/** 角色着色准备：所有契约角色入口共用；编辑器参数在准备完成后应用。 */
import * as THREE from 'three';
import type { CharacterHandles } from './character';
import { applyNprToObject, configureNprMesh, toNprMaterial, type NprUniforms } from './npr';
// 登记随引擎发布的模块：契约里的 `dissolve@1` 只有在模块文件被 import 过之后
// 才存在于注册表里，缺这一步的表现是「效果静默消失」而不是报错。
import './shader/builtins';
import { resolveModules, type ShaderModule } from './shader/module';
import type { NoticeSink } from './notice';

export type FaceSdfState =
  | { status: 'absent'; texture: null }
  | { status: 'ready'; url: string; texture: THREE.Texture }
  | { status: 'failed'; url: string; texture: null; error: unknown };

export interface CharacterRendering {
  readonly faceSdf: FaceSdfState;
  /** 人物编辑器可延后切入 NPR，并保留原材质作对照。 */
  createMaterial(source: THREE.Material): THREE.Material;
  /** 舞台、动作台直接切入 NPR。每个角色只调用一次。 */
  apply(): void;
  /** 释放此准备过程加载的 SDF；网格/材质仍由角色持有者释放。 */
  dispose(): void;
}

export interface PrepareCharacterRenderingOptions {
  /** 默认 false，各入口采用相同金属策略。 */
  stylizeMetal?: boolean;
  /** 可替换的资源加载边界，默认使用 TextureLoader。 */
  loadTexture?: (url: string) => Promise<THREE.Texture>;
  /** 内容侧追加到表面的着色模块（层 A）；只作用于 NPR / PBR 轨道 */
  modules?: readonly ShaderModule[];
  /** 降级/冲突提示出口 */
  notices?: NoticeSink;
}

/** absent 是合法能力缺省；failed 是资产故障，明确提示后回退普通 NPR。 */
export async function prepareCharacterRendering(
  character: Pick<CharacterHandles, 'group' | 'charter'>,
  uniforms: NprUniforms,
  options: PrepareCharacterRenderingOptions = {},
): Promise<CharacterRendering> {
  let faceSdf: FaceSdfState = { status: 'absent', texture: null };
  const file = character.charter?.faceSdf;
  if (file) {
    const url = `/models/${file}`;
    try {
      const texture = await (options.loadTexture ?? ((path) => new THREE.TextureLoader().loadAsync(path)))(url);
      texture.colorSpace = THREE.NoColorSpace;
      faceSdf = { status: 'ready', url, texture };
    } catch (error) {
      faceSdf = { status: 'failed', url, texture: null, error };
      console.warn(`[${character.charter?.id}] SDF 加载失败，回退普通 NPR: ${url}`, error);
    }
  }
  // 模型级契约着色（scene.extras.charter.shader）：全身生效，排在内建 NPR 之后。
  // 缺失的模块降级跳过 + notice——资产与代码的版本错位不该让整具模型不可见。
  const charterIds = character.charter?.shader?.modules ?? [];
  const resolved = resolveModules(charterIds);
  if (resolved.missing.length > 0) {
    options.notices?.warn(
      'module-missing',
      `模型「${character.charter?.id ?? '?'}」声明的着色模块未注册：${resolved.missing.join(', ')}。已跳过。`,
      { id: resolved.missing[0], detail: { missing: resolved.missing } },
    );
  }
  const modules = [...resolved.modules, ...(options.modules ?? [])];

  const materialOptions = {
    stylizeMetal: options.stylizeMetal ?? false,
    faceSdf: faceSdf.texture,
    modules,
    notices: options.notices,
  };
  character.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) configureNprMesh(mesh);
  });
  let applied = false;
  let disposed = false;
  const assertLive = () => {
    if (disposed) throw new Error('角色着色资源已释放');
  };
  return {
    faceSdf,
    createMaterial(source) {
      assertLive();
      // PBR 转换会就地注入；克隆保证原版/贴图对照不受污染。
      const clone = source.clone();
      const converted = toNprMaterial(clone, uniforms, materialOptions);
      if (converted !== clone) clone.dispose();
      return converted;
    },
    apply() {
      assertLive();
      if (applied) return;
      applyNprToObject(character.group, uniforms, materialOptions);
      applied = true;
    },
    dispose() {
      if (disposed) return;
      faceSdf.texture?.dispose();
      disposed = true;
    },
  };
}

export function faceSdfStatusText(state: FaceSdfState): string {
  switch (state.status) {
    case 'absent': return 'SDF：未声明（普通 NPR）';
    case 'ready': return 'SDF：已就绪';
    case 'failed': return 'SDF：加载失败（已回退普通 NPR）';
  }
}

/** 异步切换中被更新请求取代的角色尚未发布，释放其独占资源。 */
export function discardPreparedCharacter(
  character: Pick<CharacterHandles, 'group'>,
  rendering: CharacterRendering,
): void {
  rendering.dispose();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  character.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
