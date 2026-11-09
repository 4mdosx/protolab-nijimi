/**
 * nijimi（滲み）—— 字面是「墨在纸上洇开」。轻量级 WebGL diorama 渲染引擎。
 *
 * 消费方（游戏侧）从这里取一切渲染能力：
 *
 *   import { createStage, workshopScene } from 'nijimi';
 *   const stage = createStage(container, { pack: workshopScene });
 *   stage.render(dt, elapsed);
 *
 * 三层结构：
 *   ① 技术层  charter / npr / materials / textures / particles / post / depth-prepass / stage
 *           扩展层  shader（模块 + 参数总线）、frame（三时钟）、queue（语义队列）、notice
 *   ② 角色层  character / rig / anim（契约化资产 + 骨骼槽位 + 外部动画）
 *   ③ 内容层  kits/*（可复用构件）、scenes/*（内容包，含示例场景）
 *
 * 引擎不认识任何游戏概念；反过来，游戏也不需要认识 three.js 与任何着色细节。
 * 职责边界与迁移路径见 docs/职责边界.md。
 */

/* ① 技术层 */
export * from './charter';
export * from './npr';
export * from './materials';
export * from './textures';
export * from './particles';
export * from './post';
export * from './depth-prepass';
export * from './soft-particles';
export * from './post-passes';
export * from './output-passes';
export * from './effects';
export * from './stage';

/* ①b 扩展层（着色模块 / 参数总线 / 帧上下文 / 语义队列 / 提示） */
export * from './shader';
export * from './frame';
export * from './queue';
export * from './notice';

/* ② 角色层 */
export * from './character';
export * from './character-rendering';
export * from './rig';
export * from './anim';
export * from './performance';
export * from './expression';
// 表情/指令的对外契约（FROZEN）与 witch.exp/1 指令流
export * from './exp-contract';
export * from './exp-protocol';

/* ③ 内容层（构件 + 内容包契约 + 自带示例场景） */
export * from './kits/industrial';
export * from './kits/shows';
export * from './kits/conduits';
export * from './scenes/types';
export * from './scenes/workshop';

/**
 * three.js 命名空间再导出 —— 内容侧（游戏）拼几何 / 材质 / 向量时统一从这里取：
 *
 *   import { THREE } from 'nijimi';
 *   const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
 *
 * 这样游戏仓**不必依赖 three**——渲染栈只由引擎一处引入（版本单点，
 * 升级 three 不用通知任何一个消费方）。游戏侧仍然可以直接 author 内容几何，
 * 因为「场景里长什么样」本来就属于内容职责（见 scenes/types.ts）。
 */
export * as THREE from 'three';

/* 舞台视觉预设：无 Three.js 依赖的数据契约 */
export * from './visual-preset';
