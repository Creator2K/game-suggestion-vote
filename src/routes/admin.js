'use strict';

/**
 * 后台 API。
 *
 * 认证：单一管理员密码（PBKDF2 加盐哈希存 settings 表）。
 * 所有写操作都要过 requireAdmin + requireCsrf（见 middleware/admin.js）。
 * 所有变更都会写 audit_log，方便回溯。
 */

const db = require('../db');
const runtime = require('../runtime');
const u = require('../util');
const adminAuth = require('../middleware/admin');
const { requireAdmin, requireCsrf } = adminAuth;

/**
 * 把后台 API 挂到传入的 router 上。
 * 与玩家端同理：Node 传 Express Router，Workers 传 worker/mini-router.js。
 */
module.exports = function mountAdminApi(router) {

const { DAY, HOUR } = { DAY: 86400000, HOUR: 3600000 };

/* ------------------------------------------------------------------ *
 * 登录失败限速（内存计数即可，重启清零无所谓）
 * ------------------------------------------------------------------ */

const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX = 8;
const loginAttempts = new Map();

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return 0;
  if (rec.resetAt < Date.now()) {
    loginAttempts.delete(ip);
    return 0;
  }
  return rec.count >= LOGIN_MAX ? Math.ceil((rec.resetAt - Date.now()) / 1000) : 0;
}

function loginFailed(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW });
  } else {
    rec.count += 1;
  }
}

function loginSucceeded(ip) {
  loginAttempts.delete(ip);
}

/** 后台会话 Cookie 是否要用 Secure（走 HTTPS 时才加，否则本地 http 登录会失败） */
function wantSecureCookie(req) {
  if (req.get('x-forwarded-proto') === 'https') return true;
  return req.secure === true;
}

/* ------------------------------------------------------------------ *
 * 设置白名单
 * ------------------------------------------------------------------ */

const SETTING_KEYS = [
  'game_name',
  'site_title',
  'tagline',
  'hero_sub',
  'announcement',
  'footer_text',
  'categories',
  'screenshots',
  'submit_open',
  'vote_open',
  'rate_vote_per_hour',
  'rate_submit_per_day',
  'rate_submit_per_day_ip',
  'rate_newplayer_per_day_ip',
  'max_title_len',
  'max_body_len',
  'vote_rank_mode',
];

/** 逐项校验后台提交的设置；返回 [清洗后的键值对, 错误信息] */
function sanitizeSettings(input) {
  const out = {};
  const errors = [];

  const str = (v, max) => u.cleanText(v, max);

  for (const key of Object.keys(input || {})) {
    if (!SETTING_KEYS.includes(key)) continue;
    const raw = input[key];

    switch (key) {
      case 'game_name':
      case 'site_title':
      case 'tagline':
      case 'hero_sub':
      case 'footer_text': {
        const v = str(raw, 80);
        if (!v) errors.push(`${key} 不能为空`);
        else out[key] = v;
        break;
      }
      case 'announcement':
        out[key] = str(raw, 300);
        break;

      case 'categories': {
        let list = raw;
        if (typeof list === 'string') {
          try {
            list = JSON.parse(list);
          } catch {
            errors.push('分类格式不正确');
            break;
          }
        }
        if (!Array.isArray(list)) {
          errors.push('分类必须是一个列表');
          break;
        }
        const cleaned = [
          ...new Set(
            list
              .map((x) => u.cleanText(x, 12))
              .filter((x) => x.length > 0)
          ),
        ].slice(0, 12);
        if (cleaned.length === 0) errors.push('至少保留一个分类');
        else out[key] = JSON.stringify(cleaned);
        break;
      }

      case 'screenshots': {
        let list = raw;
        if (typeof list === 'string') {
          try {
            list = JSON.parse(list);
          } catch {
            errors.push('截图列表格式不正确');
            break;
          }
        }
        if (!Array.isArray(list)) {
          errors.push('截图必须是一个列表');
          break;
        }
        const cleaned = list
          .filter((s) => s && typeof s === 'object' && typeof s.url === 'string')
          .slice(0, 8)
          .map((s) => ({
            id: String(s.id || u.newId()),
            url: String(s.url).slice(0, 300),
            caption: u.cleanText(s.caption, 40),
          }));
        out[key] = JSON.stringify(cleaned);
        break;
      }

      case 'submit_open':
      case 'vote_open':
        out[key] = raw === true || raw === '1' || raw === 1 || raw === 'true' ? '1' : '0';
        break;

      case 'rate_vote_per_hour':
        out[key] = String(u.clampInt(raw, 1, 1000, 30));
        break;
      case 'rate_submit_per_day':
        out[key] = String(u.clampInt(raw, 1, 200, 5));
        break;
      case 'rate_submit_per_day_ip':
        out[key] = String(u.clampInt(raw, 1, 500, 20));
        break;
      case 'rate_newplayer_per_day_ip':
        out[key] = String(u.clampInt(raw, 1, 500, 10));
        break;

      case 'max_title_len':
        out[key] = String(u.clampInt(raw, 10, 120, 60));
        break;
      case 'max_body_len':
        out[key] = String(u.clampInt(raw, 50, 5000, 500));
        break;

      case 'vote_rank_mode':
        out[key] = raw === 'newest' ? 'newest' : 'votes';
        break;

      default:
        break;
    }
  }

  return { values: out, errors };
}

