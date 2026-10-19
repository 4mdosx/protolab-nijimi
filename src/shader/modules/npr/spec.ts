/**
 * npr-spec —— 视角高光：高光方向 = 主光方向与相机方向的混合。
 *
 * [公开拆解] 「服装和头发的高光方向会始终跟随摄像机视角，如同一个虚拟补光灯」。
 * 这一条是终末地/少前 2 的头发看起来「有体积」而不是「有油光」的主因。
 */

import type { ShaderModule } from '../../module';

export const nprSpec: ShaderModule = {
  id: 'npr-spec',
  version: 1,
  doc: '视角高光（方向随相机）',
  after: ['npr-tint'],
  params: [
    { id: 'uNprSpecViewMix', type: 'float', label: '高光方向混入相机朝向的比例' },
    { id: 'uNprSpecStrength', type: 'float', label: '高光强度' },
    { id: 'uNprSpecPower', type: 'float', label: '高光锐度' },
    { id: 'uNprSpecColor', type: 'color', label: '高光颜色' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		vec3 nprH = normalize( mix( nprL, nprV, uNprSpecViewMix ) );
		float nprSpec = pow( clamp( dot( nprN, nprH ), 0.0, 1.0 ), max( uNprSpecPower, 1.0 ) );
		nprOut += uNprSpecColor * nprSpec * uNprSpecStrength;
`,
  },
};
