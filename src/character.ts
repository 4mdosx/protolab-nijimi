/**
 * 角色加载 —— 纯契约消费。
 *
 * 分工（改这里之前先读这段）：
 *   tools/charter-rules.mjs  **约定**（角色枚举 / 名字规则 / 模型档案：摆正角、身高、站位、授权）
 *   tools/charter-glb.mjs    把约定写进 GLB（材质 extras.charter、scene extras.charter）
 *   src/render/charter.ts    读契约 + 施加 glTF 表达不了的项
 *   本文件                    加载 + 归一化 + 站位 + 光台架
 *
 * ⚠️ 本文件不再有任何基于材质名或模型名的特判。历史包袱（PMX 修正、眼层重排、
 * 隐藏描边壳、面部自发光魔数）全部上移到契约：新模型入料只需在 charter-rules.mjs
 * 登记档案 + 跑一次 tools/charter-glb.mjs。
 *
 * 两个版本并存（见 models/README.md）：
 *   models/<id>.glb          原版，忠于 PMX 命名与材质序（溯源 / 回归对照，运行期不用）
 *   models/<id>.charter.glb  契约版，**运行期唯一使用**
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { modernMaterials, type ModernMaterials } from './materials';
import { applyCharter, readModelCharter, type CharterModel, type CharterReport } from './charter';
import { loadExpression, loadExpressionManifest, type ExpressionLayer } from './expression';
import { ExpProtocol } from './exp-protocol';

export interface CharacterHandles {
  group: THREE.Group;
  /** 角色站位（房间坐标） */
  readonly position: THREE.Vector3;
  /** 骨骼动画驱动（当前模型无动画，接口留好） */
  mixer?: THREE.AnimationMixer | null;
  /**
   * 表情层（写 morphTargetInfluences + 材质，与骨骼动画正交）。
   * 契约里没有该模型的表情档案时为 null —— 调用方必须判空，不要静默假设「有脸」。
   */
  expression?: ExpressionLayer | null;
  /**
   * `witch.exp/1` 指令入口（**消费方唯一该用的东西**）。
   * 表情层为 null 时它依然存在：指令会走「无表情层」回退并发提示，而不是崩。
   */
  exp: ExpProtocol;
  /**
   * 编辑器用的「摆正」朝向（弧度），来自契约。拆包模型正面朝向与本地轴的关系
   * 各包不同，主场景站位角（如夜兰房间里的 -2.36）只在房间机位下成立。
   */
  defaultRotY?: number;
  /** 契约档案（未走契约的资产为 null） */
  charter: CharterModel | null;
  /** 契约施加报告（未标注材质会列在 unbound 里） */
  report: CharterReport;
}

/** 契约版资产路径（运行期唯一入口） */
export const charterPath = (id: string) => `/models/${id}.charter.glb`;

/* ------------------------------------------------------------------ *
 * 加载：fetch（带进度/取消/缓存）→ GLTFLoader.parse
 *
 * 为什么不用 `loader.load()`：那条路没有进度回调之外的任何控制——不能取消、
 * 不能超时、失败重试要自己包，而且每次切换角色都会把 9–24 MB 重新下一遍。
 * 这里自己抓 ArrayBuffer，换来四件事：
 *   ① 真进度（按 content-length 算，不是「加载中…」）；
 *   ② AbortSignal 贯穿（切页/换角色时立刻断掉在途请求）；
 *   ③ 同一 URL 的内存缓存（换装/来回切角色不重复下载）；
 *   ④ 超时可控（弱网下不再无限转圈）。
 * ------------------------------------------------------------------ */

/** Draco 解码器目录（构建时由 `public/decoders/draco/` 提供；只在遇到压缩资产时才下载 wasm） */
let dracoDecoderPath: string | null = '/decoders/draco/';
let dracoLoader: DRACOLoader | null = null;

/** 覆盖 Draco 解码器路径；传 null 关闭（不支持压缩资产） */
export function setDracoDecoderPath(path: string | null) {
  dracoDecoderPath = path;
  dracoLoader?.dispose();
  dracoLoader = null;
}

export interface LoadProgress {
  loaded: number;
  total: number;
  /** 0–1；服务端没给 content-length 时为 0 */
  ratio: number;
}

export interface LoadOptions {
  signal?: AbortSignal;
  onProgress?: (p: LoadProgress) => void;
  /** 毫秒；默认 30000。超时按 AbortError 抛出 */
  timeoutMs?: number;
}

/** URL → ArrayBuffer 的进程内缓存（同一页里的换装/回切不再重下） */
const bufferCache = new Map<string, ArrayBuffer>();

