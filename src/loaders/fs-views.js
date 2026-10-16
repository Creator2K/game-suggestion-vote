'use strict';

/**
 * 模板 loader · Node 版：从 public/ 目录读 HTML。
 *
 * 带 mtime 缓存，开发时改了模板刷新浏览器就能看到，不用重启。
 * 找不到文件时抛出的错误带 code === 'ENOENT'，页面路由靠它区分「没这个页面」。
 */

const fs = require('node:fs');
const path = require('node:path');

function create(dir) {
  const cache = new Map();

  return async function load(relPath) {
    const abs = path.join(dir, relPath);
    const stat = fs.statSync(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;

    const text = fs.readFileSync(abs, 'utf8');
    cache.set(abs, { mtimeMs: stat.mtimeMs, text });
    return text;
  };
}

module.exports = { create };
