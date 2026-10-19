/**
 * 人物编辑器：单人模型 + 与主工程一致的渲染配置（ACES + 冷底暖光 + Bloom）。
 * 用途：调试角色渲染效果、标定朝向/缩放、检查骨架绑定、**查看/对照材质契约**。
 *
 * 模型清单来自 assets/models/charter-manifest.json（由 pipeline/charter-glb.mjs 产出），
 * 清单里每个模型有「契约版」与「原版」两个入口 —— 同机位切换即 A/B 对照，
 * 用来确认契约映射（材质族/层序/alpha/描边/通道）没改坏观感。
 *
 * 材质契约面板（左上）三段：
 *   ① 模型档案（契约版本 / 授权 / 几何规模 / 族分布）
 *   ② **材质查看器** —— 下拉选任一材质 → 材质球（可切「契约轨道 / 原材质」）+
 *      契约字段 + 终末地通道缩略图；「隔离此材质」在主视图只留该件
 *   ③ 材质表（全览，行与下拉联动）
 *
 * 与 scene.ts 的共享约定（改动要同步）:
 *   - renderer: ACESFilmic + exposure 1.3 + PCFShadow
 *   - 灯光: hemi 紫蓝 + ambient + 暖方向光主光 + 冷暮光
 *   - Bloom: UnrealBloomPass(0.62, 0.55, 0.74) + OutputPass
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { createPostChain } from '../src/post';
import { createToneMapPass, createEncodePass } from '../src/output-passes';
import { loadCharacter, loadChibiWitch, type CharacterHandles } from '../src/character';
import { channelOfTexture, materialCharter, type CharterMaterial } from '../src/charter';
import {
  createNprUniforms,
  roleOfMaterial,
  toNprMaterial,
  updateNprUniforms,
  type MaterialRole,
  type NprUniforms,
} from '../src/npr';
import { prepareCharacterRendering, discardPreparedCharacter, faceSdfStatusText, type CharacterRendering } from '../src/character-rendering';
import { setQueue } from '../src/queue';
import { loadRawModel } from './raw';
import { buildStudio } from './studio';
import type { ExpCommand, ExpNotice } from '../src/exp-contract';

// ---------- 基础（渲染配置与主工程一致） ----------

const container = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186：PCFSoft 已移除
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
container.appendChild(renderer.domElement);

/**
 * 无头/软件光栅（SwiftShader）对**第二个** WebGL 上下文极其脆弱——实测
 * character.html 双上下文必崩、`?noviewer=1` 单上下文稳定。所以查看器在
 * 检测到软件渲染时自动不建（真实浏览器不受影响，正常显示材质球）。
 */
function isSoftwareGL(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|software|llvmpipe|angle \(software/i.test(s);
  } catch { return false; }
}

const scene = new THREE.Scene();

// 轻科幻展示棚：浅灰背景 + 板缝线 + 弧线标线地面 + 雾（studio 内含 fog/background/floor）
buildStudio(scene);

// 展示台（diorama 圆盘 + 淡网格，浅灰版）
const pad = new THREE.Mesh(
  new THREE.CylinderGeometry(1.5, 1.6, 0.12, 48),
  new THREE.MeshStandardMaterial({ color: 0xccd1d8, roughness: 0.9 }),
);
pad.position.y = -0.06;
pad.receiveShadow = true;
scene.add(pad);
const grid = new THREE.PolarGridHelper(1.5, 8, 4, 48, 0x9c98a4, 0xb4b0ba);
grid.position.y = 0.002;
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.4;
scene.add(grid);

// ---- 灯光（与 scene.ts 同款冷底暖光）----
const hemi = new THREE.HemisphereLight(0x565a8a, 0x241d2e, 0.5);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x3a3355, 0.55);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xffc890, 1.35);
key.position.set(-3.5, 5.5, 2.6);
key.target.position.set(0.3, 0.6, 0.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -7;
key.shadow.camera.right = 7;
key.shadow.camera.top = 7;
key.shadow.camera.bottom = -7;
key.shadow.camera.far = 16;
key.shadow.bias = -0.0006;
scene.add(key, key.target);

const moon = new THREE.DirectionalLight(0xb8cce8, 0.55);
moon.position.set(2.2, 2.6, -2.2);
scene.add(moon);

const fill = new THREE.PointLight(0xffd9a0, 6, 10, 1.6);
fill.position.set(1.9, 1.8, -2.4);
scene.add(fill);

// 角色专属暖补光（编辑器里挂在场景，位置随模型中点）
const rim = new THREE.PointLight(0xffd0a0, 2.6, 3.0, 1.8);
rim.position.set(0.45, 0.9, 1.1);
scene.add(rim);

// ---- 灯光预设：棚拍中性（轻科幻展示棚默认）/ 冷底暖光（主工程契约，标定用）----
// 颜色+强度一起切（浅色棚里原暖光强度必过曝），滑杆位置同步回写。
const LIGHT_PRESETS = {
  studio: {
    colors: { hemiSky: 0xe6eaf0, hemiGround: 0xb6bac2, ambient: 0xd0d3da, key: 0xffffff, moon: 0xe2e8f2, fill: 0xffffff, rim: 0xfff0e0 },
    sliders: { key: 0.7, hemi: 0.7, moon: 0.3, rim: 1.2, bloom: 0.2 },
    fill: 1.8,
  },
  warm: {
    colors: { hemiSky: 0x565a8a, hemiGround: 0x241d2e, ambient: 0x3a3355, key: 0xffc890, moon: 0xb8cce8, fill: 0xffd9a0, rim: 0xffd0a0 },
    sliders: { key: 1.35, hemi: 1.05, moon: 0.55, rim: 2.6, bloom: 0.62 },
    fill: 6,
  },
};
let lightMode: keyof typeof LIGHT_PRESETS = 'studio';
function applyLightColors() {
  const p = LIGHT_PRESETS[lightMode];
  hemi.color.set(p.colors.hemiSky);
  hemi.groundColor.set(p.colors.hemiGround);
  ambient.color.set(p.colors.ambient);
  key.color.set(p.colors.key);
  moon.color.set(p.colors.moon);
  fill.color.set(p.colors.fill);
  rim.color.set(p.colors.rim);
  key.intensity = p.sliders.key;
  hemi.intensity = p.sliders.hemi * 0.5;
  ambient.intensity = p.sliders.hemi * 0.55;
  moon.intensity = p.sliders.moon;
  rim.intensity = p.sliders.rim;
  bloomPass.strength = p.sliders.bloom;
  fill.intensity = p.fill;
  // 滑杆 UI 同步（值+读数）
  const sync = (id: string, valId: string, v: number, fmt: (x: number) => string) => {
    $inp(id).value = String(v);
    $(valId).textContent = fmt(v);
  };
  sync('key', 'keyVal', p.sliders.key, (x) => x.toFixed(2));
  sync('hemi', 'hemiVal', p.sliders.hemi, (x) => x.toFixed(2));
  sync('moon', 'moonVal', p.sliders.moon, (x) => x.toFixed(2));
  sync('rim', 'rimVal', p.sliders.rim, (x) => x.toFixed(2));
  sync('bloom', 'bloomVal', p.sliders.bloom, (x) => x.toFixed(2));
  $('lightMode').textContent = lightMode === 'studio' ? '灯光：棚拍中性' : '灯光：冷底暖光';
  applyFaceGlow();
}

// 面部自发光按灯光语境缩放：契约 0.55 是暗房标定值，浅棚里会把脸糊成白团
// （实测：棚拍档全脸 emissive 清零后脸部完全正常）。studio 压到 0.15 倍只留一丝眼睛辉光。
// 基值读 materialCharter（userData.charter.faceGlow）——遵守「运行期只认 charter」纪律。
const FACE_GLOW_SCALE: Record<keyof typeof LIGHT_PRESETS, number> = { studio: 0.15, warm: 1 };
function applyFaceGlow() {
  if (!character) return;
  character.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const c = materialCharter(m);
      if (c?.role === 'face' && (c.faceGlow ?? 0) > 0) {
        (m as THREE.MeshStandardMaterial).emissiveIntensity = (c.faceGlow as number) * FACE_GLOW_SCALE[lightMode];
      }
    }
  });
}

