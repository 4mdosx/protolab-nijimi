/**
 * 姿势实验台（POSE LAB）—— 动作库的**生产工具**。
 *
 * 它验证并落地三件事（对应 design/角色动作库-骨骼槽位与姿势管线.md）：
 *   ① **语义欧拉能摆姿势**：26 个槽位 × [前俯后仰 / 左右转 / 左右侧倾] 三滑杆，
 *      不用碰日文骨名，也不用理解 MMD 各骨互不相同的局部轴系；
 *   ② **姿势可存可取**：摆好 → 存进浏览器本地库 → 导出 JSON（就是动作库的资产格式）；
 *   ③ **姿势能串成动作**：把若干姿势排成关键帧序列 → 播放 → 这就是一段动作。
 *      叠加层（呼吸/轻摆/手臂微垂）叠在任意姿势上，静止的也像活的。
 *
 * 渲染栈与 lab/scene/character.ts 同源（ACES + 棚拍中性 + Bloom + 契约轨道），
 * 骨架/关节点的画法也照抄那里 —— 两个编辑器看到的必须是同一个模型。
 *
 * 数据源：assets/models/rig-manifest.json（由 pipeline/rig-glb.mjs 从 pipeline/rig-rules.mjs 生成）
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createPostChain } from '../src/post';
import { createToneMapPass, createEncodePass } from '../src/output-passes';
import { loadCharacter, type CharacterHandles } from '../src/character';
import { materialCharter } from '../src/charter';
import { createNprUniforms, updateNprUniforms } from '../src/npr';
import { setQueue } from '../src/queue';
import { prepareCharacterRendering, discardPreparedCharacter, faceSdfStatusText, type CharacterRendering } from '../src/character-rendering';
import { buildStudio } from './studio';
import {
  BUILTIN_POSES, PosePlayer, buildRig, loadRigManifest, mirrorOnto, mirrorPose,
  type PoseClip, type PoseDeg, type Rig, type RigManifest,
} from '../src/rig';
import { CharacterAnim, loadAnimClips, rebindClip, type BindReport } from '../src/anim';

/* ------------------------------------------------------------------ *
 * 渲染基础（与人物编辑器同源）
 * ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $inp = (id: string) => document.getElementById(id) as HTMLInputElement;

const container = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
buildStudio(scene);

const pad = new THREE.Mesh(
  new THREE.CylinderGeometry(1.5, 1.6, 0.12, 48),
  new THREE.MeshStandardMaterial({ color: 0xccd1d8, roughness: 0.9 }),
);
pad.position.y = -0.06;
pad.receiveShadow = true;
scene.add(pad);
/** 朝向参考：脚下一个圆环刻度 —— 摆姿势时判断「她面向哪」全靠它 */
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.36, 0.40, 48),
  new THREE.MeshBasicMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.004;
scene.add(ring);

const hemi = new THREE.HemisphereLight(0xe6eaf0, 0xb6bac2, 0.35);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xd0d3da, 0.39);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xffffff, 0.7);
key.position.set(-3.5, 5.5, 2.6);
key.target.position.set(0.3, 0.6, 0.1);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -6; key.shadow.camera.right = 6;
key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
key.shadow.camera.far = 16;
key.shadow.bias = -0.0006;
scene.add(key, key.target);
const moon = new THREE.DirectionalLight(0xe2e8f2, 0.3);
moon.position.set(2.2, 2.6, -2.2);
scene.add(moon);
const fill = new THREE.PointLight(0xffffff, 1.8, 10, 1.6);
fill.position.set(1.9, 1.8, -2.4);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
camera.position.set(2.1, 1.35, 3.0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.85, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// 后期走引擎的 PostChain（与舞台同一条链）：动作台原来没有调色，
// 这里也只装 Bloom + 输出两段——并轨不改观感，改的是「谁定义顺序」。
const post = createPostChain(renderer, { width: 1, height: 1, samples: 0, type: THREE.HalfFloatType });
post.add(new RenderPass(scene, camera), { id: 'scene', anchor: 'scene', priority: 0, locked: true });
const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.2, 0.55, 0.74);
post.add(bloom, { id: 'bloom', anchor: 'beforeTonemap', priority: 10 });
post.add(createToneMapPass(), { id: 'tonemap', anchor: 'tonemap', priority: 0, locked: true, internal: true });
post.add(createEncodePass(), { id: 'encode', anchor: 'encode', priority: 0, locked: true, internal: true });

