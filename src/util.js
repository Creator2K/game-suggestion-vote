'use strict';

/**
 * 通用工具：校验、脱敏、密码哈希、响应封装。
 */

const crypto = require('node:crypto');

/* ---------------------------- 时间 ---------------------------- */

const now = () => Date.now();

/* ---------------------------- IP ---------------------------- */

/** 把 ::ffff:127.0.0.1 这类 IPv4-mapped 地址还原成 127.0.0.1 */
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  let v = String(ip);
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1') v = '127.0.0.1';
  return v;
}

/** config.TRUST_PROXY 打开后，Express 已依据 X-Forwarded-For 填好 req.ip */
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
  // 去掉除 \n \t 外的控制字符
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

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(password), useSalt, SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 64 * 1024 * 1024,
    })
    .toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  let actual;
  try {
    actual = hashPassword(password, salt).hash;
  } catch {
    return false;
  }
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

const newToken = () => crypto.randomBytes(32).toString('base64url');
const newId = () => crypto.randomUUID();

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
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
  newToken,
  newId,
  sha256,
  ok,
  fail,
  wrap,
  escapeHtml,
  clampInt,
};
