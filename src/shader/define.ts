/**
 * 层 B：独立材质（`defineMaterial`）—— 自己写 GLSL，但由引擎供时间/相机/队列/参数。
 *
 * 与层 A（`extendMaterial` 注入内建材质）的分工：
 *
 *   层 A  要保住蒙皮 / morph / 阴影 / PBR 光照链 → 只能往 three 的材质里插代码
 *   层 B  凭空出现的几何（连线、光柱、法阵、冲击面）→ 不需要光照链，直接 new ShaderMaterial
 *
 * 为什么还要包一层：手写 `new THREE.ShaderMaterial` 在 `kits/conduits.ts` 里踩过三个坑，
 * 这三个坑在内容侧只会更严重（内容侧没有引擎作者在旁边看着）：
 *
 *   ① **时间从哪来**：内容自己累加 `uTime` 就会走 1/30 的动画步长，
 *      流光在 60Hz 屏上一跳一跳；这里统一从 ParamBus 取内建 `uTime`（真实 dt）。
 *   ② **队列从哪来**：裸 `renderOrder = 10/99` 谁都能写，加一个元素就得扫全仓；
 *      这里用语义带（`effect` / `decal` / …），带内偏移才允许。
 *   ③ **uniform 有声明**：参数表同时是「编辑器滑杆的来源」和「GLSL 里那行 uniform」，
 *      不再靠作者记得两边都写。
 *
 * 热改：`patchMaterialSource(mat, { frag })` 换源码并重编译（编辑器 GLSL 面板用）。
 * 只对层 B 有效——层 A 的注入体要重走 onBeforeCompile，得重编材质，不在这个函数里做。
 */

import * as THREE from 'three';
import { setQueue, type QueueName } from '../queue';
import { GLSL_TYPE, type ParamType, type ShaderModuleParam } from './module';
import { defaultParamValue, type ParamBus, type ParamValue } from './params';
import type { NoticeSink } from '../notice';

/** 引擎每帧写、材质只读的内建 uniform 槽 */
export type BuiltinSlot = 'time' | 'delta' | 'frame' | 'resolution' | 'camera';

const BUILTIN_UNIFORMS: Record<BuiltinSlot, readonly { id: string; type: ParamType }[]> = {
  time: [{ id: 'uTime', type: 'float' }],
  delta: [{ id: 'uDelta', type: 'float' }],
  frame: [{ id: 'uFrame', type: 'float' }],
  resolution: [{ id: 'uResolution', type: 'vec2' }],
  camera: [{ id: 'uCamPos', type: 'vec3' }, { id: 'uCamDir', type: 'vec3' }],
};

export type MaterialBlending = 'normal' | 'additive' | 'none';

const BLENDING: Record<MaterialBlending, THREE.Blending> = {
  normal: THREE.NormalBlending,
  additive: THREE.AdditiveBlending,
  none: THREE.NoBlending,
};

export interface MaterialSpec {
  /** 稳定 id（调试面板、notice、查找都靠它） */
  id: string;
  /** 材质名；默认 = id */
  name?: string;
  /** 语义队列带，默认 `effect`（凭空出现的几何） */
  queue?: QueueName;
  /** 带内偏移 0–99；同带内排前后用，别跨带抢号 */
  queueOffset?: number;
  blending?: MaterialBlending;
  depth?: { test?: boolean; write?: boolean };
  side?: THREE.Side;
  /** 默认跟随 blending（none → 不透明） */
  transparent?: boolean;
  /** 自动注入的内建 uniform（见 BUILTIN_UNIFORMS） */
  builtins?: readonly BuiltinSlot[];
  /**
   * 参数表。声明即生效：注入时自动生成 `uniform <type> <id>;`
   * （要自己写声明的设 `declare: false`）。
   */
  params?: readonly ShaderModuleParam[];
  /** 参数初值（只在总线里没有这个 id 时使用，避免覆盖别人已绑定的共享 uniform） */
  values?: Record<string, ParamValue>;
  /**
   * **每实例私有**的参数 id：照常自动声明 uniform，但不进总线、不共享。
   * 用在中层对象上——例如每条连线自己的 `uOpacity`，共享了就会「悬停一条，全部变淡」。
   */
  local?: readonly string[];
  /** 顶点着色器也要声明这些 uniform（顶点里用到 uTime 时打开） */
  declareInVertex?: boolean;
  vert: string;
  frag: string;
}

