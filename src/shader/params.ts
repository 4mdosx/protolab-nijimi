/**
 * 参数总线（ParamBus）—— 具名参数 + 共享 `IUniform` 引用（文档 §3.5(1)）。
 *
 * 解决三件真实的事：
 *
 * ① **时间源只有一个。** `uTime` 由引擎每帧按**真实 dt** 写入；内容侧不再自己
 *    从 1/30 的动画步长里累加（那会让流光在 60Hz 屏上一跳一跳）。
 * ② **写一次全场生效。** 总线持有的是 `IUniform` 对象本身，材质绑的也是同一批对象。
 *    所以 `declare` / `adopt` **绝不 clone**——这正是 npr.ts 里
 *    `asShaderUniforms()` 保住的那条性质，别在重构时弄丢。
 * ③ **写入者有名字。** 同一帧内两个不同写入者抢同一个参数：后者被拒绝 + 发 notice。
 *    表情层与效果层抢 `opacity` 的问题由此有据可查，而不是「谁后跑谁赢」。
 *
 * 内建参数（引擎每帧写，内容只读）：
 *   uTime / uDelta / uFrame / uResolution / uCamPos / uCamDir
 */

import * as THREE from 'three';
import type { FrameContext } from '../frame';
import type { NoticeSink } from '../notice';
import type { ParamType } from './module';

export type ParamValue =
  | number
  | THREE.Vector2
  | THREE.Vector3
  | THREE.Vector4
  | THREE.Color
  | THREE.Texture
  | null;

/** 参数类型的默认值（材质/模块没绑定时用它占位，别传 undefined 给 GLSL） */
export function defaultParamValue(type: ParamType): ParamValue {
  switch (type) {
    case 'float': return 0;
    case 'vec2': return new THREE.Vector2();
    case 'vec3': return new THREE.Vector3();
    case 'vec4': return new THREE.Vector4();
    case 'color': return new THREE.Color(1, 1, 1);
    case 'texture': return null;
  }
}

export interface BuiltinParams {
  readonly time: THREE.IUniform<number>;
  readonly delta: THREE.IUniform<number>;
  readonly frame: THREE.IUniform<number>;
  readonly resolution: THREE.IUniform<THREE.Vector2>;
  readonly camPos: THREE.IUniform<THREE.Vector3>;
  readonly camDir: THREE.IUniform<THREE.Vector3>;
}

export interface ParamBus {
  /**
   * 声明并拿到共享 uniform。同名已存在时**返回已有的那个**（不覆盖、不克隆）——
   * 这样「某个模块先声明了 uTime」与「内容侧后声明」拿到的是同一个对象。
   */
  declare(id: string, value: ParamValue, type?: ParamType): THREE.IUniform;
  /** 接管一个**已经存在**的 uniform（npr 的共享容器就走这条进来） */
  adopt(id: string, uniform: THREE.IUniform, type?: ParamType): THREE.IUniform;
  get(id: string): THREE.IUniform | undefined;
  has(id: string): boolean;
  typeOf(id: string): ParamType | undefined;
  /**
   * 写一个参数。返回值 = 是否被接受。
   * 同一帧内换成另一个 writer 会被拒绝（并发 notice `param-conflict`）。
   */
  set(id: string, value: ParamValue, writer?: string): boolean;
  /** 当前所有参数 id（编辑器生成滑杆、审计用） */
  readonly ids: readonly string[];
  /** 内建参数的直通引用（每帧由 tick 写） */
  readonly builtin: BuiltinParams;
  /** 每帧开头调用：清空写入者审计，写内建参数 */
  tick(ctx: FrameContext): void;
  dispose(): void;
}

interface Entry {
  uniform: THREE.IUniform;
  type: ParamType;
  /** 本帧最后一个写入者 */
  writer: string | null;
}

const BUILTIN_IDS = new Set([
  'uTime', 'uDelta', 'uFrame', 'uResolution', 'uCamPos', 'uCamDir',
]);

