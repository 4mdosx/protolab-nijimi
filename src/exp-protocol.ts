/**
 * `witch.exp/1` 指令流 —— 把「一句话」变成「脸上发生的事」。
 *
 * 分工（这是本文件存在的唯一理由）：
 *   exp-contract.ts   约定：指令类型 / 能力表 / 回退语义（FROZEN）
 *   expression.ts     能力：槽位 → morph / 材质 / 眼骨（只认 manifest 索引）
 *   本文件            翻译：指令 → 能力调用 + 时序 + **缺能力时的回退与提示**
 *
 * 三条纪律：
 *
 * ① **不静默。** 消费方发了一条这个模型做不到的指令，唯一正确的行为是
 *    「按约定回退 + 发一条 notice」。假装成功会让上游永远发现不了自己的 bug
 *    （最典型的：给 si 发 `symbol_sweat`，屏幕上什么都没发生，日志也没有）。
 *
 * ② **不抛错。** 跨进程/跨语言调用方可能发了新版本才有的 op。拒收 + notice
 *    就够了，表情层不该炸掉整个场景。
 *
 * ③ **不解释动作。** `emote.motion` 只转交动作系统，本层不判断它是否存在 ——
 *    判断权在动作系统（它返回 false，这里负责回退到 idle 并提示）。
 *
 * 时序语义（消费方不需要自己计时）：
 *   face.set  → 保持到下次设置
 *   face.play → hold 秒后自动回落
 *   emote     → 表情起 + 动作起 + hold 后一起收
 */

import * as THREE from 'three';
import type { ExpressionLayer } from './expression';
import {
  EXP_OPS, EXP_PROTOCOL, EMPTY_RESULT, normalizeViseme, resolveSlot,
  type ExpCommand, type ExpOp, type ExpNotice, type ExpNoticeCode, type ExpResult,
  type ExpSlotMeta, type FallbackDecision, type ModelCapabilities,
} from './exp-contract';

/* ------------------------------------------------------------------ *
 * 动作系统端口
 *
 * 表情层不实现动作，只占一个口。项目当前没有动作库（`anim.ts` 是空壳），
 * 所以默认端口什么都做不了 —— 那也必须**说**出来（见 motion-unavailable）。
 * 将来接上 `CharacterAnim` 时只换这一个对象，指令协议一个字不用改。
 * ------------------------------------------------------------------ */

export interface MotionPort {
  /** 默认待机动作 id —— 回退目标 */
  readonly idle: string;
  /** 播一个动作；**返回 false 表示没有这个动作** */
  play(id: string, opts?: { loop?: boolean; fade?: number }): boolean;
  stop(): void;
}

export const NULL_MOTION: MotionPort = Object.freeze({
  idle: 'idle',
  play: () => false,
  stop: () => undefined,
});

export interface ExpProtocolOptions {
  /** 表情层；null = 该模型没有表情契约（如 yelan） */
  readonly expr: ExpressionLayer | null;
  /** 槽位表（来自 manifest.slots）—— expr 为 null 时也要能报「这个槽位是什么组」 */
  readonly slots: Readonly<Record<string, ExpSlotMeta>>;
  readonly modelId: string;
  /** 动作系统端口；省略 = 无动作系统 */
  readonly motion?: MotionPort;
  /** 每条 notice 的回调（UI / 日志 / 遥测）。回调抛错不影响指令执行 */
  readonly onNotice?: (n: ExpNotice) => void;
}

const DEFAULT_EMOTE_HOLD = 1.6;
const MAX_KEPT_NOTICES = 40;

export class ExpProtocol {
  readonly modelId: string;
  readonly protocol = EXP_PROTOCOL;
  private readonly expr: ExpressionLayer | null;
  private readonly slots: Readonly<Record<string, ExpSlotMeta>>;
  private readonly motion: MotionPort;
  private onNotice?: (n: ExpNotice) => void;

  /** 最近发生的 notice（新的在前）—— 调试面板读这个 */
  private readonly recent: ExpNotice[] = [];
  /** console 去重：同一 model+code+slot 只吵一次 */
  private readonly warned = new Set<string>();

