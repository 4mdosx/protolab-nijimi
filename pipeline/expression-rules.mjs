#!/usr/bin/env node
/**
 * 表情规则 —— 表情层的**约定**（唯一源）。
 *
 * 与 charter-rules.mjs 同构：规则与执行分离。本文件只写「约定」，不写「怎么导」。
 *   本文件                     约定：槽位表 / 名字规则 / 各模型档案 / 槽位解析
 *   pipeline/pmx2glb.mjs       执行：把解析出的 morph 写进 GLB（--expr）
 *   pipeline/expression-glb.mjs 执行：读 GLB 的 targetNames，产出 expression-manifest.json
 *   pipeline/morph-survey.mjs   诊断：只读体检（覆盖率报告，直接 import 本文件的表）
 *   src/expression.ts           运行期：只读 manifest，不认名字
 *
 * 设计依据: docs/表情层-系统设计与指令协议.md §3
 *
 * ⚠️ 改这里的槽位名 = 改对外协议。改完必须同步跑：
 *   node pipeline/expression-glb.mjs <id>      # 重出 manifest
 *   node pipeline/morph-survey.mjs <pmx>       # 覆盖率体检
 * docs 里 §3.2 的表格也要跟着改（两处必须一致）。
 */

/** manifest 版本。运行期据此拒绝旧资产（与 CHARTER_VERSION 同一套路）。
 *  v2（2026-10-17）：加 capabilities / gaze / fallback —— 对外契约冻结的那三个块。 */
export const EXPR_VERSION = 2;

/* ------------------------------------------------------------------ *
 * ① 语义槽位表（35 个）
 *
 * 槽位是「引擎与游戏之间的语言」：稳定、跨模型。模型作者怎么命名 morph 与
 * 游戏怎么说话是两件事，中间那层映射住在 manifest 里。
 * ------------------------------------------------------------------ */

/** 组的顺序即 UI / 报告的分组顺序（情绪在前是因为它是高层语义）。 */
export const SLOT_GROUPS = ['emotion', 'blink', 'eye', 'mouth', 'look', 'brow', 'symbol'];

export const SLOTS = {
  // 情绪（6）—— 每个情绪的落地是「一组 binding 的合成」，模型间差异最大的就是这组
  happy:     { cn: '开心', group: 'emotion' },
  sad:       { cn: '难过', group: 'emotion' },
  angry:     { cn: '生气', group: 'emotion' },
  surprised: { cn: '惊讶', group: 'emotion' },
  relaxed:   { cn: '放松', group: 'emotion' },
  shy:       { cn: '害羞', group: 'emotion' },
  // 眨眼（3）
  blink:   { cn: '双眼闭', group: 'blink' },
  blink_l: { cn: '左眼闭', group: 'blink', side: 'left' },
  blink_r: { cn: '右眼闭', group: 'blink', side: 'right' },
  // 眼型（4）—— 演出用的底层量，比情绪更细
  squint:        { cn: '眯眼',   group: 'eye' },
  eye_wide:      { cn: '瞪眼',   group: 'eye' },
  pupil_small:   { cn: '瞳小',   group: 'eye' },
  highlight_off: { cn: '高光灭', group: 'eye' },
  // 口型（5）—— 对齐 MMD あいうえお / VRM aa·ih·ou·ee·oh
  mouth_a: { cn: '张嘴 あ', group: 'mouth' },
  mouth_i: { cn: '口型 い', group: 'mouth' },
  mouth_u: { cn: '口型 う', group: 'mouth' },
  mouth_e: { cn: '口型 え', group: 'mouth' },
  mouth_o: { cn: '口型 お', group: 'mouth' },
  // 视线（8）—— 只在 gazeMode='morph' 的模型上有。注意异环用 RU/LU/RD/LD
  // ⚠️ 这里**不能**写 side：`side` 的语义是「左右眼归属」（blink_l/blink_r 用），
  //    而 look_r 是「双眼一起看右」，做几何判定会得到「跨两侧」的假警告。
  look_u:  { cn: '看上',   group: 'look' },
  look_ur: { cn: '看右上', group: 'look' },
  look_r:  { cn: '看右',   group: 'look' },
  look_rd: { cn: '看右下', group: 'look' },
  look_d:  { cn: '看下',   group: 'look' },
  look_dl: { cn: '看左下', group: 'look' },
  look_l:  { cn: '看左',   group: 'look' },
  look_lu: { cn: '看左上', group: 'look' },
  // 眉（3）
  brow_up:    { cn: '眉上', group: 'brow' },
  brow_down:  { cn: '眉下', group: 'brow' },
  brow_angry: { cn: '怒眉', group: 'brow' },
  // 漫画符号（6）—— diorama 里的「演出道具」，不是所有模型都有
  symbol_sweat:      { cn: '汗',     group: 'symbol' },
  symbol_tears:      { cn: '泪',     group: 'symbol' },
  symbol_vein:       { cn: '怒符',   group: 'symbol' },
  symbol_star_eyes:  { cn: '星星眼', group: 'symbol' },
  symbol_black_line: { cn: '黑线',   group: 'symbol' },
  symbol_blush:      { cn: '脸红',   group: 'symbol' },
};

