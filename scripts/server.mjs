#!/usr/bin/env node
/**
 * cy-chat 上传接口
 *
 * 给客户端 App 用的接收层。收到文件后：
 *   识别真实类型 -> 校验分类 -> 落盘 -> 调用同一份 sync 引擎 -> 提交推送
 * 与 GitHub Actions 共用 scripts/sync-index.mjs，两条入口的识别结果完全一致。
 *
 * 启动：
 *   node scripts/server.mjs
 *
 * 环境变量：
 *   PORT            监听端口，默认 8787
 *   REPO_DIR        仓库根目录，默认脚本的上级目录
 *   UPLOAD_TOKEN    可选。设置后所有上传请求需带 X-Upload-Token 头
 *   AUTO_PUSH       默认 true。设为 false 则只本地提交不推送
 *   MAX_UPLOAD_MB   单文件大小上限，默认 10
 *
 * 接口：
 *   GET  /health                     健康检查
 *   POST /upload/meme?name=&category=  上传表情包（body 为文件原始字节）
 *   POST /upload/word?category=        上传字卡（body 为纯文本，每行一条）
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  IMAGE_TYPES, EXT_BY_TYPE, EXT_ALIASES, MEME_CATEGORIES, WORD_CATEGORIES,
  sniffImageType, readImageSize, sha1, safeFileName, baseName,
} from './lib/identify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_DIR = process.env.REPO_DIR || path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.UPLOAD_TOKEN || '';
const AUTO_PUSH = String(process.env.AUTO_PUSH ?? 'true') !== 'false';
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
const SYNC_SCRIPT = path.join(REPO_DIR, 'scripts/sync-index.mjs');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 串行队列。
 * 上传会触发 git 提交，并发跑必然撞车，所以所有写操作排队执行。
 */
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(() => task());
  queue = run.then(() => {}, () => {});
  return run;
}

function run(cmd, args, extra = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extra,
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `文件超过上限 ${(limit / 1024 / 1024).toFixed(1)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 调用同步引擎，返回结构化报告 */
function runSync() {
  const tmp = path.join(os.tmpdir(), `cy-chat-sync-${process.pid}-${Date.now()}.json`);
  try {
    run(process.execPath, [SYNC_SCRIPT, '--write', `--json-file=${tmp}`]);
    return JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

/**
 * 提交并推送。
 *
 * 两个刻意的设计：
 *  1. 身份用 -c 显式传入，不依赖机器上的 git 全局配置 —— 服务器上没配 user.name
 *     是很常见的情况，直接 commit 会以 "Author identity unknown" 失败。
 *  2. 提交失败不抛错，降级成返回值里的提示。此时文件已经落盘、索引也已经更新，
 *     属于「内容已入库、只是没提交」，不该让客户端以为整次上传失败而重试。
 */
function commitAndPush(message) {
  const name = process.env.GIT_BOT_NAME || 'cy-chat-bot';
  const email = process.env.GIT_BOT_EMAIL || 'cy-chat-bot@users.noreply.github.com';

  try {
    if (!run('git', ['status', '--porcelain']).trim()) {
      return { committed: false, reason: '没有变更' };
    }
    run('git', ['add', '-A']);
    run('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message]);
    if (!AUTO_PUSH) return { committed: true, pushed: false, reason: 'AUTO_PUSH=false' };

    try {
      run('git', ['push']);
    } catch {
      run('git', ['pull', '--rebase', '--autostash']);
      run('git', ['push']);
    }
    return { committed: true, pushed: true };
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-2).join(' ').trim();
    console.error('[upload] git 提交失败（内容已落盘，索引已更新）:', detail);
    return { committed: false, error: detail, note: '文件与索引已更新，仅 git 提交未完成' };
  }
}

/** 在目录树中按内容指纹查重，找到就返回其绝对路径 */
function findByHash(dir, hash) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findByHash(abs, hash);
      if (hit) return hit;
    } else if (entry.isFile() && sha1(fs.readFileSync(abs)) === hash) {
      return abs;
    }
  }
  return null;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * 上传处理
 * ------------------------------------------------------------------ */

/** 表情包：body 是文件原始字节 */
async function handleMeme(req, res, url) {
  const buf = await readBody(req, MAX_BYTES);
  if (!buf.length) throw new HttpError(400, '请求体为空');

  const type = sniffImageType(buf);
  if (!IMAGE_TYPES.includes(type)) {
    throw new HttpError(400, `不是有效图片：文件头识别为 ${type}。支持 ${IMAGE_TYPES.join(' / ')}`);
  }

  const category = url.searchParams.get('category') || 'reactions';
  if (!MEME_CATEGORIES[category]) {
    throw new HttpError(400, `未知分类 "${category}"，可用：${Object.keys(MEME_CATEGORIES).join(' / ')}`);
  }

  // 文件名：按真实类型对齐扩展名
  let name = safeFileName(url.searchParams.get('name') || `upload_${Date.now()}`);
  if (!(EXT_ALIASES[type] || []).includes(path.extname(name).toLowerCase())) {
    name = baseName(name) + EXT_BY_TYPE[type];
  }

  const dir = path.join(REPO_DIR, 'Meme/images', category);
  fs.mkdirSync(dir, { recursive: true });

  // 内容相同的图直接判重、不落盘（跨全部分类比对，避免同一张图换个分类重复上传）
  const hash = sha1(buf);
  const dup = findByHash(path.join(REPO_DIR, 'Meme/images'), hash);
  if (dup) {
    return send(res, 200, {
      ok: true,
      duplicate: true,
      message: '该图片已存在（内容相同），未重复添加',
      file: path.relative(REPO_DIR, dup).split(path.sep).join('/'),
    });
  }

  // 同名不同图时加序号
  let target = path.join(dir, name);
  let seq = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${baseName(name)}-${seq}${path.extname(name)}`);
    seq++;
  }
  fs.writeFileSync(target, buf);

  const rel = path.relative(REPO_DIR, target).split(path.sep).join('/');
  const size = readImageSize(buf, type);
  const sync = runSync();
  const commit = commitAndPush(`feat(meme): 上传 ${path.basename(target)} [skip-sync]`);

  return send(res, 200, {
    ok: true,
    duplicate: false,
    file: rel,
    type,
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: buf.length,
    sync: { added: sync.meme.added, total: sync.meme.valid, warnings: sync.warnings },
    commit,
  });
}

