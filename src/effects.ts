/**
 * 效果时间线（Effects）—— 把「一段演出」编译成若干参数曲线 + 临时后处理 + 临时几何。
 *
 * 为什么需要它（文档 §3.5(6)）：
 *   现在的做法是在 `stage.onFrame` 里手写 `if (t > 0.3) ... else ...`，每加一段演出就多一个
 *   状态机，且这些状态机各写各的相位、各写各的 `params.set`——两个演出叠在一起时，
 *   谁覆盖谁取决于注册顺序。这里把「一段演出」变成**声明**：
 *
 *     stage.effects.play(chargeBurst());
 *
 * 设计纪律（和 P1 一致，别破坏）：
 *
 *   ① **时间用真实 dt**，不用 1/30 动画步长。演出慢半拍是灾难；脸慢半拍是演技。
 *   ② **参数只有一个写入者**：`fx:<id>`。写进 ParamBus 走审计，别人抢写会收到 notice。
 *   ③ **能力在加载期定死**：材质模块必须在建舞台时就装好（`characterModules`），
 *      演出只驱动参数、不重编 shader。所以 `EffectSpec` 里没有 `material: { modules }`
 *      ——那是 P1 之前的设计，运行期注入等于每播一次演出编译一次。
 *   ④ **临时后处理**可以入链（`post`），结束按 `onEnd` 决定拆走还是留下。
 *
 * 相位 `t ∈ [0,1]` 由 `elapsed / duration` 得到；`loop` 时取模。`duration` 必须 > 0。
 */

import * as THREE from 'three';
import type { PassDescriptor, PostChain } from './post';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { ParamBus, ParamValue } from './shader/params';
import type { NoticeSink } from './notice';
import type { FrameContext } from './frame';

export interface EffectSpec {
  /** 稳定 id：重复播放会先停掉旧的（同一段演出不叠加两份） */
  id: string;
  /** 秒；必须 > 0 */
  duration: number;
  loop?: boolean;
  /**
   * 相位 → 参数表。每帧调用一次，返回值按 `fx:<id>` 写入参数总线。
   * 只写几何看不出、必须逐帧变化的量（强度、阈值、中心）；静态初值放模块默认值。
   */
  params?: (t: number, ctx: FrameContext) => Record<string, ParamValue>;
  /**
   * 逐帧回调：需要动 Object3D / 相机 / **临时 pass 的 uniform** 时用。
   * 参数类的东西优先走 `params(t)`（有写入者审计）；pass 的 uniform 不在总线上，
   * 用 `api.setPassParams()`。
   */
  onFrame?: (t: number, ctx: FrameContext, api: EffectRuntime) => void;
  /** 期间临时入链的 pass。id 省略时用 `fx:<id>` */
  post?: Omit<PassDescriptor, 'id'> & { id?: string };
  /** 期间挂进场景的对象（结束移除；`keep` 时留下） */
  overlay?: THREE.Object3D;
  /**
   * restore（默认）：结束拆走后处理与 overlay，参数留在最后一帧的值
   * keep：结束后后处理与 overlay 永久留下（一次性状态变化，例如「烧掉了」）
   */
  onEnd?: 'restore' | 'keep';
}

/** `onFrame` 拿到的运行时句柄 */
export interface EffectRuntime {
  readonly id: string;
  /** 本次演出临时插入的 pass（没有则为 null） */
  readonly pass: Pass | null;
  /** 本次演出的 overlay（没有则为 null） */
  readonly overlay: THREE.Object3D | null;
  /** 写临时 pass 的 uniform（按名字找 pass.uniforms / pass.material.uniforms） */
  setPassParams(values: Record<string, ParamValue>): void;
}

export interface EffectHandle {
  readonly id: string;
  /** 已播放的真实秒 */
  readonly time: number;
  /** 相位 0–1（loop 时循环） */
  readonly t: number;
  readonly playing: boolean;
  /** 立刻结束（按 onEnd 处理） */
  stop(): void;
}

export interface EffectsOptions {
  scene: THREE.Scene;
  post: PostChain;
  params: ParamBus;
  notices?: NoticeSink;
}

export interface Effects {
  play(spec: EffectSpec): EffectHandle;
  stop(id: string): void;
  stopAll(): void;
  readonly active: readonly string[];
  /** 舞台每帧调用（在参数 tick 与用户 onFrame 之后、渲染之前） */
  update(ctx: FrameContext): void;
  dispose(): void;
}

interface Live {
  spec: EffectSpec;
  handle: EffectHandle;
  runtime: EffectRuntime;
  elapsed: number;
  passId: string | null;
  overlay: THREE.Object3D | null;
  finished: boolean;
}

