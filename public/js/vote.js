'use strict';

/** 投票榜：身份识别 + 筛选 + 投票 */

(function () {
  const boot = App.$('#boot');
  let categories = [];
  try {
    categories = JSON.parse(boot.dataset.categories || '[]');
  } catch (e) {
    categories = [];
  }
  const voteOpen = boot.dataset.voteOpen === '1';
  const rankMode = boot.dataset.rankMode || 'votes';

  const listBox = App.$('#list');
  const pagerBox = App.$('#pager');
  const chipsBox = App.$('#chips');

  const state = {
    page: Number(App.qs('page', '1')) || 1,
    category: App.qs('category', ''),
    q: App.qs('q', ''),
    sort: App.qs('sort', rankMode),
    totalPages: 1,
    total: 0,
    maxVotes: 1,
    items: [],
    votedCount: 0,
  };

  if (!voteOpen) {
    App.$('#closed-box').hidden = false;
    App.$('#id-panel').classList.add('hidden');
  }

  /* ==================================================================
     身份
     ================================================================== */

  const idNone = App.$('#id-none');
  const idReady = App.$('#id-ready');
  const idEmail = App.$('#id-email');
  const idNick = App.$('#id-nick');
  const idNickWrap = App.$('#id-nick-wrap');
  const idWho = App.$('#id-who');
  const idVotedCount = App.$('#id-voted-count');

  function showReady(me) {
    idWho.textContent = me.nickname ? me.nickname + '（' + me.email + '）' : me.email;
    idNone.hidden = true;
    idReady.hidden = false;
  }

  function showNone() {
    idNone.hidden = false;
    idReady.hidden = true;
    idEmail.focus();
  }

  /** 检查邮箱是否已注册；已注册就记下昵称，没注册就让它填昵称 */
  async function confirmIdentity() {
    const email = idEmail.value.trim();

    if (!email) return App.err('先填邮箱');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return App.err('邮箱格式看起来不对');

    let data;
    try {
      data = await App.api('/api/mine?email=' + encodeURIComponent(email));
    } catch (err) {
      return App.err(err.message);
    }

    if (data.found) {
      if (data.banned) return App.err('这个邮箱已被封禁，如有疑问请联系管理员');
      App.setMe(email, data.nickname);
      showReady({ email: email, nickname: data.nickname });
      state.votedCount = (data.voted || []).length;
      idVotedCount.textContent = '已投 ' + state.votedCount + ' 票';
      App.ok('欢迎回来，' + data.nickname);
      return;
    }

    // 新邮箱 → 要昵称
    const nick = idNick.value.trim();
    if (!nick) {
      idNickWrap.hidden = false;
      idNick.focus();
      return App.err('这个邮箱是第一次来，先取个昵称');
    }
    if (nick.length < 2 || nick.length > 16) return App.err('昵称要 2~16 个字');

    App.setMe(email, nick);
    showReady({ email: email, nickname: nick });
    state.votedCount = 0;
    idVotedCount.textContent = '还未投过票';
    App.ok('身份已记下');
  }

  App.$('#id-go').addEventListener('click', confirmIdentity);

  App.$('#id-change').addEventListener('click', function () {
    App.clearMe();
    idNick.value = '';
    idNickWrap.hidden = true;
    showNone();
  });

  idEmail.value = App.qs('email', '');
  const me0 = App.getMe();
  if (me0.email) {
    idEmail.value = me0.email;
    showReady(me0);
  } else {
    showNone();
  }

  /* ==================================================================
     筛选控件
     ================================================================== */

  function renderChips() {
    App.clear(chipsBox);
    const all = App.el('span', { class: 'chip' + (state.category ? '' : ' is-active'), text: '全部' });
    all.addEventListener('click', function () {
      setFilter({ category: '' });
    });
    chipsBox.appendChild(all);

    categories.forEach(function (c) {
      const chip = App.el('span', {
        class: 'chip' + (state.category === c ? ' is-active' : ''),
        text: c,
      });
      chip.addEventListener('click', function () {
        setFilter({ category: state.category === c ? '' : c });
      });
      chipsBox.appendChild(chip);
    });
  }

  const sortBtn = App.$('#sort-btn');
  function renderSortBtn() {
    sortBtn.textContent = state.sort === 'newest' ? '按时间排' : '按票数排';
    sortBtn.dataset.sort = state.sort;
  }

  sortBtn.addEventListener('click', function () {
    setFilter({ sort: state.sort === 'newest' ? 'votes' : 'newest' });
  });

  const qInput = App.$('#q');
  qInput.value = state.q;
  let qTimer = null;
  qInput.addEventListener('input', function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () {
      setFilter({ q: qInput.value.trim() });
    }, 320);
  });

  function setFilter(patch) {
    if (patch.category !== undefined) state.category = patch.category;
    if (patch.q !== undefined) state.q = patch.q;
    if (patch.sort !== undefined) state.sort = patch.sort;
    state.page = 1;
    App.setQs({
      category: state.category,
      q: state.q,
      sort: state.sort === rankMode ? '' : state.sort,
      page: '',
    });
    renderChips();
    renderSortBtn();
    load();
  }

  /* ==================================================================
     列表
     ================================================================== */

  function rankClass(rank) {
    return rank <= 3 ? ' px-card--rank' + rank : '';
  }

  function barClass(rank) {
    if (rank === 1) return ' votebar--gold';
    if (rank === 2) return ' votebar--sky';
    return '';
  }

  function renderList() {
    App.clear(listBox);

    if (!state.items.length) {
      listBox.appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: state.q || state.category ? '没有匹配的建议' : '投票榜还是空的' }),
          App.el('div', {
            class: 'fs1 muted',
            text: state.q || state.category ? '换个关键词或分类试试。' : '通过审核的建议会出现在这里。',
          }),
        ])
      );
      return;
    }

    state.items.forEach(function (item) {
      listBox.appendChild(buildCard(item));
    });
  }

  function buildCard(item) {
    const pct = Math.max(3, Math.round((item.voteCount / state.maxVotes) * 100));

    const bar = App.el('div', { class: 'votebar' + barClass(item.rank) }, [
      App.el('div', { class: 'votebar__fill', style: 'width:' + pct + '%' }),
    ]);

    const count = App.el('div', { class: 'votecount' + (item.rank === 1 ? ' votecount--gold' : item.rank === 2 ? ' votecount--sky' : '') });
    count.appendChild(App.el('span', { text: String(item.voteCount) }));
    count.appendChild(App.el('small', { text: '票' }));

    const actions = App.el('div', { class: 'vote-actions' });

    if (item.voted) {
      actions.appendChild(App.el('span', { class: 'voted-mark', text: '✓ 已投票' }));
    } else {
      const btn = App.el('button', { class: 'px-btn px-btn--primary', type: 'button', text: '投一票' });
      btn.addEventListener('click', function () {
        castVote(item, btn);
      });
      actions.appendChild(btn);
    }

    const card = App.el('article', {
      class: 'px-card' + rankClass(item.rank),
      id: 's-' + item.id,
    }, [
      App.el('div', { class: 'px-card__rank' }, [
        App.el('span', { text: String(item.rank) }),
        App.el('small', { text: '名' }),
      ]),
      App.el('div', { class: 'px-card__main' }, [
        App.el('h3', { class: 'px-card__title', text: item.title }),
        App.el('div', { class: 'px-card__meta' }, [
          App.el('span', { html: App.catBadge(item.category) }),
          App.el('span', { text: 'by ' + item.author }),
          App.el('span', { text: App.timeAgo(item.createdAt) }),
        ]),
        App.el('p', { class: 'px-card__body clamp-3 mt2', text: item.body }),
        bar,
      ]),
      App.el('div', { class: 'px-card__side' }, [count, actions]),
    ]);

    return card;
  }

  function recomputeMax() {
    state.maxVotes = state.items.reduce(function (m, it) {
      return Math.max(m, it.voteCount);
    }, 1);
  }

  /** 投票成功后局部更新，不整页重绘（保住滚动位置） */
  function applyVote(id, voteCount) {
    const item = state.items.find(function (x) {
      return x.id === id;
    });
    if (item) {
      item.voteCount = voteCount;
      item.voted = true;
    }
    recomputeMax();
    renderList();
  }

  async function castVote(item, btn) {
    const me = App.getMe();
    if (!me.email) {
      App.err('先在上面填一下邮箱，才能投票');
      App.$('#id-change').click();
      return;
    }

    btn.disabled = true;
    try {
      const r = await App.vote(item.id, me.email, me.nickname);
      applyVote(item.id, r.voteCount);
      App.ok('投票成功！现在有 ' + r.voteCount + ' 票');
    } catch (err) {
      const d = err.data || {};

      if (d.duplicate) {
        applyVote(item.id, d.voteCount !== undefined ? d.voteCount : item.voteCount);
        App.err('你已经给这条建议投过票了');
        return;
      }
      if (d.needNickname || d.nicknameTaken) {
        App.clearMe();
        App.$('#id-change').click();
        idNickWrap.hidden = false;
        if (d.nicknameTaken) App.err('这个昵称刚被别人占用了，换一个再试');
        else App.err('这个邮箱需要先取个昵称');
        return;
      }
      if (d.banned) {
        App.err(err.message);
        return;
      }
      App.err(err.message);
      btn.disabled = false;
    }
  }

  /* ==================================================================
     分页
     ================================================================== */

  function renderPager() {
    pagerBox.innerHTML = '';

    if (state.totalPages > 1) {
      const nav = App.el('div', { class: 'row' });
      nav.innerHTML = App.pager(state.page, state.totalPages, function (p) {
        const params = new URLSearchParams();
        if (state.category) params.set('category', state.category);
        if (state.q) params.set('q', state.q);
        if (state.sort !== rankMode) params.set('sort', state.sort);
        if (p > 1) params.set('page', String(p));
        const qs = params.toString();
        return location.pathname + (qs ? '?' + qs : '');
      });
      // 让分页链接走 SPA 逻辑，避免整页刷新
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

    pagerBox.appendChild(
      App.el('div', {
        class: 'pager__info',
        text: '共 ' + state.total + ' 条建议 · 第 ' + state.page + ' / ' + state.totalPages + ' 页',
      })
    );
  }

  /* ==================================================================
     加载
     ================================================================== */

  function renderSkeleton() {
    App.clear(listBox);
    for (let i = 0; i < 3; i += 1) {
      listBox.appendChild(App.el('div', { class: 'skeleton', style: 'height:170px;border:3px solid #14111f' }));
    }
  }

  async function load() {
    renderSkeleton();
    const me = App.getMe();

    const params = new URLSearchParams();
    params.set('page', String(state.page));
    params.set('pageSize', '10');
    params.set('sort', state.sort);
    if (state.category) params.set('category', state.category);
    if (state.q) params.set('q', state.q);
    if (me.email) params.set('email', me.email);

    try {
      const data = await App.api('/api/suggestions?' + params.toString());
      state.items = data.items;
      state.total = data.total;
      state.totalPages = data.totalPages;
      state.page = data.page;
      state.sort = data.sort;
      recomputeMax();
      renderList();
      renderPager();

      const voted = data.items.filter(function (x) {
        return x.voted;
      }).length;
      if (me.email && voted) {
        idVotedCount.textContent = '本页已投 ' + voted + ' 条';
      }
    } catch (err) {
      App.clear(listBox).appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '加载失败' }),
          App.el('div', { class: 'fs1 muted', text: err.message }),
        ])
      );
    }
  }

  /* ==================================================================
     启动
     ================================================================== */

  renderChips();
  renderSortBtn();

  if (voteOpen) load();

  // 从首页 Top3 跳过来会带 #s-<id>，滚过去并闪一下
  if (location.hash && /^#s-\d+$/.test(location.hash)) {
    setTimeout(function () {
      const node = App.$(location.hash);
      if (node) {
        node.scrollIntoView({ block: 'center' });
        node.style.outline = 'var(--bd) solid var(--c-gold)';
        setTimeout(function () {
          node.style.outline = '';
        }, 1400);
      }
    }, 400);
  }
})();