/** 字卡：body 是纯文本，每行一条 */
async function handleWord(req, res, url) {
  const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new HttpError(400, '没有可用的文本行（空行和 # 开头的注释会被忽略）');

  const category = url.searchParams.get('category') || 'customReplies';
  if (!WORD_CATEGORIES[category]) {
    throw new HttpError(400, `未知分类 "${category}"，可用：${Object.keys(WORD_CATEGORIES).join(' / ')}`);
  }

  const dir = path.join(REPO_DIR, 'Word/words');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${category}.txt`);

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // 既跟文件里已有的比，也在本批次内部去重，避免同一批里重复行被写进源文件
  const seen = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const fresh = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    fresh.push(line);
  }

  if (fresh.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, prefix + fresh.join('\n') + '\n', 'utf8');
  }

  const sync = runSync();
  const commit = fresh.length
    ? commitAndPush(`feat(word): 上传 ${fresh.length} 条字卡 [skip-sync]`)
    : { committed: false, reason: '内容已存在，无需提交' };

  return send(res, 200, {
    ok: true,
    category,
    received: lines.length,
    added: fresh.length,
    skipped: lines.length - fresh.length,
    sync: { added: sync.word.added, kept: sync.word.kept },
    commit,
  });
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        repo: REPO_DIR,
        autoPush: AUTO_PUSH,
        authRequired: Boolean(TOKEN),
        categories: { meme: Object.keys(MEME_CATEGORIES), word: Object.keys(WORD_CATEGORIES) },
        maxUploadMB: MAX_BYTES / 1024 / 1024,
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, {
        name: 'cy-chat upload API',
        endpoints: {
          'GET /health': '健康检查',
          'POST /upload/meme?name=x.jpg&category=reactions': '上传表情包，body 为文件原始字节',
          'POST /upload/word?category=customReplies': '上传字卡，body 为纯文本、每行一条',
        },
      });
    }

    if (TOKEN && req.headers['x-upload-token'] !== TOKEN) {
      return send(res, 401, { ok: false, error: '缺少或错误的 X-Upload-Token' });
    }

    if (req.method === 'POST' && url.pathname === '/upload/meme') {
      return await enqueue(() => handleMeme(req, res, url));
    }
    if (req.method === 'POST' && url.pathname === '/upload/word') {
      return await enqueue(() => handleWord(req, res, url));
    }

    return send(res, 404, { ok: false, error: `未知接口 ${req.method} ${url.pathname}` });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[upload] 内部错误:', err);
    if (!res.headersSent) send(res, status, { ok: false, error: err.message });
    return undefined;
  }
});

if (!fs.existsSync(SYNC_SCRIPT)) {
  console.error(`✖ 找不到同步脚本: ${SYNC_SCRIPT}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`cy-chat 上传接口已启动`);
  console.log(`  监听      http://127.0.0.1:${PORT}`);
  console.log(`  仓库      ${REPO_DIR}`);
  console.log(`  自动推送  ${AUTO_PUSH ? '开' : '关'}`);
  console.log(`  鉴权      ${TOKEN ? '开（X-Upload-Token）' : '关'}`);
});
