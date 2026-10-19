#!/usr/bin/env node
/**
 * PMX morph 测绘脚本 —— 表情层的「有没有货」体检。
 *
 * 用途：在动手做表情层之前，先把一个 PMX 的表情资产量清楚，并对照语义槽位表
 * 报告覆盖率。**只读，不改任何文件。**
 *
 * 用法:
 *   node pipeline/morph-survey.mjs <file.pmx> [<file.pmx> ...] [--json]
 *
 * 输出:
 *   · morph 总数 / 类型分布（vertex / bone / material / uv / group）
 *   · 每个 morph 的影响元素数（elementCount）—— 区分「空壳」与「真有分量」
 *   · 按语义槽位表的覆盖率：哪些槽位这个模型能做、哪些做不了
 *
 * 槽位表的**正式**定义在 pipeline/expression-rules.mjs（本脚本直接 import，不再自带副本）。
 * 设计依据: docs/表情层-系统设计与指令协议.md §3.2
 *
 * ⚠️ confidence 字段的含义：
 *   'high'           名字无歧义，可直接采信
 *   'bone-derived'   左右归属靠骨骼位置几何判定（expression-rules 的 sideOf），可信
 *   'needs-eyeball'  名字能匹配，但语义归属必须目视标定后才能定稿
 */

import fs from 'node:fs';
import path from 'node:path';
import { MMDParser } from 'mmd-parser';
import { SLOT_GROUPS, SLOT_NAMES, SLOT_RULES, SLOTS } from './expression-rules.mjs';

// ---------- 语义槽位表（唯一源：expression-rules.mjs） ----------
// 把组 / 中文名摊平到规则上，报告里少写两次查表。
const RULES = SLOT_RULES.map((r) => ({
  ...r,
  cn: SLOTS[r.slot]?.cn ?? r.slot,
  group: SLOTS[r.slot]?.group ?? 'other',
}));
/** 兼容旧字段名：本文件内部统一用 RULES */
const SLOT_TABLE = RULES;

/** mmd-parser 的 morph.type 编号。见 PMX 2.0 规范。 */
const MORPH_TYPE = {
  0: 'group', 1: 'vertex', 2: 'bone',
  3: 'uvA', 4: 'uvB', 5: 'uvC', 6: 'uvD', 7: 'uvA4',
  8: 'material', 9: 'flip', 10: 'impulse',
};

const fmt = (n) => n.toLocaleString('en-US');

function parsePmx(file) {
  const buf = fs.readFileSync(file);
  return new MMDParser.Parser().parsePmx(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

function survey(file) {
  const pmx = parsePmx(file);
  const morphs = pmx.morphs ?? [];

  const byType = {};
  const rows = [];
  for (const m of morphs) {
    const type = MORPH_TYPE[m.type] ?? `type${m.type}`;
    byType[type] = (byType[type] ?? 0) + 1;
    rows.push({
      name: m.name,
      englishName: m.englishName || '',
      type,
      elements: m.elementCount ?? m.elements?.length ?? 0,
    });
  }

  // 槽位覆盖：一个槽位可命中多个 morph，全部记下
  const slots = {};
  const claimed = new Set();
  for (const rule of SLOT_TABLE) {
    const hit = rows.filter((r) => rule.re.some((re) => re.test(r.name)));
    if (!hit.length) continue;
    slots[rule.slot] = {
      cn: rule.cn,
      group: rule.group,
      confidence: rule.confidence,
      morphs: hit.map((r) => ({ name: r.name, type: r.type, elements: r.elements })),
    };
    for (const h of hit) claimed.add(h.name);
  }

  const empty = rows.filter((r) => r.elements === 0);
  return {
    file,
    total: rows.length,
    byType,
    elementSum: rows.reduce((s, r) => s + r.elements, 0),
    emptyMorphs: empty.map((r) => r.name),
    slots,
    uncoveredSlots: SLOT_NAMES.filter((s) => !slots[s]),
    unclaimedMorphs: rows.filter((r) => !claimed.has(r.name)).map((r) => `${r.name} (${r.type}, ${fmt(r.elements)})`),
    rows,
  };
}

function report(r) {
  console.log(`\n=== ${r.file}`);
  console.log(`morph 总数 ${r.total}   类型 ${JSON.stringify(r.byType)}   影响元素合计 ${fmt(r.elementSum)}`);
  if (r.emptyMorphs.length) {
    console.log(`⚠️  空壳 morph（elementCount = 0，无内容）${r.emptyMorphs.length} 个: ${r.emptyMorphs.join(' | ')}`);
  } else {
    console.log('空壳 morph: 0（全部有实际内容）');
  }

  const groups = SLOT_GROUPS.filter((g) => SLOT_TABLE.some((x) => x.group === g));
  console.log('\n槽位覆盖:');
  for (const g of groups) {
    const inGroup = SLOT_TABLE.filter((x) => x.group === g);
    const lines = [];
    for (const rule of inGroup) {
      const hit = r.slots[rule.slot];
      if (!hit) {
        lines.push(`  ❌ ${rule.slot.padEnd(18)} ${rule.cn}`);
        continue;
      }
      const mb = hit.morphs
        .sort((a, b) => b.elements - a.elements)
        .slice(0, 3)
        .map((m) => `${m.name} ${fmt(m.elements)}`)
        .join(' + ');
      const flag = hit.confidence === 'needs-eyeball' ? '  [归属需目视标定]'
        : hit.confidence === 'bone-derived' ? '  [左右由骨骼几何判定]' : '';
      lines.push(`  ✅ ${rule.slot.padEnd(18)} ${rule.cn.padEnd(8)} ← ${mb}${flag}`);
    }
    const okCount = inGroup.filter((x) => r.slots[x.slot]).length;
    console.log(`\n  ── ${g}（${okCount}/${inGroup.length}）`);
    console.log(lines.join('\n'));
  }

  const covered = Object.keys(r.slots).length;
  console.log(`\n覆盖 ${covered}/${SLOT_NAMES.length} 槽位`);
  if (r.uncoveredSlots.length) console.log(`未覆盖: ${r.uncoveredSlots.join(' ')}`);
  if (r.unclaimedMorphs.length) {
    console.log(`\n未被任何槽位认领的 morph ${r.unclaimedMorphs.length} 个（可能是模型专属演出，值得人工过一遍）:`);
    console.log('  ' + r.unclaimedMorphs.join('\n  '));
  }
}

// ---------- main ----------
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('用法: node pipeline/morph-survey.mjs <file.pmx> [...] [--json]');
  process.exit(1);
}

const results = [];
for (const f of files) {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) { console.error(`跳过（文件不存在）: ${f}`); continue; }
  results.push(survey(abs));
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) report(r);
}
