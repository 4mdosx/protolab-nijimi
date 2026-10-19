/**
 * npr-commit —— 把 NPR 结果写回 `outgoingLight`。
 *
 * 这里承担原来 `if ( uNprEnable > 0.5 ) { ... }` 的开关语义。用三目而不是把整段
 * 计算包在 if 里，是因为模块之间要共享同一个作用域（拆开就没法读彼此的局部变量）。
 *
 * 等价性：`uNprEnable = 1` 时取 `nprOut`，与旧代码逐字相同；
 * `= 0` 时取原来的 `outgoingLight`，分支虽被计算但结果被丢弃——视觉与旧代码一致。
 */

import type { ShaderModule } from '../../module';

export const nprCommit: ShaderModule = {
  id: 'npr-commit',
  version: 1,
  doc: 'NPR 总开关 + 写回 outgoingLight',
  after: ['npr-debug'],
  params: [
    { id: 'uNprEnable', type: 'float', label: 'NPR 总开关（0 = A/B 原始 PBR）' },
  ],
  frag: {
    beforeOutput: /* glsl */ `
		outgoingLight = uNprEnable > 0.5 ? nprOut : outgoingLight;
`,
  },
};