/* ------------------------------------------------------------------ *
 * 建议状态流转
 * ------------------------------------------------------------------ */

const STATUSES = ['pending', 'approved', 'rejected', 'done'];

function loadSuggestion(id) {
  const sid = u.clampInt(id, 1, Number.MAX_SAFE_INTEGER, 0);
  if (!sid) return null;
  return db.get(
    `SELECT s.*, p.nickname AS author_nickname, p.email AS author_email
     FROM suggestions s JOIN players p ON p.id = s.author_id
     WHERE s.id = ?`,
    sid
  );
}

function adminMapSuggestion(row) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    category: row.category,
    status: row.status,
    voteCount: Number(row.vote_count),
    author: row.author_nickname,
    authorEmail: row.author_email,
    authorId: Number(row.author_id),
    rejectReason: row.reject_reason,
    adminNote: row.admin_note,
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : null,
    doneAt: row.done_at ? Number(row.done_at) : null,
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
  };
}

/* ------------------------------------------------------------------ *
 * 票数维护
 * ------------------------------------------------------------------ */

/** 按条件批量删票，并重算受影响建议的票数缓存 */
function purgeVotes(whereSql, params) {
  const affected = db.all(
    `SELECT DISTINCT suggestion_id FROM votes WHERE ${whereSql}`,
    ...params
  );
  const del = db.run(`DELETE FROM votes WHERE ${whereSql}`, ...params);
  for (const row of affected) db.recountSuggestion(Number(row.suggestion_id));
  return { removed: Number(del.changes), affected: affected.length };
}

/* ================================================================== *
 * 公开部分：初始化状态 / 首次设置密码 / 登录
 * ================================================================== */

router.get('/state', (req, res) => {
  const initialized = !!db.getSetting('admin_password_hash', '');
  u.ok(res, { initialized, loggedIn: !!req.admin });
});

router.post(
  '/setup',
  u.wrap(async (req, res) => {
    // 只允许在尚未初始化时调用一次
    if (db.getSetting('admin_password_hash', '')) {
      return u.fail(res, '管理员密码已经设置过了，请直接登录', 409);
    }

    const password = String((req.body || {}).password || '');
    const err = u.validateAdminPassword(password);
    if (err) return u.fail(res, err, 400);

    const { salt, hash } = await u.hashPassword(password);
    db.setSetting('admin_password_salt', salt);
    db.setSetting('admin_password_hash', hash);
    db.logAudit({
      action: 'admin.init',
      detail: '设置管理员密码',
      ip: u.clientIp(req),
    });

    // 设置完直接登录，省一步
    const token = u.newToken();
    const expiresAt = Date.now() + runtime.sessionDays * DAY;
    db.run(
      'INSERT INTO admin_sessions (token, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      token,
      Date.now(),
      expiresAt,
      u.clientIp(req),
      u.userAgent(req)
    );
    adminAuth.setCookie(res, token, runtime.sessionDays * 86400, wantSecureCookie(req));

    u.ok(res, { token, expiresAt, initialized: true });
  })
);

router.post(
  '/login',
  u.wrap(async (req, res) => {
    const ip = u.clientIp(req);
    const waitSec = loginBlocked(ip);
    if (waitSec > 0) {
      res.set('Retry-After', String(waitSec));
      return u.fail(res, `密码错误次数太多，请 ${Math.ceil(waitSec / 60)} 分钟后再试`, 429);
    }

    const storedHash = db.getSetting('admin_password_hash', '');
    if (!storedHash) {
      return u.fail(res, '后台还没初始化，请先设置管理员密码', 409, { needSetup: true });
    }

    // 旧版本用 scrypt 存密码，换算法后认不出来。这里给明确指引，
    // 否则用户只会看到「密码不正确」，怎么试都没用。
    if (u.hashFormat(storedHash) !== 'pbkdf2') {
      return u.fail(
        res,
        '管理员密码的存储格式已升级，请执行 npm run reset-password 重设密码',
        409,
        { needReset: true }
      );
    }

    const password = String((req.body || {}).password || '');
    const salt = db.getSetting('admin_password_salt', '');

    if (!(await u.verifyPassword(password, salt, storedHash))) {
      loginFailed(ip);
      db.logAudit({ action: 'admin.login_failed', ip, detail: null });
      return u.fail(res, '密码不正确', 401);
    }

    loginSucceeded(ip);

    // 每次登录清掉旧会话，单人后台没必要留多份
    db.run('DELETE FROM admin_sessions');
    const token = u.newToken();
    const expiresAt = Date.now() + runtime.sessionDays * DAY;
    db.run(
      'INSERT INTO admin_sessions (token, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      token,
      Date.now(),
      expiresAt,
      ip,
      u.userAgent(req)
    );
    adminAuth.setCookie(res, token, runtime.sessionDays * 86400, wantSecureCookie(req));
    db.logAudit({ action: 'admin.login', ip });

    u.ok(res, { token, expiresAt });
  })
);