const editNpr = createNprUniforms();

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

let manifest: RigManifest | null = null;
let character: CharacterHandles | null = null;
let characterRendering: CharacterRendering | null = null;
let loadGeneration = 0;
let rig: Rig | null = null;
let player: PosePlayer | null = null;

/** 当前编辑的静态姿势 */
let pose: PoseDeg = {};
/** 排好的关键帧（姿势对象数组，顺序即播放顺序） */
let clipKeys: PoseDeg[] = [];
let clipDuration = 4;
let looping = true;
/** 正在播放动作串（而不是编辑静态姿势） */
let playingClip = false;

/** 本地姿势库 { 名字: 姿势 } */
const STORE_KEY = 'witch.pose.v1';
let saved: Record<string, PoseDeg> = {};
try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { saved = {}; }
const persist = () => localStorage.setItem(STORE_KEY, JSON.stringify(saved));

/** 外部动画（Blender 导出）：加载后的 clips + 播放器 */
let anim: CharacterAnim | null = null;
let animClips: THREE.AnimationClip[] = [];
let animSelected = -1;
let animLoop = true;

let selected: string | null = null;

// 骨架显示
let skelHelper: THREE.SkeletonHelper | null = null;
let jointPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
let showSkel = false;
let showJoints = false;
const highlight = new THREE.Mesh(
  new THREE.SphereGeometry(0.03, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xe8a34c, depthTest: false, transparent: true }),
);
setQueue(highlight, 'overlay', 2);
highlight.visible = false;
scene.add(highlight);

/* ------------------------------------------------------------------ *
 * 加载模型
 * ------------------------------------------------------------------ */

const FACE_GLOW_SCALE = 0.15; // 浅棚档：契约 0.55 是暗房标定值，这里压下去

function scaleFaceGlow(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const c = materialCharter(m);
      const std = m as THREE.MeshStandardMaterial;
      if (c?.role === 'face' && (c.faceGlow ?? 0) > 0 && std.emissive) {
        std.emissiveIntensity = (c.faceGlow as number) * FACE_GLOW_SCALE;
      }
    }
  });
}

function disposeCharacter() {
  if (!character) return;
  characterRendering?.dispose();
  characterRendering = null;
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
  character = null; rig = null; player = null;
  anim = null; // 旧 mixer 绑在旧 group 上，直接弃（clip 是按骨名的，换模型后仍可复用）
  highlight.visible = false;
}

