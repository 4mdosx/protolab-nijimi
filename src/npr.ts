/**
 * NPR 复刻库 —— 《明日方舟：终末地》/《少女前线2：追放》公开拆解里的可移植手法，
 * 落到 three.js r186（WebGL2 / GLSL1）上。拆解与取舍见
 * `design/NPR渲染复刻-终末地少前2手法拆解与落地.md`。
 *
 * 六件事，全部与现有半 PBR 管线共存（不推翻 cozy 定稿）：
 *   1. 分离式光照 rig：角色主光方向锁在相机坐标系里，不跟随场景光源 → 永不阴阳脸。
 *   2. NPR 材质注入：柔和 ramp（不出现锐利半影）、冷暖撞色（暗部染色）、
 *      视角高光（高光方向随相机）、随相机边缘光（rim，颜色可换）。
 *   3. 彩色 IBL：程序化等距柱状渐变 → PMREM，给 PBR 件（黄铜/金属）带颜色的间接光。
 *   4. 反向 hull 描边材质：MeshBasicMaterial + onBeforeCompile 沿法线外扩，蒙皮自动兼容。
 *      （只到「材质」这一层：对象级的 addOutlineToObject / 阴影代理 / 相机锁定 rig
 *       在 2026-10-17 核对时是零调用，P2 直接删掉，见 docs/渲染管线-*.md §5.3-⑱）
 *   5. PBR / NPR 分区：契约版资产按 `extras.charter.role` 查表定轨道
 *      （终末地 Hybrid NPR：面/发/布 NPR、身体与装甲 PBR）；无契约的资产
 *      （房间程序化材质、CC0 通用模型）退回材质名正则兜底。
 *   6. 后期：暗角 + 冷暖分离调色，一个 ShaderPass。
 *
 * 事实来源标注：[公开拆解] = 检索到的公开分析/复刻文章明确提到的；
 * [工程推断] = 我们为在 three.js 里落地做的替代实现。见文档 §2 逐条对照。
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { materialCharter, TRACK_OF_ROLE, type CharterRole } from './charter';
import { resolveModules } from './shader/module';
import { extendMaterial } from './shader/material';
import { NPR_MODULES } from './shader/modules/npr';
import type { ShaderModule } from './shader/module';
import { createParamBus, type ParamBus, type ParamValue } from './shader/params';
import type { ParamType } from './shader/module';
import type { NoticeSink } from './notice';

/* ------------------------------------------------------------------ *
 * 1. NPR 光照参数（共享 uniform 容器）
 * ------------------------------------------------------------------ */

/** 所有 NPR 材质共享同一组 IUniform 对象引用 → 改一次，全场生效。 */
export interface NprUniforms {
  /** 主光方向（世界空间，表面 → 光源，已归一化） */
  uNprKeyDir: THREE.IUniform<THREE.Vector3>;
  /** 主光颜色（乘在暗部→亮部过渡上的色） */
  uNprKeyColor: THREE.IUniform<THREE.Color>;
  /** 暗部保留比例：0 = 全黑，1 = 不做收敛（1 即关闭 ramp 收敛） */
  uNprRampLow: THREE.IUniform<number>;
  /** 明暗过渡带宽度（0.02 ≈ 硬边 cel；0.5 ≈ 几乎无阶跃）——终末地取「刻意避免锐利半影」 */
  uNprRampSoft: THREE.IUniform<number>;
  /** 暗部染色（冷暖撞色的冷端） */
  uNprShadowTint: THREE.IUniform<THREE.Color>;
  /** 亮部染色（冷暖撞色的暖端） */
  uNprLightTint: THREE.IUniform<THREE.Color>;
  /** 撞色强度 0–1 */
  uNprTintStrength: THREE.IUniform<number>;
  /** 视角高光：方向里混入相机朝向的比例（1 = 完全跟随相机 = 虚拟补光灯） */
  uNprSpecViewMix: THREE.IUniform<number>;
  uNprSpecStrength: THREE.IUniform<number>;
  uNprSpecPower: THREE.IUniform<number>;
  uNprSpecColor: THREE.IUniform<THREE.Color>;
  /** 随相机边缘光 */
  uNprRimColor: THREE.IUniform<THREE.Color>;
  uNprRimStrength: THREE.IUniform<number>;
  /** 边缘光宽度（指数越大越窄） */
  uNprRimPower: THREE.IUniform<number>;
  /** 全局开关：0 = 完全关掉注入（用于 A/B） */
  uNprEnable: THREE.IUniform<number>;
  /** 相机世界坐标（每帧写） */
  uNprCamPos: THREE.IUniform<THREE.Vector3>;
  /** 面部 SDF 总开关（共享；只有带 SDF 贴图的 face 材质会被置 1） */
  uNprSdfOn: THREE.IUniform<number>;
  /** 面部 SDF 调试输出：1=阈值场 2=最终明暗 3=光照衰减（共享） */
  uNprSdfDebug: THREE.IUniform<number>;
}

