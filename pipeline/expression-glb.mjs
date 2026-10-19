#!/usr/bin/env node
/**
 * 表情契约转换器：契约 GLB + PMX → `expression-manifest.json`
 *
 * 用法:
 *   node pipeline/expression-glb.mjs si            # 单个模型
 *   node pipeline/expression-glb.mjs --all         # 所有 enabled 的模型
 *   node pipeline/expression-glb.mjs si --check    # 只校验，不写盘
 *
 * 前置：`pmx2glb.mjs --expr` 已经把 morph 写进 GLB（契约版由 charter-glb 继承）。
 *
 * 产物（运行期只读这一份）：
 *   assets/models/expression-manifest.json
 *     · slots       槽位表（名字 / 中文 / 组）—— UI 与校验共用
 *     · models[]    每个模型的：gazeMode / blinkSource / targets / bindings /
 *                   overrides / unresolved / coverage
 *
 * 为什么单独一个文件、而不是塞进 charter-manifest.json：
 *   材质契约与表情契约是**两条独立的演进线**（材质改族表、表情改槽位表），
 *   合在一起会让「跑一次 charter 就把表情打回原形」。分开写、各自幂等。
 *
 * 纪律：**转换期做名字判定，运行期只认索引。** manifest 里的 binding 落成
 * `target: <序号>`，three 加载后 morphTargetInfluences 的下标与之逐位对应。
 */

import fs from 'node:fs';
import path from 'node:path';
import { MMDParser } from 'mmd-parser';
import {
  EXPR_VERSION, GROUP_FALLBACK, MODEL_EXPR, SLOT_ALIASES, SLOTS, SLOT_GROUPS, SLOT_NAMES,
  capabilityOf, resolveExpression,
} from './expression-rules.mjs';
import { MODELS } from './charter-rules.mjs';

const MANIFEST = 'assets/models/expression-manifest.json';
const RIG_MANIFEST = 'assets/models/rig-manifest.json';
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const all = argv.includes('--all');
const ids = argv.filter((a) => !a.startsWith('--'));

/**
 * 视线走骨时，骨骼名从**骨骼契约**取（rig-manifest 的 slots.eye_l.key）。
 * 为什么不在 expression-rules 里手写骨名：手写会与 rig 的 sanitize 结果漂移，
 * 而且「这个模型有没有眼骨」本来就是 rig 契约的事实，不该抄第二份。
 */
const rigManifest = fs.existsSync(RIG_MANIFEST)
  ? JSON.parse(fs.readFileSync(RIG_MANIFEST, 'utf8'))
  : null;
const rigModelOf = (id) => rigManifest?.models?.find((m) => m.id === id) ?? null;

/** gaze 配置补齐骨名；bone 模式但找不到骨 → 降级为 none 并记 warning */
function resolveGaze(id, gaze, warnings) {
  const g = { ...(gaze ?? { mode: 'none' }) };
  if (g.mode !== 'bone') return g;
  // 档案显式给了骨名就直接用 —— 眼球骨 ≠ 瞳孔骨，谁是"能转的那根"是资产判断，
  // 不能由 rig 的 eye_l 槽位代劳（si 的 eye_l 映射到 `瞳左`，转了几乎不移动）。
  if (g.bones?.length === 2) return g;
  const rig = rigModelOf(id);
  const bones = (g.slots ?? ['eye_l', 'eye_r'])
    .map((s) => rig?.slots?.[s]?.key)
    .filter(Boolean);
  if (bones.length !== 2) {
    warnings.push(`gaze=bone 但骨骼契约里找不到 ${(g.slots ?? []).join('/')} —— 降级为 none`);
    return { mode: 'none' };
  }
  return { ...g, bones };
}

if (!all && !ids.length) {
  console.error('用法: node pipeline/expression-glb.mjs <id> [...] | --all  [--check]');
  process.exit(1);
}

