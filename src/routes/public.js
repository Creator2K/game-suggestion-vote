'use strict';

/**
 * 玩家端 API。
 *
 * 身份模型：邮箱即身份。首次提交/投票时补昵称并建档，之后只认邮箱。
 * 昵称全局唯一（数据库层 COLLATE NOCASE 唯一索引），防止冒充。
 */

const express = require('express');
const db = require('../db');
const spam = require('../middleware/antispam');
const u = require('../util');

const router = express.Router();
const { DAY, HOUR } = spam;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** LIKE 查询里的 % _ \ 需要转义，否则用户输入的 % 会变成通配符 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

function settingNum(key, fallback) {
  const v = Number(db.getSetting(key, String(fallback)));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function pageParams(query, defaultSize = 12, maxSize = 50) {
  const page = u.clampInt(query.page, 1, 100000, 1);
  const pageSize = u.clampInt(query.pageSize, 1, maxSize, defaultSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/* ------------------------------------------------------------------ *
 * 玩家身份解析
 * ------------------------------------------------------------------ */

/**
 * 根据 email(+nickname) 拿到玩家记录，必要时建档。
 * @returns {{player?: object, error?: string, needNickname?: boolean, nicknameTaken?: boolean, banned?: boolean, isNew?: boolean}}
 */
function resolvePlayer(req, { email, nickname }) {
  const cleanEmail = u.normalizeEmail(email);
  const emailErr = u.validateEmail(cleanEmail);
  if (emailErr) return { error: emailErr };

  if (spam.isEmailBanned(cleanEmail)) {
    return { error: '这个邮箱已被禁止操作，如有疑问请联系管理员', banned: true };
  }

  const ip = u.clientIp(req);
  const existing = db.get('SELECT * FROM players WHERE email = ?', cleanEmail);

  if (existing) {
    if (Number(existing.banned) === 1) {
      const reason = existing.ban_reason ? `：${existing.ban_reason}` : '';
      return { error: `这个邮箱已被封禁${reason}`, banned: true };
    }
    db.run(
      'UPDATE players SET last_seen_at = ?, last_ip = ? WHERE id = ?',
      Date.now(),
      ip,
      existing.id
    );
    return { player: existing, isNew: false };
  }

  // —— 新邮箱：需要昵称 ——
  const nick = u.normalizeNickname(nickname);
  const nickErr = u.validateNickname(nick);
  if (nickErr) return { error: nickErr, needNickname: true };

  if (db.get('SELECT id FROM players WHERE nickname = ?', nick)) {
    return {
      error: `昵称「${nick}」已经被占用了，换一个吧`,
      needNickname: true,
      nicknameTaken: true,
    };
  }

  const ts = Date.now();
  try {
    const r = db.run(
      `INSERT INTO players (email, nickname, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?)`,
      cleanEmail,
      nick,
      ts,
      ts,
      ip
    );
    const player = db.get('SELECT * FROM players WHERE id = ?', Number(r.lastInsertRowid));
    return { player, isNew: true };
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      // 并发下被抢先插入，重查
      const again = db.get('SELECT * FROM players WHERE email = ?', cleanEmail);
      if (again) return { player: again, isNew: false };
      return {
        error: '昵称刚被别人占用了，换一个吧',
        needNickname: true,
        nicknameTaken: true,
      };
    }
    throw err;
  }
}

/** 把 resolvePlayer 的错误统一转成 HTTP 响应 */
function replyPlayerError(res, r) {
  const status = r.banned ? 403 : r.nicknameTaken ? 409 : 400;
  return u.fail(res, r.error, status, {
    needNickname: !!r.needNickname,
    nicknameTaken: !!r.nicknameTaken,
    banned: !!r.banned,
  });
}

/* ------------------------------------------------------------------ *
 * 站点信息
 * ------------------------------------------------------------------ */

router.get('/config', (req, res) => {
  const cfg = db.publicConfig();
  const initialized = !!db.getSetting('admin_password_hash', '');
  u.ok(res, { config: cfg, adminInitialized: initialized });
});

router.get('/stats', (req, res) => {
  const dayAgo = Date.now() - DAY;

  const one = (sql, ...p) => {
    const row = db.get(sql, ...p);
    return row ? Number(Object.values(row)[0]) : 0;
  };

  u.ok(res, {
    stats: {
      approved: one("SELECT COUNT(*) FROM suggestions WHERE status='approved' AND deleted_at IS NULL"),
      pending: one("SELECT COUNT(*) FROM suggestions WHERE status='pending' AND deleted_at IS NULL"),
      done: one("SELECT COUNT(*) FROM suggestions WHERE status='done' AND deleted_at IS NULL"),
      rejected: one("SELECT COUNT(*) FROM suggestions WHERE status='rejected' AND deleted_at IS NULL"),
      totalSuggestions: one('SELECT COUNT(*) FROM suggestions WHERE deleted_at IS NULL'),
      totalVotes: one('SELECT COUNT(*) FROM votes'),
      totalPlayers: one('SELECT COUNT(*) FROM players'),
      votesToday: one('SELECT COUNT(*) FROM votes WHERE created_at > ?', dayAgo),
      suggestionsToday: one('SELECT COUNT(*) FROM suggestions WHERE created_at > ?', dayAgo),
    },
  });
});

/* ------------------------------------------------------------------ *
 * 建议列表
 * ------------------------------------------------------------------ */

const SUGGESTION_SELECT = `
  SELECT s.id, s.title, s.body, s.category, s.status, s.reject_reason, s.admin_note,
         s.vote_count, s.created_at, s.reviewed_at, s.done_at, s.edited_at,
         p.nickname AS author_nickname
  FROM suggestions s
  JOIN players p ON p.id = s.author_id
`;

function mapSuggestion(row, rank) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    category: row.category,
    status: row.status,
    voteCount: Number(row.vote_count),
    author: row.author_nickname,
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : null,
    doneAt: row.done_at ? Number(row.done_at) : null,
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    // 实现说明只在「已实现」时公开，其他状态下后台备注不外泄
    doneNote: row.status === 'done' ? row.admin_note || null : null,
    ...(rank === undefined ? {} : { rank }),
  };
}

