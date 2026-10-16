'use strict';

/**
 * 造一批演示数据，用来预览界面。
 *   node scripts/seed-demo.js          已有数据时会拒绝执行
 *   node scripts/seed-demo.js --force  先清空再灌
 *
 * 生产环境别跑这个。
 */

const db = require('../src/db');
const u = require('../src/util');

const force = process.argv.includes('--force');

require('../src/node-boot').boot();

const existing = Number(db.get('SELECT COUNT(*) AS c FROM suggestions').c);
if (existing > 0 && !force) {
  console.log(`数据库里已经有 ${existing} 条建议了。`);
  console.log('如果确实要重灌演示数据，加 --force（会清空现有建议、玩家和投票）。');
  process.exit(0);
}

/* ------------------------------ 演示数据 ------------------------------ */

const PLAYERS = [
  ['pixelfan@example.com', '像素老哥'],
  ['moonlit@example.com', '月下挖矿'],
  ['carrot@example.com', '胡萝卜骑士'],
  ['zzz@example.com', '熬夜打游戏'],
  ['lantern@example.com', '提灯人'],
  ['anvil@example.com', '铁砧师傅'],
  ['soda@example.com', '汽水加冰'],
  ['thorn@example.com', '荆棘小路'],
  ['echo@example.com', '回声洞穴'],
  ['mossy@example.com', '长苔的石头'],
];

// [标题, 分类, 正文, 状态, 基础票数, 拒绝理由]
const SUGGESTIONS = [
  [
    '加入自动整理背包按钮',
    '玩法',
    '每次挖完矿回城都要手动一个个挪，背包满了还得反复开箱子。希望有一个「一键整理」按钮，按类型自动归类，能省下大量重复操作的时间。',
    'approved',
    42,
  ],
  [
    'Boss 战前增加存档点',
    '玩法',
    '第三个 Boss 前面的路太长了，每次打不过就要重跑两分钟的路。希望在 Boss 房门口放一个存档点，不然挫败感真的很强。',
    'approved',
    37,
  ],
  [
    '夜间场景再加一层环境音',
    '音乐音效',
    '白天的虫鸣很好听，但到了晚上只剩风声，安静得有点出戏。想加一点点远处的猫头鹰叫或者水流声，让夜里的氛围更厚一些。',
    'approved',
    28,
  ],
  [
    '手柄支持按键自定义',
    '玩法',
    '现在手柄的键位是固定的，我的手比较小按不到 RB。如果能自己改键位就完美了，很多同类游戏都有这个功能。',
    'approved',
    25,
  ],
  [
    '给 NPC 加上日程表',
    '玩法',
    '镇上的 NPC 一天到晚站在同一个地方，希望能像某些农场游戏那样，白天去开店、晚上回家，跟着时间走动，镇子会活起来。',
    'approved',
    21,
  ],
  [
    '困难模式想加个死亡惩罚开关',
    '平衡性',
    '困难模式死了掉一半金币有点太狠了，希望能在设置里单独关掉这一条，其它难度不变。手残玩家也想体验剧情。',
    'approved',
    17,
  ],
  [
    '背包里的药水显示剩余次数',
    '美术',
    '药水堆叠在一起看不出还剩几瓶，每次都要点开确认。希望图标角落能加一个小小的数字角标。',
    'approved',
    12,
  ],
  [
    '希望加入钓鱼小游戏',
    '玩法',
    '地图上那么多水域现在只能游过去，感觉浪费了。想加一个简单的钓鱼系统，能钓到食材和稀有装饰品。',
    'approved',
    9,
  ],
  [
    '第二关的跳跃手感偏飘',
    '平衡性',
    '第二关的浮空平台之间距离有点尴尬，起跳后总感觉落点差一点点。希望稍微降低一点滞空时间，或者把平台间的距离拉近一点。',
    'pending',
    0,
  ],
  [
    '增加一个宠物跟随系统',
    '玩法',
    '想让抓到的怪物幼崽能跟在身后，不参与战斗但会帮忙捡掉落物。纯观赏也行，主要是陪伴感。',
    'pending',
    0,
  ],
  [
    '中文文本里有几处错别字',
    'Bug 反馈',
    '第三章铁匠的对话里「锻造」写成了「锻练」，另外道具描述里「恢复」写成了「恢愎」。麻烦校对一下。',
    'pending',
    0,
  ],
  [
    '把手机号绑定加到登录里',
    '其他',
    '想直接用手机号登录，这样换设备就不用记邮箱了，顺便可以绑定一下微信方便分享。',
    'rejected',
    0,
    '这个系统只做建议收集，不涉及游戏账号体系，请到游戏内反馈登录相关问题。',
  ],
  [
    '一键全屏秒杀所有敌人',
    '其他',
    '希望加一个作弊按钮，按一下全场敌人都死掉，方便我快速通关看结局。',
    'rejected',
    0,
    '会破坏游戏的核心体验，不做。想快速看剧情可以试试简单模式。',
  ],
  [
    '一键整理背包已经做进 1.3 版本了',
    '玩法',
    '1.3 版本加入了背包一键整理和按类型筛选，顺手也把药水的数量角标加上了。感谢每一位投票和留言的玩家。',
    'done',
    42,
  ],
  [
    'Boss 房门口的存档点已上线',
    '玩法',
    '1.3 版本在每个 Boss 房门口都放了篝火存档点，失误重来的路缩短到几秒钟。',
    'done',
    37,
  ],
  [
    '手柄改键已经在做了',
    '玩法',
    '1.4 版本会加入完整的按键自定义，包括摇杆死区调节，敬请期待。',
    'done',
    25,
  ],
  [
    '夜间环境音重制完成',
    '音乐音效',
    '重录了一版夜间环境音，加入了远处的虫鸣和水流，戴上耳机效果更明显。',
    'done',
    28,
  ],
];

