#!/usr/bin/env node
/**
 * cy-chat 索引同步引擎
 *
 * 把「磁盘上的文件」和「JSON 索引」对齐。一条命令完成：
 *   识别真实类型 -> 校验 -> 内容去重 -> 分类归位 -> 分配 ID -> 重建索引 -> 输出报告
 *
 * 用法：
 *   node scripts/sync-index.mjs                  # 试运行，只报告不改动
 *   node scripts/sync-index.mjs --write          # 实际写入（JSON + 移动文件 + 删除重复）
 *   node scripts/sync-index.mjs --write --no-move  # 写 JSON 但不移动文件
 *   node scripts/sync-index.mjs --json           # 额外输出机器可读报告
 *
 * 设计要点：
 *   Meme 侧 = 镜像式。图片文件本身是权威，索引向磁盘看齐（会清理孤儿条目）。
 *   Word 侧 = 追加式。文字没有实体文件承载，索引是权威，脚本只增不删。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMAGE_TYPES, EXT_BY_TYPE, WEB_SAFE_TYPES, MEME_CATEGORIES, WORD_CATEGORIES,
  sniffImageType, readImageSize, sha1, walkFiles, categoryFromPath,
  isExtensionAcceptable, baseName, idNumber, formatId,
} from './lib/identify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const OPT = {
  write: argv.includes('--write'),
  move: !argv.includes('--no-move'),
  json: argv.includes('--json'),
  out: (argv.find((a) => a.startsWith('--out=')) || '').split('=')[1] || null,
  jsonFile: (argv.find((a) => a.startsWith('--json-file=')) || '').split('=')[1] || null,
  defaultCategory: (argv.find((a) => a.startsWith('--default-category=')) || '').split('=')[1] || 'reactions',
  root: (argv.find((a) => a.startsWith('--root=')) || '').split('=')[1] || REPO_ROOT,
};

if (!Object.keys(MEME_CATEGORIES).includes(OPT.defaultCategory)) {
  console.error(`✖ --default-category 必须是 ${Object.keys(MEME_CATEGORIES).join(' / ')} 之一`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 报告收集器
 * ------------------------------------------------------------------ */

const report = {
  mode: OPT.write ? 'write' : 'dry-run',
  startedAt: new Date().toISOString(),
  meme: { scanned: 0, valid: 0, added: 0, kept: 0, moved: 0, removedOrphans: 0, duplicates: [], formatWarnings: [], failed: [] },
  word: { files: 0, added: 0, kept: 0 },
  warnings: [],
  errors: [],
  operations: [],
};

const warn = (msg) => report.warnings.push(msg);
const fail = (msg) => report.errors.push(msg);
const op = (kind, from, to, note = '') => report.operations.push({ kind, from, to, note });

/* ------------------------------------------------------------------ *
 * IO 辅助
 * ------------------------------------------------------------------ */

const MEME_JSON = path.join(OPT.root, 'Meme/meme.json');
const WORD_JSON = path.join(OPT.root, 'Word/word.json');
const IMAGES_DIR = path.join(OPT.root, 'Meme/images');
const WORDS_DIR = path.join(OPT.root, 'Word/words');

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`JSON 解析失败 ${path.relative(OPT.root, file)}: ${err.message}`);
    return null;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 稳定序列化：递归排序对象 key，消除 key 顺序造成的假差异。
 * 用于判断「内容到底变没变」。
 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * 内容没变时沿用旧的 updatedAt。
 * 否则每次同步都会刷新时间戳，CI 在「有触发但没有实质改动」时也会产生一次空提交。
 */
function keepTimestampIfUnchanged(file, next) {
  const prev = loadJson(file);
  if (!prev) return next;
  const a = stableStringify({ ...prev, updatedAt: null });
  const b = stableStringify({ ...next, updatedAt: null });
  if (a === b && prev.updatedAt) next.updatedAt = prev.updatedAt;
  return next;
}

/** 稳定排序，让输出可复现 */
const byPath = (a, b) => a.localeCompare(b, 'en');