// ---- 相机 + 轨道控制（编辑器要自由检视，不做固定机位）----
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
camera.position.set(2.1, 1.35, 3.0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 1.2;

// ---- 后期：走引擎的 PostChain（与舞台同一条链，不再自建 EffectComposer）----
// 这里**刻意保留**编辑器原有的观感：不开 MSAA（samples 0）、HDR 半浮点、
// Bokeh 在 Bloom 之前——并轨是为了「编辑器看到的 = 运行时看到的」，
// 不是为了顺手改画面。锚点与舞台一致：beforeTonemap → tonemap → encode。
const post = createPostChain(renderer, {
  width: 1,
  height: 1,
  samples: 0,
  type: THREE.HalfFloatType,
});
post.add(new RenderPass(scene, camera), { id: 'scene', anchor: 'scene', priority: 0, locked: true });
// 景深：焦点实时锁在轨道目标（角色），坡度放缓——近处地面保持锐利，远处才糊进天空
const bokehPass = new BokehPass(scene, camera, { focus: 4.0, aperture: 0.0012, maxblur: 0.008 });
post.add(bokehPass, { id: 'bokeh', anchor: 'beforeTonemap', priority: 5 });
const bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.62, 0.55, 0.74);
post.add(bloomPass, { id: 'bloom', anchor: 'beforeTonemap', priority: 10 });
post.add(createToneMapPass(), { id: 'tonemap', anchor: 'tonemap', priority: 0, locked: true, internal: true });
post.add(createEncodePass(), { id: 'encode', anchor: 'encode', priority: 0, locked: true, internal: true });

/* ------------------------------------------------------------------ *
 * 材质查看器：独立小 renderer + 材质球（球 / 平面两种载体）
 *
 * 这是材质契约的**最终消费者视图**：选一个材质，看它在契约里被判成什么族、
 * 走哪条轨道、生效哪些终末地通道。「契约轨道」开着时材质经 toNprMaterial
 * 转换——所以看到的就是运行期着色，而不是 glTF 原样。
 *
 * ⚠️ 这是页面上**第二个** WebGL 上下文。无头浏览器（SwiftShader 软件光栅）
 * 对双上下文很脆，实测会偶发整页崩溃——所以查看器做得极轻（无 AA / dpr=1 /
 * 半速渲染），并留 `?noviewer=1` 整体关掉（此时面板只剩文字与通道缩略图）。
 * ------------------------------------------------------------------ */

const MV_OFF = new URLSearchParams(location.search).has('noviewer') || isSoftwareGL(renderer);
let mvRenderer: THREE.WebGLRenderer | null = null;
let mvScene: THREE.Scene | null = null;
let mvCam: THREE.PerspectiveCamera | null = null;
let ballMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null;
let quadMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null;
let mvNpr: ReturnType<typeof createNprUniforms> | null = null;
let mvUseTrack = true;   // 契约轨道 / 原材质
let mvSpin = true;
let mvMat: THREE.Material | null = null;
let mvYaw = 0.5, mvPitch = -0.12;
let mvFrame = 0;

if (!MV_OFF) {
  mvRenderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('matBall') as HTMLCanvasElement,
    antialias: false, // 200px 的小球，AA 的开销不值（也是无头环境减负）
    alpha: true,      // 底色交给 CSS（中性灰径向渐变），深浅件都读得出来
  });
  mvRenderer.setPixelRatio(1);
  mvRenderer.outputColorSpace = THREE.SRGBColorSpace;
  mvRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  mvRenderer.toneMappingExposure = 1.3;

  mvScene = new THREE.Scene();
  mvCam = new THREE.PerspectiveCamera(30, 200 / 142, 0.1, 30);
  mvCam.position.set(0, 0, 4.0);

  ballMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    new THREE.SphereGeometry(1, 32, 20),
    new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.5 }),
  );
  quadMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: 0x8a8a92 }),
  );
  quadMesh.visible = false;
  mvScene.add(ballMesh, quadMesh);

  // 中性三点光：刻意不带上位色偏，避免把材质的固有色读错
  const mvKey = new THREE.DirectionalLight(0xffffff, 2.3); mvKey.position.set(2.4, 3.2, 3.6);
  const mvFill = new THREE.DirectionalLight(0xdce6ff, 0.85); mvFill.position.set(-3.4, 0.4, 2.4);
  const mvRim = new THREE.DirectionalLight(0xfff2e2, 1.6); mvRim.position.set(-1.4, -1.8, -3.2);
  mvScene.add(mvKey, mvFill, mvRim);
  mvScene.add(new THREE.HemisphereLight(0xffffff, 0x4c4c58, 1.0));

  // 材质球与主视图共用同一套 NPR uniform（注入项跟着查看器相机走）
  mvNpr = createNprUniforms();
}

/** 把材质克隆一份给材质球用（原材质留着给模型，互不影响） */
function ballMaterialOf(src: THREE.Material, useTrack: boolean): { mat: THREE.Material; track: MaterialRole } {
  let m: THREE.Material = src.clone();
  const track = roleOfMaterial(src);
  if (useTrack) {
    const conv = toNprMaterial(m, mvNpr!);
    if (conv !== m) m.dispose();
    m = conv;
  }
  // 描边壳是「背面 + 沿法线外扩」的，球体上完全看不见 → 查看器里翻成正面（看它的颜色）
  const anyM = m as THREE.MeshBasicMaterial;
  if (anyM.side === THREE.BackSide) anyM.side = THREE.FrontSide;
  // 薄片叠加件（眼/口/贴片）自带透明，球体上会几乎消失 —— 抬到可读的下限
  if (m.transparent && m.opacity < 0.55) m.opacity = Math.max(m.opacity, 0.55);
  m.name = src.name;
  return { mat: m, track };
}

