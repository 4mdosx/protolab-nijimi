/**
 * NPR 模块组 —— 一份「终末地式」表面着色模型，拆成可独立开关的七段。
 *
 * 顺序（也就是同一锚点内的 GLSL 拼接顺序）：
 *
 *   basis   世界法线 / 视线 / 主光 / 衰减度
 *   sdf     面部 SDF 驱动（可选，靠 NPR_HAS_FACE_SDF 定义）
 *   ramp    柔和明暗 + 直射光重组
 *   tint    冷暖撞色（保亮度）
 *   spec    视角高光
 *   rim     随相机边缘光
 *   debug   SDF 标定输出
 *   commit  总开关 + 写回 outgoingLight
 *
 * 拆分前这是一段 80 行的字符串常量。拆开之后：
 *   ① 每种手法有自己的参数声明，编辑器能自动生成滑杆（P2）；
 *   ② 内容侧可以「只加 rim、不要 tint」——把 tint 从这个数组里去掉即可，
 *      变体键跟着变，program 不会互相污染；
 *   ③ 升级 three 换 chunk 名时，只有 anchors.ts 要改。
 */

import { registerModules, type ShaderModule } from '../../module';
import { nprBasis } from './basis';
import { nprSdf } from './sdf';
import { nprRamp } from './ramp';
import { nprTint } from './tint';
import { nprSpec } from './spec';
import { nprRim } from './rim';
import { nprDebug } from './debug';
import { nprCommit } from './commit';

export { nprBasis, nprSdf, nprRamp, nprTint, nprSpec, nprRim, nprDebug, nprCommit };

/** 完整 NPR 表面（默认）。顺序敏感，别重排。 */
export const NPR_MODULES: readonly ShaderModule[] = [
  nprBasis,
  nprSdf,
  nprRamp,
  nprTint,
  nprSpec,
  nprRim,
  nprDebug,
  nprCommit,
];

/** 不带染色的极简组（A/B 用：只保留明暗与边缘光） */
export const NPR_MODULES_NO_TINT: readonly ShaderModule[] = [
  nprBasis,
  nprSdf,
  nprRamp,
  nprSpec,
  nprRim,
  nprDebug,
  nprCommit,
];

registerModules(NPR_MODULES);
