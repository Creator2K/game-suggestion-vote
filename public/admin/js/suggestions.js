'use strict';

/** 建议管理：全量筛选 + 详情弹窗 + 所有状态操作 */

(function () {
  const rowsBox = App.$('#rows');
  const pagerBox = App.$('#pager');
  const tabsBox = App.$('#status-tabs');
  const qInput = App.$('#q');
  const catSel = App.$('#category');
  const sortSel = App.$('#sort');

  const STATUS_TABS = [
    { key: 'pending', label: '待审核' },
    { key: 'approved', label: '投票中' },
    { key: 'done', label: '已实现' },
    { key: 'rejected', label: '已拒绝' },
    { key: 'deleted', label: '已删除' },
    { key: 'all', label: '全部' },
  ];

  /** AI 标记的中文名，对应 src/ai/review.js 里的 flag */
  const AI_FLAG_LABEL = {
    duplicate: '疑似重复',
    junk: '无意义内容',
    ad: '广告引流',
    bot: '疑似机器人',
  };

  const state = {
    status: App.qs('status', 'pending') || 'pending',
    q: App.qs('q', ''),
    category: App.qs('category', ''),
    sort: App.qs('sort', 'newest') || 'newest',
    page: 1,
    totalPages: 1,
    total: 0,
    counts: {},
    items: [],
    categories: [],
  };

  /* ============================ 筛选控件 ============================ */

  function renderTabs() {
    App.clear(tabsBox);
    STATUS_TABS.forEach(function (t) {
      const n = state.counts[t.key];
      const label = t.label + (n !== undefined ? '（' + n + '）' : '');
      const el = App.el('span', {
        class: 'tab' + (state.status === t.key ? ' is-active' : ''),
        text: label,
      });
      el.addEventListener('click', function () {
        state.status = t.key;
        state.page = 1;
        syncQs();
        load();
      });
      tabsBox.appendChild(el);
    });
  }

  function renderCategories() {
    App.clear(catSel);
    catSel.appendChild(App.el('option', { value: '', text: '全部分类' }));
    state.categories.forEach(function (c) {
      catSel.appendChild(
        App.el('option', { value: c, text: c, selected: state.category === c ? 'selected' : null })
      );
    });
  }

  function syncQs() {
    App.setQs({
      status: state.status,
      q: state.q,
      category: state.category,
      sort: state.sort,
      page: '',
    });
  }

  /* ============================ 表格 ============================ */

  const COLS = 8;

  function renderRows() {
    App.clear(rowsBox);

    if (!state.items.length) {
      rowsBox.appendChild(Admin.emptyRow(COLS, '没有匹配的建议', '换个筛选条件试试。'));
      return;
    }

    state.items.forEach(function (item) {
      const titleCell = App.el('td', {}, [
        App.el('a', { class: 'cell-title', href: '#', text: item.title }),
        item.deletedAt ? App.el('span', { class: 'cell-sub', text: '已删除 · ' + App.fmtDate(item.deletedAt) }) : null,
        item.editedAt ? App.el('span', { class: 'cell-sub', text: '编辑过 · ' + App.fmtDate(item.editedAt) }) : null,
        // AI 审核留下的标记：一眼看出这条为什么被处理/待确认
        item.aiFlag
          ? App.el('span', {
              class: 'cell-sub',
              style: 'color:var(--c-gold)',
              text: 'AI：' + (AI_FLAG_LABEL[item.aiFlag] || item.aiFlag) + (item.aiNote ? ' · ' + item.aiNote : ''),
            })
          : null,
      ]);
      App.$('a', titleCell).addEventListener('click', function (ev) {
        ev.preventDefault();
        openDetail(item);
      });

      const authorCell = App.el('td', {}, [
        App.el('span', { class: 'cell-title', text: item.author }),
        App.el('span', { class: 'cell-sub', text: item.authorEmail }),
      ]);

      const actions = App.el('div', { class: 'inline-actions' });

      if (!item.deletedAt) {
        if (item.status === 'pending') {
          actions.appendChild(smallBtn('通过', 'px-btn--primary', function () {
            act(item, 'approve');
          }));
          actions.appendChild(smallBtn('拒绝', 'px-btn--danger', function () {
            reject(item);
          }));
        } else if (item.status === 'approved') {
          actions.appendChild(smallBtn('标记完成', 'px-btn--gold', function () {
            done(item);
          }));
        } else if (item.status === 'done') {
          actions.appendChild(smallBtn('撤销完成', '', function () {
            act(item, 'undone');
          }));
        } else if (item.status === 'rejected') {
          actions.appendChild(smallBtn('打回待审', '', function () {
            act(item, 'reopen');
          }));
        }
        actions.appendChild(smallBtn('编辑', '', function () {
          edit(item);
        }));
        actions.appendChild(smallBtn('删除', 'px-btn--ghost', function () {
          del(item);
        }));
      } else {
        actions.appendChild(smallBtn('恢复', 'px-btn--primary', function () {
          act(item, 'restore');
        }));
      }

      rowsBox.appendChild(
        App.el('tr', { id: 's-' + item.id }, [
          App.el('td', { class: 'cell-id', text: '#' + item.id }),
          titleCell,
          App.el('td', {}, [App.el('span', { html: App.catBadge(item.category) })]),
          App.el('td', {}, [App.el('span', { html: App.statusBadge(item.status) })]),
          App.el('td', { text: String(item.voteCount) }),
          authorCell,
          App.el('td', { class: 'cell-mono', text: App.fmtDate(item.createdAt) }),
          App.el('td', {}, [actions]),
        ])
      );
    });
  }

  function smallBtn(label, cls, handler) {
    const b = App.el('button', {
      class: 'px-btn px-btn--sm ' + cls,
      type: 'button',
      text: label,
    });
    b.addEventListener('click', handler);
    return b;
  }

  /* ============================ 详情弹窗 ============================ */

  function openDetail(item) {
    const overlay = App.el('div', { class: 'px-modal' });
    const close = function () {
      overlay.remove();
    };

    const actions = App.el('div', { class: 'inline-actions' });
    if (!item.deletedAt) {
      if (item.status === 'pending') {
        actions.appendChild(smallBtn('通过审核', 'px-btn--primary', function () {
          close();
          act(item, 'approve');
        }));
        actions.appendChild(smallBtn('拒绝', 'px-btn--danger', function () {
          close();
          reject(item);
        }));
      }
      if (item.status === 'approved') {
        actions.appendChild(smallBtn('标记为已完成', 'px-btn--gold', function () {
          close();
          done(item);
        }));
      }
      if (item.status === 'done') {
        actions.appendChild(smallBtn('撤销完成', '', function () {
          close();
          act(item, 'undone');
        }));
      }
      if (item.status === 'rejected') {
        actions.appendChild(smallBtn('打回待审', '', function () {
          close();
          act(item, 'reopen');
        }));
      }
      actions.appendChild(smallBtn('编辑内容', '', function () {
        close();
        edit(item);
      }));
      actions.appendChild(smallBtn('软删除', 'px-btn--ghost', function () {
        close();
        del(item);
      }));
    } else {
      actions.appendChild(smallBtn('恢复这条建议', 'px-btn--primary', function () {
        close();
        act(item, 'restore');
      }));
    }

    const closeBtn = App.el('button', { class: 'px-btn px-btn--ghost', type: 'button', text: '关闭' });
    closeBtn.addEventListener('click', close);

    const kv = App.el('div', { class: 'kv mb3' }, [
      App.el('span', { class: 'kv__k', text: '编号' }), App.el('span', { class: 'kv__v', text: '#' + item.id }),
      App.el('span', { class: 'kv__k', text: '状态' }), App.el('span', { class: 'kv__v', html: App.statusBadge(item.status) }),
      App.el('span', { class: 'kv__k', text: '分类' }), App.el('span', { class: 'kv__v', html: App.catBadge(item.category) }),
      App.el('span', { class: 'kv__k', text: '票数' }), App.el('span', { class: 'kv__v', text: String(item.voteCount) }),
      App.el('span', { class: 'kv__k', text: '提交者' }), App.el('span', { class: 'kv__v', text: item.author + '（' + item.authorEmail + '）' }),
      App.el('span', { class: 'kv__k', text: '提交时间' }), App.el('span', { class: 'kv__v', text: App.fmtDateTime(item.createdAt) }),
      item.reviewedAt ? App.el('span', { class: 'kv__k', text: '审核时间' }) : null,
      item.reviewedAt ? App.el('span', { class: 'kv__v', text: App.fmtDateTime(item.reviewedAt) }) : null,
      item.doneAt ? App.el('span', { class: 'kv__k', text: '完成时间' }) : null,
      item.doneAt ? App.el('span', { class: 'kv__v', text: App.fmtDateTime(item.doneAt) }) : null,
    ]);

    const box = App.el('div', { class: 'px-modal__box' }, [
      App.el('div', { class: 'px-modal__title', text: item.title }),
      kv,
      item.rejectReason ? App.el('div', { class: 'reject-box mb3', text: '拒绝理由：' + item.rejectReason }) : null,
      item.adminNote ? App.el('div', { class: 'done-note mb3', text: '实现说明：' + item.adminNote }) : null,
      App.el('div', { class: 'fs1 muted mb2', text: '正文' }),
      App.el('p', { class: 'px-card__body', text: item.body }),
      App.el('div', { class: 'px-modal__actions' }, [actions, App.el('div', { class: 'spacer' }), closeBtn]),
    ]);

    overlay.appendChild(box);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    document.body.appendChild(overlay);
  }

  /* ============================ 操作 ============================ */

  async function act(item, action) {
    const paths = {
      approve: '/suggestions/' + item.id + '/approve',
      undone: '/suggestions/' + item.id + '/undone',
      reopen: '/suggestions/' + item.id + '/reopen',
      restore: '/suggestions/' + item.id + '/restore',
    };
    const labels = { approve: '已通过', undone: '已撤销完成', reopen: '已打回待审', restore: '已恢复' };

    try {
      await Admin.api(paths[action], { method: 'POST', body: {} });
      App.ok(labels[action] + '：' + item.title);
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function reject(item) {
    const reason = await Admin.prompt({
      title: '拒绝「' + item.title + '」',
      text: '理由会展示给提交者，写清楚原因。',
      label: '拒绝理由',
      placeholder: '例如：属于重复建议，已有 #12 在投票',
      required: true,
      requiredMessage: '必须填写理由',
      multiline: true,
      maxlength: 200,
      okText: '确认拒绝',
    });
    if (reason === null) return;

    try {
      await Admin.api('/suggestions/' + item.id + '/reject', { method: 'POST', body: { reason: reason } });
      App.ok('已拒绝');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function done(item) {
    const note = await Admin.prompt({
      title: '把「' + item.title + '」标记为已完成',
      text: '建议会从投票榜移到「已实现」页。可选填一句实现说明，会公开给玩家看。',
      label: '实现说明（可留空）',
      placeholder: '例如：1.4 版本已加入，在设置里可以开关',
      maxlength: 300,
      multiline: true,
      okText: '标记完成',
    });
    if (note === null) return;

    try {
      await Admin.api('/suggestions/' + item.id + '/done', { method: 'POST', body: { note: note } });
      App.ok('已标记完成，玩家能在「已实现」页看到');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function edit(item) {
    const title = await Admin.prompt({
      title: '编辑标题（原：' + item.title + '）',
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
      okText: '下一步',
    });
    if (body === null) return;

    const cats = state.categories;
    const overlay = App.el('div', { class: 'px-modal' });
    let resolved = null;

    await new Promise(function (resolve) {
      const sel = App.el('select', { class: 'px-select' });
      cats.forEach(function (c) {
        sel.appendChild(App.el('option', { value: c, text: c, selected: c === item.category ? 'selected' : null }));
      });

      const okBtn = App.el('button', { class: 'px-btn px-btn--primary', type: 'button', text: '保存' });
      okBtn.addEventListener('click', function () {
        resolved = sel.value;
        overlay.remove();
        resolve();
      });
      const cancelBtn = App.el('button', { class: 'px-btn px-btn--ghost', type: 'button', text: '取消' });
      cancelBtn.addEventListener('click', function () {
        overlay.remove();
        resolve();
      });

      overlay.appendChild(
        App.el('div', { class: 'px-modal__box' }, [
          App.el('div', { class: 'px-modal__title', text: '选择分类' }),
          App.el('label', { class: 'px-label' }, [App.el('span', { text: '分类' }), sel]),
          App.el('div', { class: 'px-modal__actions' }, [cancelBtn, okBtn]),
        ])
      );
      document.body.appendChild(overlay);
    });

    if (!resolved) return;

    try {
      await Admin.api('/suggestions/' + item.id, {
        method: 'PATCH',
        body: { title: title, body: body, category: resolved },
      });
      App.ok('已保存');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function del(item) {
    const yes = await Admin.confirm({
      title: '删除「' + item.title + '」？',
      text: '软删除，可以用「已删除」筛选恢复。',
      okText: '删除',
      danger: true,
    });
    if (!yes) return;
    try {
      await Admin.api('/suggestions/' + item.id, { method: 'DELETE', body: {} });
      App.ok('已删除');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 加载 ============================ */

  async function load(keepPage) {
    if (!keepPage) state.page = 1;
    App.clear(rowsBox).appendChild(
      App.el('tr', {}, [App.el('td', { colspan: String(COLS) }, [
        App.el('div', { class: 'skeleton', style: 'height:60px' }),
      ])])
    );

    const params = new URLSearchParams();
    params.set('status', state.status);
    params.set('sort', state.sort);
    params.set('page', String(state.page));
    params.set('pageSize', '25');
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);

    try {
      const data = await Admin.api('/suggestions?' + params.toString());
      state.items = data.items;
      state.page = data.page;
      state.totalPages = data.totalPages;
      state.total = data.total;
      state.counts = data.counts;
      renderTabs();
      renderRows();
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (p) {
        state.page = p;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 事件 ============================ */

  App.$('#search-btn').addEventListener('click', function () {
    state.q = qInput.value.trim();
    syncQs();
    load();
  });
  qInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      state.q = qInput.value.trim();
      syncQs();
      load();
    }
  });
  catSel.addEventListener('change', function () {
    state.category = catSel.value;
    syncQs();
    load();
  });
  sortSel.addEventListener('change', function () {
    state.sort = sortSel.value;
    syncQs();
    load();
  });
  App.$('#reset-btn').addEventListener('click', function () {
    state.q = '';
    state.category = '';
    state.sort = 'newest';
    state.status = 'all';
    qInput.value = '';
    catSel.value = '';
    sortSel.value = 'newest';
    syncQs();
    load();
  });

  /* ============================ 启动 ============================ */

  qInput.value = state.q;
  sortSel.value = state.sort;

  Admin.boot({
    onReady: async function (me) {
      state.categories = (me.config && me.config.categories) || [];
      renderCategories();
      catSel.value = state.category;
      renderTabs();
      await load();
    },
  });
})();