async function loadModel(id: string) {
  const generation = ++loadGeneration;
  disposeCharacter();
  $('stats').textContent = '加载角色与 SDF…';
  if (!manifest) return;
  const model = manifest.models.find((m) => m.id === id);
  if (!model) { $('stats').textContent = `manifest 里没有 ${id}`; return; }

  try {
    const loaded = await loadCharacter(id);
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
  // 编辑器：回原点，用模型自带的摆正角（各包正面朝向不同）
  character.group.position.set(0, 0, 0);
  character.group.rotation.y = character.defaultRotY ?? 0;
  // 调试参数 ?noshadow=1：关闭模型自阴影/受影（定位阴影 acne 时用）
  const noShadow = new URLSearchParams(location.search).get('noshadow') === '1';
  character.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = !noShadow; m.receiveShadow = !noShadow; }
  });
  scene.add(character.group);

  // 调试句柄：控制台可拿 scene / 当前模型（定位渲染问题时用）
  (window as any).__pose = { get character() { return character; }, scene, THREE };

  // 契约轨道（与主工程同一套着色）+ 面部自发光按浅棚缩放
  characterRendering!.apply();
  scaleFaceGlow(character.group);
  // 参数必须在 NPR 创建之后应用，否则转换过程会重新启用阴影。
  if (noShadow) character.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
  });

  // 调试参数 ?noshell=1：隐藏「发轮廓线」描边壳（定位描边壳渲染问题时用）
  if (new URLSearchParams(location.search).get('noshell') === '1') {
    character.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((x) => x && x.name === '发轮廓线')) m.visible = false;
    });
  }

  // 骨骼契约
  rig = buildRig(character.group, model);
  player = new PosePlayer(rig, manifest.additives ?? {});
  player.opts.additives = {};
  for (const k of Object.keys(manifest.additives ?? {})) player.opts.additives[k] = true;
  player.opts.additiveGain = parseFloat($inp('addGain').value);

  // 骨架 / 关节点
  skelHelper = new THREE.SkeletonHelper(character.group);
  (skelHelper.material as THREE.LineBasicMaterial).depthTest = false;
  setQueue(skelHelper, 'overlay', 0);
  skelHelper.visible = showSkel;
  scene.add(skelHelper);

  const bones = rig.bones;
  const jg = new THREE.BufferGeometry();
  jg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, bones.length) * 3), 3));
  jointPoints = new THREE.Points(jg, new THREE.PointsMaterial({
    color: 0x53e0c8, size: 0.022, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.9,
  }));
  setQueue(jointPoints, 'overlay', 1);
  jointPoints.visible = showJoints;
  scene.add(jointPoints);

  // 相机对准模型中点
  const box = new THREE.Box3().setFromObject(character.group);
  const mid = new THREE.Vector3();
  box.getCenter(mid);
  controls.target.copy(mid);
  ring.position.set(0, 0.004, 0);

  // 默认姿势：站立
  pose = structuredClone(BUILTIN_POSES.stand.bones ?? {});
  clipKeys = [];
  playingClip = false;
  player.setStatic(pose);

  selected = null;
  renderSlotList();
  renderEdit();
  renderClip();
  updateAnimButtons();
  $('stats').innerHTML =
    `${faceSdfStatusText(characterRendering!.faceSdf)}<br>骨架 <b>${model.stats.joints}</b> · 有权重 <b>${model.stats.weighted}</b> · 槽位 <b>${Object.keys(model.slots).length}</b>`
    + ` · 物理骨 ${model.stats.physBones}（${(model.stats.physVerts / 1000).toFixed(0)}k 权重顶点）`
    + `<br>未解析槽位 ${model.unresolvedSlots.length ? `<span style="color:#d86a6a">${model.unresolvedSlots.join(',')}</span>` : '无 → 全部命中'}`;
}

/* ------------------------------------------------------------------ *
 * 槽位 UI
 * ------------------------------------------------------------------ */

function val(id: string): number[] {
  const v = pose[id];
  return [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0];
}

function setVal(id: string, ax: number, deg: number) {
  const cur = pose[id] ? [...pose[id]] : [0, 0, 0];
  while (cur.length < 3) cur.push(0);
  cur[ax] = Math.round(deg * 10) / 10;
  if (cur[0] === 0 && cur[1] === 0 && cur[2] === 0) delete pose[id];
  else pose[id] = cur;
  if (!playingClip && player) player.setStatic(pose);
  refreshRow(id);
}

function renderSlotList() {
  if (!rig) { $('slotList').innerHTML = ''; return; }
  const html = rig.slotGroups().map((g) => `
    <div class="slotgrp">
      <div class="hd"><span>${g.cn}</span><span>${g.ids.length}</span></div>
      ${g.ids.map(rowHtml).join('')}
    </div>`).join('');
  $('slotList').innerHTML = html;
}

function rowHtml(id: string) {
  const h = rig!.slots.get(id)!;
  const v = val(id);
  const set = v.some((x) => Math.abs(x) > 0.01);
  return `<div class="slot${selected === id ? ' on' : ''}${set ? ' set' : ''}" data-id="${id}">
    <span class="nm">${id}</span><span class="cn">${h.cn}</span>
    <span class="v">${v.map((x) => x.toFixed(0)).join(', ')}</span>
    <span class="sd">${h.side ?? ''}</span>
  </div>`;
}

function refreshRow(id: string) {
  const el = $('slotList').querySelector(`.slot[data-id="${id}"]`);
  if (!el) return;
  const v = val(id);
  el.querySelector('.v')!.textContent = v.map((x) => x.toFixed(0)).join(', ');
  el.classList.toggle('set', v.some((x) => Math.abs(x) > 0.01));
}

function renderEdit() {
  const id = selected;
  const h = id ? rig?.slots.get(id) : undefined;
  $('edName').innerHTML = h
    ? `${id} <i>${h.cn} · 骨 ${h.bone}</i>`
    : '（在下面列表里点一根骨）';
  const v = h && id ? val(id) : [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    $inp(`sx${i}`).value = String(v[i]);
    $inp(`nx${i}`).value = String(Math.round(v[i]));
  }
}