/* ================================================================== *
 * 忘记密码时的自救入口（在 requireAdmin 之前，所以不需要登录）
 * ================================================================== */

/** 定长比较，别用 === 泄漏时间差 */
function tokenEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 凭重置令牌改管理员密码。
 * 令牌没配置时这里直接当作不存在——避免出现一个默认就能用的后门。
 *   Workers: wrangler secret put RESET_TOKEN
 *   Node:    RESET_TOKEN=xxx npm start
 */
router.post(
  '/force-reset',
  u.wrap(async (req, res) => {
    const expect = String(runtime.resetToken || '');
    if (!expect) return u.fail(res, '接口不存在', 404);

    if (!tokenEquals(String(req.get('x-reset-token') || ''), expect)) {
      return u.fail(res, '重置令牌不正确', 403);
    }

    const password = String((req.body || {}).password || '');
    const err = u.validateAdminPassword(password);
    if (err) return u.fail(res, err, 400);

    const fresh = await u.hashPassword(password);
    db.setSetting('admin_password_salt', fresh.salt);
    db.setSetting('admin_password_hash', fresh.hash);
    db.run('DELETE FROM admin_sessions');
    adminAuth.clearCookie(res);
    db.logAudit({ action: 'admin.force_reset', ip: u.clientIp(req), detail: '凭重置令牌' });

    u.ok(res, { relogin: true });
  })
);

/* ================================================================== *
 * 以下全部需要登录
 * ================================================================== */

router.use(requireAdmin, requireCsrf);

router.post('/logout', (req, res) => {
  db.run('DELETE FROM admin_sessions WHERE token = ?', req.adminToken);
  adminAuth.clearCookie(res);
  db.logAudit({ action: 'admin.logout', ip: u.clientIp(req) });
  u.ok(res);
});

router.get('/me', (req, res) => {
  const pendingRow = db.get(
    "SELECT COUNT(*) AS c FROM suggestions WHERE status='pending' AND deleted_at IS NULL"
  );
  u.ok(res, {
    token: req.adminToken,
    expiresAt: req.admin.expiresAt,
    pending: pendingRow ? Number(pendingRow.c) : 0,
    config: db.publicConfig(),
  });
});

/* ------------------------------ 仪表盘 ------------------------------ */

