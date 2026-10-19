/**
 * npr-ramp —— 明暗台阶（柔和 ramp）+ 直射光重组。
 *
 * 只对「直射光」做风格化，环境/IBL 全额保留——对应拆解里「场景光源提供整体明暗
 * 与色彩氛围，角色光独立」的分工。若把环境光一起乘进 ramp，暗部会被二次压黑
 * （实测：整身发灰发闷）。
 *
 * PBR 轨道（金属/装甲）只 ramp 漫反射：GGX 高光是金属质感的本体，乘 ramp 会把
 * 高光带一起压没（实测：黄铜件整根发黑）。
 */

import type { ShaderModule } from '../../module';

export const nprRamp: ShaderModule = {
  id: 'npr-ramp',
  version: 1,
  doc: '柔和 ramp 收敛 + 直射光重组（PBR 轨道只收敛漫反射）',
  after: ['npr-sdf'],
  params: [
    { id: 'uNprRampLow', type: 'float', label: '暗部保留比例（0=全黑，1=不收敛）' },
    { id: 'uNprRampSoft', type: 'float', label: '明暗过渡带宽（0.02≈硬边，0.5≈几乎无阶跃）' },
    { id: 'uNprKeyColor', type: 'color', label: '主光颜色' },
    { id: 'uNprSdfOn', type: 'float', label: 'SDF 总开关（与 npr-sdf 共享）' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		// 默认：柔和 ramp（smoothstep 重写 NdotL 过渡，抹掉锐利半影分割）
		float nprDriver = smoothstep( 0.5 - uNprRampSoft, 0.5 + uNprRampSoft, dot( nprN, nprL ) * 0.5 + 0.5 );
		#ifdef NPR_HAS_FACE_SDF
		if ( uNprSdfOn > 0.5 ) nprDriver = nprSdfDriver;
		#endif

		float nprShade = mix( uNprRampLow, 1.0, nprDriver );

		vec3 nprIndirect = reflectedLight.indirectDiffuse + reflectedLight.indirectSpecular;
		#ifdef NPR_IS_PBR
			vec3 nprDirect = reflectedLight.directDiffuse * nprShade * uNprKeyColor + reflectedLight.directSpecular;
		#else
			vec3 nprDirect = ( reflectedLight.directDiffuse + reflectedLight.directSpecular ) * nprShade * uNprKeyColor;
		#endif

		// 自发光：face 的弱自发光随 SDF 明暗一起衰减（不然阴影区被自发光填平，
		// SDF 白烘）；其余轨道全额保留（glow 加法件「黑=不贡献」，不该被压）。
		#ifdef NPR_IS_FACE
			vec3 nprEmisTerm = totalEmissiveRadiance * mix( 0.35, 1.0, nprDriver );
		#else
			vec3 nprEmisTerm = totalEmissiveRadiance;
		#endif
		vec3 nprOut = nprIndirect + nprDirect + nprEmisTerm;
`,
  },
};
