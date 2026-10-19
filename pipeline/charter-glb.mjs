#!/usr/bin/env node
/**
 * 契约映射转换器：原版 GLB → 契约版 GLB
 *
 * 用法:
 *   node pipeline/charter-glb.mjs assets/models/<id>.glb [--out assets/models/<id>.charter.glb]
 *   node pipeline/charter-glb.mjs --all                  # 遍历 MODELS 里所有已入料的模型
 *   node pipeline/charter-glb.mjs assets/models/<id>.glb --pmx assets/refs/<id>/x.pmx   # 覆盖贴图溯源源
 *   node pipeline/charter-glb.mjs assets/models/<id>.glb --no-resize              # 关闭贴图降采样
 *
 * 产物（**两个版本并存，原版永不改写**）：
 *   assets/models/<id>.glb          原版：pmx2glb 直出，忠于 PMX 命名与材质序（溯源 / 回归对照）
 *   assets/models/<id>.charter.glb  契约版：材质族 / 渲染层 / 属性按 pipeline/charter-rules.mjs 归一
 *   assets/models/charter-manifest.json  登记表：模型档案 + 材质表 + 贴图表 + 超标项
 *
 * 契约版做了什么（一切判定都落进数据，运行期代码不再认名字）：
 *   ① 每个材质写 extras.charter = { version, role, track, layer, pmxOrder, srcName, hit, channels }
 *   ② 非金属族 metallicFactor 归零（PMX 无 PBR 数据，glTF 默认 1 会让暗处纯黑）
 *   ③ 脸部叠加件（eye/mouth/decal）的 alphaMode 按贴图 alpha 实况修正
 *   ④ glow 族挂 emissiveMap = D（MMD 加法 sphere 的近似）
 *   ⑤ face 族带 faceGlow 强度（渲染端据此加自发光修正）
 *   ⑥ 贴图重命名为 tex<PMX贴图序>_<终末地通道>（通道取源文件后缀，见 ②）
 *   ⑦ scene.extras.charter = 模型档案（摆正角 / 身高 / 站位 / 授权）
 *   ⑧ 贴图预算闸：最长边超 BUDGET.maxTexSize 的 PNG 自动 box filter 降采样
 *      （只动契约版；原版永不改写。`--no-resize` 关掉，改回只报告）
 *   ⑨ 着色模块声明：MODELS[<id>] 的 shader / roleShader / materialShader 合并去重后
 *      写进 scene.extras.charter.shader 与 material.extras.charter.shader
 *      （**只写 id，不写 GLSL**；id 在转换期按 SHADER_MODULES 校验，写错直接失败）
 *
 * ⭐ 贴图通道溯源：pmx2glb 把贴图命名为 `tex<PMX 贴图索引>`，而 PMX 里有原始文件名
 * （终末地是 `T_actor_jsspsi_hair_01_D.png` 这种官方命名）。有了 PMX 源就能把每个
 * GLB 贴图对回**官方的通道**——这是「契约以终末地为核心」在最底层数据上的落实。
 * 覆盖不了（如夜兰的 PMX 不在库内）就退回 glTF 槽位映射（D/E/N/MRO）。
 *
 * 依赖同 pmx2glb.mjs（装在 ~/.workbuddy/binaries/node/workspace）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import {
  ALPHA_CUT_ROLES, BUDGET, CHARTER_VERSION, FAMILIES, METAL_OK, MODELS, ROLE_TRACK, TRACKS,
  pmxChannel, pmxOf, resolveMaterial, resolveShader, validateShaderIds,
} from './charter-rules.mjs';

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const noResize = argv.includes('--no-resize') || BUDGET.downsample === false;
const pmxArgIdx = argv.indexOf('--pmx');
const pmxArg = pmxArgIdx >= 0 ? argv[pmxArgIdx + 1] : null;
const outArgIdx = argv.indexOf('--out');
const outArg = outArgIdx >= 0 ? argv[outArgIdx + 1] : null;
const inputs = argv.filter((a, i) => !a.startsWith('--')
  && !(outArgIdx >= 0 && i === outArgIdx + 1)
  && !(pmxArgIdx >= 0 && i === pmxArgIdx + 1));

if (!all && !inputs.length) {
  console.error('用法: node pipeline/charter-glb.mjs assets/models/<id>.glb [--out <out.glb>] [--pmx <src.pmx>] | --all');
  process.exit(1);
}

/** 读 PMX 的贴图索引表 —— 用来把 GLB 的 `tex<N>` 对回原始文件名（→ 终末地通道）。 */
async function readPmxTextures(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const { MMDParser } = await import('mmd-parser');
    const buf = fs.readFileSync(file);
    const pmx = new MMDParser.Parser().parsePmx(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    return pmx.textures ?? [];
  } catch (e) {
    console.warn(`  ⚠ PMX 溯源失败（${file}）：${e.message}——通道退回 glTF 槽位映射`);
    return null;
  }
}

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);

