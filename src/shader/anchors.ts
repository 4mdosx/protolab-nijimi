/**
 * 注入锚点 —— 把「往 shader 里插一段 GLSL」从字符串魔法变成有名字的语义位置。
 *
 * 为什么必须收编（文档 §2.2-⑥）：`String.replace('#include <opaque_fragment>', ...)`
 * 在 three 换 chunk 名时**静默返回原串**——NPR 整体失效，画面「看起来还行」，
 * 没有任何报错。r152→r186 已经改过一次（vUv 的声明条件）。
 *
 * 纪律：
 *   ① 锚点缺失 = **抛错**，不静默；
 *   ② chunk 名只在这张表里出现一次，升级 three 只改这张表；
 *   ③ 本文件**不依赖 three**（纯字符串处理），`pipeline/` 的 Node 脚本可以直接 import。
 */

export type FragAnchor =
  /** 声明区：`#include <common>` 之后。uniform / varying / 工具函数放这里 */
  | 'common'
  /** 贴图已采样：diffuseColor 已乘 map */
  | 'map'
  /** 法线贴图已作用 */
  | 'normal'
  /** PBR 光照算完：reflectedLight 就绪 */
  | 'lightsEnd'
  /** 自发光已叠加 */
  | 'emissive'
  /** 写 gl_FragColor 之前：outgoingLight / totalEmissiveRadiance 可改（NPR 用的点） */
  | 'beforeOutput'
  /** gl_FragColor 已写、dithering 之后：只能改最终像素 */
  | 'afterOutput';

export type VertAnchor =
  /** 声明区 */
  | 'common'
  /** begin_vertex 之后：transformed 已就绪 */
  | 'begin'
  /** skinning_vertex 之后：transformed/objectNormal 已被骨骼变换 */
  | 'skinning'
  /** worldpos_vertex 之后：世界坐标可用 */
  | 'worldpos'
  /** beginnormal_vertex 之后：objectNormal 就绪 */
  | 'normal';

export interface AnchorSpec {
  /** three 的 chunk 包含语句，原样匹配 */
  chunk: string;
  /** 插在 chunk 之前还是之后 */
  at: 'before' | 'after';
}

export const FRAG_ANCHORS: Record<FragAnchor, AnchorSpec> = {
  common:       { chunk: '#include <common>',              at: 'after'  },
  map:          { chunk: '#include <map_fragment>',         at: 'after'  },
  normal:       { chunk: '#include <normal_fragment_maps>', at: 'after'  },
  lightsEnd:    { chunk: '#include <lights_fragment_end>',  at: 'after'  },
  emissive:     { chunk: '#include <emissivemap_fragment>', at: 'after'  },
  beforeOutput: { chunk: '#include <opaque_fragment>',      at: 'before' },
  afterOutput:  { chunk: '#include <dithering_fragment>',   at: 'after'  },
};

export const VERT_ANCHORS: Record<VertAnchor, AnchorSpec> = {
  common:   { chunk: '#include <common>',            at: 'after' },
  begin:    { chunk: '#include <begin_vertex>',      at: 'after' },
  skinning: { chunk: '#include <skinning_vertex>',   at: 'after' },
  worldpos: { chunk: '#include <worldpos_vertex>',   at: 'after' },
  normal:   { chunk: '#include <beginnormal_vertex>', at: 'after' },
};

export interface AnchorContext {
  /** 出错时报告给谁看：模块 id + 锚点名 */
  moduleId: string;
  anchor: string;
  /** three 版本号，只用于报错文案（升级后一眼知道该改这张表） */
  revision?: string;
}

/**
 * 在 `src` 里找锚点并插入 `code`。找不到就抛——这是这个文件存在的全部理由。
 * 幂等性由调用方负责（同一份源码多次注入同一段代码会重复，这里不查重）。
 */
export function injectAt(src: string, spec: AnchorSpec, code: string, ctx: AnchorContext): string {
  if (!code) return src;
  const i = src.indexOf(spec.chunk);
  if (i < 0) {
    throw new Error(
      `[shader] 模块「${ctx.moduleId}」的锚点「${ctx.anchor}」缺失：找不到 ${spec.chunk}。`
      + (ctx.revision ? `three 版本 ${ctx.revision} 的 chunk 名可能已变，` : '')
      + '请改 src/shader/anchors.ts 的锚点表（或确认该材质确实有这一段）。',
    );
  }
  const cut = spec.at === 'before' ? i : i + spec.chunk.length;
  return src.slice(0, cut) + '\n' + code + src.slice(cut);
}
