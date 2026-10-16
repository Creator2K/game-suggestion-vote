'use strict';

/** 站点设置：文案、分类、截图、开关阈值、改密码 */

(function () {
  const TEXT_KEYS = [
    'game_name',
    'site_title',
    'tagline',
    'hero_sub',
    'announcement',
    'footer_text',
    'allowed_email_domains',
  ];
  const NUM_KEYS = [
    'rate_vote_per_hour',
    'rate_submit_per_day',
    'rate_submit_per_day_ip',
    'rate_newplayer_per_day_ip',
    'max_title_len',
    'max_body_len',
    'ai_batch_size',
  ];

  /** 常用邮箱，一键填进去 */
  const DOMAIN_PRESET = [
    'qq.com',
    '163.com',
    '126.com',
    'foxmail.com',
    'sina.com',
    'gmail.com',
    'outlook.com',
    'hotmail.com',
    'icloud.com',
  ].join(', ');

  let categories = [];
  let screenshots = [];

  /* ============================ 分类编辑 ============================ */

  function renderCategories() {
    const box = App.clear(App.$('#cat-list'));

    if (!categories.length) {
      box.appendChild(App.el('span', { class: 'fs1 muted', text: '还没有分类，至少加一个' }));
      return;
    }

    categories.forEach(function (c, i) {
      const del = App.el('span', { class: 'tag-edit__del', text: '×', title: '删除' });
      del.addEventListener('click', function () {
        categories.splice(i, 1);
        renderCategories();
      });
      box.appendChild(App.el('span', { class: 'tag-edit__item' }, [c, del]));
    });
  }

  App.$('#cat-add').addEventListener('click', function () {
    const input = App.$('#cat-new');
    const v = input.value.trim();
    if (!v) return App.err('先填分类名');
    if (v.length > 12) return App.err('分类名不能超过 12 个字');
    if (categories.includes(v)) return App.err('这个分类已经有了');
    if (categories.length >= 12) return App.err('最多 12 个分类');
    categories.push(v);
    input.value = '';
    renderCategories();
    App.ok('已添加，记得点右上角保存');
  });

  App.$('#cat-new').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      App.$('#cat-add').click();
    }
  });

  /* ============================ 截图 ============================ */

  function renderShots() {
    const box = App.clear(App.$('#shot-list'));

    if (!screenshots.length) {
      box.appendChild(
        App.el('div', { class: 'px-empty', style: 'grid-column:1/-1' }, [
          App.el('div', { class: 'fs1 muted', text: '还没有截图。上传后首页会多一个「游戏长这样」区块。' }),
        ])
      );
      return;
    }

    screenshots.forEach(function (s) {
      const captionInput = App.el('input', {
        class: 'px-input',
        type: 'text',
        maxlength: '40',
        value: s.caption || '',
        placeholder: '说明文字（可选）',
        style: 'font-size:var(--fs-1);margin-top:6px',
      });
      captionInput.addEventListener('change', function () {
        s.caption = captionInput.value.trim();
        saveShots('说明已更新');
      });

      const del = App.el('button', { class: 'px-btn px-btn--sm px-btn--danger mt2 px-btn--block', type: 'button', text: '删除这张' });
      del.addEventListener('click', async function () {
        const yes = await Admin.confirm({ title: '删除这张截图？', text: s.caption || s.url, okText: '删除', danger: true });
        if (!yes) return;
        try {
          const r = await Admin.api('/screenshots', { method: 'DELETE', body: { id: s.id } });
          screenshots = r.screenshots;
          renderShots();
          App.ok('已删除');
        } catch (err) {
          App.err(err.message);
        }
      });

      box.appendChild(
        App.el('div', { class: 'shot-manage__item' }, [
          App.el('img', { src: s.url, alt: s.caption || '截图' }),
          captionInput,
          del,
        ])
      );
    });
  }

  async function saveShots(message) {
    try {
      await Admin.api('/settings', { method: 'PUT', body: { screenshots: screenshots } });
      if (message) App.ok(message);
    } catch (err) {
      App.err(err.message);
    }
  }

  App.$('#shot-file').addEventListener('change', async function (ev) {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;

    const stateEl = App.$('#shot-state');

    for (const file of files) {
      if (screenshots.length >= 8) {
        App.err('最多 8 张，先删几张');
        break;
      }
      if (file.size > 2 * 1024 * 1024) {
        App.err(file.name + ' 超过 2MB，先压缩一下');
        continue;
      }

      stateEl.textContent = '正在上传 ' + file.name + '…';
      try {
        const dataUrl = await readAsDataURL(file);
        const r = await Admin.api('/screenshots', {
          method: 'POST',
          body: { dataUrl: dataUrl, caption: '' },
        });
        screenshots = r.screenshots;
        renderShots();
        App.ok('已上传 ' + file.name);
      } catch (err) {
        App.err(file.name + '：' + err.message);
      }
    }

    stateEl.textContent = '';
    ev.target.value = '';
  });

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  /* ============================ 读取与保存 ============================ */

  function fill(settings) {
    TEXT_KEYS.forEach(function (k) {
      const el = App.$('#' + k);
      if (el) el.value = settings[k] || '';
    });
    NUM_KEYS.forEach(function (k) {
      const el = App.$('#' + k);
      if (el) el.value = settings[k] || '';
    });
    App.$('#submit_open').checked = settings.submit_open === '1';
    App.$('#vote_open').checked = settings.vote_open === '1';
    App.$('#vote_rank_mode').value = settings.vote_rank_mode || 'votes';
    App.$('#ai_review_enabled').checked = settings.ai_review_enabled !== '0';
    App.$('#ai_retrieve_min').value = settings.ai_retrieve_min || '';

    try {
      categories = JSON.parse(settings.categories || '[]');
    } catch (e) {
      categories = [];
    }
    try {
      screenshots = JSON.parse(settings.screenshots || '[]');
    } catch (e) {
      screenshots = [];
    }

    renderCategories();
    renderShots();
  }

  async function save() {
    const body = {};

    TEXT_KEYS.forEach(function (k) {
      body[k] = App.$('#' + k).value.trim();
    });
    NUM_KEYS.forEach(function (k) {
      body[k] = Number(App.$('#' + k).value);
    });
    body.submit_open = App.$('#submit_open').checked ? '1' : '0';
    body.vote_open = App.$('#vote_open').checked ? '1' : '0';
    body.vote_rank_mode = App.$('#vote_rank_mode').value;
    body.ai_review_enabled = App.$('#ai_review_enabled').checked ? '1' : '0';
    body.ai_retrieve_min = App.$('#ai_retrieve_min').value.trim();
    body.categories = categories;
    body.screenshots = screenshots;

    const btn = App.$('#save-btn');
    btn.disabled = true;
    btn.textContent = '保存中…';

    try {
      const r = await Admin.api('/settings', { method: 'PUT', body: body });
      fill(r.settings);
      App.ok('已保存，玩家端立刻生效');
    } catch (err) {
      App.err(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '保存全部修改';
    }
  }

  App.$('#save-btn').addEventListener('click', save);

  /* ============================ 邮箱白名单 ============================ */

  App.$('#domain-preset').addEventListener('click', function () {
    const box = App.$('#allowed_email_domains');
    box.value = DOMAIN_PRESET;
    App.ok('已填入常用邮箱，记得点右上角保存');
  });

  App.$('#domain-clear').addEventListener('click', function () {
    App.$('#allowed_email_domains').value = '';
    App.ok('已清空，保存后任何邮箱都能注册');
  });

  /* ============================ 改密码 ============================ */

  App.$('#pw-btn').addEventListener('click', async function () {
    const cur = App.$('#pw-cur').value;
    const next = App.$('#pw-new').value;
    const next2 = App.$('#pw-new2').value;

    if (!cur) return App.err('请输入当前密码');
    if (next.length < 8) return App.err('新密码至少 8 位');
    if (next !== next2) return App.err('两次输入的新密码不一致');

    const yes = await Admin.confirm({
      title: '确认修改密码？',
      text: '改完之后所有后台会话会失效，需要用新密码重新登录。',
      okText: '修改',
    });
    if (!yes) return;

    try {
      await Admin.api('/password', { method: 'POST', body: { current: cur, next: next } });
      App.ok('密码已修改，正在跳转登录页');
      setTimeout(function () {
        location.replace('/admin/login');
      }, 1200);
    } catch (err) {
      App.err(err.message);
    }
  });

  /* ============================ 启动 ============================ */

  Admin.boot({
    onReady: async function () {
      try {
        const data = await Admin.api('/settings');
        fill(data.settings);
      } catch (err) {
        App.err(err.message);
      }
    },
  });
})();
