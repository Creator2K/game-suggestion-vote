'use strict';

/** 已实现荣誉榜 */

(function () {
  const boot = App.$('#boot');
  let categories = [];
  try {
    categories = JSON.parse(boot.dataset.categories || '[]');
  } catch (e) {
    categories = [];
  }

  const listBox = App.$('#list');
  const pagerBox = App.$('#pager');
  const chipsBox = App.$('#chips');

  const state = {
    page: Number(App.qs('page', '1')) || 1,
    category: App.qs('category', ''),
    total: 0,
    totalPages: 1,
  };

  /* ---------------------------- 分类筛选 ---------------------------- */

  function renderChips() {
    App.clear(chipsBox);
    const all = App.el('span', { class: 'chip' + (state.category ? '' : ' is-active'), text: '全部' });
    all.addEventListener('click', function () {
      pick('');
    });
    chipsBox.appendChild(all);

    categories.forEach(function (c) {
      const chip = App.el('span', {
        class: 'chip' + (state.category === c ? ' is-active' : ''),
        text: c,
      });
      chip.addEventListener('click', function () {
        pick(state.category === c ? '' : c);
      });
      chipsBox.appendChild(chip);
    });
  }

  function pick(category) {
    state.category = category;
    state.page = 1;
    App.setQs({ category: category, page: '' });
    renderChips();
    load();
  }

  /* ---------------------------- 列表 ---------------------------- */

  function buildCard(item) {
    const meta = App.el('div', { class: 'px-card__meta' }, [
      App.el('span', { html: App.catBadge(item.category) }),
      App.el('span', { text: '由 ' + item.author + ' 提出' }),
      item.doneAt ? App.el('span', { text: App.fmtDate(item.doneAt) + ' 实现' }) : null,
    ]);

    const main = App.el('div', { class: 'px-card__main' }, [
      App.el('h3', { class: 'px-card__title', text: item.title }),
      meta,
      App.el('p', { class: 'px-card__body mt2', text: item.body }),
      item.doneNote ? App.el('div', { class: 'done-note', text: '实现说明：' + item.doneNote }) : null,
    ]);

    return App.el('article', { class: 'px-card done-card', id: 's-' + item.id }, [
      App.el('div', { class: 'px-card__rank' }, [
        App.el('span', { class: 'done-stamp', text: '已实现' }),
      ]),
      main,
      App.el('div', { class: 'px-card__side' }, [
        App.el('div', { class: 'votecount votecount--sky' }, [
          App.el('span', { text: String(item.voteCount) }),
          App.el('small', { text: '票支持' }),
        ]),
      ]),
    ]);
  }

  function renderList() {
    App.clear(listBox);

    if (!state.items || !state.items.length) {
      listBox.appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: state.category ? '这个分类还没有已实现的建议' : '还没有已实现的建议' }),
          App.el('div', {
            class: 'fs1 muted',
            text: '去投票榜支持你最想要的那条，它有可能就是下一条。',
          }),
          App.el('div', { class: 'mt4' }, [
            App.el('a', { class: 'px-btn px-btn--gold', href: '/vote', text: '去投票' }),
          ]),
        ])
      );
      return;
    }

    state.items.forEach(function (item) {
      listBox.appendChild(buildCard(item));
    });
  }

  function renderPager() {
    App.clear(pagerBox);
    if (state.totalPages <= 1) return;

    const nav = App.el('div', { class: 'row' });
    nav.innerHTML = App.pager(state.page, state.totalPages, function (p) {
      const params = new URLSearchParams();
      if (state.category) params.set('category', state.category);
      if (p > 1) params.set('page', String(p));
      const qs = params.toString();
      return location.pathname + (qs ? '?' + qs : '');
    });
    App.$$('a.px-btn', nav).forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        const url = new URL(a.href, location.origin);
        state.page = Number(url.searchParams.get('page') || '1');
        history.replaceState({}, '', url);
        load();
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    });
    pagerBox.appendChild(nav);
  }

  /* ---------------------------- 加载 ---------------------------- */

  async function load() {
    App.clear(listBox);
    listBox.appendChild(App.el('div', { class: 'skeleton', style: 'height:170px;border:3px solid #14111f' }));

    const params = new URLSearchParams();
    params.set('page', String(state.page));
    params.set('pageSize', '10');
    if (state.category) params.set('category', state.category);

    try {
      const data = await App.api('/api/done?' + params.toString());
      state.items = data.items;
      state.total = data.total;
      state.totalPages = data.totalPages;
      state.page = data.page;
      renderList();
      renderPager();
    } catch (err) {
      App.clear(listBox).appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '加载失败' }),
          App.el('div', { class: 'fs1 muted', text: err.message }),
        ])
      );
    }
  }

  renderChips();
  load();
})();
