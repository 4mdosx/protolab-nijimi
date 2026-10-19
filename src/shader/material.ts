/**
 * 材质扩展（层 A）—— 把 ShaderModule 注入 three 的内建材质。
 *
 * 为什么必须走 `onBeforeCompile` 而不是自己写 ShaderMaterial：
 * 只有这条路能白拿 three 的蒙皮 / morph / instancing / 阴影 / PBR 光照链。
 * 代价是它是私有协议（字符串替换），所以这里做三件补偿：
 *
 *   ① 锚点有名字（anchors.ts），缺了抛错；
 *   ② uniform 不 clone（ParamBus 给的是共享对象，改一次全场生效）；
 *   ③ 变体键 = 模块签名，同族材质共享一个 program（旧实现是随机串 → 每材质一个 program）。
 */

import * as THREE from 'three';
import {
  FRAG_ANCHORS,
  VERT_ANCHORS,
  injectAt,
  type FragAnchor,
  type VertAnchor,
} from './anchors';
import {
  GLSL_TYPE,
  orderModules,
  variantKey,
  type ShaderModule,
} from './module';
import type { ParamBus } from './params';
import { defaultParamValue } from './params';
import type { NoticeSink } from '../notice';

export interface ExtendMaterialOptions {
  /** 变体基名；默认取材质类型（如 `MeshStandardMaterial`） */
  base?: string;
  /** 参数总线：模块声明的 uniform 从这里取**共享对象** */
  params?: ParamBus;
  /** 材质级 uniform：优先级高于总线（每材质自己的贴图、开关） */
  extra?: Record<string, THREE.IUniform>;
  /** 追加到变体键的标签（轨道名等；不参与 GLSL） */
  tag?: string;
  notices?: NoticeSink;
}

interface Applied {
  key: string;
}

const applied = new WeakMap<THREE.Material, Applied>();

/**
 * 把模块声明的参数**提前**登记到总线。
 *
 * 为什么需要「提前」：内容侧通常在角色还没加载完时就开始写效果参数
 * （`stage.params.set('uRimPulseStrength', ...)`），而材质要到加载完成才注入。
 * 不提前登记的话，第一帧的写入会走「未声明」路径并报 param-undeclared。
 * 舞台启动时对 `characterModules` 调一次即可。
 */
export function declareModuleParams(
  bus: ParamBus,
  modules: readonly ShaderModule[],
): void {
  for (const m of modules) {
    for (const p of m.params ?? []) {
      if (!bus.has(p.id)) bus.declare(p.id, defaultParamValue(p.type), p.type);
    }
  }
}

/**
 * 给材质注入一组模块。返回变体键（调试/断言用）。
 * 幂等：同一材质重复注入同一组模块不会叠加 onBeforeCompile。
 */
