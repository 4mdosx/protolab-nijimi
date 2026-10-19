/**
 * 后处理链（PostChain）—— 引擎里**唯一**允许挂全屏 pass 的地方。
 *
 * 为什么需要一层壳：直接 `composer.addPass()` 有三个已经踩过的问题
 *   ① 关掉某个效果 = 换一条渲染路径（旧 `setBloom(false)` 直接 `renderer.render`，
 *      调色与 OutputPass 一起消失，A/B 比出来的差异不是 Bloom）；
 *   ② 顺序靠 addPass 调用顺序，插入一个 pass 要改调用点；
 *   ③ pass 的资源归属不清（谁 setSize、谁 dispose）。
 *
 * 这里把它变成「具名 + 语义锚点 + 可开关 + 可插入 + 可销毁」的链：
 *
 *   post.insert({ id: 'shock', anchor: 'afterTonemap', create: () => makeShockPass() })
 *   post.setEnabled('bloom', false)   // 链照常走完，输出段永远在
 *
 * 锚点（P1 全部开放）：
 *   scene          场景渲染这一步本身（RenderPass，锁定不可关）
 *   beforeTonemap  线性 HDR：Bloom / 调色 / 任何乘色或加光的效果
 *   tonemap        ⚠️ 引擎结构锚点：ToneMapPass 自己
 *   afterTonemap   显示参考、**未编码**：颗粒 / 暗角 / 色差 / 扫描线 / 冲击波的正位
 *   encode         ⚠️ 引擎结构锚点：EncodePass 自己
 *   afterOutput    LDR（已编码）：只适合 UI / 调试叠层，注意不能再做线性光运算
 *
 * 结构锚点（tonemap / encode）不对外开放：往里插 pass 等于把 tone mapping
 * 拆成两半，只有引擎知道怎么接。传这两个锚点会直接抛错。
 *
 * 缓冲：P2 起链上 RT 挂 `depthTexture`（`reads: ['depth']` 可用，深度来自 RenderPass
 * 写入的那个缓冲 = `post.depthTexture`）。法线缓冲需要 MRT，three 的内建材质不写第二
 * 附件，所以 `reads: ['normal']` 仍然在建链时抛错——不假装支持。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { ParamBus, ParamValue } from './shader/params';
import type { NoticeSink } from './notice';

export type PostAnchor =
  | 'scene'
  | 'beforeTonemap'
  | 'tonemap'
  | 'afterTonemap'
  | 'encode'
  | 'afterOutput';

/** 锚点次序。同锚点内按 priority 升序，再按加入次序。 */
const ANCHOR_RANK: Record<PostAnchor, number> = {
  scene: 0,
  beforeTonemap: 10,
  tonemap: 20,
  afterTonemap: 30,
  encode: 40,
  afterOutput: 50,
};

/** 只给引擎自己的两段用的锚点 */
const STRUCTURAL: readonly PostAnchor[] = ['tonemap', 'encode'];

export interface PostPassOptions {
  /** 稳定 id：开关、取回、移除都靠它。重复会抛错。 */
  id: string;
  /** 默认 beforeTonemap（线性光段） */
  anchor?: PostAnchor;
  /** 同锚点内次序，小的先跑。默认 100。 */
  priority?: number;
  enabled?: boolean;
  /**
   * 声明读哪些缓冲。`depth` 可用（RT 挂了 depthTexture）；`normal` 需要 MRT，
   * 当前不支持——声明它在建链时就抛错，而不是渲染出黑图（见文档 §2.2-⑧）。
   */
  reads?: readonly ('color' | 'depth' | 'normal')[];
  /** 锁定 pass 不可关闭（场景渲染与输出段用；关掉整条链就没有画面了） */
  locked?: boolean;
  /** 允许占用结构锚点（引擎内部用） */
  internal?: boolean;
}

/** insert 时拿到的建链上下文 */
export interface PassContext {
  readonly renderer: THREE.WebGLRenderer;
  /** 逻辑尺寸（CSS px） */
  readonly width: number;
  readonly height: number;
  readonly params: ParamBus | null;
}

