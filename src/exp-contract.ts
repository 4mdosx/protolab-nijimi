/**
 * 表情与指令的**对外契约** —— `witch.exp/1`
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ⚠️ FROZEN API
 *
 *  这是引擎与「消费方」（游戏逻辑、LLM 桥、编辑器、自动化测试）之间
 *  唯一被承诺稳定的面。规则只有三条：
 *
 *  1. **消费方只 import 本文件**，不读 expression-manifest.json 的原始结构，
 *     也不直接调 ExpressionLayer。manifest 是转换期产物，结构可演进；
 *     本文件是契约，只能升版本。
 *  2. **任何破坏性改动（改名 / 删 op / 改语义）必须升 EXP_CONTRACT_VERSION**，
 *     并在 docs/表情层-对外契约.md 里写迁移说明。
 *     加字段 / 加可选 op 不算破坏，但也要在文档里登记。
 *  3. **做不到的事必须报出来**，不许静默 —— 见 `ExpNotice` 与 `resolveSlot`。
 *     消费方发了一条这个模型做不了的指令，正确行为是「回退到默认 + 提示」，
 *     而不是假装成功。
 *
 *  版本对应关系：
 *    EXP_CONTRACT_VERSION 2  ≈  manifest.contractVersion 2  ≈  pipeline EXPR_VERSION 2
 *    三者必须一致；运行期发现不一致会 warn 并降级（不致命，但要修资产）。
 * ═══════════════════════════════════════════════════════════════════
 *
 * 设计依据：docs/表情层-对外契约.md、docs/表情层-系统设计与指令协议.md §3 / §6
 */

/** 指令协议标识。出现在日志、调试面板与跨进程消息的 `format` 字段里。 */
export const EXP_PROTOCOL = 'witch.exp/1' as const;

/** 契约版本（见文件头第 2 条） */
export const EXP_CONTRACT_VERSION = 2 as const;

/* ------------------------------------------------------------------ *
 * 1. 数据契约（manifest 的结构，消费方**不需要**直接读）
 * ------------------------------------------------------------------ */

export interface ExpSlotMeta {
  readonly cn: string;
  readonly group: string;
  readonly side?: 'left' | 'right';
}

/** morph 通道：写 mesh.morphTargetInfluences[target] */
export interface ExpMorphBinding {
  readonly ch: 'morph';
  readonly target: number;
  readonly name: string;
  readonly w: number;
}

/** 材质通道：写 material.opacity（如 si 的脸红叠加层） */
export interface ExpMaterialBinding {
  readonly ch: 'material';
  readonly material: string;
  readonly materialIndex: number;
  readonly morph: string;
  readonly prop: 'opacity';
  readonly mode: 'add' | 'mul';
  readonly value: number;
  readonly w: number;
}

export type ExpBinding = ExpMorphBinding | ExpMaterialBinding;

export interface ExpTarget {
  readonly index: number;
  readonly name: string;
  readonly verts: number;
  /** 该 morph 真正移动了多少个顶点（不是全量的 verts）—— 判断「这个表情有多明显」 */
  readonly affected: number;
  readonly sparse: boolean;
}

/**
 * 视线方案。三选一，是这个模型的事实：
 *   morph  有 look_* 8 方向 morph（akane）→ 与姿势层正交，零竞争
 *   bone   有 eye_l/eye_r 眼骨（si / yelan）→ 写骨，必须在姿势层之后
 *   none   都没有（yelan 无表情层）→ gaze 指令一律回退
 */
export interface ExpGaze {
  readonly mode: 'none' | 'morph' | 'bone';
  /** bone 模式的最大偏转角（度）；morph 模式下是满权对应的等效角度 */
  readonly maxDeg?: number;
  /** bone 模式的骨骼名（来自骨骼契约的 key，运行期按名找） */
  readonly bones?: readonly string[];
  /**
   * 该资产的**横向方向与契约相反**（x>0 = 角色右方）。
   * morph 模式：部分资产的 `look_L/look_R` 是按**观众视角**命名的（akane 实测如此），
   * 所以 `x=+1`（看角色右）要取 `look_L` 才动。声明在这里而不是在代码里特判。
   */
  readonly mirrorX?: boolean;
}

/** 一个模型能做什么。转换期算好写进 manifest，运行期零推导。 */
export interface ModelCapabilities {
  readonly modelId: string;
  /** 能实现的槽位 */
  readonly slots: readonly string[];
  /** 做不了的槽位（= manifest.unresolved，去重后） */
  readonly missing: readonly string[];
  readonly byGroup: Readonly<Record<string, { readonly have: readonly string[]; readonly missing: readonly string[] }>>;
  readonly gaze: ExpGaze;
  readonly blink: boolean;
  /** 是否有材质通道（脸红这类不能靠 morph 表达的） */
  readonly material: boolean;
  /** 离散 look_* 没有、但能连续转视线（gaze.dir）时为 true */
  readonly continuousGaze?: boolean;
}

