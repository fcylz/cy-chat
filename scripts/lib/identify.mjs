/**
 * cy-chat 机械识别核心库
 *
 * 只用 Node 内置模块，零第三方依赖。
 * 被 scripts/sync-index.mjs（CI / 本地）和 scripts/server.mjs（上传接口）共用，
 * 保证两条入口的识别结果完全一致。
 *
 * 识别范围（确定性，不联网、不调模型）：
 *   1. 真实文件类型（读文件头，不信任扩展名）
 *   2. 图片宽高
 *   3. 内容指纹（SHA1）—— 用于去重
 *   4. 分类归属（按子目录）
 *   5. ID 分配（稳定续号）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 支持的图片真实类型（由文件头判定，非扩展名） */
export const IMAGE_TYPES = ['jpeg', 'png', 'gif', 'webp', 'bmp', 'heif', 'avif', 'svg'];

/** 真实类型 -> 规范扩展名 */
export const EXT_BY_TYPE = {
  jpeg: '.jpg',
  png: '.png',
  gif: '.gif',
  webp: '.webp',
  bmp: '.bmp',
  heif: '.heif',
  avif: '.avif',
  svg: '.svg',
};

/** 浏览器 / 常见客户端可直接渲染的类型。不在表内的会被标记为“兼容性告警”。 */
export const WEB_SAFE_TYPES = ['jpeg', 'png', 'gif', 'webp', 'avif', 'svg'];

/**
 * 每种真实类型可接受的扩展名别名。
 * 命中别名就保留原文件名、不告警（例如 .jpeg 和 .jpg 都是 JPEG，没必要改名）；
 * 只有真正对不上时才规范化，并给出告警（例如把 JPEG 存成 .heif）。
 */
export const EXT_ALIASES = {
  jpeg: ['.jpg', '.jpeg', '.jpe'],
  png: ['.png'],
  gif: ['.gif'],
  webp: ['.webp'],
  bmp: ['.bmp'],
  heif: ['.heif', '.heic'],
  avif: ['.avif'],
  svg: ['.svg'],
};

/** 扩展名是否与真实类型相容（相容则无需改名） */
export function isExtensionAcceptable(ext, type) {
  return (EXT_ALIASES[type] || []).includes(String(ext).toLowerCase());
}

/** 表情包分类：目录名即分类键，与 Meme/images/<key>/ 一一对应 */
export const MEME_CATEGORIES = {
  reactions: { label: '反应表情', description: '日常反应类表情包' },
  emotions: { label: '情绪表情', description: '情绪表达类表情包' },
  interactions: { label: '互动表情', description: '互动 / 夸奖 / 撒娇类表情包' },
  stickers: { label: '贴图', description: '无文字装饰性贴图' },
};

/**
 * 字卡分类：文件名即分类键，与 Word/words/<key>.txt 一一对应。
 *
 * 分两段：
 *   · 通用字卡（daily … emoji）—— 聊天里随口一句，进任何站的通用回复池。
 *   · 功能字卡（fish … music）—— 对齐 mochi-x 的「其它互动功能字卡」池
 *     （mochi 源码 CC_FUNC_KEYS），只在各自功能页被抽到，不进聊天通用回复。
 *
 * 功能分类的 label **必须与 mochi 的 CC_LABEL 逐字一致**：mochi 站点
 * （chatcard.js 的 CLOUD_TYPE_BY_LABEL）和油猴脚本（wordMap）都是按 label
 * 反查字卡分类的，改一个字就会落回主字卡、变成普通文本组。
 *
 * 少列一个 mjfree（梦角自由造句）——那是 dream-free.js 程序生成的重造句卡，
 * 没有云端文本来源，导进去只会变成一堆上下文无关的句子。
 */
