/**
 * soft-particles —— 软粒子：按「离场景几何多远」把粒子淡出（P3）。
 *
 * 为什么这是个**模块**而不是后处理：淡出要按像素做，但像素属于粒子自己
 * （alpha 乘在 `<opaque_fragment>` 之前），后处理拿到的已经是混合完的画面。
 * 所以它只能活在材质里——层 A 注入，`extendMaterial(mat, [softParticles])`。
 *
 * 深度从哪来：**不是** `post.depthTexture`（那是场景渲完才有的），而是
 * `src/depth-prepass.ts` 在主渲染之前渲出的一张独立深度图。四个深度相关 uniform
 * （`uSceneDepth` / `uDepthTexel` / `uNearFar` / `uOrtho`）由 `applySoftParticles`
 * 以 `extra` 绑进材质，不走参数总线——它们是**每帧变化的引擎状态**，不是可调参数。
 *
 * 唯一可调参数是 `uSoftDistance`（世界单位）：0 = 关（默认）。注入本身在 0 时
 * 只多一次分支判断，像素与不装这个模块一致。
 *
 * ⚠️ 只对**透明**材质有意义：不透明材质的 alpha 不参与混合，乘了也没人看。
 */

import { registerModule, type ShaderModule } from '../module';

export const softParticles: ShaderModule = {
  id: 'soft-particles',
  version: 1,
  doc: '软粒子 / 软贴面：按与场景几何的距离淡出（需要深度预 pass）',
  params: [
    { id: 'uSoftDistance', type: 'float', label: '软粒子过渡距离（0 = 关）' },
    // 四个深度槽由引擎的深度预 pass 提供。标记 optional：不绑也不该刷 notice，
    // 因为 uSoftDistance = 0 时它们根本不会被采样。
    { id: 'uSceneDepth', type: 'texture', optional: true, label: '场景深度（预 pass）' },
    { id: 'uDepthTexel', type: 'vec2', optional: true, label: '深度图 texel' },
    { id: 'uNearFar', type: 'vec2', optional: true, label: '相机近/远平面' },
    { id: 'uOrtho', type: 'float', optional: true, label: '正交相机（1 = 是）' },
  ],
  decls: {
    frag: /* glsl */ `
// 窗口深度 [0,1] → 到相机的距离（正数）。
// 不用 #include <packing>：那个 chunk 里有 GLSL3 的 modf()，GLSL ES 1.00 下编译不过。
float nprSoftViewDepth( float d ) {
	float near = uNearFar.x;
	float far = uNearFar.y;
	float v = uOrtho > 0.5
		? d * ( near - far ) - near
		: ( near * far ) / ( ( far - near ) * d - far );
	return -v;
}
`,
  },
  frag: {
    beforeOutput: /* glsl */ `
		if ( uSoftDistance > 0.0001 ) {
			// gl_FragCoord 是当前渲染目标的像素坐标；乘深度图的 texel 就是屏幕 uv。
			// 深度图可能是半分辨率，但归一化 uv 一致（两张图同宽高比）。
			vec2 nprSoftUv = gl_FragCoord.xy * uDepthTexel;
			float nprSoftScene = nprSoftViewDepth( texture2D( uSceneDepth, nprSoftUv ).x );
			float nprSoftSelf = nprSoftViewDepth( gl_FragCoord.z );
			// 粒子在几何**前面**时为正值 → 不淡；贴近表面时趋 0 → 淡出。
			// 粒子在几何后面时深度测试会整片剔掉，这里不需要处理。
			diffuseColor.a *= smoothstep( 0.0, uSoftDistance, nprSoftScene - nprSoftSelf );
		}
`,
  },
};

// 注册进全局表：契约（charter.shader.modules）与内容侧都按 id 引用
registerModule(softParticles);
