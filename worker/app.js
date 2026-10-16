'use strict';

/**
 * Workers 侧的应用装配。
 *
 * 与 src/app.js 是同一套东西，差别只在：
 *   - 没有常驻进程与磁盘：静态资源交给 Static Assets 绑定，截图从 DO 里取
 *   - 路由容器用 worker/mini-router.js 而不是 Express
 *   - 页面模板由 template.setLoader() 注入的 loader 提供
 *
 * 业务路由（src/routes/*）与中间件（src/middleware/*）在这里被原样挂上，
 * 与 Node 版共用同一份代码。
 */

const runtime = require('../src/runtime');
const template = require('../src/template');
const adminAuth = require('../src/middleware/admin');
const mountPublicApi = require('../src/routes/public');
const mountAdminApi = require('../src/routes/admin');
const { createRouter, runLayers, createRequest, createResponse } = require('./mini-router');

const JSON_LIMIT_ADMIN = 8 * 1024 * 1024;
const JSON_LIMIT_PUBLIC = 64 * 1024;

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */

/** 安全响应头，与 Node 版逐条一致 */
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  // 接口响应一律不许缓存。否则浏览器会把「已登录」的状态存下来，
  // 之后页面就在「以为已登录」和「被服务端踢回登录页」之间来回跳。
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

/** 解析 JSON 请求体，等价于 express.json({ limit })，但要在 Workers 里自己读流 */
function jsonBody(limitBytes) {
  return async (req, res, next) => {
    if (req._jsonParsed) return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const ct = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return next();
    req._jsonParsed = true;

    const declared = Number(req.get('content-length') || 0);
    if (declared && declared > limitBytes) {
      return res.status(413).json({ ok: false, error: '请求体太大了' });
    }

    let text = '';
    try {
      text = await req.raw.text();
    } catch {
      return next();
    }
    if (text.length > limitBytes) {
      return res.status(413).json({ ok: false, error: '请求体太大了' });
    }
    if (!text) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(text);
    } catch {
      return res.status(400).json({ ok: false, error: '请求体不是合法的 JSON' });
    }
    return next();
  };
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

const PLAYER_PAGES = {
  '/': ['index.html', { active: 'home' }],
  '/submit': ['submit.html', { active: 'submit' }],
  '/vote': ['vote.html', { active: 'vote' }],
  '/done': ['done.html', { active: 'done' }],
  '/mine': ['mine.html', { active: 'mine' }],
};

const ADMIN_PAGES = {
  '/admin': ['admin/index.html', { active: 'dash', pageTitle: '仪表盘' }],
  '/admin/login': ['admin/login.html', { active: '', pageTitle: '登录' }],
  '/admin/review': ['admin/review.html', { active: 'review', pageTitle: '待审核' }],
  '/admin/suggestions': ['admin/suggestions.html', { active: 'suggestions', pageTitle: '建议管理' }],
  '/admin/completed': ['admin/completed.html', { active: 'completed', pageTitle: '已完成' }],
  '/admin/votes': ['admin/votes.html', { active: 'votes', pageTitle: '投票明细' }],
  '/admin/players': ['admin/players.html', { active: 'players', pageTitle: '玩家管理' }],
  '/admin/bans': ['admin/bans.html', { active: 'bans', pageTitle: '封禁名单' }],
  '/admin/settings': ['admin/settings.html', { active: 'settings', pageTitle: '站点设置' }],
  '/admin/logs': ['admin/logs.html', { active: 'logs', pageTitle: '操作日志' }],
};

function page(relPath, extra) {
  return async (req, res, next) => {
    try {
      const html = await template.render(relPath, extra);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (err) {
      if (err.code === 'ENOENT') return next();
      return next(err);
    }
  };
}

/**
 * 后台页面：除登录页外，没有有效会话的直接 302 到登录页。
 * 只靠前端守卫的话，任何人打开 /admin 都能看到后台的页面骨架。
 */
function adminPage(relPath, extra) {
  const render = page(relPath, extra);
  return (req, res, next) => {
    if (relPath === 'admin/login.html') return render(req, res, next);
    if (!req.admin) return res.redirect('/admin/login');
    return render(req, res, next);
  };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

function createApp(env) {
  const router = createRouter();

  router.use(securityHeaders);
  router.use(adminAuth.attachAdmin);

  // 后台允许传 base64 图片，所以后台的限额更大；两条前缀会同时命中 /api/admin，
  // 靠 req._jsonParsed 保证只解析一次
  router.use('/api/admin', jsonBody(JSON_LIMIT_ADMIN));
  router.use('/api', jsonBody(JSON_LIMIT_PUBLIC));

  for (const [route, [file, extra]] of Object.entries(PLAYER_PAGES)) {
    router.get(route, page(file, extra));
  }
  for (const [route, [file, extra]] of Object.entries(ADMIN_PAGES)) {
    router.get(route, adminPage(file, extra));
  }

  router.get('/healthz', (req, res) => {
    res.json({ ok: true, runtime: 'cloudflare-workers' });
  });

  /** 截图：存在 DO 的 SQLite 里，这里取出来直接吐二进制 */
  router.get('/uploads/:name', (req, res) => {
    const name = String(req.params.name);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    const file = runtime.screenshots().get(name);
    if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });

    res.set('Content-Type', file.contentType);
    res.set('Cache-Control', 'public, max-age=604800');
    return res.send(file.bytes);
  });

  const publicApi = createRouter();
  mountPublicApi(publicApi);
  router.use('/api', publicApi);

  const adminApi = createRouter();
  mountAdminApi(adminApi);
  router.use('/api/admin', adminApi);

  // 兜底：接口给 JSON，其余给一个极简 404 页面（与 Node 版一致）
  router.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: '接口不存在' });
    }
    return res
      .status(404)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>404</title>' +
          '<body style="font-family:monospace;padding:40px;background:#1b1a26;color:#e8e4d8">' +
          '<h1>404</h1><p>这个页面不存在。</p><p><a href="/" style="color:#8fd4a8">回首页</a></p>'
      );
  });

  // 错误处理：4 参数即错误中间件，与 Express 同签名
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[错误]', req.method, req.originalUrl, err && err.stack);
    if (res.finished) return;
    res.status(status).json({
      ok: false,
      error: status >= 500 ? '服务器出错了，请稍后再试' : err.message || '请求有误',
    });
  });

  const flat = router.build();

  /**
   * 返回 Response；没被任何路由命中时返回 null，交给外层决定（静态资源）。
   */
  async function handle(request) {
    const url = new URL(request.url);
    const req = createRequest(request, url, {});

    const res = createResponse();
    const err = await runLayers(flat, req, res);

    if (!res.finished) {
      if (err) throw err;
      return null;
    }

    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  }

  return { handle, router };
}

module.exports = { createApp };