export interface ExpFallback {
  /** 同义替代：只在两个槽位共用同一份资产时登记，否则是骗人 */
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  /** 组级回落：该组回到中性（null = 清掉该组，不是保持） */
  readonly groups: Readonly<Record<string, { readonly to: string | null; readonly cn: string }>>;
}

export interface ModelExpression {
  readonly id: string;
  readonly file: string;
  readonly exprVersion: number;
  readonly gazeMode: 'none' | 'morph' | 'bone';
  readonly gaze?: ExpGaze;
  readonly blinkSource: string;
  readonly targetCount?: number;
  readonly targets?: readonly ExpTarget[];
  readonly bindings: Readonly<Record<string, readonly ExpBinding[]>>;
  /** VRM 1.0 语义：情绪激活时底层通道怎么让位（none / block / blend） */
  readonly overrides?: Readonly<Record<string, Readonly<Record<string, 'none' | 'block' | 'blend'>>>>;
  readonly unresolved: readonly string[];
  readonly capabilities?: ModelCapabilities;
  readonly fallback?: ExpFallback;
  readonly coverage?: { readonly covered: number; readonly total: number };
  readonly note?: string | null;
  readonly warnings?: readonly string[];
}

export interface ExpressionManifest {
  readonly exprVersion: number;
  readonly contractVersion?: number;
  readonly generatedAt: string | null;
  readonly slots: Readonly<Record<string, ExpSlotMeta>>;
  readonly groups: readonly string[];
  readonly models: readonly ModelExpression[];
}

/* ------------------------------------------------------------------ *
 * 2. 指令契约（消费方唯一要写的东西）
 *
 * 全部是**置位型**指令，不是关键帧。时间语义在引擎里：
 *   face.set    → 保持到下次设置
 *   face.play   → hold 秒后自动回落
 *   emote       → 语义打包：表情 + 动作 + 时序
 * 所以消费方不需要每帧算权重，也不需要自己计时。
 * ------------------------------------------------------------------ */

export type ExpFaceCommand =
  | { readonly op: 'face.set'; readonly slot: string; readonly w?: number; readonly fade?: number }
  | {
    readonly op: 'face.play';
    readonly slot: string;
    readonly w?: number;
    readonly hold?: number;
    readonly fade?: number;
    readonly release?: number;
  }
  | { readonly op: 'face.clear'; readonly slots?: readonly string[] }
  | { readonly op: 'face.auto'; readonly what: 'blink' | 'gaze'; readonly on: boolean };

export type ExpMouthCommand =
  | { readonly op: 'mouth.set'; readonly viseme: string; readonly w?: number }
  | { readonly op: 'mouth.clear' };

export type ExpGazeCommand =
  /** 归一化方向：x>0 看角色右方，y>0 看上；长度即强度（1 = 满） */
  | { readonly op: 'gaze.dir'; readonly x: number; readonly y: number; readonly fade?: number }
  /** 世界坐标目标点；null = 回到空闲游移 */
  | { readonly op: 'gaze.at'; readonly target: readonly [number, number, number] | null; readonly fade?: number };

export type ExpMotionCommand =
  | { readonly op: 'motion.play'; readonly id: string; readonly loop?: boolean; readonly fade?: number }
  | { readonly op: 'motion.stop' };

/** 语义打包 —— 「她开心地挥手」一句话说完 */
export interface ExpEmoteCommand {
  readonly op: 'emote';
  readonly slot: string;
  /** 动作 id，交给动作系统；本层不解释它 */
  readonly motion?: string;
  readonly hold?: number;
  readonly release?: number;
  readonly w?: number;
}

export interface ExpResetCommand {
  readonly op: 'reset';
}

export type ExpCommand =
  | ExpFaceCommand
  | ExpMouthCommand
  | ExpGazeCommand
  | ExpMotionCommand
  | ExpEmoteCommand
  | ExpResetCommand;

export type ExpOp = ExpCommand['op'];

/** 契约内的 op 白名单（运行期用它拒收未知指令，不抛错） */
export const EXP_OPS: readonly ExpOp[] = Object.freeze([
  'face.set', 'face.play', 'face.clear', 'face.auto',
  'mouth.set', 'mouth.clear',
  'gaze.dir', 'gaze.at',
  'motion.play', 'motion.stop',
  'emote', 'reset',
]);

/* ------------------------------------------------------------------ *
 * 3. 回退与提示
 * ------------------------------------------------------------------ */

export type ExpNoticeCode =
  /** 槽位在该模型上不存在，改用同义槽位 */
  | 'slot-alias'
  /** 槽位在该模型上不存在，该组回到中性 */
  | 'slot-neutral'
  /** 槽位名不在契约的 35 个槽位里（拼错了 / 用了新版本才有的名字） */
  | 'slot-unknown'
  /** 该模型没有表情层（如 yelan） */
  | 'no-expression'
  /** 视线做不了（无 look_* 也无眼骨） */
  | 'gaze-unavailable'
  /** 动作系统没有这个动作，回退到默认动作 */
  | 'motion-unavailable'
  /** 不认识的 op（跨版本调用） */
  | 'unknown-op'
  /** 契约与资产版本不一致 */
  | 'contract-version';

