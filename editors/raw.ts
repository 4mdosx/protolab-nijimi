/**
 * 原版资产对照加载器（**编辑器专用**）。
 *
 * 运行期代码只认契约（src/render/character.ts 的 loadCharacter）。这个模块为了
 * 回归对照而存在：同一机位切「契约版 / 原版」，看契约映射到底改了什么。
 * 它不做任何契约施加，材质判定退回名字兜底（npr.ts 的 classifyMaterial）。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CharacterHandles } from '../src/character';
import { ExpProtocol } from '../src/exp-protocol';

const loader = new GLTFLoader();

export interface RawLoadOptions {
  targetHeight?: number;
  /** 编辑器摆正角（从 manifest 的档案里取） */
  defaultRotY?: number;
}

export async function loadRawModel(id: string, opts: RawLoadOptions = {}): Promise<CharacterHandles> {
  const { targetHeight = 1.55, defaultRotY = 0 } = opts;
  const gltf = await new Promise<Awaited<ReturnType<typeof loader.loadAsync>>>((resolve, reject) => {
    loader.load(`/models/${id}.glb`, resolve, undefined, reject);
  });

  // 归一化（与 src/render/character.ts 的 normalizeModel 同规则，故意不共享——
  // 对照路径一旦共享实现就不再是独立对照了）
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const k = targetHeight / size.y;
  gltf.scene.scale.setScalar(k);
  gltf.scene.position.y += -box.min.y * k;
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; }
  });

  const group = new THREE.Group();
  group.add(gltf.scene);

  const face = new THREE.PointLight(0xffe8d0, 1.4, 2.6, 1.9);
  face.position.set(0, 1.25, -0.95);
  group.add(face);
  const rim = new THREE.PointLight(0xffd0a0, 2.6, 3.0, 1.8);
  rim.position.set(0.3, 1.2, 0.55);
  group.add(rim);

  return {
    group,
    position: group.position,
    mixer: null,
    exp: new ExpProtocol({ expr: null, slots: {}, modelId: id }),
    defaultRotY,
    charter: null,
    report: { bound: 0, unbound: [], roles: {}, modelId: null, morphOnlyHidden: [] },
  };
}