/**
 * 建 NPR 的共享 uniform 容器。
 *
 * 传 `bus` 时会把每个 uniform **接管**进参数总线（不克隆、返回同一对象）：
 * 于是「材质注入时按 id 找 uniform」和「编辑器直接改 nprUniforms.uNprRimStrength.value」
 * 操作的是同一个 IUniform。不传就自己建一条总线——编辑器/测试沿旧用法即可。
 */
export function createNprUniforms(bus: ParamBus = createParamBus()): NprUniforms {
  const declare = (id: string, value: ParamValue) => bus.adopt(id, { value }, NPR_PARAM_TYPES[id]);
  const u = {
    uNprKeyDir: declare('uNprKeyDir', new THREE.Vector3(-0.4, 0.8, 0.45).normalize()),
    uNprKeyColor: declare('uNprKeyColor', new THREE.Color(0xfff0dd)),
    uNprRampLow: declare('uNprRampLow', 0.5),
    uNprRampSoft: declare('uNprRampSoft', 0.34),
    uNprShadowTint: declare('uNprShadowTint', new THREE.Color(0x7d84c8)), // 冷紫（与房间 hemi 同源）
    uNprLightTint: declare('uNprLightTint', new THREE.Color(0xfff1d8)),  // 暖白
    uNprTintStrength: declare('uNprTintStrength', 0.5),
    uNprSpecViewMix: declare('uNprSpecViewMix', 0.7),
    uNprSpecStrength: declare('uNprSpecStrength', 0.22),
    uNprSpecPower: declare('uNprSpecPower', 28),
    uNprSpecColor: declare('uNprSpecColor', new THREE.Color(0xfff4e2)),
    uNprRimColor: declare('uNprRimColor', new THREE.Color(0xffc890)),
    uNprRimStrength: declare('uNprRimStrength', 0.3),
    uNprRimPower: declare('uNprRimPower', 3.2),
    uNprEnable: declare('uNprEnable', 1),
    uNprCamPos: declare('uNprCamPos', new THREE.Vector3()),
    uNprSdfOn: declare('uNprSdfOn', 0),
    uNprSdfDebug: declare('uNprSdfDebug', 0),
  } as unknown as NprUniforms;
  (u as NprUniforms & NprWithBus)[NPR_BUS] = bus;
  return u;
}

/** 共享 uniform → 参数总线的桥（NprUniforms 上挂了自己的总线，模块注入时按 id 解析） */
const NPR_BUS = Symbol('nijimi.npr.bus');
type NprWithBus = { [NPR_BUS]?: ParamBus };

/** NprUniforms 里每个 uniform 的 GLSL 类型（注入时自动生成声明用） */
const NPR_PARAM_TYPES: Record<string, ParamType> = {
  uNprKeyDir: 'vec3',
  uNprKeyColor: 'color',
  uNprRampLow: 'float',
  uNprRampSoft: 'float',
  uNprShadowTint: 'color',
  uNprLightTint: 'color',
  uNprTintStrength: 'float',
  uNprSpecViewMix: 'float',
  uNprSpecStrength: 'float',
  uNprSpecPower: 'float',
  uNprSpecColor: 'color',
  uNprRimColor: 'color',
  uNprRimStrength: 'float',
  uNprRimPower: 'float',
  uNprEnable: 'float',
  uNprCamPos: 'vec3',
  uNprSdfOn: 'float',
  uNprSdfDebug: 'float',
};