router.get('/dashboard', (req, res) => {
  const days = u.clampInt(req.query.days, 7, 90, 14);
  const since = Date.now() - days * DAY;

  const one = (sql, ...p) => {
    const row = db.get(sql, ...p);
    return row ? Number(Object.values(row)[0]) : 0;
  };

  const counts = {
    pending: one("SELECT COUNT(*) FROM suggestions WHERE status='pending' AND deleted_at IS NULL"),
    approved: one("SELECT COUNT(*) FROM suggestions WHERE status='approved' AND deleted_at IS NULL"),
    rejected: one("SELECT COUNT(*) FROM suggestions WHERE status='rejected' AND deleted_at IS NULL"),
    done: one("SELECT COUNT(*) FROM suggestions WHERE status='done' AND deleted_at IS NULL"),
    deleted: one('SELECT COUNT(*) FROM suggestions WHERE deleted_at IS NOT NULL'),
    totalVotes: one('SELECT COUNT(*) FROM votes'),
    totalPlayers: one('SELECT COUNT(*) FROM players'),
    bannedPlayers: one('SELECT COUNT(*) FROM players WHERE banned=1'),
    bans: one('SELECT COUNT(*) FROM bans'),
    votesToday: one('SELECT COUNT(*) FROM votes WHERE created_at > ?', Date.now() - DAY),
    suggestionsToday: one('SELECT COUNT(*) FROM suggestions WHERE created_at > ?', Date.now() - DAY),
    playersToday: one('SELECT COUNT(*) FROM players WHERE created_at > ?', Date.now() - DAY),
  };

  // 通过率：已审的建议里通过的比例
  const reviewed = counts.approved + counts.rejected + counts.done;
  counts.approvalRate = reviewed > 0 ? Math.round(((counts.approved + counts.done) / reviewed) * 100) : 0;

  // 趋势：把缺的日期补成 0，否则图表会断
  const voteRows = db.all(
    `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS c
     FROM votes WHERE created_at > ? GROUP BY d`,
    since
  );
  const sugRows = db.all(
    `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS c
     FROM suggestions WHERE created_at > ? GROUP BY d`,
    since
  );
  const voteMap = new Map(voteRows.map((r) => [r.d, Number(r.c)]));
  const sugMap = new Map(sugRows.map((r) => [r.d, Number(r.c)]));

  const trend = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dt = new Date(Date.now() - i * DAY);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
      dt.getDate()
    ).padStart(2, '0')}`;
    trend.push({
      date: key,
      votes: voteMap.get(key) || 0,
      suggestions: sugMap.get(key) || 0,
    });
  }

  const topByVotes = db.all(
    `SELECT s.id, s.title, s.category, s.vote_count FROM suggestions s
     WHERE s.status='approved' AND s.deleted_at IS NULL
     ORDER BY s.vote_count DESC, s.created_at ASC LIMIT 8`
  ).map((r) => ({
    id: Number(r.id),
    title: r.title,
    category: r.category,
    voteCount: Number(r.vote_count),
  }));

  const recentSuggestions = db.all(
    `SELECT s.id, s.title, s.status, s.created_at, p.nickname
     FROM suggestions s JOIN players p ON p.id = s.author_id
     WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 8`
  ).map((r) => ({
    id: Number(r.id),
    title: r.title,
    status: r.status,
    author: r.nickname,
    createdAt: Number(r.created_at),
  }));

  // 可疑 IP：同一个 IP 投出的票数明显偏多
  const suspiciousIps = db.all(
    `SELECT ip, COUNT(*) AS c, COUNT(DISTINCT player_id) AS players
     FROM votes WHERE ip IS NOT NULL
     GROUP BY ip HAVING c >= 10 ORDER BY c DESC LIMIT 8`
  ).map((r) => ({ ip: r.ip, votes: Number(r.c), players: Number(r.players) }));

  u.ok(res, { counts, trend, days, topByVotes, recentSuggestions, suspiciousIps });
});

/* ------------------------------ 建议管理 ------------------------------ */

router.get('/suggestions', (req, res) => {
  const page = u.clampInt(req.query.page, 1, 100000, 1);
  const pageSize = u.clampInt(req.query.pageSize, 1, 100, 20);
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];

  const status = String(req.query.status || 'all');
  if (status === 'deleted') {
    where.push('s.deleted_at IS NOT NULL');
  } else {
    where.push('s.deleted_at IS NULL');
    if (STATUSES.includes(status)) {
      where.push('s.status = ?');
      params.push(status);
    }
  }

  const category = String(req.query.category || '').trim();
  if (category) {
    where.push('s.category = ?');
    params.push(category);
  }

  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    where.push("(s.title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR p.nickname LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like, like);
  }

  const sortMap = {
    votes: 's.vote_count DESC, s.created_at DESC',
    newest: 's.created_at DESC',
    oldest: 's.created_at ASC',
    updated: 'COALESCE(s.edited_at, s.reviewed_at, s.created_at) DESC',
  };
  const order = sortMap[req.query.sort] || sortMap.newest;

  const whereSql = where.join(' AND ');

  const totalRow = db.get(
    `SELECT COUNT(*) AS c FROM suggestions s JOIN players p ON p.id = s.author_id WHERE ${whereSql}`,
    ...params
  );
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    `SELECT s.*, p.nickname AS author_nickname, p.email AS author_email
     FROM suggestions s JOIN players p ON p.id = s.author_id
     WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset
  );

  res.json({
    ok: true,
    items: rows.map(adminMapSuggestion),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    counts: {
      pending: Number(db.get("SELECT COUNT(*) c FROM suggestions WHERE status='pending' AND deleted_at IS NULL").c),
      approved: Number(db.get("SELECT COUNT(*) c FROM suggestions WHERE status='approved' AND deleted_at IS NULL").c),
      rejected: Number(db.get("SELECT COUNT(*) c FROM suggestions WHERE status='rejected' AND deleted_at IS NULL").c),
      done: Number(db.get("SELECT COUNT(*) c FROM suggestions WHERE status='done' AND deleted_at IS NULL").c),
      deleted: Number(db.get("SELECT COUNT(*) c FROM suggestions WHERE deleted_at IS NOT NULL").c),
    },
  });
});

router.get('/suggestions/:id', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  const votes = db.all(
    `SELECT v.id, v.ip, v.user_agent, v.created_at, p.nickname, p.email
     FROM votes v JOIN players p ON p.id = v.player_id
     WHERE v.suggestion_id = ? ORDER BY v.created_at DESC LIMIT 200`,
    row.id
  );

  res.json({
    ok: true,
    item: adminMapSuggestion(row),
    votes: votes.map((v) => ({
      id: Number(v.id),
      ip: v.ip,
      userAgent: v.user_agent,
      createdAt: Number(v.created_at),
      nickname: v.nickname,
      email: v.email,
    })),
  });
});

/** 通过审核 —— 上架到投票榜 */
router.post('/suggestions/:id/approve', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);
  if (row.deleted_at) return u.fail(res, '这条建议已被删除，先恢复再审核', 409);

  db.run(
    `UPDATE suggestions SET status='approved', reject_reason=NULL, reviewed_at=?
     WHERE id = ?`,
    Date.now(),
    row.id
  );
  db.logAudit({
    action: 'suggestion.approve',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id), status: 'approved' });
});

