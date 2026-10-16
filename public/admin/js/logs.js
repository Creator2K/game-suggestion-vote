'use strict';

/** 操作日志 */

(function () {
  const rowsBox = App.$('#rows');
  const pagerBox = App.$('#pager');
  const COLS = 5;

  const ACTION_LABEL = {
    'admin.init': '初始化后台',
    'admin.login': '登录后台',
    'admin.login_failed': '登录失败',
    'admin.logout': '退出登录',
    'admin.password_change': '修改管理员密码',
    'admin.password_reset': '重置管理员密码',
    'suggestion.approve': '通过建议',
    'suggestion.reject': '拒绝建议',
    'suggestion.reopen': '打回待审',
    'suggestion.done': '标记完成',
    'suggestion.undone': '撤销完成',
    'suggestion.edit': '编辑建议',
    'suggestion.delete': '删除建议',
    'suggestion.restore': '恢复建议',
    'vote.delete': '删除投票',
    'vote.purge': '批量清理投票',
    'player.ban': '封禁玩家',
    'player.unban': '解封玩家',
    'player.purge_votes': '清空玩家投票',
    'ban.add': '新增封禁',
    'ban.remove': '解除封禁',
    'settings.update': '修改设置',
    'screenshot.add': '上传截图',
    'screenshot.remove': '删除截图',
    'maintenance.recount': '重算票数',
    'maintenance.cleanup': '清理过期数据',
  };

  const state = { page: 1, totalPages: 1, total: 0 };

  function prettyDetail(log) {
    if (!log.detail) return '—';
    try {
      const obj = JSON.parse(log.detail);
      if (typeof obj === 'string') return obj;
      const parts = [];
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v === null || v === undefined || v === '') continue;
        parts.push(k + '：' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
      }
      return parts.length ? parts.join(' · ') : '—';
    } catch (e) {
      return log.detail;
    }
  }

  function render(items) {
    App.clear(rowsBox);

    if (!items.length) {
      rowsBox.appendChild(Admin.emptyRow(COLS, '还没有操作记录', '审核、封禁、改设置等动作都会记录在这里。'));
      return;
    }

    items.forEach(function (log) {
      // 登录失败标红，方便一眼看到有人在试密码
      const isFailed = log.action === 'admin.login_failed';

      rowsBox.appendChild(
        App.el('tr', { style: isFailed ? 'background:rgba(232,137,140,.08)' : null }, [
          App.el('td', { class: 'cell-mono', text: App.fmtDateTime(log.at) }),
          App.el('td', {}, [
            App.el('span', { class: 'cell-title', text: ACTION_LABEL[log.action] || log.action }),
            App.el('span', { class: 'cell-sub', text: log.action }),
          ]),
          App.el('td', { class: 'cell-mono', text: log.targetType ? log.targetType + (log.targetId ? ' #' + log.targetId : '') : '—' }),
          App.el('td', {}, [App.el('span', { class: 'cell-sub', text: prettyDetail(log) })]),
          App.el('td', { class: 'cell-mono', text: log.ip || '—' }),
        ])
      );
    });
  }

  async function load(keepPage) {
    if (!keepPage) state.page = 1;
    App.clear(rowsBox).appendChild(
      App.el('tr', {}, [
        App.el('td', { colspan: String(COLS) }, [App.el('div', { class: 'skeleton', style: 'height:60px' })]),
      ])
    );

    try {
      const data = await Admin.api('/logs?page=' + state.page + '&pageSize=50');
      state.page = data.page;
      state.totalPages = data.totalPages;
      state.total = data.total;
      render(data.items);
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (p) {
        state.page = p;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
    }
  }

  Admin.boot({ onReady: load });
})();