/** 每帧把播放中的实际数值回写到 UI（节流） */
let uiTick = 0;
function syncUiFromRig() {
  if (!player) return;
  const p = player.currentPose();
  for (const id of rig!.slots.keys()) {
    const el = $('slotList').querySelector(`.slot[data-id="${id}"]`);
    if (!el) continue;
    const v = [p[id]?.[0] ?? 0, p[id]?.[1] ?? 0, p[id]?.[2] ?? 0];
    el.querySelector('.v')!.textContent = v.map((x) => x.toFixed(0)).join(', ');
    el.classList.toggle('set', v.some((x) => Math.abs(x) > 0.5));
  }
  if (selected) {
    const v = [p[selected]?.[0] ?? 0, p[selected]?.[1] ?? 0, p[selected]?.[2] ?? 0];
    for (let i = 0; i < 3; i++) {
      $inp(`sx${i}`).value = String(v[i]);
      $inp(`nx${i}`).value = String(Math.round(v[i]));
    }
  }
}

$('slotList').addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('.slot') as HTMLElement | null;
  if (!el?.dataset.id) return;
  selected = el.dataset.id;
  for (const s of $('slotList').querySelectorAll('.slot')) s.classList.toggle('on', s === el);
  renderEdit();
  focusSelected();
});

function focusSelected() {
  if (!rig || !selected) { highlight.visible = false; return; }
  const wp = new THREE.Vector3();
  rig.slots.get(selected)!.bone.getWorldPosition(wp);
  highlight.position.copy(wp);
  highlight.visible = true;
}

$('focusSlot').addEventListener('click', () => {
  if (!rig || !selected) return;
  const wp = new THREE.Vector3();
  rig.slots.get(selected)!.bone.getWorldPosition(wp);
  controls.target.copy(wp);
});

$('zeroSlot').addEventListener('click', () => {
  if (!selected) return;
  delete pose[selected];
  if (!playingClip && player) player.setStatic(pose);
  refreshRow(selected); renderEdit(); focusSelected();
});

$('mirSlot').addEventListener('click', () => {
  if (!selected) return;
  pose = mirrorOnto(pose, selected);
  if (!playingClip && player) player.setStatic(pose);
  renderSlotList(); renderEdit();
});

for (let i = 0; i < 3; i++) {
  $inp(`sx${i}`).addEventListener('input', () => {
    if (!selected) return;
    setVal(selected, i, parseFloat($inp(`sx${i}`).value));
    $inp(`nx${i}`).value = String(Math.round(parseFloat($inp(`sx${i}`).value)));
  });
  $inp(`nx${i}`).addEventListener('change', () => {
    if (!selected) return;
    setVal(selected, i, parseFloat($inp(`nx${i}`).value));
    $inp(`sx${i}`).value = String(parseFloat($inp(`nx${i}`).value));
  });
}

$('resetPose').addEventListener('click', () => {
  pose = {};
  if (!playingClip && player) player.setStatic(pose);
  for (const el of $('slotList').querySelectorAll('.slot')) {
    el.querySelector('.v')!.textContent = '0, 0, 0';
    el.classList.remove('set');
  }
  renderEdit();
});

$('mirrorAll').addEventListener('click', () => {
  if (!player) return;
  const cur = { ...player.currentPose() };
  pose = mirrorPose(cur);
  if (!playingClip) player.setStatic(pose);
  renderSlotList(); renderEdit();
});

$('tSkel').addEventListener('click', () => {
  showSkel = !showSkel;
  if (skelHelper) skelHelper.visible = showSkel;
  $('tSkel').classList.toggle('on', showSkel);
});
$('tJoint').addEventListener('click', () => {
  showJoints = !showJoints;
  if (jointPoints) jointPoints.visible = showJoints;
  $('tJoint').classList.toggle('on', showJoints);
});

/* ------------------------------------------------------------------ *
 * 姿势库
 * ------------------------------------------------------------------ */

function renderBuiltin() {
  $('builtinList').innerHTML = Object.entries(BUILTIN_POSES)
    .map(([k, p]) => `<button data-builtin="${k}">${p.name ?? k}</button>`).join('');
}
$('builtinList').addEventListener('click', (ev) => {
  const k = (ev.target as HTMLElement).dataset.builtin;
  if (!k || !player) return;
  pose = structuredClone(BUILTIN_POSES[k].bones ?? {});
  playingClip = false;
  player.setStatic(pose);
  player.clip = null;
  renderSlotList(); renderEdit(); renderClip();
});

