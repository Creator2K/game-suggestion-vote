'use strict';

/**
 * 极简服务端模板：把 HTML 里的 {{token}} 替换成站点配置。
 *
 * 为什么不用前端拉接口填文案？——那样首页会先闪一下默认文字再变。
 * 这里在吐 HTML 时就把游戏名、宣传语注入进去，首屏直接是对的。
 *
 * 安全：所有注入值都经过 HTML 转义。
 *
 * 模板从哪来由 loader 决定（见 setLoader）：
 *   Node    → src/loaders/fs-views.js，读 public/ 目录，带 mtime 自动失效
 *   Workers → worker/loaders/assets-views.js，从 Static Assets 绑定读，进程内缓存
 * 因此本层不引用任何文件系统 API。
 */

const db = require('./db');
const { escapeHtml } = require('./util');

/** async (relPath: string) => Promise<string>，找不到就抛错 */
let loader = null;

function setLoader(fn) {
  if (typeof fn !== 'function') throw new Error('模板 loader 必须是函数');
  loader = fn;
}

async function readPartial(name) {
  // 只允许简单的名字，防止路径穿越
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return '';
  try {
    return await loader(`partials/${name}.html`);
  } catch {
    return `<!-- 缺少局部模板 partials/${name}.html -->`;
  }
}

/** 展开 {{> partialName}}，允许多层嵌套 */
async function expandPartials(html) {
  const re = /\{\{>\s*([A-Za-z0-9_-]+)\s*\}\}/g;

  for (let round = 0; round < 5; round += 1) {
    const matches = [...html.matchAll(re)];
    if (matches.length === 0) break;

    const parts = await Promise.all(matches.map((m) => readPartial(m[1])));
    let out = '';
    let cursor = 0;
    matches.forEach((m, i) => {
      out += html.slice(cursor, m.index) + parts[i];
      cursor = m.index + m[0].length;
    });
    out += html.slice(cursor);

    if (out === html) break;
    html = out;
  }
  return html;
}

/**
 * 渲染一个 HTML 模板。
 * 支持两种语法：
 *   {{> partialName}}  嵌入 partials/partialName.html（可嵌套）
 *   {{variable}}       注入配置变量（自动 HTML 转义）
 *
 * @param {string} relPath 模板相对路径，如 'index.html'、'admin/login.html'
 * @param {Record<string, unknown>} extra 额外注入的变量（会覆盖配置同名项）
 */
async function render(relPath, extra = {}) {
  if (!loader) throw new Error('模板 loader 未初始化：请先调用 template.setLoader()');

  let html = await loader(relPath);
  html = await expandPartials(html);

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

module.exports = { render, setLoader };
