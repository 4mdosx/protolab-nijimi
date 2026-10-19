/**
 * 深度预 pass（DepthPrepass）—— 在主渲染**之前**，把场景深度渲进一张独立图。
 *
 * 为什么需要它（P2 留下的账，见 docs/渲染管线-着色器扩展与钩子系统.md §5.3-③）：
 * `post.depthTexture` 是 RenderPass 写进 `renderTarget1` 的那个深度，它在**场景渲完之后**
 * 才存在；而软粒子要的是「场景渲染**期间**能读到的不透明几何深度」。两者时序不同，
 * 不是同一个缓冲，所以只能在场景之前多渲一遍深度。
 *
 * 三个设计取舍：
 *   ① **只渲深度**：`MeshDepthMaterial` + `colorWrite: false`，颜色附件一点都不写；
 *      尺寸默认 0.5 倍（软粒子只需要「离几何多远」，不需要几何细节）。
 *   ② **不掺透明件**：预 pass 会把透明/不写深度的对象临时隐藏——粒子和贴片自己写进
 *      深度图就会「自己遮自己」，软淡出立刻失效。
 *   ③ **不重复渲阴影**：`shadowMap.autoUpdate = false` 跑这一遍，否则每帧阴影贴图渲两次。
 *
 * 用法（软粒子是唯一的使用者，入口在 `applySoftParticles`）：
 *
 *   const depth = createDepthPrepass({ renderer, scene, camera });
 *   // 每帧、在 post.render 之前：
 *   depth.update();
 *   applySoftParticles(pointsMaterial, depth);
 *
 * 舞台把它包成了 `createStage(el, { softParticles: true })`，内容包从
 * `ScenePackContext.depth` 拿到同一个句柄。
 */

import * as THREE from 'three';

export interface DepthPrepassOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** 需要 near/far（两种相机都有；正交与透视的线性化不同，见模块里的 GLSL） */
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  /**
   * 深度图相对 canvas 设备像素的倍率，默认 0.5。
   * 深度纹理只能用 NEAREST 采样（WebGL2 的 depth 纹理不支持线性过滤），
   * 0.5 倍就是「软淡出的边缘按 2 像素量化」——软粒子本来就模糊，看不出来；
   * 需要更细（例如按深度做描边）时传 1。
   */
  scale?: number;
  notices?: import('./notice').NoticeSink;
}

/** 软粒子/深度模块绑的就是这几个对象（保持引用稳定，材质只绑一次） */
export interface DepthUniforms {
  uSceneDepth: THREE.IUniform<THREE.Texture | null>;
  uDepthTexel: THREE.IUniform<THREE.Vector2>;
  uNearFar: THREE.IUniform<THREE.Vector2>;
  uOrtho: THREE.IUniform<number>;
}

export interface DepthPrepassStats {
  /** 上一次 update 临时隐藏的对象数（透明件 + 非网格 + 显式排除） */
  hidden: number;
  width: number;
  height: number;
  scale: number;
}

export interface DepthPrepass {
  /** 场景不透明几何的深度（[0,1] 窗口深度，NEAREST） */
  readonly texture: THREE.DepthTexture;
  readonly uniforms: DepthUniforms;
  /** 验收/调试用（改了一次隐藏多少对象、缓冲多大） */
  readonly stats: DepthPrepassStats;
  /** 渲染本帧的深度。舞台在 post.render 之前调用。 */
  update(): void;
  /** 逻辑尺寸（CSS px）；内部按 renderer 的 pixelRatio 与 scale 换算 */
  setSize(width: number, height: number): void;
  dispose(): void;
}

/** 这个对象该不该进深度预 pass（不该 → 临时隐藏） */
function opaqueForDepth(object: THREE.Object3D): boolean {
  const mesh = object as THREE.Mesh;
  // 点/线/精灵没有「表面」，写进来会是一条条假几何
  if (!mesh.isMesh) return false;
  if (object.userData.nijimiDepthExclude === true) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  // 至少要有一份「不透明且写深度」的材质；混合材质里那份透明的会漏进来一点，
  // 但把它藏了会连不透明部分一起丢——宁可多一点点遮挡。
  return mats.some((m) => m && m.transparent !== true && m.depthWrite !== false);
}

export function createDepthPrepass(opts: DepthPrepassOptions): DepthPrepass {
  const { renderer, scene, camera } = opts;
  const scale = Math.min(1, Math.max(0.1, opts.scale ?? 0.5));

  const depthTexture = new THREE.DepthTexture(1, 1);
  depthTexture.name = 'nijimi/depth-prepass';
  const target = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.name = 'nijimi/depth-prepass/color';

  const material = new THREE.MeshDepthMaterial({ colorWrite: false });
  material.name = 'nijimi/DepthPrepass';

  const uniforms: DepthUniforms = {
    uSceneDepth: { value: depthTexture },
    uDepthTexel: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
    uOrtho: { value: (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0 },
  };

  const stats: DepthPrepassStats = { hidden: 0, width: 1, height: 1, scale };

  function resizeTarget(cssWidth: number, cssHeight: number) {
    const dpr = renderer.getPixelRatio();
    const w = Math.max(1, Math.round(Math.max(1, cssWidth) * dpr * scale));
    const h = Math.max(1, Math.round(Math.max(1, cssHeight) * dpr * scale));
    if (w === stats.width && h === stats.height && depthTexture.image.width === w) return;
    target.setSize(w, h);
    stats.width = w;
    stats.height = h;
    uniforms.uDepthTexel.value.set(1 / w, 1 / h);
  }

  let disposed = false;

  const prepass: DepthPrepass = {
    texture: depthTexture,
    uniforms,
    stats,

    update() {
      if (disposed) return;
      uniforms.uNearFar.value.set(camera.near, camera.far);
      uniforms.uOrtho.value = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;

      // 透明件/非网格临时隐藏。每帧重走一遍而不是缓存列表：角色是异步加载的，
      // 缓存要么失效要么要维护版本号——diorama 规模下这点遍历远小于一次 GPU pass。
      const hidden: THREE.Object3D[] = [];
      const visit = (object: THREE.Object3D) => {
        if (!object.visible) return; // 父节点已经隐藏，子树自然不进渲染
        if (object.userData.nijimiDepthExclude === true) {
          hidden.push(object);
          return;
        }
        const renderable = (object as THREE.Mesh).isMesh
          || (object as THREE.Points).isPoints
          || (object as THREE.Line).isLine
          || (object as THREE.Sprite).isSprite;
        if (renderable && !opaqueForDepth(object)) {
          hidden.push(object);
          return;
        }
        for (const child of object.children) visit(child);
      };
      for (const child of scene.children) visit(child);

      const prevTarget = renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      const prevShadowAuto = renderer.shadowMap.autoUpdate;

      for (const o of hidden) o.visible = false;
      scene.overrideMaterial = material;
      // 这一遍不需要阴影：不关掉的话每帧阴影贴图会渲两次（灯光多时是实打实的开销）
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);

      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      for (const o of hidden) o.visible = true;

      stats.hidden = hidden.length;
    },

    setSize(width, height) {
      resizeTarget(width, height);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // texture 挂在 target 上，target.dispose 会一并释放
      target.dispose();
      material.dispose();
      uniforms.uSceneDepth.value = null;
    },
  };

  resizeTarget(renderer.domElement.clientWidth || 1, renderer.domElement.clientHeight || 1);
  return prepass;
}