/** 全部槽位名（顺序 = SLOTS 声明顺序，导出目标顺序由此决定） */
export const SLOT_NAMES = Object.keys(SLOTS);

/* ------------------------------------------------------------------ *
 * ①b 回退约定（对外契约的一部分，运行期照此执行）
 *
 * 消费方可以「说任何一个槽位名」，但每个模型能实现哪些是**事实**。
 * 所以约定必须写死「做不到时怎么办」，而不是让消费方自己判空：
 *
 *   ① 同义替代（SLOT_ALIASES）—— 只有当两个槽位在该模型上落在**同一份
 *      资产**时才登记（否则就是骗人）。例：si 的 shy 与 symbol_blush 共用
 *      材质 11「表情」的同一层 alpha，互换完全无损。
 *   ② 组级回落（GROUP_FALLBACK）—— 该组回到中性。`null` = 清掉该组，
 *      不是「保持上一次」：保持会让「她说她生气了」之后一直挂着怒眉。
 *   ③ 模型无表情层 —— 整条指令丢弃，只把 motion 转交动作系统。
 *
 * 三级都要发 Notice（见 src/exp-contract.ts 的 ExpNotice），不许静默。
 * ------------------------------------------------------------------ */

export const SLOT_ALIASES = {
  symbol_blush: ['shy'],
  shy: ['symbol_blush'],
};

export const GROUP_FALLBACK = {
  emotion: { to: null, cn: '回到中性脸' },
  blink: { to: null, cn: '交回自动眨眼' },
  eye: { to: null, cn: '回到默认眼型' },
  mouth: { to: null, cn: '闭嘴' },
  look: { to: null, cn: '视线回正前方' },
  brow: { to: null, cn: '眉毛回默认' },
  symbol: { to: null, cn: '不显示符号层' },
};

/** 一组槽位 → 该组在指定模型上「能做 / 做不了」 */
export function capabilityOf(modelId, bindings) {
  const have = Object.keys(bindings ?? {}).filter((s) => SLOTS[s]);
  const missing = SLOT_NAMES.filter((s) => !bindings?.[s]);
  const byGroup = {};
  for (const g of SLOT_GROUPS) {
    const inGroup = SLOT_NAMES.filter((s) => SLOTS[s].group === g);
    byGroup[g] = {
      have: inGroup.filter((s) => have.includes(s)),
      missing: inGroup.filter((s) => !have.includes(s)),
    };
  }
  return { modelId, slots: have, missing, byGroup };
}

/* ------------------------------------------------------------------ *
 * ② 名字规则（PMX morph 名 → 槽位）
 *
 * 只在**转换期**用。运行期只认 manifest 里的 target 索引，不做名字判定。
 * 每组内「具体优先」：先最窄的正则，最后才是通配。
 *
 * confidence:
 *   'high'          名字无歧义，可直接采信
 *   'bone-derived'  靠骨骼位置几何判定左右（见 resolveSide），可信
 *   'needs-eyeball' 名字能匹配但语义归属仍需目视标定（第一版先不用它）
 * ------------------------------------------------------------------ */

