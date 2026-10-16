'use strict';

/** 提交建议页 */

(function () {
  const boot = App.$('#boot');
  const maxTitle = Number(boot.dataset.maxTitle) || 60;
  const maxBody = Number(boot.dataset.maxBody) || 500;
  const submitOpen = boot.dataset.submitOpen === '1';

  let categories = [];
  try {
    categories = JSON.parse(boot.dataset.categories || '[]');
  } catch (e) {
    categories = [];
  }

  const form = App.$('#submit-form');
  const fNickname = App.$('#f-nickname');
  const fEmail = App.$('#f-email');
  const fCategory = App.$('#f-category');
  const fTitle = App.$('#f-title');
  const fBody = App.$('#f-body');
  const btn = App.$('#f-submit');
  const state = App.$('#form-state');
  const cTitle = App.$('#c-title');
  const cBody = App.$('#c-body');

  /* ---------------------------- 初始化 ---------------------------- */

  categories.forEach(function (c) {
    fCategory.appendChild(App.el('option', { value: c, text: c }));
  });

  const me = App.getMe();
  fEmail.value = me.email || App.qs('email');
  fNickname.value = me.nickname || '';

  if (!submitOpen) {
    App.$('#closed-box').hidden = false;
    App.$('#form-panel').classList.add('hidden');
    App.$('#tips-panel').classList.add('hidden');
  }

  /* ---------------------------- 字数计数 ---------------------------- */

  function bindCounter(input, node, max) {
    const update = function () {
      const len = input.value.length;
      node.textContent = len + ' / ' + max;
      node.classList.toggle('is-over', len > max);
    };
    input.addEventListener('input', update);
    update();
  }

  bindCounter(fTitle, cTitle, maxTitle);
  bindCounter(fBody, cBody, maxBody);

  /* ---------------------------- 提交 ---------------------------- */

  function setState(text) {
    state.textContent = text || '';
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    setState('');

    const nickname = fNickname.value.trim();
    const email = fEmail.value.trim();
    const category = fCategory.value;
    const title = fTitle.value.trim();
    const body = fBody.value.trim();

    // 前端先挡一道，省得白跑一趟
    if (!nickname) return App.err('请填写昵称');
    if (!email) return App.err('请填写邮箱');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return App.err('邮箱格式看起来不对');
    if (title.length < 4) return App.err('标题至少 4 个字');
    if (body.length < 10) return App.err('详细说明至少 10 个字');

    btn.disabled = true;
    setState('正在提交…');

    try {
      await App.api('/api/submit', {
        method: 'POST',
        body: { email: email, nickname: nickname, category: category, title: title, body: body },
      });

      App.setMe(email, nickname);
      App.$('#receipt-text').textContent = '「' + title + '」已经进入审核队列。';
      App.$('#form-panel').classList.add('hidden');
      App.$('#tips-panel').classList.add('hidden');
      App.$('#receipt').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'auto' });
      App.ok('提交成功');
    } catch (err) {
      setState('');
      const d = err.data || {};

      if (d.nicknameTaken) {
        fNickname.focus();
        fNickname.select();
        App.err('这个昵称已经被占用了，换一个吧');
      } else if (d.needNickname) {
        fNickname.focus();
        App.err('新邮箱需要先取一个昵称');
      } else {
        App.err(err.message);
      }
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------------------- 再提一条 ---------------------------- */

  App.$('#again-btn').addEventListener('click', function () {
    fTitle.value = '';
    fBody.value = '';
    fTitle.dispatchEvent(new Event('input'));
    fBody.dispatchEvent(new Event('input'));
    App.$('#receipt').classList.add('hidden');
    App.$('#form-panel').classList.remove('hidden');
    App.$('#tips-panel').classList.remove('hidden');
    fTitle.focus();
  });
})();