  constructor(opts: ExpProtocolOptions) {
    this.expr = opts.expr;
    this.slots = opts.slots;
    this.modelId = opts.modelId;
    this.motion = opts.motion ?? NULL_MOTION;
    this.onNotice = opts.onNotice;
  }

  /** 这个模型的能力表（消费方应先问再做；问了就等于提前知道会不会回退） */
  get capabilities(): ModelCapabilities | null {
    return this.expr?.caps ?? null;
  }

  /** 能不能做某个槽位（含 alias 判定：alias 也算「能做，但会发 notice」） */
  supports(slot: string): boolean {
    const d = this.decide(slot);
    return d.kind === 'direct';
  }

  /** 最近 notice（新 → 旧） */
  get notices(): readonly ExpNotice[] {
    return this.recent;
  }

  setNoticeSink(sink?: (n: ExpNotice) => void): void {
    this.onNotice = sink;
  }

  /** 清掉提示历史（编辑器「清空日志」用） */
  clearNotices(): void {
    this.recent.length = 0;
  }

  /* ------------------------------ 执行 ------------------------------ */

  /** 执行一条或一批指令。批量按顺序应用（同槽位后来者覆盖前者）。 */
  apply(input: ExpCommand | readonly ExpCommand[]): ExpResult {
    const cmds: readonly ExpCommand[] = Array.isArray(input)
      ? (input as readonly ExpCommand[])
      : [input as ExpCommand];
    const notices: ExpNotice[] = [];
    const applied: string[] = [];
    let ok = true;

    for (const cmd of cmds) {
      const r = this.applyOne(cmd);
      notices.push(...r.notices);
      applied.push(...r.applied);
      if (!r.ok) ok = false;
    }
    if (!cmds.length) return EMPTY_RESULT;
    return { ok, applied, notices };
  }

  private applyOne(cmd: ExpCommand): ExpResult {
    if (!cmd || typeof cmd !== 'object' || !('op' in cmd)) {
      return this.fail('unknown-op', String(cmd), '不是一条指令对象');
    }
    if (!EXP_OPS.includes(cmd.op)) {
      return this.fail('unknown-op', String(cmd.op), `op「${String(cmd.op)}」不在 ${EXP_PROTOCOL} 的指令集里`);
    }

    // switch 直接读 cmd.op 才能让 TS 收窄联合类型（先赋给变量会丢掉判别关系）
    const requestedOp = cmd.op;
    switch (cmd.op) {
      case 'face.set': return this.faceSet(cmd.slot, cmd.w ?? 1, cmd.fade);
      case 'face.play':
        return this.facePlay(cmd.slot, { hold: cmd.hold, fade: cmd.fade, release: cmd.release, w: cmd.w });
      case 'face.clear': return this.faceClear(cmd.slots);
      case 'face.auto': return this.faceAuto(cmd.what, cmd.on);
      case 'mouth.set': return this.faceSet(normalizeViseme(cmd.viseme), cmd.w ?? 1);
      case 'mouth.clear':
        return this.faceClear(Object.keys(this.slots).filter((s) => this.slots[s].group === 'mouth'));
      case 'gaze.dir': return this.gazeDir(cmd.x, cmd.y);
      case 'gaze.at': return this.gazeAt(cmd.target);
      case 'motion.play': return this.motionPlay(cmd.id, { loop: cmd.loop, fade: cmd.fade });
      case 'motion.stop': this.motion.stop(); return { ok: true, applied: [], notices: [] };
      case 'emote': return this.emote(cmd);
      case 'reset': return this.reset();
      default: return this.fail('unknown-op', String(requestedOp), `op「${String(requestedOp)}」未实现`);
    }
  }

  /* ------------------------------ 表情 ------------------------------ */