/** PNG alpha 统计（pngjs 只吃 Buffer —— 喂 Uint8Array 会静默失效，已踩过） */
function pngStats(bytes) {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const total = png.width * png.height;
    let zero = 0, partial = 0;
    for (let i = 3; i < png.data.length; i += 4) {
      const a = png.data[i];
      if (a === 0) zero++;
      else if (a < 250) partial++;
    }
    return { w: png.width, h: png.height, zero: +(zero / total).toFixed(4), partial: +(partial / total).toFixed(4) };
  } catch {
    return null;
  }
}

/**
 * PNG 降采样：最长边超 maxSize 时按**整数倍** box filter 缩（2048/1024 两档）。
 * 返回 null 表示无需缩（调用方跳过）。
 *
 * 取舍（写下来省得后人重推一遍）：
 *   - 整数倍是刻意的——4K→2K 是 2×2 均值，无重采样核、无相位误差，也不需要额外的
 *     插值库。拆包贴图几乎都是 2 的幂，非整数倍只会发生在预算被改成怪值时。
 *   - 在 sRGB 编码域直接平均，不做 linear 往返。严格做法该转线性再平均，但每像素
 *     两次 pow 会让 6 张 4K 图从秒级退化到分钟级；2×2 降采样的域误差 <2%，而角色在
 *     屏幕上占位很小（2048 相对实际需要还有数倍余量），不值得。
 *   - alpha 一并平均：MASK 贴图边缘会软半像素，0.5 阈值下近似等价。
 */
function downsamplePng(bytes, maxSize) {
  const png = PNG.sync.read(Buffer.from(bytes));
  const W = png.width, H = png.height;
  const longest = Math.max(W, H);
  if (longest <= maxSize) return null;
  const k = Math.ceil(longest / maxSize);
  const W2 = Math.max(1, Math.floor(W / k));
  const H2 = Math.max(1, Math.floor(H / k));
  const src = png.data;
  const out = new PNG({ width: W2, height: H2 });
  const dst = out.data;
  const inv = 1 / (k * k);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < k; dy++) {
        let o = ((y * k + dy) * W + x * k) * 4;
        for (let dx = 0; dx < k; dx++, o += 4) {
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
        }
      }
      const p = (y * W2 + x) * 4;
      dst[p] = (r * inv + 0.5) | 0;
      dst[p + 1] = (g * inv + 0.5) | 0;
      dst[p + 2] = (b * inv + 0.5) | 0;
      dst[p + 3] = (a * inv + 0.5) | 0;
    }
  }
  return { png: PNG.sync.write(out), from: `${W}×${H}`, to: `${W2}×${H2}`, k };
}

const io = new NodeIO();
const MANIFEST = 'assets/models/charter-manifest.json';

/** 已登记的模型条目（保留其他模型，不整表覆盖） */
let manifest = { charterVersion: CHARTER_VERSION, generatedAt: null, models: [] };
if (fs.existsSync(MANIFEST)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* 重写 */ }
}

const targets = all
  ? Object.keys(MODELS).map((id) => `assets/models/${id}.glb`).filter((f) => fs.existsSync(f))
  : inputs;

