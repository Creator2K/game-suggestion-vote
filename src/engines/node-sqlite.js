'use strict';

/**
 * Node 侧的数据引擎：node:sqlite（Node 22.5 起内置，零原生编译）。
 *
 * 对外只暴露 5 个方法，src/db.js 之上的一切都只依赖这 5 个：
 *   all(sql, params)  -> 行数组
 *   get(sql, params)  -> 第一行或 undefined
 *   run(sql, params)  -> { changes, lastInsertRowid }
 *   exec(sql)         -> 执行多条语句，无返回值
 *   transaction(fn)   -> 包一层事务，抛错回滚
 */

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

/**
 * @param {{ dataDir: string, uploadDir: string, dbFile: string }} cfg
 */
function open(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.uploadDir, { recursive: true });

  const db = new DatabaseSync(cfg.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }

  return {
    all: (sql, params) => stmt(sql).all(...params),
    get: (sql, params) => stmt(sql).get(...params),
    run: (sql, params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    transaction: (fn) => {
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
    },
    close: () => {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      cache.clear();
    },
    /** 只有 Node 侧用得到（VACUUM INTO 备份），Workers 没有对应物 */
    get raw() {
      return db;
    },
  };
}

module.exports = { open };
