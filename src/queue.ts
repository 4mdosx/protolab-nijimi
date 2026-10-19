/**
 * 语义渲染队列 —— 替掉裸 `renderOrder = -1 / 1 / 2 / 9 / 10 / 11 / 99`。
 *
 * three 的排序键是 `renderOrder`（整数），谁都能写，于是「描边壳 -1」「网格线 1」
 * 「粒子 2」「骨骼 9」「关节 10」「高亮 11」「连线 99」共用同一个整数空间：
 * 加一个新元素就得先扫全仓看哪些号被占了，而且没人知道两个 10 谁先。
 *
 * 这里把整数空间切成**语义带**。带与带之间留 100 的间隔，带内用 offset（0–99）
 * 保留「同一类里我还要排前后」的需求（比如契约资产的透明层序 layer）。
 *
 *   outline  -100  反向壳：必须最先画，否则外扩的背面会被深度挡住
 *   opaque      0  不透明主体（默认，不设 renderOrder 也是它）
 *   decal     100  贴在别的表面上的薄面（发影、目影、贴花）：透明、depthWrite=false
 *   effect    300  凭空出现的几何（连线、法阵、冲击波、拖尾）
 *   overlay   800  调试叠层（骨骼线、关节点、坐标轴）
 *   screen    900  屏幕空间 UI / 全屏标记
 *
 * 注意：队列只决定**绘制顺序**，不决定深度与混合。透明件仍然要自己设
 * `transparent` / `depthWrite`（见 charter.ts 的透明层处理）。
 */

import type * as THREE from 'three';

export const QUEUE = {
  outline: -100,
  opaque: 0,
  decal: 100,
  effect: 300,
  overlay: 800,
  screen: 900,
} as const;

export type QueueName = keyof typeof QUEUE;

/** 带内可用偏移上限。超过就夹住并发 notice（需要更多层级说明带切错了）。 */
const BAND = 100;

const ORDER = (Object.keys(QUEUE) as QueueName[]).sort((a, b) => QUEUE[a] - QUEUE[b]);

export function setQueue(object: THREE.Object3D, name: QueueName, offset = 0): void {
  object.renderOrder = QUEUE[name] + Math.max(0, Math.min(BAND - 1, Math.floor(offset)));
}

/** 反查一个 renderOrder 落在哪个语义带（调试/编辑器显示用）。 */
export function queueOf(object: THREE.Object3D): QueueName | null {
  const v = object.renderOrder;
  let hit: QueueName | null = null;
  for (const name of ORDER) {
    if (v >= QUEUE[name]) hit = name;
  }
  return hit;
}

export function queueRange(name: QueueName): { min: number; max: number } {
  return { min: QUEUE[name], max: QUEUE[name] + BAND - 1 };
}