/** 清缓存（编辑器热切换/调试用；正常业务不需要） */
export function clearAssetCache(url?: string) {
  if (url) bufferCache.delete(url);
  else bufferCache.clear();
}

export function assetCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const b of bufferCache.values()) bytes += b.byteLength;
  return { entries: bufferCache.size, bytes };
}

function concatChunks(chunks: Uint8Array[], size: number): ArrayBuffer {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

/**
 * 抓一个二进制资源。缓存在**解码成 ArrayBuffer 之后**，所以命中时进度直接 100%：
 * 这不是「假装在加载」，而是真的不用再走网络。
 */
export async function fetchBinary(url: string, opts: LoadOptions = {}): Promise<ArrayBuffer> {
  const hit = bufferCache.get(url);
  if (hit) {
    opts.onProgress?.({ loaded: hit.byteLength, total: hit.byteLength, ratio: 1 });
    return hit;
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs)
    : null;
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || 0;
    const body = res.body;
    if (!body) {
      const buf = await res.arrayBuffer();
      bufferCache.set(url, buf);
      opts.onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, ratio: 1 });
      return buf;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        opts.onProgress?.({ loaded, total, ratio: total > 0 ? Math.min(1, loaded / total) : 0 });
      }
    }
    const buf = concatChunks(chunks, loaded);
    bufferCache.set(url, buf);
    opts.onProgress?.({ loaded, total: total || loaded, ratio: 1 });
    return buf;
  } catch (e) {
    if (timedOut) throw new Error(`${url}: 加载超时（${timeoutMs} ms）`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const gltfLoader = new GLTFLoader();
function loader(): GLTFLoader {
  if (dracoDecoderPath) {
    if (!dracoLoader) {
      dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath(dracoDecoderPath);
    }
    gltfLoader.setDRACOLoader(dracoLoader);
  }
  return gltfLoader;
}

/** 以 `/` 开头 = 任意项目内路径；否则按 `/assets/models/<file>` 解析 */
const assetUrl = (file: string) => (file.startsWith('/') ? file : `/assets/models/${file}`);

async function loadGLB(file: string, opts: LoadOptions = {}): Promise<GLTF> {
  const url = assetUrl(file);
  const buf = await fetchBinary(url, opts);
  // 第二个参数是相对路径前缀：GLB 自包含时它只影响外部贴图/缓冲的解析
  return loader().parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
}


/** 归一化：缩放到目标高度，脚底贴 y=base */
function normalizeModel(obj: THREE.Object3D, targetH: number, base = 0): THREE.Group {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const k = targetH / size.y;
  obj.scale.setScalar(k);
  obj.position.y += base - box.min.y * k;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  const g = new THREE.Group();
  g.add(obj);
  return g;
}

/**
 * 角色光台架（局部坐标，随角色转；模型正面朝 -Z）：
 * 正面柔光救动漫贴图被冷底光洗灰的脸 + 背侧暖轮廓光。
 * 这是**渲染端策略**（与机位/房间灯光设计绑定），不进资产契约。
 */
function addLightRig(group: THREE.Group) {
  const face = new THREE.PointLight(0xffe8d0, 1.4, 2.6, 1.9);
  face.position.set(0, 1.25, -0.95);
  group.add(face);
  const rim = new THREE.PointLight(0xffd0a0, 2.6, 3.0, 1.8);
  rim.position.set(0.3, 1.2, 0.55);
  group.add(rim);
}

export interface LoadCharacterOptions extends LoadOptions {
  /** 挂角色光台架（房间用 true；编辑器自带场景灯时传 false） */
  withLights?: boolean;
  /** 覆盖站位（房间机位标定）；省略则用契约档案里的 standPosition */
  position?: THREE.Vector3;
  /** 覆盖朝向；省略则用契约档案里的 standRotY */
  rotY?: number;
}

/**
 * 加载契约版角色资产。这是**唯一**的角色加载入口。
 *
 * 契约缺失时直接抛错——宁可炸得响，也不要静默退化成「靠名字猜」，
 * 那正是这次改造要消灭的东西。
 */
export async function loadCharacter(
  id: string,
  opts: LoadCharacterOptions = {},
): Promise<CharacterHandles> {
  const gltf = await loadGLB(charterPath(id), opts);
  const charter = readModelCharter(gltf.scene);
  if (!charter) {
    throw new Error(
      `${id}: 资产没有契约标注。请确认加载的是 <id>.charter.glb，并先跑 `
      + `\`node pipeline/charter-glb.mjs assets/models/${id}.glb\`。`,
    );
  }

  const report = applyCharter(gltf.scene);
  if (report.unbound.length) {
    console.warn(`[charter] ${id} 有 ${report.unbound.length} 个材质未标注（将退回名字兜底）:`, report.unbound);
  }

  // 表情层：契约缺失/模型无 morph 时为 null（引擎不猜、不造）
  const expression = await loadExpression(id, gltf.scene);
  // 指令层：即便没有表情层也要有 —— 否则消费方一个 `emote` 就直接 TypeError，
  // 而不是拿到「这个模型做不了」的提示。
  const manifest = await loadExpressionManifest();
  const exp = new ExpProtocol({
    expr: expression,
    slots: manifest?.slots ?? {},
    modelId: id,
  });

  const group = normalizeModel(gltf.scene, charter.targetHeight);
  if (opts.withLights !== false) addLightRig(group);

  const stand = opts.position
    ?? (charter.standPosition ? new THREE.Vector3(...charter.standPosition) : null);
  if (stand) group.position.copy(stand);
  group.rotation.y = opts.rotY ?? charter.standRotY ?? 0;

  return {
    group,
    position: group.position,
    mixer: null,
    expression,
    exp,
    defaultRotY: charter.defaultRotY,
    charter,
    report,
  };
}

/**
 * 释放一个角色独占的 GPU 资源：几何 / 材质 / 材质引用的贴图 / group 上的灯光。
 *
 * 为什么单独一个函数而不是塞进 `stage.dispose()`：角色是可以**中途换掉**的
 * （换装、换人、队伍增删），舞台却要一直活着。`character-rendering` 那边的
 * `dispose()` 只负责 SDF 贴图，GLB 的几何与材质没人管——这就是之前换角色会
 * 一点点吃显存的原因。
 *
 * 不要拿它释放共享材质（`modernMaterials()` 那套单例属于内容层，跨舞台存活）。
 */
export function disposeCharacter(handles: CharacterHandles): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  handles.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      if (mesh.geometry) geometries.add(mesh.geometry);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) if (m) materials.add(m);
    }
    const light = o as THREE.Light;
    if (light.isLight) light.dispose?.();
  });

  for (const m of materials) {
    // three 的 Material.dispose 不碰贴图，得自己扫一遍属性
    for (const value of Object.values(m as unknown as Record<string, unknown>)) {
      const tex = value as THREE.Texture | null;
      if (tex && (tex as THREE.Texture).isTexture) textures.add(tex);
    }
    m.dispose();
  }
  for (const t of textures) t.dispose();
  for (const g of geometries) g.dispose();

  handles.group.removeFromParent();
  handles.group.clear();
}