export function extendMaterial(
  mat: THREE.Material,
  modules: readonly ShaderModule[],
  opts: ExtendMaterialOptions = {},
): string {
  const ordered = orderModules(modules);
  const base = opts.base ?? mat.type;

  const moduleDefines: Record<string, string> = {};
  for (const m of ordered) Object.assign(moduleDefines, m.defines ?? {});

  const defines: Record<string, string> = {
    ...(mat.defines as Record<string, string> | undefined ?? {}),
    ...moduleDefines,
  };
  const key = `${variantKey(base, ordered, defines)}${opts.tag ? `|${opts.tag}` : ''}`;

  const prev = applied.get(mat);
  if (prev) {
    if (prev.key !== key && opts.notices) {
      opts.notices.warn('module-missing', '材质已扩展过，重复注入被忽略（换模块请新建材质）。', {
        id: mat.name || base,
        detail: { applied: prev.key, requested: key },
      });
    }
    return prev.key;
  }
  applied.set(mat, { key });

  if (Object.keys(moduleDefines).length > 0) {
    mat.defines = { ...(mat.defines as Record<string, string> | undefined ?? {}), ...moduleDefines };
  }

  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile?.call(mat, shader, renderer);

    // ---- uniform：共享引用，不 clone ----
    const uniforms: Record<string, THREE.IUniform> = {};
    const declared = new Set<string>();
    for (const m of ordered) {
      for (const p of m.params ?? []) {
        if (!declared.has(p.id)) {
          const shared = opts.extra?.[p.id] ?? opts.params?.get(p.id);
          if (shared) {
            uniforms[p.id] = shared;
          } else if (opts.params) {
            // 有总线就登记进去：内容侧/编辑器按 id 能拿到同一个对象，写进去立刻生效
            uniforms[p.id] = opts.params.declare(p.id, defaultParamValue(p.type), p.type);
          } else {
            if (!p.optional && opts.notices) {
              opts.notices.warn(
                'module-missing',
                `模块「${m.id}」的参数「${p.id}」没有绑定，使用默认值。`,
                { id: p.id, detail: { module: m.id, material: mat.name } },
              );
            }
            uniforms[p.id] = { value: defaultParamValue(p.type) };
          }
          declared.add(p.id);
        }
      }
    }
    Object.assign(shader.uniforms, uniforms, opts.extra ?? {});

    // ---- 声明区：自动 uniform 声明 + 手写 decls ----
    // 顺序很重要：**uniform 先、手写 decls 后**。模块的 decls 里常常是辅助函数，
    // 而辅助函数会用到自己模块声明的 uniform（软粒子的 nprSoftViewDepth 就是这么写的）。
    // 反过来拼会在 GLSL 里报 "undeclared identifier"——这个坑是 P3 踩出来的。
    let fragDecls = '';
    let vertDecls = '';
    const emitted = new Set<string>();
    for (const m of ordered) {
      for (const p of m.params ?? []) {
        if (p.declare === false || emitted.has(p.id)) continue;
        emitted.add(p.id);
        const line = `uniform ${GLSL_TYPE[p.type]} ${p.id};`;
        fragDecls += `${line}\n`;
        vertDecls += `${line}\n`;
      }
    }
    for (const m of ordered) {
      if (m.decls?.frag) fragDecls += `${m.decls.frag}\n`;
      if (m.decls?.vert) vertDecls += `${m.decls.vert}\n`;
    }

    // ---- 按锚点分组：同一锚点内的模块共享作用域，顺序即拼接顺序 ----
    const fragGroups = new Map<FragAnchor, string>();
    for (const m of ordered) {
      if (!m.frag) continue;
      for (const [anchor, code] of Object.entries(m.frag) as [FragAnchor, string][]) {
        if (!code) continue;
        fragGroups.set(anchor, (fragGroups.get(anchor) ?? '') + code + '\n');
      }
    }
    const vertGroups = new Map<VertAnchor, string>();
    for (const m of ordered) {
      if (!m.vert) continue;
      for (const [anchor, code] of Object.entries(m.vert) as [VertAnchor, string][]) {
        if (!code) continue;
        vertGroups.set(anchor, (vertGroups.get(anchor) ?? '') + code + '\n');
      }
    }

    const ctx = (moduleId: string, anchor: string) => ({ moduleId, anchor, revision: THREE.REVISION });
    const label = ordered.map((m) => m.id).join('+');

    const applyFrag = (anchor: FragAnchor, code: string, moduleId: string) => {
      shader.fragmentShader = injectAt(shader.fragmentShader, FRAG_ANCHORS[anchor], code, ctx(moduleId, anchor));
    };
    const applyVert = (anchor: VertAnchor, code: string, moduleId: string) => {
      shader.vertexShader = injectAt(shader.vertexShader, VERT_ANCHORS[anchor], code, ctx(moduleId, anchor));
    };

    // common 单独处理：先注入模块的 common 代码，最后注入声明区——
    // injectAt 是「紧贴 chunk 插入」，后插的会被推到前面，于是 final 顺序 = decls → 模块 common。
    for (const [anchor, code] of fragGroups) if (anchor !== 'common') applyFrag(anchor, code, label);
    for (const [anchor, code] of vertGroups) if (anchor !== 'common') applyVert(anchor, code, label);
    if (fragGroups.has('common')) applyFrag('common', fragGroups.get('common')!, label);
    if (vertGroups.has('common')) applyVert('common', vertGroups.get('common')!, label);
    if (fragDecls) applyFrag('common', fragDecls, '<decls>');
    if (vertDecls) applyVert('common', vertDecls, '<decls>');
  };

  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return key;
}

/** 已注入的变体键（未注入返回 null）。调试/断言用。 */
export function variantOfMaterial(mat: THREE.Material): string | null {
  return applied.get(mat)?.key ?? null;
}

/**
 * 一次性把「模块 + 参数」装到一个材质上，返回材质本身（链式写法用）。
 * 语义上等于 `extendMaterial`，只是把「新建材质 → 注入」的样板收掉。
 */
export function withModules<T extends THREE.Material>(
  mat: T,
  modules: readonly ShaderModule[],
  opts?: ExtendMaterialOptions,
): T {
  extendMaterial(mat, modules, opts);
  return mat;
}
