'use strict';

/**
 * 极简服务端模板：把 HTML 里的 {{token}} 替换成站点配置。
 *
 * 为什么不用前端拉接口填文案？——那样首页会先闪一下默认文字再变。
 * 这里在吐 HTML 时就把游戏名、宣传语注入进去，首屏直接是对的。
 *
 * 安全：所有注入值都经过 HTML 转义。
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const { escapeHtml } = require('./util');

/** 文件内容缓存，附带 mtime 以便开发时自动失效 */
const cache = new Map();

function readTemplate(absPath) {
  const stat = fs.statSync(absPath);
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.text;
  const text = fs.readFileSync(absPath, 'utf8');
  cache.set(absPath, { mtimeMs: stat.mtimeMs, text });
  return text;
}

function readPartial(name) {
  // 只允许简单的名字，防止路径穿越
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return '';
  const abs = path.join(config.PUBLIC_DIR, 'partials', `${name}.html`);
  try {
    return readTemplate(abs);
  } catch {
    return `<!-- 缺少局部模板 partials/${name}.html -->`;
  }
}

/**
 * 渲染 public 目录下的一个 HTML 模板。
 * 支持两种语法：
 *   {{> partialName}}  嵌入 public/partials/partialName.html（可嵌套）
 *   {{variable}}       注入配置变量（自动 HTML 转义）
 *
 * @param {string} relPath 相对 public 的路径，如 'index.html'
 * @param {Record<string, unknown>} extra 额外注入的变量（会覆盖配置同名项）
 */
function render(relPath, extra = {}) {
  const abs = path.join(config.PUBLIC_DIR, relPath);
  let html = readTemplate(abs);

  // 先把局部模板展开（多跑几轮，允许 partial 里再嵌 partial）
  for (let i = 0; i < 5 && html.includes('{{>'); i += 1) {
    const before = html;
    html = html.replace(/\{\{>\s*([A-Za-z0-9_-]+)\s*\}\}/g, (m, name) => readPartial(name));
    if (html === before) break;
  }

  const cfg = db.publicConfig();
  const vars = {
    gameName: cfg.gameName,
    siteTitle: cfg.siteTitle,
    tagline: cfg.tagline,
    heroSub: cfg.heroSub,
    announcement: cfg.announcement,
    footerText: cfg.footerText,
    year: new Date().getFullYear(),
    categoriesJson: JSON.stringify(cfg.categories),
    screenshotsJson: JSON.stringify(cfg.screenshots),
    submitOpen: cfg.submitOpen ? '1' : '0',
    voteOpen: cfg.voteOpen ? '1' : '0',
    maxTitleLen: String(cfg.maxTitleLen),
    maxBodyLen: String(cfg.maxBodyLen),
    voteRankMode: cfg.voteRankMode,
    active: '',
    pageTitle: '',
    ...extra,
  };

  html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) return match;
    const value = vars[key];
    return escapeHtml(value == null ? '' : String(value));
  });

  return html;
}

/** 开发模式下清缓存，便于改模板立即生效 */
function clearCache() {
  cache.clear();
}

module.exports = { render, clearCache };