// ---------- 模型管理 ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement;

let character: CharacterHandles | null = null;
let skelHelper: THREE.SkeletonHelper | null = null;
let jointPoints: THREE.Points | null = null;
let bones: THREE.Bone[] = [];

const origMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
const unlitPool = new Map<THREE.Mesh, THREE.MeshBasicMaterial>();
const trackPool = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
const normalMat = new THREE.MeshNormalMaterial();
const wireMat = new THREE.MeshBasicMaterial({ color: 0x8a7fae, wireframe: true });

// ---- 契约轨道（NPR 注入）----
// 与主工程同一套 uniforms；主视图用的编辑器相机与 key 灯每帧回写（方向接线）。
const editNpr: NprUniforms = createNprUniforms();
let characterRendering: CharacterRendering | null = null;
let loadGeneration = 0;

function disposeCharacter() {
  if (!character) return;
  scene.remove(character.group);
  if (skelHelper) { scene.remove(skelHelper); skelHelper.dispose(); skelHelper = null; }
  if (jointPoints) { scene.remove(jointPoints); jointPoints.geometry.dispose(); jointPoints = null; }
  character.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat.dispose());
    }
  });
  origMaterials.clear();
  for (const u of unlitPool.values()) u.dispose();
  unlitPool.clear();
  for (const t of trackPool.values()) (Array.isArray(t) ? t : [t]).forEach((m) => m.dispose());
  trackPool.clear();
  characterRendering?.dispose();
  characterRendering = null;
  character = null;
  bones = [];
}

type ModelKind = string; // 'c:<id>' 契约版 | 'r:<id>' 原版对照 | 'witch'

/* ---------- 模型清单：来自 charter-manifest.json（运行时发现，不硬编码） ---------- */

interface ManifestMaterial {
  name: string; role: string; track: string; layer: number; hit: string;
  alphaMode: string; faceGlow?: number; tex?: Record<string, string | null>;
}
interface ManifestModel {
  id: string; name?: string; license?: string; defaultRotY: number; targetHeight: number;
  standPosition: number[] | null; stats: Record<string, number>;
  roles: Record<string, number>; materials: ManifestMaterial[];
  textures?: ManifestTexture[];
}
interface Manifest { charterVersion: number; generatedAt: string; models: ManifestModel[] }

let manifest: Manifest | null = null;
const manifestOf = (id: string) => manifest?.models.find((m) => m.id === id) ?? null;

async function loadManifest() {
  try {
    const r = await fetch('/models/charter-manifest.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = await r.json() as Manifest;
  } catch (e) {
    console.warn('[charter] manifest 未读到（先跑 pipeline/charter-glb.mjs --all）', e);
  }
  const sel = $sel('model');
  const prev = sel.value;
  const html: string[] = [];
  if (manifest?.models.length) {
    html.push('<optgroup label="契约版（运行期使用）">');
    for (const m of manifest.models) {
      html.push(`<option value="c:${m.id}">${m.name ? `${m.name} · ` : ''}${m.id}</option>`);
    }
    html.push('</optgroup>');
    html.push('<optgroup label="原版（回归对照 · 无契约）">');
    for (const m of manifest.models) {
      html.push(`<option value="r:${m.id}">${m.name ? `${m.name} · ` : ''}${m.id}</option>`);
    }
    html.push('</optgroup>');
  } else {
    html.push('<option value="c:yelan">夜兰 · yelan（manifest 缺失，降级）</option>');
  }
  html.push('<option value="witch">工装女巫（Chibi CC0）</option>');
  sel.innerHTML = html.join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/* ------------------------------------------------------------------ *
 * 材质查看器：索引 / 材质球 / 契约字段 / 通道缩略图
 * ------------------------------------------------------------------ */

interface MatEntry {
  mat: THREE.Material;
  meshes: THREE.Mesh[];
  charter: CharterMaterial | null;
  /** 契约族；无契约时为「名字兜底」标注 */
  role: string;
  track: string;
  layer: number | string;
  bound: boolean;
}

interface ManifestTexture {
  name: string; ch?: string | null; src?: string | null; srcCh?: string | null;
  size?: string | null; kb?: number; alpha?: { zero: number; partial: number } | null;
}

let matIndex: MatEntry[] = [];
const curTextures = new Map<string, ManifestTexture>();

/** 把当前模型的所有材质摊平成一个索引（下拉 / 表格 / 查看器共用） */
function buildMaterialIndex(group: THREE.Object3D): MatEntry[] {
  const byMat = new Map<THREE.Material, MatEntry>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      let e = byMat.get(mat);
      if (!e) {
        const c = materialCharter(mat);
        e = {
          mat, meshes: [], charter: c,
          role: c?.role ?? `(${roleOfMaterial(mat)})`,
          track: c?.track ?? roleOfMaterial(mat),
          layer: c ? c.layer : '—',
          bound: !!c,
        };
        byMat.set(mat, e);
      }
      e.meshes.push(mesh);
    }
  });
  return [...byMat.values()];
}

/** 材质的终末地通道：契约版直接读，原版资产退回「贴图名 / glTF 槽位」推 */
function channelsOf(e: MatEntry): string[] {
  if (e.charter?.channels?.length) return e.charter.channels;
  const std = e.mat as THREE.MeshStandardMaterial;
  const out: string[] = [];
  const add = (t: THREE.Texture | null | undefined, slot: string) => {
    if (!t) return;
    const ch = channelOfTexture(t) ?? slot;
    if (!out.includes(ch)) out.push(ch);
  };
  add(std.map, 'D');
  add(std.emissiveMap, 'E');
  add(std.normalMap, 'N');
  add(std.aoMap, 'MRO');
  add(std.metalnessMap, 'MRO');
  return out;
}

/** 贴图缩略图：直接把 Texture.image 画进 2D canvas（画不了就留底色，尺寸信息仍在） */
function drawThumb(cv: HTMLCanvasElement, tex: THREE.Texture) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const img = (tex as unknown as { image?: CanvasImageSource & { width?: number } }).image;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!img) return;
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0, cv.width, cv.height);
  } catch { /* ImageData / 压缩纹理：画不了 */ }
}