/** 拒绝并记理由（玩家可在「查我的建议」看到） */
router.post('/suggestions/:id/reject', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);
  if (row.deleted_at) return u.fail(res, '这条建议已被删除', 409);

  const reason = u.cleanText((req.body || {}).reason, 200);
  if (reason.length < 2) return u.fail(res, '请填写拒绝理由，至少 2 个字（玩家能看到）', 400);

  db.run(
    `UPDATE suggestions SET status='rejected', reject_reason=?, reviewed_at=? WHERE id = ?`,
    reason,
    Date.now(),
    row.id
  );
  db.logAudit({
    action: 'suggestion.reject',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: { title: row.title, reason },
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id), status: 'rejected', rejectReason: reason });
});

/** 打回待审（用于误拒） */
router.post('/suggestions/:id/reopen', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  db.run(
    `UPDATE suggestions SET status='pending', reject_reason=NULL, reviewed_at=NULL WHERE id = ?`,
    row.id
  );
  db.logAudit({
    action: 'suggestion.reopen',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id), status: 'pending' });
});

/** 标记完成 —— 从投票榜下架，进「已实现」荣誉榜 */
router.post('/suggestions/:id/done', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);
  if (row.deleted_at) return u.fail(res, '这条建议已被删除', 409);

  const note = u.cleanText((req.body || {}).note, 300);
  db.run(
    `UPDATE suggestions SET status='done', done_at=?, admin_note=COALESCE(NULLIF(?, ''), admin_note)
     WHERE id = ?`,
    Date.now(),
    note,
    row.id
  );
  db.logAudit({
    action: 'suggestion.done',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id), status: 'done' });
});

/** 撤销完成 —— 回到投票榜 */
router.post('/suggestions/:id/undone', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  db.run("UPDATE suggestions SET status='approved', done_at=NULL WHERE id = ?", row.id);
  db.logAudit({
    action: 'suggestion.undone',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id), status: 'approved' });
});

/** 编辑内容（后台可改标题/正文/分类/备注） */
router.patch('/suggestions/:id', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  const cfg = db.publicConfig();
  const body = req.body || {};

  const title = body.title === undefined ? row.title : u.cleanText(body.title, cfg.maxTitleLen);
  if (title.length < 4) return u.fail(res, '标题至少 4 个字', 400);

  const text = body.body === undefined ? row.body : u.cleanText(body.body, cfg.maxBodyLen);
  if (text.length < 10) return u.fail(res, '正文至少 10 个字', 400);

  let category = row.category;
  if (body.category !== undefined) {
    category = u.cleanText(body.category, 12);
    if (!cfg.categories.includes(category)) return u.fail(res, '分类不在可选范围内', 400);
  }

  const note = body.adminNote === undefined ? row.admin_note : u.cleanText(body.adminNote, 300);

  db.run(
    `UPDATE suggestions SET title=?, body=?, category=?, admin_note=?, edited_at=? WHERE id = ?`,
    title,
    text,
    category,
    note || null,
    Date.now(),
    row.id
  );
  db.logAudit({
    action: 'suggestion.edit',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: { before: row.title, after: title },
    ip: u.clientIp(req),
  });

  u.ok(res, { item: adminMapSuggestion(loadSuggestion(row.id)) });
});

/** 软删除 */
router.delete('/suggestions/:id', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  db.run('UPDATE suggestions SET deleted_at=? WHERE id = ?', Date.now(), row.id);
  db.logAudit({
    action: 'suggestion.delete',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id) });
});

router.post('/suggestions/:id/restore', (req, res) => {
  const row = loadSuggestion(req.params.id);
  if (!row) return u.fail(res, '建议不存在', 404);

  db.run('UPDATE suggestions SET deleted_at=NULL WHERE id = ?', row.id);
  db.logAudit({
    action: 'suggestion.restore',
    targetType: 'suggestion',
    targetId: Number(row.id),
    detail: row.title,
    ip: u.clientIp(req),
  });
  u.ok(res, { id: Number(row.id) });
});

/* ------------------------------ 投票明细 ------------------------------ */

