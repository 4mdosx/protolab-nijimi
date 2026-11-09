/**
 * 骨骼契约消费端 —— 动作库的**运行期**。
 *
 * 分工（改这里之前先读这段）：
 *   tools/rig-rules.mjs       **约定**（槽位表 / 语义轴 / 物理链规则 / 叠加层预设）
 *   tools/rig-glb.mjs         按约定解析模型 → models/rig-manifest.json
 *   本文件                     只读 manifest。**不做任何骨名判定**。
 *   lab/scene/pose.html       姿势生产工具（摆 → 存 → 播）
 *
 * ⭐ 本文件的两个核心机制：
 *
 * ① **语义欧拉**（§localOf）
 *    数据里写的是 [pitch, yaw, roll]（度）：前俯后仰 / 左右转动 / 左右侧倾，
 *    参照系是**身体空间**（上 +Y / 前 -Z / 右 +X，由 tools/rig-glb.mjs 实测锚定）。
 *    但每根骨的局部轴系互不相同（实测：`上半身` 绕局部 X+ = 后仰，
 *    `首` 绕局部 X+ = 仰头），所以运行期要把世界语义旋转共轭到骨骼局部：
 *
 *        q_local = conj(R) · q_world · R        （R = 该骨 rest 世界旋转）
 *
 *    这条式子让左右对称的动作**用同一个角度值**（pitch），镜像轴（yaw/roll）
 *    取反即可 —— 数据里不用为左右各写一套符号。
 *
 * ② **姿势 ≠ 骨骼列表**
 *    数据只写槽位（spine / upperarm_l …），不写日文骨名。换模型只换 manifest，
 *    动作数据一个字都不用改。
 *
 * 三条不变量（可单测）：
 *   1. setPose 先把**全部槽位**复位到 rest 再应用 —— 否则上一段动作会残留
 *   2. 物理骨（裙/发/袖）不参与复位 —— 它们归次级运动层（§physChains）
 *   3. 位移单位是**米**（转换器已把 PMX 坐标换算到米，实测 センター y ≈ 0.903）
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;
/** 语义欧拉的应用顺序：先转身、再前倾、最后侧倾 */
const EULER_ORDER = 'YXZ';

/* ------------------------------------------------------------------ *
 * 数据类型
 * ------------------------------------------------------------------ */

/**
 * 一个姿势 = 槽位 → 六元组。
 *   [pitch, yaw, roll, dx, dy, dz]   角度为度，位移为米（身体空间）
 * 后三位可省略（写 3 元组即可，位移默认 0）。
 */
export type SlotValue = number[];
export type PoseDeg = Record<string, SlotValue>;

export interface Pose {
  format: 'witch.pose/1';
  id?: string;
  name?: string;
  bones: PoseDeg;
}

export interface PoseKey {
  t: number;
  pose: PoseDeg;
}

export interface PoseClip {
  format: 'witch.clip/1';
  id: string;
  name?: string;
  loop?: boolean;
  duration: number;
  keys: PoseKey[];
  /** 叠加层 id（引用 manifest.additives 的键），默认全开 */
  additive?: string[];
}

/** manifest 里的槽位条目（tools/rig-glb.mjs 产出） */
export interface RigSlotEntry {
  bone: string;
  key: string;
  cn: string;
  side: 'l' | 'r' | null;
  weighted: boolean;
  verts: number;
  /** rest 世界旋转四元数 [x,y,z,w] —— 语义轴换算的唯一依据 */
  q: number[];
}

export interface RigPhysChain {
  root: string;
  rootQ: number[];
  segs: { bone: string; verts: number }[];
  verts: number;
}

export interface RigModel {
  id: string;
  name?: string;
  rigFile: string;
  stats: {
    joints: number; weighted: number; slots: number; slotTotal: number;
    physBones: number; physVerts: number; physChains: number;
  };
  slots: Record<string, RigSlotEntry>;
  hands: Record<string, Record<string, { cn: string; segs: string[]; verts: number }>>;
  physChains: RigPhysChain[];
  unresolvedSlots: string[];
  selfCheck: Record<string, Record<string, { up: number; fwd: number; left: number; len: number }>>;
}

