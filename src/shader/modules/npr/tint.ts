/**
 * npr-tint —— 冷暖撞色：暗部往冷端偏、亮部往暖端偏。
 *
 * 关键约束：**保亮度**。直接乘色会顺手把画面压暗，观感像「加了一层滤镜」；
 * 这里把结果按亮度比例拉回去，只改色相/饱和度。
 */

import type { ShaderModule } from '../../module';

export const nprTint: ShaderModule = {
  id: 'npr-tint',
  version: 1,
  doc: '冷暖分离染色（保亮度）',
  after: ['npr-ramp'],
  params: [
    { id: 'uNprShadowTint', type: 'color', label: '暗部染色（冷端）' },
    { id: 'uNprLightTint', type: 'color', label: '亮部染色（暖端）' },
    { id: 'uNprTintStrength', type: 'float', label: '撞色强度' },
  ],
  frag: {
    common: /* glsl */ `
// 保亮度的染色：只偏移色相 / 饱和度，不改变明度
vec3 nprTintKeepLuma( vec3 c, vec3 tint ) {
	float l0 = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 t = c * tint;
	float l1 = max( dot( t, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
	return t * ( l0 / l1 );
}
`,
    beforeOutput: /* glsl */ `
		vec3 nprTint = mix( uNprShadowTint, uNprLightTint, nprDriver );
		vec3 nprTinted = nprTintKeepLuma( nprOut, nprTint );
		nprOut = mix( nprOut, nprTinted, uNprTintStrength );
`,
  },
};