export const SLOT_RULES = [
  // ---- 眨眼 ----
  { slot: 'blink_l', re: [/^ウィンク$/, /^blink[_-]?l$/i], confidence: 'bone-derived' },
  { slot: 'blink_r', re: [/^ウィンク右$/, /^ｳｨﾝｸ２右$/, /^blink[_-]?r$/i], confidence: 'bone-derived' },
  { slot: 'blink', re: [/^まばたき$/, /^blink$/i, /^eye[s]?clo$/i], confidence: 'high' },
  // ---- 眼型 ----
  { slot: 'squint', re: [/^じと目$/, /^biyan\d*$/i, /^目を細める$/], confidence: 'high' },
  { slot: 'eye_wide', re: [/^(ｷﾘｯ|ｷﾘｯ2)$/, /^eye_.*wide$/i], confidence: 'high' },
  { slot: 'pupil_small', re: [/^瞳小$/], confidence: 'high' },
  { slot: 'highlight_off', re: [/^ハイライト消$/, /^eye_SF$/i], confidence: 'high' },
  // ---- 口型 ----
  { slot: 'mouth_a', re: [/^あ$/, /^jawOpen_a$/i], confidence: 'high' },
  { slot: 'mouth_i', re: [/^い$/, /^jawOpen_yi$/i], confidence: 'high' },
  { slot: 'mouth_u', re: [/^う$/, /^jawOpen_wu$/i], confidence: 'high' },
  { slot: 'mouth_e', re: [/^え$/, /^jawOpen_ei$/i], confidence: 'high' },
  { slot: 'mouth_o', re: [/^お$/, /^jawOpen_o$/i], confidence: 'high' },
  // ---- 视线 ----
  { slot: 'look_u', re: [/^look_U$/, /^EL_Up$/i], confidence: 'high' },
  { slot: 'look_d', re: [/^look_D$/, /^EL_Down$/i], confidence: 'high' },
  { slot: 'look_l', re: [/^look_L$/], confidence: 'high' },
  { slot: 'look_r', re: [/^look_R$/], confidence: 'high' },
  { slot: 'look_lu', re: [/^look_(LU|UL)$/], confidence: 'high' },
  { slot: 'look_ur', re: [/^look_(RU|UR)$/], confidence: 'high' },
  { slot: 'look_dl', re: [/^look_(LD|DL)$/], confidence: 'high' },
  { slot: 'look_rd', re: [/^look_(RD|DR)$/], confidence: 'high' },
  // ---- 眉 ----
  { slot: 'brow_up', re: [/^上$/, /^EL_(CornerUp|Light_Up)$/i], confidence: 'needs-eyeball' },
  { slot: 'brow_down', re: [/^下$/, /^EL_(CornerDown|Light_L)$/i], confidence: 'needs-eyeball' },
  { slot: 'brow_angry', re: [/^真面目$/, /^EB_Angry/i], confidence: 'high' },
  // ---- 情绪 ----
  // `_OP` / `_CLO` 成对时**默认取 OP**（睁眼版）：闭眼版是配合眨眼的变体，
  // 归 manifest 的 variants 字段，不占主槽位（见 §5.3）。
  { slot: 'happy', re: [/^笑い$/, /^EL_(Happy|Smile)/i], confidence: 'high' },
  { slot: 'sad', re: [/^困る$/, /^EL_Sad/i], confidence: 'high' },
  { slot: 'angry', re: [/^怒り$/, /^EL_(Angry|Despise|Evil)/i], confidence: 'high' },
  { slot: 'surprised', re: [/^びっくり$/, /^EL_Surprised/i], confidence: 'high' },
  { slot: 'relaxed', re: [/^なごみ$/, /^EL_(Tired|Serious)/i], confidence: 'needs-eyeball' },
  { slot: 'shy', re: [/^照れ$/, /TDS_(haixiu|lianhong)/i], confidence: 'needs-eyeball' },
  // ---- 漫画符号 ----
  { slot: 'symbol_sweat', re: [/^TD_(Sweaty)$/i, /^TDS_(liuhan|Sweaty)/i], confidence: 'high' },
  { slot: 'symbol_tears', re: [/^TDS_(liulei|leizhu|yankuanglei|gandonglei)/i], confidence: 'high' },
  { slot: 'symbol_vein', re: [/^TD_Veins$/i], confidence: 'high' },
  { slot: 'symbol_star_eyes', re: [/^TDS_StarEyes$/i], confidence: 'high' },
  { slot: 'symbol_black_line', re: [/^TDS_heixian$/i], confidence: 'high' },
  { slot: 'symbol_blush', re: [/^TDS_(lianhong|haixiu)$/i, /^照れ$/], confidence: 'needs-eyeball' },
];

