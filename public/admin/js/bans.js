'use strict';

/** 封禁名单管理 */

(function () {
  const rowsBox = App.$('#rows');
  const countBadge = App.$('#count');
  const kindSel = App.$('#kind');
  const valueInput = App.$('#value');
  const reasonInput = App.$('#reason');

  const COLS = 5;
  let items = [];

  /* ============================ 渲染 ============================ */

  function render() {
    App.clear(rowsBox);

    if (!items.length) {
      rowsBox.appendChild(Admin.emptyRow(COLS, '封禁名单是空的', '目前没有任何邮箱或 IP 被禁止操作。'));
      return;
    }

    items.forEach(function (b) {
      const delBtn = App.el('button', { class: 'px-btn px-btn--sm px-btn--danger', type: 'button', text: '解除' });
      delBtn.addEventListener('click', function () {
        removeBan(b);
      });

      // IP 类型的封禁，顺手给一个「看这个 IP 的投票」入口
      const valueCell = App.el('td', {}, [
        App.el('span', { class: 'cell-title', text: b.value }),
      ]);
      if (b.kind === 'ip') {
        const link = App.el('a', { class: 'cell-sub', href: '/admin/votes?ip=' + encodeURIComponent(b.value), text: '查看该 IP 的投票 →' });
        valueCell.appendChild(link);
      } else {
        const link = App.el('a', { class: 'cell-sub', href: '/admin/players?q=' + encodeURIComponent(b.value), text: '查看该玩家 →' });
        valueCell.appendChild(link);
      }

      rowsBox.appendChild(
        App.el('tr', {}, [
          App.el('td', {}, [
            App.el('span', {
              class: 'px-badge ' + (b.kind === 'ip' ? 'px-badge--rejected' : 'px-badge--pending'),
              text: b.kind === 'ip' ? 'IP' : '邮箱',
            }),
          ]),
          valueCell,
          App.el('td', { text: b.reason || '—' }),
          App.el('td', { class: 'cell-mono', text: App.fmtDateTime(b.createdAt) }),
          App.el('td', {}, [delBtn]),
        ])
      );
    });

    countBadge.textContent = String(items.length);
  }

  /* ============================ 操作 ============================ */

  async function addBan() {
    const kind = kindSel.value;
    const value = valueInput.value.trim();
    const reason = reasonInput.value.trim();

    if (!value) return App.err('请填写要封禁的内容');
    if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return App.err('邮箱格式看起来不对');
    }

    try {
      await Admin.api('/bans', { method: 'POST', body: { kind: kind, value: value, reason: reason } });
      App.ok('已加入封禁名单');
      valueInput.value = '';
      reasonInput.value = '';
      await load();
    } catch (err) {
      App.err(err.message);
    }
  }

  async function removeBan(b) {
    const yes = await Admin.confirm({
      title: '解除封禁？',
      text: b.kind === 'ip' ? 'IP ' + b.value : '邮箱 ' + b.value,
      detail: '解除后该邮箱 / IP 可以重新提交建议和投票。',
      okText: '解除',
    });
    if (!yes) return;

    try {
      await Admin.api('/bans/' + b.id, { method: 'DELETE', body: {} });
      App.ok('已解除封禁');
      await load();
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 加载 ============================ */

  async function load() {
    try {
      const data = await Admin.api('/bans');
      items = data.items;
      render();
    } catch (err) {
      App.err(err.message);
    }
  }

  App.$('#add-btn').addEventListener('click', addBan);
  valueInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') addBan();
  });
  kindSel.addEventListener('change', function () {
    valueInput.placeholder = kindSel.value === 'ip' ? '例如 203.0.113.10' : '例如 someone@example.com';
  });

  Admin.boot({
    onReady: async function () {
      // 从玩家详情跳过来时带 ?add=<ip>
      const add = App.qs('add', '');
      if (add) {
        valueInput.value = add;
        kindSel.value = /^\d{1,3}(\.\d{1,3}){3}$/.test(add) ? 'ip' : 'email';
        App.setQs({ add: '' });
      }
      await load();
    },
  });
})();
