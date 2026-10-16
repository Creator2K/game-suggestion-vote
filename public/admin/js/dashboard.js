'use strict';

/** 后台仪表盘 */

(function () {
  const daysSel = App.$('#days');
  const cardsBox = App.$('#cards');
  const trendBox = App.$('#trend-box');
  const trendNote = App.$('#trend-note');

  /* ---------------------------- 统计卡片 ---------------------------- */

  function renderCards(c) {
    App.clear(cardsBox);

    const items = [
      { label: '待审核', value: c.pending, cls: c.pending > 0 ? 'card--warn' : '' },
      { label: '投票中', value: c.approved, cls: 'card--ok' },
      { label: '已实现', value: c.done, cls: 'card--info' },
      { label: '已拒绝', value: c.rejected, cls: '' },
      { label: '累计票数', value: c.totalVotes, cls: '' },
      { label: '玩家数', value: c.totalPlayers, cls: '' },
      { label: '今日投票', value: c.votesToday, cls: '' },
      { label: '今日新建议', value: c.suggestionsToday, cls: '' },
      { label: '通过率', value: c.approvalRate + '%', cls: 'card--ok' },
      { label: '封禁中', value: c.bannedPlayers + c.bans, cls: c.bannedPlayers + c.bans > 0 ? 'card--danger' : '' },
    ];

    items.forEach(function (it) {
      cardsBox.appendChild(
        App.el('div', { class: 'card ' + it.cls }, [
          App.el('div', { class: 'card__value', text: String(it.value) }),
          App.el('div', { class: 'card__label', text: it.label }),
        ])
      );
    });
  }

  /* ---------------------------- 趋势图 ---------------------------- */

  function renderTrend(trend) {
    App.clear(trendBox);

    const maxVotes = trend.reduce(function (m, d) {
      return Math.max(m, d.votes);
    }, 1);
    const maxSug = trend.reduce(function (m, d) {
      return Math.max(m, d.suggestions);
    }, 1);

    const chart = App.el('div', { class: 'trend' });
    const labels = App.el('div', { class: 'trend__label' });

    trend.forEach(function (d) {
      const col = App.el('div', {
        class: 'trend__col',
        title: d.date + '：投票 ' + d.votes + ' · 建议 ' + d.suggestions,
      });
      // 建议用固定比例（建议数天然比票数少得多），投票按最大值缩放
      const voteH = Math.round((d.votes / maxVotes) * 100);
      const sugH = Math.round((d.suggestions / maxSug) * 40);

      if (d.votes > 0) {
        col.appendChild(App.el('div', { class: 'trend__bar', style: 'height:' + Math.max(2, voteH) + '%' }));
      }
      if (d.suggestions > 0) {
        col.appendChild(App.el('div', { class: 'trend__bar trend__bar--sug', style: 'height:' + Math.max(2, sugH) + '%' }));
      }
      chart.appendChild(col);

      labels.appendChild(App.el('span', { text: d.date.slice(5) }));
    });

    trendBox.appendChild(chart);
    trendBox.appendChild(labels);

    const sum = trend.reduce(function (a, d) {
      return a + d.votes;
    }, 0);
    trendNote.textContent = '该区间共 ' + sum + ' 票，单日最高 ' + maxVotes + ' 票';
  }

  /* ---------------------------- 榜单 ---------------------------- */

  function renderTop(items) {
    const box = App.clear(App.$('#top-box'));
    if (!items.length) {
      box.appendChild(App.el('div', { class: 'px-empty' }, [App.el('div', { text: '还没有上架的建议' })]));
      return;
    }
    const list = App.el('div', { class: 'stack' });
    items.forEach(function (it, i) {
      list.appendChild(
        App.el('div', { class: 'mine-item' }, [
          App.el('div', { class: 'mine-item__main' }, [
            App.el('div', { class: 'mine-item__title', text: (i + 1) + '. ' + it.title }),
            App.el('div', { class: 'cell-badge-row' }, [
              App.el('span', { html: App.catBadge(it.category) }),
            ]),
          ]),
          App.el('div', { class: 'px-card__side' }, [
            App.el('span', { class: 'fs1', style: 'color:var(--c-mint)', text: it.voteCount + ' 票' }),
          ]),
        ])
      );
    });
    box.appendChild(list);
  }

  function renderRecent(items) {
    const box = App.clear(App.$('#recent-box'));
    if (!items.length) {
      box.appendChild(App.el('div', { class: 'px-empty' }, [App.el('div', { text: '还没有收到建议' })]));
      return;
    }
    const list = App.el('div', { class: 'stack' });
    items.forEach(function (it) {
      const row = App.el('div', { class: 'mine-item' }, [
        App.el('div', { class: 'mine-item__main' }, [
          App.el('div', { class: 'mine-item__title', text: it.title }),
          App.el('div', { class: 'cell-badge-row' }, [
            App.el('span', { html: App.statusBadge(it.status) }),
            App.el('span', { class: 'fs1 muted', text: it.author + ' · ' + App.timeAgo(it.createdAt) }),
          ]),
        ]),
      ]);
      if (it.status === 'pending') {
        const go = App.el('button', { class: 'px-btn px-btn--sm px-btn--gold', type: 'button', text: '去审核' });
        go.addEventListener('click', function () {
          location.href = '/admin/review#s-' + it.id;
        });
        row.appendChild(App.el('div', { class: 'px-card__side' }, [go]));
      }
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  function renderSuspicious(items) {
    const section = App.$('#suspicious-section');
    if (!items.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const box = App.clear(App.$('#suspicious-box'));
    const table = App.el('table', { class: 'px-table admin-table' });
    const thead = App.el('thead', {}, [
      App.el('tr', {}, [
        App.el('th', { text: 'IP' }),
        App.el('th', { text: '投出的票数' }),
        App.el('th', { text: '涉及邮箱数' }),
        App.el('th', { text: '操作' }),
      ]),
    ]);
    const tbody = App.el('tbody');
    items.forEach(function (it) {
      const go = App.el('button', { class: 'px-btn px-btn--sm', type: 'button', text: '看明细' });
      go.addEventListener('click', function () {
        location.href = '/admin/votes?ip=' + encodeURIComponent(it.ip);
      });
      tbody.appendChild(
        App.el('tr', {}, [
          App.el('td', { class: 'cell-mono', text: it.ip || '（未记录）' }),
          App.el('td', { text: String(it.votes) }),
          App.el('td', { text: String(it.players) }),
          App.el('td', {}, [go]),
        ])
      );
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    box.appendChild(App.el('div', { class: 'table-wrap' }, [table]));
  }

  /* ---------------------------- 加载 ---------------------------- */

  async function load() {
    try {
      const data = await Admin.api('/dashboard?days=' + encodeURIComponent(daysSel.value));
      renderCards(data.counts);
      renderTrend(data.trend);
      renderTop(data.topByVotes);
      renderRecent(data.recentSuggestions);
      renderSuspicious(data.suspiciousIps);

      const badge = App.$('#nav-pending');
      if (badge) {
        if (data.counts.pending > 0) {
          badge.textContent = String(data.counts.pending);
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
    } catch (err) {
      App.err(err.message);
      App.clear(cardsBox).appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '数据加载失败' }),
          App.el('div', { class: 'fs1 muted', text: err.message }),
        ])
      );
    }
  }

  daysSel.addEventListener('change', load);

  App.$('#btn-recount').addEventListener('click', async function () {
    const yes = await Admin.confirm({
      title: '重算票数',
      text: '会遍历所有建议，把票数缓存按投票明细重新算一遍。数据量大时可能要几秒。',
      okText: '开始重算',
    });
    if (!yes) return;
    try {
      const r = await Admin.api('/recount', { method: 'POST', body: {} });
      App.ok(r.fixed > 0 ? '修正了 ' + r.fixed + ' 条建议的票数' : '所有票数都是一致的，无需修正');
      load();
    } catch (err) {
      App.err(err.message);
    }
  });

  App.$('#btn-cleanup').addEventListener('click', async function () {
    const yes = await Admin.confirm({
      title: '清理过期数据',
      text: '删除过期的后台会话、7 天前的限频记录、以及 180 天前的操作日志。',
      okText: '确认清理',
    });
    if (!yes) return;
    try {
      await Admin.api('/cleanup', { method: 'POST', body: {} });
      App.ok('已清理');
    } catch (err) {
      App.err(err.message);
    }
  });

  Admin.boot({ onReady: load });
})();