for (const input of targets) {
  const src = path.resolve(input);
  const id = path.basename(src, '.glb');
  const meta = MODELS[id];
  if (!meta) {
    console.error(`✗ ${id}: pipeline/charter-rules.mjs 的 MODELS 里没有这个模型，先登记档案再转`);
    process.exitCode = 1;
    continue;
  }
  const out = path.resolve(outArg ?? path.join(path.dirname(src), `${id}.charter.glb`));

  const doc = await io.read(src);
  const root = doc.getRoot();
  const warnings = [];

  /* ---------- 着色声明：先整批校验，再逐材质合并 ---------- */
  // 位置刻意放在材质循环之前：**资产声明错要比材质映射错更早失败**。
  // 模块 id 打错在运行期只是「这个部位没效果」，没人会注意到；
  // 在转换期直接 exitCode=1，逼作者当场改对。
  {
    const checks = [
      [`${id} 模型级 shader`, meta.shader?.modules],
      ...[Object.entries(meta.roleShader ?? {}).map(([r, list]) => [`${id} 族级 shader[${r}]`, list])],
      ...[Object.entries(meta.materialShader ?? {}).map(([n, list]) => [`${id} 材质级 shader[${n}]`, list])],
    ];
    for (const [where, list] of checks) {
      const { errors, warnings: ws } = validateShaderIds(list, where);
      warnings.push(...ws);
      if (errors.length) {
        for (const e of errors) console.error(`✗ ${e}`);
        process.exitCode = 1;
      }
    }
  }
  const modelShaderIds = meta.shader?.modules ?? [];

  /* ---------- 贴图溯源：PMX 原始文件名 → 终末地通道 ---------- */
  const pmxPath = pmxArg ?? pmxOf(id);
  const pmxTextures = await readPmxTextures(pmxPath ? path.resolve(pmxPath) : null);

  /* ---------- 贴图：alpha 统计 + 通道命名 ---------- */
  const texStats = new Map();
  const texOrder = new Map();
  const texRecords = [];
  root.listTextures().forEach((t, i) => {
    texOrder.set(t, i);
    const img = t.getImage();
    const st = t.getMimeType() === 'image/png' && img ? pngStats(img) : null;
    texStats.set(t, st);
    // pmx2glb 用 `tex<PMX 贴图索引>` 命名 —— 借此对回 PMX 里的原始文件名
    const mIdx = /^tex(\d+)/.exec(t.getName() || '');
    const pmxIdx = mIdx ? +mIdx[1] : null;
    const srcFile = pmxTextures && pmxIdx !== null ? (pmxTextures[pmxIdx] ?? null) : null;
    const chFromSrc = pmxChannel(srcFile);
    const rec = {
      idx: i,
      name: t.getName(),
      pmxIndex: pmxIdx,
      src: srcFile ? srcFile.replace(/\\/g, '/').split('/').pop() : null,
      srcCh: chFromSrc,   // 官方后缀溯源出来的通道（null = 该文件没有通道记号）
      ch: null,           // 最终通道（官方溯源优先，否则 glTF 槽位兜底）——重命名阶段回填
      mime: t.getMimeType(),
      kb: img ? +(img.byteLength / 1024).toFixed(1) : 0,
      size: st ? `${st.w}×${st.h}` : null,
      alpha: st ? { zero: st.zero, partial: st.partial } : null,
      usedBy: [],
    };
    // 超预算只打标，真正的处置在材质判定之后（alpha 抠形要用原图的 alpha 实况，
    // 缩完再判会改变 MASK/BLEND 的选择）——见下面的「贴图预算闸」。
    if (st && Math.max(st.w, st.h) > BUDGET.maxTexSize) rec.overBudget = true;
    texRecords.push(rec);
  });
  const texRec = (t) => (t ? texRecords[texOrder.get(t)] : null);

  // glTF 槽位 → 终末地通道（无 PMX 溯源时的兜底）
  const SLOT_CHAN = { baseColor: 'D', emissive: 'E', normal: 'N', orm: 'MRO' };
  /** 贴图的最终通道：优先官方后缀（源文件名），否则按槽位 */
  const chanOf = (t, slot) => {
    const rec = texRec(t);
    return rec?.srcCh ?? SLOT_CHAN[slot];
  };

  /* ---------- 材质：角色判定 + 属性归一 ---------- */
  // PMX 材质序：优先取原版 extras.pmxOrder；缺失（如 akane 用别的路径转过）则按
  // primitive 出现顺序补 —— pmx2glb 严格按 PMX 序生成 primitive，语义等价。
  const primOrder = new Map();
  {
    let k = 0;
    for (const mesh of root.listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const m = p.getMaterial();
        if (m && !primOrder.has(m)) primOrder.set(m, k++);
      }
    }
  }
  const primTris = new Map();
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const m = p.getMaterial();
      if (!m) continue;
      primTris.set(m, (primTris.get(m) ?? 0) + (p.getIndices()?.getCount() ?? 0) / 3);
    }
  }

  const matRecords = [];
  const texChannel = new Map(); // Texture → 通道（先到先得：同图多挂时取第一个语义）
  let roleCount = {};
  let fixedMetal = 0, fixedAlpha = 0, shaderMaterials = 0;

  for (const mat of root.listMaterials()) {
    const name = mat.getName() || '(未命名)';
    const rawOrder = mat.getExtras()?.pmxOrder;
    const pmxOrder = typeof rawOrder === 'number' ? rawOrder : (primOrder.get(mat) ?? null);
    const { role, layer, hit, layerHit } = resolveMaterial(id, name, pmxOrder);
    const track = ROLE_TRACK[role] ?? 'npr';
    if (!TRACKS.has(track)) warnings.push(`族 ${role} 的轨道 ${track} 不在 TRACKS 里（契约自检）`);
    roleCount[role] = (roleCount[role] ?? 0) + 1;

    // ① 角色标注（契约的核心：运行期只读这里）
    const charter = {
      version: CHARTER_VERSION,
      role,
      track,
      layer,
      pmxOrder,
      srcName: name,
      hit,
    };
    if (layerHit === 'override') charter.layerHit = 'override';

    // ② 金属归零
    const isMetalRole = METAL_OK.has(role);
    if (!isMetalRole && mat.getMetallicFactor() > 0) {
      mat.setMetallicFactor(0).setRoughnessFactor(0.9);
      fixedMetal++;
      charter.metalFixed = true;
    }
    if (isMetalRole && mat.getMetallicFactor() === 0) {
      // 金属角色却 metal=0（被上一版铁律一刀切过）：恢复为风格化金属值
      mat.setMetallicFactor(0.7).setRoughnessFactor(Math.min(mat.getRoughnessFactor() || 0.5, 0.6));
      charter.metalRestored = true;
    }

    // ③ 脸部叠加件的 alpha 抠形
    const bc = mat.getBaseColorTexture();
    const st = bc ? texStats.get(bc) : null;
    const mode = mat.getAlphaMode() ?? 'OPAQUE';
    if (ALPHA_CUT_ROLES.has(role) && st && st.zero > 0.02 && mode === 'OPAQUE') {
      if (st.partial < 0.05) mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
      else mat.setAlphaMode('BLEND');
      fixedAlpha++;
      charter.alphaFixed = st.partial < 0.05 ? 'MASK' : 'BLEND';
    }

    // ④ glow：BC 兼任 emissiveMap（黑底加法）
    if (role === 'glow' && bc && !mat.getEmissiveTexture()) {
      mat.setEmissiveFactor([1, 1, 1]).setEmissiveTexture(bc);
      charter.emissiveFromD = true;
    }

    // ⑤ face：自发光强度交给渲染端（glTF 无标准槽位可放，写 extras 最稳）
    if (role === 'face') {
      if (meta.faceGlow > 0) charter.faceGlow = meta.faceGlow;
      else charter.faceGlow = 0;
    }

    // ⑤b morph 驱动件（口腔系）：字段交给渲染端——模型无 morph targets 时整件隐藏
    if (FAMILIES[role]?.morphOnly) charter.morphOnly = true;

    // ⑥ 描边壳策略
    if (role === 'outline') {
      const policy = meta.outline ?? 'hide';
      charter.outline = policy;
      if (policy === 'enable') {
        // 契约版把它从「PMX 隐藏壳」变成「可见黑壳」：颜色与不透明度烘进数据，
        // 背面 + 沿法线外扩由渲染端按 role=outline 施加（glTF 表达不了 side=BackSide）
        mat.setBaseColorFactor([0.14, 0.11, 0.18, 1]);
        mat.setAlphaMode('OPAQUE');
        mat.setMetallicFactor(0).setRoughnessFactor(1);
      } else {
        mat.setBaseColorFactor([0, 0, 0, 0]);
        mat.setAlphaMode('BLEND');
      }
    }

    // ⑦ 贴图通道登记（改名与「名字回填」在全部材质判完后统一做）
    //    通道取终末地官方后缀（源文件名），拿不到才按 glTF 槽位兜底
    const mark = (t, slot) => {
      if (!t) return null;
      const ch = chanOf(t, slot);
      if (!texChannel.has(t)) texChannel.set(t, ch);
      const r = texRec(t);
      if (r && !r.usedBy.includes(name)) r.usedBy.push(name);
      return t; // 先存引用：此刻贴图的最终名还没定（同图可能双挂 D+E）
    };
    const texRefs = {
      baseColor: mark(bc, 'baseColor'),
      emissive: mark(mat.getEmissiveTexture(), 'emissive'),
      normal: mark(mat.getNormalTexture(), 'normal'),
      occlusion: mark(mat.getOcclusionTexture(), 'orm'),
      metalRough: mark(mat.getMetallicRoughnessTexture(), 'orm'),
    };
    // 该材质实际用到的终末地通道集合（契约里最直观的一格：一族该带哪些通道）
    const chans = [...new Set(Object.values(texRefs)
      .map((t) => (t ? chanOf(t, 'baseColor') : null))
      .filter(Boolean))];
    if (chans.length) charter.channels = chans;

    // ⑧ 着色模块（模型级 → 族级 → 材质级合并去重）
    //    只写 id，不写 GLSL：GLSL 归引擎/内容仓的代码，资产只声明意图。
    const shader = resolveShader(id, role, name);
    if (shader.ids.length) {
      charter.shader = { modules: shader.ids };
      shaderMaterials++;
    }

    mat.setExtras({ ...(mat.getExtras() ?? {}), charter });
    matRecords.push({
      name,
      role,
      track,
      layer,
      hit,
      tris: Math.round(primTris.get(mat) ?? 0),
      metal: mat.getMetallicFactor(),
      rough: mat.getRoughnessFactor(),
      alphaMode: mat.getAlphaMode() ?? 'OPAQUE',
      doubleSided: mat.getDoubleSided(),
      channels: chans,
      _texRefs: texRefs,
      faceGlow: charter.faceGlow,
      ...(shader.ids.length ? { shader: shader.ids } : {}),
      flags: Object.keys(charter).filter((k) => !['version', 'role', 'track', 'layer', 'pmxOrder', 'srcName', 'hit', 'layerHit', 'faceGlow', 'channels', 'shader'].includes(k)),
    });
  }

  /* ---------- 贴图预算闸（降采样） ---------- */
  // 位置刻意排在材质判定之后：③ 的 alpha 抠形读的是原图的 alpha 实况，先缩会让
  // 镂空比例失真（尤其 MASK/BLEND 的分界）。
  // 降采样后重算 alpha 与体积，并把「从哪来」记进 manifest —— 降过采的贴图必须可溯源。
  let resized = 0;
  const resizeLog = [];
  for (const t of root.listTextures()) {
    const rec = texRec(t);
    if (!rec?.overBudget) continue;
    if (noResize) {
      warnings.push(`贴图 ${rec.name} ${rec.size} 超出预算 ${BUDGET.maxTexSize}（--no-resize：未降采样）`);
      continue;
    }
    if (t.getMimeType() !== 'image/png') {
      warnings.push(`贴图 ${rec.name} ${rec.size} 超出预算且非 PNG（${t.getMimeType()}）—— 只降采样 PNG，这张请手工处理`);
      continue;
    }
    const r = downsamplePng(t.getImage(), BUDGET.maxTexSize);
    if (!r) continue;
    t.setImage(r.png);
    const st2 = pngStats(r.png);
    texStats.set(t, st2);
    rec.size = r.to;
    rec.kb = +(r.png.byteLength / 1024).toFixed(1);
    rec.alpha = st2 ? { zero: st2.zero, partial: st2.partial } : rec.alpha;
    rec.resize = { from: r.from, to: r.to, k: r.k, algorithm: 'box', domain: 'srgb' };
    delete rec.overBudget;
    resized++;
    resizeLog.push({ rec, from: r.from, to: r.to, k: r.k });   // 名字在重命名后回填
  }

  /* ---------- 贴图统一重命名（保留 PMX 索引 + 通道后缀） ---------- */
  // 原名即 pmx2glb 写的 `tex<pmxIndex>`，沿用该数字而不是新序号——重转一次
  // 或换一张图集时，名字仍能对上拆包源。
  const idxOf = (t, fallback) => {
    const m = /^tex(\d+)/.exec(t.getName() || '');
    return m ? +m[1] : fallback;
  };
  const finalName = new Map();
  for (const t of root.listTextures()) {
    const i = idxOf(t, texOrder.get(t));
    const ch = texChannel.get(t) ?? 'TEX';
    const nm = `tex${i}_${ch}`;
    finalName.set(t, nm);
    t.setName(nm);
    const rec = texRecords[texOrder.get(t)];
    rec.name = nm;
    rec.ch = ch; // 最终通道（官方溯源优先 / glTF 槽位兜底）
  }
  const nmOf = (t) => (t ? finalName.get(t) : null);
  for (const rec of matRecords) {
    const refs = rec._texRefs;
    delete rec._texRefs;
    rec.tex = {
      baseColor: nmOf(refs.baseColor),
      emissive: nmOf(refs.emissive),
      normal: nmOf(refs.normal),
      occlusion: nmOf(refs.occlusion),
      metalRough: nmOf(refs.metalRough),
    };
  }

  /* ---------- 模型档案 ---------- */
  const scene = root.listScenes()[0] ?? doc.createScene('Scene');
  scene.setExtras({
    ...(scene.getExtras() ?? {}),
    charter: {
      version: CHARTER_VERSION,
      id,
      name: meta.name,
      source: meta.source,
      license: meta.license,
      defaultRotY: meta.defaultRotY ?? 0,
      targetHeight: meta.targetHeight ?? 1.55,
      standPosition: meta.standPosition ?? null,
      standRotY: meta.standRotY ?? null,
      faceSdf: meta.faceSdf ?? null,
      sourceOrder: 'pmx',
      // 模型级着色（全身）：消费端 prepareCharacterRendering 读它，缺失的模块降级跳过
      ...(modelShaderIds.length ? { shader: { modules: modelShaderIds } } : {}),
    },
  });

  /* ---------- 写盘 ---------- */
  // 贴图数量与体积预算
  if (texRecords.length > BUDGET.maxTextures) warnings.push(`贴图数 ${texRecords.length} 超出预算 ${BUDGET.maxTextures}`);
  await io.write(out, doc);
  const mb = +(fs.statSync(out).size / 1024 / 1024).toFixed(2);
  if (mb > BUDGET.maxTotalMB) warnings.push(`契约版体积 ${mb}MB 超出预算 ${BUDGET.maxTotalMB}MB`);

  let verts = 0, tris = 0, joints = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    // 同一个 POSITION accessor 被所有 primitive 共享（pmx2glb 的写法），只算一次
    if (pos && p === mesh.listPrimitives()[0]) verts += pos.getCount();
    tris += (p.getIndices()?.getCount() ?? 0) / 3;
  }
  for (const sk of root.listSkins()) joints += sk.listJoints().length;

  const entry = {
    id,
    name: meta.name,
    source: meta.source,
    license: meta.license,
    charterFile: path.basename(out),
    sourceFile: path.basename(src),
    sourceSha1: sha1(src),
    defaultRotY: meta.defaultRotY ?? 0,
    targetHeight: meta.targetHeight ?? 1.55,
    faceGlow: meta.faceGlow ?? 0,
    faceSdf: meta.faceSdf ?? null,
    standPosition: meta.standPosition ?? null,
    ...(modelShaderIds.length ? { shader: modelShaderIds } : {}),
    stats: { verts, tris: Math.round(tris), materials: matRecords.length, textures: texRecords.length, joints, mb },
    roles: roleCount,
    materials: matRecords,
    textures: texRecords.map((t) => ({
      name: t.name, ch: t.ch, srcCh: t.srcCh, src: t.src, pmxIndex: t.pmxIndex,
      size: t.size, kb: t.kb, alpha: t.alpha, usedBy: t.usedBy,
      ...(t.resize ? { resize: t.resize } : {}),
    })),
    resized: resizeLog.map((x) => `${x.rec.name} ${x.from}→${x.to} (${x.k}× box)`),
    warnings,
  };
  manifest.models = [...manifest.models.filter((m) => m.id !== id), entry];
  manifest.generatedAt = new Date().toISOString();
  manifest.charterVersion = CHARTER_VERSION;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  /* ---------- 报告 ---------- */
  const tracked = pmxTextures ? texRecords.filter((t) => t.srcCh).length : 0;
  console.log(`\n━━ ${id} → ${path.basename(out)}  ${mb} MB（原版 ${(fs.statSync(src).size / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`材质 ${matRecords.length} · 贴图 ${texRecords.length} · 骨骼 ${joints} · 三角 ${Math.round(tris).toLocaleString()}`);
  console.log(`材质族: ${Object.entries(roleCount).map(([r, c]) => `${r}×${c}`).join('  ')}`);
  console.log(`归一: 金属归零 ${fixedMetal} · alpha 修正 ${fixedAlpha}`);
  console.log(`着色声明: ${modelShaderIds.length ? `模型级 ${modelShaderIds.join('+')}` : '无模型级'}`
    + ` · 命中材质 ${shaderMaterials}/${matRecords.length}`);
  console.log(`通道溯源: ${pmxTextures ? `${tracked}/${texRecords.length} 张对回终末地官方后缀（PMX ${path.basename(pmxPath ?? '')}）` : '无 PMX 源 → 按 glTF 槽位映射'}`);
  console.log(`贴图预算: 降采样 ${resized} 张${resizeLog.length ? `（${resizeLog.map((x) => `${x.rec.name} ${x.from}→${x.to}`).join(' · ')}）` : ''}`
    + (noResize ? '（--no-resize 已关）' : ` / 上限 ${BUDGET.maxTexSize}`));
  console.log('');
  console.log('  ' + '材质'.padEnd(16) + '族'.padEnd(9) + '轨道'.padEnd(9) + '层'.padEnd(5) + '判定'.padEnd(10) + 'alphaMode'.padEnd(10) + '通道');
  console.log('  ' + '-'.repeat(82));
  for (const m of matRecords) {
    console.log('  ' + m.name.padEnd(16) + m.role.padEnd(9) + m.track.padEnd(9)
      + String(m.layer).padEnd(5) + m.hit.padEnd(10) + m.alphaMode.padEnd(10)
      + (m.channels.join('+') || '—')
      + (m.shader ? `   ⟨${m.shader.join('+')}⟩` : '')
      + (m.flags.length ? `   [${m.flags.join(',')}]` : ''));
  }
  console.log('');
  console.log('  贴图: ' + texRecords.map((t) => `${t.name}${t.ch ? `(${t.src})` : ''}`).join('  '));
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} 项提示：`);
    for (const w of warnings) console.log('  · ' + w);
  }
  console.log('');
}

console.log(`manifest → ${MANIFEST}`);
