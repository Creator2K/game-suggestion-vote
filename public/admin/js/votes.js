'use strict';

/** 投票明细：查刷票、删票、按 IP / 邮箱批量清理 */

(function () {
  const rowsBox = App.$('#rows');
  const pagerBox = App.$('#pager');
  const qIp = App.$('#q-ip');
  const qEmail = App.$('#q-email');
  const qSug = App.$('#q-sug');
  const purgeBar = App.$('#purge-bar');
  const purgeLabel = App.$('#purge-label');

  const COLS = 6;

  const state = {
    ip: App.qs('ip', ''),
    email: App.qs('email', ''),
    suggestionId: App.qs('suggestionId', ''),
    page: 1,
    totalPages: 1,
    total: 0,
    items: [],
  };

  function syncInputs() {
    qIp.value = state.ip;
    qEmail.value = state.email;
    qSug.value = state.suggestionId;
  }

  function syncPurgeBar() {
    // 只有当筛选条件精确到「单个 IP」或「单个邮箱」时才允许批量清理，
    // 免得误用模糊条件一次性删掉一大堆正常投票
    const parts = [];
    if (state.ip) parts.push('IP ' + state.ip);
    if (state.email) parts.push('邮箱 ' + state.email);

    if (!parts.length) {
      purgeBar.hidden = true;
      return;
    }
    purgeBar.hidden = false;
    purgeLabel.textContent = '当前筛选：' + parts.join(' · ') + '（注意：邮箱是按包含匹配，清理会删掉所有匹配到的票）';
  }

  /* ============================ 表格 ============================ */

  function render() {
    App.clear(rowsBox);

    if (!state.items.length) {
      rowsBox.appendChild(Admin.emptyRow(COLS, '没有匹配的投票记录', '换个筛选条件试试。'));
      return;
    }

    state.items.forEach(function (v) {
      const delBtn = App.el('button', { class: 'px-btn px-btn--sm px-btn--danger', type: 'button', text: '删' });
      delBtn.addEventListener('click', function () {
        removeVote(v);
      });

      const userCell = App.el('td', {}, [
        App.el('span', { class: 'cell-title', text: v.nickname }),
        App.el('span', { class: 'cell-sub', text: v.email }),
        v.banned ? App.el('span', { class: 'px-badge px-badge--rejected mt1', text: '已封禁' }) : null,
      ]);

      rowsBox.appendChild(
        App.el('tr', {}, [
          App.el('td', { class: 'cell-id', text: '#' + v.id }),
          App.el('td', {}, [
            App.el('span', { class: 'cell-title', text: v.suggestionTitle }),
            App.el('span', { class: 'cell-sub', text: '#' + v.suggestionId + ' · ' + (App.STATUS_LABEL[v.suggestionStatus] || v.suggestionStatus) }),
          ]),
          userCell,
          App.el('td', { class: 'cell-mono', text: v.ip || '（未记录）' }),
          App.el('td', { class: 'cell-mono', text: App.fmtDateTime(v.createdAt) }),
          App.el('td', {}, [delBtn]),
        ])
      );
    });
  }

  /* ============================ 操作 ============================ */

  async function removeVote(v) {
    const yes = await Admin.confirm({
      title: '删除这张票？',
      text: v.nickname + ' 投给「' + v.suggestionTitle + '」',
      detail: '删除后票数缓存会同步修正。这个动作不可撤销。',
      okText: '删除',
      danger: true,
    });
    if (!yes) return;

    try {
      await Admin.api('/votes/' + v.id, { method: 'DELETE', body: {} });
      App.ok('已删除并修正票数');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  App.$('#purge-btn').addEventListener('click', async function () {
    const target = state.ip ? { ip: state.ip } : { email: state.email };
    const label = state.ip ? 'IP ' + state.ip : '邮箱包含「' + state.email + '」';

    const yes = await Admin.confirm({
      title: '批量清理投票',
      text: '将删除 ' + label + ' 对应的全部投票记录。',
      detail: '适用于确认刷票的情况。删完之后记得去仪表盘「重算票数」核对一下。',
      okText: '确认清理',
      danger: true,
    });
    if (!yes) return;

    try {
      const r = await Admin.api('/votes/purge', { method: 'POST', body: target });
      App.ok('已清理 ' + r.removed + ' 张票，影响 ' + r.affected + ' 条建议');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  });

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
    if (state.ip) params.set('ip', state.ip);
    if (state.email) params.set('email', state.email);
    if (state.suggestionId) params.set('suggestionId', state.suggestionId);

    try {
      const data = await Admin.api('/votes?' + params.toString());
      state.items = data.items;
      state.page = data.page;
      state.totalPages = data.totalPages;
      state.total = data.total;
      render();
      syncPurgeBar();
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (p) {
        state.page = p;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
    }
  }

  function doSearch() {
    state.ip = qIp.value.trim();
    state.email = qEmail.value.trim();
    state.suggestionId = qSug.value.trim().replace(/[^0-9]/g, '');
    App.setQs({ ip: state.ip, email: state.email, suggestionId: state.suggestionId, page: '' });
    load();
  }

  App.$('#search-btn').addEventListener('click', doSearch);
  [qIp, qEmail, qSug].forEach(function (input) {
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') doSearch();
    });
  });

  App.$('#reset-btn').addEventListener('click', function () {
    state.ip = '';
    state.email = '';
    state.suggestionId = '';
    syncInputs();
    App.setQs({ ip: '', email: '', suggestionId: '', page: '' });
    load();
  });

  syncInputs();
  Admin.boot({ onReady: load });
})();
