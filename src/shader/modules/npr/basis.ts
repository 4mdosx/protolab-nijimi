/**
 * npr-basis —— NPR 表面基向量。
 *
 * 世界法线 / 视线 / 主光方向 / 光照衰减度：后面每个 NPR 模块都读这四个量。
 * 单独成模块的理由：它们与「怎么用」无关，换 shading model（ramp/toon/分层）
 * 时这一段不变；也让 rim / spec 等模块不必各自重算一遍。
 */

import type { ShaderModule } from '../../module';

export const nprBasis: ShaderModule = {
  id: 'npr-basis',
  version: 1,
  doc: '世界法线 / 视线 / 主光方向 / 光照衰减（NPR 各模块的公共输入）',
  params: [
    { id: 'uNprCamPos', type: 'vec3', label: '相机世界坐标（每帧写）' },
    { id: 'uNprKeyDir', type: 'vec3', label: '主光方向（表面→光源）' },
  ],
  vert: {
    common: /* glsl */ `
varying vec3 vNprWNormal;
varying vec3 vNprWPos;
varying vec3 vNprFwd;
varying vec3 vNprLeft;
// 自建 UV varying：r152 起 three 只在 USE_UV / USE_ANISOTROPY 下声明 vUv，
// 而 r186 的 WebGLProgram 从不定义 USE_UV（USE_MAP 只给 vMapUv）——直接引用
// vUv 会「未声明标识符」编译失败，把整个注入体连同调试分支一起废掉。
varying vec2 vNprUv;
`,
    worldpos: /* glsl */ `
	vNprWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vNprWNormal = normalize( mat3( modelMatrix ) * objectNormal );
	vNprFwd = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, -1.0 ) );
	vNprLeft = normalize( mat3( modelMatrix ) * vec3( -1.0, 0.0, 0.0 ) );
	vNprUv = uv;
`,
  },
  frag: {
    common: /* glsl */ `
varying vec3 vNprWNormal;
varying vec3 vNprWPos;
varying vec3 vNprFwd;
varying vec3 vNprLeft;
varying vec2 vNprUv;
`,
    beforeOutput: /* glsl */ `
		vec3 nprN = normalize( vNprWNormal );
		vec3 nprV = normalize( uNprCamPos - vNprWPos );
		vec3 nprL = normalize( uNprKeyDir );
		// lightAtten = 光从正面(0)到背面(1)的水平进度，脸部 SDF 用它挑阈值
		float nprAtten = 1.0 - ( dot( nprL, normalize( vNprFwd ) ) * 0.5 + 0.5 );
`,
  },
};
