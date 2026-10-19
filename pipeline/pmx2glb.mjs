#!/usr/bin/env node
/**
 * PMX → GLB 转换脚本（witch-idle 验证期工具链）
 *
 * 用法:
 *   node pipeline/pmx2glb.mjs <input.pmx> [output.glb] [--scale 0.08] [--name 夜兰]
 *
 * 默认输出到 assets/models/<名>.glb（已 gitignore 的模型资产区）。
 *
 * 依赖（装在 ~/.workbuddy/binaries/node/workspace）:
 *   mmd-parser  https://github.com/takahirox/mmd-parser  — PMX 解析
 *   @gltf-transform/core — 纯 JS 构建 GLB（无 DOM 依赖）
 *   pngjs — BMP→PNG 转码（glTF 不支持 BMP）
 *
 * 坐标转换（MMD 左手系 → glTF 右手系，与 Blender mmd_tools 一致）:
 *   - 顶点/法线/骨骼位置取反 X
 *   - 三角形绕序反转
 *   - UV 不翻 V（mmd-parser 输出已是 glTF 语义，见下方顶点缓冲注释）
 *
 * sphere 贴图: MMD 球面映射 UV 无法用标准 glTF 还原；验证期只处理「加法 env」材质
 *   （envFlag=2，如头发高光层）：把主贴图同时挂为 emissiveMap（透明区 RGB=黑，
 *   不发光），近似 MMD 的加法叠加效果。乘法/减法 env 跳过。
 * extras.pmxOrder: 每个 primitive 材质的 PMX 序号，渲染端据此设 renderOrder，
 *   保证 MMD「材质顺序即叠加顺序」语义（睫毛/高光层等在底层之上）。
 *
 * 骨骼: 平移链示（MMD 骨骼静止姿态只有位移，无旋转），rest 旋转全为 identity，
 *       inverseBindMatrix = 逆全局平移。SDEF/QDEF 顶点按 BDEF 近似（验证期够用）。
 *
 * 表情 morph（--expr）:
 *   按 pipeline/expression-rules.mjs 的槽位档案筛选 PMX 的 vertex morph，写成
 *   glTF morph target（POSITION delta，**只导位移不导法线**——面部明暗走 SDF 阈值场）。
 *   实现要点：
 *     · 全部 primitive 共享同一个 POSITION accessor，所以一份全模型 delta accessor
 *       可以被所有 primitive 的 targets 共同引用，**不做索引重映射**。
 *     · delta 用 **sparse accessor**（base 值全 0）：实测把 20 个 morph 从 ~15 MB
 *       压到 ~1 MB，而 three 的 GLTFLoader 会解压成稠密数组（显存占用不变）。
 *     · target 名写进 PrimitiveTarget 的 name，glTF-Transform 自动落成
 *       mesh.extras.targetNames，three 据此建 morphTargetDictionary。
 *
 * 不支持: 物理、IK、toon/sphere 贴图、group/bone/uv 类 morph —— 按需再加。
 *
 * 运行（隔离运行时）:
 *   NODE_PATH=/Users/token/.workbuddy/binaries/node/workspace/node_modules \
 *     /Users/token/.workbuddy/binaries/node/versions/22.22.2-6/bin/node pipeline/pmx2glb.mjs ...
 */

import fs from 'node:fs';
import path from 'node:path';
import { MMDParser } from 'mmd-parser';
import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import { resolveExpression } from './expression-rules.mjs';

// ---------- CLI ----------

const argv = process.argv.slice(2);
const args = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    // 无值开关（--expr）与「下一个是另一个开关」都当布尔 true
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  } else positional.push(argv[i]);
}
if (positional.length < 1) {
  console.error('用法: node pipeline/pmx2glb.mjs <input.pmx> [output.glb] [--scale 0.08] [--name <名>] [--expr] [--model <id>]');
  process.exit(1);
}
const inputPath = path.resolve(positional[0]);
const outPath = path.resolve(positional[1] || path.join(process.cwd(), 'models', path.basename(inputPath, '.pmx') + '.glb'));
const SCALE = parseFloat(args.scale ?? '0.08'); // MMD 单位≈cm，0.08 → 米
const MODEL_NAME = args.name ?? path.basename(inputPath, '.pmx');

