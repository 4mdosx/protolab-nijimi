/**
 * 角色资产契约 — 映射规则表（人在环的裁定，入库）
 *
 * ⭐ **以终末地（《明日方舟：终末地》）角色材质体系为核心**。两件事都对齐它：
 *   ① 材质族（role）按官方贴图命名的 `<part>` 记号归纳；
 *   ② 贴图通道（channel）直接用官方后缀（D/N/P/RD/RS/M/ST/E/SDF/HN/MRO/LUT/MatCap）。
 *
 * 证据不是二手文章而是**终末地拆包随附的官方共用贴图**——`assets/refs/si/other tex/`（59 张，
 * 2026-10-16 实测清单），命名规范 `T_actor_<char|common>_<part>_<nn>[_<sub>]_<CH>.png`。
 * 每条通道/族都在下面带 `ev:` 证据文件名，可逐条回查。
 *
 * 本文件是**约定本身**，不含模型数据。pipeline/charter-glb.mjs 读它把拆包模型映射到
 * 项目约定；src/render/charter.ts 是按同一份约定实现的消费端。
 *
 * 四段内容：
 *   ① FAMILIES / ROLE_TRACK —— 材质族枚举与渲染轨道（契约的核心）
 *   ② CHANNELS              —— 终末地通道表（glTF 落位 + 色彩空间）
 *   ③ NAME_RULES            —— 「材质名 → 族」的通用规则（顺序敏感，特化在前）
 *   ④ MODELS                —— 每个模型的档案与人工覆盖（实测值）
 *
 * 新增模型：先跑 pipeline/charter-glb.mjs 看自动映射报告，只把「判错的」写进
 * MODELS[<id>].roleOverrides —— 通用规则吃得下的不要重复声明。
 */

/** 契约版本。字段语义变化时 +1（消费端可据此拒绝旧资产）。 */
export const CHARTER_VERSION = 2;

/* ------------------------------------------------------------------ *
 * ① 材质族 + 渲染轨道（终末地核心）
 * ------------------------------------------------------------------ */

/**
 * 材质族 = 终末地材质体系的「部位族」。族名取官方 `<part>` 记号的语义，
 * 覆盖 `T_actor_*_<part>_*` 的全部实测实例（59 张贴图全部分得进去，无遗漏）。
 *
 * `track` 是终末地 Hybrid NPR 的落点（[公开拆解]：面部/发/布 NPR 主导，
 * 身体与装甲武器 PBR 核心；脸部叠加件当代管线惯例走 unlit）：
 *
 *   npr      → MeshToonMaterial + 柔和 ramp + 冷暖撞色 + 视角高光/边缘光
 *   pbr      → MeshStandardMaterial 保留物理反射（吃彩色 IBL；不做金属化处理）
 *   unlit    → MeshBasicMaterial 贴图直出（脸部叠加件：不参与光照是它们的本意）
 *   outline  → 背面外扩黑壳
 *
 * 轨道刻意只有四条：多一条就多一条要维护的分支。自发光（族 glow）不是独立轨道——
 * 它是「npr 轨道 + 转换期烘好的 emissiveMap」这一份**数据**差异。
 */