/* ------------------------------------------------------------------ *
 * ③ 模型档案 —— 每个模型的事实，不是通用规则
 *
 * picks: 显式指定槽位用哪个 morph。**优先于名字规则**——因为「哪个 morph 才是
 *        这个模型上最好的『开心』」是资产判断，不是字符串匹配能决定的。
 *        （si 的 笑い 3,386 顶点 vs にっこり 1,060 顶点：前者是整眼区笑起来，
 *         后者只是嘴角，做 `happy` 当然用前者。）
 * skip:  明确知道做不了的槽位组，别让名字规则瞎猜。
 * ------------------------------------------------------------------ */

export const MODEL_EXPR = {
  si: {
    // 无 look_* morph，但骨架有 eye_l/eye_r（`瞳左`/`瞳右`）→ 视线走眼骨。
    // 与 akane 的 morph 方案共用同一个 `gaze.dir` 指令，消费方不用关心差别。
    gazeMode: 'bone',
    // 视线骨必须显式指定：si 的层级是 `左目`(眼球, 296 顶点区) → `瞳左`(瞳孔贴片,
    // 896 顶点, 在眼球前方 z=-0.747)。rig-rules 把 eye_l 槽位映射到 `瞳左`，
    // 但转瞳孔贴片只是让它自转（几乎无位移），看起来像"眼睛没动"。
    // **测过：先用瞳左做的 ±10°／±20° 两版截图，瞳孔都没平移。**
    // ±20°：眼球的常见上限，再大虹膜会压到眼睑。
    gaze: { mode: 'bone', maxDeg: 20, bones: ['左目', '右目'] },
    blinkSource: 'morph',
    picks: {
      happy: '笑い',
      sad: '困る',
      angry: '怒り',
      surprised: 'びっくり',
      relaxed: 'なごみ',
      blink: 'まばたき',
      blink_l: 'ウィンク',
      blink_r: 'ウィンク右',
      squint: 'じと目',
      eye_wide: 'ｷﾘｯ',
      pupil_small: '瞳小',
      highlight_off: 'ハイライト消',
      mouth_a: 'あ',
      mouth_i: 'い',
      mouth_u: 'う',
      mouth_e: 'え',
      mouth_o: 'お',
      brow_up: '上',
      brow_down: '下',
      brow_angry: '真面目',
    },
    // 情绪激活时底层通道的让位策略（VRM 1.0 语义，§5.3）
    overrides: {
      happy: { blink: 'blend', mouth: 'blend' },
      angry: { blink: 'blend', mouth: 'blend' },
      sad: { blink: 'blend', mouth: 'blend' },
      surprised: { blink: 'blend', mouth: 'blend' },
    },
    note: '终末地·祀：41 个 morph（40 vertex + 1 material）。无 look_*、无漫画符号，'
      + '「照れ」是 material morph（材质 11「表情」的叠加层，靠 alpha 渐显）。',
  },

  akane: {
    // 8 方向 look_* 齐全 → 视线走 morph，与姿势层正交（不写骨，零竞争）
    gazeMode: 'morph',
    // mirrorX：该资产的 look_L/look_R 按**观众视角**命名（实测 `gaze.dir(1,0)` 点亮
    // look_R 后瞳孔偏向观众右侧 = 角色左侧）。契约的方向是角色视角，所以横向取反。
    gaze: { mode: 'morph', maxDeg: 18, mirrorX: true },
    blinkSource: 'morph',
    enabled: true,
    /**
     * 162 个 morph 里挑 35 个。**这里是资产判断，不是字符串匹配。**
     *
     * 三条挑选依据：
     * ① `EL_*_OP` 优先于 `_CLO`：`_CLO` 是「情绪 + 闭眼」的合成变体，
     *    留给眨眼的 override 仲裁用；主槽位必须用睁眼版，否则平时就是闭着眼。
     * ② 影响元素数不是唯一标准，但**同义时选覆盖更全的**：`EL_Sad_01_OP`
     *    动 2,086 个顶点，MMD 标准 `困る` 只动 346 个 —— 前者是整眼区情绪，
     *    后者只是眉间，做 `sad` 当然用前者。
     * ③ `happy` 没有 `EL_Happy_01_OP`（这套资产只给了 `_l/_r_CLO` 的左右分开
     *    闭眼笑），所以用 MMD 标准 `笑い`。这是资产事实，不是遗漏。
     */
    picks: {
      happy: '笑い',
      sad: 'EL_Sad_01_OP',
      angry: 'EL_Angry_01_OP',
      surprised: 'EL_Surprised_01',
      relaxed: 'EL_Tired_01_OP',
      shy: 'TDS_haixiu',
      blink: 'まばたき',
      blink_l: 'ウィンク',
      blink_r: 'ウィンク右',
      squint: 'biyan',
      eye_wide: 'ｷﾘｯ',
      pupil_small: '瞳小',
      highlight_off: 'eye_SF',
      mouth_a: 'あ',
      mouth_i: 'い',
      mouth_u: 'う',
      mouth_e: 'え',
      mouth_o: 'お',
      look_u: 'look_U',
      look_ur: 'look_RU',
      look_r: 'look_R',
      look_rd: 'look_RD',
      look_d: 'look_D',
      look_dl: 'look_LD',
      look_l: 'look_L',
      look_lu: 'look_LU',
      brow_up: 'EL_CornerUp',
      brow_down: 'EL_CornerDown',
      brow_angry: 'EB_Angry_01',
      symbol_sweat: 'TDS_liuhan',
      symbol_tears: 'TDS_liulei_01',
      symbol_vein: 'TD_Veins',
      symbol_star_eyes: 'TDS_StarEyes',
      symbol_black_line: 'TDS_heixian',
      symbol_blush: 'TDS_lianhong',
    },
    overrides: {
      happy: { blink: 'blend', mouth: 'blend' },
      angry: { blink: 'blend', mouth: 'blend' },
      sad: { blink: 'blend', mouth: 'blend' },
      surprised: { blink: 'blend', mouth: 'blend' },
    },
    note: '异环·明音凛：162 个 morph。选 35 个导出（其余留在源里）：'
      + 'EL_*_OP/_CLO 成对情绪（CLO 留给眨眼仲裁）、8 方向视线、jawOpen 五元音、'
      + 'TD_*/TDS_* 漫画符号、EB_* 眉层。'
      + '注：happy 用 MMD 标准「笑い」= 眯眼笑 —— 这套资产没有睁眼笑版'
      + '（EL_Happy_l/_r_CLO、EL_Smile_01_CLO 全是闭眼）。',
  },

  yelan: {
    gazeMode: 'none',
    blinkSource: 'none',
    enabled: false,
    note: '原神·夜兰：PMX 源不在库内（只有 GLB），morph 无从谈起。要做需先补源。',
  },
};

