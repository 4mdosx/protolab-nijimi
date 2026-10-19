/**
 * 关键帧时间线 → `EffectSpec`（内容侧工具，不是引擎能力）。
 *
 * 为什么要有这一层：`effects.ts` 把「一段演出」定义成**函数** `params(t)`，
 * 这对代码友好、对「改一个数字看看」极不友好——每调一次强度都要改源码、等热更、
 * 再看画面。这里把同一段演出换成**数据**（每轨若干关键帧），于是：
 *
 *   - 编辑器能画曲线、能拖点、能 scrub；
 *   - 拖完直接 `fromTimeline(show)` 得到可播的 spec，不需要重新加载；
 *   - 定稿后用 `serializeTimeline(show)` 导出一份**没有运行时依赖**的 TS 源码，
 *     贴回内容仓即可（导出结果只 import three 与 EffectSpec 类型）。
 *
 * 设计纪律（与 effects.ts 一致）：
 *   ① 纯数据：本文件不 import 引擎内部，`pipeline/` 的 Node 脚本可以 import 它；
 *   ② 只产 `params(t)`，不产 `material`（运行期不编译 shader）；
 *   ③ 曲线之外的东西（颜色常量、冲击波时序）显式列在 show 上，别藏进闭包。
 */

import * as THREE from 'three';
import type { EffectSpec } from '../effects';

export interface TimelineKey {
  /** 相位 0–1 */
  t: number;
  /** 参数值 */
  v: number;
}

export interface TimelineTrack {
  /** 目标参数名（ParamBus 的 id，例如 `uRimPulseStrength`） */
  id: string;
  /** 至少一个；调用方负责排序，`fromTimeline` 内部会再排一次 */
  keys: TimelineKey[];
  /** 段间插值，默认 smoothstep（两边都缓）。linear 用于「匀速推」的量 */
  ease?: 'smooth' | 'linear';
}

export interface TimelineShock {
  /** 起跑相位 */
  from: number;
  /** 结束相位 */
  to: number;
  strength?: number;
  width?: number;
  /** 十六进制，与颜色参数同色才像一次爆发 */
  color?: string;
}

export interface TimelineShow {
  id: string;
  /** 秒 */
  duration: number;
  loop?: boolean;
  onEnd?: 'restore' | 'keep';
  tracks: TimelineTrack[];
  /**
   * 曲线表达不了的常量（`color` 类型）：参数名 → 十六进制。
   * 不是偷懒——颜色的插值空间（线性 vs sRGB）是另一个话题，先当常量。
   */
  colors?: Record<string, string>;
  /** 可选的全屏冲击波（编辑器里可开关） */
  shock?: TimelineShock;
}

/** 返回**新数组**（不改入参），按 t 升序、同 t 保留后者 */
export function sortKeys(keys: readonly TimelineKey[]): TimelineKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * 采一个轨道的值。区间外**保持端值**（不是补 0）：
 * 演出常从「已经在某个状态」开始（例如溶解到一半接第二段），补 0 会闪一下。
 */
export function sampleTrack(track: TimelineTrack, t: number): number {
  const keys = track.keys;
  if (keys.length === 0) return 0;
  if (keys.length === 1) return keys[0].v;

  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;

  // 线性扫描：轨道一般 < 8 个点，二分反而更慢也更难读
  for (let i = 1; i < keys.length; i++) {
    const k1 = keys[i];
    if (t > k1.t) continue;
    const k0 = keys[i - 1];
    const span = k1.t - k0.t;
    const u = span <= 1e-6 ? 1 : (t - k0.t) / span;
    return k0.v + (k1.v - k0.v) * (track.ease === 'linear' ? u : smooth01(u));
  }
  return last.v;
}

/**
 * 相位 → 参数字典。`colors` 是调用方缓存的 `THREE.Color`（每帧 new 会制造垃圾，
 * 而这个函数每帧都被 effects.update 调一次）。
 */
export function evalTimeline(
  show: TimelineShow,
  t: number,
  colors?: Record<string, THREE.Color>,
): Record<string, number | THREE.Color> {
  const out: Record<string, number | THREE.Color> = {};
  for (const track of show.tracks) {
    if (!track.id) continue;
    out[track.id] = sampleTrack(track, t);
  }
  for (const [id, color] of Object.entries(colors ?? {})) out[id] = color;
  return out;
}

/** 颜色常量的缓存（`fromTimeline` 与编辑器共用一份口径） */
export function buildColors(show: TimelineShow): Record<string, THREE.Color> {
  const out: Record<string, THREE.Color> = {};
  for (const [id, hex] of Object.entries(show.colors ?? {})) out[id] = new THREE.Color(hex);
  return out;
}

/**
 * 数据 → 可播的 spec。**读的是 `show` 的引用**，所以改轨道后正在播的演出
 * 下一帧就跟上（不用重播）——这是编辑器「拖一下就变」的实现基础。
 */