/** 叠加层预设（节选自 tools/rig-rules.mjs 的 ADDITIVE_PRESETS） */
export interface AdditivePreset {
  cn: string;
  period: number;
  bones: Record<string, number[]>;
}

export interface RigManifest {
  rigVersion: number;
  generatedAt: string;
  axes: Record<string, number[]>;
  additives: Record<string, AdditivePreset>;
  models: RigModel[];
}

/* ------------------------------------------------------------------ *
 * manifest 加载
 * ------------------------------------------------------------------ */

let cached: RigManifest | null = null;

export async function loadRigManifest(force = false): Promise<RigManifest | null> {
  if (cached && !force) return cached;
  try {
    const r = await fetch('/models/rig-manifest.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cached = await r.json() as RigManifest;
    return cached;
  } catch (e) {
    console.warn('[rig] manifest 未读到（先跑 `node tools/rig-glb.mjs`）', e);
    return null;
  }
}

export const rigModelOf = (m: RigManifest | null, id: string) =>
  m?.models.find((x) => x.id === id) ?? null;

/* ------------------------------------------------------------------ *
 * Rig：槽位句柄 + 姿势读写
 * ------------------------------------------------------------------ */

export interface SlotHandle {
  id: string;
  cn: string;
  side: 'l' | 'r' | null;
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  restInv: THREE.Quaternion;
  restPos: THREE.Vector3;
}

export class Rig {
  readonly modelId: string;
  readonly slots = new Map<string, SlotHandle>();
  readonly bones: THREE.Bone[] = [];
  readonly physChains: THREE.Bone[][] = [];
  readonly unresolved: string[] = [];

  private restQ = new Map<THREE.Bone, THREE.Quaternion>();
  private restP = new Map<THREE.Bone, THREE.Vector3>();
  /** 槽位骨的 id 反查（复位用） */
  private slotOf = new Map<THREE.Bone, SlotHandle>();

  // 复用的临时对象（每帧调用，不产生 GC）
  private _e = new THREE.Euler(0, 0, 0, EULER_ORDER);
  private _q = new THREE.Quaternion();
  private _qp = new THREE.Quaternion();

  constructor(root: THREE.Object3D, model: RigModel) {
    this.modelId = model.id;

    // 收集骨骼（GLTFLoader 已 sanitize 过名字，manifest 里存的就是 sanitized key）
    const byKey = new Map<string, THREE.Bone>();
    root.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      this.bones.push(b);
      this.restQ.set(b, b.quaternion.clone());
      this.restP.set(b, b.position.clone());
      if (b.name && !byKey.has(b.name)) byKey.set(b.name, b);
    });

    for (const [id, s] of Object.entries(model.slots)) {
      const bone = byKey.get(s.key) ?? byKey.get(s.bone);
      if (!bone) { this.unresolved.push(id); continue; }
      const rest = new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]).normalize();
      const h: SlotHandle = {
        id, cn: s.cn, side: s.side, bone,
        rest, restInv: rest.clone().invert(),
        restPos: this.restP.get(bone)!.clone(),
      };
      this.slots.set(id, h);
      this.slotOf.set(bone, h);
    }

    for (const c of model.physChains) {
      const segs = c.segs.map((x) => byKey.get(x.bone)).filter(Boolean) as THREE.Bone[];
      if (segs.length >= 2) this.physChains.push(segs);
    }
  }

  /* ---------- 语义 ⇄ 局部 ---------- */

  /**
   * 语义欧拉 → 该槽位骨的局部四元数。
   * q_local = conj(R) · q_world · R（推导见文件头 §①）
   */
  private localOf(h: SlotHandle, pitch: number, yaw: number, roll: number, out: THREE.Quaternion) {
    this._e.set(pitch * DEG, yaw * DEG, roll * DEG);
    // Euler(YXZ) 在 three 里表示世界旋转 R = Ry·Rx·Rz —— 直接当 q_world 用
    this._q.setFromEuler(this._e);
    return out.copy(h.restInv).multiply(this._q).multiply(h.rest);
  }

  /** 局部四元数 → 语义欧拉（capturePose 用；与 localOf 严格互逆） */
  private semanticOf(h: SlotHandle, qLocal: THREE.Quaternion, out: THREE.Euler) {
    // q_world = R · q_local · conj(R)
    this._qp.copy(h.rest).multiply(qLocal).multiply(h.restInv);
    return out.setFromQuaternion(this._qp, EULER_ORDER);
  }

  /* ---------- 姿势 ---------- */

  /** 全部槽位骨复位到 rest（**不动**物理骨 —— 它们归次级运动层） */
  resetSlots() {
    for (const h of this.slots.values()) {
      h.bone.quaternion.copy(h.rest);
      h.bone.position.copy(h.restPos);
    }
  }

  /** 全部骨骼（含物理骨）复位；切换模型/清空时用 */
  reset() {
    for (const b of this.bones) {
      const q = this.restQ.get(b), p = this.restP.get(b);
      if (q) b.quaternion.copy(q);
      if (p) b.position.copy(p);
    }
  }

  /**
   * 应用一个姿势。**先复位全部槽位**再写入 —— 这是不变量 1：
   * 不清的话，上一段动作没覆盖到的槽位会把姿态留在原地。
   */
  setPose(pose: PoseDeg) {
    this.resetSlots();
    this.addPose(pose);
  }

  /** 只叠加，不复位（叠加层用；调用方负责先 setPose） */
  addPose(pose: PoseDeg) {
    const out = this._qp;
    for (const [id, v] of Object.entries(pose)) {
      const h = this.slots.get(id);
      if (!h) continue;
      this.localOf(h, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, out);
      if (v[3] || v[4] || v[5]) {
        // 位移：身体空间增量直接加到 rest 位置上
        h.bone.position.set(
          h.restPos.x + (v[3] ?? 0),
          h.restPos.y + (v[4] ?? 0),
          h.restPos.z + (v[5] ?? 0),
        );
      }
      h.bone.quaternion.copy(out);
    }
  }

  /** 从当前骨骼状态读回姿势（编辑器「存姿势」用） */
  capturePose(): PoseDeg {
    const e = new THREE.Euler(0, 0, 0, EULER_ORDER);
    const out: PoseDeg = {};
    for (const h of this.slots.values()) {
      this.semanticOf(h, h.bone.quaternion, e);
      const v = [
        +(e.x / DEG).toFixed(2), +(e.y / DEG).toFixed(2), +(e.z / DEG).toFixed(2),
      ];
      const d = [
        h.bone.position.x - h.restPos.x,
        h.bone.position.y - h.restPos.y,
        h.bone.position.z - h.restPos.z,
      ];
      if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-5) {
        v.push(+d[0].toFixed(4), +d[1].toFixed(4), +d[2].toFixed(4));
      }
      // 只记录非零槽位 —— 姿势文件因此保持可读（几个到十几个条目）
      if (v.some((x) => Math.abs(x) > 0.01)) out[h.id] = v;
    }
    return out;
  }

  /* ---------- 槽位查询 ---------- */

  /** 按身体分区给 UI 分组的槽位清单（顺序与 tools/rig-rules.mjs 的槽位表一致） */
  slotGroups(): { key: string; cn: string; ids: string[] }[] {
    const g: { key: string; cn: string; ids: string[] }[] = [
      { key: 'trunk', cn: '躯干', ids: ['root', 'center', 'hip', 'pelvis', 'spine', 'chest', 'neck', 'head'] },
      { key: 'arm', cn: '手臂', ids: [] },
      { key: 'leg', cn: '腿', ids: [] },
      { key: 'extra', cn: '其他', ids: [] },
    ];
    for (const side of ['_l', '_r'] as const) {
      for (const id of ['shoulder', 'upperarm', 'twist', 'lowerarm', 'wrist']) {
        if (this.slots.has(id + side)) g[1].ids.push(id + side);
      }
      for (const id of ['thigh', 'shin', 'foot']) {
        if (this.slots.has(id + side)) g[2].ids.push(id + side);
      }
      if (this.slots.has('eye' + side)) g[3].ids.push('eye' + side);
    }
    for (const id of this.slots.keys()) {
      if (!g.some((x) => x.ids.includes(id))) g[3].ids.push(id);
    }
    return g.filter((x) => x.ids.length);
  }
}

