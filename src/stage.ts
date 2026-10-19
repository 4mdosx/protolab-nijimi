/**
 * 舞台（Stage）—— 引擎的**技术总装**：渲染器 / 灯光 / IBL / NPR / 正交 diorama 相机 /
 * 视窗缩放平移 / 后期（Bloom + 调色）/ 帧循环 / 角色加载。
 *
 * ⚠️ 它**不认识任何具体场景**：场景内容由 `pack`（ScenePack，见 src/scenes/types.ts）注入。
 * 引擎自带示例包 `scenes/workshop.ts`；内容侧实现同一接口就能换自己的房间/关卡，
 * 不需要改这个文件（迁移路径见 docs/职责边界.md）。
 *
 * 动画层帧率可配置（房间渲染架构的分层接口，MVP 跑 30fps）：内容动画统一在
 * `pack.update(animStep, elapsed)` 里推进，别用真实帧 dt。
 *
 * 2026-10-17（P0 管线修复，见 docs/渲染管线-着色器扩展与钩子系统.md §5）：
 *   - **渲染每帧**，动画层用累加器推进（原本整条 composer.render 被 30fps 闸门包住，
 *     相机交互跟着掉到 30fps，慢帧还会丢时间）；
 *   - 后期交给 `post` 链（`src/post.ts`）：Bloom 只是链上一段，关掉它不再绕过调色与输出；
 *   - `setNpr` 不再顺手关调色（材质层与后期层解耦）；
 *   - 补 dispose / ResizeObserver / context lost 处理。
 *
 * 2026-10-17（P3 ⊕ 软粒子）：`softParticles` 选项会在主渲染之前多渲一遍场景深度
 * （`src/depth-prepass.ts`），内容包通过 `ScenePackContext.depth` 拿到它。
 * 这是**场景渲染期**的深度；`post.depthTexture` 是场景渲完之后才有的那个，两者不是一回事。
 */

import * as THREE from 'three';
import { loadCharacter, loadProps, type CharacterHandles } from './character';
import { prepareCharacterRendering, type CharacterRendering } from './character-rendering';
import { workshopScene } from './scenes/workshop';
import type { ScenePack } from './scenes/types';
import {
  applyEnvironment,
  createColoredEnvironment,
  createGradePass,
  createNprUniforms,
  updateNprUniforms,
  type NprUniforms,
} from './npr';
import { createPostChain, type PostChain } from './post';
import { createToneMapPass, createEncodePass } from './output-passes';
import { createNoticeSink, type Notice, type NoticeSink } from './notice';
import { createEffects, type Effects } from './effects';
import { createDepthPrepass, type DepthPrepass } from './depth-prepass';
import { createParamBus, type ParamBus } from './shader/params';
import { declareModuleParams } from './shader/material';
import { createFrameClock, type FrameClock, type FrameContext } from './frame';
import type { ShaderModule } from './shader/module';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export const ANIM_FPS = 30;
/** 慢帧最多补几步动画（防止一次卡顿后连跑十几步雪崩） */
const MAX_CATCHUP_STEPS = 5;

/** 取景：场景任一维不超过视窗的 62%（四周留白给背景） */
const ROOM_FRAC = 0.62;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3.2;
const ZOOM_DEFAULT = 1.35;