/* ------------------------------ 写入 ------------------------------ */

const now = Date.now();
const DAY = 86400000;

db.tx(() => {
  if (force) {
    db.run('DELETE FROM votes');
    db.run('DELETE FROM suggestions');
    db.run('DELETE FROM players');
    db.run('DELETE FROM ip_events');
    db.run("DELETE FROM settings WHERE setting_key IN ('screenshots')");
  }

  // 玩家
  const playerIds = {};
  PLAYERS.forEach(([email, nickname], i) => {
    const createdAt = now - (PLAYERS.length - i) * 2 * DAY;
    const r = db.run(
      `INSERT INTO players (email, nickname, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?)`,
      email,
      nickname,
      createdAt,
      createdAt,
      `203.0.113.${10 + i}`
    );
    playerIds[nickname] = Number(r.lastInsertRowid);
  });

  const nicknames = Object.keys(playerIds);

  // 再补一批「路人玩家」，否则 10 个人最多只能投出 10 票，排行榜会全是并列
  const FILLER = 70;
  for (let i = 0; i < FILLER; i += 1) {
    const nickname = `路人${String(i + 1).padStart(3, '0')}`;
    const createdAt = now - Math.floor(Math.random() * 30 * DAY);
    const r = db.run(
      `INSERT INTO players (email, nickname, created_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?)`,
      `demo${String(i + 1).padStart(3, '0')}@example.com`,
      nickname,
      createdAt,
      createdAt,
      `198.51.100.${(i % 250) + 1}`
    );
    playerIds[nickname] = Number(r.lastInsertRowid);
    nicknames.push(nickname);
  }

  // 建议
  const suggestionIds = [];
  SUGGESTIONS.forEach(([title, category, body, status, baseVotes, rejectReason], i) => {
    const author = nicknames[i % nicknames.length];
    const createdAt = now - (SUGGESTIONS.length - i) * 8 * 3600 * 1000;
    const reviewedAt = status === 'pending' ? null : createdAt + 6 * 3600 * 1000;
    const doneAt = status === 'done' ? reviewedAt + 5 * DAY : null;

    const r = db.run(
      `INSERT INTO suggestions
         (title, body, category, author_id, status, reject_reason, vote_count,
          created_at, reviewed_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      title,
      body,
      category,
      playerIds[author],
      status,
      rejectReason || null,
      createdAt,
      reviewedAt,
      doneAt
    );
    suggestionIds.push({ id: Number(r.lastInsertRowid), votes: baseVotes, status });
  });

  // 投票：按目标票数随机挑不重复的玩家
  let totalVotes = 0;
  suggestionIds.forEach(({ id, votes }) => {
    if (votes <= 0) return;
    const pool = [...nicknames];
    // 打乱
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const voters = pool.slice(0, Math.min(votes, pool.length));
    voters.forEach((nick, k) => {
      const at = now - Math.floor(Math.random() * 12 * DAY);
      const ins = db.run(
        `INSERT INTO votes (suggestion_id, player_id, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(suggestion_id, player_id) DO NOTHING`,
        id,
        playerIds[nick],
        `203.0.113.${10 + (k % 10)}`,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Demo',
        at
      );
      if (Number(ins.changes) > 0) totalVotes += 1;
    });
  });

  // 演示数据的票数按实际写入量重算，保证缓存与明细一致
  for (const { id } of suggestionIds) db.recountSuggestion(id);

  // 演示站点文案，让首页有内容可看
  db.setSetting('game_name', '像素大陆');
  db.setSetting('site_title', '建议投票站');
  db.setSetting('tagline', '你的每一个想法，都可能出现在下个版本里');
  db.setSetting('hero_sub', '提交建议 · 投票 · 见证它被实现');
  db.setSetting('footer_text', '由玩家共同建设 · 当前版本 1.3.2');
});

const counts = {
  players: Number(db.get('SELECT COUNT(*) AS c FROM players').c),
  suggestions: Number(db.get('SELECT COUNT(*) AS c FROM suggestions').c),
  votes: Number(db.get('SELECT COUNT(*) AS c FROM votes').c),
};

console.log('演示数据已写入：');
console.log(`  玩家 ${counts.players} 位`);
console.log(`  建议 ${counts.suggestions} 条（含待审 / 通过 / 拒绝 / 已完成）`);
console.log(`  投票 ${counts.votes} 张`);
console.log('');
console.log('现在可以 npm start，打开 http://127.0.0.1:3210/ 看效果。');

db.close();