/* ------------------------------------------------------------------ *
 * Meme：镜像式同步
 * ------------------------------------------------------------------ */

function syncMeme() {
  const old = loadJson(MEME_JSON) || { categories: {} };
  const validKeys = Object.keys(MEME_CATEGORIES);

  // ---- 1. 建立旧条目索引：basename -> item（url 和 id 都要变，文件名是唯一稳定锚点）
  const oldByBase = new Map();
  for (const [cat, group] of Object.entries(old.categories || {})) {
    for (const item of group.items || []) {
      if (!item?.url) continue;
      oldByBase.set(baseName(item.url), { ...item, __oldCat: cat });
    }
  }

  // ---- 2. 扫描 + 识别
  const relPaths = walkFiles(IMAGES_DIR).sort(byPath);
  report.meme.scanned = relPaths.length;

  const seen = [];          // 识别成功的文件
  for (const rel of relPaths) {
    const abs = path.join(IMAGES_DIR, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      report.meme.failed.push({ file: rel, reason: `读取失败: ${err.message}` });
      fail(`无法读取 ${rel}: ${err.message}`);
      continue;
    }

    const type = sniffImageType(buf);
    if (!IMAGE_TYPES.includes(type)) {
      report.meme.failed.push({ file: rel, reason: `不是有效图片（识别为 ${type}）` });
      warn(`跳过非图片文件: ${rel}（文件头识别为 ${type}）`);
      continue;
    }

    const size = readImageSize(buf, type);
    if (!size) warn(`无法解析尺寸: ${rel}（已登记，尺寸字段留空）`);
    if (!WEB_SAFE_TYPES.includes(type)) {
      report.meme.formatWarnings.push({ file: rel, format: type });
      warn(`格式兼容性: ${rel} 是 ${type.toUpperCase()}，浏览器与多数客户端无法直接渲染，建议转成 JPG/PNG`);
    }

    seen.push({
      rel,
      abs,
      type,
      bytes: buf.length,
      hash: sha1(buf),
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
  }

  // ---- 3. 内容去重：同一份图只留一个
  const byHash = new Map();
  for (const f of seen) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }

  const survivors = [];
  for (const group of byHash.values()) {
    if (group.length === 1) { survivors.push(group[0]); continue; }

    // 保留策略：优先已经被索引登记的 -> 优先已在正确分类目录里的 -> 路径字典序
    const ranked = [...group].sort((a, b) => {
      const aKnown = oldByBase.has(baseName(a.rel)) ? 0 : 1;
      const bKnown = oldByBase.has(baseName(b.rel)) ? 0 : 1;
      if (aKnown !== bKnown) return aKnown - bKnown;
      const aCat = categoryFromPath(a.rel, validKeys) ? 0 : 1;
      const bCat = categoryFromPath(b.rel, validKeys) ? 0 : 1;
      if (aCat !== bCat) return aCat - bCat;
      return a.rel.localeCompare(b.rel, 'en');
    });

    const keep = ranked[0];
    survivors.push(keep);
    const dropped = ranked.slice(1);
    report.meme.duplicates.push({ keep: keep.rel, dropped: dropped.map((d) => d.rel) });
    for (const d of dropped) {
      op('delete', `Meme/images/${d.rel}`, '', `与 ${keep.rel} 内容完全相同（SHA1 ${keep.hash.slice(0, 12)}…）`);
    }
  }
  report.meme.valid = survivors.length;

  // ---- 4. 分类归位 + 生成条目
  const usedTargets = new Set();
  const planned = [];
  const looseFiles = [];   // 平铺在 images/ 根目录、读不出分类的文件

  for (const f of survivors.sort((a, b) => a.rel.localeCompare(b.rel, 'en'))) {
    const fromPath = categoryFromPath(f.rel, validKeys);
    let category = fromPath;
    if (!category) {
      category = OPT.defaultCategory;
      looseFiles.push(f.rel);
    }

    // 目标文件名：只有扩展名与真实类型真正对不上时才规范化
    const wantExt = EXT_BY_TYPE[f.type];
    let file = path.basename(f.rel);
    if (!isExtensionAcceptable(path.extname(file), f.type)) {
      const fixed = baseName(file) + wantExt;
      warn(`扩展名与真实类型不符: ${f.rel} 实为 ${f.type.toUpperCase()}，已规范为 ${fixed}`);
      report.meme.formatWarnings.push({ file: f.rel, actual: f.type, declared: path.extname(file) });
      file = fixed;
    }

    // 同名冲突（不同内容、同一目标名）时加序号
    let target = `Meme/images/${category}/${file}`;
    let seq = 2;
    while (usedTargets.has(target.toLowerCase())) {
      file = `${baseName(file)}-${seq}${path.extname(file)}`;
      target = `Meme/images/${category}/${file}`;
      seq++;
    }
    usedTargets.add(target.toLowerCase());

    const src = `Meme/images/${f.rel}`;
    if (OPT.move && src !== target) {
      op('move', src, target, fromPath ? `分类归位` : `归入默认分类 ${category}`);
      report.meme.moved++;
    }

    planned.push({ ...f, category, file, src, target });
  }

  if (looseFiles.length) {
    warn(
      `Meme/images/ 根目录下有 ${looseFiles.length} 个文件未放入分类子目录，已按默认策略归入 "${OPT.defaultCategory}"。` +
      `建议以后直接放到 Meme/images/{${validKeys.join('|')}}/ 下，路径即分类。` +
      (looseFiles.length <= 3 ? ` 涉及: ${looseFiles.join(', ')}` : '')
    );
  }

  // ---- 5. 分配 ID（老条目沿用原 ID，新条目续号）
  let maxNum = 0;
  for (const it of oldByBase.values()) maxNum = Math.max(maxNum, idNumber(it.id));

  const inUse = new Set();
  for (const p of planned) {
    const oldItem = oldByBase.get(baseName(p.rel)) || oldByBase.get(baseName(p.file));
    if (oldItem?.id && !inUse.has(oldItem.id)) {
      p.id = oldItem.id;
      inUse.add(oldItem.id);
    }
  }
  for (const p of planned) {
    if (p.id) continue;
    let n = ++maxNum;
    while (inUse.has(formatId('meme', n))) n = ++maxNum;
    p.id = formatId('meme', n);
    inUse.add(p.id);
  }

  // ---- 6. 组装新索引
  const categories = {};
  for (const key of validKeys) {
    const meta = MEME_CATEGORIES[key];
    // 保留原文件中已有的 label/description 覆盖
    const prev = old.categories?.[key] || {};
    categories[key] = {
      label: prev.label || meta.label,
      description: prev.description || meta.description,
      items: [],
    };
  }
  // 保持老文件里出现过、但已不在标准分类表中的分类（避免静默丢数据）
  for (const [key, group] of Object.entries(old.categories || {})) {
    if (!categories[key]) {
      categories[key] = { ...group, items: [] };
      warn(`保留非标准分类 "${key}"（未在 MEME_CATEGORIES 中定义）`);
    }
  }

  for (const p of planned.sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
    const oldItem = oldByBase.get(baseName(p.rel)) || oldByBase.get(baseName(p.file));
    const item = {
      id: p.id,
      name: oldItem?.name || baseName(p.file),
      url: p.target,
      tags: Array.isArray(oldItem?.tags) ? oldItem.tags : [],
    };
    // 机械识别产出的技术元数据（新增字段，对旧消费端向后兼容）
    if (p.width && p.height) { item.width = p.width; item.height = p.height; }
    item.bytes = p.bytes;
    item.format = p.type;
    categories[p.category].items.push(item);
  }
  report.meme.kept = planned.filter((p) => oldByBase.has(baseName(p.rel))).length;
  report.meme.added = planned.length - report.meme.kept;

  // ---- 7. 孤儿条目（索引里有、磁盘上没有）
  const droppedRel = new Set(report.meme.duplicates.flatMap((d) => d.dropped));
  const aliveBase = new Set(planned.map((p) => baseName(p.file)));
  for (const [base, item] of oldByBase) {
    if (aliveBase.has(base)) continue;
    report.meme.removedOrphans++;
    const rel = String(item.url).replace(/^Meme\/images\//, '');
    const why = droppedRel.has(rel) ? '对应文件因内容重复已被删除' : '对应文件在磁盘上不存在';
    warn(`清理孤儿条目: ${item.id}（${item.url}）—— ${why}`);
  }

  const next = {
    name: old.name || 'cy-chat Meme Pack',
    version: '2.0.0',
    description: old.description || '表情包云端数据 - 图片表情 & 贴图',
    updatedAt: new Date().toISOString(),
    generatedBy: 'scripts/sync-index.mjs',
    categories,
  };

  return { planned, next, old };
}

/* ------------------------------------------------------------------ *
 * Word：追加式同步
 * ------------------------------------------------------------------ */

function syncWord() {
  const old = loadJson(WORD_JSON) || { categories: {} };
  const files = walkFiles(WORDS_DIR).filter((f) => /\.txt$/i.test(f)).sort(byPath);
  report.word.files = files.length;

  const categories = {};
  for (const [key, meta] of Object.entries(WORD_CATEGORIES)) {
    const prev = old.categories?.[key] || {};
    categories[key] = {
      label: prev.label || meta.label,
      description: prev.description || meta.description,
      items: [...(prev.items || [])],
    };
  }
  for (const [key, group] of Object.entries(old.categories || {})) {
    if (!categories[key]) categories[key] = group;
  }
  report.word.kept = Object.values(categories).reduce((n, g) => n + g.items.length, 0);

  // 没有字卡源文件时也不用提前返回：走同一条路径，保证 generatedBy 等字段始终一致
  // 现有文本集合（跨全部分类查重）
  const existing = new Map();
  for (const [cat, group] of Object.entries(categories)) {
    for (const it of group.items) {
      if (typeof it?.text === 'string') existing.set(it.text, { cat, item: it });
    }
  }

  const prefixByCat = { customReplies: 'reply', pokes: 'poke', statuses: 'status' };
  const nextNum = {};
  for (const [cat, pre] of Object.entries(prefixByCat)) {
    let max = 0;
    for (const it of categories[cat].items) max = Math.max(max, idNumber(it.id));
    nextNum[cat] = max;
  }

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(WORDS_DIR, rel), 'utf8');
    const key = baseName(rel);
    const category = Object.keys(WORD_CATEGORIES).includes(key) ? key : 'customReplies';
    if (category === 'customReplies' && key !== 'customReplies') {
      warn(`字卡文件 ${rel} 未匹配到分类名，内容全部归入 customReplies（可用 customReplies.txt / pokes.txt / statuses.txt 指定分类）`);
    }

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    for (const text of lines) {
      const hit = existing.get(text);
      if (hit) {
        if (hit.cat !== category) warn(`文本已在分类 ${hit.cat} 中，跳过本次 ${rel} 的重复: ${text.slice(0, 30)}`);
        continue;
      }
      const item = { id: formatId(prefixByCat[category] || 'reply', ++nextNum[category]), text, tags: [] };
      categories[category].items.push(item);
      existing.set(text, { cat: category, item });
      report.word.added++;
    }
  }

  return {
    next: {
      ...old,
      version: old.version || '1.0.0',
      updatedAt: new Date().toISOString(),
      generatedBy: 'scripts/sync-index.mjs',
      categories,
    },
    old,
    files,
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
  const meme = syncMeme();
  const word = syncWord();

  // ---- 落盘
  if (OPT.write) {
    // 先移动 / 删除文件，再写 JSON，避免出现「索引指向不存在的文件」的中间态
    for (const o of report.operations) {
      if (o.kind === 'delete') {
        const abs = path.join(OPT.root, o.from);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      }
    }
    for (const o of report.operations) {
      if (o.kind !== 'move') continue;
      const fromAbs = path.join(OPT.root, o.from);
      const toAbs = path.join(OPT.root, o.to);
      if (!fs.existsSync(fromAbs) || fromAbs === toAbs) continue;
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      if (fs.existsSync(toAbs)) {
        warn(`目标已存在，跳过移动: ${o.to}`);
        continue;
      }
      fs.renameSync(fromAbs, toAbs);
    }
    keepTimestampIfUnchanged(MEME_JSON, meme.next);
    keepTimestampIfUnchanged(WORD_JSON, word.next);
    saveJson(MEME_JSON, meme.next);
    saveJson(WORD_JSON, word.next);
  }

  // ---- 报告
  const L = [];
  const m = report.meme;
  L.push('');
  L.push('══ cy-chat 索引同步报告 ══════════════════════════════════');
  L.push(`模式: ${OPT.write ? '✎ 写入（已改动仓库）' : '👀 试运行（加 --write 才落盘）'}`);
  L.push('');
  const nonImage = m.failed.length;
  const dupDropped = m.duplicates.reduce((n, d) => n + d.dropped.length, 0);
  const excluded = [];
  if (nonImage) excluded.push(`${nonImage} 个非图片`);
  if (dupDropped) excluded.push(`${dupDropped} 个内容重复`);

  L.push('【Meme 表情包】');
  L.push(`  扫描文件        ${m.scanned}`);
  L.push(`  有效图片        ${m.valid}${excluded.length ? `  (已排除 ${excluded.join('、')})` : ''}`);
  L.push(`  新增登记        ${m.added}`);
  L.push(`  沿用原条目      ${m.kept}`);
  L.push(`  分类归位        ${m.moved}`);
  L.push(`  清理孤儿条目    ${m.removedOrphans}`);
  L.push(`  内容重复        ${m.duplicates.length} 组 / ${m.duplicates.reduce((n, d) => n + d.dropped.length, 0)} 个冗余文件`);
  L.push(`  格式兼容告警    ${m.formatWarnings.length}`);
  L.push('');
  L.push('【Word 字卡】');
  L.push(`  扫描 txt        ${report.word.files}`);
  L.push(`  新增条目        ${report.word.added}`);
  L.push(`  现有条目        ${report.word.kept}`);
  L.push('');

  if (report.errors.length) {
    L.push(`【✖ 错误 ${report.errors.length}】`);
    for (const e of report.errors) L.push('  ✖ ' + e);
    L.push('');
  }
  if (report.warnings.length) {
    L.push(`【⚠ 警告 ${report.warnings.length}】`);
    for (const w of report.warnings.slice(0, 40)) L.push('  ⚠ ' + w);
    if (report.warnings.length > 40) L.push(`  … 另有 ${report.warnings.length - 40} 条，见 --json 输出`);
    L.push('');
  }
  if (report.operations.length) {
    const dels = report.operations.filter((o) => o.kind === 'delete');
    const moves = report.operations.filter((o) => o.kind === 'move');
    L.push(`【文件操作 ${report.operations.length}】${OPT.write ? '' : ' （未执行，加 --write 生效）'}`);
    if (dels.length) {
      L.push(`  ── 删除 ${dels.length} 个冗余文件`);
      for (const o of dels) L.push(`     ✖ ${o.from}   ${o.note}`);
    }
    if (moves.length) {
      L.push(`  ── 移动 ${moves.length} 个文件`);
      const SHOW = 12;
      for (const o of moves.slice(0, SHOW)) L.push(`     ↪ ${o.from}  →  ${o.to}`);
      if (moves.length > SHOW) L.push(`     … 另有 ${moves.length - SHOW} 个，完整清单加 --json`);
    }
    L.push('');
  }
  L.push('══════════════════════════════════════════════════════════');
  L.push('');

  const text = L.join('\n');
  if (OPT.jsonFile) fs.writeFileSync(OPT.jsonFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (OPT.out) {
    fs.writeFileSync(OPT.out, text + (OPT.json ? JSON.stringify(report, null, 2) + '\n' : ''), 'utf8');
    process.stdout.write(`报告已写入 ${OPT.out}\n`);
  } else {
    process.stdout.write(text);
    if (OPT.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  // CI 摘要
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n', 'utf8');
  }

  process.exit(report.errors.length ? 1 : 0);
}

main();