// ---------- 解析 PMX ----------

const parser = new MMDParser.Parser();
const pmx = parser.parsePmx(readArrayBuffer(inputPath)); // eslint-disable-line -- 定义见下
function readArrayBuffer(file) {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const pmxDir = path.dirname(inputPath);

console.log(`[pmx] 顶点=${pmx.vertices.length} 面=${pmx.faces.length} 材质=${pmx.materials.length} 骨骼=${pmx.bones.length} 贴图=${pmx.textures.length} morph=${pmx.morphs?.length ?? 0}`);

// ---------- 贴图: BMP 解码 → PNG；png/jpg 原样内嵌 ----------

/** 解码未压缩 24/32bpp BMP（glTF 不收 BMP，必须转码） */
function decodeBMP(bytes) {
  if (bytes.readUInt16LE(0) !== 0x4d42) throw new Error('非 BMP 文件');
  const dataOffset = bytes.readUInt32LE(10);
  const headerSize = bytes.readUInt32LE(14);
  if (headerSize < 40) throw new Error('不支持 BITMAPCOREHEADER');
  const width = bytes.readInt32LE(18);
  let height = bytes.readInt32LE(22);
  const bpp = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  if (compression !== 0) throw new Error(`不支持的 BMP 压缩类型 ${compression}（仅 BI_RGB）`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`不支持的位深 ${bpp}`);
  const bottomUp = height > 0;
  height = Math.abs(height);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const srcY = bottomUp ? height - 1 - y : y;
    let off = dataOffset + srcY * rowSize;
    for (let x = 0; x < width; x++) {
      const b = bytes[off++], g = bytes[off++], r = bytes[off++];
      const a = bpp === 32 ? bytes[off++] : 255;
      const idx = (y * width + x) * 4;
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

/** 解码 TGA（未压缩 type2 / RLE type10，24/32bpp）→ PNG */
function decodeTGA(bytes) {
  const idLength = bytes[0];
  const imageType = bytes[2];
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const bpp = bytes[16];
  const descriptor = bytes[17];
  const topOrigin = !!(descriptor & 0x20);
  if (bpp !== 24 && bpp !== 32) throw new Error(`不支持的 TGA 位深 ${bpp}`);
  if (imageType !== 2 && imageType !== 10) throw new Error(`不支持的 TGA 类型 ${imageType}（仅 2=RGB / 10=RLE RGB）`);
  const bytesPerPixel = bpp / 8;
  const pixelCount = width * height;
  const src = new Uint8Array(bytes.buffer, bytes.byteOffset + 18 + idLength, imageType === 10 ? Infinity : pixelCount * bytesPerPixel);

  const rgba = new Uint8Array(pixelCount * 4);
  let si = 0;
  let di = 0;
  const put = (b, g, r, a) => {
    if (di >= rgba.length) return;
    rgba[di++] = r; rgba[di++] = g; rgba[di++] = b; rgba[di++] = a;
  };
  if (imageType === 2) {
    for (let i = 0; i < pixelCount; i++) {
      put(src[si], src[si + 1], src[si + 2], bpp === 32 ? src[si + 3] : 255);
      si += bytesPerPixel;
    }
  } else {
    // RLE: 包头最高位 1=重复包（1 个像素重复 n+1 次），0=原始包（n+1 个字面像素）
    while (di < rgba.length) {
      const head = src[si++];
      const n = (head & 0x7f) + 1;
      if (head & 0x80) {
        const b = src[si], g = src[si + 1], r = src[si + 2], a = bpp === 32 ? src[si + 3] : 255;
        si += bytesPerPixel;
        for (let i = 0; i < n; i++) put(b, g, r, a);
      } else {
        for (let i = 0; i < n; i++) {
          put(src[si], src[si + 1], src[si + 2], bpp === 32 ? src[si + 3] : 255);
          si += bytesPerPixel;
        }
      }
    }
  }
  // TGA 行序：默认自底向上；origin 位置才翻转
  if (!topOrigin) {
    const row = new Uint8Array(width * 4);
    for (let y = 0; y < (height >> 1); y++) {
      const a = y * width * 4;
      const bIdx = (height - 1 - y) * width * 4;
      row.set(rgba.subarray(a, a + width * 4));
      rgba.copyWithin(a, bIdx, bIdx + width * 4);
      rgba.set(row, bIdx);
    }
  }
  const png = new PNG({ width, height });
  png.data = rgba;
  return PNG.sync.write(png);
}

/** PNG alpha 通道统计：zero = a=0 占比，partial = 中间 alpha 占比（MASK/BLEND 判据）。 */
function pngAlphaStats(bytes) {
  try {
    const png = PNG.sync.read(bytes);
    const total = png.width * png.height;
    let zero = 0, partial = 0;
    for (let i = 3; i < png.data.length; i += 4) {
      const a = png.data[i];
      if (a === 0) zero++;
      else if (a < 250) partial++;
    }
    return { zero: zero / total, partial: partial / total };
  } catch {
    return null;
  }
}

/**
 * 贴图回退索引：拆包包常把贴图分目录放（如「other tex/」），PMX 里的相对路径
 * （textures/xxx.png）会落空。按 basename 在 PMX 目录树内再找一次。
 * 2026-10-16 实证：终末地「祀」的 T_actor_jsspsi_body_01_N.png 在 other tex/，
 * 缺失时「发影」层拿不到遮罩 → 脸上糊一块纯色。
 */
let texIndex = null;
function findTextureByName(rel) {
  if (!texIndex) {
    texIndex = new Map();
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (!texIndex.has(e.name.toLowerCase())) texIndex.set(e.name.toLowerCase(), p);
      }
    };
    walk(pmxDir);
  }
  return texIndex.get(path.basename(rel).toLowerCase()) ?? null;
}

function loadTexture(rel) {  // PMX 贴图路径用 Windows 反斜杠
  const direct = path.resolve(pmxDir, rel.replaceAll('\\', '/'));
  const file = fs.existsSync(direct) ? direct : findTextureByName(rel);
  if (!file) {
    console.warn(`[tex] 缺失: ${rel}（按文件名全目录搜索亦未命中 → 以纯色材质代替）`);
    return null;
  }
  if (file !== direct) console.warn(`[tex] 路径回退: ${rel} → ${path.relative(pmxDir, file)}`);
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    return { bytes, mime: ext === '.png' ? 'image/png' : 'image/jpeg' };
  }
  if (ext === '.bmp') return { bytes: decodeBMP(bytes), mime: 'image/png' };
  if (ext === '.tga') return { bytes: decodeTGA(bytes), mime: 'image/png' };
  if (ext === '.sph' || ext === '.spa') {
    console.warn(`[tex] 暂不支持 ${ext}: ${rel}（跳过）`);
    return null;
  }
  console.warn(`[tex] 未知扩展 ${ext}: ${rel}（跳过）`);
  return null;
}

