/**
 * 表情层 —— 把**语义槽位**写成模型的脸。
 *
 * 定位（与 rig / anim 的分工，见 docs/表情层-系统设计与指令协议.md §5）：
 *   rig   管骨头怎么摆      —— 写 bone.quaternion
 *   anim  管动作怎么播      —— 写 bone.quaternion（与 rig 互斥）
 *   expr  管脸怎么变        —— 写 mesh.morphTargetInfluences + 材质（与上面两者**正交**）
 *
 * 为什么能正交：它们写的是**不同属性**。「挥着手同时笑」不需要任何互斥协议。
 * 唯一的例外是视线（`gazeMode: 'bone'` 要写眼骨），本版未实现，见 §5.2。
 *
 * 纪律：**本文件不认 morph 名字、不认材质名字。** 一切映射来自
 * `assets/models/expression-manifest.json`（转换期由 pipeline/expression-glb.mjs 产出）。
 * 名字判定只允许出现在 pipeline/，这里只拿 `target: <序号>` 与 material 的 srcName 查表。
 *
 * 运行期数据流：
 *   set/play（外部） → desired → update(dt) 插值 → current
 *        → 按 binding 分摊到 target 索引 → 写 14 个 primitive 的 influences
 */

import * as THREE from 'three';
import { materialCharter } from './charter';
import type {
  ExpBinding, ExpGaze, ExpMaterialBinding, ExpMorphBinding, ExpSlotMeta, ExpTarget,
  ExpressionManifest, ModelExpression, ModelCapabilities,
} from './exp-contract';
import { capabilitiesOf } from './exp-contract';

/* ------------------------------------------------------------------ *
 * 契约结构 —— 定义在 src/exp-contract.ts（FROZEN）。
 * 这里 re-export 是为了让老引用（editors/、character.ts）不用改 import 路径。
 * ------------------------------------------------------------------ */

export type {
  ExpBinding, ExpGaze, ExpMaterialBinding, ExpMorphBinding, ExpSlotMeta, ExpTarget,
  ExpressionManifest, ModelExpression, ModelCapabilities,
};

/** 视线方向：x 右正、y 上正，长度 = 强度（0..1） */
export interface GazeDir {
  x: number;
  y: number;
}

/** 读契约（模块级缓存：一页只拉一次） */
let manifestPromise: Promise<ExpressionManifest | null> | null = null;
export function loadExpressionManifest(): Promise<ExpressionManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch('/models/expression-manifest.json')
      .then((r) => (r.ok ? r.json() as Promise<ExpressionManifest> : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((e) => {
        // 缺 manifest 不是致命错误：角色照常加载，只是没有表情
        console.warn('[expr] expression-manifest.json 未读到（先跑 pipeline/expression-glb.mjs）', e);
        return null;
      });
  }
  return manifestPromise;
}

/** 加载某模型的表情契约并挂到已加载的模型上。没有契约返回 null。 */
export async function loadExpression(
  id: string,
  root: THREE.Object3D,
): Promise<ExpressionLayer | null> {
  const manifest = await loadExpressionManifest();
  const def = manifest?.models.find((m) => m.id === id);
  if (!manifest || !def) return null;
  return new ExpressionLayer(root, def, manifest.slots, manifest.groups);
}

/* ------------------------------------------------------------------ *
 * 表情层
 * ------------------------------------------------------------------ */

/** 单次 `play` 后再回落的调度 */
interface Release {
  hold: number;
  dur: number;
  from: number;
  t: number;
}

interface MaterialDriver {
  material: string;
  mode: 'add' | 'mul';
  value: number;
  /** 参与驱动的槽位（多个槽位可能共用同一材质叠加层，如 shy + symbol_blush） */
  slots: string[];
  /** 基值（构造时从材质读一次，之后只写增量） */
  base: number;
  applied: number;
}

const DEFAULT_FADE = 0.12;   // 秒。表情切换的交叉淡化（参考项目 300ms 偏慢，60fps 下 120ms 更跟手）
const MOUTH_EPS = 0.02;      // 口型权重低于此值视为闭嘴 → 口内件隐藏
const GAZE_FADE = 0.18;      // 视线转向的淡化（比表情慢一点，眼球瞬移很假）

