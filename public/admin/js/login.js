'use strict';

/** 后台登录 / 首次设置管理员密码 */

(function () {
  const title = App.$('#box-title');
  const sub = App.$('#box-sub');
  const form = App.$('#login-form');
  const pw = App.$('#pw');
  const pwWrap = App.$('#pw-wrap');
  const pw2 = App.$('#pw2');
  const pw2Wrap = App.$('#pw2-wrap');
  const pwHint = App.$('#pw-hint');
  const go = App.$('#go');

  let needSetup = false;

  Admin.boot({
    requiresAuth: false,
    onReady: function (state) {
      needSetup = !state.initialized;

      if (needSetup) {
        title.textContent = '设置管理员密码';
        sub.textContent = '这是第一次启动，先给后台设一个密码';
        pw2Wrap.hidden = false;
        pwHint.hidden = false;
        go.textContent = '设置并进入后台';
        pw.setAttribute('autocomplete', 'new-password');
      } else {
        // 已登录的话直接进后台
        if (state.loggedIn) {
          location.replace('/admin');
          return;
        }
        pw.focus();
      }
    },
  });

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const password = pw.value;

    if (!password) return App.err('请输入密码');

    if (needSetup) {
      if (password !== pw2.value) return App.err('两次输入的密码不一致');
      if (password.length < 8) return App.err('密码至少 8 位');
    }

    go.disabled = true;
    go.textContent = '处理中…';

    try {
      const path = needSetup ? '/setup' : '/login';
      await Admin.api(path, { method: 'POST', body: { password: password } });
      location.replace('/admin');
    } catch (err) {
      App.err(err.message);
      pw.value = '';
      pw.focus();
      go.disabled = false;
      go.textContent = needSetup ? '设置并进入后台' : '登录';
    }
  });
})();
