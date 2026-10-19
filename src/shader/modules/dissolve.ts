/**
 * dissolve —— 溶解 / 元素化（内容侧第二个示范模块，配合 `kits/shows.ts` 的充能演出）。
 *
 * 手法：世界坐标 3D 噪声当阈值场，`uDissolve` 从 0 推到 1 时逐块 discard；
 * 阈值边缘再叠一圈自发光，看起来像「被烧掉」而不是「被裁掉」。
 *
 * 为什么不贴图：噪声贴图要 UV，而角色各部位的 UV 密度不同（脸/发/布差一个数量级），
 * 同一张图在不同部位会显出拉伸。世界坐标噪声对整身是连续的，且不需要资产侧准备。
 *
 * 依赖：`vNprWPos`（npr-basis）与 `nprOut`（npr-ramp）——所以 `after: npr-ramp`，
 * 并且必须排在 `npr-commit` 之前（commit 会把 nprOut 写回 outgoingLight）。
 *
 * `uDissolve = 0` 时**不执行 discard、不加光**：像素与不装这个模块完全一致（P1/P2 验收项）。
 */

import { registerModule, type ShaderModule } from '../module';

export const dissolve: ShaderModule = {
  id: 'dissolve',
  version: 1,
  doc: '溶解 / 元素化（世界坐标噪声阈值 + 边缘自发光）',
  after: ['npr-ramp'],
  before: ['npr-commit'],
  params: [
    { id: 'uDissolve', type: 'float', label: '溶解进度（0 = 完好，1 = 全消）' },
    { id: 'uDissolveEdge', type: 'float', label: '边缘宽度（阈值带的软硬）' },
    { id: 'uDissolveScale', type: 'float', label: '噪声频率（世界单位倒数）' },
    { id: 'uDissolveColor', type: 'color', label: '边缘发光颜色' },
    { id: 'uDissolveGlow', type: 'float', label: '边缘发光强度' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		if ( uDissolve > 0.0005 ) {
			float nprDissolveN = nprDissolveNoise( vNprWPos * max( uDissolveScale, 0.001 ) );
			if ( nprDissolveN < uDissolve ) discard;
			float nprDissolveEdge = 1.0 - smoothstep(
				uDissolve,
				uDissolve + max( uDissolveEdge, 0.001 ),
				nprDissolveN
			);
			nprOut += uDissolveColor * nprDissolveEdge * uDissolveGlow;
		}
`,
  },
  // 噪声函数只在这里定义一次；同一锚点的模块共享作用域，所以放 common。
  // 名字带 npr 前缀：避免和 three 的 chunk 或内容侧其它模块撞名。
  decls: {
    frag: /* glsl */ `
float nprDissolveHash( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float nprDissolveNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix(
			mix( nprDissolveHash( i + vec3( 0.0, 0.0, 0.0 ) ), nprDissolveHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
			mix( nprDissolveHash( i + vec3( 0.0, 1.0, 0.0 ) ), nprDissolveHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ),
			f.y
		),
		mix(
			mix( nprDissolveHash( i + vec3( 0.0, 0.0, 1.0 ) ), nprDissolveHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
			mix( nprDissolveHash( i + vec3( 0.0, 1.0, 1.0 ) ), nprDissolveHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ),
			f.y
		),
		f.z
	);
}
`,
  },
};

// 注册进全局表：契约（charter.shader.modules）与内容侧都按 id 引用，转换期也靠这张表校验
registerModule(dissolve);