/** 8 方向 morph 的角序：从「上」起顺时针，每 45° 一个（与 look_* 的槽位名同序） */
const LOOK_RING = [
  ['look_u', 0], ['look_ur', 45], ['look_r', 90], ['look_rd', 135],
  ['look_d', 180], ['look_dl', 225], ['look_l', 270], ['look_lu', 315],
] as const;

export class ExpressionLayer {
  readonly model: ModelExpression;
  /** 能力表（manifest 算好的；旧资产则本地推导） */
  readonly caps: ModelCapabilities;
  /** 槽位 → 是否可做（unresolved 里的为 false） */
  readonly available: ReadonlySet<string>;
  /** 槽位元数据（中文名 / 分组）—— 编辑器与调试面板用 */
  readonly slots: Readonly<Record<string, ExpSlotMeta>>;
  readonly groups: readonly string[];

  private readonly root: THREE.Object3D;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly morphOnly: THREE.Mesh[] = [];
  /** target 索引 → 谁在驱动它 */
  private readonly drivers: Map<number, { slot: string; w: number }[]> = new Map();
  private readonly matDrivers: MaterialDriver[] = [];
  /** 口型槽位（决定口内件的显隐） */
  private readonly mouthSlots = new Set<string>();
  /** 情绪槽位（决定 override 的衰减与自动降权） */
  private readonly emotionSlots = new Set<string>();
  private readonly targetCount: number;

  /* ---------- 视线 ---------- */
  /** morph 模式：能用的 look_* 槽位（缺哪几个就不给那几度） */
  private readonly lookSlots = new Map<string, { slot: string; deg: number }>();
  /** bone 模式：眼骨 + rest 世界旋转（视线写法与 rig 的语义欧拉同一套） */
  private readonly eyeBones: { bone: THREE.Bone; rest: THREE.Quaternion }[] = [];
  private readonly gazeMaxDeg: number;
  /** 当前视线（方向 + 强度），由指令写入，tickGaze 平滑逼近 */
  private readonly gazeWant: GazeDir = { x: 0, y: 0 };
  private readonly gazeNow: GazeDir = { x: 0, y: 0 };
  /** gaze.at 的世界目标点；null = 方向模式或空闲 */
  private gazeAtPoint: THREE.Vector3 | null = null;
  /** 自动视线游移（无指令时的「活着」感） */
  autoGaze = false;
  private gazeTimer = 3;
  private gazeWander: GazeDir = { x: 0, y: 0 };
  /** 头部高度（世界 Y），gaze.at 用它当眼睛位置 */
  private headWorldY = 1.4;

  private readonly desired = new Map<string, number>();
  private readonly current = new Map<string, number>();
  private readonly releases = new Map<string, Release>();
  private readonly fadeOf = new Map<string, number>();

  /** 自动眨眼 */
  autoBlink = true;
  private blinkTimer = 2.5;
  private blinkPhase: 'idle' | 'closing' | 'hold' | 'opening' = 'idle';
  private blinkVal = 0;
  private blinkT = 0;
  private readonly warned = new Set<string>();

  /** 口内件的当前显隐（避免每帧写 visible） */
  private mouthShown = true;

  // 复用的临时对象（每帧视线计算用，不产生 GC）
  private readonly _v = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _qRoot = new THREE.Quaternion();
  private readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _gq = new THREE.Quaternion();

