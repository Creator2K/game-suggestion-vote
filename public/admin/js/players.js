'use strict';

/** 玩家管理：封禁 / 解封 / 查看行为 / 清空其投票 */

(function () {
  const rowsBox = App.$('#rows');
  const pagerBox = App.$('#pager');
  const qInput = App.$('#q');
  const onlyBanned = App.$('#only-banned');

  const COLS = 7;

  const state = {
    q: App.qs('q', ''),
    banned: App.qs('banned', '') === '1',
    page: 1,
    totalPages: 1,
    total: 0,
    items: [],
  };

  /* ============================ 表格 ============================ */

  function render() {
    App.clear(rowsBox);

    if (!state.items.length) {
      rowsBox.appendChild(Admin.emptyRow(COLS, '没有匹配的玩家', '换个关键词试试。'));
      return;
    }

    state.items.forEach(function (p) {
      const detailBtn = App.el('button', { class: 'px-btn px-btn--sm', type: 'button', text: '详情' });
      detailBtn.addEventListener('click', function () {
        openDetail(p);
      });

      const actions = App.el('div', { class: 'inline-actions' });
      actions.appendChild(detailBtn);

      if (p.banned) {
        const unban = App.el('button', { class: 'px-btn px-btn--sm px-btn--primary', type: 'button', text: '解封' });
        unban.addEventListener('click', function () {
          unbanPlayer(p);
        });
        actions.appendChild(unban);
      } else {
        const ban = App.el('button', { class: 'px-btn px-btn--sm px-btn--danger', type: 'button', text: '封禁' });
        ban.addEventListener('click', function () {
          banPlayer(p);
        });
        actions.appendChild(ban);
      }

      const statusCell = App.el('td', {}, [
        App.el('div', { class: 'cell-badge-row' }, [
          p.banned
            ? App.el('span', { class: 'px-badge px-badge--rejected', text: '已封禁' })
            : App.el('span', { class: 'px-badge px-badge--approved', text: '正常' }),
        ]),
        p.banned && p.banReason ? App.el('span', { class: 'cell-sub', text: p.banReason }) : null,
        App.el('div', { class: 'mt2' }, [actions]),
      ]);

      rowsBox.appendChild(
        App.el('tr', {}, [
          App.el('td', { class: 'cell-id', text: '#' + p.id }),
          App.el('td', {}, [
            App.el('span', { class: 'cell-title', text: p.nickname }),
            App.el('span', { class: 'cell-sub', text: p.email }),
          ]),
          App.el('td', { text: String(p.suggestionCount) }),
          App.el('td', { text: String(p.voteCount) }),
          App.el('td', { class: 'cell-mono', text: p.lastIp || '—' }),
          App.el('td', { class: 'cell-mono', text: App.fmtDate(p.createdAt) }),
          statusCell,
        ])
      );
    });
  }

  /* ============================ 详情 ============================ */

  async function openDetail(p) {
    const overlay = App.el('div', { class: 'px-modal' });
    const close = function () {
      overlay.remove();
    };
    const box = App.el('div', { class: 'px-modal__box' });
    box.appendChild(App.el('div', { class: 'px-modal__title', text: p.nickname }));
    box.appendChild(App.el('div', { class: 'skeleton', style: 'height:160px' }));
    overlay.appendChild(box);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    document.body.appendChild(overlay);

    let data;
    try {
      data = await Admin.api('/players/' + p.id);
    } catch (err) {
      App.err(err.message);
      close();
      return;
    }

    App.clear(box);
    const d = data.player;

    box.appendChild(App.el('div', { class: 'px-modal__title', text: d.nickname }));
    box.appendChild(
      App.el('div', { class: 'kv mb3' }, [
        App.el('span', { class: 'kv__k', text: '邮箱' }), App.el('span', { class: 'kv__v', text: d.email }),
        App.el('span', { class: 'kv__k', text: '加入' }), App.el('span', { class: 'kv__v', text: App.fmtDateTime(d.createdAt) }),
        d.lastSeenAt ? App.el('span', { class: 'kv__k', text: '最近活动' }) : null,
        d.lastSeenAt ? App.el('span', { class: 'kv__v', text: App.fmtDateTime(d.lastSeenAt) }) : null,
        App.el('span', { class: 'kv__k', text: '最近 IP' }), App.el('span', { class: 'kv__v', text: d.lastIp || '—' }),
        App.el('span', { class: 'kv__k', text: '状态' }),
        App.el('span', {
          class: 'kv__v',
          text: d.banned ? '已封禁' + (d.banReason ? '（' + d.banReason + '）' : '') : '正常',
          style: d.banned ? 'color:var(--c-coral)' : 'color:var(--c-mint)',
        }),
      ])
    );

    // 建议
    box.appendChild(App.el('h3', { class: 'fs2 mb2', text: '提交的建议（' + data.suggestions.length + '）' }));
    if (!data.suggestions.length) {
      box.appendChild(App.el('div', { class: 'fs1 muted mb3', text: '没有提交过建议。' }));
    } else {
      const list = App.el('div', { class: 'mb3' });
      data.suggestions.forEach(function (s) {
        list.appendChild(
          App.el('div', { class: 'mine-item' }, [
            App.el('div', { class: 'mine-item__main' }, [
              App.el('div', { class: 'cell-title', text: s.title }),
              App.el('div', { class: 'cell-badge-row' }, [
                App.el('span', { html: App.statusBadge(s.status) }),
                App.el('span', { class: 'fs1 muted', text: '#' + s.id + ' · ' + s.voteCount + ' 票 · ' + App.fmtDate(s.createdAt) }),
              ]),
            ]),
          ])
        );
      });
      box.appendChild(list);
    }

    // 投票
    box.appendChild(App.el('h3', { class: 'fs2 mb2', text: '投出的票（' + data.votes.length + '）' }));
    if (!data.votes.length) {
      box.appendChild(App.el('div', { class: 'fs1 muted mb3', text: '还没有投过票。' }));
    } else {
      const list = App.el('div', { class: 'mb3', style: 'max-height:240px;overflow:auto' });
      data.votes.forEach(function (v) {
        list.appendChild(
          App.el('div', { class: 'mine-item' }, [
            App.el('div', { class: 'mine-item__main' }, [
              App.el('div', { class: 'cell-title', text: v.title }),
              App.el('div', { class: 'fs1 muted', text: '#' + v.suggestionId + ' · ' + App.fmtDateTime(v.createdAt) + ' · ' + (v.ip || '无 IP') }),
            ]),
          ])
        );
      });
      box.appendChild(list);
    }

    // 操作
    const actions = App.el('div', { class: 'inline-actions' });

    if (d.banned) {
      const unban = App.el('button', { class: 'px-btn px-btn--primary', type: 'button', text: '解除封禁' });
      unban.addEventListener('click', function () {
        close();
        unbanPlayer(d);
      });
      actions.appendChild(unban);
    } else {
      const ban = App.el('button', { class: 'px-btn px-btn--danger', type: 'button', text: '封禁这个玩家' });
      ban.addEventListener('click', function () {
        close();
        banPlayer(d);
      });
      actions.appendChild(ban);
    }

    const banIp = App.el('button', { class: 'px-btn', type: 'button', text: '封禁其 IP' });
    banIp.addEventListener('click', function () {
      if (!d.lastIp) return App.err('这个玩家没有记录到 IP');
      close();
      location.href = '/admin/bans?add=' + encodeURIComponent(d.lastIp);
    });
    actions.appendChild(banIp);

    const purge = App.el('button', { class: 'px-btn px-btn--ghost', type: 'button', text: '清空其全部投票' });
    purge.addEventListener('click', function () {
      close();
      purgeVotes(d);
    });
    actions.appendChild(purge);

    const closeBtn = App.el('button', { class: 'px-btn px-btn--ghost', type: 'button', text: '关闭' });
    closeBtn.addEventListener('click', close);

    box.appendChild(App.el('div', { class: 'px-modal__actions' }, [actions, App.el('div', { class: 'spacer' }), closeBtn]));
  }

  /* ============================ 操作 ============================ */

  async function banPlayer(p) {
    const reason = await Admin.prompt({
      title: '封禁 ' + p.nickname,
      text: '被封禁的邮箱将无法提交建议和投票。理由会展示给本人。',
      label: '封禁理由',
      placeholder: '例如：批量刷票',
      maxlength: 100,
      okText: '确认封禁',
    });
    if (reason === null) return;

    try {
      await Admin.api('/players/' + p.id + '/ban', { method: 'POST', body: { reason: reason } });
      App.ok('已封禁 ' + p.nickname);
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function unbanPlayer(p) {
    try {
      await Admin.api('/players/' + p.id + '/unban', { method: 'POST', body: {} });
      App.ok('已解封');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function purgeVotes(p) {
    const yes = await Admin.confirm({
      title: '清空 ' + p.nickname + ' 的所有投票？',
      text: '共 ' + p.voteCount + ' 张票会被删除，相关建议的票数会重新计算。',
      detail: '这个动作不可撤销，通常用于清理确认的刷票账号。',
      okText: '确认清空',
      danger: true,
    });
    if (!yes) return;

    try {
      const r = await Admin.api('/players/' + p.id + '/purge-votes', { method: 'POST', body: {} });
      App.ok('已清空 ' + r.removed + ' 张票');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 加载 ============================ */

  async function load(keepPage) {
    if (!keepPage) state.page = 1;
    App.clear(rowsBox).appendChild(
      App.el('tr', {}, [
        App.el('td', { colspan: String(COLS) }, [App.el('div', { class: 'skeleton', style: 'height:60px' })]),
      ])
    );

    const params = new URLSearchParams();
    params.set('page', String(state.page));
    params.set('pageSize', '30');
    if (state.q) params.set('q', state.q);
    if (state.banned) params.set('banned', '1');

    try {
      const data = await Admin.api('/players?' + params.toString());
      state.items = data.items;
      state.page = data.page;
      state.totalPages = data.totalPages;
      state.total = data.total;
      render();
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (pg) {
        state.page = pg;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
    }
  }

  function doSearch() {
    state.q = qInput.value.trim();
    state.banned = onlyBanned.checked;
    App.setQs({ q: state.q, banned: state.banned ? '1' : '', page: '' });
    load();
  }

  App.$('#search-btn').addEventListener('click', doSearch);
  qInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') doSearch();
  });
  onlyBanned.addEventListener('change', doSearch);
  App.$('#reset-btn').addEventListener('click', function () {
    qInput.value = '';
    onlyBanned.checked = false;
    state.q = '';
    state.banned = false;
    App.setQs({ q: '', banned: '', page: '' });
    load();
  });

  qInput.value = state.q;
  onlyBanned.checked = state.banned;

  Admin.boot({ onReady: load });
})();
