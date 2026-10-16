'use strict';

/**
 * Workers 侧的数据引擎：Durable Object 内嵌的 SQLite。
 *
 * 与 src/engines/node-sqlite.js 提供同样的 5 个方法，因此 src/db.js
 * 以及之上所有业务代码一行都不用改。
 *
 * 两个已知差异（都在这里吸收掉）：
 *   - sql.exec() 不能执行 BEGIN/COMMIT，事务必须走 ctx.storage.transactionSync()
 *   - 没有 prepared statement 游标可复用，每次都是 sql.exec(query, ...bindings)
 *     （workerd 内部有语句缓存，不用自己管）
 */

/** BLOB 读回来可能是 ArrayBuffer，也可能是 Uint8Array，统一成 Uint8Array */
function toBytes(v) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  return new Uint8Array(v);
}

/**
 * @param {{ sql: any, storage: any }} do_ Durable Object 的 ctx.storage
 */
function create(do_) {
  const { sql, storage } = do_;

  return {
    all(query, params) {
      return sql.exec(query, ...params).toArray();
    },

    get(query, params) {
      const rows = sql.exec(query, ...params).toArray();
      return rows.length ? rows[0] : undefined;
    },

    run(query, params) {
      const cursor = sql.exec(query, ...params);
      // 消费掉游标，语句才算执行完
      cursor.toArray();

      // changes() 才是「真正被改动的行数」：INSERT ... ON CONFLICT DO NOTHING
      // 被忽略时它是 0，而游标的 rowsWritten 会把被忽略的写入也算进去，
      // 用它判重复投票会漏判。
      const info = sql.exec('SELECT changes() AS changes, last_insert_rowid() AS id').one();
      const changes = Number(info.changes) || 0;

      // 只有 INSERT 才需要回查自增 id
      const lastInsertRowid = /^\s*insert/i.test(query) ? Number(info.id) : null;

      return { changes, lastInsertRowid };
    },

    exec(query) {
      sql.exec(query).toArray();
    },

    transaction(fn) {
      return storage.transactionSync(fn);
    },

    close() {
      /* Durable Object 的存储由平台管理，没有需要手动关闭的句柄 */
    },

    /** 数据库当前占用字节数，后台仪表盘用得到 */
    get size() {
      return sql.databaseSize;
    },

    toBytes,
  };
}

module.exports = { create, toBytes };
