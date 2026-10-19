/**
 * 提示通道（notice）—— 引擎的统一「降级要出声」出口。
 *
 * 造型来自 `exp-contract` 已经验证过的模式：**能力缺失 = 降级 + 说出来**，
 * 不静默、不抛崩。区别是那里面向表情能力，这里面向渲染能力。
 *
 * 约定：
 *   - `warn`  画面还能看，但和作者以为的不一样（参数冲突、pass 被跳过）
 *   - `error` 本次改动没生效，需要作者处理（锚点缺失、模块不存在）
 *
 * 消费者：`stage.onNotice(cb)`、编辑器状态栏、测试页。
 * 引擎内部**不要 console.warn 了事**——那条信息在浏览器里活不过一次刷新。
 */

export type NoticeCode =
  /** 同一帧内两个写入者抢同一个参数（后者被拒绝） */
  | 'param-conflict'
  /** 参数没声明就被写（已按值推断类型，但多半是 id 拼错或模块漏声明） */
  | 'param-undeclared'
  /** 契约/内容声明了未注册的着色模块 */
  | 'module-missing'
  /** 注入锚点在这份 shader 源码里找不到（three 换 chunk 名的信号） */
  | 'anchor-missing'
  /** pass 声明了当前 RT 不提供的缓冲，被跳过 */
  | 'pass-skipped'
  /** 独立材质要内建参数（uTime 等）但没有参数总线，会停在 0 */
  | 'material-builtin'
  /** 效果时间线：id 重复、时长非法、临时 pass 插不进链 */
  | 'effect-skipped'
  /** 语义队列带内溢出（offset 超出预留区） */
  | 'queue-overflow'
  /** 模块装在了不该装的材质上（如软粒子装在不透明材质：alpha 没人看，等于白编一段） */
  | 'material-unsuitable';

export interface Notice {
  code: NoticeCode;
  level: 'warn' | 'error';
  message: string;
  /** 相关对象：参数名 / 模块 id / pass id */
  id?: string;
  detail?: Record<string, unknown>;
}

export type NoticeListener = (notice: Notice) => void;

export interface NoticeSink {
  emit(notice: Notice): void;
  warn(code: NoticeCode, message: string, extra?: Omit<Notice, 'code' | 'level' | 'message'>): void;
  error(code: NoticeCode, message: string, extra?: Omit<Notice, 'code' | 'level' | 'message'>): void;
  /** 订阅；返回取消函数 */
  on(listener: NoticeListener): () => void;
  /** 最近的记录（编辑器/测试读取；容量固定，避免长跑泄漏） */
  readonly log: readonly Notice[];
  clear(): void;
}

const LOG_LIMIT = 64;

export function createNoticeSink(): NoticeSink {
  const listeners = new Set<NoticeListener>();
  const log: Notice[] = [];

  function emit(notice: Notice) {
    log.push(notice);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    for (const l of listeners) {
      try {
        l(notice);
      } catch (e) {
        // 监听者自己的异常不能反过来打断渲染
        console.warn('[notice] 监听器抛错', e);
      }
    }
  }

  return {
    emit,
    warn(code, message, extra) {
      emit({ code, level: 'warn', message, ...extra });
    },
    error(code, message, extra) {
      emit({ code, level: 'error', message, ...extra });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get log() {
      return log;
    },
    clear() {
      log.length = 0;
    },
  };
}
