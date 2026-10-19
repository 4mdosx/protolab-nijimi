/**
 * npr-debug —— SDF 标定用的调试输出。
 *
 * 1 = 阈值场 / 2 = 最终明暗 / 3 = 光照衰减。只影响最终 `nprOut`，不改驱动链——
 * 所以开着调试时看到的明暗仍然是真正在跑的那一套（不会自欺）。
 */

import type { ShaderModule } from '../../module';

export const nprDebug: ShaderModule = {
  id: 'npr-debug',
  version: 1,
  doc: 'SDF 阈值场 / 最终明暗 / 光照衰减 三档调试输出',
  after: ['npr-rim'],
  params: [
    { id: 'uNprSdfDebug', type: 'float', label: '调试档位（0 关）' },
    { id: 'uNprSdfOn', type: 'float', optional: true },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		#ifdef NPR_HAS_FACE_SDF
		if ( uNprSdfOn > 0.5 && uNprSdfDebug > 0.5 ) {
			nprOut = uNprSdfDebug < 1.5 ? vec3( nprThr )
				: ( uNprSdfDebug < 2.5 ? vec3( nprDriver ) : vec3( nprAtten ) );
		}
		#endif
`,
  },
};
