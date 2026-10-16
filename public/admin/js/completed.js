'use strict';

/** 已完成列表管理：改实现说明、撤销完成 */

(function () {
  const listBox = App.$('#list');
  const pagerBox = App.$('#pager');
  const qInput = App.$('#q');
  const catSel = App.$('#category');

  const state = {
    q: '',
    category: '',
    page: 1,
    totalPages: 1,
    total: 0,
    items: [],
    categories: [],
  };

  function render() {
    App.clear(listBox);

    if (!state.items.length) {
      listBox.appendChild(
        App.el('div', { class: 'px-empty' }, [
          App.el('div', { class: 'px-empty__title', text: '还没有已实现的建议' }),
          App.el('div', { class: 'fs1 muted', text: '在「建议管理」里把投票中的建议标记为完成，就会出现在这里。' }),
          App.el('div', { class: 'mt4' }, [
            App.el('a', { class: 'px-btn px-btn--gold', href: '/admin/suggestions?status=approved', text: '去处理投票中的建议' }),
          ]),
        ])
      );
      return;
    }

    state.items.forEach(function (item) {
      const noteBox = App.el('div', { class: 'done-note mt2', text: item.adminNote || '（还没有填写实现说明）' });

      const editNoteBtn = App.el('button', { class: 'px-btn px-btn--sm', type: 'button', text: '改实现说明' });
      editNoteBtn.addEventListener('click', function () {
        editNote(item);
      });

      const undoneBtn = App.el('button', { class: 'px-btn px-btn--sm px-btn--ghost', type: 'button', text: '撤销完成' });
      undoneBtn.addEventListener('click', function () {
        undone(item);
      });

      const viewLink = App.el('a', {
        class: 'px-btn px-btn--sm',
        href: '/done#s-' + item.id,
        target: '_blank',
        rel: 'noopener',
        text: '查看 ↗',
      });

      listBox.appendChild(
        App.el('article', { class: 'px-panel', id: 's-' + item.id }, [
          App.el('div', { class: 'row row--between mb2' }, [
            App.el('h2', { class: 'px-card__title', text: item.title }),
            App.el('span', { class: 'px-badge px-badge--done', text: '已实现' }),
          ]),
          App.el('div', { class: 'px-card__meta' }, [
            App.el('span', { class: 'px-badge px-badge--muted', text: '#' + item.id }),
            App.el('span', { html: App.catBadge(item.category) }),
            App.el('span', { text: item.author + ' 提出' }),
            App.el('span', { text: item.voteCount + ' 票支持' }),
            item.doneAt ? App.el('span', { text: App.fmtDate(item.doneAt) + ' 完成' }) : null,
          ]),
          App.el('p', { class: 'px-card__body clamp-3 mt2', text: item.body }),
          noteBox,
          App.el('div', { class: 'row row--wrap mt3' }, [
            editNoteBtn,
            undoneBtn,
            App.el('div', { class: 'spacer' }),
            viewLink,
          ]),
        ])
      );
    });
  }

  async function editNote(item) {
    const note = await Admin.prompt({
      title: '实现说明',
      text: '会公开显示在「已实现」页，告诉玩家具体做成了什么样。',
      label: '实现说明',
      placeholder: '例如：1.4 版本已加入，在设置里可以开关',
      maxlength: 300,
      multiline: true,
      okText: '保存',
    });
    if (note === null) return;

    try {
      await Admin.api('/suggestions/' + item.id, { method: 'PATCH', body: { adminNote: note } });
      App.ok('已保存实现说明');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function undone(item) {
    const yes = await Admin.confirm({
      title: '撤销完成？',
      text: '「' + item.title + '」会从「已实现」页移除，重新回到投票榜。',
      okText: '撤销完成',
    });
    if (!yes) return;

    try {
      await Admin.api('/suggestions/' + item.id + '/undone', { method: 'POST', body: {} });
      App.ok('已撤销，建议回到投票榜');
      load(true);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function load(keepPage) {
    if (!keepPage) state.page = 1;
    App.clear(listBox).appendChild(App.el('div', { class: 'skeleton', style: 'height:180px' }));

    const params = new URLSearchParams();
    params.set('status', 'done');
    params.set('sort', 'newest');
    params.set('page', String(state.page));
    params.set('pageSize', '15');
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);

    try {
      const data = await Admin.api('/suggestions?' + params.toString());
      state.items = data.items;
      state.page = data.page;
      state.totalPages = data.totalPages;
      state.total = data.total;
      render();
      Admin.pager(pagerBox, data.page, data.totalPages, data.total, function (p) {
        state.page = p;
        load(true);
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    } catch (err) {
      App.err(err.message);
    }
  }

  App.$('#search-btn').addEventListener('click', function () {
    state.q = qInput.value.trim();
    load();
  });
  qInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      state.q = qInput.value.trim();
      load();
    }
  });
  catSel.addEventListener('change', function () {
    state.category = catSel.value;
    load();
  });

  Admin.boot({
    onReady: async function (me) {
      state.categories = (me.config && me.config.categories) || [];
      state.categories.forEach(function (c) {
        catSel.appendChild(App.el('option', { value: c, text: c }));
      });
      await load();
    },
  });
})();