  constructor(
    root: THREE.Object3D,
    model: ModelExpression,
    slots: Readonly<Record<string, ExpSlotMeta>> = {},
    groups: readonly string[] = ['emotion', 'blink', 'eye', 'mouth', 'look', 'brow', 'symbol'],
  ) {
    this.root = root;
    this.model = model;
    this.caps = capabilitiesOf(model);
    this.available = new Set(Object.keys(model.bindings));
    this.slots = slots;
    this.groups = groups;
    this.gazeMaxDeg = model.gaze?.maxDeg ?? 14;

    for (const [slot, list] of Object.entries(model.bindings)) {
      const group = slots[slot]?.group;
      if (group === 'mouth') this.mouthSlots.add(slot);
      if (group === 'emotion') this.emotionSlots.add(slot);
      for (const b of list) {
        if (b.ch === 'morph') {
          const arr = this.drivers.get(b.target) ?? [];
          arr.push({ slot, w: b.w ?? 1 });
          this.drivers.set(b.target, arr);
        }
      }
    }
    for (const [slot, deg] of LOOK_RING) {
      if (this.available.has(slot)) this.lookSlots.set(slot, { slot, deg });
    }
    this.slots = slots;
    this.groups = groups;

    for (const [slot, list] of Object.entries(model.bindings)) {
      const group = slots[slot]?.group;
      if (group === 'mouth') this.mouthSlots.add(slot);
      if (group === 'emotion') this.emotionSlots.add(slot);
      for (const b of list) {
        if (b.ch === 'morph') {
          const arr = this.drivers.get(b.target) ?? [];
          arr.push({ slot, w: b.w ?? 1 });
          this.drivers.set(b.target, arr);
        }
      }
    }

    // 材质叠加层按材质聚合（同材质的多个槽位取 max，不叠加 —— 否则脸红会叠成过曝）
    const byMat = new Map<string, MaterialDriver>();
    for (const list of Object.values(model.bindings)) {
      for (const b of list) {
        if (b.ch !== 'material') continue;
        let d = byMat.get(b.material);
        if (!d) {
          d = { material: b.material, mode: b.mode, value: b.value, slots: [], base: 0, applied: 0 };
          byMat.set(b.material, d);
        }
        if (!d.slots.includes(stringSlotOf(model.bindings, b))) d.slots.push(stringSlotOf(model.bindings, b));
      }
    }
    this.matDrivers = [...byMat.values()];

    // 收集网格：morph 权重是 **per-mesh** 的（14 个 primitive 各有一份），必须全写
    let maxTarget = -1;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const infl = mesh.morphTargetInfluences;
      if (infl?.length) {
        this.meshes.push(mesh);
        maxTarget = Math.max(maxTarget, infl.length - 1);
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some((m) => materialCharter(m)?.morphOnly)) this.morphOnly.push(mesh);
    });
    this.targetCount = maxTarget + 1;

    if (this.meshes.length && model.targetCount && this.targetCount !== model.targetCount) {
      console.warn(`[expr] ${model.id}: 运行期 target 数 ${this.targetCount} ≠ manifest ${model.targetCount}（资产版本不匹配？）`);
    }
    // 基值只读一次：之后只写增量，不把累乘写回基值
    for (const d of this.matDrivers) d.base = this.findBaseOpacity(d.material) ?? 0;

    /* ---------- 视线：bone 模式收集眼骨 ---------- *
     * 名字来自骨骼契约（expression-glb 从 rig-manifest 抄的 key），运行期不猜。
     * rest 取构造时的 bone.quaternion —— 眼球骨的 rest 通常是 identity，
     * 用「局部后乘」就在局部轴下转，不必再做世界共轭。 */
    const gz = model.gaze;
    if (gz?.mode === 'bone' && gz.bones?.length) {
      const byName = new Map<string, THREE.Bone>();
      root.traverse((o) => {
        const b = o as THREE.Bone;
        if (b.isBone && b.name && !byName.has(b.name)) byName.set(b.name, b);
      });
      for (const name of gz.bones) {
        const bone = byName.get(name);
        if (!bone) {
          console.warn(`[expr] ${model.id}: 视线眼骨「${name}」不在骨架里 → 视线降级为不动`);
          this.eyeBones.length = 0;
          break;
        }
        this.eyeBones.push({ bone, rest: bone.quaternion.clone() });
      }
    }

    // gaze.at 需要一个「眼睛在哪」。用包围盒顶部往下 6%（头顶略下 = 眼线），
    // 不追头骨：头骨会被姿势层转，静态估值反而稳，而且每帧省一次矩阵分解。
    const box = new THREE.Box3().setFromObject(root);
    const h = box.max.y - box.min.y;
    if (Number.isFinite(h) && h > 0.2) this.headWorldY = box.max.y - h * 0.06;
  }

  /** 这个模型能不能做某个槽位（消费方应先问再做，而不是默默没反应） */
  has(slot: string): boolean {
    return this.available.has(slot);
  }

  /** 语义槽位 → 权重。0 = 关闭，1 = 满。持有到下次设置（不自动回落） */
  set(slot: string, weight: number, fade = DEFAULT_FADE): void {
    if (!this.available.has(slot)) {
      if (!this.warned.has(slot)) {
        this.warned.add(slot);
        console.warn(`[expr] ${this.model.id} 不支持槽位「${slot}」（见 expression-manifest.json 的 unresolved）`);
      }
      return;
    }
    this.desired.set(slot, THREE.MathUtils.clamp(weight, 0, 1));
    this.fadeOf.set(slot, fade);
    this.releases.delete(slot);
  }

  /** 播一次再回落：`hold` 秒后按 `release` 秒淡出。一次性演出用 */
  play(slot: string, opts: { hold?: number; fade?: number; release?: number; w?: number } = {}): void {
    const { hold = 1.2, fade = DEFAULT_FADE, release = 0.45, w = 1 } = opts;
    this.set(slot, w, fade);
    this.releases.set(slot, { hold, dur: release, from: w, t: 0 });
  }

  /** 清空所有槽位（含待回落的）与视线 */
  clear(): void {
    this.desired.clear();
    this.releases.clear();
    this.gazeAtPoint = null;
    this.gazeWant.x = 0;
    this.gazeWant.y = 0;
  }

  /** 关掉自动眨眼（如消费方自己驱动眨眼） */
  setAutoBlink(on: boolean): void {
    this.autoBlink = on;
  }

  /* ------------------------------ 视线 ------------------------------ */

  /**
   * 看向一个归一化方向（x 右正 / y 上正，长度即强度）。
   * 两条落地路径对消费方透明：
   *   morph 模式（akane）→ 分摊到 8 方向 look_* 权重，与姿势层零竞争
   *   bone  模式（si）  → 转眼骨，**独占**眼骨（必须在姿势层之后写）
   */
  gazeDir(x: number, y: number): void {
    const m = Math.hypot(x, y);
    const k = m > 1 ? 1 / m : 1;
    this.gazeWant.x = x * k;
    this.gazeWant.y = y * k;
    this.gazeAtPoint = null;
  }

  /** 看向世界坐标的一点；null = 回到空闲（方向归零 / 自动游移） */
  gazeAt(world: THREE.Vector3 | null): void {
    if (!world) { this.gazeAtPoint = null; this.gazeWant.x = 0; this.gazeWant.y = 0; return; }
    this.gazeAtPoint = this.gazeAtPoint ? this.gazeAtPoint.copy(world) : world.clone();
  }

  setAutoGaze(on: boolean): void {
    this.autoGaze = on;
  }

  /** 当前视线方向（调试面板 / 断言用） */
  get gazeNowDir(): Readonly<GazeDir> {
    return this.gazeNow;
  }

  /** 当前真实生效的权重表（调试面板 / 测试断言用） */
  get effective(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.current);
  }

  /**
   * 每帧推进。`dt` 用动画层的步长（30fps 的 `ANIM_FPS` 倒数），不要用真实帧时长 ——
   * 表情与骨架动画必须同一时基，否则慢帧时脸会比身体先动。
   */
  update(dt: number): void {
    if (!this.meshes.length) return;
    this.tickReleases(dt);
    this.tickBlink(dt);
    this.tickGaze(dt);
    this.tickFade(dt);
    this.writeMorphs();
    this.writeMaterials();
    this.updateMouthVisibility();
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 一次性表情的定时释放 */
  private tickReleases(dt: number): void {
    for (const [slot, r] of this.releases) {
      r.t += dt;
      if (r.t <= r.hold) continue;
      const k = Math.min(1, (r.t - r.hold) / Math.max(1e-3, r.dur));
      this.desired.set(slot, r.from * (1 - k));
      if (k >= 1) this.releases.delete(slot);
    }
  }

  /** 眨眼节律：2–6s 随机间隔 / 闭 60ms / 停 40ms / 睁 90ms */
  private tickBlink(dt: number): void {
    const explicit = [...this.blinkTargetSlots()].some((s) => (this.desired.get(s) ?? 0) > 0.001);
    if (!this.autoBlink || explicit) { this.blinkVal = 0; return; }

    // 情绪激活时按 override 降权（VRM 的 'blend'）：笑着眨眼时眼皮权重连续衰减，
    // 而不是「有情绪就关掉眨眼」那种硬开关。
    const emo = this.emotionStrength();
    const scale = 1 - emo;

    switch (this.blinkPhase) {
      case 'idle':
        this.blinkTimer -= dt;
        if (this.blinkTimer <= 0) { this.blinkPhase = 'closing'; this.blinkT = 0; }
        break;
      case 'closing':
        this.blinkT += dt; this.blinkVal = Math.min(1, this.blinkT / 0.06);
        if (this.blinkT >= 0.06) { this.blinkPhase = 'hold'; this.blinkT = 0; }
        break;
      case 'hold':
        this.blinkT += dt; this.blinkVal = 1;
        if (this.blinkT >= 0.04) { this.blinkPhase = 'opening'; this.blinkT = 0; }
        break;
      case 'opening':
        this.blinkT += dt; this.blinkVal = Math.max(0, 1 - this.blinkT / 0.09);
        if (this.blinkT >= 0.09) {
          this.blinkPhase = 'idle'; this.blinkVal = 0;
          this.blinkTimer = 2 + Math.random() * 4;
        }
        break;
    }
    this.autoBlinkValue = this.blinkVal * Math.max(0, scale);
  }

  private autoBlinkValue = 0;

  /* ------------------------------ 视线 ------------------------------ */

  /**
   * 视线推进：目标 → 平滑 → 落地。
   * morph 模式不在这里写权重 —— 它和普通槽位写同一批 target，必须在 writeMorphs
   * 里统一取 max（否则 gaze 与显式 look_* 会叠加成两倍）。
   */
  private tickGaze(dt: number): void {
    const mode = this.caps.gaze.mode;
    if (mode === 'none') return;

    if (this.gazeAtPoint) {
      const dir = this.dirToLocal(this.gazeAtPoint);
      if (dir) { this.gazeWant.x = dir.x; this.gazeWant.y = dir.y; }
    } else if (this.autoGaze && Math.hypot(this.gazeWant.x, this.gazeWant.y) < 0.02) {
      // 空闲游移：每 2.5–5s 换一个很轻的目标 —— 「在看房间里不同的东西」
      this.gazeTimer -= dt;
      if (this.gazeTimer <= 0) {
        this.gazeTimer = 2.5 + Math.random() * 2.5;
        this.gazeWander.x = (Math.random() * 2 - 1) * 0.25;
        this.gazeWander.y = (Math.random() * 2 - 1) * 0.14;
      }
      this.gazeWant.x = this.gazeWander.x;
      this.gazeWant.y = this.gazeWander.y;
    }

    const k = 1 - Math.exp(-dt / Math.max(1e-3, GAZE_FADE / 3));
    this.gazeNow.x += (this.gazeWant.x - this.gazeNow.x) * k;
    this.gazeNow.y += (this.gazeWant.y - this.gazeNow.y) * k;

    if (this.eyeBones.length) this.applyGazeBones();
  }

  /** 世界点 → 角色局部归一化方向（x 右正 / y 上正，1 = 满量程） */
  private dirToLocal(world: THREE.Vector3): GazeDir | null {
    this.root.updateWorldMatrix(true, false);
    const eyeY = this.headWorldY;
    this._v.copy(world);
    this._v2.setFromMatrixPosition(this.root.matrixWorld);
    this._v2.y = eyeY;
    this._v.sub(this._v2);
    if (this._v.lengthSq() < 0.0025) return null;   // 目标就在眼前，方向无意义
    // 世界方向 → 角色朝向空间（模型正面朝 -Z）
    this._qRoot.copy(this.root.quaternion).invert();
    this._v.applyQuaternion(this._qRoot).normalize();
    const yaw = Math.atan2(this._v.x, -this._v.z);
    const pitch = Math.atan2(this._v.y, Math.hypot(this._v.x, this._v.z));
    const maxRad = (this.gazeMaxDeg * Math.PI) / 180;
    return {
      x: THREE.MathUtils.clamp(yaw / maxRad, -1, 1),
      y: THREE.MathUtils.clamp(pitch / maxRad, -1, 1),
    };
  }

  /**
   * bone 模式：把方向写成眼骨旋转。
   * 符号约定（**实测标定，别按直觉改**）：x>0 看角色右方 = 绕局部 Y **负**转；
   * y>0 看上 = 绕局部 X **负**转。rest 是构造时抓的，所以每帧都是「从静止重算」，
   * 不会累积。**这条通道独占眼骨**：姿势数据不要写 eye_l/eye_r。
   *
   * 标定方法：`gaze.dir(1,0)` 拍一张、`gaze.dir(0,1)` 拍一张，看瞳孔往哪边移 ——
   * MMD 眼球骨的局部轴并不都跟模型空间一致，spec 里写不出来，只能看。
   * （si 实测：+X 转向让瞳孔偏向**观众右侧**，即角色左侧，所以 x 要取负。）
   */
  private applyGazeBones(): void {
    const maxRad = (this.gazeMaxDeg * Math.PI) / 180;
    this._e.set(-this.gazeNow.y * maxRad, -this.gazeNow.x * maxRad, 0, 'YXZ');
    this._gq.setFromEuler(this._e);
    for (const { bone, rest } of this.eyeBones) {
      bone.quaternion.copy(rest).multiply(this._gq);
    }
  }

  /** morph 模式：方向 → 相邻两个 look_* 的权重（线性插值，不会两个方向都满） */
  private gazeWeights(): Map<string, number> {
    const out = new Map<string, number>();
    const m = Math.hypot(this.gazeNow.x, this.gazeNow.y);
    if (m < 0.01 || !this.lookSlots.size) return out;
    const w = Math.min(1, m);
    if (this.lookSlots.size === 1) {
      out.set([...this.lookSlots.values()][0].slot, w);
      return out;
    }
    // mirrorX：该资产的 look_L/R 按观众视角命名（akane 实测），横向要取反才能对契约
    const gx = this.model.gaze?.mirrorX ? -this.gazeNow.x : this.gazeNow.x;
    const deg = ((Math.atan2(gx, this.gazeNow.y) * 180) / Math.PI + 360) % 360;
    const ring = [...this.lookSlots.values()].sort((a, b) => a.deg - b.deg);
    let i = ring.length - 1;
    for (let k = 0; k < ring.length; k++) if (ring[k].deg <= deg) i = k;
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const span = (((b.deg - a.deg) % 360) + 360) % 360 || 360;
    const t = (((deg - a.deg) % 360) + 360) % 360 / span;
    out.set(a.slot, (1 - t) * w);
    out.set(b.slot, t * w);
    return out;
  }

  private blinkTargetSlots(): string[] {
    return ['blink', 'blink_l', 'blink_r'].filter((s) => this.available.has(s));
  }

  /** 情绪强度 = 所有情绪槽位里的最大权重（用于 blink / mouth 的降权） */
  private emotionStrength(): number {
    let m = 0;
    for (const s of this.emotionSlots) m = Math.max(m, this.current.get(s) ?? 0);
    return m;
  }

  /** desired → current 的指数逼近期（帧率无关） */
  private tickFade(dt: number): void {
    for (const [slot, want] of this.desired) {
      const cur = this.current.get(slot) ?? 0;
      if (Math.abs(want - cur) < 1e-4) { this.current.set(slot, want); continue; }
      const fade = this.fadeOf.get(slot) ?? DEFAULT_FADE;
      const k = 1 - Math.exp(-dt / Math.max(1e-3, fade / 3));
      this.current.set(slot, cur + (want - cur) * k);
    }
    // desired 里没有但 current 还有残值的槽位（clear 之后）继续回落
    for (const [slot, cur] of this.current) {
      if (this.desired.has(slot) || cur < 1e-4) continue;
      this.current.set(slot, cur * (1 - Math.min(1, dt / Math.max(1e-3, DEFAULT_FADE))));
    }
    for (const [slot, v] of this.current) if (v < 1e-4) this.current.delete(slot);
  }

  /** 把槽位权重摊到 morph target 上并写入所有网格 */
  private writeMorphs(): void {
    const acc = new Map<number, number>();
    const emo = this.emotionStrength();
    const mouthScale = this.mouthOverrideScale(emo);

    for (const [slot, w] of this.current) {
      const weight = this.mouthSlots.has(slot) ? w * mouthScale : w;
      if (weight <= 0) continue;
      for (const [target, list] of this.drivers) {
        for (const d of list) {
          if (d.slot !== slot) continue;
          acc.set(target, (acc.get(target) ?? 0) + weight * d.w);
        }
      }
    }
    // 自动眨眼直接叠到「双眼闭」那一格上（没有对应的显式槽位驱动时）
    if (this.autoBlinkValue > 0) {
      for (const [target, list] of this.drivers) {
        if (list.some((d) => d.slot === 'blink')) {
          acc.set(target, (acc.get(target) ?? 0) + this.autoBlinkValue);
        }
      }
    }

    // 视线（morph 模式）：与显式 look_* 槽位**取 max**，不叠加。
    // 两条路写的是同一批 target：显式槽位是「消费方要她看右」，gaze 是「她在看某点」，
    // 同时发生时后者不该让前者翻倍。
    if (this.lookSlots.size) {
      for (const [slot, w] of this.gazeWeights()) {
        if (w <= 0) continue;
        for (const [target, list] of this.drivers) {
          for (const d of list) {
            if (d.slot !== slot) continue;
            acc.set(target, Math.max(acc.get(target) ?? 0, w * d.w));
          }
        }
      }
    }

    for (const mesh of this.meshes) {
      const infl = mesh.morphTargetInfluences;
      if (!infl) continue;
      for (let i = 0; i < infl.length; i++) infl[i] = Math.min(1, acc.get(i) ?? 0);
    }
  }

  /** 情绪声明了 overrideMouth: blend 时，口型权重随情绪衰减（参考值：有情绪时 25%） */
  private mouthOverrideScale(emo: number): number {
    if (emo <= 0) return 1;
    for (const s of this.emotionSlots) {
      const policy = this.model.overrides?.[s]?.mouth;
      if (policy === 'blend' && (this.current.get(s) ?? 0) > 0.5) return 1 - 0.75 * emo;
      if (policy === 'block' && (this.current.get(s) ?? 0) > 0.5) return 0;
    }
    return 1;
  }

  /**
   * 材质叠加层（如 si 的「照れ」= 表情图集 alpha 渐显）。
   * 每帧按名重找材质：编辑器切「契约轨道」时会克隆材质实例，持有旧引用会静默失效。
   * 同材质多槽位取 max —— 叠加会过曝。
   */
  private writeMaterials(): void {
    if (!this.matDrivers.length) return;
    let dirty = false;
    const want = new Map<string, number>();
    for (const d of this.matDrivers) {
      let m = 0;
      for (const s of d.slots) m = Math.max(m, this.current.get(s) ?? 0);
      want.set(d.material, m);
    }
    for (const d of this.matDrivers) {
      const w = want.get(d.material) ?? 0;
      const target = d.mode === 'add' ? d.base + d.value * w : d.base * (1 + d.value * w);
      if (Math.abs(target - d.applied) < 1e-4) continue;
      d.applied = target;
      dirty = true;
    }
    if (!dirty) return;

    const byName = new Map(this.matDrivers.map((d) => [d.material, d]));
    const seen = new Set<THREE.Material>();
    for (const mesh of this.meshes.concat(this.morphOnly)) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat || seen.has(mat)) continue;
        const name = materialCharter(mat)?.srcName ?? mat.name;
        const d = byName.get(name);
        if (!d) continue;
        seen.add(mat);
        mat.opacity = THREE.MathUtils.clamp(d.applied, 0, 1);
        mat.transparent = true; // 从 0 渐显的叠加层必须是透明通道
      }
    }
  }

  /** 口内 / 舌 / 齿：只在嘴张开时露出来（契约的 morphOnly） */
  private updateMouthVisibility(): void {
    if (!this.morphOnly.length) return;
    let open = 0;
    for (const s of this.mouthSlots) open = Math.max(open, this.current.get(s) ?? 0);
    const show = open > MOUTH_EPS;
    if (show === this.mouthShown) return;
    this.mouthShown = show;
    for (const m of this.morphOnly) {
      // 描边壳等其它原因隐藏的件不要被这里打开
      if (!show && m.visible) m.visible = false;
      else if (show) m.visible = true;
    }
  }

  /** 按材质名找基值（opacity）。找不到返回 null */
  private findBaseOpacity(name: string): number | null {
    for (const mesh of this.meshes.concat(this.morphOnly)) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const n = materialCharter(mat)?.srcName ?? mat.name;
        if (n === name) return mat.opacity;
      }
    }
    return null;
  }
}

/** 反查某条 material binding 属于哪个槽位（构造期一次性用） */
function stringSlotOf(bindings: Readonly<Record<string, readonly ExpBinding[]>>, needle: ExpMaterialBinding): string {
  for (const [slot, list] of Object.entries(bindings)) {
    for (const b of list) if (b.ch === 'material' && b === needle) return slot;
  }
  return '';
}
