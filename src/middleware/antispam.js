'use strict';

/**
 * 反滥用中间件。
 *
 * 诚实的前提：邮箱不验证，就无法真正防住刻意刷票。
 * 这里的组合目标是「让普通玩家顺手投一次，让恶意刷票变麻烦」：
 *   1. 同邮箱对同建议只能投一票 —— 由 votes 表的唯一约束强制（不在这一层）
 *   2. IP 限频 —— 本文件
 *   3. 封禁名单 —— 本文件
 *   4. 每张票留 IP/UA/时间 —— 供人工识别
 */

const db = require('../db');
const { clientIp } = require('../util');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 记录一次成功行为，用于之后的限频统计 */
function bump(kind, ip, at = Date.now()) {
  db.run('INSERT INTO ip_events (ip, kind, at) VALUES (?, ?, ?)', ip, kind, at);
}

/** 窗口内某 IP 的行为次数 */
function countIp(kind, ip, windowMs) {
  const row = db.get(
    'SELECT COUNT(*) AS c FROM ip_events WHERE ip = ? AND kind = ? AND at > ?',
    ip,
    kind,
    Date.now() - windowMs
  );
  return row ? Number(row.c) : 0;
}

/** 该 IP 在窗口内最早一次行为的时间，用来算 Retry-After */
function oldestInWindow(kind, ip, windowMs) {
  const row = db.get(
    'SELECT MIN(at) AS t FROM ip_events WHERE ip = ? AND kind = ? AND at > ?',
    ip,
    kind,
    Date.now() - windowMs
  );
  return row && row.t ? Number(row.t) : null;
}

/**
 * IP 限频。配置里的 max 是「窗口内允许的次数」。
 * 只在成功执行后由路由 bump，所以失败尝试不消耗额度。
 */
function rateLimit({ kind, max, windowMs = HOUR, message }) {
  return (req, res, next) => {
    const ip = clientIp(req);
    // max 允许传函数，这样阈值可以直接从后台配置里实时读，改了立即生效
    const limit = typeof max === 'function' ? Number(max(req)) : Number(max);
    if (!Number.isFinite(limit) || limit <= 0) return next();

    const used = countIp(kind, ip, windowMs);
    if (used >= limit) {
      const oldest = oldestInWindow(kind, ip, windowMs);
      const retryAfterSec = oldest
        ? Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000))
        : 60;
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: message || `操作太频繁了，请 ${Math.ceil(retryAfterSec / 60)} 分钟后再试`,
        retryAfterSec,
      });
    }
    return next();
  };
}

/* ------------------------- 封禁名单 ------------------------- */

function isIpBanned(ip) {
  return !!db.get("SELECT 1 AS x FROM bans WHERE kind = 'ip' AND value = ?", ip);
}

function isEmailBanned(email) {
  return !!db.get("SELECT 1 AS x FROM bans WHERE kind = 'email' AND value = ?", email);
}

function rejectBannedIp(req, res, next) {
  const ip = clientIp(req);
  if (isIpBanned(ip)) {
    return res.status(403).json({
      ok: false,
      error: '这个网络地址已被禁止操作，如有疑问请联系管理员',
      banned: true,
    });
  }
  return next();
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,
  bump,
  countIp,
  rateLimit,
  isIpBanned,
  isEmailBanned,
  rejectBannedIp,
};
