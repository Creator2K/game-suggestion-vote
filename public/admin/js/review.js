'use strict';

/** 待审核队列 */

(function () {
  const listBox = App.$('#list');
  const pagerBox = App.$('#pager');
  const countBadge = App.$('#pending-count');
  const fullBody = App.$('#full-body');

  let page = 1;
  let items = [];
  let focusIndex = 0;

  /* ============================ 渲染 ============================ */

  function render() {
    App.clear(listBox);

    if (!items.length) {
      listBox.appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '没有待审核的建议' }),
          App.el('div', { class: 'fs1 muted', text: '队列清空了。新提交的建议会自动出现在这里。' }),
          App.el('div', { class: 'mt4' }, [
            App.el('a', { class: 'px-btn', href: '/admin/suggestions', text: '去看全部建议' }),
          ]),
        ])
      );
      return;
    }

    items.forEach(function (item, i) {
      listBox.appendChild(buildItem(item, i));
    });
  }

  function buildItem(item, index) {
    const longBody = item.body.length > 160;

    const meta = App.el('div', { class: 'px-card__meta' }, [
      App.el('span', { html: App.catBadge(item.category) }),
      App.el('span', { class: 'px-badge px-badge--muted', text: '#' + item.id }),
      App.el('span', { text: item.author }),
      App.el('span', { class: 'cell-mono', text: item.authorEmail }),
      App.el('span', { text: App.fmtDateTime(item.createdAt) + '（' + App.timeAgo(item.createdAt) + '）' }),
    ]);

    const body = App.el('p', {
      class: 'px-card__body mt2' + (longBody && !fullBody.checked ? ' clamp-3' : ''),
      text: item.body,
    });

    const approveBtn = App.el('button', { class: 'px-btn px-btn--primary', type: 'button', text: '通过（A）' });
    approveBtn.addEventListener('click', function () {
      doApprove(item);
    });

    const rejectBtn = App.el('button', { class: 'px-btn px-btn--danger', type: 'button', text: '拒绝（R）' });
    rejectBtn.addEventListener('click', function () {
      doReject(item);
    });

    const editBtn = App.el('button', { class: 'px-btn', type: 'button', text: '编辑（E）' });
    editBtn.addEventListener('click', function () {
      doEdit(item);
    });

    const delBtn = App.el('button', { class: 'px-btn px-btn--ghost px-btn--sm', type: 'button', text: '删除' });
    delBtn.addEventListener('click', function () {
      doDelete(item);
    });

    return App.el('article', { class: 'px-panel', id: 's-' + item.id, tabindex: '-1' }, [
      App.el('div', { class: 'row row--between mb2' }, [
        App.el('h2', { class: 'px-card__title', text: item.title }),
        App.el('span', { class: 'fs1 muted nowrap', text: '第 ' + (index + 1) + ' / ' + items.length + ' 条' }),
      ]),
      meta,
      body,
      App.el('div', { class: 'row row--wrap mt3' }, [
        approveBtn,
        rejectBtn,
        editBtn,
        App.el('div', { class: 'spacer' }),
        delBtn,
      ]),
    ]);
  }

  /* ============================ 动作 ============================ */

  function removeFromList(id) {
    items = items.filter(function (x) {
      return x.id !== id;
    });
  }

  async function doApprove(item) {
    try {
      await Admin.api('/suggestions/' + item.id + '/approve', { method: 'POST', body: {} });
      App.ok('已通过：「' + item.title + '」现在出现在投票榜上了');
      removeFromList(item.id);
      refreshCount();
      render();
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function doReject(item) {
    const reason = await Admin.prompt({
      title: '拒绝「' + item.title + '」',
      text: '理由会原样展示给提交者，在「查我的建议」里能看到。写清楚原因，别让人猜。',
      label: '拒绝理由',
      placeholder: '例如：属于重复建议，已有 #12 在投票',
      required: true,
      requiredMessage: '必须填写理由，玩家会看到',
      maxlength: 200,
      multiline: true,
      okText: '确认拒绝',
    });
    if (reason === null) return;

    try {
      await Admin.api('/suggestions/' + item.id + '/reject', {
        method: 'POST',
        body: { reason: reason },
      });
      App.ok('已拒绝，理由已记录');
      removeFromList(item.id);
      refreshCount();
      render();
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function doEdit(item) {
    const title = await Admin.prompt({
      title: '编辑标题',
      label: '标题',
      required: true,
      maxlength: 60,
      okText: '下一步',
    });
    if (title === null) return;

    const body = await Admin.prompt({
      title: '编辑正文',
      label: '正文',
      required: true,
      maxlength: 500,
      multiline: true,
      okText: '保存',
    });
    if (body === null) return;

    try {
      const r = await Admin.api('/suggestions/' + item.id, {
        method: 'PATCH',
        body: { title: title, body: body },
      });
      item.title = r.item.title;
      item.body = r.item.body;
      App.ok('已保存修改');
      render();
    } catch (err) {
      App.err(err.message);
    }
  }

  async function doDelete(item) {
    const yes = await Admin.confirm({
      title: '删除这条建议？',
      text: '「' + item.title + '」',
      detail: '这是软删除，建议不会真的从数据库消失，可以在「建议管理」里筛选「已删除」恢复。',
      okText: '删除',
      danger: true,
    });
    if (!yes) return;

    try {
      await Admin.api('/suggestions/' + item.id, { method: 'DELETE', body: {} });
      App.ok('已删除');
      removeFromList(item.id);
      refreshCount();
      render();
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 加载 ============================ */

  async function refreshCount() {
    try {
      const r = await Admin.api('/suggestions?status=pending&pageSize=1');
      countBadge.textContent = r.total;
      const nav = App.$('#nav-pending');
      if (nav) {
        if (r.total > 0) {
          nav.textContent = String(r.total);
          nav.hidden = false;
        } else {
          nav.hidden = true;
        }
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  async function load(keepPage) {
    if (!keepPage) page = 1;
    App.clear(listBox).appendChild(App.el('div', { class: 'skeleton', style: 'height:200px' }));

    try {
      const data = await Admin.api(
        '/suggestions?status=pending&sort=oldest&page=' + page + '&pageSize=10'
      );
      items = data.items;
      page = data.page;
      countBadge.textContent = data.counts.pending;
      focusIndex = 0;
      render();
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (p) {
        page = p;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
      App.clear(listBox).appendChild(
        App.el('div', { class: 'px-empty' }, [App.el('div', { text: err.message })])
      );
    }
  }

  /* ============================ 事件 ============================ */

  fullBody.addEventListener('change', render);
  App.$('#refresh').addEventListener('click', function () {
    load(true);
    App.ok('已刷新');
  });

  // 快捷键：只在没有输入焦点时生效，避免打字时误触
  document.addEventListener('keydown', function (ev) {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (App.$('.px-modal')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!items.length) return;

    const item = items[Math.min(focusIndex, items.length - 1)];
    if (!item) return;

    const key = ev.key.toLowerCase();
    if (key === 'a') {
      ev.preventDefault();
      doApprove(item);
    } else if (key === 'r') {
      ev.preventDefault();
      doReject(item);
    } else if (key === 'e') {
      ev.preventDefault();
      doEdit(item);
    } else if (key === 'j' || key === 'arrowdown') {
      ev.preventDefault();
      focusIndex = Math.min(focusIndex + 1, items.length - 1);
      scrollToFocus();
    } else if (key === 'k' || key === 'arrowup') {
      ev.preventDefault();
      focusIndex = Math.max(focusIndex - 1, 0);
      scrollToFocus();
    }
  });

  function scrollToFocus() {
    const item = items[focusIndex];
    if (!item) return;
    const node = App.$('#s-' + item.id);
    if (!node) return;
    node.scrollIntoView({ block: 'center' });
    App.$$('.px-panel', listBox).forEach(function (p) {
      p.style.outline = '';
    });
    node.style.outline = 'var(--bd) solid var(--c-gold)';
  }

  /* ============================ 启动 ============================ */

  // 从仪表盘跳过来可能带 #s-<id>
  Admin.boot({
    onReady: async function () {
      await load();
      if (location.hash && /^#s-\d+$/.test(location.hash)) {
        const node = App.$(location.hash);
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.style.outline = 'var(--bd) solid var(--c-gold)';
        }
      }
    },
  });
})();