/** 就地构建（模型已加进场景后调用） */
export const buildRig = (root: THREE.Object3D, model: RigModel) => new Rig(root, model);

/* ------------------------------------------------------------------ *
 * 姿势工具
 * ------------------------------------------------------------------ */

/** 镜像：`_l` ↔ `_r`，pitch 不变，yaw / roll 取反，位移 x 取反 */
export function mirrorPose(pose: PoseDeg): PoseDeg {
  const out: PoseDeg = {};
  for (const [id, v] of Object.entries(pose)) {
    const flipped = id.endsWith('_l') ? id.slice(0, -2) + '_r'
      : id.endsWith('_r') ? id.slice(0, -2) + '_l'
        : id;
    const m = [v[0] ?? 0, -(v[1] ?? 0), -(v[2] ?? 0)];
    if (v.length > 3) m.push(-(v[3] ?? 0), v[4] ?? 0, v[5] ?? 0);
    out[flipped] = m;
  }
  return out;
}

/** 把 A 的左右复制到 B 的同名侧（「左右同姿」按钮） */
export function mirrorOnto(pose: PoseDeg, slotId: string): PoseDeg {
  if (!slotId.endsWith('_l') && !slotId.endsWith('_r')) return pose;
  const v = pose[slotId];
  if (!v) return pose;
  const other = slotId.endsWith('_l') ? slotId.slice(0, -2) + '_r' : slotId.slice(0, -2) + '_l';
  const m = [v[0] ?? 0, -(v[1] ?? 0), -(v[2] ?? 0)];
  if (v.length > 3) m.push(-(v[3] ?? 0), v[4] ?? 0, v[5] ?? 0);
  return { ...pose, [other]: m };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** 姿势线性插值（语义欧拉是小角度量，逐分量线性即足够，且不会像四元数那样绕远路） */
export function lerpPose(a: PoseDeg, b: PoseDeg, k: number): PoseDeg {
  const out: PoseDeg = {};
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    const va = a[id] ?? [0, 0, 0];
    const vb = b[id] ?? [0, 0, 0];
    const n = Math.max(va.length, vb.length, 3);
    const v: number[] = [];
    for (let i = 0; i < n; i++) v.push(lerp(va[i] ?? 0, vb[i] ?? 0, k));
    out[id] = v;
  }
  return out;
}