/** 直读 GLB 的 JSON chunk（不依赖 gltf-transform：这里只看结构，不改文件） */
function readGlbJson(file) {
  const data = fs.readFileSync(file);
  let off = 12;
  while (off < data.length) {
    const len = data.readUInt32LE(off);
    const type = data.readUInt32LE(off + 4);
    if (type === 0x4E4F534A) return JSON.parse(data.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len;
  }
  throw new Error(`${file}: 找不到 JSON chunk`);
}

function parsePmx(file) {
  const buf = fs.readFileSync(file);
  return new MMDParser.Parser().parsePmx(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

let manifest = {
  exprVersion: EXPR_VERSION,
  /** 对外指令协议的版本。与 exprVersion 分开：槽位表可能不动，但指令集扩了 op */
  contractVersion: EXPR_VERSION,
  generatedAt: null,
  slots: SLOTS,
  groups: SLOT_GROUPS,
  models: [],
};
if (fs.existsSync(MANIFEST)) {
  try {
    const old = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (old.exprVersion === EXPR_VERSION) manifest = { ...manifest, ...old, slots: SLOTS, groups: SLOT_GROUPS };
  } catch { /* 重写 */ }
}

const targets = all
  ? Object.entries(MODEL_EXPR).filter(([, p]) => p.enabled !== false).map(([id]) => id)
  : ids;

let failed = false;

for (const id of targets) {
  const meta = MODELS[id];
  const profile = MODEL_EXPR[id] ?? {};
  if (!meta) { console.error(`✗ ${id}: charter-rules.mjs 的 MODELS 里没有登记`); failed = true; continue; }
  if (!meta.pmx) { console.error(`✗ ${id}: 没有 PMX 源（${meta.source}）——表情无从导出`); failed = true; continue; }

  const charterFile = `assets/models/${id}.charter.glb`;
  if (!fs.existsSync(charterFile)) { console.error(`✗ ${id}: 缺 ${charterFile}（先跑 npm run charter）`); failed = true; continue; }

  const glb = readGlbJson(charterFile);
  const mesh = glb.meshes?.[0];
  const prims = mesh?.primitives ?? [];
  const names = mesh?.extras?.targetNames ?? [];
  const counts = [...new Set(prims.map((p) => p.targets?.length ?? 0))];

  const expr = resolveExpression(parsePmx(path.resolve(meta.pmx)), id);
  const warnings = [];

  /* ---------- 结构校验 ---------- */
  if (!names.length) {
    console.error(`✗ ${id}: GLB 没有 morph target（先跑 pmx2glb --expr）`);
    failed = true;
    continue;
  }
  if (counts.length !== 1) {
    warnings.push(`primitive 间的 target 数不一致：${counts.join(' / ')}（glTF 规范要求一致）`);
  }
  if (counts[0] !== names.length) {
    warnings.push(`targetNames 数 ${names.length} ≠ primitive target 数 ${counts[0]}`);
  }

  /* ---------- 名字 → 索引，并核对稀疏实况 ---------- */
  const idxOf = new Map(names.map((n, i) => [n, i]));
  const targetRows = [];
  const accs = new Set();
  for (let i = 0; i < names.length; i++) {
    const ref = prims[0].targets?.[i]?.POSITION;
    if (ref === undefined) continue;
    if (accs.has(ref)) warnings.push(`target「${names[i]}」与前面的 target 共用 accessor（应各自独立）`);
    accs.add(ref);
    const acc = glb.accessors[ref];
    targetRows.push({
      index: i,
      name: names[i],
      verts: acc?.count ?? 0,
      affected: acc?.sparse?.count ?? acc?.count ?? 0,
      sparse: !!acc?.sparse,
    });
  }

  /* ---------- bindings：名字 → 索引 ---------- */
  const bindings = {};
  for (const [slot, list] of Object.entries(expr.bindings)) {
    const out = [];
    for (const b of list) {
      if (b.ch === 'morph') {
        const i = idxOf.get(b.target);
        if (i === undefined) { warnings.push(`${slot}: 「${b.target}」不在 GLB 的 targetNames 里`); continue; }
        out.push({ ch: 'morph', target: i, name: b.target, w: b.w });
      } else if (b.ch === 'material') {
        out.push({
          ch: 'material',
          material: b.material,
          materialIndex: b.materialIndex,
          morph: b.morph,
          prop: b.prop,
          mode: b.mode,
          value: b.value,
          w: b.w,
        });
      }
    }
    if (out.length) bindings[slot] = out;
  }

  /* ---------- 覆盖率核对：解析说能做到的，GLB 里必须真有 ---------- */
  const lostSlots = SLOT_NAMES.filter((s) => expr.bindings[s] && !bindings[s]);
  if (lostSlots.length) warnings.push(`解析命中但 GLB 缺失的槽位：${lostSlots.join(' ')}`);

  const gaze = resolveGaze(id, expr.gaze, warnings);

  const entry = {
    id,
    file: path.basename(charterFile),
    exprVersion: EXPR_VERSION,
    gazeMode: gaze.mode,
    gaze,
    blinkSource: expr.blinkSource,
    targetCount: targetRows.length,
    targets: targetRows,
    bindings,
    overrides: expr.overrides,
    unresolved: expr.unresolved,
    // ① 能力表（对外契约的「这个模型能做什么」）—— 转换期算好，运行期零推导
    capabilities: {
      ...capabilityOf(id, bindings),
      gaze,
      blink: expr.blinkSource !== 'none' && !!bindings.blink,
      material: Object.values(bindings).some((l) => l.some((b) => b.ch === 'material')),
      /** 离散 look_* 槽位没有、但能连续转视线（gaze.dir）时为 true */
      continuousGaze: gaze.mode !== 'none',
    },
    // ② 回退约定（对外契约的「做不到时怎么办」）
    fallback: { aliases: SLOT_ALIASES, groups: GROUP_FALLBACK },
    coverage: { covered: Object.keys(bindings).length, total: SLOT_NAMES.length },
    sideChecks: expr.sideChecks,
    note: profile.note ?? null,
    warnings: [...expr.warnings, ...warnings],
  };

  if (!checkOnly) {
    manifest.models = [...manifest.models.filter((m) => m.id !== id), entry];
    manifest.generatedAt = new Date().toISOString();
    manifest.exprVersion = EXPR_VERSION;
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }

  /* ---------- 报告 ---------- */
  const sparseRatio = targetRows.length
    ? targetRows.reduce((s, t) => s + t.affected, 0) / targetRows.reduce((s, t) => s + t.verts, 0)
    : 0;
  console.log(`\n━━ ${id} → ${path.basename(charterFile)}`);
  console.log(`target ${targetRows.length} · 每 primitive ${counts[0]} 个 · 顶点池 ${targetRows[0]?.verts?.toLocaleString()}`
    + ` · 平均稀疏度 ${(sparseRatio * 100).toFixed(2)}%`);
  console.log(`gaze=${gaze.mode}${gaze.bones ? `(${gaze.bones.join('/')} ±${gaze.maxDeg}°)` : gaze.maxDeg ? `(±${gaze.maxDeg}°)` : ''}`
    + ` blink=${expr.blinkSource} · 覆盖 ${entry.coverage.covered}/${entry.coverage.total} 槽位`);

  const groups = SLOT_GROUPS;
  for (const g of groups) {
    const slots = SLOT_NAMES.filter((s) => SLOTS[s].group === g);
    const parts = slots.map((s) => {
      if (!bindings[s]) return `\x1b[2m${s}\x1b[0m`;
      const what = bindings[s].map((b) => (b.ch === 'morph' ? b.name : `材质:${b.material}`)).join('+');
      return `${s}(${what})`;
    });
    console.log(`  ${g.padEnd(8)} ${parts.join('  ')}`);
  }
  if (entry.unresolved.length) console.log(`  \x1b[2m未覆盖（该模型做不了）: ${entry.unresolved.join(' ')}\x1b[0m`);
  for (const s of expr.sideChecks) {
    const ok = s.got === s.want;
    console.log(`  ${ok ? '✓' : '✗'} 左右 ${s.slot} ← 「${s.morph}」 质心 x=${s.cx?.toFixed(3)} → ${s.got}`);
  }
  if (entry.warnings.length) {
    console.log(`  ⚠ ${entry.warnings.length} 项提示：`);
    for (const w of entry.warnings) console.log(`    · ${w}`);
  }
}

if (!checkOnly) console.log(`\nmanifest → ${MANIFEST}`);
if (failed) process.exitCode = 1;
