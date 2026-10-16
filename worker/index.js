import { Board } from './board.js';

export { Board };

/**
 * Worker 入口。
 *
 * 这里刻意保持很薄：所有动态请求都转给那个唯一的 Durable Object，
 * 静态资源交给 Static Assets 绑定。业务代码一行都不在这一层。
 */

/** 需要走应用（动态渲染 / 接口 / 截图）的路径，其余一律当静态资源 */
const APP_PATHS = new Set([
  '/',
  '/submit',
  '/vote',
  '/done',
  '/mine',
  '/healthz',
]);

function isAppPath(pathname) {
  if (pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/uploads/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  return APP_PATHS.has(pathname);
}

function notFound() {
  return new Response('<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>', {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 模板文件本身就放在 public/ 里，别让人直接把 {{占位符}} 抓走
    if (/\.html?$/i.test(url.pathname)) return notFound();

    if (isAppPath(url.pathname)) {
      return env.BOARD.get(env.BOARD.idFromName('board')).fetch(request);
    }

    const asset = await env.ASSETS.fetch(request);
    return asset;
  },

  /** 定时任务：原来的 setInterval 清理，改由 Cron Trigger 驱动 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.BOARD.get(env.BOARD.idFromName('board')).runCleanup());
  },
};
