'use strict';

/**
 * 截图存储 · Node 版：文件写到磁盘的 uploads 目录。
 *
 * 对外接口（Workers 版必须实现同样的 4 个方法，见 worker/stores/do-blob.js）：
 *   put(name, bytes, contentType)  写入，同名覆盖
 *   remove(name)                   删除，不存在也不报错
 *   has(name)                      是否存在
 *   get(name) -> { bytes, contentType } | null
 *
 * name 只允许文件名，不接受路径——两个实现都按此约束防穿越。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function create(dir) {
  fs.mkdirSync(dir, { recursive: true });

  /** 只取文件名部分，杜绝 ../ 之类的穿越 */
  const abs = (name) => path.join(dir, path.basename(String(name)));

  return {
    put(name, bytes) {
      fs.writeFileSync(abs(name), bytes);
    },
    remove(name) {
      const p = abs(name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
    has(name) {
      return fs.existsSync(abs(name));
    },
    get(name) {
      const p = abs(name);
      if (!fs.existsSync(p)) return null;
      const ext = path.extname(p).slice(1).toLowerCase();
      return { bytes: fs.readFileSync(p), contentType: MIME_BY_EXT[ext] || 'application/octet-stream' };
    },
  };
}

module.exports = { create };
