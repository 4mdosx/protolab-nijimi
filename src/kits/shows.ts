/**
 * 现成演出（内容层）—— 不是引擎能力，是**写法示范**。
 *
 * 这份文件只 import 公开出口（`EffectSpec` / 模块 / 成品 pass），一行引擎内部实现都不碰；
 * 游戏仓照抄就能得到自己的演出，不需要改 `src/`。
 *
 * 前提：材质侧要装好对应的模块——
 *
 *   createStage(el, { characterModules: SHOW_MODULES })
 *
 * `SHOW_MODULES` = rim-pulse + dissolve。没装也不会崩：参数写进总线时会被
 * `param-undeclared` 记一笔，画面上什么都不会发生（这就是「缺失 = 降级 + 出声」）。
 */

import * as THREE from 'three';
import type { EffectSpec } from '../effects';
import type { ShaderModule } from '../shader/module';
import { rimPulse } from '../shader/modules/rim-pulse';
import { dissolve } from '../shader/modules/dissolve';
import { createShockwavePass } from '../post-passes';

/** 演出需要的表面模块（建舞台时传给 `characterModules`） */
export const SHOW_MODULES: readonly ShaderModule[] = [rimPulse, dissolve];

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

export interface ChargeBurstOptions {
  /** 主色（边缘光、溶解边缘、冲击波同一个色） */
  color?: THREE.ColorRepresentation;
  /** 总时长（秒）；节奏按比例缩放 */
  duration?: number;
}

/**
 * 充能爆发：**边缘光充能 → 全屏冲击波 → 角色元素化（溶解）**。
 *
 * 三个通道分别落在三层上，正好演示扩展体系的三个位置：
 *   - 表面层：rim-pulse / dissolve（层 A，注入内建材质，蒙皮与阴影不受影响）
 *   - 后期层：shockwave（层 C，`afterTonemap`，显示参考空间做径向折射）
 *   - 参数层：`params(t)` 曲线（写入者 `fx:charge-burst`，与别人抢写会被审计拒绝）
 *
 * 结束（`onEnd: 'restore'`）：后处理拆走，但 `uDissolve` 停在 1——
 * 角色保持「已元素化」的状态，直到 `reform()` 或重播把它拉回 0。
 */
export function chargeBurst(opts: ChargeBurstOptions = {}): EffectSpec {
  const duration = opts.duration ?? 1.9;
  const color = new THREE.Color(opts.color ?? 0x9fd8ff);
  // 相位归一化：所有分段都乘 1/duration，改总时长不会改节奏
  return {
    id: 'charge-burst',
    duration,
    onEnd: 'restore',
    params(t) {
      const charge = smooth01(t / 0.32);
      const dissolveT = smooth01((t - 0.55) / 0.39);
      const rimFade = 1 - smooth01((t - 0.32) / 0.22) * 0.55;
      return {
        uRimPulseStrength: charge * rimFade * 1.7,
        uRimPulsePower: 2.6 - charge * 0.8,
        uRimPulseColor: color,
        // 留 0.005 不推满：全消之后角色彻底不可见，编辑器里会以为崩了
        uDissolve: dissolveT * 0.995,
        uDissolveEdge: 0.07,
        uDissolveScale: 5.5,
        uDissolveColor: color,
        uDissolveGlow: 1.5 * (1 - smooth01((t - 0.78) / 0.22) * 0.65),
      };
    },
    post: {
      anchor: 'afterTonemap',
      priority: 10,
      reads: ['color'],
      params: { uStrength: 0 },
      create: () => createShockwavePass({ color }),
    },
    onFrame(t, _ctx, api) {
      // 冲击波在爆发点起跑，比溶解早 0.2 相位——先「炸开」再「化掉」
      const p = smooth01((t - 0.30) / 0.55);
      api.setPassParams({
        uProgress: p,
        uStrength: p > 0 && p < 1 ? 1.15 : 0,
        uWidth: 0.055,
      });
    },
  };
}

/**
 * 复原：溶解从 1 退回 0（反向播放同一套参数）。
 * 与 `chargeBurst` 配对：一个「化掉」，一个「聚回来」。
 */
export function reform(opts: ChargeBurstOptions = {}): EffectSpec {
  const duration = opts.duration ?? 1.1;
  const color = new THREE.Color(opts.color ?? 0x9fd8ff);
  return {
    id: 'reform',
    duration,
    onEnd: 'restore',
    params(t) {
      const back = 1 - smooth01(t / 0.85);
      return {
        uDissolve: back * 0.995,
        uDissolveEdge: 0.07,
        uDissolveScale: 5.5,
        uDissolveColor: color,
        uDissolveGlow: 1.2 * smooth01((1 - t) / 0.5) * (back > 0.001 ? 1 : 0),
        uRimPulseStrength: 0,
      };
    },
  };
}
