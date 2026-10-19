/**
 * ascii-flow —— 把模型表面变成**流动的 ASCII 字符**（内容侧第三个示范模块）。
 *
 * 和 dissolve 一样属于层 A：注入内建材质，所以蒙皮 / 阴影 / NPR 光照全都在，
 * 只是在最后一步把像素换成「格子里的一个字形」。
 *
 * 三个决定，值得先讲清楚：
 *
 * ① **格子按屏幕空间切**（`gl_FragCoord`），不是按 UV。
 *    按 UV 切的话，脸和衣服的 UV 密度差一个数量级，同一套参数在脸上是 3 个字、
 *    在袖子上是 300 个字。屏幕空间切和显示器分辨率无关（用 `uResolution` 归一化），
 *    缩放到什么尺寸都是「一行 54 个字符」。
 *
 * ② **字形是程序化的，不用贴图**。
 *    图集贴图要资产侧准备、要绑 sampler、要处理 mipmap 与 sRGB——而且一旦没绑上，
 *    画面会静默变成一片空白。十种字形（. - | / \ o + * # █）用距离场写死在这里，
 *    模块保持纯数据，Node 侧的契约校验脚本能直接 import 它（等同 dissolve 的理由）。
 *
 * ③ **字符由「亮度分级 + 随机」共同决定**。
 *    纯随机 = 电视雪花；纯亮度 = 死板的阶调。默认 `uAsciiScatter = 0.85`，
 *    每列有自己的相位（`cid.y * 0.37`），看起来就是字符在往下流。
 *
 * `uAscii = 0` 时整段不执行：**逐像素等价于不装这个模块**（验收项，与 rim-pulse 同）。
 *
 * 锚点用 `afterOutput`（dithering 之后）：此时 `gl_FragColor` 是最终像素，
 * 改它不会影响光照链、也不会被雾或色调映射二次加工。
 */

import { registerModule, type ShaderModule } from '../module';