export const FAMILIES = {
  face: {
    part: 'face_01', cn: '面部', track: 'npr',
    chans: ['D', 'N', 'ST', 'SDF'],
    desc: '面部皮肤；SDF 面部阴影已全量启用（2026-10-16 裁定，无景别门控）——'
      + '贴图经模型档案 faceSdf 字段指向 /models/<id>.face-sdf.png，'
      + 'R/G=左右半球阴影阈值场，A=鼻尖 mask',
    ev: 'T_actor_jsspsi_face_01_D/N/ST.png + T_actor_common_female_face_01_SDF.png',
  },
  skin: {
    part: 'body_01 / femaleskincolor*_lut', cn: '身体·皮肤', track: 'pbr',
    chans: ['D', 'N', 'RD', 'LUT'],
    desc: '裸露皮肤与身体；终末地在身体上走 PBR（与面部的 NPR 形成分区）',
    ev: 'T_actor_jsspsi_body_01_D/N.png',
  },
  hair: {
    part: 'hair_01 / hairst_01', cn: '头发', track: 'npr',
    chans: ['D', 'HN', 'P', 'RS', 'ST'],
    desc: '头发主体；HN 提供各向异性发丝法线（发丝高光的正主）',
    ev: 'T_actor_jsspsi_hair_01_D/HN/P/RS/ST.png',
  },
  cloth: {
    part: 'cloth_01/02/03', cn: '布料', track: 'npr',
    chans: ['D', 'N', 'P', 'E', 'ST', 'M'],
    desc: '衣物 / 配饰 / 鞋帽；布料 NPR 主导，自带 E 与 ST（发光片与阴影阶梯）',
    ev: 'T_actor_jsspsi_cloth_01_D/N/P/E/ST.png',
  },
  metal: {
    part: 'default_mro', cn: '硬表面·金属', track: 'pbr',
    chans: ['MRO', 'D', 'N', 'MatCap'],
    desc: '金属 / 装甲 / 武器；PBR 核心，唯一允许 metalness > 0 的族',
    ev: 'T_default_mro_MRO.png',
  },
  glow: {
    part: '_E 驱动的自发光件', cn: '自发光·加法层', track: 'npr',
    chans: ['E', 'D'],
    desc: '自发光件 / MMD 加法 sphere 层（原 v1 的 add）。走 npr 轨道 + 烘好的 emissiveMap',
    ev: 'T_actor_jsspsi_cloth_01_E.png',
  },
  eye: {
    part: 'iris_01 / matcap_08 / eyeshadow_01', cn: '眼周', track: 'unlit',
    chans: ['D', 'MatCap', 'M'],
    desc: '虹膜 / 眼白 / 睫眉 / 眼影；脸部叠加件，虹膜假反射用 MatCap 通道',
    ev: 'T_actor_jsspsi_iris_01_D.png / T_actor_common_matcap_08_D.png',
  },
  mouth: {
    part: 'face_01 子集', cn: '口腔', track: 'unlit',
    morphOnly: true,
    chans: ['D'],
    desc: '口内 / 舌 / 齿；脸部叠加件。**morph 驱动**：张嘴时才该露出来，'
      + '模型没有 morph targets 时渲染端必须整件隐藏（实测 2026-10-16：'
      + 'si 的口内贴片悬在闭着的嘴唇前面，GLB 无 morph → 嘴永远「张开」）',
    ev: 'T_actor_jsspsi_face_01_D.png（面部件图集的嘴部图块）',
  },
  decal: {
    part: 'emotion_atlas_01 / hairline_03 / hairshadow_01', cn: '贴片', track: 'unlit',
    chans: ['D', 'M'],
    desc: '贴在别件上的图集与遮罩：表情图集 / 发影 / 发际线 / 眼睑投影 / 目影',
    ev: 'T_actor_common_female_emotion_atlas_01_D.png / _hairline_03_M / _hairshadow_01_M',
  },
  outline: {
    part: '—', cn: '描边壳', track: 'outline',
    chans: [],
    desc: 'PMX 里靠 alpha=0 隐藏的描边壳；契约里明确 enable 才当描边用',
    ev: '—（非终末地命名，PMX 侧概念）',
  },
  misc: {
    part: '—', cn: '兜底', track: 'npr',
    chans: [],
    desc: '判定不出部位时当布料处理，再看转换报告修正',
    ev: '—',
  },
};

/** 族 → 轨道（FAMILIES 的派生视图，给转换器/消费端的一次查表） */
export const ROLE_TRACK = Object.fromEntries(
  Object.entries(FAMILIES).map(([k, v]) => [k, v.track]),
);

/** 契约里的合法轨道（v1 的 `add` 轨道已并入 npr + emissiveMap，`glow` 只是族名） */
export const TRACKS = new Set(['npr', 'pbr', 'unlit', 'outline']);