export type ExpNoticeLevel = 'info' | 'fallback' | 'warn';

export interface ExpNotice {
  readonly code: ExpNoticeCode;
  readonly level: ExpNoticeLevel;
  readonly model: string;
  readonly op: ExpOp | string;
  readonly slot?: string;
  /** 实际做了什么（回退目标 / 中性 / 丢弃） */
  readonly detail: string;
  /** 给人和 LLM 看的一句话，可直接显示 */
  readonly message: string;
}

/** 一条指令的执行结果 */
export interface ExpResult {
  /** 是否「做了什么」（回退到中性也算 true；整条丢弃才 false） */
  readonly ok: boolean;
  /** 实际生效的槽位（含 alias 后的） */
  readonly applied: readonly string[];
  readonly notices: readonly ExpNotice[];
}

export const EMPTY_RESULT: ExpResult = Object.freeze({ ok: true, applied: [], notices: [] });

export type FallbackKind =
  /** 模型直接支持 */
  | 'direct'
  /** 模型不支持，但同义槽位支持 */
  | 'alias'
  /** 模型不支持，该组回到中性 */
  | 'neutral'
  /** 槽位名不在契约里 */
  | 'unknown'
  /** 整个模型没有表情层 */
  | 'unsupported';

export interface FallbackDecision {
  readonly kind: FallbackKind;
  /** 实际要应用的槽位；null = 清掉该组（中性） */
  readonly slot: string | null;
  /** 所属组（用于 neutral 的说明） */
  readonly group: string | null;
  readonly detail: string;
}

/**
 * 一条槽位指令落到具体模型上该怎么做。
 *
 * **这是回退语义的唯一实现**（纯函数，无副作用，可单测）。
 * 顺序：直用 → 同义 → 组级中性 → 未知。
 */
export function resolveSlot(
  slot: string,
  caps: ModelCapabilities | null,
  slots: Readonly<Record<string, ExpSlotMeta>>,
  aliases: Readonly<Record<string, readonly string[]>> = {},
): FallbackDecision {
  const meta = slots[slot];
  if (!meta) {
    return { kind: 'unknown', slot: null, group: null, detail: `「${slot}」不在契约的槽位表里` };
  }
  if (!caps) {
    return { kind: 'unsupported', slot: null, group: meta.group, detail: '该模型没有表情契约' };
  }
  if (caps.slots.includes(slot)) {
    return { kind: 'direct', slot, group: meta.group, detail: '直接支持' };
  }
  for (const alt of aliases[slot] ?? []) {
    if (caps.slots.includes(alt)) {
      return {
        kind: 'alias', slot: alt, group: meta.group,
        detail: `「${slot}」不可用，改用同义槽位「${alt}」`,
      };
    }
  }
  return {
    kind: 'neutral', slot: null, group: meta.group,
    detail: `「${slot}」不可用，${meta.group} 组回到中性`,
  };
}

/** 从 manifest 的模型条目推出能力表（manifest 已带则直接用） */
export function capabilitiesOf(model: ModelExpression): ModelCapabilities {
  if (model.capabilities) return model.capabilities;
  const have = Object.keys(model.bindings);
  // 旧 manifest（无 capabilities）的兜底：按组拆分交给调用方用 slots 表补
  return {
    modelId: model.id,
    slots: have,
    missing: [...model.unresolved],
    byGroup: {},
    gaze: model.gaze ?? { mode: model.gazeMode },
    blink: !!model.bindings.blink,
    material: Object.values(model.bindings).some((l) => l.some((b) => b.ch === 'material')),
    continuousGaze: (model.gaze ?? { mode: model.gazeMode }).mode !== 'none',
  };
}

/**
 * 契约版本校验。返回的字符串会直接进 console.warn / 调试面板。
 * 不抛错：资产旧了不该炸掉整个场景，但必须让人看见。
 */
export function checkContract(manifest: ExpressionManifest): string[] {
  const out: string[] = [];
  if (manifest.contractVersion !== undefined && manifest.contractVersion !== EXP_CONTRACT_VERSION) {
    out.push(
      `manifest.contractVersion=${manifest.contractVersion} ≠ 运行期 ${EXP_CONTRACT_VERSION}`
      + '（重跑 npm run expr；跨版本调用会走回退分支）',
    );
  }
  for (const m of manifest.models) {
    if (m.exprVersion !== manifest.exprVersion) {
      out.push(`${m.id}: exprVersion=${m.exprVersion} ≠ manifest ${manifest.exprVersion}`);
    }
    if (!m.capabilities) out.push(`${m.id}: 缺 capabilities（运行期将本地推导，回退提示可能不准）`);
  }
  return out;
}

/** 口型别名归一化：'a' 与 'mouth_a' 等价（消费方两种写法都见过） */
export function normalizeViseme(v: string): string {
  const s = v.trim().toLowerCase();
  if (s.startsWith('mouth_')) return s;
  return `mouth_${s}`;
}
