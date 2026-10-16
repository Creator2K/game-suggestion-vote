'use strict';

/**
 * 玩家端公共库。
 * 挂到 window.App，所有页面共用。
 */

(function () {
  const App = {};

  /* ============================ DOM ============================ */

  App.$ = (sel, root) => (root || document).querySelector(sel);
  App.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /** 建元素：el('div', {class:'x'}, '文本' | [子元素]) */
  App.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  };

  App.clear = function (node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  /* ============================ 文本 ============================ */

  /** 一切用户内容都要过这里再进 innerHTML */
  App.esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /* ============================ 接口 ============================ */

  App.api = async function (path, opts) {
    const o = opts || {};
    const init = {
      method: o.method || 'GET',
      headers: {},
      credentials: 'same-origin',
    };
    if (o.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    if (o.csrf) init.headers['x-csrf-token'] = o.csrf;

    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      const err = new Error('连不上服务器，检查一下网络');
      err.status = 0;
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* 非 JSON */
    }

    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || '请求失败（' + res.status + '）');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  /* ============================ 时间 ============================ */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  App.fmtDate = function (ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  App.fmtDateTime = function (ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  };

  App.timeAgo = function (ts) {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    if (diff < 0) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const hour = Math.floor(min / 60);
    if (hour < 24) return hour + ' 小时前';
    const day = Math.floor(hour / 24);
    if (day < 30) return day + ' 天前';
    return App.fmtDate(ts);
  };

  /* ============================ 提示 ============================ */

  App.toast = function (message, type, ms) {
    const box = App.$('#toasts');
    if (!box) return;
    const kind = type === 'ok' || type === 'err' ? type : 'info';
    const node = App.el('div', { class: 'toast toast--' + kind, text: String(message) });
    box.appendChild(node);
    const life = ms || (kind === 'err' ? 5200 : 3400);
    setTimeout(function () {
      node.remove();
    }, life);
  };

  App.ok = (m) => App.toast(m, 'ok');
  App.err = (m) => App.toast(m, 'err');

  /* ============================ 状态 ============================ */

  App.STATUS_LABEL = {
    pending: '待审核',
    approved: '投票中',
    rejected: '已拒绝',
    done: '已实现',
  };

  App.statusBadge = function (status) {
    const label = App.STATUS_LABEL[status] || status;
    return '<span class="px-badge px-badge--' + App.esc(status) + '">' + App.esc(label) + '</span>';
  };

  App.catBadge = function (cat) {
    return '<span class="px-badge px-badge--cat">' + App.esc(cat) + '</span>';
  };

  /** 内容里不能有 HTML，统一转义后再插 */
  App.safe = function (s) {
    return App.esc(s).replace(/\n/g, '<br>');
  };

  /* ============================ 玩家身份 ============================ */

  const ME_KEY = 'pv_me';

  App.getMe = function () {
    try {
      const raw = localStorage.getItem(ME_KEY);
      if (!raw) return { email: '', nickname: '' };
      const obj = JSON.parse(raw);
      return {
        email: typeof obj.email === 'string' ? obj.email : '',
        nickname: typeof obj.nickname === 'string' ? obj.nickname : '',
      };
    } catch (e) {
      return { email: '', nickname: '' };
    }
  };

  App.setMe = function (email, nickname) {
    const current = App.getMe();
    const next = {
      email: email || current.email || '',
      nickname: nickname || current.nickname || '',
    };
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(next));
    } catch (e) {
      /* 隐私模式下写入会失败，忽略即可 */
    }
    return next;
  };

  App.clearMe = function () {
    try {
      localStorage.removeItem(ME_KEY);
    } catch (e) {
      /* 忽略 */
    }
  };

  /* ============================ 查询参数 ============================ */

  App.qs = function (name, fallback) {
    const v = new URLSearchParams(location.search).get(name);
    return v === null ? (fallback === undefined ? '' : fallback) : v;
  };

  /** 改地址栏参数但不刷新页面（用于分页、筛选） */
  App.setQs = function (updates, replace) {
    const url = new URL(location.href);
    for (const k of Object.keys(updates)) {
      const v = updates[k];
      if (v === null || v === undefined || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    history[replace === false ? 'pushState' : 'replaceState']({}, '', url);
  };

  /* ============================ 数字跳动 ============================ */

  /** 用有限帧数跳到位，不要平滑缓动——像素风不兴那个 */
  App.countUp = function (node, to, frames) {
    const total = Number(to) || 0;
    if (!node) return;
    const steps = frames || 12;
    let i = 0;
    node.textContent = '0';
    const timer = setInterval(function () {
      i += 1;
      if (i >= steps) {
        node.textContent = total.toLocaleString('zh-CN');
        clearInterval(timer);
        return;
      }
      const v = Math.round((total * i) / steps);
      node.textContent = v.toLocaleString('zh-CN');
    }, 34);
  };

  /* ============================ 顶栏高亮 ============================ */

  function normalize(p) {
    let v = String(p || '/').split('?')[0];
    if (v.length > 1) v = v.replace(/\/+$/, '');
    return v || '/';
  }

  App.highlightNav = function () {
    const here = normalize(location.pathname);
    App.$$('[data-nav]').forEach(function (a) {
      const target = normalize(a.getAttribute('href'));
      if (target === here) a.classList.add('is-active');
      else a.classList.remove('is-active');
    });
  };

  /* ============================ 分页渲染 ============================ */

  /** 生成「上一页 / 页码 / 下一页」，返回 HTML 字符串 */
  App.pager = function (page, totalPages, makeHref) {
    if (totalPages <= 1) return '';
    const href = makeHref || ((p) => '?page=' + p);
    const parts = [];

    parts.push(
      page > 1
        ? '<a class="px-btn px-btn--sm" href="' + App.esc(href(page - 1)) + '">上一页</a>'
        : '<span class="px-btn px-btn--sm" aria-disabled="true">上一页</span>'
    );

    const nums = [];
    const push = (p) => nums.push(p);
    push(1);
    for (let p = page - 2; p <= page + 2; p += 1) {
      if (p > 1 && p < totalPages) push(p);
    }
    if (totalPages > 1) push(totalPages);

    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    let prev = 0;
    for (const p of uniq) {
      if (prev && p - prev > 1) parts.push('<span class="pager__info">…</span>');
      parts.push(
        p === page
          ? '<span class="px-btn px-btn--sm px-btn--gold" aria-current="page">' + p + '</span>'
          : '<a class="px-btn px-btn--sm" href="' + App.esc(href(p)) + '">' + p + '</a>'
      );
      prev = p;
    }

    parts.push(
      page < totalPages
        ? '<a class="px-btn px-btn--sm" href="' + App.esc(href(page + 1)) + '">下一页</a>'
        : '<span class="px-btn px-btn--sm" aria-disabled="true">下一页</span>'
    );

    return parts.join('');
  };

  /* ============================ 投票按钮 ============================ */

  /**
   * 投票。需要邮箱；新邮箱要补昵称。
   * 返回 { voteCount, voted }，失败会抛错（err.data 里带 needNickname / nicknameTaken）
   */
  App.vote = async function (suggestionId, email, nickname) {
    const body = { suggestionId: suggestionId, email: email };
    if (nickname) body.nickname = nickname;
    return App.api('/api/vote', { method: 'POST', body: body });
  };

  /* ============================ 启动 ============================ */

  document.addEventListener('DOMContentLoaded', function () {
    App.highlightNav();
  });

  window.App = App;
})();