function renderChannels(e: MatEntry) {
  const std = e.mat as THREE.MeshStandardMaterial;
  const list: Array<[string, THREE.Texture | null | undefined]> = [
    ['D', std.map], ['E', std.emissiveMap], ['N', std.normalMap],
    ['MRO', std.aoMap], ['MRO', std.metalnessMap],
  ];
  const host = $('matChannels');
  host.innerHTML = '';
  const seen = new Set<THREE.Texture>();
  for (const [slot, tex] of list) {
    if (!tex || seen.has(tex)) continue;
    seen.add(tex);
    const ch = channelOfTexture(tex) ?? slot;
    const img = (tex as unknown as { image?: { width?: number; height?: number } }).image;
    const rec = curTextures.get(tex.name);
    const div = document.createElement('div');
    div.className = 'chan';
    div.title = rec?.src ? `原始文件：${rec.src}` : (tex.name || '');
    div.innerHTML = '<canvas width="124" height="124"></canvas>'
      + `<div class="lab"><b>${ch}</b> ${tex.name || '—'}<br>`
      + `${img?.width && img?.height ? `${img.width}×${img.height}` : '—'}`
      + (rec?.kb ? ` · ${rec.kb}KB` : '')
      + (rec?.alpha ? ` · α0 ${(rec.alpha.zero * 100).toFixed(0)}%` : '')
      + (rec?.src ? `<br>${rec.src}` : '')
      + '</div>';
    host.appendChild(div);
    drawThumb(div.querySelector('canvas') as HTMLCanvasElement, tex);
  }
  if (!host.children.length) {
    host.innerHTML = '<div style="font-size:10px;color:#7a7062">该材质没有绑定贴图（纯色 / 常量件）</div>';
  }
}

/** 契约字段 + 备注（faceGlow / 描边 / 转换期修正） */
function renderFacts(e: MatEntry) {
  const c = e.charter;
  const std = e.mat as THREE.MeshStandardMaterial;
  const alpha = e.mat.transparent ? 'BLEND' : (std.alphaTest > 0 ? 'MASK' : 'OPAQUE');
  const tri = e.meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count / 3 : 0), 0);
  const chans = channelsOf(e);
  const notes: string[] = [];
  if (typeof c?.faceGlow === 'number' && c.faceGlow > 0) notes.push(`<span class="ok">面部自发光 ${c.faceGlow}</span>`);
  if (c?.outline) notes.push(`<span class="k">描边壳 ${c.outline}</span>`);
  if (c?.emissiveFromD) notes.push('<span class="ok">D 兼任自发光图</span>');
  if (c?.alphaFixed) notes.push(`<span class="ok">alpha 修正 → ${c.alphaFixed}</span>`);
  if (c?.metalFixed) notes.push('<span class="k">金属归零</span>');
  if (c?.metalRestored) notes.push('<span class="ok">金属值恢复</span>');

  $('matFacts').innerHTML = [
    `<span class="role" data-r="${e.role}">${e.role}</span> <span class="k">轨道</span> ${e.track}`,
    `<span class="k">层</span> ${e.layer} · <span class="k">alpha</span> ${alpha} · ${Math.round(tri).toLocaleString()} tri`,
    c
      ? `<span class="k">判定</span> ${c.hit}${c.layerHit === 'override' ? ' · 层为人工覆盖' : ''}`
      : '<span class="warn">无契约标注（走名字兜底）</span>',
    `<span class="k">终末地通道</span> ${chans.length ? chans.map((x) => `<b style="color:#e8a34c">${x}</b>`).join(' ') : '—'}`,
    c ? `<span class="k">原材质名</span> ${c.srcName}${c.pmxOrder !== null ? ` · PMX#${c.pmxOrder}` : ''}` : '',
    notes.join(' · '),
  ].filter(Boolean).join('<br>');
}

/* ---------- 隔离：主视图只留选中材质的网格 ---------- */

const meshVis = new Map<THREE.Mesh, boolean>();
let isoOn = false;

function captureVisibility(group: THREE.Object3D) {
  meshVis.clear();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshVis.set(m, m.visible);
  });
}

function applyIsolation() {
  if (!isoOn) {
    for (const [mesh, v] of meshVis) mesh.visible = v;
    return;
  }
  const e = matIndex[parseInt($inp('matSel').value, 10)];
  if (!e) return;
  const keep = new Set(e.meshes);
  for (const [mesh, v] of meshVis) mesh.visible = v && keep.has(mesh);
}

/** 选中第 i 个材质：材质球 / 契约字段 / 通道 / 表格高亮 / 隔离 一起更新 */
function selectMaterial(i: number) {
  const e = matIndex[i];
  const trs = $('charterTable').querySelectorAll('tbody tr');
  trs.forEach((tr, k) => tr.classList.toggle('sel', k === i));
  if (!e) {
    $('matFacts').textContent = '—';
    $('matChannels').innerHTML = '';
    return;
  }

  // 材质球（?noviewer=1 时没有 GL 上下文，只剩文字与通道缩略图）
  if (ballMesh && quadMesh) {
    if (mvMat) mvMat.dispose();
    const { mat, track } = ballMaterialOf(e.mat, mvUseTrack);
    mvMat = mat;
    // 脸部叠加件（unlit + 有贴图）在球体上读不出内容 → 换成平面，按贴图比例 1:1 展示
    const useQuad = track === 'unlit' && !!(mat as THREE.MeshBasicMaterial).map;
    if (useQuad) {
      const img = ((mat as THREE.MeshBasicMaterial).map as THREE.Texture & { image?: { width?: number; height?: number } }).image;
      const w = img?.width ?? 1, h = img?.height ?? 1;
      const k = 2 / Math.max(w, h);
      quadMesh.scale.set(w * k, h * k, 1);
      quadMesh.material = mat;
      quadMesh.visible = true;
      ballMesh.visible = false;
    } else {
      ballMesh.material = mat;
      ballMesh.visible = true;
      quadMesh.visible = false;
    }
  }

  renderFacts(e);
  renderChannels(e);
  applyIsolation();
}