export const WORD_CATEGORIES = {
  daily: { label: '日常', description: '生活应答、状态描述、随口一句话' },
  connect: { label: '连接', description: '通讯与在线状态：延迟、顶号、找字卡、被限制' },
  address: { label: '称呼', description: '对人的叫法与昵称' },
  quotes: { label: '官方语录', description: '角色设定台词（方承意 / 明昭侯府体）' },
  sweet: { label: '情话', description: '表白、告白、亲昵话' },
  kaomoji: { label: '颜文字', description: '纯字符拼的表情与装饰符号' },
  emoji: { label: 'emoji', description: '含系统 emoji 的字卡' },
  // 拍一拍：不是「一句回复」，而是「TA 拍了拍你 ___」的填空。
  // 客户端抽中后直接拼在拍一拍前缀后面，所以只能放短句（别放整段、别放 emoji 序列）。
  // mochi 里它是 cc-groups.poke 这个载体分类（与 text 平级），不是功能池。
  poke: { label: '拍一拍', description: '拍一拍的填空短语：抽中后拼成「TA 拍了拍你 …」' },

  // ---- 功能分类（对齐 mochi-x CC_FUNC_KEYS，顺序同 mochi 的 CC_LABEL）----
  fish: { label: '摸鱼', description: '摸鱼浮字与抓包回应：TA 在偷懒 / 抓到摸鱼' },
  eat: { label: '吃饭', description: '饭点提醒、追着问吃没吃、夜宵' },
  period: { label: '经期', description: '经期关心、经前预警、推迟' },
  water: { label: '喝水', description: '喝水提醒与喝够夸奖' },
  garden: { label: '花园', description: '花园悄悄话：浇花、花在长' },
  sync: { label: '同频', description: '同频：TA 此刻在做什么 / 没接住的回应' },
  reach: { label: '伸手', description: '伸手：被抓住的回应与触感描述' },
  cjian: { label: '此间', description: '此间：在场感知、气息与落空' },
  room: { label: '房间', description: '房间：进门、靠近、家具互动、方位感知' },
  piggy: { label: '存钱罐', description: '存钱罐：存入 / 取款 / 塞硬币的碎碎念' },
  drift: { label: '漂流瓶', description: '漂流瓶：TA 的话、TA 的回应、海风' },
  interact: { label: '互动回应', description: '互动按钮的回应：邀请、提问、贴贴、游戏输赢' },
  music: { label: '音乐', description: '一起听歌：暂停 / 恢复播放时的话' },
};

/* ------------------------------------------------------------------ *
 * 动态分类（目录名即分类，不写死白名单）
 * ------------------------------------------------------------------ */

/**
 * 上面两张表只是「已知分类」，用来提供中文标签和固定 ID 前缀。
 * 真正合法的分类是**磁盘上实际存在的文件夹名**——用户新建一个目录就是新建一个分类，
 * 不需要改任何代码。所以分类校验只做「能不能安全当目录名」这一件事。
 */

/** 每个分类键对应一个显示标签：已知分类用中文标签，动态分类直接用目录名 */
export function categoryLabel(key) {
  return MEME_CATEGORIES[key]?.label || WORD_CATEGORIES[key]?.label || key;
}

/** 分类描述：已知分类用预设文案，动态分类标明来源 */
export const categoryDescription = (key, source = 'meme') => {
  const known = (source === 'word' ? WORD_CATEGORIES : MEME_CATEGORIES)[key];
  return known?.description || `自动发现的分类（${source === 'word' ? '文件名' : '目录名'}即分类）`;
};

/**
 * 分类键安全校验：它最终会变成一层目录名，必须挡掉路径穿越和非法字符。
 * 允许中文等多字节字符（目录名就是给用户看的），只禁真正危险的东西。
 * @returns {string|null} 规范化后的分类键，不合法则 null
 */