// ---------- 构建文档 ----------

const doc = new Document();
const buffer = doc.createBuffer();
const root = doc.createNode(MODEL_NAME).setTranslation([0, 0, 0]);
doc.createScene('Scene').addChild(root);

// ---- 顶点缓冲（左手→右手: 取反 X）----
// UV 不翻 V：mmd-parser 输出的 v 已是「从底数」语义（与 glTF 一致）。
// 2026-10-15 实证：多翻一次导致全模型 UV 垂直镜像，虹膜采到 atlas 右上角灰白发梢区
// （表现 = 眼睛空白灰块、发色漂移）；去掉翻转后浏览器内翻回实验虹膜立刻正确。
const n = pmx.vertices.length;
const positions = new Float32Array(n * 3);
const normals = new Float32Array(n * 3);
const uvs = new Float32Array(n * 2);
const joints = new Uint16Array(n * 4);
const weights = new Float32Array(n * 4);
let sdefCount = 0;
for (let i = 0; i < n; i++) {
  const v = pmx.vertices[i];
  positions[i * 3] = -v.position[0] * SCALE;
  positions[i * 3 + 1] = v.position[1] * SCALE;
  positions[i * 3 + 2] = v.position[2] * SCALE;
  normals[i * 3] = -v.normal[0];
  normals[i * 3 + 1] = v.normal[1];
  normals[i * 3 + 2] = v.normal[2];
  uvs[i * 2] = v.uv[0];
  uvs[i * 2 + 1] = v.uv[1];
  const si = v.skinIndices ?? [];
  const sw = v.skinWeights ?? [];
  for (let j = 0; j < 4; j++) {
    joints[i * 4 + j] = si[j] ?? 0;
    weights[i * 4 + j] = sw[j] ?? 0;
  }
  if (v.type === 3) sdefCount++; // SDEF 按 BDEF 近似
}
if (sdefCount) console.warn(`[skin] ${sdefCount} 个 SDEF 顶点按 BDEF 近似（验证期可接受）`);