/** 取这批 uniform 归属的参数总线（编辑器自己 new 的 NprUniforms 也能用） */
export function nprBusOf(u: NprUniforms): ParamBus {
  const own = (u as NprUniforms & NprWithBus)[NPR_BUS];
  if (own) return own;
  // 兼容旧路径（有人手工拼了一个 NprUniforms 对象）：现场补一个总线并接管这些 uniform，
  // 只接管一次——之后所有模块拿到的都是同一批对象。
  const bus = createParamBus();
  for (const [id, uniform] of Object.entries(u)) {
    bus.adopt(id, uniform as THREE.IUniform, NPR_PARAM_TYPES[id]);
  }
  (u as NprUniforms & NprWithBus)[NPR_BUS] = bus;
  return bus;
}

/* ------------------------------------------------------------------ *
 * 2. 材质注入（模块化）
 * ------------------------------------------------------------------ */

/** 注入用的模块集 = 内建 NPR 表面 + 内容侧追加的模块（顺序由 after/before 决定） */
function modulesFor(extra: readonly ShaderModule[]): readonly ShaderModule[] {
  return extra.length > 0 ? [...NPR_MODULES, ...extra] : NPR_MODULES;
}

export interface InjectNprOptions {
  /** 内容侧追加的模块（层 A 的扩展点） */
  modules?: readonly ShaderModule[];
  /** 材质级 uniform（如各自的 SDF 贴图），优先级高于总线 */
  extra?: Record<string, THREE.IUniform>;
  /** 变体键里的轨道名，只影响缓存分组 */
  tag?: string;
  notices?: NoticeSink;
}

/**
 * 把一个材质打上 NPR 表面（幂等）。
 *
 * 以前这里是一整段字符串常量 + `Math.random()` 的 cache key：每个材质一个 program。
 * 现在拆成模块（basis/sdf/ramp/tint/spec/rim/debug/commit），cache key = 模块签名，
 * 同族材质共享 program；内容侧只要往 `modules` 里追加自己的模块就能加效果。
 */
function injectNpr(mat: THREE.Material, u: NprUniforms, opts: InjectNprOptions = {}): string {
  return extendMaterial(mat, modulesFor(opts.modules ?? []), {
    base: 'standard',
    params: nprBusOf(u),
    extra: opts.extra,
    tag: opts.tag,
    notices: opts.notices,
  });
}


/* ------------------------------------------------------------------ *
 * 3. PBR / NPR 分区
 * ------------------------------------------------------------------ */

export type MaterialRole = 'npr' | 'pbr' | 'outline' | 'unlit' | 'auto';

/** [公开拆解] 「面部及皮肤着重 NPR，装甲武器以 PBR 为核心，布料皮革以 NPR 为主导」 */
const NPR_HINTS = ['皮肤', '脸', '面', '发', '毛', 'hair', 'skin', 'face', 'cloth', '服', '衣', '布', '裙', '丝', '袜', 'body', '体'];
const PBR_HINTS = ['金属', 'metal', '甲', 'armor', '武器', 'weapon', '刃', '刀', '枪', '剑', 'gear', '铁', '钢', '黄铜', 'brass', 'gear', 'glasses', '镜'];
const OUTLINE_HINTS = ['轮廓线', 'outline'];
/**
 * 脸部叠加件（眼球/睫毛/口腔/投影层）：不参与光照，直接出贴图色。
 * [实测] 这些件是贴在脸上的 BLEND 薄面，凹面法线背对相机锁定的主光，
 * Toon 轨道又吃不到 IBL，结果整个眼窝/口腔发黑（拆包模型通用问题）。
 * 现代 NPR 管线同样把这类件当 unlit 处理。
 *
 * 命名并集：夜兰「睫眉/白目/目/星目/口舌/齿」，终末地「睫眉/目白/目/目HL/目影/口内/表情/发影」。
 * 其中「发影」「目影」是半透明黑色投影层——走光照会被二次压暗，unlit 才是它的本意。
 */
const UNLIT_HINTS = [
  '睫眉', '眉睫', '目', '白目', '星目', '目hl', '目影', 'eye',
  '口舌', '口内', '齿', 'teeth', '表情',
  '发影', 'hairshadow', 'eyeshadow', 'highlight',
];