function renderSaved() {
  const names = Object.keys(saved);
  $('savedList').innerHTML = names.length
    ? names.map((n) => `<div class="item" data-saved="${n}"><span class="t">${n}</span><span class="x" data-del="${n}">×</span></div>`).join('')
    : '<div class="empty">还没存过。摆好姿势点「存当前姿势」。</div>';
}
$('savedList').addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const del = t.dataset.del;
  if (del) { delete saved[del]; persist(); renderSaved(); return; }
  const item = t.closest('.item') as HTMLElement | null;
  if (!item?.dataset.saved || !player) return;
  for (const el of $('savedList').querySelectorAll('.item')) el.classList.toggle('sel', el === item);
  pose = structuredClone(saved[item.dataset.saved]);
  playingClip = false;
  player.setStatic(pose);
  player.clip = null;
  renderSlotList(); renderEdit(); renderClip();
});

$('savePose').addEventListener('click', () => {
  if (!player) return;
  const name = prompt('姿势名（英文/数字，作为动作库资产名）', `pose_${Object.keys(saved).length + 1}`);
  if (!name) return;
  saved[name] = player.currentPose();
  persist();
  renderSaved();
});

$('delPose').addEventListener('click', () => {
  const sel = $('savedList').querySelector('.item.sel') as HTMLElement | null;
  if (!sel?.dataset.saved) return;
  delete saved[sel.dataset.saved];
  persist(); renderSaved();
});

/* ------------------------------------------------------------------ *
 * 动作串（关键帧序列 → 播放）
 * ------------------------------------------------------------------ */

function clipFromKeys(keys: PoseDeg[], duration: number, loop: boolean): PoseClip {
  const n = keys.length;
  const list = keys.map((p, i) => ({ t: n > 1 ? (i / n) * duration : 0, pose: p }));
  // 闭环：末尾补一帧回到起点，loop 采样才不会在接缝处跳
  if (loop && n > 1) list.push({ t: duration, pose: keys[0] });
  return { format: 'witch.clip/1', id: 'preview', name: '预览', loop, duration, keys: list };
}

function renderClip() {
  $('clipList').innerHTML = clipKeys.length
    ? clipKeys.map((_, i) => `<div class="item"><span class="n">${i + 1}</span><span class="t">keyframe</span><span class="x" data-kdel="${i}">×</span></div>`).join('')
    : '<div class="empty">点「＋ 加当前姿势」把姿势排成关键帧。</div>';
  $('clipDurVal').textContent = `${clipDuration.toFixed(1)}s`;
}
$('clipList').addEventListener('click', (ev) => {
  const i = (ev.target as HTMLElement).dataset.kdel;
  if (i === undefined) return;
  clipKeys.splice(parseInt(i, 10), 1);
  renderClip();
});

$('addKey').addEventListener('click', () => {
  if (!player) return;
  clipKeys.push(structuredClone(player.currentPose()));
  renderClip();
});
$('clearClip').addEventListener('click', () => {
  clipKeys = [];
  renderClip();
});
$inp('clipDur').addEventListener('input', () => {
  clipDuration = parseFloat($inp('clipDur').value);
  renderClip();
});
$('loopClip').addEventListener('click', () => {
  looping = !looping;
  $('loopClip').classList.toggle('on', looping);
  if (playingClip) startClip();
});

function startClip() {
  if (!player || clipKeys.length === 0) return;
  playingClip = true;
  player.play(clipFromKeys(clipKeys, clipDuration, looping));
  $('playClip').textContent = '⏸ 暂停';
  $('playClip').classList.add('on');
}
$('playClip').addEventListener('click', () => {
  if (!player) return;
  if (playingClip) {
    playingClip = false;
    pose = structuredClone(player.currentPose());
    player.setStatic(pose);
    player.clip = null;
    $('playClip').textContent = '▶ 播放';
    $('playClip').classList.remove('on');
    renderSlotList(); renderEdit();
  } else {
    startClip();
  }
});