export function createEffects(opts: EffectsOptions): Effects {
  const { scene, post, params, notices } = opts;
  const live = new Map<string, Live>();

  function finish(entry: Live) {
    if (entry.finished) return;
    entry.finished = true;
    const keep = entry.spec.onEnd === 'keep';
    if (!keep && entry.passId && post.has(entry.passId)) {
      try {
        post.remove(entry.passId);
      } catch (e) {
        notices?.warn('effect-skipped', `效果「${entry.spec.id}」的 pass 移除失败。`, {
          id: entry.spec.id,
          detail: { error: String(e) },
        });
      }
    }
    const overlay = entry.overlay;
    if (!keep && overlay) {
      overlay.removeFromParent();
      // 只释放演出自己造的对象；外部传进来的（可能复用）不释放
      if (overlay.userData.nijimiOwned === true) {
        overlay.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) m?.dispose();
        });
      }
    }
    live.delete(entry.spec.id);
  }

  function makeHandle(spec: EffectSpec, entry: () => Live | undefined): EffectHandle {
    return {
      id: spec.id,
      get time() {
        return entry()?.elapsed ?? 0;
      },
      get t() {
        const e = entry();
        return e ? phase(e) : 0;
      },
      get playing() {
        return entry()?.finished === false;
      },
      stop() {
        const e = entry();
        if (e) finish(e);
      },
    };
  }

  function phase(e: Live): number {
    const d = e.spec.duration;
    if (!(d > 0)) return 1;
    const raw = e.elapsed / d;
    if (!e.spec.loop) return Math.min(1, raw);
    return raw - Math.floor(raw);
  }

  const effects: Effects = {
    play(spec) {
      if (!(spec.duration > 0)) {
        notices?.warn('effect-skipped', `效果「${spec.id}」的 duration 必须 > 0，已忽略。`, { id: spec.id });
        return makeHandle(spec, () => undefined);
      }

      // 同一段演出重播：先收掉旧的（避免两份叠加写同一个参数）
      const prev = live.get(spec.id);
      if (prev) finish(prev);

      const passId = spec.post ? (spec.post.id ?? `fx:${spec.id}`) : null;
      if (spec.post && passId) {
        if (post.has(passId)) {
          notices?.warn('effect-skipped', `效果「${spec.id}」的 pass id「${passId}」已在链上，跳过插入。`, {
            id: passId,
          });
        } else {
          try {
            post.insert({ priority: 100, ...spec.post, id: passId });
          } catch (e) {
            notices?.warn('effect-skipped', `效果「${spec.id}」的 pass 建链失败。`, {
              id: spec.id,
              detail: { error: String(e) },
            });
          }
        }
      }

      if (spec.overlay) scene.add(spec.overlay);

      const entry: Live = {
        spec,
        // 先占位，下面回填（handle 闭包读的是 map 里的同一个 Live）
        handle: null as unknown as EffectHandle,
        runtime: null as unknown as EffectRuntime,
        elapsed: 0,
        passId,
        overlay: spec.overlay ?? null,
        finished: false,
      };
      entry.handle = makeHandle(spec, () => live.get(spec.id));
      entry.runtime = {
        id: spec.id,
        get pass() {
          return passId ? post.get(passId) : null;
        },
        get overlay() {
          return entry.overlay;
        },
        setPassParams(values) {
          if (!passId || !post.has(passId)) return;
          try {
            post.setParams(passId, values);
          } catch (err) {
            notices?.warn('effect-skipped', `效果「${spec.id}」写 pass 参数失败。`, {
              id: spec.id,
              detail: { error: String(err) },
            });
          }
        },
      };
      live.set(spec.id, entry);

      // 起手式：t=0 的参数立刻写一次，避免第一帧画面还停在上一次的残值
      writeParams(entry, 0, null);
      return entry.handle;
    },

    stop(id) {
      const e = live.get(id);
      if (e) finish(e);
    },

    stopAll() {
      for (const e of [...live.values()]) finish(e);
    },

    get active() {
      return [...live.keys()];
    },

    update(ctx) {
      for (const e of [...live.values()]) {
        e.elapsed += ctx.delta;
        let t = phase(e);
        if (!e.spec.loop && e.elapsed >= e.spec.duration) {
          // 末帧先按 t=1 写一次，再收尾——否则最后一帧会停在 0.98 的强度上被拆掉
          writeParams(e, 1, ctx);
          e.spec.onFrame?.(1, ctx, e.runtime);
          finish(e);
          continue;
        }
        writeParams(e, t, ctx);
        e.spec.onFrame?.(t, ctx, e.runtime);
      }
    },

    dispose() {
      effects.stopAll();
      live.clear();
    },
  };

  function writeParams(e: Live, t: number, ctx: FrameContext | null) {
    const values = e.spec.params?.(t, ctx ?? emptyCtx);
    if (!values) return;
    const writer = `fx:${e.spec.id}`;
    for (const [id, value] of Object.entries(values)) params.set(id, value, writer);
  }

  return effects;
}

/**
 * `play()` 起手写 t=0 参数时还没有帧上下文。这里给一个「零帧」占位，
 * 让 `params(t)` 可以无条件读 `ctx.time` 之类的字段而不炸。
 */
const emptyCtx = {
  time: 0,
  delta: 0,
  frame: 0,
  animTime: 0,
  width: 1,
  height: 1,
  dpr: 1,
  camera: null as unknown as THREE.Camera,
  renderer: null as unknown as THREE.WebGLRenderer,
} as FrameContext;
