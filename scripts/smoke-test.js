'use strict';

/**
 * 端到端冒烟测试：把玩家端和后台的主要流程全跑一遍。
 *
 *   先启动服务：npm start
 *   再另开一个终端：node scripts/smoke-test.js
 *
 * 会写入测试数据（邮箱后缀 @smoke.test）。
 * 后台密码从 SMOKE_ADMIN_PASSWORD 读，默认 smoke-admin-2026；
 * 如果后台还没初始化，脚本会直接用这个密码完成初始化。
 * 已经设过别的密码的话，先跑 node scripts/reset-password.js smoke-admin-2026。
 */

const BASE = process.env.BASE || 'http://127.0.0.1:3210';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || 'smoke-admin-2026';

let pass = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u2717 ${name}${extra ? `  \u2190 ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text, res };
}

const uid = Date.now().toString(36);
const emailA = `a-${uid}@smoke.test`;
const emailB = `b-${uid}@smoke.test`;
const nickA = `烟测甲${uid.slice(-4)}`;
const nickB = `烟测乙${uid.slice(-4)}`;

let adminCookie = null;
let csrf = null;

async function main() {
  console.log(`冒烟测试目标：${BASE}`);

  /* ------------------------------ 基础接口 ------------------------------ */

  section('1. 基础接口');
  {
    const h = await api('/healthz');
    check('healthz 返回 ok', h.status === 200 && h.json?.ok === true, `status=${h.status}`);
  }
  {
    const c = await api('/api/config');
    check(
      'config 带出站点文案',
      c.status === 200 && typeof c.json?.config?.gameName === 'string',
      c.text.slice(0, 120)
    );
    check('config 不含管理员密码哈希', !/admin_password/.test(c.text));
  }
  {
    const s = await api('/api/stats');
    check('stats 数字齐全', s.status === 200 && typeof s.json?.stats?.totalVotes === 'number');
  }
  {
    // 这里只校验响应结构和排序不变式。空库也要能通过，
    // 具体的名次断言放在有数据之后（见第 5 节）。
    const r = await api('/api/suggestions?pageSize=3');
    const items = r.json?.items || [];
    check(
      '投票榜返回正确结构',
      r.status === 200 && Array.isArray(items) && typeof r.json?.total === 'number',
      r.text.slice(0, 120)
    );
    check(
      '投票榜只返回 approved',
      items.every((it) => it.status === 'approved'),
      items.map((x) => x.status).join(',')
    );
    check(
      '投票榜按票数降序',
      items.every((it, i) => i === 0 || items[i - 1].voteCount >= it.voteCount),
      items.map((x) => x.voteCount).join(',')
    );
    check(
      '列表项带从 1 开始的连续名次',
      items.every((it, i) => it.rank === i + 1),
      items.map((x) => x.rank).join(',')
    );
  }
  {
    const r = await api('/api/suggestions?q=%25&pageSize=5');
    check('LIKE 通配符被转义（不会返回全部）', r.status === 200 && typeof r.json?.total === 'number');
  }

  /* ------------------------------ 提交建议 ------------------------------ */

  section('2. 提交建议');
  let newId = null;
  {
    const r = await api('/api/submit', {
      method: 'POST',
      body: {
        email: emailA,
        nickname: nickA,
        category: '玩法',
        title: `烟测建议 ${uid}`,
        body: '这是冒烟测试自动提交的建议正文，长度肯定超过十个字了，用来验证提交接口。',
      },
    });
    newId = r.json?.id;
    check('新玩家提交成功', r.status === 200 && r.json?.ok === true, r.text.slice(0, 160));
    check('返回了新建议 id', Number.isInteger(newId), String(newId));
  }
  {
    const r = await api('/api/submit', {
      method: 'POST',
      body: {
        email: emailA,
        nickname: nickA,
        category: '玩法',
        title: `烟测建议 ${uid}`,
        body: '这是冒烟测试自动提交的建议正文，长度肯定超过十个字了，用来验证提交接口。',
      },
    });
    check('十分钟内重复标题被拦（409）', r.status === 409, `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await api('/api/submit', {
      method: 'POST',
      body: {
        email: emailB,
        nickname: nickA,
        category: '玩法',
        title: `抢昵称 ${uid}`,
        body: '用别人已经占用的昵称来提交，应该被拒绝才对。',
      },
    });
    check('昵称被占用时拒绝（409）', r.status === 409, `status=${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await api('/api/submit', {
      method: 'POST',
      body: { email: 'not-an-email', nickname: 'x', category: '玩法', title: '短', body: '短' },
    });
    check('邮箱格式错误被拒（400）', r.status === 400, `status=${r.status}`);
  }
  {
    const r = await api('/api/submit', {
      method: 'POST',
      body: {
        email: `c-${uid}@smoke.test`,
        nickname: `烟测丙${uid.slice(-4)}`,
        category: '不存在的分类',
        title: '分类非法测试标题',
        body: '这条建议使用了一个并不存在的分类，应当被拒绝。',
      },
    });
    check('非法分类被拒（400）', r.status === 400, `status=${r.status}`);
  }

  /* ------------------------------ 审核前不能投 ------------------------------ */

  section('3. 审核前不可投票');
  {
    const r = await api('/api/vote', {
      method: 'POST',
      body: { email: emailB, nickname: nickB, suggestionId: newId },
    });
    check('待审建议投票被拒（409）', r.status === 409, `status=${r.status} ${r.text.slice(0, 120)}`);
  }

  /* ------------------------------ 后台登录 ------------------------------ */

  section('4. 后台登录');
  {
    const s = await api('/api/admin/state');
    check('state 可读取', s.status === 200);

    if (!s.json?.initialized) {
      const r = await api('/api/admin/setup', {
        method: 'POST',
        body: { password: ADMIN_PASSWORD },
      });
      check('首次设置管理员密码成功', r.status === 200, r.text.slice(0, 160));
    }

    const bad = await api('/api/admin/login', { method: 'POST', body: { password: 'wrong-password' } });
    check('错误密码被拒（401）', bad.status === 401, `status=${bad.status}`);

    const good = await api('/api/admin/login', {
      method: 'POST',
      body: { password: ADMIN_PASSWORD },
    });
    const setCookie = good.res.headers.getSetCookie?.() || [];
    adminCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    csrf = good.json?.token;
    check('正确密码登录成功', good.status === 200 && !!csrf, good.text.slice(0, 160));
    check('登录下发了 httpOnly Cookie', /pv_admin=/.test(adminCookie), adminCookie);
    check('Cookie 带 HttpOnly', /HttpOnly/i.test(setCookie.join(';')));
  }
  {
    const noCookie = await api('/api/admin/dashboard');
    check('未登录访问后台接口被拒（401）', noCookie.status === 401, `status=${noCookie.status}`);
  }
  {
    const noCsrf = await api('/api/admin/recount', { method: 'POST', cookie: adminCookie, body: {} });
    check('缺少 CSRF 头被拒（403）', noCsrf.status === 403, `status=${noCsrf.status}`);
  }

  /* ------------------------------ 审核流程 ------------------------------ */

  section('5. 审核流程');
  {
    const d = await api('/api/admin/dashboard', { cookie: adminCookie });
    check('仪表盘返回数据', d.status === 200 && !!d.json?.counts && Array.isArray(d.json?.trend));
    check('仪表盘有趋势数据', (d.json?.trend || []).length > 0);
  }
  {
    const r = await api(`/api/admin/suggestions/${newId}/approve`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: {},
    });
    check('通过审核', r.status === 200 && r.json?.status === 'approved', r.text.slice(0, 160));
  }
  {
    const list = await api('/api/suggestions?pageSize=50');
    check(
      '通过后出现在投票榜',
      (list.json?.items || []).some((x) => x.id === newId)
    );
  }
  {
    const v = await api('/api/vote', {
      method: 'POST',
      body: { email: emailB, nickname: nickB, suggestionId: newId },
    });
    check('审核通过后可以投票', v.status === 200 && v.json?.voteCount >= 1, v.text.slice(0, 160));

    const dup = await api('/api/vote', {
      method: 'POST',
      body: { email: emailB, suggestionId: newId },
    });
    check('同一邮箱重复投票被拒（409）', dup.status === 409, `status=${dup.status}`);

    const again = await api('/api/vote', {
      method: 'POST',
      body: { email: emailB, suggestionId: newId },
    });
    check('重复投票后票数没有被多算', again.json?.voteCount === v.json?.voteCount, `${again.json?.voteCount} vs ${v.json?.voteCount}`);
  }
  {
    const d = await api(`/api/admin/suggestions/${newId}/done`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { note: '烟测标记完成' },
    });
    check('标记完成', d.status === 200 && d.json?.status === 'done', d.text.slice(0, 160));

    const list = await api('/api/suggestions?pageSize=50');
    check('完成后从投票榜移除', !(list.json?.items || []).some((x) => x.id === newId));

    const done = await api('/api/done?pageSize=50');
    check('完成后进入已完成列表', (done.json?.items || []).some((x) => x.id === newId));

    const back = await api(`/api/admin/suggestions/${newId}/undone`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: {},
    });
    check('撤销完成后回到投票榜', back.status === 200 && back.json?.status === 'approved');

    const list2 = await api('/api/suggestions?pageSize=50');
    check('撤销后重新出现在投票榜', (list2.json?.items || []).some((x) => x.id === newId));
  }
  {
    // 排名：再造一条零票的建议当对照组，验证票数高的真的排在前面
    const sub = await api('/api/submit', {
      method: 'POST',
      body: {
        email: `low-${uid}@smoke.test`,
        nickname: `烟测零票${uid.slice(-4)}`,
        category: '玩法',
        title: `烟测零票对照 ${uid}`,
        body: '这条建议只用来验证排名顺序，不会获得任何投票，应当排在有一条票的建议后面。',
      },
    });
    check('创建零票对照建议', sub.status === 200 && Number.isInteger(sub.json?.id), sub.text.slice(0, 140));

    const lowId = sub.json?.id;
    if (lowId) {
      await api(`/api/admin/suggestions/${lowId}/approve`, {
        method: 'POST',
        cookie: adminCookie,
        csrf,
        body: {},
      });
    }

    const ranked = await api('/api/suggestions?pageSize=50&sort=votes');
    const items = ranked.json?.items || [];
    const idxWithVote = items.findIndex((x) => x.id === newId);
    const idxNoVote = items.findIndex((x) => x.id === lowId);

    check(
      '榜单整体按票数降序',
      items.every((it, i) => i === 0 || items[i - 1].voteCount >= it.voteCount),
      items.map((x) => x.voteCount).join(',')
    );
    check(
      '有名次连续且从 1 开始',
      items.length > 0 && items.every((it, i) => it.rank === i + 1),
      items.map((x) => x.rank).join(',')
    );
    check(
      '有票的排在零票的前面',
      idxWithVote !== -1 && idxNoVote !== -1 && idxWithVote < idxNoVote,
      `有票 index=${idxWithVote}，零票 index=${idxNoVote}`
    );

    const top = await api('/api/top?limit=50');
    const topIds = (top.json?.items || []).map((x) => x.id);
    check('Top 接口包含刚上架的建议', topIds.includes(newId), topIds.join(','));
  }

  /* ------------------------------ 拒绝与玩家可见 ------------------------------ */

  section('6. 拒绝理由对玩家可见');
  {
    const empty = await api(`/api/admin/suggestions/${newId}/reject`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { reason: '' },
    });
    check('拒绝时不填理由会被拦（400）', empty.status === 400, `status=${empty.status}`);

    const r = await api(`/api/admin/suggestions/${newId}/reject`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { reason: '烟测：这条属于重复建议' },
    });
    check('带理由拒绝成功', r.status === 200 && r.json?.status === 'rejected', r.text.slice(0, 160));

    const mine = await api(`/api/mine?email=${encodeURIComponent(emailA)}`);
    const item = (mine.json?.items || []).find((x) => x.id === newId);
    check('玩家能查到自己的建议', !!item);
    check('玩家能看见拒绝理由', item?.rejectReason === '烟测：这条属于重复建议', String(item?.rejectReason));

    const reopen = await api(`/api/admin/suggestions/${newId}/reopen`, {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: {},
    });
    check('打回待审成功', reopen.status === 200 && reopen.json?.status === 'pending');
  }

  /* ------------------------------ 编辑 ------------------------------ */

  section('7. 后台编辑建议');
  {
    const r = await api(`/api/admin/suggestions/${newId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      csrf,
      body: { title: `烟测已编辑 ${uid}` },
    });
    check('编辑标题成功', r.status === 200 && r.json?.item?.title === `烟测已编辑 ${uid}`, r.text.slice(0, 160));
    check('编辑留下了 editedAt', !!r.json?.item?.editedAt);
  }

  /* ------------------------------ 设置 ------------------------------ */

  section('8. 站点设置与限频');
  let originalRate = null;
  {
    const s = await api('/api/admin/settings', { cookie: adminCookie });
    check('读取设置成功', s.status === 200 && !!s.json?.settings);
    originalRate = Number(s.json?.settings?.rate_vote_per_hour || 30);

    const bad = await api('/api/admin/settings', {
      method: 'PUT',
      cookie: adminCookie,
      csrf,
      body: { categories: [] },
    });
    check('分类清空被拦（400）', bad.status === 400, `status=${bad.status}`);

    const ok = await api('/api/admin/settings', {
      method: 'PUT',
      cookie: adminCookie,
      csrf,
      body: { game_name: '烟测游戏名', tagline: '烟测标语', rate_vote_per_hour: 1 },
    });
    check('更新设置成功', ok.status === 200 && ok.json?.settings?.game_name === '烟测游戏名', ok.text.slice(0, 160));

    const cfg = await api('/api/config');
    check('玩家端立刻读到新文案', cfg.json?.config?.gameName === '烟测游戏名', String(cfg.json?.config?.gameName));
    const html = await fetch(`${BASE}/`);
    const text = await html.text();
    check('首页 HTML 已注入新文案（无闪烁）', text.includes('烟测游戏名'));
  }
  {
    // 限频：上面把阈值改成了 1 次/小时。
    // 注意不能断言「第一票一定通过」——同一个 IP 在一小时窗口内可能已经有历史投票，
    // 所以这里改成「连续投票，应当在很少的尝试内撞到 429」，对残留数据免疫。
    let retryAfter = null;
    let saw429 = false;
    let statuses = [];

    for (let i = 0; i < 6 && !saw429; i += 1) {
      const r = await api('/api/vote', {
        method: 'POST',
        body: {
          email: `rl${i}-${uid}@smoke.test`,
          nickname: `限频${i}${uid.slice(-3)}`,
          suggestionId: 2,
        },
      });
      statuses.push(r.status);
      if (r.status === 429) {
        saw429 = true;
        retryAfter = r.res.headers.get('retry-after');
      }
    }

    check('限频生效：连续投票最终被拒（429）', saw429, `实际状态序列 ${statuses.join(',')}`);
    check('429 带 Retry-After 头', !!retryAfter, String(retryAfter));
    check('限频期间没有出现 5xx', statuses.every((s) => s < 500), statuses.join(','));
  }
  {
    const r = await api('/api/admin/settings', {
      method: 'PUT',
      cookie: adminCookie,
      csrf,
      body: { game_name: '像素大陆', tagline: '你的每一个想法，都可能出现在下个版本里', rate_vote_per_hour: originalRate },
    });
    check('恢复原设置', r.status === 200, r.text.slice(0, 160));
  }

  /* ------------------------------ 封禁与清理 ------------------------------ */

  section('9. 封禁与刷票清理');
  {
    const add = await api('/api/admin/bans', {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { kind: 'email', value: `banned-${uid}@smoke.test`, reason: '烟测封禁' },
    });
    check('添加邮箱封禁', add.status === 200, add.text.slice(0, 160));

    const dup = await api('/api/admin/bans', {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { kind: 'email', value: `banned-${uid}@smoke.test` },
    });
    check('重复封禁被拒（409）', dup.status === 409, `status=${dup.status}`);

    const blocked = await api('/api/vote', {
      method: 'POST',
      body: { email: `banned-${uid}@smoke.test`, nickname: `封禁${uid.slice(-4)}`, suggestionId: 2 },
    });
    check('被封禁的邮箱无法操作（403）', blocked.status === 403, `status=${blocked.status} ${blocked.text.slice(0, 120)}`);

    const list = await api('/api/admin/bans', { cookie: adminCookie });
    const target = (list.json?.items || []).find((x) => x.value === `banned-${uid}@smoke.test`);
    check('封禁名单能查到', !!target);

    const del = await api(`/api/admin/bans/${target?.id}`, { method: 'DELETE', cookie: adminCookie, csrf, body: {} });
    check('解除封禁', del.status === 200, del.text.slice(0, 160));
  }
  {
    const votes = await api('/api/admin/votes?pageSize=5', { cookie: adminCookie });
    check('投票明细可查', votes.status === 200 && (votes.json?.items || []).length > 0);
    const v = votes.json?.items?.[0];
    check('明细含 IP 与邮箱', !!v?.ip && !!v?.email, JSON.stringify(v)?.slice(0, 120));
  }
  {
    const rc = await api('/api/admin/recount', { method: 'POST', cookie: adminCookie, csrf, body: {} });
    check('票数重算成功', rc.status === 200 && Number.isInteger(rc.json?.fixed), rc.text.slice(0, 160));
    check('重算后没有偏差', rc.json?.fixed === 0, `fixed=${rc.json?.fixed}`);
  }

  /* ------------------------------ 玩家与日志 ------------------------------ */

  section('10. 玩家管理与操作日志');
  {
    const p = await api('/api/admin/players?pageSize=5', { cookie: adminCookie });
    check('玩家列表可查', p.status === 200 && (p.json?.items || []).length > 0);

    const me = (p.json?.items || []).find((x) => x.nickname === nickA);
    if (me) {
      const ban = await api(`/api/admin/players/${me.id}/ban`, {
        method: 'POST',
        cookie: adminCookie,
        csrf,
        body: { reason: '烟测封禁玩家' },
      });
      check('封禁玩家成功', ban.status === 200);

      const after = await api(`/api/admin/players/${me.id}`, { cookie: adminCookie });
      check('玩家详情显示已封禁', after.json?.player?.banned === true);

      const unban = await api(`/api/admin/players/${me.id}/unban`, {
        method: 'POST',
        cookie: adminCookie,
        csrf,
        body: {},
      });
      check('解封玩家成功', unban.status === 200);
    } else {
      check('找到烟测玩家', false, '列表里没找到');
    }
  }
  {
    const l = await api('/api/admin/logs?pageSize=10', { cookie: adminCookie });
    check('操作日志可查', l.status === 200 && (l.json?.items || []).length > 0);
    check(
      '日志记录了审核动作',
      (l.json?.items || []).some((x) => x.action.startsWith('suggestion.'))
    );
  }

  /* ------------------------------ 截图上传 ------------------------------ */

  section('11. 首页截图上传');
  {
    // 1x1 的透明 PNG
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = await api('/api/admin/screenshots', {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { dataUrl: `data:image/png;base64,${png}`, caption: '烟测截图' },
    });
    check('上传截图成功', up.status === 200 && !!up.json?.screenshot?.url, up.text.slice(0, 200));

    if (up.json?.screenshot?.url) {
      const img = await fetch(BASE + up.json.screenshot.url);
      check('上传的图片可以访问', img.status === 200, `status=${img.status}`);

      const del = await api('/api/admin/screenshots', {
        method: 'DELETE',
        cookie: adminCookie,
        csrf,
        body: { id: up.json.screenshot.id },
      });
      check('删除截图成功', del.status === 200, del.text.slice(0, 160));
    }

    const fake = await api('/api/admin/screenshots', {
      method: 'POST',
      cookie: adminCookie,
      csrf,
      body: { dataUrl: 'data:image/png;base64,bm90LWEtcG5n' },
    });
    check('伪造图片（魔数不符）被拒（400）', fake.status === 400, `status=${fake.status}`);
  }

  /* ------------------------------ 登出 ------------------------------ */

  section('12. 登出');
  {
    const r = await api('/api/admin/logout', { method: 'POST', cookie: adminCookie, csrf, body: {} });
    check('登出成功', r.status === 200, r.text.slice(0, 120));

    const after = await api('/api/admin/dashboard', { cookie: adminCookie });
    check('登出后会话失效（401）', after.status === 401, `status=${after.status}`);
  }

  /* ------------------------------ 页面渲染 ------------------------------ */

  section('13. 页面可达性');
  {
    const pages = [
      ['/', 'player', 'hero__title'],
      ['/submit', 'player', 'submit-form'],
      ['/vote', 'player', 'id-panel'],
      ['/done', 'player', 'list'],
      ['/mine', 'player', 'm-email'],
      ['/admin', 'admin', 'admin__side'],
      ['/admin/login', 'admin', 'login-form'],
      ['/admin/review', 'admin', 'pending-count'],
      ['/admin/suggestions', 'admin', 'status-tabs'],
      ['/admin/completed', 'admin', 'list'],
      ['/admin/votes', 'admin', 'purge-bar'],
      ['/admin/players', 'admin', 'only-banned'],
      ['/admin/bans', 'admin', 'add-btn'],
      ['/admin/settings', 'admin', 'cat-list'],
      ['/admin/logs', 'admin', 'pager'],
    ];

    for (const [path, kind, marker] of pages) {
      const res = await fetch(BASE + path);
      const html = await res.text();
      const leftover = (html.match(/\{\{[^}]*\}\}/g) || []).length;
      const missingPartial = html.includes('缺少局部模板');
      const hasMarker = html.includes(marker);

      check(
        `${path} 正常渲染`,
        res.status === 200 && leftover === 0 && !missingPartial && hasMarker,
        `status=${res.status} 残留占位=${leftover} 缺partial=${missingPartial} 缺标记=${!hasMarker}`
      );

      // 后台页面不能被搜索引擎收录
      if (kind === 'admin') {
        check(`${path} 带 noindex`, /noindex/.test(html));
      }
    }

    // 后台页面不该引到玩家端独有的脚本
    const adminHtml = await (await fetch(BASE + '/admin')).text();
    check('后台页引用了后台 JS', adminHtml.includes('/admin/js/admin.js'));
    check('后台页没有站点页脚', !adminHtml.includes('footer__inner'));
  }

  /* ------------------------------ 结果 ------------------------------ */

  console.log(`\n${'─'.repeat(52)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${pass} 项`);
  } else {
    console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(`${'─'.repeat(52)}\n`);

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试脚本自身出错：', err);
  process.exit(2);
});