/* ------------------------------------------------------------------ *
 * 外部动画（Blender 导出的动画 GLB → 试播）
 * ------------------------------------------------------------------ */

let animReports: (BindReport | null)[] = [];

function animDroppedCount() {
  return animReports.reduce((n, r) => n + (r?.dropped.length ?? 0), 0);
}

function renderAnimList() {
  $('animList').innerHTML = animClips.length
    ? animClips.map((c, i) => {
      const r = animReports[i];
      const cls = r && r.dropped.length ? 'anim-dropped' : 'anim-bound';
      const warn = r && r.dropped.length ? ` · ⚠${r.dropped.length}条未绑` : '';
      return `<div class="item ${cls}${i === animSelected ? ' sel' : ''}" data-anim="${i}">
        <span class="n">${i + 1}</span><span class="t">${c.name || 'clip'} · ${c.duration.toFixed(1)}s${warn}</span></div>`;
    }).join('')
    : '<div class="empty">还没加载动画。选一个 .anim.glb（pipeline/anim-audit.mjs 可预检）。</div>';
}

function updateAnimButtons() {
  const has = animClips.length > 0 && !!character;
  const playing = anim?.active ?? false;
  ($('playAnim') as HTMLButtonElement).disabled = !has || playing;
  ($('stopAnim') as HTMLButtonElement).disabled = !playing;
  $('playAnim').textContent = playing ? '▶ 播放中' : '▶ 播放';
}

/** 停止动画：mixer 清场 → 骨架全部复位 → 姿势层接管 */
function finishAnim() {
  if (!anim || !player) return;
  anim.onStop = undefined;
  anim.stop();
  anim = null;
  rig?.reset();
  player.setStatic(pose);
  updateAnimButtons();
}

/** 按路径加载动画（?anim= 深链；文件上传也走这里） */
async function loadAnimFromUrl(url: string, label: string) {
  if (!character) return;
  try {
    const raw = await loadAnimClips(url);
    animClips = [];
    animReports = [];
    for (const c of raw) {
      const { clip, report } = rebindClip(c, character.group);
      animClips.push(clip);
      animReports.push(report);
    }
    animSelected = animClips.length ? 0 : -1;
    const n = animDroppedCount();
    $('animHint').textContent = `${label}：${animClips.length} 个动作`
      + (n ? ` · ${n} 条 track 绑不上骨架（先跑 pipeline/anim-audit.mjs）` : ' · 全部绑定 ✓');
  } catch (e) {
    $('animHint').textContent = '加载失败: ' + e;
  }
  renderAnimList();
  updateAnimButtons();
}

$('animFile').addEventListener('change', () => {
  const f = ($('animFile') as HTMLInputElement).files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadAnimFromUrl(url, f.name).finally(() => URL.revokeObjectURL(url));
});

$('animList').addEventListener('click', (ev) => {
  if (anim?.active) return;
  const el = (ev.target as HTMLElement).closest('[data-anim]') as HTMLElement | null;
  if (!el) return;
  animSelected = parseInt(el.dataset.anim!, 10);
  renderAnimList();
});

$('playAnim').addEventListener('click', () => {
  const clip = animClips[animSelected];
  if (!clip || !character) return;
  if (!anim || (anim.mixer.getRoot() as THREE.Object3D) !== character.group) {
    anim = new CharacterAnim(character.group);
  }
  playingClip = false;
  player?.stop();
  anim.onStop = () => finishAnim(); // 非 loop 播完自动交还姿势层
  anim.play(clip, { loop: animLoop, fade: 0.25 });
  $('playClip').textContent = '▶ 播放';
  $('playClip').classList.remove('on');
  renderAnimList();
  updateAnimButtons();
});

$('stopAnim').addEventListener('click', () => finishAnim());

$('loopAnim').addEventListener('click', () => {
  animLoop = !animLoop;
  $('loopAnim').classList.toggle('on', animLoop);
  if (anim?.active && animSelected >= 0) anim.play(animClips[animSelected], { loop: animLoop, fade: 0 });
});

/* ------------------------------------------------------------------ *
 * 叠加层
 * ------------------------------------------------------------------ */

