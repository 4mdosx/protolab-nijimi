/**
 * 帧上下文与三时钟（文档 §3.7）。
 *
 * 之前时间源四处分裂：`elapsed`（外部 rAF 传进来的）、内容自己累加、`setTime()`、
 * 以及 1/30 的 `animStep`。同一个「现在几点」有四种答案，流光跟不跟手全看运气。
 *
 * 这里把它们收敛成三个明确的东西：
 *
 *   frameTime  真实秒，不封顶。消费者：相机、uTime/uDelta、Effect、后处理、粒子。
 *   animTime   1/30 累加器。消费者：骨骼、表情、内容包 update —— 与 ANIM_FPS 契约一致。
 *   frame      帧序号（整数）。消费者：抖动/交替采样（TAA 类）、调试。
 *
 * `effectTime` 不在这里：它按 Effect 实例从 0 计，属于 `effects.ts`（P2）。
 */

import * as THREE from 'three';

export interface FrameContext {
  /** 舞台建立以来的真实秒 */
  readonly time: number;
  /** 本帧真实 dt（秒）；首帧与异常 dt 为 0 */
  readonly delta: number;
  /** 帧序号，从 0 递增 */
  readonly frame: number;
  /** 动画层累计时间（1/30 步长累加） */
  readonly animTime: number;
  /** 逻辑尺寸（CSS px） */
  readonly width: number;
  readonly height: number;
  /** 设备像素比（已按上限收敛） */
  readonly dpr: number;
  readonly camera: THREE.Camera;
  readonly renderer: THREE.WebGLRenderer;
}

export interface FrameClock {
  /** 推进一帧；返回**只读**快照（同一对象复用，别存下来） */
  tick(dt: number, size: { width: number; height: number }): FrameContext;
  /** 动画层推进一步（舞台的 1/30 累加器每步调用一次） */
  addAnim(step: number): void;
  readonly context: FrameContext;
  reset(): void;
}

export function createFrameClock(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
): FrameClock {
  let time = 0;
  let delta = 0;
  let frame = -1;
  let animTime = 0;
  let width = 1;
  let height = 1;

  // 快照对象复用：每帧只改字段。调用方若需要留存请自己拷贝。
  const ctx = {
    get time() { return time; },
    get delta() { return delta; },
    get frame() { return frame; },
    get animTime() { return animTime; },
    get width() { return width; },
    get height() { return height; },
    get dpr() { return renderer.getPixelRatio(); },
    camera,
    renderer,
  } as FrameContext;

  return {
    tick(rawDt, size) {
      // 外部 rAF 在切后台回来时会给一个巨大的 dt（甚至 NaN）：
      // 真实时间不封顶是给相机用的，但不能把时钟本身打歪。
      const d = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : 0;
      delta = d;
      time += d;
      frame++;
      width = Math.max(1, size.width);
      height = Math.max(1, size.height);
      return ctx;
    },
    addAnim(step) {
      if (Number.isFinite(step) && step > 0) animTime += step;
    },
    get context() {
      return ctx;
    },
    reset() {
      time = 0;
      delta = 0;
      frame = -1;
      animTime = 0;
    },
  };
}