/** 按材质名猜角色部位（拆包模型的中文/英文材质名都吃得下） */
export function classifyMaterial(name: string): MaterialRole {
  const n = (name || '').toLowerCase();
  if (!n) return 'auto';
  for (const h of OUTLINE_HINTS) if (n.includes(h.toLowerCase())) return 'outline';
  for (const h of UNLIT_HINTS) if (n.includes(h.toLowerCase())) return 'unlit';
  for (const h of PBR_HINTS) if (n.includes(h.toLowerCase())) return 'pbr';
  for (const h of NPR_HINTS) if (n.includes(h.toLowerCase())) return 'npr';
  return 'auto';
}

/**
 * 契约族 → 渲染轨道。**这是角色资产的主路径**：契约版 GLB 的每个材质都带
 * `extras.charter.role`（见 src/render/charter.ts 与 tools/charter-rules.mjs），
 * 到这儿只是一次查表，没有任何名字匹配。
 *
 * 表本身在 `charter.ts` 的 `TRACK_OF_ROLE`（与 tools/charter-rules.mjs 的
 * FAMILIES[].track 同源），此处只加一条 v1 资产的兼容别名。
 */
const CHARTER_ROLE_TO_TRACK: Record<string, MaterialRole> = {
  ...TRACK_OF_ROLE,
  add: 'npr', // v1 契约的族名，v2 已改名 glow（保留别名免旧资产失效）
};

/**
 * 材质 → 轨道。优先读契约（角色资产），无契约时（房间程序化材质、CC0 通用模型）
 * 退回名字正则兜底。
 */
export function roleOfMaterial(mat: THREE.Material | null | undefined): MaterialRole {
  const c = materialCharter(mat);
  if (c?.role && CHARTER_ROLE_TO_TRACK[c.role]) return CHARTER_ROLE_TO_TRACK[c.role];
  return classifyMaterial(mat?.name ?? '');
}

/** 材质 → 契约族（无契约返回 null）。渲染端做族级分支时用这个，别自己读 userData。 */
export function charterRoleOf(mat: THREE.Material | null | undefined): CharterRole | null {
  return materialCharter(mat)?.role ?? null;
}

/* ------------------------------------------------------------------ *
 * 5. 材质转换
 * ------------------------------------------------------------------ */

export interface NprMaterialOptions {
  /** 强制角色；省略则按材质名自动分类 */
  role?: MaterialRole;
  /** 色阶段数与柔和度（仅 NPR 轨道） */
  bands?: number;
  rampSoft?: number;
  /** 是否给 PBR 件加风格化高光（默认 true） */
  stylizeMetal?: boolean;
  /** 描边壳粗细（世界单位，仅 outline 轨道） */
  outlineWidth?: number;
  /**
   * 面部 SDF 阴影贴图（契约 model.charter.faceSdf 指向的文件）。
   * 传入后所有 face 族材质走 SDF 明暗（终末地脸部专项），全量启用、无景别门控。
   * 通道语义：R/G = 左/右半球阴影阈值场，A = 鼻尖 mask（黑=鼻尖）。
   */
  faceSdf?: THREE.Texture | null;
  /**
   * 内容侧追加的着色模块（层 A 扩展点）。会插进内建 NPR 模块链里，
   * 顺序由模块自身的 after/before 决定（例如 rim-pulse 排在 npr-commit 之前）。
   * 只对 NPR / PBR 轨道生效——unlit 与描边壳没有 NPR 表面，硬塞会编译失败。
   */
  modules?: readonly ShaderModule[];
  /** 降级/冲突提示的出口（舞台会传自己的 sink） */
  notices?: NoticeSink;
}

/** 内容侧模块 + 材质级契约模块（契约声明排在内建 NPR 之后） */
function modulesForMaterial(
  src: THREE.Material,
  opts: NprMaterialOptions,
): readonly ShaderModule[] {
  const extra = opts.modules ?? [];
  const ids = materialCharter(src)?.shader?.modules;
  if (!ids || ids.length === 0) return extra;
  const { modules, missing } = resolveModules(ids);
  if (missing.length > 0) {
    opts.notices?.warn(
      'module-missing',
      `材质「${src.name || '(未命名)'}」声明的着色模块未注册：${missing.join(', ')}。已跳过。`,
      { id: missing[0], detail: { material: src.name, missing } },
    );
  }
  return modules.length > 0 ? [...extra, ...modules] : extra;
}

