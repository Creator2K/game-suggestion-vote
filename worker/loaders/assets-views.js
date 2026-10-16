'use strict';

/**
 * 模板 loader · Workers 版：从 Static Assets 绑定读 public/ 下的 HTML。
 *
 * 模板仍然放在 public/（跟 Node 版同一份文件，不用搬家）：
 * 这个 fetch 打在绑定上，不走网络、不算请求数，只在 isolate 内读一次。
 * 部署之后模板内容不会变，所以进程内缓存不需要失效逻辑。
 *
 * 找不到时抛出的错误带 code === 'ENOENT'，页面路由靠它区分「没这个页面」。
 */

function create(assets) {
  const cache = new Map();

  return async function load(relPath) {
    const key = String(relPath);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const res = await assets.fetch(new Request(`https://assets.internal/${key}`));
    if (!res.ok) {
      const err = new Error(`模板不存在：${key}`);
      err.code = 'ENOENT';
      throw err;
    }

    const text = await res.text();
    cache.set(key, text);
    return text;
  };
}

module.exports = { create };