/* ------------------------------------------------------------------ *
 * ④ 槽位解析（转换期）
 * ------------------------------------------------------------------ */

const MORPH_TYPE = {
  0: 'group', 1: 'vertex', 2: 'bone',
  3: 'uvA', 4: 'uvB', 5: 'uvC', 6: 'uvD', 7: 'uvA4',
  8: 'material', 9: 'flip', 10: 'impulse',
};

/** PMX 材质 morph 的作用模式：0=乘算 1=加算（PMX 2.0 规范） */
const materialMode = (t) => (t === 0 ? 'mul' : 'add');

/**
 * 左右归属的**几何判定**：拿眼部骨骼的位置当基准，比较 morph 所影响顶点的
 * 质心在 X 轴的同侧关系。
 *
 * 为什么可信：MMD 骨架有强制的 `左目` / `右目`，而 wink 类 morph 只影响单侧眼周。
 * si 实测：ウィンク 质心 +0.543 / ウィンク右 -0.542，`左目` 骨骼 +0.291 ——
 * 符号一比就能定，不需要拉权重渲染一帧去目视。
 */
function sideOf(pmx, morph) {
  const elems = morph.elements ?? [];
  if (!elems.length) return null;
  let sx = 0, n = 0, min = Infinity, max = -Infinity;
  for (const e of elems) {
    const p = pmx.vertices[e.index]?.position;
    if (!p) continue;
    sx += p[0]; n++;
    if (p[0] < min) min = p[0];
    if (p[0] > max) max = p[0];
  }
  if (!n) return null;
  const cx = sx / n;
  const left = pmx.bones?.find((b) => b.name === '左目');
  const right = pmx.bones?.find((b) => b.name === '右目');
  // 没有标准眼部骨骼就退回「质心偏离中线」判（阈值取包围盒宽度的一小部分）
  const mid = left && right ? (left.position[0] + right.position[0]) / 2 : 0;
  const span = Math.max(Math.abs(min - mid), Math.abs(max - mid));
  const off = cx - mid;
  // 影响面覆盖两侧（|偏移| < 幅度的 25%）= 不是单侧 morph
  if (span <= 1e-6 || Math.abs(off) < span * 0.25) return { side: 'both', cx, off };
  return { side: off > 0 ? 'left' : 'right', cx, off };
}