/**
 * 把 glTF 带来的 MeshStandardMaterial 转成 NPR 轨道材质，并注入风格化光照。
 * 保留 map / alphaMode / side / transparent / name / skinning 相关的一切——
 * 只换 shading 模型，不换外观数据（[工程推断] 等价于引擎侧的「材质替换」）。
 *
 * 轨道判定走 roleOfMaterial：契约版资产读 extras.charter.role，其余退回名字正则。
 */
export function toNprMaterial(
  src: THREE.Material,
  u: NprUniforms,
  opts: NprMaterialOptions = {},
): THREE.Material {
  const std = src as THREE.MeshStandardMaterial;
  const role = opts.role ?? roleOfMaterial(src);
  // 材质级契约着色：id 解析不到不抛（资产与代码可能版本错位），降级 + 出声
  const modules = modulesForMaterial(src, opts);

  if (role === 'outline') {
    // 自带描边壳（契约 role=outline，如异环「发轮廓线」）：转成反向 hull——
    // 背面 + 沿法线外扩。PMX 里它靠 alpha=0 隐藏，这里才是它的正解。
    const m = makeOutlineMaterial({
      color: new THREE.Color(std.color ?? 0x241d2e),
      thickness: opts.outlineWidth ?? 0.008,
    });
    m.name = src.name;
    m.userData = { ...src.userData, ...m.userData };
    return m;
  }

  if (role === 'unlit') {
    // 脸部叠加件：保留贴图与透明设置，去掉所有光照反应
    const m = new THREE.MeshBasicMaterial({
      color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
      map: std.map ?? null,
      side: std.side,
      transparent: std.transparent,
      opacity: std.opacity,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
      fog: false,
    });
    m.name = src.name;
    m.userData = { ...src.userData, ...m.userData };
    // 眼周叠层需与 NPR 面部混用：无 SDF 时通过 NPR_HAS_FACE_SDF
    // 移除采样分支，避免留下未绑定的 SDF sampler 导致脸部贴图异常。
    return m;
  }

  if (role === 'pbr') {
    // PBR 轨道：保留物理反射。**只有金属族**做「重新定义金属」的高光改造——
    // 皮肤走 PBR 是终末地的部位分区（身体 PBR），不是要给它加高光带；
    // 曾经的写法对整条 PBR 轨道统一 stylizeMetal，会把皮肤粗糙度钳到 0.62 发亮。
    if (opts.stylizeMetal !== false && charterRoleOf(src) === 'metal') stylizeMetal(std);
    (std as THREE.MeshStandardMaterial).defines = { NPR_IS_PBR: '' };
    injectNpr(std, u, {
      modules,
      notices: opts.notices,
      tag: 'pbr',
    });
    return std;
  }

  // ---- NPR 轨道（face 族先分流）----
  // 统一着色模型：MeshStandardMaterial + 注入（终末地路线是「PBR 各分量重映射」，
  // 不是 toon 材质打补丁）。曾经的 MeshToonMaterial + gradientMap 与注入 ramp
  // 是两级阶跃串联，且 toon 不吃 scene.environment——2026-10-16 起废弃。
  const isFace = charterRoleOf(src) === 'face';

  if (isFace && opts.faceSdf) {
    // face 专项：SDF 阴影驱动明暗（NPR_IS_FACE 分支）。皮肤无高光（roughness 拉满），
    // 弱自发光保底（契约 faceGlow，随 SDF 明暗调制，否则阴影区被填平）。
    const face = new THREE.MeshStandardMaterial({
      color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
      map: std.map ?? null,
      roughness: 0.95,
      metalness: 0,
      emissive: std.emissive ? std.emissive.clone() : new THREE.Color(0x000000),
      emissiveMap: std.emissiveMap ?? null,
      emissiveIntensity: std.emissiveIntensity ?? 1,
      alphaMap: std.alphaMap ?? null,
      side: std.side,
      transparent: std.transparent,
      opacity: std.opacity,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
    });
    face.name = src.name;
    face.userData = { ...src.userData };
    // 无 SDF 的材质不能留下未绑定的 sampler；运行期开关为 0 仍会保留活跃 uniform。
    face.defines = { NPR_IS_FACE: '', NPR_HAS_FACE_SDF: '' };
    opts.faceSdf.colorSpace = THREE.NoColorSpace; // 数据贴图，不做 sRGB 解码
    injectNpr(face, u, {
      modules,
      notices: opts.notices,
      extra: {
        uNprSdfMap: { value: opts.faceSdf },
        uNprSdfOn: { value: 1 },
      },
      tag: 'face-sdf',
    });
    return face;
  }

  const npr = new THREE.MeshStandardMaterial({
    color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
    map: std.map ?? null,
    roughness: 0.9,
    metalness: 0,
    emissive: std.emissive ? std.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: std.emissiveMap ?? null,
    // 拷贝自发光强度——applyPmxAnimeFix 标定的 0.2 曾在这里被默认值 1 覆盖，
    // 脸部等于全强度自发光，过 Bloom 直接白炸（2026-10-16 集成编辑器实测）
    emissiveIntensity: std.emissiveIntensity ?? 1,
    alphaMap: std.alphaMap ?? null,
    side: std.side,
    transparent: std.transparent,
    opacity: std.opacity,
    alphaTest: std.alphaTest,
    depthWrite: std.depthWrite,
  });
  npr.name = src.name;
  npr.userData = { ...src.userData };
  if (isFace) npr.defines = { NPR_IS_FACE: '' }; // 无 SDF：保留 face 语义，不编译 SDF 采样分支
  injectNpr(npr, u, {
    modules,
    notices: opts.notices,
    tag: isFace ? 'face' : 'npr',
  });
  return npr;
}