export const asciiFlow: ShaderModule = {
  id: 'ascii-flow',
  version: 1,
  doc: '屏幕空间 ASCII 字符化 + 字符流（模型表面，字形程序化生成）',
  params: [
    { id: 'uAscii', type: 'float', label: 'ASCII 强度（0 = 关）' },
    { id: 'uAsciiRows', type: 'float', label: '竖排行数（越多字越小）' },
    { id: 'uAsciiSpeed', type: 'float', label: '流动速度' },
    { id: 'uAsciiScatter', type: 'float', label: '字符随机度（0 = 只按亮度）' },
    { id: 'uAsciiContrast', type: 'float', label: '亮度增益' },
    { id: 'uAsciiThreshold', type: 'float', label: '出字门槛（暗部不出字）' },
    { id: 'uAsciiFill', type: 'float', label: '空隙保留原色（0 = 纯黑底）' },
    { id: 'uAsciiTint', type: 'float', label: '字符随亮度变化（0 = 纯色）' },
    { id: 'uAsciiBand', type: 'float', label: '横向亮带' },
    { id: 'uAsciiColor', type: 'color', label: '字符颜色' },
    // uResolution / uTime 是 ParamBus 的内建参数：这里声明是为了自动生成
    // uniform 声明，值由引擎每帧写进同一个共享对象（不会覆盖、不会重复声明）。
    { id: 'uResolution', type: 'vec2' },
    { id: 'uTime', type: 'float' },
  ],
  frag: {
    afterOutput: /* glsl */ `
		if ( uAscii > 0.0005 ) {
			// ---- 屏幕空间格子：行数固定，列数按宽高比补足 → 格子始终是正方形 ----
			float nprAsciiAspect = uResolution.x / max( uResolution.y, 1.0 );
			float nprAsciiRows = max( uAsciiRows, 4.0 );
			vec2 nprAsciiCells = vec2( nprAsciiRows * nprAsciiAspect, nprAsciiRows );
			vec2 nprAsciiGp = gl_FragCoord.xy / max( uResolution, vec2( 1.0 ) ) * nprAsciiCells;
			vec2 nprAsciiCid = floor( nprAsciiGp );
			vec2 nprAsciiUv = fract( nprAsciiGp );
			nprAsciiUv.y = 1.0 - nprAsciiUv.y;

			// ---- 亮度 → 字符密度 ----
			// gl_FragColor 还是线性空间（色调映射在后面的 post 链里），
			// 直接取亮度会偏暗，pow 0.6 把它拉回「看起来对」的区间。
			float nprAsciiLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
			float nprAsciiV = pow( clamp( nprAsciiLum * uAsciiContrast, 0.0, 1.0 ), 0.6 );
			// 门槛：低于它的格子不出字，模型暗部因此保留一点形体（而不是整片黑）
			nprAsciiV *= smoothstep( uAsciiThreshold, uAsciiThreshold + 0.09, nprAsciiV );

			// ---- 流动：每列独立相位，字符沿 y 方向逐格替换 ----
			// flow 连续递减，floor 每过 1 就换一次 hash → 字符「跳格」；
			// cid.y * 0.37 让上下行的相位错开，于是看起来是往下流而不是整片闪。
			float nprAsciiT = uTime * uAsciiSpeed;
			float nprAsciiFlow = nprAsciiCid.y * 0.37 - nprAsciiT
				+ nprAsciiHash( vec2( nprAsciiCid.x, 3.1 ) ) * 24.0;
			float nprAsciiFlick = nprAsciiHash( vec2( nprAsciiCid.x * 1.7, floor( nprAsciiFlow ) ) );

			// ---- 字形：亮度分级打底，随机替换（scatter 越大越像雨） ----
			float nprAsciiLevel = floor( nprAsciiV * 9.0 );
			float nprAsciiPick = mix( nprAsciiLevel, nprAsciiFlick * 10.0, clamp( uAsciiScatter, 0.0, 1.0 ) );

			// ---- 横向亮带：让「流动」有方向感，而不只是闪烁 ----
			float nprAsciiBand = 0.5 + 0.5 * sin( nprAsciiCid.y * 0.18 - nprAsciiT * 2.0 );
			nprAsciiV *= mix( 1.0, 0.35 + 0.9 * nprAsciiBand, clamp( uAsciiBand, 0.0, 1.0 ) );

			float nprAsciiGlyph = nprAsciiGlyph( nprAsciiUv, nprAsciiPick );

			// ---- 合成：字符 = 主色（可按亮度明暗）；空隙 = 残影 ----
			vec3 nprAsciiInk = uAsciiColor * mix( 1.0, 0.35 + 1.4 * nprAsciiV, uAsciiTint );
			vec3 nprAsciiOut = nprAsciiInk * nprAsciiGlyph * ( 0.25 + 0.75 * nprAsciiV )
				+ gl_FragColor.rgb * clamp( uAsciiFill, 0.0, 1.0 );
			gl_FragColor.rgb = mix( gl_FragColor.rgb, nprAsciiOut, clamp( uAscii, 0.0, 1.0 ) );
		}
`,
  },
  decls: {
    frag: /* glsl */ `
float nprAsciiHash( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

/** 一条宽 2w 的线（d = 到线心的有符号距离），返回 0..1 并自带软边 */
float nprAsciiBar( float d, float w ) {
	return smoothstep( w, 0.0, abs( d ) );
}

/**
 * 十种字形，uv ∈ [0,1]²（y 已翻正）。返回 0..1 的覆盖率。
 * 用 if 链而不是「十个字形全算再加权」：后者每条像素要多算 20 次 smoothstep。
 */
float nprAsciiGlyph( vec2 uv, float idx ) {
	vec2 p = uv * 2.0 - 1.0;
	float i = mod( floor( idx + 0.5 ), 10.0 );
	float aa = 0.15;

	if ( i < 0.5 ) return step( length( p - vec2( 0.0, -0.62 ) ), 0.19 );                 // .
	if ( i < 1.5 ) return nprAsciiBar( p.y, aa ) * step( abs( p.x ), 0.66 );               // -
	if ( i < 2.5 ) return nprAsciiBar( p.x, aa ) * step( abs( p.y ), 0.72 );               // |
	if ( i < 3.5 ) return nprAsciiBar( p.y - p.x * 0.72, aa * 0.9 ) * step( abs( p.x ), 0.72 ); // /
	// 反斜线：注释里绝不能写反斜杠结尾——预处理器会把下一行拼进注释
	if ( i < 4.5 ) return nprAsciiBar( p.y + p.x * 0.72, aa * 0.9 ) * step( abs( p.x ), 0.72 );
	if ( i < 5.5 ) return nprAsciiBar( length( p ) - 0.52, aa * 0.9 );                     // o
	if ( i < 6.5 ) return max(                                                            // +
		nprAsciiBar( p.x, aa * 0.8 ) * step( abs( p.y ), 0.58 ),
		nprAsciiBar( p.y, aa * 0.8 ) * step( abs( p.x ), 0.58 )
	);
	if ( i < 7.5 ) return max(                                                            // *
		max( nprAsciiBar( p.x, aa * 0.7 ), nprAsciiBar( p.y, aa * 0.7 ) ),
		max( nprAsciiBar( p.y - p.x, aa * 0.55 ), nprAsciiBar( p.y + p.x, aa * 0.55 ) )
	);

	float nprAsciiH = max(                                                                // #
		max( nprAsciiBar( p.x - 0.34, aa * 0.62 ), nprAsciiBar( p.x + 0.34, aa * 0.62 ) )
			* step( abs( p.y ), 0.72 ),
		max( nprAsciiBar( p.y - 0.34, aa * 0.62 ), nprAsciiBar( p.y + 0.34, aa * 0.62 ) )
			* step( abs( p.x ), 0.72 )
	);
	if ( i < 8.5 ) return nprAsciiH;
	return step( max( abs( p.x ), abs( p.y ) ), 0.52 );                                    // █
}
`,
  },
};

// 注册进全局表：契约（charter.shader.modules）与内容侧都按 id 引用，转换期也靠这张表校验
registerModule(asciiFlow);