/* ------------------------------------------------------------------ *
 * 以下为不走契约的两条线：CC0 程序化角色（网格手术）与静态陈设。
 * 「程序化构造 + 网格手术」是通用能力（下载资产不合方向时按材质名 + 几何判据
 * 切面，比重新建模便宜），但材质名判据只出现在这里，不扩散到契约路径。
 * ------------------------------------------------------------------ */

/** 去尖帽：删除指定材质网格中 y ≥ threshold 的面（帽锥与长袍合并网格时按高度切） */
function cutAbove(root: THREE.Object3D, yThreshold: number, matNamePart: string) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (!mat.name || !mat.name.includes(matNamePart)) return;
    const geom = m.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;
    const keep: number[] = [];
    if (index) {
      for (let f = 0; f < index.count; f += 3) {
        const a = index.getX(f), b = index.getX(f + 1), c = index.getX(f + 2);
        if (pos.getY(a) < yThreshold && pos.getY(b) < yThreshold && pos.getY(c) < yThreshold) {
          keep.push(a, b, c);
        }
      }
    } else {
      for (let v = 0; v < pos.count; v += 3) {
        if (pos.getY(v) < yThreshold && pos.getY(v + 1) < yThreshold && pos.getY(v + 2) < yThreshold) {
          keep.push(v, v + 1, v + 2);
        }
      }
    }
    const g2 = geom.clone();
    g2.setIndex(keep);
    m.geometry = g2;
  });
}

