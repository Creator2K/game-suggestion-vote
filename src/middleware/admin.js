'use strict';

/**
 * 后台会话与 CSRF。
 *
 * 会话：随机 token 存 admin_sessions 表，通过 httpOnly Cookie 下发。
 * CSRF：Cookie 已设 SameSite=Strict；再加一道「自定义头必须等于会话 token」。
 *       跨站表单无法设置自定义请求头，所以这一道很稳。
 */

const db = require('../db');

const COOKIE_NAME = 'pv_admin';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function getToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

/** 解析会话，挂到 req.admin / req.adminToken，不拦截 */
function attachAdmin(req, res, next) {
  req.admin = null;
  req.adminToken = null;

  const token = getToken(req);
  if (token) {
    const row = db.get(
      'SELECT token, created_at, expires_at FROM admin_sessions WHERE token = ?',
      token
    );
    if (row && Number(row.expires_at) > Date.now()) {
      req.admin = {
        token: row.token,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
      };
      req.adminToken = row.token;
    } else if (row) {
      // 顺手清掉过期会话
      db.run('DELETE FROM admin_sessions WHERE token = ?', token);
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({ ok: false, error: '请先登录后台', needLogin: true });
  }
  return next();
}

function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const sent = req.get('x-csrf-token');
  if (!sent || sent !== req.adminToken) {
    return res.status(403).json({ ok: false, error: '请求校验失败，请刷新页面后重试' });
  }
  return next();
}

function setCookie(res, token, maxAgeSec, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  attachAdmin,
  requireAdmin,
  requireCsrf,
  setCookie,
  clearCookie,
};
