/**
 * 着色模块（ShaderModule）—— 纯数据的 GLSL 片段 + 元信息（文档 §3.2 / §3.5(2)）。
 *
 * **本文件不 import three**，也不闭包捕获任何材质。理由很实际：
 * `pipeline/` 的 Node 脚本要能直接 import 这张表，在**资产转换期**就校验
 * 「这个模型声明的模块是否存在」——GLSL 没有编译期，这是能补上的最有价值的一环。
 *
 * 模块的组成：
 *   frag / vert     锚点 → GLSL 片段。同一锚点内按模块顺序拼接，**共享同一个作用域**，
 *                   所以后一个模块可以直接用前一个声明的局部变量（见 §3.4 的族 2 设计）。
 *   params          参数声明。注入时由 ParamBus 解析成共享 uniform，并自动生成
 *                   `uniform <type> <id>;`（`declare:false` 时自己写在 decls 里）。
 *   decls           手写声明区（`#ifdef` 包起来的 sampler、辅助函数等）。
 *   defines         变体宏（会合并进材质 defines，并参与变体键）。
 *   after           顺序依赖：这些模块必须排在我前面。同锚点共享作用域时用它表达「我读你的变量」。
 *   doc             一句话说明，给编辑器和报错文案用。
 */

import type { FragAnchor, VertAnchor } from './anchors';

export type ParamType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'texture';

export interface ShaderModuleParam {
  /** uniform 名，也是 ParamBus 的键 */
  id: string;
  type: ParamType;
  /** 是否自动生成 `uniform ...` 声明；默认 true。sampler 需要 #ifdef 时设为 false */
  declare?: boolean;
  /**
   * 允许总线里没有绑定：注入时用类型默认值，**不发 notice**。
   * 用于「有就绑、没有就是空纹理」的可选槽（如 SDF 贴图）。
   */
  optional?: boolean;
  /** 注释（编辑器滑杆的 tooltip） */
  label?: string;
}

export interface ShaderModule {
  readonly id: string;
  readonly version: number;
  readonly frag?: Partial<Record<FragAnchor, string>>;
  readonly vert?: Partial<Record<VertAnchor, string>>;
  readonly params?: readonly ShaderModuleParam[];
  readonly decls?: { readonly frag?: string; readonly vert?: string };
  readonly defines?: Readonly<Record<string, string>>;
  /** 顺序依赖：这些模块必须排在我前面 */
  readonly after?: readonly string[];
  /** 顺序依赖：这些模块必须排在我后面（用于「插在 commit 之前」这类约束） */
  readonly before?: readonly string[];
  readonly doc?: string;
}

/** GLSL 类型（`color` 在 GLSL 侧就是 vec3，值由 three 的 Color 上传） */
export const GLSL_TYPE: Record<ParamType, string> = {
  float: 'float',
  vec2: 'vec2',
  vec3: 'vec3',
  vec4: 'vec4',
  color: 'vec3',
  texture: 'sampler2D',
};

/**
 * 稳定拓扑排序：尊重 `after` / `before`，其余保持**输入顺序**。
 * 输入顺序是作者写的顺序，也是同一锚点内代码的拼接顺序——不能被排序打乱。
 *
 * 按 id **去重（先到先得）**：资产契约声明的模块与代码侧传的 `modules` 会合并，
 * 两边都写了 `dissolve` 是正常情况（资产说「我有这个能力」，代码说「这次演出要用」）。
 * 不去重的话同一段 GLSL 会被拼两遍、uniform 声明两次，整个材质编译失败。
 *
 * 用 Kahn + 「就绪集合里取输入序最靠前的」：结果确定、可复现，
 * 也让「内容侧临时插一个模块」不会悄悄改变既有模块之间的相对顺序。
 */
export function orderModules(modules: readonly ShaderModule[]): ShaderModule[] {
  const unique: ShaderModule[] = [];
  const seenIds = new Set<string>();
  for (const m of modules) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    unique.push(m);
  }
  if (unique.length < 2) return unique;
  const byId = new Map(unique.map((m) => [m.id, m]));
  const index = new Map(unique.map((m, i) => [m.id, i]));
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const m of unique) {
    indegree.set(m.id, 0);
    edges.set(m.id, []);
  }
  const edge = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    edges.get(from)!.push(to);
    indegree.set(to, indegree.get(to)! + 1);
  };
  for (const m of unique) {
    for (const dep of m.after ?? []) edge(dep, m.id);
    for (const dep of m.before ?? []) edge(m.id, dep);
  }

  const ready = unique.filter((m) => indegree.get(m.id) === 0).map((m) => m.id);
  const out: ShaderModule[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => index.get(a)! - index.get(b)!);
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const to of edges.get(id)!) {
      const d = indegree.get(to)! - 1;
      indegree.set(to, d);
      if (d === 0) ready.push(to);
    }
  }
  if (out.length !== unique.length) {
    throw new Error(`[shader] 模块顺序依赖成环：${unique.map((m) => m.id).join(', ')}`);
  }
  return out;
}

/**
 * 变体键 = 基材 + 模块签名（**顺序敏感**：顺序决定 GLSL 拼接顺序）+ defines。
 *
 * 之前这里是 `npr:${Math.random()}`——等于宣布「所有材质都不同」，
 * 30 个角色材质 → 30 次编译。改完之后 `renderer.info.programs.length`
 * 应该约等于变体数，而不是材质数。
 */
export function variantKey(
  base: string,
  modules: readonly ShaderModule[],
  defines: Readonly<Record<string, string>> = {},
): string {
  const mods = modules.map((m) => `${m.id}@${m.version}`).join('+');
  const defs = Object.keys(defines).sort().map((k) => `${k}=${defines[k]}`).join(',');
  return `v3|${base}|${mods}|${defs}`;
}

/* ------------------------------------------------------------------ *
 * 注册表：内容侧按 id 引用，转换期按 id 校验
 * ------------------------------------------------------------------ */

const registry = new Map<string, ShaderModule>();

export function registerModule(module: ShaderModule): ShaderModule {
  const prev = registry.get(module.id);
  if (prev && prev.version > module.version) return prev;
  registry.set(module.id, module);
  return module;
}

export function registerModules(modules: readonly ShaderModule[]): void {
  for (const m of modules) registerModule(m);
}

export function getModule(id: string): ShaderModule | undefined {
  // 支持 `id@version` 写法（契约里的模块引用就是这么写的）
  const [name] = id.split('@');
  return registry.get(name);
}

export function listModules(): readonly ShaderModule[] {
  return [...registry.values()];
}

/**
 * 按 id 列表解析模块。缺失的 **不抛**——收集成 `missing` 交给调用方降级并出声
 * （沿用 exp-contract 的「缺失 = 降级 + 说出来」）。
 */
export function resolveModules(ids: readonly string[]): { modules: ShaderModule[]; missing: string[] } {
  const modules: ShaderModule[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const m = getModule(id);
    if (m) modules.push(m);
    else missing.push(id);
  }
  return { modules, missing };
}
