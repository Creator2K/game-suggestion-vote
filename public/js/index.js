'use strict';

/** 首页：统计数字、热门 Top3、游戏截图、公告 */

(function () {
  const boot = App.$('#boot');
  const announcement = boot ? (boot.dataset.announcement || '').trim() : '';

  /* ---------------------------- 公告 ---------------------------- */

  if (announcement) {
    App.$('#notice-text').textContent = announcement;
    App.$('#notice-box').hidden = false;
  }

  /* ---------------------------- 实时统计 ---------------------------- */

  async function loadStats() {
    try {
      const data = await App.api('/api/stats');
      const s = data.stats;
      App.countUp(App.$('#s-approved'), s.approved);
      App.countUp(App.$('#s-votes'), s.totalVotes);
      App.countUp(App.$('#s-done'), s.done);
      App.countUp(App.$('#s-players'), s.totalPlayers);
    } catch (e) {
      ['#s-approved', '#s-votes', '#s-done', '#s-players'].forEach(function (sel) {
        const node = App.$(sel);
        if (node) node.textContent = '—';
      });
    }
  }

  /* ---------------------------- 热门 Top3 ---------------------------- */

  async function loadTop3() {
    const box = App.$('#top3');
    try {
      const data = await App.api('/api/top?limit=3');
      App.clear(box);

      if (!data.items.length) {
        box.appendChild(
          App.el('div', { class: 'px-empty' }, [
            App.el('div', { class: 'px-empty__title', text: '还没有上架的建议' }),
            App.el('div', { class: 'fs1 muted', text: '第一批建议正在审核中，欢迎你抢先提交。' }),
          ])
        );
        return;
      }

      data.items.forEach(function (item, i) {
        const rank = i + 1;
        const row = App.el('a', {
          class: 'top3__item top3__item--' + rank,
          href: '/vote#' + item.id,
        }, [
          App.el('div', { class: 'top3__rank', text: String(rank) }),
          App.el('div', { class: 'top3__main' }, [
            App.el('div', { class: 'top3__title', text: item.title }),
            App.el('div', { class: 'top3__meta' }, [
              App.el('span', { html: App.catBadge(item.category) }),
              App.el('span', { text: 'by ' + item.author }),
              App.el('span', { text: App.timeAgo(item.createdAt) }),
            ]),
          ]),
          App.el('div', { class: 'top3__votes', text: item.voteCount + ' 票' }),
        ]);
        box.appendChild(row);
      });
    } catch (e) {
      App.clear(box).appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '热门建议加载失败' }),
          App.el('div', { class: 'fs1 muted', text: e.message }),
        ])
      );
    }
  }

  /* ---------------------------- 游戏截图 ---------------------------- */

  function renderShots() {
    let shots = [];
    try {
      shots = JSON.parse((boot && boot.dataset.screenshots) || '[]');
    } catch (e) {
      shots = [];
    }
    if (!Array.isArray(shots) || shots.length === 0) return;

    const section = App.$('#shots-section');
    const box = App.clear(App.$('#shots'));

    shots.forEach(function (shot) {
      box.appendChild(
        App.el('figure', { class: 'shot' }, [
          App.el('img', { src: shot.url, alt: shot.caption || '游戏截图', loading: 'lazy' }),
          shot.caption ? App.el('figcaption', { class: 'shot__caption', text: shot.caption }) : null,
        ])
      );
    });

    section.hidden = false;
  }

  /* ---------------------------- 启动 ---------------------------- */

  renderShots();
  loadStats();
  loadTop3();
})();