function renderAdditives() {
  const list = manifest?.additives ?? {};
  $('addList').innerHTML = Object.entries(list).map(([k, p]) => {
    const on = player?.opts.additives?.[k] !== false;
    return `<button data-add="${k}" class="${on ? 'on' : ''}">${p.cn ?? k}</button>`;
  }).join('');
}
$('addList').addEventListener('click', (ev) => {
  const k = (ev.target as HTMLElement).dataset.add;
  if (!k || !player) return;
  player.opts.additives![k] = player.opts.additives![k] === false;
  renderAdditives();
});
$inp('addGain').addEventListener('input', () => {
  const v = parseFloat($inp('addGain').value);
  $('addGainVal').textContent = v.toFixed(2);
  if (player) player.opts.additiveGain = v;
});

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

$('exportJson').addEventListener('click', () => {
  if (!player) return;
  const data = {
    format: 'witch.pose/1',
    id: 'exported',
    bones: player.currentPose(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pose.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('copyJson').addEventListener('click', async () => {
  if (!player) return;
  const txt = JSON.stringify({ format: 'witch.pose/1', bones: player.currentPose() }, null, 2);
  try { await navigator.clipboard.writeText(txt); $('copyJson').textContent = '已复制 ✓'; }
  catch { console.log(txt); $('copyJson').textContent = '见控制台'; }
  setTimeout(() => { $('copyJson').textContent = '复制到剪贴板'; }, 1400);
});

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

const clock = new THREE.Clock();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  post.setSize(w, h);
}
window.addEventListener('resize', resize);

function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (anim?.active) anim.update(dt);
  else if (player) player.update(dt);
  if (rig) {
    if (character) {
      updateNprUniforms(editNpr, camera, key);
      const bi = rig.slots.get(selected ?? '')?.bone;
      if (highlight.visible && bi) bi.getWorldPosition(highlight.position);
    }
    if (jointPoints?.visible) {
      const attr = jointPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < rig.bones.length; i++) {
        rig.bones[i].getWorldPosition(tmp);
        attr.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
      attr.needsUpdate = true;
    }
    // UI 回写（节流到 ~7fps，别让 78 个 input 拖慢渲染）
    uiTick += dt;
    if (playingClip && uiTick > 0.14) { uiTick = 0; syncUiFromRig(); }
  }

  controls.update();
  post.render(dt);
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 调试句柄：控制台/自动化诊断用（window.__poseLab） */
declare global {
  interface Window { __poseLab?: unknown }
}
interface PoseLabDebug {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  rig: Rig | null; player: PosePlayer | null;
  /** 按材质名找网格（如「口内」） */
  meshOf: (matName: string) => THREE.Mesh[];
}
window.__poseLab = {
  get scene() { return scene; },
  get camera() { return camera; },
  get controls() { return controls; },
  get rig() { return rig; },
  get player() { return player; },
  get rendering() { return characterRendering; },
  meshOf: (matName: string) => {
    const out: THREE.Mesh[] = [];
    character?.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((x) => x.name === matName)) out.push(m);
    });
    return out;
  },
} as PoseLabDebug;

(async () => {
  renderBuiltin();
  renderSaved();
  renderAdditives();
  renderClip();
  renderAnimList();
  updateAnimButtons();
  resize();

  manifest = await loadRigManifest();
  const sel = $inp('model');
  if (!manifest?.models.length) {
    $('stats').innerHTML = '<span style="color:#d86a6a">rig-manifest.json 未读到</span><br>先跑 <b>node pipeline/rig-glb.mjs</b>';
    sel.innerHTML = '<option>—</option>';
  } else {
    sel.innerHTML = manifest.models
      .map((m) => `<option value="${m.id}">${m.name ? `${m.name} · ` : ''}${m.id}</option>`).join('');
    // ?model= 深链：直接加载指定模型（调试对照用）
    const modelParam = new URLSearchParams(location.search).get('model');
    const firstId = modelParam && manifest.models.some((m) => m.id === modelParam) ? modelParam : manifest.models[0].id;
    sel.value = firstId;
    await loadModel(firstId);
  }
  sel.addEventListener('change', () => { loadModel(sel.value).catch(console.error); });

  // ?anim=/models/anims/xxx.anim.glb 深链：加载后自动挂上动画（不自动播）
  const animParam = new URLSearchParams(location.search).get('anim');
  if (animParam) {
    await loadAnimFromUrl(animParam, animParam.split('/').pop() ?? animParam);
    if (animClips.length) animSelected = 0, renderAnimList();
  }

  loop();
})();