export function sanitizeCategory(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.length > 40) return null;
  // 控制字符 / Windows 保留字符 / 路径分隔符 一律拒绝；前后点也拒绝（挡掉 . .. .git）
  if (/[\u0000-\u001f\\/:*?"<>|]/.test(s)) return null;
  if (s.startsWith('.')) return null;
  if (s === '..' || s === '.') return null;
  return s;
}

/** 把若干候选分类键合并成有序列表：已知分类按声明顺序在前，动态分类按字典序在后 */
export function mergeCategoryKeys(known, candidates) {
  const knownKeys = Object.keys(known);
  const seen = new Set(knownKeys);
  const extra = [];
  for (const raw of candidates) {
    const key = sanitizeCategory(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    extra.push(key);
  }
  extra.sort((a, b) => a.localeCompare(b, 'en'));
  return [...knownKeys, ...extra];
}

/**
 * 字卡 ID 前缀：所有分类统一用 reply，不按分类区分。
 *
 * 理由：分组前的 1521 条历史条目 ID 是 reply_0001～reply_1521，分组只是改了归属，
 * ID 必须保持原样。若新增条目改用分类名当前缀（daily_1522 / sweet_1523），
 * ID 体系会碎成七套，且各分类的编号会互相重复（daily_1286 与 reply_1286 是两条
 * 不同的字卡，客户端只取数字部分就会撞车）。统一 reply 后编号全局连续递增，
 * 客户端认一种前缀就够。
 *
 * 动态分类（新建 greetings.txt）同样走 reply，不再按分类名推导前缀。
 */
export const WORD_ID_PREFIX = Object.fromEntries(
  Object.keys(WORD_CATEGORIES).map((key) => [key, 'reply'])
);

/** 为每个字卡分类分配 ID 前缀：一律 reply，保持全局唯一且历史连续。 */
export function wordIdPrefixes(keys) {
  const out = {};
  for (const k of keys) out[k] = 'reply';
  return out;
}

/** 扫描时需要跳过的系统垃圾文件 */
const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.gitkeep', '.gitattributes']);

/* ------------------------------------------------------------------ *
 * 1. 真实类型嗅探
 * ------------------------------------------------------------------ */

const latin = (buf, start, end) => buf.subarray(start, end).toString('latin1');

/**
 * 读取文件头判定真实图片类型。
 * 故意不信任扩展名——把 .exe 改名成 .jpg 会被这里挡下来。
 * @returns {string} IMAGE_TYPES 中的一项，或 'unknown' / 'ftyp:<brand>'
 */
export function sniffImageType(buf) {
  if (buf.length < 4) return 'unknown';

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';

  // GIF: "GIF87a" / "GIF89a"
  if (buf.length >= 6 && /^GIF8[79]a$/.test(latin(buf, 0, 6))) return 'gif';

  // WEBP: "RIFF" .... "WEBP"
  if (buf.length >= 12 && latin(buf, 0, 4) === 'RIFF' && latin(buf, 8, 12) === 'WEBP') return 'webp';

  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';

  // ISOBMFF 家族（HEIF / AVIF）: size(4) + "ftyp" + brand(4)
  if (buf.length >= 12 && latin(buf, 4, 8) === 'ftyp') {
    const brand = latin(buf, 8, 12).trim();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) {
      return 'heif';
    }
    return `ftyp:${brand}`;
  }

  // SVG / 文本型
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg')) return 'svg';
  if (head.startsWith('<?xml') && head.includes('<svg')) return 'svg';

  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * 2. 图片尺寸解析
 * ------------------------------------------------------------------ */

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // 无 payload 的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  const fourcc = latin(buf, 12, 16);
  if (fourcc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/** HEIF / AVIF：在 box 树里找 ispe（Image Spatial Extents），拿到宽高 */
function ispeSize(buf) {
  const idx = buf.indexOf(Buffer.from('ispe', 'latin1'));
  if (idx < 0 || idx + 16 > buf.length) return null;
  // 'ispe' 之后：version+flags(4) + width(4) + height(4)
  return { width: buf.readUInt32BE(idx + 8), height: buf.readUInt32BE(idx + 12) };
}

function svgSize(buf) {
  const head = buf.subarray(0, 2048).toString('utf8');
  const w = /\bwidth\s*=\s*["']?\s*([\d.]+)/i.exec(head);
  const h = /\bheight\s*=\s*["']?\s*([\d.]+)/i.exec(head);
  if (w && h) return { width: Math.round(+w[1]), height: Math.round(+h[1]) };
  const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(head);
  if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
  return null;
}

/**
 * 解析图片真实宽高。解析不出来返回 null（不抛错）。
 * @returns {{width:number,height:number}|null}
 */
export function readImageSize(buf, type) {
  try {
    switch (type) {
      case 'jpeg': return jpegSize(buf);
      case 'png': return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case 'gif': return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
      case 'bmp': return buf.length >= 26 ? { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) } : null;
      case 'webp': return webpSize(buf);
      case 'heif':
      case 'avif': return ispeSize(buf);
      case 'svg': return svgSize(buf);
      default: return null;
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 3. 工具函数
 * ------------------------------------------------------------------ */

export function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 递归列出目录下所有文件，返回 posix 相对路径 */
export function walkFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name.toLowerCase())) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** 从相对路径推断分类：'reactions/a.jpg' -> 'reactions'；根目录返回 null */
export function categoryFromPath(relPath, validCategories) {
  const seg = relPath.split('/');
  if (seg.length < 2) return null;
  const cat = seg[0];
  return validCategories.includes(cat) ? cat : null;
}

/** 去掉扩展名 */
export const baseName = (p) => path.basename(p, path.extname(p));

/** 把任意字符串安全化为文件名 */
export function safeFileName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'unnamed';
}

/** 数字后缀续号：'meme_0007' -> 7 */
export function idNumber(id) {
  const m = /(\d+)\s*$/.exec(String(id ?? ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** 按前缀把数字格式化成 id：('meme', 7) -> 'meme_0007'（位数自适应，至少 4 位） */
export function formatId(prefix, n) {
  return `${prefix}_${String(n).padStart(4, '0')}`;
}

/** 人类可读的文件大小 */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