/** 把「当前邮箱投过哪些」标注出来 */
function votedSetFor(email, ids) {
  const clean = u.normalizeEmail(email);
  if (!clean || !ids.length) return new Set();
  if (u.validateEmail(clean)) return new Set();
  const player = db.get('SELECT id FROM players WHERE email = ?', clean);
  if (!player) return new Set();

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT suggestion_id FROM votes WHERE player_id = ? AND suggestion_id IN (${placeholders})`,
    player.id,
    ...ids
  );
  return new Set(rows.map((r) => Number(r.suggestion_id)));
}

router.get('/suggestions', (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 12);
  const cfg = db.publicConfig();

  const where = ["s.status = 'approved'", 's.deleted_at IS NULL'];
  const params = [];

  const category = String(req.query.category || '').trim();
  if (category && cfg.categories.includes(category)) {
    where.push('s.category = ?');
    params.push(category);
  }

  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    where.push("(s.title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\')");
    params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }

  const sort = req.query.sort === 'newest' || req.query.sort === 'votes'
    ? req.query.sort
    : cfg.voteRankMode;
  const order =
    sort === 'newest'
      ? 's.created_at DESC, s.id DESC'
      : 's.vote_count DESC, s.created_at ASC, s.id ASC';

  const whereSql = where.join(' AND ');
  const totalRow = db.get(
    `SELECT COUNT(*) AS c FROM suggestions s JOIN players p ON p.id = s.author_id WHERE ${whereSql}`,
    ...params
  );
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    `${SUGGESTION_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset
  );

  const voted = votedSetFor(req.query.email, rows.map((r) => Number(r.id)));

  res.json({
    ok: true,
    items: rows.map((row, i) => ({
      ...mapSuggestion(row, offset + i + 1),
      voted: voted.has(Number(row.id)),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    sort,
  });
});

/** 首页热门 Top N */
router.get('/top', (req, res) => {
  const limit = u.clampInt(req.query.limit, 1, 10, 3);
  const rows = db.all(
    `${SUGGESTION_SELECT}
     WHERE s.status = 'approved' AND s.deleted_at IS NULL
     ORDER BY s.vote_count DESC, s.created_at ASC, s.id ASC
     LIMIT ?`,
    limit
  );
  res.json({ ok: true, items: rows.map((row, i) => mapSuggestion(row, i + 1)) });
});

/** 已实现荣誉榜 */
router.get('/done', (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 12);
  const where = ["s.status = 'done'", 's.deleted_at IS NULL'];
  const params = [];

  const category = String(req.query.category || '').trim();
  const cfg = db.publicConfig();
  if (category && cfg.categories.includes(category)) {
    where.push('s.category = ?');
    params.push(category);
  }

  const whereSql = where.join(' AND ');
  const totalRow = db.get(`SELECT COUNT(*) AS c FROM suggestions s WHERE ${whereSql}`, ...params);
  const total = totalRow ? Number(totalRow.c) : 0;

  const rows = db.all(
    `${SUGGESTION_SELECT} WHERE ${whereSql} ORDER BY s.done_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset
  );

  res.json({
    ok: true,
    items: rows.map((row) => mapSuggestion(row)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/** 单条建议详情 */
router.get('/suggestions/:id', (req, res) => {
  const id = u.clampInt(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  if (!id) return u.fail(res, '参数不正确', 400);

  const row = db.get(`${SUGGESTION_SELECT} WHERE s.id = ?`, id);
  if (!row || row.status === 'rejected') return u.fail(res, '建议不存在', 404);

  const voted = votedSetFor(req.query.email, [id]);
  res.json({ ok: true, item: { ...mapSuggestion(row), voted: voted.has(id) } });
});

/* ------------------------------------------------------------------ *
 * 查我的建议
 * ------------------------------------------------------------------ */

router.get('/mine', (req, res) => {
  const email = u.normalizeEmail(req.query.email);
  const emailErr = u.validateEmail(email);
  if (emailErr) return u.fail(res, emailErr, 400);

  const player = db.get('SELECT * FROM players WHERE email = ?', email);
  if (!player) {
    return u.ok(res, {
      found: false,
      nickname: null,
      items: [],
      voted: [],
      message: '这个邮箱还没有提交过任何建议',
    });
  }

  const rows = db.all(
    `${SUGGESTION_SELECT} WHERE s.author_id = ? AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    player.id
  );

  // 该玩家投过票的建议
  const votedRows = db.all(
    `SELECT s.id, s.title, s.category, s.status, s.vote_count, s.created_at
     FROM votes v JOIN suggestions s ON s.id = v.suggestion_id
     WHERE v.player_id = ? AND s.deleted_at IS NULL
     ORDER BY v.created_at DESC`,
    player.id
  );

  res.json({
    ok: true,
    found: true,
    nickname: player.nickname,
    banned: Number(player.banned) === 1,
    banReason: player.ban_reason || null,
    items: rows.map((row) => ({
      ...mapSuggestion(row),
      rejectReason: row.status === 'rejected' ? row.reject_reason : null,
    })),
    voted: votedRows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      category: r.category,
      status: r.status,
      voteCount: Number(r.vote_count),
      createdAt: Number(r.created_at),
    })),
  });
});