/** 契约表 + 模型档案 + 材质下拉（一次加载重绘一次） */
function renderCharterPanel(h: CharacterHandles) {
  const meta = $('charterMeta');
  const table = $('charterTable');
  const m = h.charter ? manifestOf(h.charter.id) : null;
  const counts: Record<string, number> = {};
  let unbound = 0;

  matIndex = buildMaterialIndex(h.group);
  curTextures.clear();
  for (const t of m?.textures ?? []) if (t.name) curTextures.set(t.name, t);

  const rows = matIndex.map((e, i) => {
    counts[e.role] = (counts[e.role] ?? 0) + 1;
    if (!e.bound) unbound++;
    const std = e.mat as THREE.MeshStandardMaterial;
    const alpha = e.mat.transparent ? 'BLEND' : (std.alphaTest > 0 ? 'MASK' : 'OPAQUE');
    const chans = channelsOf(e).join('+') || '—';
    return `<tr data-i="${i}" class="${e.bound ? '' : 'unbound'}">`
      + `<td>${e.mat.name || '(未命名)'}</td>`
      + `<td><span class="role" data-r="${e.role}">${e.role}</span></td>`
      + `<td>${e.track}</td><td class="num">${e.layer}</td>`
      + `<td>${alpha}</td><td>${chans}</td>`
      + `<td>${std.map?.name ?? '—'}</td>`
      + '</tr>';
  });

  if (h.charter) {
    const s = m?.stats;
    meta.innerHTML =
      `<b>${h.charter.name || h.charter.id}</b> · id=${h.charter.id} · 契约 v${h.charter.version}<br>`
      + `身高 ${h.charter.targetHeight}m · 摆正角 ${Math.round(h.charter.defaultRotY * 180 / Math.PI)}°`
      + (s ? ` · 材质 ${s.materials} · 贴图 ${s.textures} · 骨骼 ${s.joints} · ${s.mb}MB` : '')
      + `<br>材质族：${Object.entries(counts).map(([r, c]) => `${r}×${c}`).join('　')}`
      + (unbound ? `<br><span class="lic">⚠ ${unbound} 个材质无契约（退回名字兜底）</span>` : '')
      + (h.charter.license ? `<br><span class="lic">${h.charter.license}</span>` : '');
  } else {
    meta.innerHTML = '<b>原版资产（无契约标注）</b> · 族列是<b>名字兜底判定</b>，仅作对照<br>'
      + '<span class="lic">红行 = 该资产没有契约字段；契约版的差异就出在这些行</span>';
  }

  table.innerHTML =
    '<thead><tr><th>材质</th><th>族</th><th>轨道</th><th>层</th><th>alpha</th><th>通道</th><th>贴图</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody>`;

  // 材质下拉（与表格行联动）
  const sel = $sel('matSel');
  const prev = sel.value;
  sel.innerHTML = matIndex.length
    ? matIndex.map((e, i) => `<option value="${i}">${e.mat.name || '(未命名)'} · ${e.role} · ${e.track}</option>`).join('')
    : '<option value="-1">（该模型无材质）</option>';
  const keep = [...sel.options].some((o) => o.value === prev && prev !== '-1');
  sel.value = keep ? prev : (matIndex.length ? '0' : '-1');

  // ?mat=<名字片段>：深链直选某个材质（分享/自动化用）
  const want = new URLSearchParams(location.search).get('mat');
  if (want && matIndex.length) {
    const hit = matIndex.findIndex((e) => e.mat.name.includes(want) || e.role === want);
    if (hit >= 0) sel.value = String(hit);
  }

  selectMaterial(parseInt(sel.value, 10));
}

/* ------------------------------------------------------------------ *
 * 表情面板：槽位滑条（数据来自 expression-manifest.json，不硬编码）
 *
 * 这是表情契约的「最终消费者视图」：滑条 = 语义槽位，动的却是 morph target
 * 与材质叠加层。滑条列表随模型变化——同一套槽位名在 si 上做不了的会标出来。
 * ------------------------------------------------------------------ */

function renderExpressionPanel(h: CharacterHandles | null) {
  const group = $('exprGroup');
  const host = $('exprSlots');
  const info = $('exprInfo');
  const expr = h?.expression ?? null;
  if (!expr) {
    group.style.display = 'none';
    return;
  }
  group.style.display = '';

  const rows: string[] = [];
  for (const g of expr.groups) {
    const slots = Object.keys(expr.slots).filter((s) => expr.slots[s].group === g && expr.has(s));
    if (!slots.length) continue;
    rows.push(`<div class="title" style="opacity:.55;font-size:10px;margin:8px 0 2px">${g}</div>`);
    for (const s of slots) {
      const cn = expr.slots[s].cn;
      rows.push(
        `<div class="row"><label title="${s}">${cn}</label>`
        + `<input type="range" data-slot="${s}" min="0" max="1" step="0.01" value="0" />`
        + `<span class="val" data-val="${s}">0.00</span></div>`,
      );
    }
  }
  host.innerHTML = rows.join('');
  for (const inp of host.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    inp.addEventListener('input', () => {
      const slot = inp.dataset.slot as string;
      const v = parseFloat(inp.value);
      expr.set(slot, v);
      const out = host.querySelector(`[data-val="${slot}"]`);
      if (out) out.textContent = v.toFixed(2);
    });
  }

  const cov = expr.model.coverage;
  info.innerHTML = `覆盖 ${cov?.covered ?? 0}/${cov?.total ?? 0} 槽位 · target ${expr.model.targets?.length ?? 0}`
    + (expr.model.unresolved.length
      ? `<br><span style="opacity:.55">做不了：${expr.model.unresolved.join(' ')}</span>`
      : '');
  $('exprBlink').classList.toggle('on', expr.autoBlink);
}

/* ------------------------------------------------------------------ *
 * 指令面板：witch.exp/1
 *
 * 这一块是**契约的活体验证**：点一条指令，看脸怎么动、日志怎么报。
 * 尤其「汗（演示回退）」—— si 没有 symbol_sweat，正确行为是回退到中性
 * 并发一条 slot-neutral，而不是什么都不发生。
 * ------------------------------------------------------------------ */

const CMD_PRESETS: { label: string; cmd: ExpCommand | Record<string, unknown> }[] = [
  { label: '开心', cmd: { op: 'emote', slot: 'happy', hold: 2.2 } },
  { label: '生气', cmd: { op: 'emote', slot: 'angry', hold: 2.0 } },
  { label: '难过', cmd: { op: 'emote', slot: 'sad', hold: 2.0 } },
  { label: '惊讶', cmd: { op: 'emote', slot: 'surprised', hold: 1.4 } },
  { label: '害羞', cmd: { op: 'emote', slot: 'shy', hold: 2.4 } },
  { label: '汗→回退', cmd: { op: 'emote', slot: 'symbol_sweat' } },
  { label: '看右', cmd: { op: 'gaze.dir', x: 1, y: 0 } },
  { label: '看左上', cmd: { op: 'gaze.dir', x: -0.7, y: 0.7 } },
  { label: '视线游移', cmd: { op: 'face.auto', what: 'gaze', on: true } },
  { label: '挥手(无动作库)', cmd: { op: 'emote', slot: 'happy', motion: 'wave' } },
  { label: '归零', cmd: { op: 'reset' } },
];

function pushNotice(n: ExpNotice | { code: string; level: string; detail: string }) {
  const log = $('cmdLog');
  const row = document.createElement('div');
  row.className = 'n ' + n.level;
  row.innerHTML = `<span class="c">${n.code}</span> ${n.detail}`;
  log.prepend(row);
  while (log.childElementCount > 30) log.lastElementChild?.remove();
}