export interface Stage<H = unknown> {
  renderer: THREE.WebGLRenderer;
  camera: THREE.OrthographicCamera;
  scene: THREE.Scene;
  /** 内容包句柄（房间锚点/灯位/粒子等的联合体，类型由内容包给出） */
  content: H;
  /** raycast 用（挂交互层） */
  raycaster: THREE.Raycaster;
  /**
   * 后期链：唯一定义「一帧长什么样」的地方。
   * 内容侧要加全屏效果走 `post.add(pass, { id, anchor })`，不要自己建 EffectComposer
   * （编辑器里三套 composer 已经让「编辑器看到的」和「运行时看到的」不是同一张画）。
   */
  post: PostChain;
  resize(): void;
  /** 视窗 rig：虚拟视窗（box）内缩放 / 平移，窗口本身大小不变 */
  view: {
    zoom: number;
    /** f > 1 放大；ndc 为缩放锚点（省略则缩放视窗中心） */
    zoomBy(f: number, ndc?: { x: number; y: number }): void;
    /** 按屏幕像素平移（拖拽） */
    panByPx(dxPx: number, dyPx: number): void;
    reset(): void;
  };
  /** 渲染一帧（dt 为真实秒；每帧都渲，不等动画步长） */
  render(dt: number, elapsed: number): void;
  /** 参数总线：具名 uniform + 内建时间/相机参数（内容侧写效果参数走这里） */
  params: ParamBus;
  /**
   * 深度预 pass（`softParticles` 打开时非 null）：**场景渲染期**的不透明几何深度。
   * 软粒子/软贴面用它，别再拿 `post.depthTexture`（那是场景渲完之后才有的）。
   */
  readonly depth: DepthPrepass | null;
  /**
   * 效果时间线（演出）：`stage.effects.play(chargeBurst())`。
   * 用**真实 dt** 推进；参数写入者固定为 `fx:<id>`，与别人的写入冲突会被审计拒绝。
   * 材质侧能力（rim-pulse / dissolve）要在建舞台时通过 `characterModules` 装好。
   */
  effects: Effects;
  /** 降级/冲突提示（`param-conflict` / `module-missing` / `pass-skipped` …） */
  notices: NoticeSink;
  onNotice(listener: (n: Notice) => void): () => void;
  /**
   * 每帧钩子（真实时间，在任何 GPU 工作之前调用）。
   * 效果时间线、参数驱动放这里——别塞进内容包的 1/30 动画步长。
   */
  onFrame(listener: (ctx: FrameContext) => void): () => void;
  /** 当前帧的只读快照（帧循环外读到的永远是上一帧） */
  readonly frame: FrameContext;
  /** Bloom 开关（氛围主角可 A/B；默认开）。只关链上这一段，调色与输出照常。 */
  setBloom(on: boolean): void;
  /** NPR 手法开关（终末地复刻子集；默认开，?npr=0 关）。只管材质，不碰后期。 */
  setNpr(on: boolean): void;
  /** 角色句柄（异步加载，可能为 null） */
  character(): CharacterHandles | null;
  /** SDF 加载状态与角色着色资源；加载完成前为 null。 */
  characterRendering(): CharacterRendering | null;
  /**
   * 世界坐标 → 页面客户端像素（交互层把 3D 端口 / 设备投回 DOM 芯片位置用）。
   * 投影属于渲染职责，所以游戏侧不需要碰相机与矩阵。
   */
  clientPos(world: THREE.Vector3): { x: number; y: number };
  /** 取 Object3D 的世界坐标 → 页面客户端像素（同上） */
  objectClientPos(obj: THREE.Object3D): { x: number; y: number };
  /**
   * 释放舞台独占的资源（后期链 / IBL / 渲染器 / 监听 / canvas）。
   * 场景内容与共享材质单例（`modernMaterials()`）**不在这里释放**：它们跨舞台存活，
   * 由内容层持有。切换编辑器时调用本函数，别只把 DOM 扔掉。
   */
  dispose(): void;
  /** 调试句柄（编辑器用；业务侧不碰） */
  debug: {
    lights: {
      hemi: THREE.HemisphereLight;
      key: THREE.DirectionalLight;
      moon: THREE.DirectionalLight;
      fill: THREE.PointLight;
    };
    bloomPass: UnrealBloomPass;
    post: PostChain;
    params: ParamBus;
    clock: FrameClock;
    depth: DepthPrepass | null;
  };
}

export interface StageOptions<H> {
  /** 内容包（省略 = 引擎自带示例：工坊 diorama） */
  pack?: ScenePack<H>;
  /** 加载角色与陈设（默认 true；场景编辑器关掉它做纯环境调试） */
  withCharacter?: boolean;
  /** 角色资产 id（契约版模型，默认 yelan） */
  characterId?: string;
  /** 加载静态陈设（默认跟随 withCharacter） */
  withProps?: boolean;
  /**
   * 追加到角色表面的着色模块（层 A 的扩展点）。
   * 只作用于 NPR / PBR 轨道——它们才有 `nprN` / `nprOut` 这套表面作用域；
   * unlit 与描边壳不接模块（硬塞会编译失败）。
   */
  characterModules?: readonly ShaderModule[];
  /**
   * 软粒子：主渲染**之前**多渲一遍场景深度（`src/depth-prepass.ts`），
   * 让粒子/烟幕按「离几何多远」淡出，而不是被深度测试硬切。
   *
   * 默认关：它是一整遍额外的场景 pass，值不值得由内容侧决定。打开后内容包从
   * `ScenePackContext.depth` 拿到深度句柄，交给 `applySoftParticles` 或
   * `new ElementParticles(..., { depth })`。
   *
   * `scale` 是深度图相对 canvas 设备像素的倍率（默认 0.5）。
   */
  softParticles?: boolean | { scale?: number };
}