export interface DefineMaterialOptions {
  /** 参数总线：给了就能被 `stage.params.set()` / 效果时间线驱动 */
  params?: ParamBus;
  notices?: NoticeSink;
}

/** `material.userData.nijimi` 的形状（编辑器/调试读它，别读私有字段） */
export interface DefinedMaterialMeta {
  kind: 'defined-material';
  id: string;
  queue: QueueName;
  queueOffset: number;
  builtins: readonly BuiltinSlot[];
  /** 实际生成声明的参数（内建 + 参数表，已去重） */
  declared: readonly ShaderModuleParam[];
  params: readonly ShaderModuleParam[];
  source: { vert: string; frag: string };
}

/** 取层 B 材质的元信息（不是 defineMaterial 建的返回 null）。 */
export function definedMaterialMeta(mat: THREE.Material): DefinedMaterialMeta | null {
  const meta = (mat.userData as { nijimi?: DefinedMaterialMeta }).nijimi;
  return meta?.kind === 'defined-material' ? meta : null;
}

/** 内建槽 → 参数声明（顺序固定，重复的 id 只留一份） */
function builtinDeclarations(builtins: readonly BuiltinSlot[]): ShaderModuleParam[] {
  const out: ShaderModuleParam[] = [];
  const seen = new Set<string>();
  for (const slot of builtins) {
    for (const u of BUILTIN_UNIFORMS[slot]) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push({ id: u.id, type: u.type });
    }
  }
  return out;
}