function sendCmd(raw: string | unknown) {
  const exp = character?.exp;
  if (!exp) return;
  let cmd: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return;
    try { cmd = JSON.parse(raw); } catch (e) {
      pushNotice({ code: 'unknown-op', level: 'warn', detail: `JSON 解析失败：${e}` });
      return;
    }
    $inp('cmdInput').value = raw;
  }
  exp.apply(cmd as ExpCommand);
}

function renderCmdPanel(h: CharacterHandles | null) {
  const group = $('cmdGroup');
  if (!h) { group.style.display = 'none'; return; }
  group.style.display = '';

  const exp = h.exp;
  exp.setNoticeSink(pushNotice);
  exp.clearNotices();
  $('cmdLog').innerHTML = '';

  const caps = exp.capabilities;
  const parts: string[] = [];
  if (caps) {
    parts.push(`能做 <b>${caps.slots.length}</b>/${caps.slots.length + caps.missing.length} 槽位`);
    parts.push(`视线 <b>${caps.gaze.mode}</b>${caps.gaze.maxDeg ? ` ±${caps.gaze.maxDeg}°` : ''}`);
    if (caps.gaze.bones?.length) parts.push(`眼骨 ${caps.gaze.bones.join('/')}`);
    parts.push(caps.blink ? '自动眨眼' : '<span style="color:#d86a6a">无眨眼</span>');
    if (caps.material) parts.push('材质通道');
    if (caps.missing.length) {
      const byG = new Map<string, number>();
      for (const s of caps.missing) {
        const g = caps.byGroup ? Object.keys(caps.byGroup).find((k) => caps.byGroup[k].missing.includes(s)) : '';
        byG.set(g || '?', (byG.get(g || '?') ?? 0) + 1);
      }
      parts.push(`<span style="color:#8a6a4a">缺 ${[...byG].map(([g, n]) => `${g}${n}`).join(' ')}</span>`);
    }
  } else {
    parts.push('<span style="color:#d86a6a">该模型没有表情契约</span>');
  }
  $('cmdCaps').innerHTML = parts.join(' · ');

  const host = $('cmdPresets');
  host.innerHTML = CMD_PRESETS.map((p, i) => `<button data-i="${i}">${p.label}</button>`).join('');
  for (const btn of host.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => sendCmd(CMD_PRESETS[parseInt(btn.dataset.i as string, 10)].cmd));
  }
}

async function loadModel(kind: ModelKind) {
  const generation = ++loadGeneration;
  disposeCharacter();
  $('stats').textContent = '加载角色与 SDF…';
  let loaded: CharacterHandles;
  // 下拉框跟着变 —— 自动化会绕过 <select> 直接调本函数，不同步的话面板标题会停在旧模型
  const modelSel = $sel('model');
  if ([...modelSel.options].some((o) => o.value === kind)) modelSel.value = kind;
  try {
    if (kind === 'witch') {
      loaded = await loadChibiWitch();
    } else if (kind.startsWith('r:')) {
      const id = kind.slice(2);
      const mm = manifestOf(id);
      loaded = await loadRawModel(id, {
        targetHeight: mm?.targetHeight,
        defaultRotY: mm?.defaultRotY,
      });
    } else {
      loaded = await loadCharacter(kind.slice(2));
    }
    const prepared = await prepareCharacterRendering(loaded, editNpr);
    if (generation !== loadGeneration) {
      discardPreparedCharacter(loaded, prepared);
      return;
    }
    character = loaded;
    characterRendering = prepared;
  } catch (e) {
    if (generation === loadGeneration) $('stats').textContent = '加载失败: ' + e;
    return;
  }
  // 编辑器: 摆回原点，朝向/缩放交给控件（loadXxx 里的房间站位在此无效）
  character.group.position.set(0, 0, 0);
  // 朝向用模型自带的「摆正角」（各包正面朝向不同），并同步到滑杆
  const defRot = character.defaultRotY ?? 0;
  character.group.rotation.y = defRot;
  const deg = Math.round((defRot * 180) / Math.PI);
  $inp('rotY').value = String(deg);
  $('rotYVal').textContent = `${deg}°`;
  scene.add(character.group);

  // 表情层先跑一帧 dt=0：口内件（morphOnly）此刻按「嘴闭」隐藏，
  // 随后 captureVisibility 抓到的可见性基线才是对的（否则隔离模式会把嘴里的牙重新打开）
  character.expression?.update(0);

  // 调试句柄：控制台可拿 scene / 当前模型（定位渲染问题时用）
  (window as any).__char = { get character() { return character; }, scene, THREE, origMaterials, editNpr };

  // 记录原始材质，供模式切换
  character.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) origMaterials.set(m, m.material);
  });
  // 准备完成后按用户选择创建材质，再应用编辑器参数。
  applyMaterialMode();

  // 骨架
  const skinned = (character.group.getObjectByProperty('type', 'SkinnedMesh') ??
    character.group.getObjectByProperty('type', 'Mesh')) as THREE.SkinnedMesh | undefined;
  const skeleton = skinned && 'skeleton' in skinned ? skinned.skeleton : null;
  bones = skeleton ? [...skeleton.bones] : [];

  // 关节点（点云，每帧同步世界坐标）
  const positions = new Float32Array(Math.max(1, bones.length) * 3);
  const jg = new THREE.BufferGeometry();
  jg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  jointPoints = new THREE.Points(jg, new THREE.PointsMaterial({
    color: 0x53e0c8, size: 0.022, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.9,
  }));
  setQueue(jointPoints, 'overlay', 1);
  jointPoints.visible = false;
  scene.add(jointPoints);

  // 选中骨骼高亮球
  highlight.visible = false;
  scene.add(highlight);

  // 骨骼下拉
  const sel = $inp('bone');
  sel.innerHTML = '<option value="-1">（选择骨骼…）</option>'
    + bones.map((b, i) => `<option value="${i}">${i} · ${b.name || '(unnamed)'}</option>`).join('');

  // 相机对准模型中点
  const box = new THREE.Box3().setFromObject(character.group);
  const mid = new THREE.Vector3();
  box.getCenter(mid);
  controls.target.copy(mid);
  rim.position.set(mid.x + 0.45, mid.y + 0.1, mid.z + 1.1);

  const vertCount = (() => {
    let n = 0;
    character!.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) n += m.geometry.attributes.position?.count ?? 0;
    });
    return n;
  })();
  $('stats').innerHTML =
    `${faceSdfStatusText(characterRendering!.faceSdf)}<br>骨骼 ${bones.length} · 顶点 ${vertCount.toLocaleString()} · 材质 ${origMaterials.size}` +
    (skeleton ? '' : '<br>⚠ 无骨架（网格手术模型）');
  if (character.report.bound || character.report.unbound.length) {
    $('stats').innerHTML += `<br>契约命中 ${character.report.bound}`
      + (character.report.unbound.length ? ` · <span style="color:#d86a6a">未标注 ${character.report.unbound.length}</span>` : '');
  }
  $('boneinfo').textContent = '未选中';
  // 隔离状态按模型重置：可见性基线必须在 selectMaterial 之前抓
  isoOn = false;
  $('matIso').classList.remove('on');
  captureVisibility(character.group);
  renderCharterPanel(character);
  renderExpressionPanel(character);
  renderCmdPanel(character);
}