  private faceSet(slot: string, w: number, fade?: number): ExpResult {
    const d = this.decide(slot);
    const notices: ExpNotice[] = [];
    if (d.kind === 'direct' || d.kind === 'alias') {
      this.expr!.set(d.slot!, w, fade);
      notices.push(...this.explain(d, 'face.set', slot));
      return { ok: true, applied: [d.slot!], notices };
    }
    // 回退：该组回到中性（不是「保持上一次」）
    this.clearGroup(d.group);
    notices.push(...this.explain(d, 'face.set', slot));
    return { ok: false, applied: [], notices };
  }

  private facePlay(slot: string, opts: { hold?: number; fade?: number; release?: number; w?: number }): ExpResult {
    const d = this.decide(slot);
    if (d.kind === 'direct' || d.kind === 'alias') {
      this.expr!.play(d.slot!, { ...opts, hold: opts.hold ?? DEFAULT_EMOTE_HOLD });
      return { ok: true, applied: [d.slot!], notices: this.explain(d, 'face.play', slot) };
    }
    this.clearGroup(d.group);
    return { ok: false, applied: [], notices: this.explain(d, 'face.play', slot) };
  }

  private faceClear(slots?: readonly string[]): ExpResult {
    if (!this.expr) return { ok: true, applied: [], notices: [] };
    if (!slots?.length) { this.expr.clear(); return { ok: true, applied: [], notices: [] }; }
    for (const s of slots) {
      if (this.expr.has(s)) this.expr.set(s, 0);
    }
    return { ok: true, applied: [...slots], notices: [] };
  }

  private faceAuto(what: 'blink' | 'gaze', on: boolean): ExpResult {
    if (!this.expr) return this.degraded('no-expression', 'face.auto', undefined, '该模型没有表情契约，自动层无从开关');
    if (what === 'blink') { this.expr.setAutoBlink(on); return { ok: true, applied: [], notices: [] }; }
    if (what === 'gaze') {
      if (this.expr.caps.gaze.mode === 'none') {
        return this.degraded('gaze-unavailable', 'face.auto', undefined, '该模型既无 look_* 也无眼骨，视线无法自动');
      }
      this.expr.setAutoGaze(on);
      return { ok: true, applied: [], notices: [] };
    }
    return this.degraded('unknown-op', 'face.auto', undefined, `自动层「${String(what)}」未定义`);
  }

  /* ------------------------------ 视线 ------------------------------ */

  private gazeDir(x: number, y: number): ExpResult {
    if (!this.expr || this.expr.caps.gaze.mode === 'none') {
      return this.degraded('gaze-unavailable', 'gaze.dir', undefined, '该模型没有视线通道，视线回正前方');
    }
    this.expr.gazeDir(x, y);
    return { ok: true, applied: [], notices: [] };
  }

  private gazeAt(target: readonly [number, number, number] | null): ExpResult {
    if (!this.expr || this.expr.caps.gaze.mode === 'none') {
      return this.degraded('gaze-unavailable', 'gaze.at', undefined, '该模型没有视线通道，视线回正前方');
    }
    this.expr.gazeAt(target ? new THREE.Vector3(target[0], target[1], target[2]) : null);
    return { ok: true, applied: [], notices: [] };
  }

  /* ------------------------------ 动作 ------------------------------ */

  private motionPlay(id: string, opts: { loop?: boolean; fade?: number }): ExpResult {
    if (this.motion.play(id, opts)) return { ok: true, applied: [], notices: [] };
    // 回退到默认动作 —— 这是 console/runtime 都能看见的一次降级
    this.motion.play(this.motion.idle, { loop: true });
    const n = this.notice(
      'motion-unavailable', 'fallback', 'motion.play',
      `动作「${id}」不在动作库里 → 回退到「${this.motion.idle}」`,
    );
    return { ok: false, applied: [], notices: [n] };
  }

  private reset(): ExpResult {
    this.expr?.clear();
    this.expr?.setAutoBlink(true);
    this.expr?.setAutoGaze(false);
    this.motion.stop();
    return { ok: true, applied: [], notices: [] };
  }

  /* ------------------------------ emote ------------------------------ */