/** 建舞台。容器尺寸决定视窗，内容包决定「里面有什么」。 */
export function createStage<H = unknown>(
  container: HTMLElement,
  opts: StageOptions<H> = {},
): Stage<H> {
  const pack = (opts.pack ?? (workshopScene as unknown as ScenePack<H>));
  const {
    withCharacter = true,
    characterId = 'yelan',
    withProps = withCharacter,
    characterModules = [],
  } = opts;

  // 提示通道与参数总线：整条舞台共用一条（材质、后期、内容侧都往这里写）
  const notices = createNoticeSink();
  const params = createParamBus({ notices });
  // 内容侧可能在角色加载完成前就写效果参数：先把模块声明的参数登记进总线
  declareModuleParams(params, characterModules);

  // 透明渲染：房间是悬浮 diorama，背景交给页面 CSS（桌宠多窗口前置形态）
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186：PCFSoft 已移除
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // ---- 灯光（现代魔法世界：冷底 + 暖光，终末地纪律的温馨版）----
  // 环境冷底（紫蓝 hemisphere + 低 Ambient），暖色只走点光/方向光——
  // 「暖光是画面唯一高饱和区」白捡构图焦点（融合定稿 §2.6）。
  const hemi = new THREE.HemisphereLight(0x565a8a, 0x241d2e, 0.5);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x3a3355, 0.55));

  // 主光：暖色方向光（斜射，勾出黄铜与长袍的体积）
  const key = new THREE.DirectionalLight(0xffc890, 1.35);
  key.position.set(-3.5, 5.5, 2.6);
  key.target.position.set(0.3, 0.6, 0.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -7;
  key.shadow.camera.far = 16;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);

  // 窗外暮光（冷色补形，压低不抢暖）
  const moon = new THREE.DirectionalLight(0xb8cce8, 0.55);
  moon.position.set(2.2, 2.6, -2.2);
  scene.add(moon);

  // 房间常驻暖补光（壁炉/坩埚点光之外的环境暖）
  const fill = new THREE.PointLight(0xffd9a0, 6, 10, 1.6);
  fill.position.set(1.9, 1.8, -2.4);
  scene.add(fill);

  // ---- NPR 复刻子集（终末地/少前2 手法，验证记录见 docs/NPR渲染复刻-*.md）----
  // ① 彩色 IBL：只作用于 PBR 轨道（黄铜/铁/石材），给金属件带颜色的间接光；
  //    NPR 轨道走灯光，互不干扰。
  // ② 角色 NPR 注入：柔和 ramp + 冷暖撞色 + 随相机边缘光；环境材质不动（平涂是定稿）。
  const nprEnabled = new URLSearchParams(window.location.search).get('npr') !== '0';
  const nprUniforms: NprUniforms = createNprUniforms(params);
  const env = createColoredEnvironment(renderer, {
    sky: 0x4d5688, horizon: 0x746a86, ground: 0x382c3a,
    glow: 0xffc890, glowDir: new THREE.Vector3(-3.5, 5.5, 2.6).normalize(),
  });
  applyEnvironment(scene, env.texture, 0.6);
  nprUniforms.uNprEnable.value = nprEnabled ? 1 : 0;

  // ---- 正交等距相机（固定朝向，但可在虚拟视窗内缩放/平移）----
  // 视锥由「内容包声明的 span 占视口比例」反推：场景是视窗中央的悬浮 diorama，
  // 四周留白给背景。内容有多大由 pack 说，引擎不猜。
  const SPAN_W = pack.span.w;
  const SPAN_H = pack.span.h;
  const focus = pack.focus ?? [0, 0, 0];

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  const baseTarget = new THREE.Vector3(focus[0], focus[1], focus[2]);
  const target = baseTarget.clone();
  const camDir = new THREE.Vector3(1, 0.82, 1).normalize(); // 俯角约 30°，diorama 视角

  // 相机屏幕平面的右/上基向量（平移用）
  const camUp = new THREE.Vector3(0, 1, 0);
  const axisRight = new THREE.Vector3().crossVectors(camUp, camDir).normalize();
  const axisScreenUp = new THREE.Vector3().crossVectors(camDir, axisRight).normalize();

  let visW = 10;
  let visH = 10;
  let zoom = ZOOM_DEFAULT;

  function applyCamera() {
    camera.position.copy(target).addScaledVector(camDir, 18);
    camera.lookAt(target);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
  }

  /** 把视窗中心钳制在场景附近，避免平移到空白 */
  function clampTarget() {
    const px = new THREE.Vector3().subVectors(target, baseTarget);
    const x = px.dot(axisRight);
    const y = px.dot(axisScreenUp);
    const limX = Math.max(0.5, ((visW / zoom - SPAN_W) / 2) * 0.85);
    const limY = Math.max(0.4, ((visH / zoom - SPAN_H) / 2) * 0.85);
    const cx = THREE.MathUtils.clamp(x, -limX, limX);
    const cy = THREE.MathUtils.clamp(y, -limY, limY);
    px.set(0, 0, 0).addScaledVector(axisRight, cx - x).addScaledVector(axisScreenUp, cy - y);
    target.add(px);
  }

  // ---- 虚拟视窗 rig：box 大小恒定，只在 box 内部缩放/平移 ----
  const view: Stage<H>['view'] = {
    get zoom() {
      return zoom;
    },
    set zoom(_: number) {
      void _;
    },
    zoomBy(f: number, ndc?: { x: number; y: number }) {
      const z1 = zoom;
      const z2 = THREE.MathUtils.clamp(z1 * f, ZOOM_MIN, ZOOM_MAX);
      if (z2 === z1) return;
      // 缩放锚点：让锚点下的世界点保持不动（默认视窗中心）
      const nx = ndc ? ndc.x : 0;
      const ny = ndc ? ndc.y : 0;
      target
        .addScaledVector(axisRight, (nx * visW * (1 / z1 - 1 / z2)) / 2)
        .addScaledVector(axisScreenUp, (ny * visH * (1 / z1 - 1 / z2)) / 2);
      zoom = z2;
      clampTarget();
      applyCamera();
    },
    panByPx(dxPx: number, dyPx: number) {
      const wppX = visW / zoom / Math.max(1, container.clientWidth);
      const wppY = visH / zoom / Math.max(1, container.clientHeight);
      target.addScaledVector(axisRight, -dxPx * wppX).addScaledVector(axisScreenUp, dyPx * wppY);
      clampTarget();
      applyCamera();
    },
    reset() {
      zoom = ZOOM_DEFAULT;
      target.copy(baseTarget);
      applyCamera();
    },
  };

  // ---- 深度预 pass（软粒子的前提；不开就完全不存在这份开销）----
  // 位置在内容包之前：内容包建粒子时要拿到句柄（能力在加载期定死，运行期不再注入）。
  const softOpt = opts.softParticles;
  const depth = softOpt
    ? createDepthPrepass({
      renderer,
      scene,
      camera,
      scale: typeof softOpt === 'object' ? softOpt.scale : undefined,
      notices,
    })
    : null;

  // ---- 内容包（房间 / 工业簇 / 粒子 / 内容动画都归它）----
  const animStep = 1 / ANIM_FPS;
  const packInst = pack.build({ scene, animStep, depth, params });
  const content: H = packInst.handles;

  // ---- 角色与陈设（异步加载，失败不阻塞场景；场景编辑器 withCharacter=false 跳过）----
  let disposed = false;
  let character: CharacterHandles | null = null;
  let characterRendering: CharacterRendering | null = null;
  if (withCharacter) {
    loadCharacter(characterId)
      .then(async (c) => {
        const rendering = await prepareCharacterRendering(c, nprUniforms, {
          modules: characterModules,
          notices,
        });
        // 舞台可能在等待贴图期间就被销毁（编辑器快速切页）：别把资源挂进已死的舞台
        if (disposed) { rendering.dispose(); return; }
        if (nprEnabled) rendering.apply();
        characterRendering = rendering;
        character = c;
        scene.add(c.group);
      })
      .catch((e) => { console.warn(`[${characterId}] 加载失败，场景照常`, e); });
    if (withProps) {
      loadProps()
        .then((p) => { if (!disposed) scene.add(p); })
        .catch(() => { /* 同上 */ });
    }
  }

  const raycaster = new THREE.Raycaster();

  /** 世界点 → 页面客户端像素（与 DOM 层对齐的投影，交互层唯一需要的相机知识） */
  const _pv = new THREE.Vector3();
  function projectClient(world: THREE.Vector3): { x: number; y: number } {
    _pv.copy(world).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((_pv.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - _pv.y) / 2) * rect.height,
    };
  }

  // ---- 后期链 ----
  // 顺序即语义：RenderPass 出线性 HDR → Bloom → 调色 → OutputPass（色调映射 + sRGB 编码）。
  // 关掉 Bloom 只是 `pass.enabled = false`，链照常走完——这样 A/B 出来的差异只可能是 Bloom。
  const post = createPostChain(renderer, {
    width: Math.max(1, container.clientWidth),
    height: Math.max(1, container.clientHeight),
    samples: 4,
    type: THREE.HalfFloatType,
    params,
    notices,
  });
  post.add(new RenderPass(scene, camera), { id: 'scene', anchor: 'scene', priority: 0, locked: true });

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.62, 0.55, 0.74,
  );
  // Bloom 的合成用 AdditiveBlending（SrcAlpha, One），alpha 通道也会被加：
  // 实测空场景角落的 alpha 从 0 被抬到 1/255。RGB 保持加性，alpha 改成「只取目标值」，
  // 透明画布才能干净地交给页面 CSS（桌宠形态的前提）。
  // 注意 blendMaterial 是 premultipliedAlpha，three 对 AdditiveBlending 实际用的是
  // (ONE, ONE)——所以这里必须写 OneFactor，写成 SrcAlpha 会把辉光整体压暗（实测 RGB 掉一半）。
  const bloomBlend = bloomPass.blendMaterial;
  bloomBlend.blending = THREE.CustomBlending;
  bloomBlend.blendEquation = THREE.AddEquation;
  bloomBlend.blendSrc = THREE.OneFactor;
  bloomBlend.blendDst = THREE.OneFactor;
  bloomBlend.blendEquationAlpha = THREE.AddEquation;
  bloomBlend.blendSrcAlpha = THREE.ZeroFactor;
  bloomBlend.blendDstAlpha = THREE.OneFactor;
  post.add(bloomPass, { id: 'bloom', anchor: 'beforeTonemap', priority: 10 });

  // 暗角 + 冷暖分离调色（压视线向角色；Bloom 之后、色彩空间输出之前）
  const gradePass = createGradePass({
    vignette: 0.3,
    strength: 0.28,
    saturation: 1.04,
    shadowTint: new THREE.Color(0x8d93d8),
    highlightTint: new THREE.Color(0xfff0d8),
  });
  post.add(gradePass, { id: 'grade', anchor: 'beforeTonemap', priority: 20 });

  // 输出段拆成两截（ToneMap / Encode），中间就是 afterTonemap 锚点：
  // 颗粒、暗角、色差、冲击波这类「显示参考空间」的效果插在那里，而不是线性光里。
  post.add(createToneMapPass(), { id: 'tonemap', anchor: 'tonemap', priority: 0, locked: true, internal: true });
  post.add(createEncodePass(), { id: 'encode', anchor: 'encode', priority: 0, locked: true, internal: true });

  // ---- 效果时间线 ----
  // 参数 tick 与用户 onFrame 都跑完之后才轮到它：演出是「最后一层写入者」，
  // 用户想每帧抢同一个参数会在 notice 里看到 param-conflict（而不是悄悄被覆盖）。
  const effects = createEffects({ scene, post, params, notices });

  // ---- 尺寸 ----
  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    post.setSize(w, h);
    // 这里传的是 **CSS 像素**：depth.setSize 内部会乘 renderer 的 pixelRatio 再乘
    // scale。别在这里先换成设备像素——那会把 DPR 乘两遍，深度图变成全分辨率。
    depth?.setSize(w, h);
    const a = w / h;
    visW = SPAN_W / ROOM_FRAC;
    visH = visW / a;
    if (visH < SPAN_H / ROOM_FRAC) {
      visH = SPAN_H / ROOM_FRAC;
      visW = visH * a;
    }
    camera.left = -visW / 2;
    camera.right = visW / 2;
    camera.top = visH / 2;
    camera.bottom = -visH / 2;
    clampTarget();
    applyCamera();
  }

  // 容器尺寸变化（编辑器分栏、多窗口拖拽）不会触发 window.resize——必须观测容器本身
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => resize())
    : null;
  resizeObserver?.observe(container);
  window.addEventListener('resize', resize);

  // WebGL 上下文丢失/恢复：three 自己会重建 GL 状态，这里只补尺寸与投影。
  // three 的 onContextLost 已经 preventDefault（那是「允许恢复」的信号），我们不再拦，
  // 只记一条日志——否则移动端切后台回来会是一张黑屏且没有任何痕迹。
  const canvas = renderer.domElement;
  function onContextLost() {
    console.warn('[nijimi] WebGL 上下文丢失，等待恢复（移动端切后台常见）');
  }
  function onContextRestored() {
    console.info('[nijimi] WebGL 上下文已恢复');
    resize();
  }
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  resize(); // 初始尺寸（post 就绪后）

  // ---- 渲染循环（渲染每帧；动画层固定步长）----
  // 三个时间源在这里分工（文档 §3.7）：
  //   frameTime  真实 dt → uTime/uDelta、参数总线、每帧钩子（效果、流光跟手）
  //   animTime   1/30 累加器 → 内容包 update、表情/骨骼
  const clock = createFrameClock(renderer, camera);
  const frameHooks = new Set<(ctx: FrameContext) => void>();
  let animAcc = 0;

  function render(dt: number, _elapsed: number) {
    if (disposed) return; // 外部 rAF 可能比 dispose 活得久
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // 帧上下文先落地：内建参数（uTime/uDelta/uResolution/uCamPos…）在任何钩子之前写好
    const ctx = clock.tick(step, {
      width: container.clientWidth,
      height: container.clientHeight,
    });
    params.tick(ctx);
    for (const hook of frameHooks) {
      try {
        hook(ctx);
      } catch (e) {
        console.warn('[stage] frame 钩子抛错', e);
      }
    }
    effects.update(ctx);

    // 动画层：累加器推进（1/30 是内容动画的契约步长）。
    // 旧写法 `if (elapsed - lastAnim >= step) { ...; render() }` 有两个毛病：
    // 渲染被锁在 30fps，且 lastAnim = elapsed 把余数丢掉，慢帧就读作时间跳变。
    animAcc = Math.min(animAcc + step, animStep * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (animAcc >= animStep && steps < MAX_CATCHUP_STEPS) {
      animAcc -= animStep;
      steps++;
      clock.addAnim(animStep);
      // 第二个参数是**动画时钟**（不是 rAF 的 elapsed）——内容包的相位跟着 1/30 走
      packInst.update?.(animStep, clock.context.animTime);
      // 表情层与骨骼动画同一时基：慢帧时脸不会比身体先动。
      // 它与骨架动画写的是不同属性（morphTargetInfluences vs bone.quaternion），无需互斥。
      character?.expression?.update(animStep);
    }

    // 光照 uniform 跟**渲染帧**走，不跟动画步长：拖动/缩放时 rim 与高光不能慢半拍
    updateNprUniforms(nprUniforms, camera, key);
    // 深度必须在场景渲染之前：软粒子在**材质里**读它，后处理的深度来不及
    depth?.update();
    post.render(step);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    frameHooks.clear();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    // SDF 是舞台加载的，归舞台；角色网格/材质是角色持有者的，别在这里释放
    // （共享材质单例还会被下一个舞台复用）
    characterRendering?.dispose();
    effects.dispose();
    depth?.dispose();
    env.dispose();
    post.dispose();
    params.dispose();
    renderer.dispose();
    canvas.remove();
  }

  return {
    renderer, camera, scene, content, raycaster, post, resize, view, render,
    params,
    depth,
    effects,
    notices,
    onNotice: (listener) => notices.on(listener),
    onFrame: (listener) => {
      frameHooks.add(listener);
      return () => frameHooks.delete(listener);
    },
    get frame() {
      return clock.context;
    },
    setBloom(on: boolean) { post.setEnabled('bloom', on); },
    setNpr(on: boolean) {
      nprUniforms.uNprEnable.value = on ? 1 : 0;
      scene.environmentIntensity = on ? 0.6 : 0;
      // 不碰 gradePass：NPR 是材质层，调色是后期层（耦合会导致「关 NPR」时整张画面换色）
    },
    character: () => character,
    characterRendering: () => characterRendering,
    clientPos: projectClient,
    objectClientPos: (obj: THREE.Object3D) => projectClient(obj.getWorldPosition(new THREE.Vector3())),
    dispose,
    debug: {
      lights: { hemi, key, moon, fill },
      bloomPass,
      post,
      params,
      clock,
      depth,
    },
  };
}