function accessor(name, array, type) {
  return doc.createAccessor(name).setBuffer(buffer).setArray(array).setType(type);
}
const accPos = accessor('POSITION', positions, 'VEC3');
const accNrm = accessor('NORMAL', normals, 'VEC3');
const accUv = accessor('TEXCOORD_0', uvs, 'VEC2');
const accJnt = accessor('JOINTS_0', joints, 'VEC4');
const accWgt = accessor('WEIGHTS_0', weights, 'VEC4');

// ---- 骨骼: MMD 骨骼位置是模型绝对坐标 → 本地平移 = 自身 - 父 ----
const boneNodes = [];
const boneGlobal = []; // 全局静止平移（baked，缩放后）
for (let i = 0; i < pmx.bones.length; i++) {
  const b = pmx.bones[i];
  const gp = [-b.position[0] * SCALE, b.position[1] * SCALE, b.position[2] * SCALE];
  const parentIdx = b.parentIndex;
  const local = parentIdx >= 0
    ? [gp[0] - boneGlobal[parentIdx][0], gp[1] - boneGlobal[parentIdx][1], gp[2] - boneGlobal[parentIdx][2]]
    : gp;
  const node = doc.createNode(uniqueName(b.name || `bone${i}`)).setTranslation(local);
  boneNodes.push(node);
  boneGlobal.push(gp);
}
for (let i = 0; i < pmx.bones.length; i++) {
  const p = pmx.bones[i].parentIndex;
  if (p >= 0) boneNodes[p].addChild(boneNodes[i]);
  else root.addChild(boneNodes[i]);
}

function uniqueName(name) {
  const taken = new Set(doc.getRoot().listNodes().map((nd) => nd.getName()));
  if (!taken.has(name)) return name;
  let k = 2;
  while (taken.has(`${name}.${k}`)) k++;
  return `${name}.${k}`;
}

// ---- 逆绑定矩阵（静止姿态全局变换的逆；纯平移 + 根缩放，直接取负）----
const ibm = new Float32Array(pmx.bones.length * 16);
for (let i = 0; i < pmx.bones.length; i++) {
  const t = boneGlobal[i];
  // 平移矩阵取逆 = 取反平移
  ibm.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -t[0], -t[1], -t[2], 1,
  ], i * 16);
}
const skin = doc.createSkin('skin')
  .setSkeleton(boneNodes[0])
  .setInverseBindMatrices(accessor('IBM', ibm, 'MAT4'));
for (const nd of boneNodes) skin.addJoint(nd);