/** morph 名 → morph 对象（重名时取第一个，与 mmd-parser 的读取顺序一致） */
function indexMorphs(pmx) {
  const byName = new Map();
  for (const m of pmx.morphs ?? []) if (!byName.has(m.name)) byName.set(m.name, m);
  return byName;
}

/** 统一成一个 binding：{ch, ...}。vertex → morph 通道，material → 材质通道。 */
function bindingOf(pmx, morph, weight) {
  const type = MORPH_TYPE[morph.type] ?? `type${morph.type}`;
  if (type === 'vertex') {
    return { ch: 'morph', target: morph.name, w: weight, affected: morph.elementCount };
  }
  if (type === 'material') {
    // 材质 morph 只能运行期施加（glTF 的 morph target 只吃 POSITION/NORMAL/TANGENT）
    const out = [];
    for (const e of morph.elements ?? []) {
      const mat = pmx.materials[e.index];
      out.push({
        ch: 'material',
        material: mat?.name ?? `#${e.index}`,
        materialIndex: e.index,
        morph: morph.name,
        prop: 'opacity',
        mode: materialMode(e.type),
        // 只记「该分量相对基值的增量」，基值由运行期从材质读（不重复写死）
        value: e.diffuse?.[3] ?? 0,
        diffuse: (e.diffuse ?? []).slice(0, 3),
        w: weight,
      });
    }
    return out.length === 1 ? out[0] : out;
  }
  return null; // 其余类型（group/bone/uv/flip/impulse）暂不导出，调用方记 warning
}

/**
 * 解析一个模型的槽位 → binding。**转换期唯一入口。**
 *
 * @param {object} pmx  mmd-parser 的 PMX 对象
 * @param {string} modelId
 * @returns {{modelId, gazeMode, blinkSource, bindings, targets, unresolved,
 *            overrides, warnings, coverage}}
 */