/**
 * 风格化金属：常规 PBR 靠「油亮」表达金属，那不是二次元语感。
 * 做法是压金属度上限 + 抬粗糙度下限 + 降环境反射强度，把金属从镜面拉回「漫反射为主、
 * 高光成带」（带感由 NPR 注入的视角高光提供）。
 */
export function stylizeMetal(mat: THREE.MeshStandardMaterial): void {
  const m = mat.metalness ?? 0;
  mat.metalness = Math.min(m, 0.82);
  mat.roughness = THREE.MathUtils.clamp(mat.roughness ?? 0.5, 0.26, 0.62);
  mat.envMapIntensity = 0.8;
}

/** 统一的角色网格阴影/裁剪策略；也供保留原材质的编辑器准备阶段调用。 */
export function configureNprMesh(mesh: THREE.Mesh): void {
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  // 面部由 SDF（或普通 NPR 回退）负责明暗，避免叠加刘海 shadow map。
  mesh.receiveShadow = !mats.some((m) => charterRoleOf(m) === 'face');
}

/** 遍历一棵子树，按分区规则换材质。返回换了几个。 */
export function applyNprToObject(
  root: THREE.Object3D,
  u: NprUniforms,
  opts: NprMaterialOptions = {},
): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    configureNprMesh(mesh);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => toNprMaterial(m, u, opts));
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    n += next.length;
  });
  return n;
}

/* ------------------------------------------------------------------ *
 * 6. 反向 hull 描边
 * ------------------------------------------------------------------ */

export interface OutlineOptions {
  color?: THREE.ColorRepresentation;
  /** 世界单位（正交相机下即屏幕恒定粗细） */
  thickness?: number;
}

/** 沿法线外扩（外扩量在世界单位下恒定，正交相机即屏幕恒定粗细）。 */
function expandAlongNormal(material: THREE.Material, u: { value: number }, outward: boolean, key: string): void {
  material.userData.outlineUniform = u; // 便于滑杆实时改粗细，不必重建
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = u;
    shader.vertexShader = 'uniform float uOutline;\n' + shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>\n\ttransformed ${outward ? '+' : '-'}= normalize( objectNormal ) * uOutline;`,
    );
  };
  material.customProgramCacheKey = () => key;
}

/**
 * 经典反向 hull 描边：MeshBasicMaterial(BackSide) + 顶点沿法线外扩。
 * 用 onBeforeCompile 而不是自写 ShaderMaterial，是为了白拿 three 的蒙皮 / morph
 * 顶点着色链——注入点放在 `#include <skinning_vertex>` 之后，`objectNormal` 已被骨骼变换。
 */
export function makeOutlineMaterial(opts: OutlineOptions = {}): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(opts.color ?? 0x1a1522),
    side: THREE.BackSide,
    transparent: false,
    depthWrite: true,
    fog: false,
  });
  expandAlongNormal(mat, { value: opts.thickness ?? 0.006 }, true, 'npr-outline');
  return mat;
}

