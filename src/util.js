'use strict';

/**
 * 通用工具：校验、脱敏、密码哈希、响应封装。
 *
 * 密码用 PBKDF2-SHA256，走全局 WebCrypto——Node 22+ 与 Cloudflare Workers
 * 都有这个 API，所以这一层不需要按宿主分叉。迭代次数写进哈希串里，
 * 以后调参不会让老密码失效。
 *
 * 历史：早期版本用 node:crypto 的 scrypt。换成 PBKDF2 是因为 scrypt 在
 * Workers 免费计划上会超出单次调用的 CPU 上限。老的 scrypt 哈希认不出来，
 * 会直接判失败，需要重新设置管理员密码。
 */

/* ---------------------------- 时间 ---------------------------- */

const now = () => Date.now();

/* ---------------------------- 编码 ---------------------------- */

const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex);
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function randomHex(n) {
  return bytesToHex(randomBytes(n));
}

/** 定长比较，避免用 === 泄漏时间差 */
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------------------- IP ---------------------------- */

/** 把 ::ffff:127.0.0.1 这类 IPv4-mapped 地址还原成 127.0.0.1 */
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  let v = String(ip);
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1') v = '127.0.0.1';
  return v;
}

/** 两个宿主都会把来源地址填进 req.ip：Node 由 Express 填，Workers 由兼容层填 */
function clientIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function userAgent(req) {
  const ua = req.get ? req.get('user-agent') : null;
  return ua ? String(ua).slice(0, 300) : null;
}

/* ---------------------------- 校验 ---------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// 昵称：中文、字母、数字、下划线、连字符，2~16 个字符
const NICKNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/;

function normalizeEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function normalizeNickname(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}

/**
 * 清洗正文：去掉控制字符（保留换行），压缩连续空行，限制长度。
 * 注意：这里不做 HTML 转义——存储保留原文，输出时由前端转义。
 */
function cleanText(v, maxLen) {
  let s = String(v == null ? '' : v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/\n{4,}/g, '\n\n\n');
  s = s.replace(/[ \t]{3,}/g, '  ');
  s = s.trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function validateEmail(email) {
  if (!email) return '请填写邮箱';
  if (email.length > 254) return '邮箱过长';
  if (!EMAIL_RE.test(email)) return '邮箱格式不正确';
  return null;
}

function validateNickname(nickname) {
  if (!nickname) return '请填写昵称';
  if (!NICKNAME_RE.test(nickname)) {
    return '昵称只能包含中文、字母、数字、下划线和连字符，长度 2~16';
  }
  return null;
}

/* ---------------------------- 密码 ---------------------------- */

const KDF_LABEL = 'pbkdf2-sha256';
const KDF_KEY_BITS = 256;
const DEFAULT_ITERATIONS = 100000;

let iterations = DEFAULT_ITERATIONS;

/**
 * 调整 PBKDF2 迭代次数。Workers 免费计划每次调用只有 10ms CPU，
 * 所以部署时会调低；次数写在哈希串里，不影响已存在的密码。
 */
function setKdfIterations(n) {
  const v = Math.floor(Number(n));
  if (Number.isFinite(v) && v >= 1000 && v <= 10000000) iterations = v;
  return iterations;
}

async function derive(password, saltHex, iters) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iters, hash: 'SHA-256' },
    key,
    KDF_KEY_BITS
  );
  return bytesToHex(new Uint8Array(bits));
}

/** @returns {Promise<{salt: string, hash: string}>} */
async function hashPassword(password, salt) {
  const useSalt = salt || randomHex(16);
  const hex = await derive(password, useSalt, iterations);
  return { salt: useSalt, hash: `${KDF_LABEL}$${iterations}$${hex}` };
}

/**
 * 判断哈希串是哪种格式。
 * 老版本（scrypt）是 128 位十六进制，没有前缀；换成 PBKDF2 后认不出来，
 * 后台靠这个给出「请重置密码」的明确提示，而不是含糊的「密码不正确」。
 */
function hashFormat(hash) {
  const s = String(hash || '');
  if (!s) return 'none';
  if (s.startsWith(`${KDF_LABEL}$`)) return 'pbkdf2';
  if (/^[0-9a-f]{128}$/i.test(s)) return 'scrypt';
  return 'unknown';
}

async function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const m = new RegExp(`^${KDF_LABEL}\\$(\\d+)\\$([0-9a-f]{64})$`, 'i').exec(String(expectedHash));
  if (!m) return false;
  const iters = Number(m[1]);
  if (!Number.isFinite(iters) || iters < 1 || iters > 10000000) return false;

  let actual;
  try {
    actual = await derive(password, salt, iters);
  } catch {
    return false;
  }
  return timingSafeEqualHex(actual, m[2].toLowerCase());
}

/** 密码强度下限：至少 8 位，且不能全是同一种字符 */
function validateAdminPassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '管理员密码至少 8 位';
  if (s.length > 200) return '管理员密码过长';
  if (/^(.)\1+$/.test(s)) return '管理员密码不能是重复的同一个字符';
  return null;
}

/* ---------------------------- 令牌 ---------------------------- */

function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const newToken = () => toBase64Url(randomBytes(32));
const newId = () => crypto.randomUUID();

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(text)));
  return bytesToHex(new Uint8Array(digest));
}

/* ---------------------------- 响应 ---------------------------- */

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function fail(res, error, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

/** 包裹 async 路由，异常统一交给错误中间件 */
const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/* ---------------------------- 其他 ---------------------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  now,
  normalizeIp,
  clientIp,
  userAgent,
  normalizeEmail,
  normalizeNickname,
  cleanText,
  validateEmail,
  validateNickname,
  validateAdminPassword,
  hashPassword,
  verifyPassword,
  hashFormat,
  setKdfIterations,
  KDF_LABEL,
  newToken,
  newId,
  sha256,
  ok,
  fail,
  wrap,
  escapeHtml,
  clampInt,
  bytesToHex,
  hexToBytes,
};
