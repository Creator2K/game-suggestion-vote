'use strict';

/**
 * 截图存储 · Workers 版：图片直接存进 Durable Object 的 SQLite。
 *
 * 为什么不放 R2：R2 要单独开通，而这个站最多 8 张 2MB 的首页截图，
 * 放进 DO 里既省一个服务，也省一套权限配置。
 *
 * 接口与 src/stores/fs.js 完全一致，所以 src/routes/admin.js 两边共用。
 */

const { toBytes } = require('../engines/do-sql');

const DDL = `
CREATE TABLE IF NOT EXISTS files (
  name         TEXT PRIMARY KEY,
  content_type TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
`;

function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

function create(db) {
  db.exec(DDL);

  return {
    put(name, bytes, contentType) {
      const buf = asBytes(bytes);
      db.run(
        `INSERT INTO files (name, content_type, bytes, size, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           content_type = excluded.content_type,
           bytes        = excluded.bytes,
           size         = excluded.size`,
        String(name),
        contentType || 'application/octet-stream',
        buf,
        buf.length,
        Date.now()
      );
    },

    remove(name) {
      db.run('DELETE FROM files WHERE name = ?', String(name));
    },

    has(name) {
      return !!db.get('SELECT 1 AS x FROM files WHERE name = ?', String(name));
    },

    get(name) {
      const row = db.get('SELECT bytes, content_type FROM files WHERE name = ?', String(name));
      if (!row) return null;
      return { bytes: toBytes(row.bytes), contentType: row.content_type };
    },
  };
}

module.exports = { create, DDL };
