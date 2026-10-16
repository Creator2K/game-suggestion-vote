'use strict';

/**
 * 应用入口：组装中间件、路由、页面。
 *
 * 启动：node src/app.js  或  npm start
 */

const path = require('node:path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const template = require('./template');
const adminAuth = require('./middleware/admin');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const backup = require('./backup');

/* ------------------------------ 初始化数据 ------------------------------ */

require('./node-boot').boot();

/* ------------------------------ Express ------------------------------ */

const app = express();
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', true);

/* 安全响应头 */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 注意：script-src 不含 unsafe-inline，所以页面里不能写内联 <script>，
  // 也不能用 onclick="" 之类的内联事件。所有脚本都放在外部 .js 文件里。
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
});

/* 后台会话解析（只读，不拦截） */
app.use(adminAuth.attachAdmin);

/* JSON 请求体：后台允许传 base64 图片，所以后台的限额更大 */
app.use('/api/admin', express.json({ limit: '8mb' }));
app.use('/api', express.json({ limit: '64kb' }));

/* ------------------------------ 静态资源 ------------------------------ */

/** 模板文件本身就放在 public/ 里，别让人把 {{占位符}} 直接抓走。Workers 入口拦得一样 */
app.use((req, res, next) => {
  if (!/\.html?$/i.test(req.path)) return next();
  return res
    .status(404)
    .type('html')
    .send('<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>');
});

const staticOpts = {
  index: false,
  // 目录不带斜杠时不要 301，直接交给页面路由，省一次跳转
  redirect: false,
  etag: true,
  maxAge: config.NODE_ENV === 'production' ? '7d' : 0,
};
app.use(express.static(config.PUBLIC_DIR, staticOpts));
app.use('/uploads', express.static(config.UPLOAD_DIR, { maxAge: '7d', index: false }));

/* ------------------------------ 页面路由 ------------------------------ */

/** 渲染 HTML：即时注入站点配置，首屏文案不会闪 */
function page(relPath, extra = {}) {
  return async (req, res, next) => {
    try {
      const html = await template.render(relPath, extra);
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (err) {
      if (err.code === 'ENOENT') return next();
      next(err);
    }
  };
}

const PLAYER_PAGES = {
  '/': ['index.html', { active: 'home' }],
  '/submit': ['submit.html', { active: 'submit' }],
  '/vote': ['vote.html', { active: 'vote' }],
  '/done': ['done.html', { active: 'done' }],
  '/mine': ['mine.html', { active: 'mine' }],
};

for (const [route, [file, extra]] of Object.entries(PLAYER_PAGES)) {
  app.get(route, page(file, extra));
}

/**
 * 后台页面：除登录页外，没有有效会话的直接 302 到登录页。
 * 只靠前端守卫的话，任何人打开 /admin 都能看到后台的页面骨架。
 */
function adminPage(relPath, extra = {}) {
  const render = page(relPath, extra);
  return (req, res, next) => {
    if (relPath === 'admin/login.html') return render(req, res, next);
    if (!req.admin) return res.redirect('/admin/login');
    return render(req, res, next);
  };
}

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

for (const [route, [file, extra]] of Object.entries(ADMIN_PAGES)) {
  app.get(route, adminPage(file, extra));
}

/* ------------------------------ 接口 ------------------------------ */

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round((Date.now() - config.STARTED_AT) / 1000),
    version: require('../package.json').version,
  });
});

/** 路由模块导出的是挂载函数，两个运行时各传各的 router 实现 */
const publicApi = express.Router();
publicRoutes(publicApi);
app.use('/api', publicApi);

const adminApi = express.Router();
adminRoutes(adminApi);
app.use('/api/admin', adminApi);

/* ------------------------------ 兜底 ------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: '接口不存在' });
  }
  return res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
      '<body style="font-family:monospace;padding:40px;background:#1b1a26;color:#e8e4d8">' +
      '<h1>404</h1><p>这个页面不存在。</p><p><a href="/" style="color:#8fd4a8">回首页</a></p>'
  );
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[错误]', req.method, req.originalUrl, err);
  }
  if (res.headersSent) return;
  res.status(status).json({
    ok: false,
    error: status >= 500 ? '服务器出错了，请稍后再试' : err.message || '请求有误',
  });
});

/* ------------------------------ 启动 ------------------------------ */

const server = app.listen(config.PORT, config.HOST, () => {
  const shown = config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST;
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │   像素游戏 · 建议投票系统 已启动              │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log('');
  console.log(`   玩家端   http://${shown}:${config.PORT}/`);
  console.log(`   投票榜   http://${shown}:${config.PORT}/vote`);
  console.log(`   后台     http://${shown}:${config.PORT}/admin`);
  console.log('');
  console.log(`   数据目录 ${config.DATA_DIR}`);

  if (!db.getSetting('admin_password_hash', '')) {
    console.log('');
    console.log('   ⚠  后台还没设置管理员密码');
    console.log(`      打开 http://${shown}:${config.PORT}/admin 按提示设置`);
  }
  console.log('');

  backup.startScheduler();

  // 每天顺手清理一次过期会话和限频事件
  const cleanupTimer = setInterval(() => {
    try {
      db.cleanup();
    } catch (err) {
      console.error('[清理] 失败：', err.message);
    }
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref?.();
});

/* 优雅退出：确保 WAL 落盘 */
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // 兜底：5 秒还没关完就强退
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