/**
 * 关键帧采样。t 先按 loop/duration 归一，再在相邻两帧之间插值。
 * 缓动用 smoothstep（起点终点都平滑）—— 放置游戏里 90% 的动作够用了；
 * 需要更讲究的曲线时再往 PoseKey 上加 easing 字段。
 */
export function sampleClip(clip: PoseClip, t: number): PoseDeg {
  const keys = clip.keys;
  if (!keys.length) return {};
  if (keys.length === 1) return keys[0].pose;

  let time = t;
  if (clip.loop) {
    time = ((t % clip.duration) + clip.duration) % clip.duration;
  } else {
    time = Math.max(0, Math.min(clip.duration, t));
  }

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= time) i++;
  const k0 = keys[i];
  const k1 = keys[Math.min(i + 1, keys.length - 1)];
  const span = k1.t - k0.t;
  let u = span > 1e-6 ? (time - k0.t) / span : 0;
  u = u * u * (3 - 2 * u); // smoothstep
  return lerpPose(k0.pose, k1.pose, u);
}

/* ------------------------------------------------------------------ *
 * PosePlayer：采样 + 叠加层 → 写进 Rig
 * ------------------------------------------------------------------ */

export interface PlayerOptions {
  /** 叠加层开关；默认按 clip.additive ?? 全部打开 */
  additives?: Record<string, boolean>;
  /** 叠加层总强度倍数 */
  additiveGain?: number;
  /** 时间缩放 */
  timeScale?: number;
}

