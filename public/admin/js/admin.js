'use strict';

/**
 * 后台公共库：登录守卫、CSRF、对话框、分页。
 * 依赖 /js/common.js 提供的 App。
 */

(function () {
  const Admin = {};

  let csrf = null;
  let ready = false;

  /* ============================ 接口 ============================ */

  /**
   * 调后台接口。path 是相对 /api/admin 的路径，例如 '/dashboard'。
   * 自动带 CSRF 头；遇到 401 自动跳登录页。
   */
  Admin.api = async function (path, opts) {
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
    if (csrf) init.headers['x-csrf-token'] = csrf;

    let res;
    try {
      res = await fetch('/api/admin' + path, init);
    } catch (e) {
      const err = new Error('连不上服务器');
      err.status = 0;
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* 非 JSON */
    }

    if (res.status === 401 && location.pathname !== '/admin/login') {
      location.replace('/admin/login');
      const err = new Error('登录已失效，正在跳转登录页');
      err.status = 401;
      throw err;
    }

    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || '请求失败（' + res.status + '）');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  Admin.getCsrf = () => csrf;

  /* ============================ 对话框 ============================ */

  function buildModal(children) {
    const box = App.el('div', { class: 'px-modal__box' }, children);
    const overlay = App.el('div', { class: 'px-modal' }, [box]);
    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * 确认框。
   * @returns {Promise<boolean>}
   */
  Admin.confirm = function (opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        overlay.remove();
        resolve(v);
      };

      const okBtn = App.el('button', {
        class: 'px-btn ' + (o.danger ? 'px-btn--danger' : 'px-btn--primary'),
        type: 'button',
        text: o.okText || '确定',
      });
      okBtn.addEventListener('click', function () {
        finish(true);
      });

      const cancelBtn = App.el('button', {
        class: 'px-btn px-btn--ghost',
        type: 'button',
        text: '取消',
      });
      cancelBtn.addEventListener('click', function () {
        finish(false);
      });

      const overlay = buildModal([
        App.el('div', { class: 'px-modal__title', text: o.title || '确认操作' }),
        App.el('p', { class: 'dim', text: o.text || '' }),
        o.detail ? App.el('div', { class: 'reject-box mt3', text: o.detail }) : null,
        App.el('div', { class: 'px-modal__actions' }, [cancelBtn, okBtn]),
      ]);

      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) finish(false);
      });
      document.addEventListener(
        'keydown',
        function onKey(ev) {
          if (ev.key === 'Escape') {
            document.removeEventListener('keydown', onKey);
            finish(false);
          }
        },
        { once: true }
      );
      okBtn.focus();
    });
  };

  /**
   * 输入框（用于填写拒绝理由等）。
   * @returns {Promise<string|null>} 取消返回 null
   */
  Admin.prompt = function (opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        overlay.remove();
        resolve(v);
      };

      const input = o.multiline
        ? App.el('textarea', { class: 'px-textarea', style: 'min-height:120px', maxlength: String(o.maxlength || 200), placeholder: o.placeholder || '' })
        : App.el('input', { class: 'px-input', type: 'text', maxlength: String(o.maxlength || 200), placeholder: o.placeholder || '' });

      const errBox = App.el('div', { class: 'fs1 mt1', style: 'color:var(--c-coral)' });

      const okBtn = App.el('button', { class: 'px-btn px-btn--primary', type: 'button', text: o.okText || '确定' });
      okBtn.addEventListener('click', function () {
        const v = input.value.trim();
        if (o.required && !v) {
          errBox.textContent = o.requiredMessage || '这一项不能为空';
          input.focus();
          return;
        }
        finish(v);
      });

      const cancelBtn = App.el('button', { class: 'px-btn px-btn--ghost', type: 'button', text: '取消' });
      cancelBtn.addEventListener('click', function () {
        finish(null);
      });

      const overlay = buildModal([
        App.el('div', { class: 'px-modal__title', text: o.title || '请输入' }),
        o.text ? App.el('p', { class: 'dim mb3', text: o.text }) : null,
        App.el('label', { class: 'px-label' }, [App.el('span', { text: o.label || '' }), input]),
        errBox,
        App.el('div', { class: 'px-modal__actions' }, [cancelBtn, okBtn]),
      ]);

      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) finish(null);
      });
      input.focus();
    });
  };

  /* ============================ 分页 ============================ */

  /**
   * 渲染分页。onGo(page) 由调用方处理。
   */
  Admin.pager = function (container, page, totalPages, total, onGo) {
    App.clear(container);

    if (totalPages > 1) {
      const nav = App.el('div', { class: 'row' });

      // target 为 null 表示当前页（不可点）
      const add = function (label, target, active) {
        const cls = 'px-btn px-btn--sm' + (active ? ' px-btn--gold' : '');
        if (target === null) {
          nav.appendChild(App.el('span', { class: cls, 'aria-disabled': 'true', text: label }));
          return;
        }
        const b = App.el('button', { class: cls, type: 'button', text: label });
        b.addEventListener('click', function () {
          onGo(target);
        });
        nav.appendChild(b);
      };

      add('上一页', page > 1 ? page - 1 : null, false);

      const nums = new Set([1, totalPages]);
      for (let p = page - 2; p <= page + 2; p += 1) {
        if (p >= 1 && p <= totalPages) nums.add(p);
      }
      const sorted = Array.from(nums).sort((a, b) => a - b);

      let prev = 0;
      for (const p of sorted) {
        if (prev && p - prev > 1) {
          nav.appendChild(App.el('span', { class: 'pager__info', text: '…' }));
        }
        add(String(p), p === page ? null : p, p === page);
        prev = p;
      }

      add('下一页', page < totalPages ? page + 1 : null, false);

      container.appendChild(nav);
    }

    container.appendChild(
      App.el('div', {
        class: 'pager__info',
        text: '共 ' + total + ' 条 · 第 ' + page + ' / ' + totalPages + ' 页',
      })
    );
  };

  /* ============================ 表格助手 ============================ */

  Admin.td = function (children, opts) {
    const o = opts || {};
    return App.el('td', {
      class: o.class || '',
      colspan: o.colspan || null,
      style: o.style || null,
    }, children);
  };

  Admin.emptyRow = function (colspan, title, text) {
    return App.el('tr', {}, [
      App.el('td', { colspan: String(colspan) }, [
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: title }),
          text ? App.el('div', { class: 'fs1 muted', text: text }) : null,
        ]),
      ]),
    ]);
  };

  /* ============================ 启动 ============================ */

  /**
   * 每个后台页面都从这里开始：校验登录 → 拿 CSRF → 绑退出 → 拉待审数 → onReady
   * @param {{onReady?: Function, requiresAuth?: boolean}} opts
   */
  Admin.boot = async function (opts) {
    const o = opts || {};
    const requiresAuth = o.requiresAuth !== false;

    let state;
    try {
      // 必须绕开缓存：登录状态被缓存下来的话，页面会在"以为已登录"和
      // "被服务端踢回登录页"之间来回跳。
      const res = await fetch('/api/admin/state?_=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      state = await res.json();
    } catch (e) {
      App.err('连不上服务器');
      return;
    }

    // 登录页自己处理初始化流程
    if (!requiresAuth) {
      if (o.onReady) o.onReady(state);
      return;
    }

    if (!state.initialized || !state.loggedIn) {
      location.replace('/admin/login');
      return;
    }

    let me;
    try {
      me = await Admin.api('/me');
    } catch (e) {
      return;
    }

    csrf = me.token;
    ready = true;

    const who = App.$('#whoami');
    if (who) {
      const parts = [];
      if (typeof me.pending === 'number') parts.push('待审核 ' + me.pending);
      who.textContent = parts.join(' · ');
    }

    const pendingBadge = App.$('#nav-pending');
    if (pendingBadge && typeof me.pending === 'number' && me.pending > 0) {
      pendingBadge.textContent = String(me.pending);
      pendingBadge.hidden = false;
    }

    const logoutBtn = App.$('#logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async function () {
        try {
          await Admin.api('/logout', { method: 'POST', body: {} });
        } catch (e) {
          /* 会话可能已经失效，照样跳走 */
        }
        location.replace('/admin/login');
      });
    }

    Admin.highlightNav();

    if (o.onReady) await o.onReady(me);
  };

  Admin.highlightNav = App.highlightNav;

  Admin.isReady = () => ready;

  window.Admin = Admin;
})();