// ---- 材质 + 索引（绕序反转）----
const prims = []; // 每个 PMX 材质一个 primitive，最后统一挂 mesh
const faceOffsetOf = [];
{
  let acc = 0;
  for (const m of pmx.materials) { faceOffsetOf.push(acc); acc += m.faceCount; }
}
const usedTextures = new Map(); // texIndex -> { tex: Texture, alphaStat: {zero,partial} | null }
for (let mi = 0; mi < pmx.materials.length; mi++) {
  const m = pmx.materials[mi];
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accPos)
    .setAttribute('NORMAL', accNrm)
    .setAttribute('TEXCOORD_0', accUv)
    .setAttribute('JOINTS_0', accJnt)
    .setAttribute('WEIGHTS_0', accWgt);

  const start = faceOffsetOf[mi] * 3;
  const count = m.faceCount * 3;
  const idx = new Uint32Array(count);
  const faces = pmx.faces;
  for (let f = 0; f < m.faceCount; f++) {
    const tri = faces[start / 3 + f].indices;
    // 取反 X 后翻绕序: a,b,c → c,b,a
    idx[f * 3] = tri[2]; idx[f * 3 + 1] = tri[1]; idx[f * 3 + 2] = tri[0];
  }
  prim.setIndices(accessor(`IDX_${mi}`, idx, 'SCALAR'));

  const mat = doc.createMaterial(m.name || `mat${mi}`);
  mat.setBaseColorFactor([m.diffuse[0], m.diffuse[1], m.diffuse[2], m.diffuse[3] ?? 1]);
  mat.setDoubleSided(true); // 绕序转换兜底；验证期不做背面剔除调优
  mat.setExtras({ pmxOrder: mi }); // 渲染端 renderOrder 依据（MMD 材质顺序语义）
  // PMX 没有 PBR 数据：glTF 默认 metallicFactor=1 会让材质漫反射归零，
  // 无 IBL 处直接纯黑（实测：yelan 全材质 metal=1，baseline 模式黑块根因）
  mat.setMetallicFactor(0).setRoughnessFactor(0.9);
  // 脸部镂空件靠贴图 alpha 抠形（MMD 渲染总是读贴图 alpha；glTF OPAQUE 会忽略 → 白/黑块）
  const ALPHA_BY_NAME = /睫眉|白目|目$|^目|口舌|齿|星目/;
  const alphaStat = usedTextures.get(m.textureIndex)?.alphaStat ?? null;
  if ((m.diffuse[3] ?? 1) < 0.999 || ALPHA_BY_NAME.test(m.name || '')) {
    mat.setAlphaMode('BLEND');
  } else if (alphaStat && alphaStat.zero > 0.02) {
    // 材质名没进白名单但贴图本身带大面积镂空（实测：yelan「髮+」刘海，
    // tex7 99.4% 像素 alpha=0，OPAQUE 导出成黑板盖脸）：
    // 硬边件（透明像素几乎纯 0/255）用 MASK 保 depthWrite、免排序问题；
    // 软边件（中间 alpha 多）用 BLEND 保渐变。
    if (alphaStat.partial < 0.05) mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
    else mat.setAlphaMode('BLEND');
  }
  if (m.textureIndex >= 0 && pmx.textures[m.textureIndex]) {
    let tex = usedTextures.get(m.textureIndex)?.tex;
    if (!tex) {
      const loaded = loadTexture(pmx.textures[m.textureIndex]);
      if (loaded) {
        tex = doc.createTexture(`tex${m.textureIndex}`)
          .setImage(loaded.bytes)
          .setMimeType(loaded.mime);
        usedTextures.set(m.textureIndex, {
          tex,
          alphaStat: loaded.mime === 'image/png' ? pngAlphaStats(loaded.bytes) : null,
        });
      }
    }
    if (tex) mat.setBaseColorTexture(tex); // 默认 texCoord=0，我们只有 TEXCOORD_0

    // 加法 env（如「髮+」sp.png 高光层）：主贴图挂 emissiveMap 近似 MMD 加法叠加。
    // 前提：贴图透明区 RGB=黑（sp.png 实测 99.4% 全黑），否则会整面发光。
    const envFlag = m.envFlag ?? 0;
    const envIdx = m.envTextureIndex ?? -1;
    if (envFlag === 2 && envIdx >= 0 && pmx.textures[envIdx] && tex) {
      mat.setEmissiveFactor([1, 1, 1]).setEmissiveTexture(tex);
      console.log(`[env] ${m.name}: 加法 sphere ${pmx.textures[envIdx]} → emissiveMap（近似）`);
    }
  }
  prim.setMaterial(mat);
  prims.push(prim);
}

