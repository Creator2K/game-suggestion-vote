'use strict';

/**
 * 数据层：SQLite（Node 内置 node:sqlite，零原生依赖）。
 *
 * 设计要点
 *  - votes 上有 UNIQUE(suggestion_id, player_id)，重复投票交给数据库强制，比应用层判断可靠。
 *  - suggestions.vote_count 是冗余缓存，写票时在同一事务里更新，排行榜不必每次 COUNT(*)。
 *  - 建议使用软删除（deleted_at），保留可追溯性。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

/* ------------------------------------------------------------------ *
 * 表结构
 * ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE,
  nickname     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip      TEXT,
  banned       INTEGER NOT NULL DEFAULT 0,
  ban_reason   TEXT,
  banned_at    INTEGER
);

CREATE TABLE IF NOT EXISTS suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT '其他',
  author_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  admin_note    TEXT,
  vote_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER,
  done_at       INTEGER,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sug_status  ON suggestions(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_sug_rank    ON suggestions(status, deleted_at, vote_count DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sug_author  ON suggestions(author_id);
CREATE INDEX IF NOT EXISTS idx_sug_created ON suggestions(created_at);

CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ip            TEXT,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(suggestion_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_sug     ON votes(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_votes_player  ON votes(player_id);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at);
CREATE INDEX IF NOT EXISTS idx_votes_ip      ON votes(ip);

CREATE TABLE IF NOT EXISTS settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS ip_events (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ip   TEXT NOT NULL,
  kind TEXT NOT NULL,
  at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ipev ON ip_events(ip, kind, at);

CREATE TABLE IF NOT EXISTS bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, value)
);
`;

/* ------------------------------------------------------------------ *
 * 默认站点配置（都能在后台改）
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  schema_version: '1',

  // 管理员密码哈希；为空表示「尚未初始化」，首次访问后台会引导设置
  admin_password_hash: '',
  admin_password_salt: '',

  // 站点文案
  game_name: '像素大陆',
  site_title: '建议投票站',
  tagline: '你的每一个想法，都可能出现在下个版本里',
  hero_sub: '提交建议 · 投票 · 见证它被实现',
  announcement: '',
  footer_text: '由玩家共同建设',

  // 内容
  categories: JSON.stringify(['玩法', '美术', '音乐音效', '平衡性', 'Bug 反馈', '其他']),
  screenshots: JSON.stringify([]),

  // 开关
  submit_open: '1',
  vote_open: '1',

  // 限频与长度（都能在后台调，不用改代码）
  rate_vote_per_hour: '30',
  rate_submit_per_day: '5',
  // 同一 IP 的天花板，防止有人批量注册邮箱绕过「每邮箱每天」的限制
  rate_submit_per_day_ip: '20',
  rate_newplayer_per_day_ip: '10',
  max_title_len: '60',
  max_body_len: '500',

  // 排行榜默认排序：votes | newest
  vote_rank_mode: 'votes',
};

/* ------------------------------------------------------------------ *
 * 连接与查询封装
 * ------------------------------------------------------------------ */

let db = null;
const stmtCache = new Map();

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array，这里统一收口 */
function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function all(sql, ...params) {
  return stmt(sql).all(...params.map(bindable));
}

function get(sql, ...params) {
  return stmt(sql).get(...params.map(bindable));
}

function run(sql, ...params) {
  return stmt(sql).run(...params.map(bindable));
}

/** 事务包装。抛错自动回滚。 */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

function init() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

  db = new DatabaseSync(config.DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  seedSettings();
  return db;
}

function seedSettings() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 配置读写
 * ------------------------------------------------------------------ */

function getSetting(key, fallback = null) {
  const row = get('SELECT setting_value FROM settings WHERE setting_key = ?', key);
  return row ? row.setting_value : fallback;
}

function setSetting(key, value) {
  run(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
    key,
    String(value)
  );
}

function allSettings() {
  const out = {};
  for (const row of all('SELECT setting_key, setting_value FROM settings')) {
    out[row.setting_key] = row.setting_value;
  }
  return out;
}

/** 站点配置的对外快照（不含任何机密字段） */
function publicConfig() {
  const s = allSettings();
  return {
    gameName: s.game_name,
    siteTitle: s.site_title,
    tagline: s.tagline,
    heroSub: s.hero_sub,
    announcement: s.announcement,
    footerText: s.footer_text,
    categories: safeJson(s.categories, []),
    screenshots: safeJson(s.screenshots, []),
    submitOpen: s.submit_open === '1',
    voteOpen: s.vote_open === '1',
    maxTitleLen: Number(s.max_title_len) || 60,
    maxBodyLen: Number(s.max_body_len) || 500,
    voteRankMode: s.vote_rank_mode || 'votes',
  };
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * 维护工具
 * ------------------------------------------------------------------ */

/** 把某条建议的票数缓存重新数一遍（用于人工修数据） */
function recountSuggestion(suggestionId) {
  const row = get('SELECT COUNT(*) AS c FROM votes WHERE suggestion_id = ?', suggestionId);
  const c = row ? Number(row.c) : 0;
  run('UPDATE suggestions SET vote_count = ? WHERE id = ?', c, suggestionId);
  return c;
}

/** 全量重算，返回修正过的条数 */
function recountAll() {
  const rows = all(`
    SELECT s.id AS id, s.vote_count AS cached, COUNT(v.id) AS real_count
    FROM suggestions s
    LEFT JOIN votes v ON v.suggestion_id = s.id
    GROUP BY s.id
    HAVING s.vote_count <> COUNT(v.id)
  `);
  tx(() => {
    for (const r of rows) {
      run('UPDATE suggestions SET vote_count = ? WHERE id = ?', Number(r.real_count), r.id);
    }
  });
  return rows.length;
}

function logAudit({ actor = 'admin', action, targetType = null, targetId = null, detail = null, ip = null }) {
  run(
    `INSERT INTO audit_log (at, actor, action, target_type, target_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    actor,
    action,
    targetType,
    targetId,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
    ip
  );
}

/** 清理过期的会话与限频事件，避免表无限增长 */
function cleanup() {
  const now = Date.now();
  run('DELETE FROM admin_sessions WHERE expires_at < ?', now);
  // 限频事件只保留最近 7 天
  run('DELETE FROM ip_events WHERE at < ?', now - 7 * 24 * 3600 * 1000);
  run('DELETE FROM audit_log WHERE at < ?', now - 180 * 24 * 3600 * 1000);
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    db = null;
    stmtCache.clear();
  }
}

module.exports = {
  init,
  close,
  tx,
  all,
  get,
  run,
  getSetting,
  setSetting,
  allSettings,
  publicConfig,
  recountSuggestion,
  recountAll,
  logAudit,
  cleanup,
  safeJson,
  DEFAULT_SETTINGS,
  get raw() {
    return db;
  },
};