/**
 * 播放器：**总是**由它写骨（哪怕只是摆一个静态姿势）。
 *
 * 为什么不让编排层直接 rig.setPose：叠加层（呼吸/轻摆）是**持续**的，
 * 它需要一个始终在走的时间。播放器把两件事合在一起：
 *   `time`  —— 跟随 clip 播放位置（暂停时冻结，姿势不再前进）
 *   `clock` —— 从不停止，只用来驱动叠加层的相位
 * 于是「静止的姿势也在呼吸」，而暂停不会让呼吸卡死。
 */
export class PosePlayer {
  readonly rig: Rig;
  clip: PoseClip | null = null;
  /** 无 clip 时的静态基础姿势（编辑器摆姿势走这条） */
  basePose: PoseDeg | null = null;
  time = 0;
  clock = 0;
  playing = false;
  opts: PlayerOptions = {};
  private presets: Record<string, AdditivePreset>;

  /**
   * 交叉淡化：从「切换那一刻画面上真实的姿势」淡到新姿势。
   *
   * 为什么记的是**合成后的姿势**而不是上一个 clip：切换可能发生在
   * clip → 静态姿势、静态姿势 → clip、clip → clip 三种组合上。只记 clip 的话
   * 另外两种要么跳变，要么要写三套分支。记一份 PoseDeg 换来三条路共用一套逻辑。
   */
  private fadeFrom: PoseDeg | null = null;
  private fadeT = 0;
  private fadeDur = 0;
  /** 上一帧真正写进骨骼的姿势（含叠加层与淡化），`currentPose()` 用它 */
  private displayed: PoseDeg = {};

  constructor(rig: Rig, presets: Record<string, AdditivePreset> = {}) {
    this.rig = rig;
    this.presets = presets;
  }

  /** 切换时开始淡化；`0` = 硬切 */
  beginFade(seconds: number) {
    this.fadeFrom = this.displayed;
    this.fadeT = 0;
    this.fadeDur = Math.max(0, seconds);
  }

  get fading() {
    return this.fadeDur > 0;
  }

  play(clip: PoseClip, from = 0, fade = 0) {
    if (fade > 0) this.beginFade(fade);
    this.clip = clip;
    this.time = from;
    this.playing = true;
  }

  stop() {
    this.playing = false;
  }

  /** 切回静态姿势（排单/编辑时用）；停在当前位置不抽动 */
  setStatic(pose: PoseDeg, fade = 0) {
    if (fade > 0) this.beginFade(fade);
    this.basePose = pose;
    this.clip = null;
    this.playing = false;
  }

  /** 当前实际显示的姿势（含叠加层与淡化）—— 「加当前姿势」按这个取 */
  currentPose(): PoseDeg {
    if (Object.keys(this.displayed).length) return this.displayed;
    if (!this.clip) return this.basePose ?? {};
    return sampleClip(this.clip, this.time);
  }

  /** 每帧调用：采样 → 叠加 → 淡化 → 写骨 */
  update(dt: number) {
    const k = this.opts.timeScale ?? 1;
    this.clock += dt * k;
    if (this.playing) this.time += dt * k;

    let pose: PoseDeg;
    if (this.clip) pose = sampleClip(this.clip, this.time);
    else pose = this.basePose ?? {};

    const gain = this.opts.additiveGain ?? 1;
    const enabled = this.clip?.additive ?? Object.keys(this.presets);
    if (gain > 0 && enabled.length) {
      const mod: PoseDeg = {};
      for (const id of enabled) {
        const p = this.presets[id];
        if (!p || this.opts.additives?.[id] === false) continue;
        const phase = Math.sin((this.clock / p.period) * Math.PI * 2);
        for (const [slot, amp] of Object.entries(p.bones)) {
          const cur = mod[slot] ?? [0, 0, 0];
          mod[slot] = [
            (cur[0] ?? 0) + (amp[0] ?? 0) * phase * gain,
            (cur[1] ?? 0) + (amp[1] ?? 0) * phase * gain,
            (cur[2] ?? 0) + (amp[2] ?? 0) * phase * gain,
          ];
        }
      }
      pose = blendAdd(pose, mod);
    }

    if (this.fadeDur > 0 && this.fadeFrom) {
      this.fadeT = Math.min(this.fadeDur, this.fadeT + dt);
      const u = this.fadeT / this.fadeDur;
      pose = lerpPose(this.fadeFrom, pose, u * u * (3 - 2 * u));
      if (this.fadeT >= this.fadeDur) {
        this.fadeFrom = null;
        this.fadeDur = 0;
        this.fadeT = 0;
      }
    }

    this.displayed = pose;
    this.rig.setPose(pose);
  }
}

