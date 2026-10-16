'use strict';

/**
 * 文本规范化与相似度。
 *
 * 两个用途：
 *   1. AI 不可用时（本机 Node）它就是全部的判定依据；
 *   2. AI 可用时它用来生成向量指纹、以及给垃圾内容做一道最便宜的预筛。
 *
 * 只用字符 n-gram，不引入中文分词：短标题上字符 2-gram 的效果与分词相当，
 * 而且没有词典依赖，两个运行时（Node / Workers）跑出来的结果完全一致。
 */

/** 全角转半角，表意空格转普通空格 */
function fold(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 比较用的形态：只留字母、数字和汉字，其余（标点、空格、符号）全部去掉 */
function normalize(s) {
  return fold(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 字符 n-gram 集合 */
function ngrams(s, n = 2) {
  const out = new Set();
  const str = String(s || '');
  if (!str) return out;
  if (str.length <= n) {
    out.add(str);
    return out;
  }
  for (let i = 0; i + n <= str.length; i += 1) out.add(str.slice(i, i + n));
  return out;
}

/** Dice 系数，0~1 */
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const g of small) if (big.has(g)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

/** 单段文本的相似度 */
function textScore(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return dice(ngrams(na), ngrams(nb));
}

/** 两条建议的相似度：标题为主，正文只做补充 */
function score(a, b) {
  const title = textScore(a.title, b.title);
  const body = textScore(String(a.body || '').slice(0, 300), String(b.body || '').slice(0, 300));
  return title * 0.75 + body * 0.25;
}

/** 稳定短哈希（FNV-1a 32 位），用来判断向量缓存是否过期 */
function fingerprint(...parts) {
  const s = parts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 明显的广告／引流词。本地规则只认这些，宁可漏也不误伤 */
const AD_WORDS = [
  '加微信',
  '加vx',
  '加v信',
  '微信号',
  'qq群',
  '代练',
  '代充',
  '私聊',
  '刷单',
  '返利',
  '兼职',
  '博彩',
  '赌博',
  '办证',
  '发票',
  '贷款',
  '外挂出售',
  '低价出售',
  'http://',
  'https://',
  'www.',
];

/**
 * 本地垃圾判定：只处理一眼能看出来的。
 * 短内容不算垃圾——那往往是玩家正常的一句话需求。
 */
function localJunk({ title, body }) {
  const text = `${title || ''}\n${body || ''}`;
  const lower = fold(text).toLowerCase();

  const hit = AD_WORDS.find((w) => lower.includes(w));
  if (hit) {
    return { kind: 'ad', confidence: 0.9, reason: `出现引流／广告字样「${hit}」` };
  }
  // 标题和正文加起来一个字母数字汉字都没有（纯符号、纯表情）
  if (normalize(text).length < 2) {
    return { kind: 'junk', confidence: 0.85, reason: '读不出任何文字内容' };
  }
  return { kind: 'ok', confidence: 0.5, reason: '' };
}

module.exports = {
  fold,
  normalize,
  ngrams,
  dice,
  textScore,
  score,
  fingerprint,
  localJunk,
  AD_WORDS,
};