function declarationBlock(params: readonly ShaderModuleParam[]): string {
  const lines = params
    .filter((p) => p.declare !== false)
    .map((p) => `uniform ${GLSL_TYPE[p.type]} ${p.id};`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function resolveUniforms(
  spec: MaterialSpec,
  ctx: DefineMaterialOptions,
): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {};
  const bus = ctx.params;
  const perInstance = new Set(spec.local ?? []);

  const bind = (id: string, type: ParamType, initial?: ParamValue) => {
    if (perInstance.has(id)) {
      uniforms[id] = { value: initial !== undefined ? initial : defaultParamValue(type) };
      return;
    }
    const shared = bus?.get(id);
    if (shared) {
      // 总线里已经有：用同一个对象，**不改它的初值**（可能是别人标定过的共享参数）
      uniforms[id] = shared;
      return;
    }
    const value = initial !== undefined ? initial : defaultParamValue(type);
    uniforms[id] = bus ? bus.adopt(id, { value }, type) : { value };
  };

  for (const slot of spec.builtins ?? []) {
    for (const u of BUILTIN_UNIFORMS[slot]) {
      if (bus?.get(u.id)) {
        uniforms[u.id] = bus.get(u.id)!;
      } else {
        uniforms[u.id] = { value: defaultParamValue(u.type) };
        ctx.notices?.warn(
          'material-builtin',
          `材质「${spec.id}」要内建参数 ${u.id}，但没有参数总线：它会停在 0。`
          + '把 stage.params 传给 defineMaterial。',
          { id: spec.id, detail: { uniform: u.id } },
        );
      }
    }
  }

  for (const p of spec.params ?? []) {
    bind(p.id, p.type, spec.values?.[p.id]);
  }
  // 只给初值、不参与声明的额外 uniform（手写 decls 时用）
  for (const [id, value] of Object.entries(spec.values ?? {})) {
    if (uniforms[id]) continue;
    const type: ParamType =
      typeof value === 'number' ? 'float'
        : value === null || (value as THREE.Texture)?.isTexture ? 'texture'
          : (value as THREE.Vector2)?.isVector2 ? 'vec2'
            : (value as THREE.Vector3)?.isVector3 ? 'vec3'
              : (value as THREE.Vector4)?.isVector4 ? 'vec4'
                : (value as THREE.Color)?.isColor ? 'color' : 'float';
    bind(id, type, value);
  }

  return uniforms;
}

/**
 * 声明式建材质。参数表 → uniform 声明 + 共享绑定；队列 → 语义带。
 * 返回的材质可以直接 `defineMesh(geom, spec)` 挂上去，也可以自己 new Mesh。
 */
export function defineMaterial(spec: MaterialSpec, ctx: DefineMaterialOptions = {}): THREE.ShaderMaterial {
  if (!spec.id) throw new Error('[shader] defineMaterial 需要 id');
  const blending = spec.blending ?? 'normal';
  // 声明区 = 内建槽 + 参数表（去重）。作者**不要**再手写这些 uniform，
  // 否则重复声明会让整个材质编译失败（层 B 最容易踩的一脚）。
  const seen = new Set<string>();
  const declared: ShaderModuleParam[] = [];
  for (const p of [...builtinDeclarations(spec.builtins ?? []), ...(spec.params ?? [])]) {
    if (seen.has(p.id) || p.declare === false) continue;
    seen.add(p.id);
    declared.push(p);
  }
  const frag = `${declarationBlock(declared)}${spec.frag}`;
  const vert = spec.declareInVertex ? `${declarationBlock(declared)}${spec.vert}` : spec.vert;

  const material = new THREE.ShaderMaterial({
    name: spec.name ?? spec.id,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: resolveUniforms(spec, ctx),
    transparent: spec.transparent ?? blending !== 'none',
    depthTest: spec.depth?.test ?? true,
    depthWrite: spec.depth?.write ?? blending === 'none',
    blending: BLENDING[blending],
    side: spec.side ?? THREE.FrontSide,
  });

  const meta: DefinedMaterialMeta = {
    kind: 'defined-material',
    id: spec.id,
    queue: spec.queue ?? 'effect',
    queueOffset: spec.queueOffset ?? 0,
    builtins: spec.builtins ?? [],
    params: spec.params ?? [],
    declared,
    source: { vert: spec.vert, frag: spec.frag },
  };
  (material.userData as { nijimi?: DefinedMaterialMeta }).nijimi = meta;

  return material;
}

/** 建材质 + 网格 + 队列一次到位（内容侧最常见的一步）。 */
export function defineMesh(
  geometry: THREE.BufferGeometry,
  spec: MaterialSpec,
  ctx: DefineMaterialOptions = {},
): THREE.Mesh {
  const material = defineMaterial(spec, ctx);
  const mesh = new THREE.Mesh(geometry, material);
  const meta = definedMaterialMeta(material)!;
  setQueue(mesh, meta.queue, meta.queueOffset);
  return mesh;
}

/**
 * 热改 GLSL 源码（编辑器面板 / HMR）。返回是否真的改了。
 *
 * 只对层 B 材质有效：`ShaderMaterial` 换源码 = 设 needsUpdate，three 会重编译。
 * 层 A 的注入体不在材质上，改它要重走 onBeforeCompile（需要重建材质）。
 */
export function patchMaterialSource(
  mat: THREE.Material,
  patch: { frag?: string; vert?: string },
): boolean {
  const meta = definedMaterialMeta(mat);
  if (!meta) {
    throw new Error('[shader] patchMaterialSource 只支持 defineMaterial 建的材质（层 B）');
  }
  const sm = mat as THREE.ShaderMaterial;
  let changed = false;
  if (typeof patch.frag === 'string' && patch.frag !== meta.source.frag) {
    meta.source.frag = patch.frag;
    sm.fragmentShader = `${declarationBlock(meta.declared)}${patch.frag}`;
    changed = true;
  }
  if (typeof patch.vert === 'string' && patch.vert !== meta.source.vert) {
    meta.source.vert = patch.vert;
    sm.vertexShader = /uTime|uDelta|uFrame|uResolution|uCamPos|uCamDir/.test(patch.vert)
      ? `${declarationBlock(meta.declared)}${patch.vert}`
      : patch.vert;
    changed = true;
  }
  if (changed) sm.needsUpdate = true;
  return changed;
}