/* ------------------------------------------------------------------ *
 * 9. 彩色 IBL
 * ------------------------------------------------------------------ */

export interface ColoredEnvOptions {
  /** 天顶色 */
  sky?: THREE.ColorRepresentation;
  /** 地平线色 */
  horizon?: THREE.ColorRepresentation;
  /** 地面色 */
  ground?: THREE.ColorRepresentation;
  /** 主光方向上的暖色光斑（模拟一盏主光被环境"看见"） */
  glow?: THREE.ColorRepresentation;
  /** 光斑中心方向（世界空间） */
  glowDir?: THREE.Vector3;
  /** 环境强度 */
  intensity?: number;
}

/**
 * [公开拆解] 「服装材质则恰到好处地混合了 PBR，并融入带颜色的 IBL
 *  （基于图像的光照），这不仅丰富了间接光信息，也让皮衣等工业风材质在
 *  二次元世界中显得毫不违和。」
 *
 * 实现：把渐变烘进一个内表面反向球体的顶点色 → PMREMGenerator.fromScene() 预卷积
 * → scene.environment。只作用于 PBR 轨道（MeshStandardMaterial 系），NPR 轨道走灯光，互不干扰。
 */
export function createColoredEnvironment(
  renderer: THREE.WebGLRenderer,
  opts: ColoredEnvOptions = {},
): { texture: THREE.Texture; dispose(): void } {
  const sky = new THREE.Color(opts.sky ?? 0x3a4270);
  const horizon = new THREE.Color(opts.horizon ?? 0x5c5570);
  const ground = new THREE.Color(opts.ground ?? 0x2a2230);
  const glow = new THREE.Color(opts.glow ?? 0xffc890);
  const glowDir = (opts.glowDir ?? new THREE.Vector3(-0.55, 0.62, 0.75)).normalize();
  const tmp = new THREE.Color();

  // PMREM：DataTexture 直喂 fromEquirectangular 实测拿到的是黑图，
  // 走文档推荐的 fromScene()——把渐变烘到一个内表面反向的球体顶点色上。
  const envScene = new THREE.Scene();
  const sphere = new THREE.SphereGeometry(10, 48, 32);
  const pos = sphere.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const h = THREE.MathUtils.clamp(v.y * 0.5 + 0.5, 0, 1);
    if (h > 0.5) tmp.copy(horizon).lerp(sky, (h - 0.5) * 2);
    else tmp.copy(ground).lerp(horizon, h * 2);
    // 主光方向上的暖斑：给金属件留下一条可读的高光带
    const g = Math.pow(THREE.MathUtils.clamp(v.dot(glowDir), 0, 1), 5);
    tmp.lerp(glow, g * 0.9);
    colors[i * 3] = THREE.MathUtils.clamp(tmp.r, 0, 1);
    colors[i * 3 + 1] = THREE.MathUtils.clamp(tmp.g, 0, 1);
    colors[i * 3 + 2] = THREE.MathUtils.clamp(tmp.b, 0, 1);
  }
  sphere.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const shell = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide,
  }));
  envScene.add(shell);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  sphere.dispose();
  (shell.material as THREE.Material).dispose();
  void opts.intensity;

  return {
    texture: rt.texture,
    dispose() {
      rt.dispose();
    },
  };
}

/** 挂环境并设强度（r163+ 的 scene.environmentIntensity） */
export function applyEnvironment(
  scene: THREE.Scene,
  env: THREE.Texture,
  intensity = 0.7,
): void {
  scene.environment = env;
  scene.environmentIntensity = intensity;
}

/* ------------------------------------------------------------------ *
 * 10. 后期：暗角 + 冷暖分离调色
 * ------------------------------------------------------------------ */