function inferType(value: ParamValue): ParamType {
  if (typeof value === 'number') return 'float';
  if (value === null) return 'texture';
  if ((value as THREE.Texture).isTexture) return 'texture';
  if ((value as THREE.Vector2).isVector2) return 'vec2';
  if ((value as THREE.Vector3).isVector3) return 'vec3';
  if ((value as THREE.Vector4).isVector4) return 'vec4';
  if ((value as THREE.Color).isColor) return 'color';
  return 'float';
}

export interface ParamBusOptions {
  notices?: NoticeSink;
}

export function createParamBus(options: ParamBusOptions = {}): ParamBus {
  const entries = new Map<string, Entry>();
  const notices = options.notices;

  const builtin: BuiltinParams = {
    time: { value: 0 },
    delta: { value: 0 },
    frame: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    camPos: { value: new THREE.Vector3() },
    camDir: { value: new THREE.Vector3(0, 0, -1) },
  };

  function register(id: string, uniform: THREE.IUniform, type?: ParamType): THREE.IUniform {
    const existing = entries.get(id);
    if (existing) return existing.uniform;
    entries.set(id, { uniform, type: type ?? inferType(uniform.value as ParamValue), writer: null });
    return uniform;
  }

  // 内建参数一开始就在表里：模块可以直接按 id 解析，内容侧也能 get 到同一个对象
  entries.set('uTime', { uniform: builtin.time, type: 'float', writer: 'frame' });
  entries.set('uDelta', { uniform: builtin.delta, type: 'float', writer: 'frame' });
  entries.set('uFrame', { uniform: builtin.frame, type: 'float', writer: 'frame' });
  entries.set('uResolution', { uniform: builtin.resolution, type: 'vec2', writer: 'frame' });
  entries.set('uCamPos', { uniform: builtin.camPos, type: 'vec3', writer: 'frame' });
  entries.set('uCamDir', { uniform: builtin.camDir, type: 'vec3', writer: 'frame' });

  const bus: ParamBus = {
    declare(id, value, type) {
      return register(id, { value }, type);
    },

    adopt(id, uniform, type) {
      return register(id, uniform, type);
    },

    get(id) {
      return entries.get(id)?.uniform;
    },

    has(id) {
      return entries.has(id);
    },

    typeOf(id) {
      return entries.get(id)?.type;
    },

    set(id, value, writer = 'anonymous') {
      const e = entries.get(id);
      if (!e) {
        // 未声明就写：自动建一个，但要说出来——多半是模块 id 拼错或忘了 declare
        register(id, { value }, inferType(value));
        notices?.warn('param-undeclared', `参数「${id}」未声明就被写入，已按值推断类型。`, {
          id,
          detail: { writer },
        });
        return true;
      }
      if (e.writer !== null && e.writer !== writer) {
        notices?.warn(
          'param-conflict',
          `参数「${id}」本帧已由「${e.writer}」写入，「${writer}」的写入被拒绝。`,
          { id, detail: { holder: e.writer, writer } },
        );
        return false;
      }
      e.writer = writer;
      e.uniform.value = value;
      return true;
    },

    get ids() {
      return [...entries.keys()];
    },

    builtin,

    tick(ctx) {
      for (const e of entries.values()) e.writer = null;
      builtin.time.value = ctx.time;
      builtin.delta.value = ctx.delta;
      builtin.frame.value = ctx.frame;
      builtin.resolution.value.set(ctx.width, ctx.height);
      ctx.camera.getWorldPosition(builtin.camPos.value);
      ctx.camera.getWorldDirection(builtin.camDir.value);
      // 内建参数的持有者是 frame：本帧如果有人再写，会被审计拒绝（除非同样自称 frame）
      entries.get('uTime')!.writer = 'frame';
      entries.get('uDelta')!.writer = 'frame';
      entries.get('uFrame')!.writer = 'frame';
      entries.get('uResolution')!.writer = 'frame';
      entries.get('uCamPos')!.writer = 'frame';
      entries.get('uCamDir')!.writer = 'frame';
    },

    dispose() {
      entries.clear();
    },
  };

  return bus;
}

/** 判断一个 id 是不是引擎内建（编辑器用：内建参数不给滑杆）。 */
export function isBuiltinParam(id: string): boolean {
  return BUILTIN_IDS.has(id);
}