// 选中骨骼高亮球
const highlight = new THREE.Mesh(
  new THREE.SphereGeometry(0.03, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xe8a34c, depthTest: false, transparent: true }),
);
setQueue(highlight, 'overlay', 2);

// ---------- 控件 ----------

let showSkel = false;
let showJoints = false;

function setSkelVisible(on: boolean) {
  showSkel = on;
  if (on && !skelHelper && character) {
    skelHelper = new THREE.SkeletonHelper(character.group);
    (skelHelper.material as THREE.LineBasicMaterial).depthTest = false;
    setQueue(skelHelper, 'overlay', 0);
    scene.add(skelHelper);
  }
  if (skelHelper) skelHelper.visible = on;
  $('toggleSkel').classList.toggle('on', on);
}
function setJointsVisible(on: boolean) {
  showJoints = on;
  if (jointPoints) jointPoints.visible = on && bones.length > 0;
  $('toggleJoints').classList.toggle('on', on);
}

$('toggleSkel').addEventListener('click', () => setSkelVisible(!showSkel));
$('toggleJoints').addEventListener('click', () => setJointsVisible(!showJoints));

$inp('bone').addEventListener('change', () => {
  const i = parseInt($inp('bone').value, 10);
  if (i < 0 || !bones[i]) { highlight.visible = false; $('boneinfo').textContent = '未选中'; return; }
  const b = bones[i];
  const wp = new THREE.Vector3();
  b.getWorldPosition(wp);
  highlight.position.copy(wp);
  highlight.visible = true;
  $('boneinfo').textContent = `${b.name || '(unnamed)'} @ (${wp.x.toFixed(2)}, ${wp.y.toFixed(2)}, ${wp.z.toFixed(2)})`;
});

$('model').addEventListener('change', () => {
  loadModel($inp('model').value as ModelKind).catch((e) => { $('stats').textContent = '加载失败: ' + e; });
});

/* ---------- 指令面板控件 ---------- */

$('cmdSend').addEventListener('click', () => sendCmd($inp('cmdInput').value));
$inp('cmdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCmd($inp('cmdInput').value);
});

/* ---------- 表情面板控件 ---------- */

$('exprBlink').addEventListener('click', () => {
  const e = character?.expression;
  if (!e) return;
  e.setAutoBlink(!e.autoBlink);
  $('exprBlink').classList.toggle('on', e.autoBlink);
});

$('exprClear').addEventListener('click', () => {
  const e = character?.expression;
  if (!e) return;
  e.clear();
  for (const inp of document.querySelectorAll<HTMLInputElement>('#exprSlots input[type="range"]')) {
    inp.value = '0';
    const out = document.querySelector(`#exprSlots [data-val="${inp.dataset.slot}"]`);
    if (out) out.textContent = '0.00';
  }
});

/* ---------- 材质查看器控件 ---------- */

$inp('matSel').addEventListener('change', () => selectMaterial(parseInt($inp('matSel').value, 10)));

// 表格行 = 下拉的另一种点法（事件委托：表格每次重绘 innerHTML，监听器挂在 table 上）
$('charterTable').addEventListener('click', (ev) => {
  const tr = (ev.target as HTMLElement).closest('tr') as HTMLTableRowElement | null;
  const i = tr?.dataset.i;
  if (i === undefined) return;
  $inp('matSel').value = i;
  selectMaterial(parseInt(i, 10));
});

$('matTrack').addEventListener('click', () => {
  mvUseTrack = !mvUseTrack;
  $('matTrack').classList.toggle('on', mvUseTrack);
  $('matTrack').textContent = mvUseTrack ? '契约轨道' : '原材质';
  selectMaterial(parseInt($inp('matSel').value, 10));
});

$('matIso').addEventListener('click', () => {
  isoOn = !isoOn;
  $('matIso').classList.toggle('on', isoOn);
  applyIsolation();
});

$('matSpin').addEventListener('click', () => {
  mvSpin = !mvSpin;
  $('matSpin').classList.toggle('on', mvSpin);
});

// 材质球拖拽旋转
{
  const wrap = $('matBallWrap');
  let dragging = false, lx = 0, ly = 0;
  wrap.addEventListener('pointerdown', (ev) => {
    dragging = true; lx = ev.clientX; ly = ev.clientY;
    wrap.setPointerCapture(ev.pointerId);
  });
  wrap.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    mvYaw += (ev.clientX - lx) * 0.012;
    mvPitch = THREE.MathUtils.clamp(mvPitch + (ev.clientY - ly) * 0.012, -1.35, 1.35);
    lx = ev.clientX; ly = ev.clientY;
  });
  const stop = () => { dragging = false; };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);
}

$inp('scale').addEventListener('input', () => {
  const v = parseFloat($inp('scale').value);
  if (character) character.group.scale.setScalar(v);
  $('scaleVal').textContent = v.toFixed(2);
});
$inp('rotY').addEventListener('input', () => {
  const deg = parseFloat($inp('rotY').value);
  if (character) character.group.rotation.y = (deg * Math.PI) / 180;
  $('rotYVal').textContent = `${deg}°`;
});

function applyMaterialMode() {
  const mode = $inp('matmode').value;
  for (const [mesh, orig] of origMaterials) {
    switch (mode) {
      case 'tex': mesh.material = orig; break;
      case 'track': {
        // 契约轨道：与主工程同一套 NPR 注入（含 face SDF）。clone 后转换——
        // pbr 分支是就地注入，直接转会把「贴图」模式的原始材质也带上注入。
        let t = trackPool.get(mesh);
        if (!t) {
          const src = Array.isArray(orig) ? orig : [orig];
          const conv = src.map((m) => characterRendering!.createMaterial(m));
          t = Array.isArray(orig) ? conv : conv[0];
          trackPool.set(mesh, t);
        }
        mesh.material = t;
        break;
      }
      case 'unlit': {
        // 每格 mesh 独立 unlit 材质——共享一个会被循环覆盖 map（只剩最后一份贴图，全模型采样同一 atlas）
        const om = (Array.isArray(orig) ? orig[0] : orig) as THREE.MeshStandardMaterial;
        const u = unlitPool.get(mesh) ?? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        u.map = om.map ?? null;
        u.color.copy(om.color); // PMX diffuse 染色（大多为白，但保持语义一致）
        u.transparent = om.transparent;
        u.depthWrite = !om.transparent; // 与 PMX 修正约定一致：透明叠加层不写深度
        unlitPool.set(mesh, u);
        mesh.material = u;
        break;
      }
      case 'normal': mesh.material = normalMat; break;
      case 'wire': mesh.material = wireMat; break;
    }
  }
  applyFaceGlow();
}
$inp('matmode').addEventListener('change', applyMaterialMode);

