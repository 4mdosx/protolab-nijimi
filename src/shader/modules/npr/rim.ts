/**
 * npr-rim —— 随相机边缘光（Fresnel 型）。
 *
 * [公开拆解] 「剧情过场中会根据场景色调应用不同颜色的边缘光，如红色或蓝色」。
 * 与 npr-spec 的区别：spec 读 NdotH（一小片亮斑），rim 读 NdotV（整圈轮廓）。
 */

import type { ShaderModule } from '../../module';

export const nprRim: ShaderModule = {
  id: 'npr-rim',
  version: 1,
  doc: '随相机边缘光（Fresnel）',
  after: ['npr-spec'],
  params: [
    { id: 'uNprRimColor', type: 'color', label: '边缘光颜色' },
    { id: 'uNprRimStrength', type: 'float', label: '边缘光强度' },
    { id: 'uNprRimPower', type: 'float', label: '边缘光宽度（越大越窄）' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		float nprFres = 1.0 - clamp( dot( nprN, nprV ), 0.0, 1.0 );
		float nprRim = pow( nprFres, max( uNprRimPower, 0.5 ) );
		nprOut += uNprRimColor * nprRim * uNprRimStrength;
`,
  },
};
