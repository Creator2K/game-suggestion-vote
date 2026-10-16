'use strict';

/** 查我的建议 */

(function () {
  const emailInput = App.$('#m-email');
  const goBtn = App.$('#m-go');
  const result = App.$('#result');

  const me = App.getMe();
  emailInput.value = me.email || App.qs('email', '');

  function placeholder(title, text) {
    return App.el('div', { class: 'px-empty' }, [
      App.el('div', { class: 'px-empty__title', text: title }),
      App.el('div', { class: 'fs1 muted', text: text }),
    ]);
  }

  /* ---------------------------- 单条建议 ---------------------------- */

  function buildItem(item) {
    const meta = App.el('div', { class: 'px-card__meta' }, [
      App.el('span', { html: App.statusBadge(item.status) }),
      App.el('span', { html: App.catBadge(item.category) }),
      App.el('span', { text: App.fmtDateTime(item.createdAt) + ' 提交' }),
      item.status === 'approved' || item.status === 'done'
        ? App.el('span', { text: item.voteCount + ' 票' })
        : null,
    ]);

    const children = [
      App.el('div', { class: 'mine-item__title', text: item.title }),
      meta,
    ];

    children.push(App.el('p', { class: 'px-card__body clamp-3 mt2', text: item.body }));

    if (item.status === 'rejected' && item.rejectReason) {
      children.push(App.el('div', { class: 'reject-box', text: '被拒绝的原因：' + item.rejectReason }));
    }
    if (item.status === 'done' && item.doneNote) {
      children.push(App.el('div', { class: 'done-note', text: '实现说明：' + item.doneNote }));
    }

    const side = App.el('div', { class: 'px-card__side' });
    if (item.status === 'approved') {
      side.appendChild(
        App.el('a', { class: 'px-btn px-btn--sm', href: '/vote#s-' + item.id, text: '去拉票' })
      );
    } else if (item.status === 'done') {
      side.appendChild(App.el('span', { class: 'done-stamp', text: '已实现' }));
    } else if (item.status === 'pending') {
      side.appendChild(App.el('span', { class: 'px-badge px-badge--pending', text: '等待审核' }));
    }

    return App.el('div', { class: 'mine-item' }, [
      App.el('div', { class: 'mine-item__main' }, children),
      side,
    ]);
  }

  /* ---------------------------- 渲染结果 ---------------------------- */

  function render(data, email) {
    App.clear(result);

    if (!data.found) {
      result.appendChild(
        placeholder(
          '这个邮箱还没有提交过任何建议',
          '检查一下邮箱是否和提交时填的一致；如果还没提过，去提交一条试试。'
        )
      );
      result.appendChild(
        App.el('p', { class: 'center mt4' }, [
          App.el('a', { class: 'px-btn px-btn--primary', href: '/submit?email=' + encodeURIComponent(email), text: '提交一条建议' }),
        ])
      );
      return;
    }

    const counts = { pending: 0, approved: 0, rejected: 0, done: 0 };
    data.items.forEach(function (it) {
      if (counts[it.status] !== undefined) counts[it.status] += 1;
    });

    // 顶部概要
    const summary = App.el('div', { class: 'mine-summary' }, [
      App.el('span', { class: 'identity__who', text: data.nickname }),
      App.el('span', { class: 'px-badge px-badge--muted', text: '待审核 ' + counts.pending }),
      App.el('span', { class: 'px-badge px-badge--approved', text: '投票中 ' + counts.approved }),
      App.el('span', { class: 'px-badge px-badge--done', text: '已实现 ' + counts.done }),
      App.el('span', { class: 'px-badge px-badge--rejected', text: '被拒 ' + counts.rejected }),
    ]);
    result.appendChild(summary);

    if (data.banned) {
      result.appendChild(
        App.el('div', { class: 'notice mb4' }, [
          App.el('span', { class: 'notice__mark', text: '【已封禁】' }),
          App.el('span', { text: '这个邮箱已被禁止操作' + (data.banReason ? '：' + data.banReason : '') }),
        ])
      );
    }

    // 我提交的
    result.appendChild(App.el('h2', { class: 'px-section-title', text: '我提交的建议（' + data.items.length + '）' }));

    if (!data.items.length) {
      result.appendChild(placeholder('还没有提交过建议', '上面有「提交建议」入口。'));
    } else {
      data.items.forEach(function (item) {
        result.appendChild(buildItem(item));
      });
    }

    // 我投过的
    result.appendChild(App.el('h2', { class: 'px-section-title mt5', text: '我投过票的（' + data.voted.length + '）' }));

    if (!data.voted.length) {
      result.appendChild(placeholder('还没投过票', '去投票榜给你最想要的那条投一票吧。'));
    } else {
      const list = App.el('div', { class: 'stack' });
      data.voted.forEach(function (v) {
        list.appendChild(
          App.el('div', { class: 'mine-item' }, [
            App.el('div', { class: 'mine-item__main' }, [
              App.el('div', { class: 'mine-item__title', text: v.title }),
              App.el('div', { class: 'px-card__meta' }, [
                App.el('span', { html: App.statusBadge(v.status) }),
                App.el('span', { html: App.catBadge(v.category) }),
                App.el('span', { text: v.voteCount + ' 票' }),
                App.el('span', { text: App.timeAgo(v.createdAt) }),
              ]),
            ]),
            App.el('div', { class: 'px-card__side' }, [
              App.el('a', {
                class: 'px-btn px-btn--sm',
                href: v.status === 'done' ? '/done#s-' + v.id : '/vote#s-' + v.id,
                text: '查看',
              }),
            ]),
          ])
        );
      });
      result.appendChild(list);
    }
  }

  /* ---------------------------- 查询 ---------------------------- */

  async function query() {
    const email = emailInput.value.trim();
    if (!email) return App.err('先填邮箱');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return App.err('邮箱格式看起来不对');

    goBtn.disabled = true;
    App.clear(result).appendChild(App.el('div', { class: 'skeleton', style: 'height:120px' }));

    try {
      const data = await App.api('/api/mine?email=' + encodeURIComponent(email));
      App.setMe(email, data.nickname || App.getMe().nickname);
      App.setQs({ email: email });
      render(data, email);
    } catch (err) {
      App.clear(result).appendChild(placeholder('查询失败', err.message));
    } finally {
      goBtn.disabled = false;
    }
  }

  goBtn.addEventListener('click', query);
  emailInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') query();
  });

  if (emailInput.value) query();
})();