/* ------------------------------------------------------------------ *
 * 提交建议
 * ------------------------------------------------------------------ */

router.post(
  '/submit',
  spam.rejectBannedIp,
  spam.rateLimit({
    kind: 'submit',
    windowMs: DAY,
    max: () => settingNum('rate_submit_per_day_ip', 20),
    message: '今天从你这个网络提交的建议有点多了，明天再来吧',
  }),
  u.wrap((req, res) => {
    const cfg = db.publicConfig();
    if (!cfg.submitOpen) return u.fail(res, '建议提交暂时关闭了，请稍后再来', 403);

    const body = req.body || {};
    const email = u.normalizeEmail(body.email);

    // 新邮箱的建档额度按 IP 限，防止有人批量造号绕过「每邮箱每天」限制
    const existingPlayer = db.get('SELECT id FROM players WHERE email = ?', email);
    const ip = u.clientIp(req);
    if (
      !existingPlayer &&
      spam.countIp('newplayer', ip, DAY) >= settingNum('rate_newplayer_per_day_ip', 10)
    ) {
      return u.fail(res, '今天从这个网络注册的新玩家有点多了，明天再来吧', 429);
    }

    const r = resolvePlayer(req, { email, nickname: body.nickname });
    if (r.error) return replyPlayerError(res, r);
    const player = r.player;

    // 每邮箱每天的提交额度
    const perDay = settingNum('rate_submit_per_day', 5);
    const recent = db.get(
      'SELECT COUNT(*) AS c FROM suggestions WHERE author_id = ? AND created_at > ?',
      player.id,
      Date.now() - DAY
    );
    if (recent && Number(recent.c) >= perDay) {
      return u.fail(res, `每个邮箱每天最多提交 ${perDay} 条建议，明天再来吧`, 429);
    }

    const title = u.cleanText(body.title, cfg.maxTitleLen);
    if (title.length < 4) return u.fail(res, '标题至少 4 个字，说清楚你想要什么', 400);
    if (!title) return u.fail(res, '请填写标题', 400);

    const text = u.cleanText(body.body, cfg.maxBodyLen);
    if (text.length < 10) return u.fail(res, '正文至少 10 个字，多写点细节更容易被采纳', 400);

    const category = String(body.category || '').trim();
    if (!cfg.categories.includes(category)) {
      return u.fail(res, '请选择一个有效的分类', 400);
    }

    // 同一邮箱短时间内不要重复提交一样的标题
    const dup = db.get(
      `SELECT id FROM suggestions
       WHERE author_id = ? AND title = ? AND created_at > ? AND deleted_at IS NULL`,
      player.id,
      title,
      Date.now() - 10 * 60 * 1000
    );
    if (dup) return u.fail(res, '你刚刚提交过一模一样的标题，稍等一会儿再来', 409);

    const ts = Date.now();
    const ins = db.run(
      `INSERT INTO suggestions (title, body, category, author_id, status, vote_count, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      title,
      text,
      category,
      player.id,
      ts
    );

    if (r.isNew) spam.bump('newplayer', ip);
    spam.bump('submit', ip);

    res.json({
      ok: true,
      id: Number(ins.lastInsertRowid),
      nickname: player.nickname,
      message: '提交成功！通过审核后就会出现在投票榜上',
    });
  })
);

/* ------------------------------------------------------------------ *
 * 投票
 * ------------------------------------------------------------------ */

router.post(
  '/vote',
  spam.rejectBannedIp,
  spam.rateLimit({
    kind: 'vote',
    windowMs: HOUR,
    max: () => settingNum('rate_vote_per_hour', 30),
    message: '投票太频繁啦，休息几分钟再来',
  }),
  u.wrap((req, res) => {
    const cfg = db.publicConfig();
    if (!cfg.voteOpen) return u.fail(res, '投票暂时关闭了，请稍后再来', 403);

    const body = req.body || {};
    const suggestionId = u.clampInt(body.suggestionId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!suggestionId) return u.fail(res, '参数不正确', 400);

    const r = resolvePlayer(req, { email: body.email, nickname: body.nickname });
    if (r.error) return replyPlayerError(res, r);
    const player = r.player;

    const sug = db.get(
      'SELECT id, title, status, deleted_at, vote_count FROM suggestions WHERE id = ?',
      suggestionId
    );
    if (!sug || sug.deleted_at) return u.fail(res, '这条建议不存在', 404);
    if (sug.status !== 'approved') {
      return u.fail(res, '这条建议当前不能投票', 409, { status: sug.status });
    }

    const ip = u.clientIp(req);
    const ua = u.userAgent(req);

    // 唯一约束 + ON CONFLICT DO NOTHING：changes 为 0 就说明重复投票
    const result = db.tx(() => {
      const ins = db.run(
        `INSERT INTO votes (suggestion_id, player_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(suggestion_id, player_id) DO NOTHING`,
        suggestionId,
        player.id,
        ip,
        ua,
        Date.now()
      );
      if (Number(ins.changes) === 0) return { duplicate: true };

      db.run('UPDATE suggestions SET vote_count = vote_count + 1 WHERE id = ?', suggestionId);
      const fresh = db.get('SELECT vote_count FROM suggestions WHERE id = ?', suggestionId);
      return { duplicate: false, voteCount: Number(fresh.vote_count) };
    });

    if (result.duplicate) {
      return u.fail(res, '你已经给这条建议投过票了', 409, {
        duplicate: true,
        voteCount: Number(sug.vote_count),
      });
    }

    spam.bump('vote', ip);
    return u.ok(res, { voteCount: result.voteCount, voted: true });
  })
);

module.exports = router;