export interface GradeOptions {
  vignette?: number;
  vignettePower?: number;
  /** 阴影整体色偏向（通常冷） */
  shadowTint?: THREE.Color;
  /** 高光整体色偏向（通常暖） */
  highlightTint?: THREE.Color;
  strength?: number;
  saturation?: number;
  contrast?: number;
  /**
   * 是否把输入的 alpha 带到输出（默认 true）。
   * 此前这里硬写 1.0：`renderer` 是 alpha:true，调色 pass 一过整张画布就不透明了，
   * 透明背景必须靠「往场景里垫棚壁」绕过去（见 editors/scene.ts 的注释）。
   * 关掉它只用于显式需要不透明输出的场合（截图、离屏合成）。
   */
  preserveAlpha?: boolean;
}

/**
 * 一个 pass 干两件事：暗角（把视线压向角色）+ 冷暖分离调色。
 * 放在 Bloom 之后、OutputPass 之前——此时是线性光，乘色即物理正确的染色。
 *
 * alpha：RGB 只做颜色运算，alpha 原样透传（`preserveAlpha`），否则后处理链会
 * 把透明画布变成不透明黑底。
 */
export function createGradePass(opts: GradeOptions = {}): ShaderPass {
  const shader: THREE.ShaderMaterialParameters = {
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      uVignette: { value: opts.vignette ?? 0.42 },
      uVignettePower: { value: opts.vignettePower ?? 1.5 },
      uShadowTint: { value: (opts.shadowTint ?? new THREE.Color(0x8d93d8)).clone() },
      uHighlightTint: { value: (opts.highlightTint ?? new THREE.Color(0xfff0d8)).clone() },
      uSplit: { value: opts.strength ?? 0.35 },
      uSaturation: { value: opts.saturation ?? 1.06 },
      uContrast: { value: opts.contrast ?? 1.05 },
      uPreserveAlpha: { value: opts.preserveAlpha === false ? 0 : 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uVignette;
      uniform float uVignettePower;
      uniform vec3 uShadowTint;
      uniform vec3 uHighlightTint;
      uniform float uSplit;
      uniform float uSaturation;
      uniform float uContrast;
      uniform float uPreserveAlpha;
      varying vec2 vUv;
      const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
      void main() {
        vec4 src = texture2D( tDiffuse, vUv );
        vec3 c = src.rgb;

        float l = dot( c, LUMA );
        // 冷暖分离：暗部乘冷端、亮部乘暖端
        vec3 tint = mix( uShadowTint, uHighlightTint, smoothstep( 0.0, 0.6, l ) );
        c = mix( c, c * tint, uSplit );

        // 饱和度 / 对比（围绕中灰）
        float g = dot( c, LUMA );
        c = mix( vec3( g ), c, uSaturation );
        c = ( c - 0.18 ) * uContrast + 0.18;

        // 暗角
        vec2 d = vUv - 0.5;
        float v = 1.0 - uVignette * pow( clamp( dot( d, d ) * 2.0, 0.0, 1.0 ), uVignettePower );
        c *= clamp( v, 0.0, 1.0 );

        // 保留输入的 alpha：颜色运算只碰 rgb。Bloom 的加性合成可能把 alpha 堆过 1，
        // 这里夹一下；preserveAlpha=0 时退回不透明（旧行为，供截图/离屏合成对照）。
        float a = mix( 1.0, clamp( src.a, 0.0, 1.0 ), uPreserveAlpha );
        gl_FragColor = vec4( max( c, vec3( 0.0 ) ), a );
      }
    `,
  };
  return new ShaderPass(shader);
}

/* ------------------------------------------------------------------ *
 * 11. 每帧驱动
 * ------------------------------------------------------------------ */

/**
 * 每帧调用：同步相机位置 uniform（视角高光与边缘光依赖它）。
 * 传 keyLight 时同时把主光方向写进 uNprKeyDir —— 注入项与真实灯光的接线
 * （此前 uNprKeyDir 只有硬编码默认值，与场景主光同向纯属巧合）。
 */
export function updateNprUniforms(
  u: NprUniforms,
  camera: THREE.Camera,
  keyLight?: THREE.DirectionalLight,
): void {
  camera.getWorldPosition(u.uNprCamPos.value);
  if (keyLight) {
    u.uNprKeyDir.value.copy(keyLight.position).sub(keyLight.target.position).normalize();
  }
}