export function resolveExpression(pmx, modelId) {
  const profile = MODEL_EXPR[modelId] ?? {};
  const byName = indexMorphs(pmx);
  const bindings = {};
  const targets = [];      // 需要导出的 vertex morph（去重、有序）
  const unresolved = [];
  const warnings = [];
  const sideChecks = [];
  const picked = new Set();  // 已被 picks 认领的 morph 名（避免名字规则重复认领）

  const ruleOf = (slot) => SLOT_RULES.find((r) => r.slot === slot);

  const add = (slot, morph, weight = 1) => {
    const b = bindingOf(pmx, morph, weight);
    if (!b) {
      warnings.push(`${slot}: 「${morph.name}」类型 ${MORPH_TYPE[morph.type]} 暂不支持导出`);
      return false;
    }
    const list = Array.isArray(b) ? b : [b];
    bindings[slot] = list;
    for (const one of list) {
      if (one.ch === 'morph' && !targets.some((t) => t.name === one.target)) {
        targets.push({ name: one.target, affected: one.affected });
      }
    }
    return true;
  };

  // ---- ① 显式 picks 优先 ----
  for (const [slot, name] of Object.entries(profile.picks ?? {})) {
    const m = byName.get(name);
    if (!m) {
      warnings.push(`${slot}: 档案指定的 morph「${name}」在该 PMX 里不存在（档案过期？）`);
      continue;
    }
    picked.add(name);
    add(slot, m);
    // 左右槽位做一次几何校验：picks 写错了会在这里立刻暴露
    const wantSide = SLOTS[slot]?.side;
    if (wantSide) {
      const s = sideOf(pmx, m);
      sideChecks.push({ slot, morph: name, want: wantSide, got: s?.side ?? null, cx: s?.cx ?? null });
      if (s && s.side !== 'both' && s.side !== wantSide) {
        warnings.push(`${slot}: 档案指定「${name}」但几何判定在${s.side === 'left' ? '左' : '右'}侧`
          + `（期望${wantSide === 'left' ? '左' : '右'}）——左右可能写反了`);
      }
    }
  }

  // ---- ② 剩余的槽位走名字规则 ----
  for (const slot of SLOT_NAMES) {
    if (bindings[slot]) continue;
    const rule = ruleOf(slot);
    if (!rule) { unresolved.push(slot); continue; }
    // 不去重「已被别的槽位用过的 morph」：一个 morph 服务多个槽位是合法的
    // （si 的「照れ」既该是 shy 也该是 symbol_blush，运行期按材质取 max）。
    // vertex morph 的重复引用也不会多导一份——targets 按名去重。
    const hits = [...byName.values()].filter((m) => rule.re.some((re) => re.test(m.name)));
    if (!hits.length) { unresolved.push(slot); continue; }
    // 排序两条，**顺序不能换**：
    //   ① 睁眼版优先（非 `_CLO`）。`EL_Sad_01_CLO` 比 `_OP` 多几个顶点（闭上的
    //      眼皮盖住了眼眶轮廓），纯按元素数会选到「一直闭着眼」的版本。
    //   ② 影响元素多的优先（更「完整」的表情）。
    const isClo = (n) => (/_CLO$/i.test(n) ? 1 : 0);
    hits.sort((a, b) => isClo(a.name) - isClo(b.name) || (b.elementCount ?? 0) - (a.elementCount ?? 0));
    if (hits.length > 1) {
      warnings.push(`${slot}: 命中 ${hits.length} 个（${hits.map((h) => h.name).join(' / ')}）`
        + `，取「${hits[0].name}」；其余如需一并叠加请写进 MODEL_EXPR.${modelId}.picks`);
    }
    picked.add(hits[0].name);
    add(slot, hits[0]);
  }

  // ---- ③ 排序整理：targets 按「首个引用它的槽位」在 SLOT_NAMES 里的位置排 ----
  // 导出与 manifest 共用这一套顺序，所以运行期的 target 索引是稳定的。
  const slotIndex = new Map(SLOT_NAMES.map((s, i) => [s, i]));
  const firstSlot = new Map();   // morph 名 → 最小槽位序
  for (const [slot, list] of Object.entries(bindings)) {
    const si = slotIndex.get(slot) ?? 999;
    for (const b of list) {
      if (b.ch !== 'morph') continue;
      if (!firstSlot.has(b.target) || si < firstSlot.get(b.target)) firstSlot.set(b.target, si);
    }
  }
  targets.sort((a, b) => (firstSlot.get(a.name) ?? 999) - (firstSlot.get(b.name) ?? 999));

  const covered = SLOT_NAMES.filter((s) => bindings[s]).length;
  const gazeMode = profile.gaze?.mode ?? profile.gazeMode ?? 'none';
  return {
    modelId,
    gazeMode,
    gaze: profile.gaze ?? { mode: gazeMode },
    blinkSource: profile.blinkSource ?? 'morph',
    bindings,
    targets,
    unresolved,
    overrides: profile.overrides ?? {},
    // 能力表：manifest 直接写死，运行期零推导（与「转换期判定、运行期查表」同一纪律）
    capabilities: {
      ...capabilityOf(modelId, bindings),
      gaze: profile.gaze ?? { mode: gazeMode },
      blink: (profile.blinkSource ?? 'morph') !== 'none' && !!bindings.blink,
      material: Object.values(bindings).some((l) => l.some((b) => b.ch === 'material')),
    },
    fallback: { aliases: SLOT_ALIASES, groups: GROUP_FALLBACK },
    sideChecks,
    warnings,
    coverage: { covered, total: SLOT_NAMES.length },
  };
}

/** 组 → 槽位名列表（报告与 UI 用） */
export function slotsOfGroup(group) {
  return SLOT_NAMES.filter((s) => SLOTS[s].group === group);
}
