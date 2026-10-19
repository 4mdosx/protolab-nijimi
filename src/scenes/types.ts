/**
 * 场景内容包（ScenePack）—— **引擎与内容之间的唯一契约**。
 *
 * 分工（改这里之前先读这段）：
 *   引擎（src/stage.ts） 负责**渲染技术**：渲染器 / 后期（Bloom + 调色）/ IBL / NPR /
 *                        相机 rig / 视窗缩放平移 / 帧循环 / 角色加载。
 *   内容包（scenes/*.ts） 负责**场景里有什么**：几何、材质、灯位、锚点、内容动画。
 *
 * 这样切的意义：
 *   - 游戏侧要自建房间 / 关卡时，实现本接口就能被同一套舞台 + 编辑器消费，
 *     不需要动引擎一行代码（见 docs/职责边界.md「内容包迁移路径」）。
 *   - 引擎自带的示例包（scenes/workshop.ts）可以整体 fork 到内容侧自行演化。
 */

import type * as THREE from 'three';
import type { DepthPrepass } from '../depth-prepass';
import type { ParamBus } from '../shader/params';

export interface ScenePackContext {
  /** 引擎的场景对象（内容包直接 add 或返回 group，两种都行） */
  scene: THREE.Scene;
  /** 动画层步长（秒，= 1 / ANIM_FPS）——内容动画按它推进，别用真实帧 dt */
  animStep: number;
  /**
   * 深度预 pass（仅当舞台开了 `softParticles`）。内容包的粒子/烟幕要软淡出就把它
   * 交给 `applySoftParticles`（或 `new ElementParticles(..., { depth })`）。
   * 它是**场景渲染期**的深度，不是 `post.depthTexture`（后者场景渲完才有）。
   */
  depth?: DepthPrepass | null;
  /**
   * 参数总线（舞台的那一条）。内容侧要声明自己的效果参数、要标题能出现在编辑器
   * 滑杆里，就往这里 `declare`，别自己 new uniform——那样演出与编辑器都改不到它。
   */
  params?: ParamBus;
}

export interface ScenePackInstance<H = unknown> {
  group: THREE.Group;
  /** 内容句柄（锚点 / 灯位 / 可交互件），交给消费方 */
  handles: H;
  /**
   * 每帧更新（引擎已按动画层节流）。火光闪烁、粒子、机械动画都走这里——
   * 引擎不关心里面是什么。
   */
  update?(dt: number, elapsed: number): void;
}

export interface ScenePack<H = unknown> {
  readonly id: string;
  readonly cn: string;
  /**
   * 取景尺寸（米）：正交相机按「场景不超过视窗 62%」反推视锥。
   * 也就是内容告诉引擎「我有多大」，而不是引擎猜。
   */
  readonly span: { w: number; h: number };
  /** 相机注视点（省略则 (0, 0, 0)） */
  readonly focus?: [number, number, number];
  build(ctx: ScenePackContext): ScenePackInstance<H>;
}