/**
 * 允许 metalness > 0 的族白名单。PMX 没有 PBR 数据，glTF 默认
 * metallicFactor=1 会让漫反射归零（暗处纯黑）——除金属族外一律归零。
 */
export const METAL_OK = new Set(['metal']);

/**
 * 走「贴图 alpha 抠形」的族：**只有**这些族的 alphaMode 允许被自动改写。
 * 别把这套推广到全局——贴图大面积镂空 ≠ 该材质要抠形：一张图集被多个部件
 * 共用时（夜兰 tex5 零值占 80.7%），UV 只采到有内容的一小块，
 * 强行 MASK 会把整个部件切没。
 * glow 也不在内：加法层靠「黑=不贡献」工作，转成透明反而错。
 */
export const ALPHA_CUT_ROLES = new Set(['eye', 'mouth', 'decal']);

/* ------------------------------------------------------------------ *
 * ② 终末地通道表（官方后缀 → 语义 → glTF 落位）
 * ------------------------------------------------------------------ */

/**
 * 通道命名统一用**终末地的官方后缀**（v1 用的 BC 已改为 D）。
 * 实测出现频次（59 张）：M 21 / D 10 / N 7 / ST 5 / RD 4 / RS 3 / P 3 / E 2 /
 * SDF 1 / HN 1 / MRO 1 / LUT 1 / MatCap 1。
 *
 * `slot` = glTF 的落位；标 (预留) 的是 glTF 没有对应槽位的——契约版把它们
 * 登记在贴图表里（名字 + 来源文件），消费端按族决定要不要起效。
 * 色彩空间：D/E/MatCap 走 sRGB，其余线性。
 */
export const CHANNELS = {
  D:      { slot: 'baseColorTexture',                  space: 'srgb',   cn: '固有色',   ev: 'T_actor_jsspsi_cloth_01_D.png' },
  N:      { slot: 'normalTexture',                     space: 'linear', cn: '法线',     ev: 'T_actor_jsspsi_body_01_N.png' },
  MRO:    { slot: 'occlusion+metallicRoughness',       space: 'linear', cn: 'MR/AO 打包', ev: 'T_default_mro_MRO.png' },
  E:      { slot: 'emissiveTexture',                   space: 'srgb',   cn: '自发光',   ev: 'T_actor_jsspsi_cloth_01_E.png' },
  P:      { slot: '(预留) 打包参数',                   space: 'linear', cn: 'PBR 打包', ev: 'T_actor_jsspsi_cloth_01_P.png（2048²，语义未公开）' },
  RD:     { slot: '(预留) 常量粗糙',                   space: 'linear', cn: '常量粗糙', ev: 'T_actor_common_body_01_RD.png（~230 B 单色）' },
  RS:     { slot: '(预留) 粗糙-高光',                  space: 'linear', cn: '粗糙高光', ev: 'T_actor_common_cloth_02_RS.png' },
  M:      { slot: '(预留) 遮罩',                       space: 'linear', cn: '遮罩',     ev: 'T_actor_common_hairline_03_M.png（最宗的通道，21 张）' },
  ST:     { slot: '(预留) 阴影阶梯',                   space: 'linear', cn: '阴影阶梯', ev: 'T_actor_jsspsi_hair_01_ST.png' },
  SDF:    { slot: '(预留) 面部阴影',                   space: 'linear', cn: '面部 SDF', ev: 'T_actor_common_female_face_01_SDF.png' },
  HN:     { slot: '(预留) 发丝法线',                   space: 'linear', cn: '发丝法线', ev: 'T_actor_jsspsi_hair_01_HN.png' },
  LUT:    { slot: '(预留) 肤色查找表',                 space: 'linear', cn: '肤色 LUT', ev: 'T_actor_common_femaleskincolor01_lut_D.png' },
  MatCap: { slot: '(预留) 球面环境图',                 space: 'srgb',   cn: '球面图',   ev: 'T_actor_common_matcap_08_D.png' },
  // 子后缀（出现在通道位之后，跟主通道组合使用）
  hl:     { slot: '(预留) 高光遮罩',                   space: 'linear', cn: '高光遮罩', ev: 'T_actor_common_face_01_hl_M.png' },
  cm:     { slot: '(预留) 区域染色遮罩',               space: 'linear', cn: '染色遮罩', ev: 'T_actor_common_female_face_01_cm_M.png' },
};