  /**
   * 「她开心地挥手」的打包形态。三件事由这里兜住：
   *   ① 表情（缺则按约定回退并提示）
   *   ② 动作（缺则回退 idle 并提示）
   *   ③ 时序（hold 后表情自然回落，消费方不用起定时器）
   */
  private emote(cmd: Extract<ExpCommand, { op: 'emote' }>): ExpResult {
    const notices: ExpNotice[] = [];
    const applied: string[] = [];
    let ok = true;

    const d = this.decide(cmd.slot);
    if (d.kind === 'direct' || d.kind === 'alias') {
      this.expr!.play(d.slot!, {
        hold: cmd.hold ?? DEFAULT_EMOTE_HOLD,
        release: cmd.release,
        w: cmd.w,
      });
      applied.push(d.slot!);
      notices.push(...this.explain(d, 'emote', cmd.slot));
    } else {
      this.clearGroup(d.group);
      ok = false;
      notices.push(...this.explain(d, 'emote', cmd.slot));
    }

    if (cmd.motion) {
      const r = this.motionPlay(cmd.motion, { loop: false });
      notices.push(...r.notices);
      if (!r.ok) ok = false;   // 表情成功、动作失败 → 整体算「降级」
    }
    return { ok, applied, notices };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 槽位 → 该怎么做（唯一回退入口，逻辑在 exp-contract 的纯函数里） */
  private decide(slot: string): FallbackDecision {
    // 程序化角色：既没表情层也没槽位表 —— 这是「整个模型没有脸」，
    // 不是「这个名字拼错了」，两种情况给消费方的提示必须不同。
    if (!this.expr && !Object.keys(this.slots).length) {
      return { kind: 'unsupported', slot: null, group: null, detail: '该模型没有表情契约' };
    }
    return resolveSlot(
      slot,
      this.expr?.caps ?? null,
      this.slots,
      this.expr?.model.fallback?.aliases ?? {},
    );
  }

  /** 清掉一个组的全部槽位（回退到中性） */
  private clearGroup(group: string | null): void {
    if (!group || !this.expr) return;
    for (const [slot, meta] of Object.entries(this.slots)) {
      if (meta.group === group && this.expr.has(slot)) this.expr.set(slot, 0);
    }
  }

  /** 把一条 fallback 决策翻译成 notice（direct 不吵） */
  private explain(d: FallbackDecision, op: ExpOp, rawSlot: string): ExpNotice[] {
    if (d.kind === 'direct') return [];
    if (d.kind === 'alias') {
      return [this.notice('slot-alias', 'fallback', op, d.detail, rawSlot)];
    }
    if (d.kind === 'unknown') {
      return [this.notice('slot-unknown', 'warn', op, d.detail, rawSlot)];
    }
    if (d.kind === 'unsupported') {
      return [this.notice('no-expression', 'fallback', op, d.detail, rawSlot)];
    }
    return [this.notice('slot-neutral', 'fallback', op, d.detail, rawSlot)];
  }

  private degraded(code: ExpNoticeCode, op: ExpOp, slot: string | undefined, detail: string): ExpResult {
    return { ok: false, applied: [], notices: [this.notice(code, 'fallback', op, detail, slot)] };
  }

  private fail(code: ExpNoticeCode, op: string, detail: string): ExpResult {
    return { ok: false, applied: [], notices: [this.notice(code, 'warn', op, detail)] };
  }

  private notice(
    code: ExpNoticeCode,
    level: 'info' | 'fallback' | 'warn',
    op: ExpOp | string,
    detail: string,
    slot?: string,
  ): ExpNotice {
    const n: ExpNotice = {
      code, level, model: this.modelId, op, slot, detail,
      message: `[${this.modelId}] ${detail}`,
    };
    this.recent.unshift(n);
    if (this.recent.length > MAX_KEPT_NOTICES) this.recent.length = MAX_KEPT_NOTICES;

    const key = `${code}:${slot ?? ''}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      if (level === 'warn') console.warn(`[exp] ${n.message}`);
      else console.info(`[exp] ${n.message}`);
    }
    try { this.onNotice?.(n); } catch { /* 回调坏了不该影响指令 */ }
    return n;
  }
}