export interface PassDescriptor extends PostPassOptions {
  /** 工厂：建链时才 new，便于按尺寸/参数构造成本较高的 pass */
  create(ctx: PassContext): Pass;
  /** 建链后写进 pass 的 uniform（按名字找 `pass.uniforms` 或 `pass.material.uniforms`） */
  params?: Record<string, ParamValue>;
}

export interface PostChain {
  readonly composer: EffectComposer;
  /** 当前链上 pass 的 id，按真实渲染顺序 */
  readonly order: readonly string[];
  /** 场景深度（RenderPass 写的那个缓冲）；建链时关了深度则为 null */
  readonly depthTexture: THREE.Texture | null;
  add(pass: Pass, opts: PostPassOptions): void;
  /** 声明式插入（推荐）：链负责调用工厂、应用参数、按锚点排序 */
  insert(desc: PassDescriptor): void;
  remove(id: string): void;
  has(id: string): boolean;
  get<T extends Pass = Pass>(id: string): T | null;
  setEnabled(id: string, on: boolean): void;
  isEnabled(id: string): boolean;
  /** 改一个已在链上的 pass 的 uniform（效果时间线用） */
  setParams(id: string, params: Record<string, ParamValue>): void;
  /** 逻辑尺寸（CSS px）；内部按 renderer pixelRatio 换算 */
  setSize(width: number, height: number): void;
  /** dt 为真实秒（Bloom 等 pass 需要） */
  render(dt: number): void;
  dispose(): void;
}

interface Entry {
  id: string;
  pass: Pass;
  anchor: PostAnchor;
  priority: number;
  /** 加入序号：同锚点同优先级时保持先进先出 */
  seq: number;
  locked: boolean;
}

export interface PostChainOptions {
  width: number;
  height: number;
  /** MSAA 采样数，默认 4 */
  samples?: number;
  /** HDR 缓冲类型，默认 HalfFloat */
  type?: THREE.TextureDataType;
  /**
   * 是否给 RT 挂 depthTexture（默认 true）。
   * 关掉可以省一点带宽，但声明 `reads:['depth']` 的 pass 会建链失败。
   */
  depth?: boolean;
  /** 参数总线：插进来的 pass 可以直接声明参数（可选） */
  params?: ParamBus;
  /** 提示出口（参数名写错之类） */
  notices?: NoticeSink;
}

function uniformsOf(pass: Pass): Record<string, THREE.IUniform> | null {
  const p = pass as unknown as {
    uniforms?: Record<string, THREE.IUniform>;
    material?: { uniforms?: Record<string, THREE.IUniform> };
  };
  return p.uniforms ?? p.material?.uniforms ?? null;
}

