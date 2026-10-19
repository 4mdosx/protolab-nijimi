/**
 * 软粒子的接线处 —— 把 `soft-particles` 模块 + 深度预 pass 的 uniform 装到材质上。
 *
 * 为什么单独一层而不是在模块里做：模块必须是**纯数据**（`pipeline/` 的 Node 脚本要 import
 * 它做校验，不能带 three）。而这里要碰 `THREE.IUniform`、要调 `extendMaterial`，
 * 所以分成「数据（modules/soft-particles.ts）+ 接线（本文件）」两半。
 *
 * 三件事一次做完：
 *   ① 把深度预 pass 的四个 uniform **以引用形式**塞进材质（不 clone——每帧 engine 会改它们）；
 *   ② `uSoftDistance` 登记进参数总线（编辑器滑杆与演出曲线都靠它，不必自己 new uniform）；
 *   ③ 不透明材质报警（装上了也不会有任何效果，属于「作者以为加了效果」的典型）。
 */

import type * as THREE from 'three';
import type { DepthPrepass, DepthUniforms } from './depth-prepass';
import { extendMaterial } from './shader/material';
import { softParticles } from './shader/modules/soft-particles';
import type { ParamBus } from './shader/params';
import type { NoticeSink } from './notice';

export interface SoftParticlesOptions {
  /** 参数总线：给了才能被编辑器/演出驱动 `uSoftDistance` */
  params?: ParamBus;
  notices?: NoticeSink;
  /**
   * 过渡距离（世界单位），默认 0.35；**0 = 关**（注入仍然发生，但只多一次分支）。
   * 只在该参数还没进总线时使用——别人已经标定过的值不会被覆盖。
   */
  distance?: number;
  /** 追加到变体键的标签（同材质不同用法时用；一般不传） */
  tag?: string;
}

/** 需要哪几个深度 uniform：`DepthPrepass` 或它裸露的 `uniforms` 都吃 */
function depthUniforms(depth: DepthPrepass | DepthUniforms): DepthUniforms {
  return 'uniforms' in depth ? depth.uniforms : depth;
}

/**
 * 给一个材质装上软粒子。返回变体键（调试/断言用）。
 * 只对 `transparent` 材质有意义：不透明材质的 alpha 不参与混合。
 */
export function applySoftParticles<T extends THREE.Material>(
  mat: T,
  depth: DepthPrepass | DepthUniforms,
  opts: SoftParticlesOptions = {},
): string {
  if (mat.transparent !== true) {
    opts.notices?.warn(
      'material-unsuitable',
      `材质「${mat.name || mat.type}」装了软粒子但它不是透明材质：alpha 不参与混合，效果看不到。`,
      { id: mat.name || mat.type, detail: { module: softParticles.id } },
    );
  }

  const bus = opts.params;
  const distance = opts.distance ?? 0.35;
  if (bus && !bus.has('uSoftDistance')) bus.declare('uSoftDistance', distance, 'float');

  return extendMaterial(mat, [softParticles], {
    params: bus,
    // 深度 uniform 每帧由引擎写，必须**同一个对象**；extra 优先级高于总线
    extra: { ...depthUniforms(depth) },
    notices: opts.notices,
    tag: opts.tag,
  });
}

/**
 * 给一棵子树里所有材质装软粒子（烟幕面片、光柱这类「一批同款材质」的常见形态）。
 * 返回装上的材质数——0 通常意味着树里没有透明材质。
 */
export function applySoftParticlesTo(
  root: THREE.Object3D,
  depth: DepthPrepass | DepthUniforms,
  opts: SoftParticlesOptions = {},
): number {
  const seen = new Set<THREE.Material>();
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh && !(object as THREE.Points).isPoints) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.transparent !== true) continue;
      applySoftParticles(m, depth, opts);
      count++;
    }
  });
  return count;
}