/** 常见别称 → 终末地通道（各家的贴图命名习惯都收进来） */
const CHAN_ALIAS = {
  NORMAL: 'N', NRM: 'N', NOR: 'N',
  DIFFUSE: 'D', ALBEDO: 'D', BC: 'D', BASE: 'D', DIFF: 'D',
  EMISSIVE: 'E', EMIT: 'E',
  ROUGH: 'RS', ROUGHNESS: 'RS', RGH: 'RS', SPECULAR: 'RS', SPEC: 'RS',
  METALLIC: 'MRO', OCCLUSION: 'MRO', AO: 'MRO', ORM: 'MRO',
  MATCAP: 'MatCap',
};

/**
 * 从原始贴图文件名推终末地通道（`T_actor_jsspsi_hair_01_HN.png` → `HN`）。
 *
 * 从右往左扫下划线/空格分词，取**第一个能对上通道表**的词——比只看最后一个词稳：
 *   终末地 `..._hair_01_HN.png` → HN
 *   异环   `..._Akane_d2.png`  → D（尾部的去重数字先剥掉）
 *   异环   `..._hair_01 2.png` → null（无通道信息，交由 glTF 槽位兜底）
 * 自家的 v1 命名 `..._BC.png` 也吃得下（别名 BC → D）。
 */
