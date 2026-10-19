/**
 * npr-sdf —— 面部 SDF 阴影响应（终末地脸部专项）。
 *
 * R/G = 左右半球的阴影阈值场（美术烘的「光到哪个角度这块开始变暗」），
 * A = 鼻尖 mask（黑 = 鼻尖）。输出 `nprSdfDriver`，由 npr-ramp 决定是否采用。
 *
 * 只在材质定义了 `NPR_HAS_FACE_SDF` 时才编译采样分支——没有贴图的材质
 * 留一个未绑定的 sampler 会让整个着色分支失效（2026-10-16 实测）。
 */

import type { ShaderModule } from '../../module';

export const nprSdf: ShaderModule = {
  id: 'npr-sdf',
  version: 1,
  doc: '面部 SDF 明暗驱动（R/G 半球阈值场，A 鼻尖 mask）',
  after: ['npr-basis'],
  params: [
    { id: 'uNprSdfOn', type: 'float', label: 'SDF 总开关（只有 face 材质置 1）' },
    // sampler 的声明要在 #ifdef 里，不能自动生成，所以自己写在 decls.frag
    { id: 'uNprSdfMap', type: 'texture', declare: false, optional: true, label: 'SDF 阈值场' },
  ],
  frag: {
    common: /* glsl */ `
#ifdef NPR_HAS_FACE_SDF
uniform sampler2D uNprSdfMap;
#endif
`,
    beforeOutput: /* glsl */ `
		float nprThr = 0.0;
		float nprSdfDriver = 0.0;
		#ifdef NPR_HAS_FACE_SDF
		// 注意：这里不做 uNprSdfDebug 门控——调试模式也要把 nprDriver 算成 SDF 驱动，
		// 否则 dbg=2（最终明暗）显示的是默认 ramp 驱动，标定时会自欺。
		if ( uNprSdfOn > 0.5 ) {
			vec4 nprSdf = texture2D( uNprSdfMap, vNprUv );
			float nprSide = dot( nprL, normalize( vNprLeft ) );
			nprThr = nprSide > 0.0 ? nprSdf.r : nprSdf.g;
			float nprE0 = max( 2.0 * nprAtten - 1.0, 0.0 );
			float nprE1 = min( 2.0 * nprAtten, 1.0 );
			float nprLit = smoothstep( nprE0, nprE1, nprThr );
			float nprNose = ( 1.0 - nprSdf.a ) * smoothstep( 0.45, 0.75, nprAtten );
			nprSdfDriver = nprLit * ( 1.0 - nprNose * 0.55 );
		}
		#endif
`,
  },
};