export function fromTimeline(show: TimelineShow): EffectSpec {
  const colors = buildColors(show);
  return {
    id: show.id,
    duration: Math.max(0.001, show.duration),
    loop: show.loop,
    onEnd: show.onEnd ?? 'restore',
    params: (t) => evalTimeline(show, t, colors),
  };
}

function fmt(n: number): string {
  // 保留 4 位小数：导出的代码要能读，别出现 0.30000000000000004
  return String(Math.round(n * 10000) / 10000);
}

function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * 生成可直接落库的 TS 源码。刻意**不带运行时依赖**：只有 three（取颜色）
 * 与 `EffectSpec` 类型。生成结果里没有从本文件 import 的东西——否则把代码贴到
 * 内容仓还要连带搬一个工具文件，那就不叫「导出」了。
 */
export function serializeTimeline(show: TimelineShow, opts: { shock?: boolean } = {}): string {
  const L: string[] = [];
  const ease = new Map<string, 'smooth' | 'linear'>();
  for (const tr of show.tracks) ease.set(tr.id, tr.ease ?? 'smooth');

  L.push('/**');
  L.push(' * 由 effects 编辑器导出（editors/effects.html）。');
  L.push(' * 前提：材质侧已装好对应模块，见 createStage(el, { characterModules: [...] })。');
  L.push(' */');
  L.push('');
  L.push("import * as THREE from 'three';");
  L.push("import type { EffectSpec } from '../src/effects';");
  if (opts.shock && show.shock) L.push("import { createShockwavePass } from '../src/post-passes';");
  L.push('');
  L.push('const smooth01 = (x: number): number => {');
  L.push('  const t = Math.min(1, Math.max(0, x));');
  L.push('  return t * t * (3 - 2 * t);');
  L.push('};');
  L.push('');
  L.push('function sample(keys: [number, number][], t: number, ease: \'smooth\' | \'linear\'): number {');
  L.push('  if (keys.length === 0) return 0;');
  L.push('  if (t <= keys[0][0]) return keys[0][1];');
  L.push('  const last = keys[keys.length - 1];');
  L.push('  if (t >= last[0]) return last[1];');
  L.push('  for (let i = 1; i < keys.length; i++) {');
  L.push('    if (t > keys[i][0]) continue;');
  L.push('    const [t0, v0] = keys[i - 1];');
  L.push('    const [t1, v1] = keys[i];');
  L.push('    const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);');
  L.push('    return v0 + (v1 - v0) * (ease === \'linear\' ? u : smooth01(u));');
  L.push('  }');
  L.push('  return last[1];');
  L.push('}');
  L.push('');
  L.push('const KEYS: Record<string, [number, number][]> = {');
  for (const tr of show.tracks) {
    if (!tr.id) continue;
    const pairs = sortKeys(tr.keys).map((k) => `[${fmt(k.t)}, ${fmt(k.v)}]`).join(', ');
    L.push(`  ${tr.id}: [${pairs}],`);
  }
  L.push('};');
  L.push('');

  const colors = Object.entries(show.colors ?? {});
  if (colors.length) {
    L.push('// 颜色常量（曲线表达不了颜色；插值空间是另一个话题）');
    for (const [id, hex] of colors) L.push(`const ${id} = new THREE.Color(0x${hex.replace(/^#/, '')});`);
    L.push('');
  }

  L.push(`export function ${show.id.replace(/[^\w]/g, '_')}(): EffectSpec {`);
  L.push('  return {');
  L.push(`    id: ${q(show.id)},`);
  L.push(`    duration: ${fmt(show.duration)},`);
  if (show.loop) L.push('    loop: true,');
  L.push(`    onEnd: '${show.onEnd ?? 'restore'}',`);
  L.push('    params(t) {');
  L.push('      return {');
  for (const tr of show.tracks) {
    if (!tr.id) continue;
    L.push(`        ${tr.id}: sample(KEYS.${tr.id}, t, '${ease.get(tr.id)}'),`);
  }
  for (const [id] of colors) L.push(`        ${id},`);
  L.push('      };');
  L.push('    },');

  if (opts.shock && show.shock) {
    const s = show.shock;
    L.push('    post: {');
    L.push("      anchor: 'afterTonemap',");
    L.push('      priority: 10,');
    L.push("      reads: ['color'],");
    L.push('      params: { uStrength: 0 },');
    L.push(`      create: () => createShockwavePass({ color: 0x${(s.color ?? '9fd8ff').replace(/^#/, '')} }),`);
    L.push('    },');
    L.push('    onFrame(t, _ctx, api) {');
    const span = Math.max(1e-4, s.to - s.from);
    L.push(`      const p = smooth01((t - ${fmt(s.from)}) / ${fmt(span)});`);
    L.push(`      api.setPassParams({ uProgress: p, uStrength: p > 0 && p < 1 ? ${fmt(s.strength ?? 1.15)} : 0, uWidth: ${fmt(s.width ?? 0.055)} });`);
    L.push('    },');
  }

  L.push('  };');
  L.push('}');
  L.push('');
  return L.join('\n');
}