/** 去帽檐外环 + T-pose 横臂：按**面心**判据删除 y>minY 且 |x|>maxX 的面 */
function cutWideRing(root: THREE.Object3D, minY: number, maxX: number, matNamePart: string) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (!mat.name || !mat.name.includes(matNamePart)) return;
    const geom = m.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;
    const keep: number[] = [];
    const drop = (a: number, b: number, c: number) => {
      const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
      const cx = Math.abs(pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      return cy > minY && cx > maxX;
    };
    if (index) {
      for (let f = 0; f < index.count; f += 3) {
        const a = index.getX(f), b = index.getX(f + 1), c = index.getX(f + 2);
        if (!drop(a, b, c)) keep.push(a, b, c);
      }
    } else {
      for (let v = 0; v < pos.count; v += 3) {
        if (!drop(v, v + 1, v + 2)) keep.push(v, v + 1, v + 2);
      }
    }
    const g2 = geom.clone();
    g2.setIndex(keep);
    m.geometry = g2;
  });
}

function std(opt: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial(opt);
}

/**
 * 加载工装女巫（Chibi Witch CC0 路线，已由夜兰替代；保留作对比与网格手术参考实现）。
 * 站位：台前右角 (2.6, 1.5)，面向房间中央（相机从 (+x,+z) 看）。
 * 附带一盏低位暖补光——样张实测发现「角色全景偏暗」，深色长袍在暗环境里吃亏，
 * 「角色=卖点」需要这盏灯（融合定稿 §6.5 发现 2）。
 */
export async function loadChibiWitch(
  mats: ModernMaterials = modernMaterials(),
): Promise<CharacterHandles> {
  const gltf = await loadGLB('witch.glb');
  cutAbove(gltf.scene, 6.0, 'DarkBlue');          // 去帽锥（传统魔幻符号）
  cutWideRing(gltf.scene, 3.2, 0.85, 'DarkBlue'); // 去帽檐（含内环）+ T-pose 横臂
  const witch = normalizeModel(gltf.scene, 1.05);

  // 程序化袖臂替代被切的 T-pose 臂（袖 + 手，工装色）
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.042, 0.32, 8),
      std({ color: 0x2e2850, roughness: 0.9 }),
    );
    sleeve.position.y = -0.16;
    arm.add(sleeve);
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 8),
      std({ color: 0xe8c8b0, roughness: 0.8 }),
    );
    hand.position.y = -0.35;
    arm.add(hand);
    arm.position.set(s * 0.23, 0.58, 0.02);
    arm.rotation.z = s * 0.38;
    arm.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    witch.add(arm);
  }

  // 护目镜（工装化）：黄铜圈 + 深色镜片，贴脸部高度
  const box = new THREE.Box3().setFromObject(witch);
  const goggles = new THREE.Group();
  goggles.add(new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 18), mats.brass));
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.046, 18),
    std({ color: 0x2a2c34, roughness: 0.15, metalness: 0.6 }),
  );
  lens.position.z = 0.008;
  goggles.add(lens);
  goggles.position.set((box.min.x + box.max.x) / 2, box.max.y - 0.14, box.max.z - 0.005);
  witch.add(goggles);

  witch.position.set(2.6, 0, 1.5);
  // 朝向：样张实证值（相机 (+x,+z) 方位角≈0.79 时 -0.5 可见正脸；
  // 该模型正面朝向与本地轴映射不直观，勿按 lookAt 推导，以样张截图为基准）
  witch.rotation.y = -0.5;

  // 角色暖补光（低位、小半径，只抬脸不洗环境；样张实测「角色全景偏暗」的对策）
  const rim = new THREE.PointLight(0xffd0a0, 2.6, 3.0, 1.8);
  rim.position.set(2.85, 1.1, 1.85);
  witch.add(rim);

  return {
    group: witch, position: witch.position, mixer: null, expression: null,
    // 程序化角色没有表情契约：指令一律走「无表情层」回退，仍然有提示
    exp: new ExpProtocol({ expr: null, slots: {}, modelId: 'witch' }),
    defaultRotY: -0.5, charter: null,
    report: { bound: 0, unbound: [], roles: {}, modelId: null, morphOnlyHidden: [] },
  };
}

/** 台面药瓶陈设（验证期资产，台面两端，不挡工位） */
export async function loadProps(mats: ModernMaterials = modernMaterials()): Promise<THREE.Group> {
  const g = new THREE.Group();
  const gltf = await loadGLB('potion.glb');
  const spots: Array<[number, number, number, number]> = [
    [-1.45, 0.955, 0.95, 1.0], [-1.5, 0.955, 0.55, 0.85],
    [2.5, 0.955, 0.9, 0.92], [2.45, 0.955, 0.4, 0.8],
  ];
  for (const [x, y, z, s] of spots) {
    const p = normalizeModel(gltf.scene.clone(true), 0.16 * s);
    p.position.set(x, y, z);
    p.rotation.y = Math.random() * Math.PI;
    g.add(p);
  }
  void mats;
  return g;
}
