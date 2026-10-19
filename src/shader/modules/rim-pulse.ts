/**
 * rim-pulse —— 第一个「内容侧」着色效果：边缘光脉冲。
 *
 * 这个文件是**示例，也是验收物**（文档 §5 P1-12）：它只依赖 NPR 表面已有的
 * 作用域变量（`nprN` / `nprV` / `nprOut`，由 npr-basis / npr-ramp 声明），
 * 不 import 任何引擎内部实现，内容侧照着写一份自己的模块即可。
 *
 * 用法（游戏仓，不改引擎）：
 *
 *   import { rimPulse } from 'nijimi';
 *   const stage = createStage(el, { characterModules: [rimPulse] });
 *   stage.onFrame((ctx) => {
 *     stage.params.set('uRimPulseStrength', 0.5 + 0.5 * Math.sin(ctx.time * 3.0), 'fx');
 *   });
 *
 * 注意：它与 npr-rim 是**两层**——rim 是常驻轮廓光（窄、低调），
 * pulse 是演出用的第二圈（宽、可染色、可归零）。
 */

import { registerModule, type ShaderModule } from '../module';

export const rimPulse: ShaderModule = {
  id: 'rim-pulse',
  version: 1,
  doc: '边缘光脉冲（演出用第二圈轮廓光）',
  // 依赖 NPR 表面的局部变量（nprN/nprV/nprOut 由 basis/ramp 声明），
  // 但必须排在 npr-commit 之前——commit 一执行，nprOut 就写回 outgoingLight 了。
  after: ['npr-ramp'],
  before: ['npr-commit'],
  params: [
    { id: 'uRimPulseColor', type: 'color', label: '脉冲颜色' },
    { id: 'uRimPulseStrength', type: 'float', label: '脉冲强度（0 = 关）' },
    { id: 'uRimPulsePower', type: 'float', label: '脉冲宽度（越大越窄）' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		float nprPulseFres = 1.0 - clamp( dot( nprN, nprV ), 0.0, 1.0 );
		nprOut += uRimPulseColor * pow( nprPulseFres, max( uRimPulsePower, 0.5 ) ) * uRimPulseStrength;
`,
  },
};

// 注册进全局表：契约（charter.shader.modules）与内容侧都按 id 引用，转换期也靠这张表校验
registerModule(rimPulse);