// ---- Mesh 挂节点 + Skin ----
const mesh = doc.createMesh('mesh');
for (const prim of prims) mesh.addPrimitive(prim);
const bodyNode = doc.createNode('body').setMesh(mesh).setSkin(skin);
root.addChild(bodyNode);

// ---- 表情 morph（--expr）----
// 放在 mesh 组好之后：PrimitiveTarget 必须在 primitive 已连进图之后才 addTarget。
if (args.expr) {
  const modelId = args.model ?? MODEL_NAME;
  const expr = resolveExpression(pmx, modelId);
  const byName = new Map((pmx.morphs ?? []).map((m) => [m.name, m]));
  const built = [];
  let zeroSkipped = 0;

  for (const t of expr.targets) {
    const morph = byName.get(t.name);
    if (!morph || morph.type !== 1) { zeroSkipped++; continue; }
    // delta 必须与 base 同空间：X 取反 + 同倍缩放（见上方顶点缓冲的坐标转换）
    const delta = new Float32Array(n * 3);
    let moved = 0;
    for (const e of morph.elements ?? []) {
      const v = e.index;
      if (!(v >= 0 && v < n)) continue;
      const dx = -e.position[0] * SCALE;
      const dy = e.position[1] * SCALE;
      const dz = e.position[2] * SCALE;
      if (dx === 0 && dy === 0 && dz === 0) continue;
      delta[v * 3] = dx; delta[v * 3 + 1] = dy; delta[v * 3 + 2] = dz;
      moved++;
    }
    if (!moved) { zeroSkipped++; continue; }
    // sparse：base 全 0，只存非零位移 → 文件体积降一个数量级（three 读回时自动展开）
    const acc = doc.createAccessor(`MORPH_${morph.name}`)
      .setType('VEC3').setArray(delta).setBuffer(buffer).setSparse(true);
    built.push({ name: morph.name, acc, moved, sparseBytes: moved * (12 + 2) });
  }

  // glTF 规范：同一 mesh 下所有 primitive 的 targets 数量与顺序必须一致
  for (const prim of prims) {
    for (const t of built) {
      prim.addTarget(doc.createPrimitiveTarget(t.name).setAttribute('POSITION', t.acc));
    }
  }

  const denseBytes = built.length * n * 12;
  const sparseBytes = built.reduce((s, t) => s + t.sparseBytes, 0);
  const covered = expr.targets.length;
  console.log(`\n[expr] model=${modelId}  gaze=${expr.gazeMode}  blink=${expr.blinkSource}`);
  console.log(`  目标 ${built.length} 个（槽位引用 ${covered}）· 覆盖 ${expr.coverage.covered}/${expr.coverage.total} 槽位`
    + (zeroSkipped ? ` · 跳过 ${zeroSkipped}（非 vertex 或零位移）` : ''));
  console.log(`  delta 体积 dense ${(denseBytes / 1048576).toFixed(2)} MB → sparse ${(sparseBytes / 1048576).toFixed(2)} MB`
    + `（${((1 - sparseBytes / Math.max(1, denseBytes)) * 100).toFixed(1)}% 省掉）`);
  for (const t of built) {
    const aff = expr.targets.find((x) => x.name === t.name)?.affected ?? 0;
    console.log(`    ${t.name.padEnd(12)} 影响 ${String(aff).padStart(5)} 顶点`
      + ` · 实写 ${String(t.moved).padStart(5)}（${((t.moved / n) * 100).toFixed(1)}% 稠密度）`);
  }
  if (expr.unresolved.length) console.log(`  unresolved（该模型做不了）: ${expr.unresolved.join(' ')}`);
  for (const s of expr.sideChecks) {
    console.log(`  左右校验 ${s.slot} ← 「${s.morph}」 质心 x=${s.cx?.toFixed(3)} → ${s.got}（期望 ${s.want}）`);
  }
  for (const w of expr.warnings) console.warn(`  ⚠ ${w}`);
}

// ---- 写 GLB ----
const io = new NodeIO();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
await io.write(outPath, doc);
console.log(`[glb] 写出 ${outPath}（${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB）`);
