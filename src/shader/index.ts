/**
 * 着色扩展层的公共出口。
 *
 * 三层扩展：
 *   A 注入   extendMaterial + ShaderModule（保住蒙皮/阴影/PBR）
 *   B 独立   defineMaterial / defineMesh（自己写 GLSL，引擎给时间/相机/队列）
 *   C 后期   （在 src/post.ts，见 PostChain.insert；成品 pass 在 src/post-passes.ts）
 *
 * 模块目录：`modules/npr/*` 是引擎内建的 NPR 表面；`modules/soft-particles.ts` 是
 * 需要场景深度的引擎模块；`modules/rim-pulse.ts`、`modules/dissolve.ts`、
 * `modules/ascii-flow.ts` 是内容侧示例（照抄写法即可，不用改引擎）。
 * 内容仓照抄后两者的写法即可，不需要改引擎。
 */

// 先登记「随引擎发布」的模块集合，再导出——导出顺序不影响，但读者能一眼看到
// 「引擎到底支持哪些 id」（见 builtins.ts 里的踩坑记录）。
import './builtins';

export * from './builtins';
export * from './anchors';
export * from './module';
export * from './material';
export * from './define';
export * from './params';
export * from './modules/npr';
export * from './modules/rim-pulse';
export * from './modules/dissolve';
export * from './modules/soft-particles';
export * from './modules/ascii-flow';