router.get('/votes', (req, res) => {
  const page = u.clampInt(req.query.page, 1, 100000, 1);
  const pageSize = u.clampInt(req.query.pageSize, 1, 100, 30);
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];

  const suggestionId = u.clampInt(req.query.suggestionId, 1, Number.MAX_SAFE_INTEGER, 0);
  if (suggestionId) {
    where.push('v.suggestion_id = ?');
    params.push(suggestionId);
  }

  const email = u.normalizeEmail(req.query.email);
  if (email) {
    where.push('p.email LIKE ? ESCAPE \'\\\'');
    params.push(`%${email.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  }

  const ip = String(req.query.ip || '').trim().slice(0, 60);
  if (ip) {
    where.push("v.ip LIKE ? ESCAPE '\\'");
    params.push(`%${ip.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db.get(
    `SELECT COUNT(*) AS c FROM votes v
     JOIN players p ON p.id = v.player_id
     JOIN suggestions s ON s.id = v.suggestion_id
     ${whereSql}`,
    ...params
  );
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    `SELECT v.id, v.ip, v.user_agent, v.created_at,
            p.nickname, p.email, p.banned,
            s.id AS suggestion_id, s.title AS suggestion_title, s.status AS suggestion_status
     FROM votes v
     JOIN players p ON p.id = v.player_id
     JOIN suggestions s ON s.id = v.suggestion_id
     ${whereSql}
     ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset
  );

  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: Number(r.id),
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: Number(r.created_at),
      nickname: r.nickname,
      email: r.email,
      banned: Number(r.banned) === 1,
      suggestionId: Number(r.suggestion_id),
      suggestionTitle: r.suggestion_title,
      suggestionStatus: r.suggestion_status,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/** 删除单张票（清理刷票） */
router.delete('/votes/:id', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const vote = db.get('SELECT * FROM votes WHERE id = ?', id);
  if (!vote) return u.fail(res, '这条投票记录不存在', 404);

  const result = purgeVotes('id = ?', [id]);
  db.logAudit({
    action: 'vote.delete',
    targetType: 'vote',
    targetId: id,
    detail: { suggestionId: Number(vote.suggestion_id), email: vote.player_id },
    ip: u.clientIp(req),
  });
  u.ok(res, { removed: result.removed });
});

/** 批量清理：按 IP 或按邮箱（两种刷票的典型形态） */
router.post('/votes/purge', (req, res) => {
  const body = req.body || {};
  const ip = String(body.ip || '').trim().slice(0, 60);
  const email = u.normalizeEmail(body.email);

  if (!ip && !email) return u.fail(res, '请提供要清理的 IP 或邮箱', 400);

  let result;
  if (ip) {
    result = purgeVotes('ip = ?', [ip]);
  } else {
    const player = db.get('SELECT id FROM players WHERE email = ?', email);
    if (!player) return u.fail(res, '这个邮箱没有对应的玩家记录', 404);
    result = purgeVotes('player_id = ?', [player.id]);
  }

  db.logAudit({
    action: 'vote.purge',
    detail: { ip: ip || null, email: email || null, removed: result.removed },
    ip: u.clientIp(req),
  });
  u.ok(res, result);
});

/* ------------------------------ 玩家管理 ------------------------------ */

router.get('/players', (req, res) => {
  const page = u.clampInt(req.query.page, 1, 100000, 1);
  const pageSize = u.clampInt(req.query.pageSize, 1, 100, 30);
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];

  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    where.push("(p.email LIKE ? ESCAPE '\\' OR p.nickname LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like);
  }

  if (req.query.banned === '1') where.push('p.banned = 1');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db.get(`SELECT COUNT(*) AS c FROM players p ${whereSql}`, ...params);
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    `SELECT p.id, p.email, p.nickname, p.created_at, p.last_seen_at, p.last_ip,
            p.banned, p.ban_reason, p.banned_at,
            (SELECT COUNT(*) FROM suggestions s WHERE s.author_id = p.id AND s.deleted_at IS NULL) AS suggestion_count,
            (SELECT COUNT(*) FROM votes v WHERE v.player_id = p.id) AS vote_count
     FROM players p ${whereSql}
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset
  );

  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      nickname: r.nickname,
      createdAt: Number(r.created_at),
      lastSeenAt: r.last_seen_at ? Number(r.last_seen_at) : null,
      lastIp: r.last_ip,
      banned: Number(r.banned) === 1,
      banReason: r.ban_reason,
      bannedAt: r.banned_at ? Number(r.banned_at) : null,
      suggestionCount: Number(r.suggestion_count),
      voteCount: Number(r.vote_count),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

router.get('/players/:id', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const player = db.get('SELECT * FROM players WHERE id = ?', id);
  if (!player) return u.fail(res, '玩家不存在', 404);

  const suggestions = db.all(
    `SELECT id, title, category, status, vote_count, created_at, reject_reason
     FROM suggestions WHERE author_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    id
  );
  const votes = db.all(
    `SELECT v.id, v.created_at, v.ip, s.id AS sid, s.title, s.status
     FROM votes v JOIN suggestions s ON s.id = v.suggestion_id
     WHERE v.player_id = ? ORDER BY v.created_at DESC LIMIT 200`,
    id
  );

  res.json({
    ok: true,
    player: {
      id: Number(player.id),
      email: player.email,
      nickname: player.nickname,
      createdAt: Number(player.created_at),
      lastSeenAt: player.last_seen_at ? Number(player.last_seen_at) : null,
      lastIp: player.last_ip,
      banned: Number(player.banned) === 1,
      banReason: player.ban_reason,
      bannedAt: player.banned_at ? Number(player.banned_at) : null,
    },
    suggestions: suggestions.map((s) => ({
      id: Number(s.id),
      title: s.title,
      category: s.category,
      status: s.status,
      voteCount: Number(s.vote_count),
      createdAt: Number(s.created_at),
      rejectReason: s.reject_reason,
    })),
    votes: votes.map((v) => ({
      id: Number(v.id),
      suggestionId: Number(v.sid),
      title: v.title,
      status: v.status,
      ip: v.ip,
      createdAt: Number(v.created_at),
    })),
  });
});

router.post('/players/:id/ban', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const player = db.get('SELECT * FROM players WHERE id = ?', id);
  if (!player) return u.fail(res, '玩家不存在', 404);

  const reason = u.cleanText((req.body || {}).reason, 100);
  db.run(
    'UPDATE players SET banned=1, ban_reason=?, banned_at=? WHERE id = ?',
    reason || null,
    Date.now(),
    id
  );
  db.logAudit({
    action: 'player.ban',
    targetType: 'player',
    targetId: id,
    detail: { email: player.email, reason },
    ip: u.clientIp(req),
  });
  u.ok(res, { id });
});

router.post('/players/:id/unban', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const player = db.get('SELECT * FROM players WHERE id = ?', id);
  if (!player) return u.fail(res, '玩家不存在', 404);

  db.run('UPDATE players SET banned=0, ban_reason=NULL, banned_at=NULL WHERE id = ?', id);
  db.logAudit({
    action: 'player.unban',
    targetType: 'player',
    targetId: id,
    detail: player.email,
    ip: u.clientIp(req),
  });
  u.ok(res, { id });
});

/** 清空某玩家的全部投票（惩罚性，可撤销与否看你） */
router.post('/players/:id/purge-votes', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const player = db.get('SELECT * FROM players WHERE id = ?', id);
  if (!player) return u.fail(res, '玩家不存在', 404);

  const result = purgeVotes('player_id = ?', [id]);
  db.logAudit({
    action: 'player.purge_votes',
    targetType: 'player',
    targetId: id,
    detail: { email: player.email, removed: result.removed },
    ip: u.clientIp(req),
  });
  u.ok(res, result);
});

/* ------------------------------ 封禁名单 ------------------------------ */

router.get('/bans', (req, res) => {
  const rows = db.all('SELECT * FROM bans ORDER BY created_at DESC LIMIT 500');
  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      value: r.value,
      reason: r.reason,
      createdAt: Number(r.created_at),
    })),
  });
});

router.post('/bans', (req, res) => {
  const body = req.body || {};
  const kind = body.kind === 'ip' ? 'ip' : body.kind === 'email' ? 'email' : null;
  if (!kind) return u.fail(res, '类型必须是 ip 或 email', 400);

  let value = u.cleanText(body.value, 100);
  if (!value) return u.fail(res, '请填写要封禁的内容', 400);
  if (kind === 'email') {
    value = u.normalizeEmail(value);
    const err = u.validateEmail(value);
    if (err) return u.fail(res, `邮箱不合法：${err}`, 400);
  } else {
    value = u.normalizeIp(value);
  }

  const reason = u.cleanText(body.reason, 100);

  try {
    db.run(
      'INSERT INTO bans (kind, value, reason, created_at) VALUES (?, ?, ?, ?)',
      kind,
      value,
      reason || null,
      Date.now()
    );
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      return u.fail(res, '这条已经在封禁名单里了', 409);
    }
    throw err;
  }

  db.logAudit({
    action: 'ban.add',
    detail: { kind, value, reason },
    ip: u.clientIp(req),
  });
  u.ok(res, { kind, value });
});

router.delete('/bans/:id', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const row = db.get('SELECT * FROM bans WHERE id = ?', id);
  if (!row) return u.fail(res, '记录不存在', 404);

  db.run('DELETE FROM bans WHERE id = ?', id);
  db.logAudit({ action: 'ban.remove', detail: { kind: row.kind, value: row.value }, ip: u.clientIp(req) });
  u.ok(res, { id });
});

/* ------------------------------ 站点设置 ------------------------------ */

router.get('/settings', (req, res) => {
  const all = db.allSettings();
  const out = {};
  for (const key of SETTING_KEYS) out[key] = all[key];

  res.json({
    ok: true,
    settings: out,
    categories: db.publicConfig().categories,
    screenshots: db.publicConfig().screenshots,
  });
});

router.put('/settings', (req, res) => {
  const { values, errors } = sanitizeSettings(req.body || {});
  if (errors.length) return u.fail(res, errors.join('；'), 400);
  if (Object.keys(values).length === 0) return u.fail(res, '没有需要更新的内容', 400);

  db.tx(() => {
    for (const [k, v] of Object.entries(values)) db.setSetting(k, v);
  });

  db.logAudit({
    action: 'settings.update',
    detail: Object.keys(values),
    ip: u.clientIp(req),
  });

  const all = db.allSettings();
  const out = {};
  for (const key of SETTING_KEYS) out[key] = all[key];
  u.ok(res, { settings: out });
});

/** 修改管理员密码 */
router.post('/password', u.wrap(async (req, res) => {
  const body = req.body || {};
  const current = String(body.current || '');
  const next = String(body.next || '');

  const salt = db.getSetting('admin_password_salt', '');
  const hash = db.getSetting('admin_password_hash', '');
  if (!(await u.verifyPassword(current, salt, hash))) {
    return u.fail(res, '当前密码不正确', 401);
  }

  const err = u.validateAdminPassword(next);
  if (err) return u.fail(res, err, 400);

  const fresh = await u.hashPassword(next);
  db.setSetting('admin_password_salt', fresh.salt);
  db.setSetting('admin_password_hash', fresh.hash);

  // 改密后所有会话失效，强制重新登录
  db.run('DELETE FROM admin_sessions');
  adminAuth.clearCookie(res);

  db.logAudit({ action: 'admin.password_change', ip: u.clientIp(req) });
  u.ok(res, { relogin: true });
}));

/* ------------------------------ 首页截图上传 ------------------------------ */

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

router.post('/screenshots', (req, res) => {
  const body = req.body || {};
  const dataUrl = String(body.dataUrl || '');
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);

  if (!match) return u.fail(res, '图片格式不对，请重新选择', 400);

  const mime = match[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return u.fail(res, '只支持 PNG / JPG / WebP / GIF', 400);

  const buf = Buffer.from(match[2], 'base64');
  if (buf.length === 0) return u.fail(res, '图片是空的', 400);
  if (buf.length > MAX_UPLOAD_BYTES) {
    return u.fail(res, `图片不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, 413);
  }

  // 用文件头再确认一次，别只信 data URL 的声明
  const magicOk =
    (ext === 'png' && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (ext === 'jpg' && buf[0] === 0xff && buf[1] === 0xd8) ||
    (ext === 'gif' && buf.subarray(0, 3).toString('latin1') === 'GIF') ||
    (ext === 'webp' && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP');

  if (!magicOk) return u.fail(res, '文件内容不像是一张图片', 400);

  const filename = `${u.newId()}.${ext}`;
  const store = runtime.screenshots();
  store.put(filename, buf, mime);

  const current = db.publicConfig().screenshots;
  if (current.length >= 8) {
    store.remove(filename);
    return u.fail(res, '首页截图最多 8 张，先删掉几张再传', 409);
  }

  const entry = {
    id: u.newId(),
    url: `/uploads/${filename}`,
    caption: u.cleanText(body.caption, 40),
  };
  const next = [...current, entry];
  db.setSetting('screenshots', JSON.stringify(next));

  db.logAudit({ action: 'screenshot.add', detail: entry.url, ip: u.clientIp(req) });
  u.ok(res, { screenshot: entry, screenshots: next });
});

router.delete('/screenshots', (req, res) => {
  const id = String((req.body || {}).id || '');
  const current = db.publicConfig().screenshots;
  const target = current.find((s) => s.id === id);
  if (!target) return u.fail(res, '这张截图不存在', 404);

  const next = current.filter((s) => s.id !== id);
  db.setSetting('screenshots', JSON.stringify(next));

  // 只删自己存的那些：文件名从 URL 里取，带路径的值一律不认
  const base = String(target.url).split('/').pop();
  if (/^[A-Za-z0-9._-]+$/.test(base)) {
    try {
      runtime.screenshots().remove(base);
    } catch {
      /* 文件删不掉不影响配置更新 */
    }
  }

  db.logAudit({ action: 'screenshot.remove', detail: target.url, ip: u.clientIp(req) });
  u.ok(res, { screenshots: next });
});

/* ------------------------------ 操作日志 ------------------------------ */

router.get('/logs', (req, res) => {
  const page = u.clampInt(req.query.page, 1, 100000, 1);
  const pageSize = u.clampInt(req.query.pageSize, 1, 200, 50);
  const offset = (page - 1) * pageSize;

  const totalRow = db.get('SELECT COUNT(*) AS c FROM audit_log');
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    'SELECT * FROM audit_log ORDER BY at DESC LIMIT ? OFFSET ?',
    pageSize,
    offset
  );

  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id === null ? null : Number(r.target_id),
      detail: r.detail,
      ip: r.ip,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/* ------------------------------ 维护工具 ------------------------------ */

/** 重算所有建议的票数缓存 */
router.post('/recount', (req, res) => {
  const fixed = db.recountAll();
  db.logAudit({ action: 'maintenance.recount', detail: { fixed }, ip: u.clientIp(req) });
  u.ok(res, { fixed });
});

/** 清理过期会话与限频事件 */
router.post('/cleanup', (req, res) => {
  db.cleanup();
  db.logAudit({ action: 'maintenance.cleanup', ip: u.clientIp(req) });
  u.ok(res);
});
};