export function pmxChannel(file) {
  if (!file) return null;
  const base = String(file).replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.(png|tga|dds|jpg|jpeg|bmp|webp)$/i, '');
  const toks = stem.split(/[_ ]+/).reverse();
  for (const tk of toks) {
    const t = tk.replace(/\d+$/, ''); // 剥去重后缀数字（d2 / 01 2 / 003）
    if (!t) continue;
    const norm = t.toLowerCase();
    if (norm === 'hl' || norm === 'cm') return norm;
    const up = t.toUpperCase();
    if (CHANNELS[up]) return up;
    if (CHAN_ALIAS[up]) return CHAN_ALIAS[up];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * ③ 材质名 → 族（通用规则，顺序敏感）
 * ------------------------------------------------------------------ */

/**
 * 顺序即优先级：先命中先赢。四处顺序关键：
 *   - 描边壳先判（「发轮廓线」含「发」，不然会被判成 hair）
 *   - 「+」后缀先判（夜兰「髮+」含「髮」）
 *   - 「影」在 eye/hair 之前（「目影」「发影」「hairshadow」「eyeshadow」是贴片，不是眼球/头发）
 *   - 口腔在面部之前（「口内」含「内」，且不该落到 face 的锚定规则）
 * 中英文与终末地官方 part 记号（cloth / hair / iris / body / cloth_01 …）都吃得下。
 */
export const NAME_RULES = [
  [/轮廓|outline|edge/i, 'outline'],
  [/\+$/, 'glow'],
  [/^(star|glow|emissive|light|fx)/i, 'glow'],
  [/影|shadow/i, 'decal'],
  [/表情|emotion|decal|facemark/i, 'decal'],
  [/睫|眉|目|眼|瞳|虹|iris|eye|lash|brow|matcap/i, 'eye'],
  [/口|舌|齿|牙|mouth|teeth|tongue/i, 'mouth'],
  [/^(颜|面)(\d|_|$)/i, 'face'],
  [/肌|肤|皮|腿|臂|手|脚|skin|body|femaleskin/i, 'skin'],
  [/发|髮|hair|刘海/i, 'hair'],
  [/服|衣|裙|裤|布|袜|丝|带|领|袖|帽|靴|鞋|手套|饰|cloth|dress|skirt|sock|glove|boot/i, 'cloth'],
  [/金属|甲|刃|刀|枪|剑|铁|钢|黄铜|brass|metal|weapon|武器|扣|铆|gear|镜|mro/i, 'metal'],
];

/* ------------------------------------------------------------------ *
 * ③½ SHADER_MODULES（可以写进契约的着色模块）
 * ------------------------------------------------------------------ */

/**
 * 资产**可以声明**的表面着色模块。与 `src/shader/modules/` 的注册表一一对应：
 * 转换期（charter-glb）与 CI（render-modules-check）都按这张表校验 id，
 * 资产里写错一个字母会在 `npm run charter` 就失败，而不是等浏览器里画面不对。
 *
 * 准入三条（都要满足）：
 *   ① **纯数据**：模块文件只 import `../module`，不 import three、不碰 DOM
 *      —— 因为转换期要在 Node 侧直接 import 它做校验；
 *   ② **零默认可见**：参数默认 0 / 安全值，声明了也不改变原观感；
 *   ③ **只依赖 NPR 表面的作用域变量**（`nprN` / `nprV` / `nprOut` / `vNprWPos`），
 *      不要求模型侧额外的贴图或缓冲。
 *
 * 两条刻意排除：
 *   - `soft-particles`：它要绑深度预 pass 的四个 uniform，由 `applySoftParticles()` 在
 *     运行期接线（内容侧代码，不是资产声明）。写进契约只会拿到一张未绑定的深度图
 *     ——那是最难查的一类「静默无效」。
 *   - `ascii-flow`：它是**屏幕空间**效果（读 `uResolution` 切字符格），属于「这一段演出」
 *     而不属于「这个资产的固有外观」。声明它还会把内建 uniform 拖进 `params` 清单，
 *     让「契约参数 = 模块参数」这条对齐断言失去意义。要走 ASCII 就在代码里
 *     `characterModules: [asciiFlow]` 挂上。
 */
export const SHADER_MODULES = {
  dissolve: {
    cn: '溶解 / 元素化',
    version: 1,
    params: ['uDissolve', 'uDissolveEdge', 'uDissolveScale', 'uDissolveColor', 'uDissolveGlow'],
    doc: '世界坐标噪声阈值 discard + 阈值边缘自发光；uDissolve = 0 时逐像素等价于不装',
  },
  'rim-pulse': {
    cn: '边缘光脉冲',
    version: 1,
    params: ['uRimPulseColor', 'uRimPulseStrength', 'uRimPulsePower'],
    doc: '演出用的第二圈轮廓光（宽、可染色、可归零）；uRimPulseStrength = 0 时逐像素等价于不装',
  },
};

/**
 * 校验一批模块引用（`id` 或 `id@version`）。
 * 返回 `{ errors, warnings }`：errors 让转换失败，warnings 只提示（版本漂移）。
 */
export function validateShaderIds(ids, where) {
  const errors = [];
  const warnings = [];
  const known = Object.keys(SHADER_MODULES).join(' / ');
  for (const raw of ids ?? []) {
    const [name, ver] = String(raw).split('@');
    const spec = SHADER_MODULES[name];
    if (!spec) {
      errors.push(`${where} 声明了未登记的着色模块「${raw}」（可选：${known}）`);
      continue;
    }
    if (ver !== undefined && Number(ver) !== spec.version) {
      warnings.push(`${where} 的「${name}」写的是 @${ver}，注册表当前 v${spec.version}——行为以引擎为准`);
    }
  }
  return { errors, warnings };
}

/**
 * 求某材质最终要写的模块 id：**模型级 → 族级 → 材质级**，按序合并去重。
 *
 * 为什么按这个顺序：模型级是「这个角色的能力」（全身溶解），族级是「这类部位的
 * 表现」（只有头发有脉冲），材质级是「这个部件的特例」。合并结果就是运行期
 * `material.modules` 钩子拿到的那串 id，顺序即模块链的拼接顺序（顺序敏感）。
 */
export function resolveShader(modelId, role, matName) {
  const M = MODELS[modelId] ?? {};
  const ids = [];
  const sources = [];
  const push = (from, list) => {
    for (const id of list ?? []) {
      const name = String(id).split('@')[0];
      if (ids.some((x) => String(x).split('@')[0] === name)) continue;
      ids.push(id);
      sources.push(`${from}:${id}`);
    }
  };
  push('model', M.shader?.modules);
  push(`role:${role}`, M.roleShader?.[role]);
  push('material', M.materialShader?.[matName]);
  return { ids, sources };
}

/* ------------------------------------------------------------------ *
 * ④ 模型档案（人工裁定部分）
 * ------------------------------------------------------------------ */

/**
 * 字段说明：
 *   source / license   —— 授权登记（进 manifest，作为对外交付时的排除依据）
 *   pmx                —— 源 PMX 路径（相对项目根；用于贴图通道溯源，缺则跳过）
 *   defaultRotY        —— 编辑器摆正角（实测；该角与编辑器固定机位绑定）
 *   targetHeight       —— 归一化身高（米）
 *   faceGlow           —— 面部自发光强度（0 = 该包不要此修正）
 *   faceSdf            —— 面部 SDF 阴影贴图文件名（相对 /models/；缺省 = 无 SDF）
 *   standPosition      —— 房间站位（可省略，主场景换主角时再补）
 *   roleOverrides      —— 名字 → 族的类手工覆盖（只写规则判错的）
 *   layerOverrides     —— 名字 → 渲染层（只写 PMX 序判错的）
 *   outline            —— 描边壳策略：'enable' 启用为黑描边 / 'hide' 隐藏
 *   shader             —— 模型级着色模块（`{ modules: [] }`，全身生效，见 SHADER_MODULES）
 *   roleShader         —— 族 → 模块（叠加在模型级之上，例如只有头发有脉冲）
 *   materialShader     —— 材质名 → 模块（叠加在族级之上，单件特例）
 */
export const MODELS = {
  yelan: {
    id: 'yelan',
    name: '夜兰',
    source: '原神 官方 PMX（B 站官方活动包）',
    license: '官方模型，禁商用；验证期占位，正式版必须替换',
    // PMX 源不在库内（只留了 GLB）→ 无贴图通道溯源，通道按 glTF 槽位推
    defaultRotY: -2.18,
    targetHeight: 1.55,
    faceGlow: 0.55,
    // 面部 SDF：pipeline/bake-face-sdf.mjs 从几何烘焙（原神官方 PMX 无 SDF 资产）
    faceSdf: 'yelan.face-sdf.png',
    standPosition: [2.35, 0, 1.15],
    standRotY: -2.36,
    roleOverrides: {
      // 「体」是躯干网格（贴 tex3 衣服图集），规则判 misc，人工归 cloth
      体: 'cloth',
    },
    // 着色声明：夜兰是「元素化」演出的主角（kits/shows.ts 的 chargeBurst / reform
    // 直接驱动 uDissolve）。写在**模型级**而不是内容侧的 characterModules 里，
    // 是因为「这具模型有没有元素化能力」属于资产事实——换成没有该能力的模型时，
    // 演出找不到参数会降级并出声，而不是把整身刷白。
    shader: { modules: ['dissolve@1'] },
    // 只有头发带第二圈脉冲：发丝在暗部最容易糊成一块，脉冲是「还活着」的信号。
    roleShader: { hair: ['rim-pulse@1'] },
  },

  si: {
    id: 'si',
    name: '祀',
    source: '明日方舟：终末地 拆包改模 by 茶叶味香皂',
    license: '仅供个人展示与交流；严禁商用。版权属鹰角网络',
    pmx: 'assets/refs/si/祀.pmx',
    defaultRotY: Math.PI,
    targetHeight: 1.55,
    faceGlow: 0.55,
    // 面部 SDF：官方共用贴图 T_actor_common_female_face_01_SDF.png，
    // 与该包脸部 UV 同布局（2026-10-16 uv 叠加实证：眼洞/鼻尖高光/嘴线全对位）
    faceSdf: 'si.face-sdf.png',
    roleOverrides: {},
    // 实测 2026-10-16：该包 PMX 序为 目(1)→目HL(2)→目白(3)，且目白贴图无 alpha
    // 镂空 → 按原序后画的眼白整块盖死虹膜。按「眼白→虹膜→高光」语义重排。
    layerOverrides: { 目白: 1, 目: 2, 目HL: 3 },
  },

  akane: {
    id: 'akane',
    name: '明音凛',
    source: '异环 拆包 PMX（by 异环）',
    license: '版权属 Hotta Studio；使用规约禁止商用',
    pmx: 'assets/refs/akane-rin-pmx/明音fashion2/明音fasion2.pmx',
    defaultRotY: -2.18,
    targetHeight: 1.55,
    faceGlow: 0, // 实测：该包贴图本身明亮，加自发光即过曝
    roleOverrides: {
      发卡: 'hair', // 发饰，贴头发图
    },
    outline: 'enable', // 「发轮廓线」是 2.8 万面的描边壳（PMX 里 alpha=0 隐藏）
  },

  'akane-weapon': {
    id: 'akane-weapon',
    name: '明音凛·武器',
    source: '异环 拆包 PMX（道具件）',
    license: '版权属 Hotta Studio；使用规约禁止商用',
    pmx: 'assets/refs/akane-rin-pmx/明音fashion2/weapon.pmx',
    defaultRotY: 0,
    targetHeight: 1.0,
    faceGlow: 0,
    roleOverrides: {},
  },
};

/** 模型 id → PMX 源路径（贴图通道溯源用；未登记返回 null） */
export function pmxOf(modelId) {
  const p = MODELS[modelId]?.pmx;
  return p || null;
}

/* ------------------------------------------------------------------ *
 * ⑤ 预算（契约的「规格」条款；导出层按此自动降采样，见 downsample）
 * ------------------------------------------------------------------ */

/**
 * 预算。角色在屏幕上的实际占位很小，4K 是纯浪费。
 *
 * `downsample: true` = 导出层（pipeline/charter-glb.mjs）对最长边超 maxTexSize 的
 * PNG 贴图**自动 box filter 降采样**（整数倍，最近 2048/1024）。作用域仅契约版
 * GLB —— 原版永不改写。要保留原尺寸就加 `--no-resize`，那时超预算只报告。
 */
export const BUDGET = {
  downsample: true,      // 导出层自动降采样开关（--no-resize 可关）
  maxTexSize: 2048,      // 单张最长边
  maxTextures: 12,       // 每角色贴图数
  maxTotalMB: 12,        // 每角色 GLB 体积
};

/* ------------------------------------------------------------------ *
 * ⑥ 应用逻辑（转换器与消费端共用同一套语义）
 * ------------------------------------------------------------------ */

/** 材质名 → 族（通用规则） */
export function ruleRole(name) {
  const n = name || '';
  for (const [re, role] of NAME_RULES) if (re.test(n)) return role;
  return 'misc';
}

/**
 * 求某模型某材质的最终裁定。
 * 返回 { role, layer, hit, layerHit }：hit 记录判定来源，供报告与溯源。
 */
export function resolveMaterial(modelId, matName, pmxOrder) {
  const M = MODELS[modelId] ?? {};
  const ov = M.roleOverrides ?? {};
  const lo = M.layerOverrides ?? {};
  let role, hit;
  if (ov[matName]) { role = ov[matName]; hit = 'override'; }
  else { role = ruleRole(matName); hit = 'rule'; }
  const layer = lo[matName] ?? pmxOrder ?? 0;
  return { role, layer, hit, layerHit: lo[matName] !== undefined ? 'override' : 'pmxOrder' };
}