/** 叠加：把 mod 加到 base 上（逐分量），不改 base */
function blendAdd(base: PoseDeg, mod: PoseDeg): PoseDeg {
  const out: PoseDeg = { ...base };
  for (const [id, m] of Object.entries(mod)) {
    const b = out[id] ?? [0, 0, 0];
    out[id] = [(b[0] ?? 0) + (m[0] ?? 0), (b[1] ?? 0) + (m[1] ?? 0), (b[2] ?? 0) + (m[2] ?? 0)];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 内置姿势（随包必需的那几个 —— 见 design/角色动作库-骨骼槽位与姿势管线.md）
 * ------------------------------------------------------------------ */

/**
 * 注意：这些是**首版估值**，必须经 lab/scene/pose.html 目视标定后再定稿。
 * 数值写在这里而不是 JSON，是为了「随包必需」的姿势有编译期检查。
 *
 * 语义欧拉的换模型红利有边界：**关节角相同 ≠ 轮廓相同**。
 * 三只模型实测 rest 上臂与水平面夹角（下压）：yelan 44.8° / si 35.1° / akane 38.2°
 * ——同一个 roll 终态角不同。stand 的 48° 是按「自然垂放≈垂直线外 3–7°」标定的，
 * 三只模型都过；但如果某姿势在某个模型上穿模（如 si 的宽摆裙），就在姿势实验台里
 * 按模型微调后另存，不要回头改共享数据。
 */
export const BUILTIN_POSES: Record<string, Pose> = {
  stand: {
    format: 'witch.pose/1', id: 'stand', name: '站立',
    bones: {
      upperarm_l: [0, 0, 48], upperarm_r: [0, 0, -48],
      lowerarm_l: [6, 0, 4], lowerarm_r: [6, 0, -4],
      shoulder_l: [0, 0, 4], shoulder_r: [0, 0, -4],
      thigh_l: [0, 0, 3], thigh_r: [0, 0, -3],
      spine: [2, 0, 0], head: [-2, 0, 0],
    },
  },
  work: {
    format: 'witch.pose/1', id: 'work', name: '伏案',
    bones: {
      center: [0, 0, 0, 0, -0.04, 0],
      pelvis: [4, 0, 0], spine: [10, 0, 0], chest: [6, 0, 0],
      neck: [8, 0, 0], head: [4, 0, 0],
      upperarm_l: [-34, 0, 46], upperarm_r: [-34, 0, -46],
      lowerarm_l: [-46, 0, 12], lowerarm_r: [-46, 0, -12],
      thigh_l: [-6, 0, 4], thigh_r: [-6, 0, -4],
      shin_l: [8, 0, 0], shin_r: [8, 0, 0],
    },
  },
  sit: {
    format: 'witch.pose/1', id: 'sit', name: '坐',
    bones: {
      center: [0, 0, 0, 0, -0.30, 0.06],
      pelvis: [-6, 0, 0], spine: [6, 0, 0],
      thigh_l: [78, 0, 6], thigh_r: [78, 0, -6],
      shin_l: [-74, 0, 0], shin_r: [-74, 0, 0],
      foot_l: [10, 0, 0], foot_r: [10, 0, 0],
      upperarm_l: [-14, 0, 62], upperarm_r: [-14, 0, -62],
      lowerarm_l: [-30, 0, 8], lowerarm_r: [-30, 0, -8],
    },
  },
  lie: {
    format: 'witch.pose/1', id: 'lie', name: '躺',
    bones: {
      center: [-88, 0, 0, 0, -0.78, 0.1],
      spine: [4, 0, 0], neck: [6, 0, 0],
      upperarm_l: [0, 0, 46], upperarm_r: [0, 0, -46],
      thigh_l: [4, 0, 5], thigh_r: [4, 0, -5],
      shin_l: [10, 0, 0], shin_r: [10, 0, 0],
    },
  },
};