/** 建链。内部仍用 three 的 EffectComposer，只是把「顺序 + 开关 + 归属」接管过来。 */
export function createPostChain(renderer: THREE.WebGLRenderer, opts: PostChainOptions): PostChain {
  const width0 = Math.max(1, opts.width);
  const height0 = Math.max(1, opts.height);
  const wantDepth = opts.depth ?? true;
  const depthTexture = wantDepth ? new THREE.DepthTexture(width0, height0) : null;
  const target = new THREE.WebGLRenderTarget(width0, height0, {
    samples: opts.samples ?? 4,
    type: opts.type ?? THREE.HalfFloatType,
    depthTexture,
  });
  const composer = new EffectComposer(renderer, target);

  const entries = new Map<string, Entry>();
  let seq = 0;
  let width = Math.max(1, opts.width);
  let height = Math.max(1, opts.height);

  const cmp = (a: Entry, b: Entry) =>
    ANCHOR_RANK[a.anchor] - ANCHOR_RANK[b.anchor] || a.priority - b.priority || a.seq - b.seq;

  /** 重排 composer.passes —— 走 addPass 而不是直接改数组，是为了让 pass 拿到 setSize。 */
  function rebuild() {
    const sorted = [...entries.values()].sort(cmp);
    composer.passes.length = 0;
    for (const e of sorted) composer.addPass(e.pass);
  }

  function applyParams(pass: Pass, params: Record<string, ParamValue>, id: string) {
    const uniforms = uniformsOf(pass);
    for (const [name, value] of Object.entries(params)) {
      if (!uniforms?.[name]) {
        opts.notices?.warn('pass-skipped', `pass「${id}」没有 uniform「${name}」，参数未应用。`, {
          id,
          detail: { param: name },
        });
        continue;
      }
      uniforms[name].value = value;
    }
  }

  const chain: PostChain = {
    composer,

    get order() {
      return [...entries.values()].sort(cmp).map((e) => e.id);
    },

    get depthTexture() {
      return composer.renderTarget1.depthTexture ?? null;
    },

    add(pass, options) {
      const id = options.id;
      if (!id) throw new Error('[post] pass 必须有 id');
      if (entries.has(id)) throw new Error(`[post] pass id 重复：${id}`);

      const anchor = options.anchor ?? 'beforeTonemap';
      if (STRUCTURAL.includes(anchor) && options.internal !== true) {
        throw new Error(
          `[post] 锚点「${anchor}」是引擎结构锚点（ToneMap / Encode 两段之间），不能插用户 pass。`
          + '用 afterTonemap（显示参考、未编码）或 beforeTonemap（线性 HDR）。',
        );
      }

      const reads = options.reads ?? ['color'];
      if (reads.includes('normal')) {
        throw new Error(
          `[post] pass「${id}」声明读取 normal，但法线缓冲需要 MRT，three 的内建材质不写第二附件。`
          + '当前只提供 color 与 depth（文档 §2.2-⑧）。',
        );
      }
      if (reads.includes('depth') && !depthTexture) {
        throw new Error(
          `[post] pass「${id}」声明读取 depth，但建链时关了深度缓冲（depth: false）。`
          + '去掉那个选项，或别声明 reads: [\'depth\']。',
        );
      }

      entries.set(id, {
        id,
        pass,
        anchor,
        priority: options.priority ?? 100,
        seq: seq++,
        locked: options.locked ?? false,
      });
      pass.enabled = options.enabled ?? true;
      rebuild();
      // 尺寸交给 composer.addPass（它按 pixelRatio 算设备像素），这里不要再 setSize 一次
    },

    insert(desc) {
      const pass = desc.create({ renderer, width, height, params: opts.params ?? null });
      this.add(pass, desc);
      if (desc.params) applyParams(pass, desc.params, desc.id);
    },

    remove(id) {
      const e = entries.get(id);
      if (!e) return;
      if (e.locked) throw new Error(`[post] pass「${id}」被锁定，不能移除`);
      entries.delete(id);
      rebuild();
      const p = e.pass as Pass & { dispose?: () => void };
      p.dispose?.();
    },

    has(id) {
      return entries.has(id);
    },

    get<T extends Pass = Pass>(id: string) {
      return (entries.get(id)?.pass ?? null) as T | null;
    },

    setEnabled(id, on) {
      const e = entries.get(id);
      if (!e) throw new Error(`[post] 没有这个 pass：${id}`);
      if (e.locked && !on) throw new Error(`[post] pass「${id}」被锁定，不能关闭`);
      e.pass.enabled = on;
    },

    isEnabled(id) {
      const e = entries.get(id);
      if (!e) throw new Error(`[post] 没有这个 pass：${id}`);
      return e.pass.enabled;
    },

    setParams(id, params) {
      const e = entries.get(id);
      if (!e) throw new Error(`[post] 没有这个 pass：${id}`);
      applyParams(e.pass, params, id);
    },

    setSize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      composer.setSize(width, height);
    },

    render(dt) {
      composer.render(dt);
    },

    dispose() {
      for (const e of entries.values()) {
        const p = e.pass as Pass & { dispose?: () => void };
        p.dispose?.();
      }
      entries.clear();
      composer.passes.length = 0;
      // composer.dispose 会连带释放 RT1/RT2（深度纹理挂在 RT 上，一并释放）
      composer.dispose();
    },
  };

  return chain;
}