function bindSlider(id: string, valId: string, apply: (v: number) => void) {
  const inp = $inp(id);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    apply(v);
    $(valId).textContent = v.toFixed(2);
  });
}
bindSlider('key', 'keyVal', (v) => { key.intensity = v; });
bindSlider('hemi', 'hemiVal', (v) => { hemi.intensity = v * 0.5; ambient.intensity = v * 0.55; });
bindSlider('moon', 'moonVal', (v) => { moon.intensity = v; });
bindSlider('rim', 'rimVal', (v) => { rim.intensity = v; });
bindSlider('bloom', 'bloomVal', (v) => { bloomPass.strength = v; });
bindSlider('exposure', 'exposureVal', (v) => { renderer.toneMappingExposure = v; });
bindSlider('dof', 'dofVal', (v) => { (bokehPass.uniforms as Record<string, { value: number }>)['maxblur'].value = v; });

// 主光方位：绕目标点水平旋转 key（半径与仰角不变）。SDF 脸影验证的核心滑杆——
// 光从正前扫到侧后，看 SDF 阴影是否「慢慢软下来」扫过脸。
const keyBase = key.position.clone().sub(key.target.position);
function setKeyAzimuth(deg: number) {
  const r = Math.hypot(keyBase.x, keyBase.z);
  const az = (deg * Math.PI) / 180 + Math.atan2(keyBase.x, keyBase.z);
  key.position.set(
    key.target.position.x + Math.sin(az) * r,
    key.position.y,
    key.target.position.z + Math.cos(az) * r,
  );
}
bindSlider('keyAng', 'keyAngVal', setKeyAzimuth);
{
  // 滑杆初值 = 当前方位角
  const deg = Math.round((Math.atan2(keyBase.x, keyBase.z) * 180) / Math.PI);
  $inp('keyAng').value = String(deg);
  $('keyAngVal').textContent = `${deg}°`;
}

// SDF 调试输出（契约轨道模式下面部可见）：1=阈值场 2=最终明暗 3=光照衰减
$inp('sdfdbg').addEventListener('change', () => {
  editNpr.uNprSdfDebug.value = parseFloat($inp('sdfdbg').value);
});

$('lightMode').addEventListener('click', () => {
  lightMode = lightMode === 'studio' ? 'warm' : 'studio';
  applyLightColors();
});
applyLightColors();

$('autorot').addEventListener('click', (e) => {
  controls.autoRotate = !controls.autoRotate;
  (e.currentTarget as HTMLElement).classList.toggle('on', controls.autoRotate);
});

// ---------- 尺寸与主循环 ----------

function resize() {
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h);
  post.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

const tmp = new THREE.Vector3();
let lastFrameT = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameT) / 1000);
  lastFrameT = now;
  controls.update();
  // 景深焦点跟随轨道目标（角色永远清晰，远处地面糊化）
  (bokehPass.uniforms as Record<string, { value: number }>)['focus'].value =
    camera.position.distanceTo(controls.target);

  // 关节点 + 高亮球跟随骨骼
  if (jointPoints?.visible && bones.length) {
    const attr = jointPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bones.length; i++) {
      bones[i].getWorldPosition(tmp);
      attr.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    attr.needsUpdate = true;
  }
  const bi = parseInt($inp('bone').value, 10);
  if (highlight.visible && bones[bi]) {
    bones[bi].getWorldPosition(tmp);
    highlight.position.copy(tmp);
  }

  // 表情层：与骨架同一时基推进（此处用真实 dt，淡化更顺；上限 0.1s 防切页回跳）
  character?.expression?.update(dt);

  post.render(dt);

  // NPR 注入项每帧回写：编辑器相机 + key 灯方向（uNprKeyDir 接线，face SDF 依赖它）
  updateNprUniforms(editNpr, camera, key);

  // ---- 材质查看器（独立 renderer，200×142，无 AA + 半速渲染压开销）----
  if (mvRenderer && mvScene && mvCam && ballMesh && quadMesh && mvNpr) {
    if (mvSpin) mvYaw += 0.006;
    ballMesh.rotation.set(mvPitch, mvYaw, 0);
    quadMesh.rotation.set(mvPitch * 0.35, mvYaw, 0);
    // NPR 注入项跟着查看器相机走（视角高光/边缘光才是「所见即运行期」）
    updateNprUniforms(mvNpr, mvCam);
    if ((mvFrame++ & 1) === 0) mvRenderer.render(mvScene, mvCam);
  }
}

// 清单（运行时发现模型）→ 加载首个
loadManifest()
  .then(() => {
    const sel = $sel('model');
    if (!sel.value) sel.selectedIndex = 0;
    return loadModel(sel.value || 'c:yelan');
  })
  .then(() => { $('stats').innerHTML += '<br>✓ 就绪'; })
  .catch((e) => { $('stats').textContent = '加载失败: ' + e; });

// 调试钩子（与 main.ts 同约定）
Object.assign(window, {
  __editor: {
    THREE,
    scene,
    camera,
    controls,
    renderer,
    bloomPass,
    lights: { key, hemi, ambient, moon, fill, rim },
    character: () => character,
    bones: () => bones,
    expr: () => character?.expression ?? null,
    /** witch.exp/1 指令入口 —— 自动化脚本用它验证回退与提示 */
    exp: () => character?.exp ?? null,
    manifest: () => manifest,
    loadModel,
    // 面部 SDF 管路诊断（自动化/控制台驱动用）
    faceSdf: () => characterRendering?.faceSdf.texture ?? null,
    rendering: () => characterRendering,
    trackPoolSize: () => trackPool.size,
    // 材质查看器（自动化/控制台驱动用）
    materials: () => matIndex,
    selectMaterial,
    viewer: {
      off: MV_OFF,
      scene: () => mvScene, camera: () => mvCam,
      ball: () => (ballMesh?.visible ? ballMesh.material : quadMesh?.material) ?? null,
      setIsolate: (on: boolean) => { isoOn = on; $('matIso').classList.toggle('on', on); applyIsolation(); },
      setUseTrack: (on: boolean) => { mvUseTrack = on; $('matTrack').classList.toggle('on', on); selectMaterial(parseInt($sel('matSel').value, 10)); },
      setSpin: (on: boolean) => { mvSpin = on; },
    },
  },
});

loop();
