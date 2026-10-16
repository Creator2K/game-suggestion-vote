'use strict';

/**
 * 忘记管理员密码时用这个重置。
 *   node scripts/reset-password.js 新密码
 * 或者不带参数，按提示输入。
 */

const readline = require('node:readline');
const db = require('../src/db');
const u = require('../src/util');

require('../src/node-boot').boot();

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden && process.stdin.isTTY) {
      // 隐藏输入
      const onData = (char) => {
        const s = String(char);
        if (s === '\n' || s === '\r' || s === '\u0004') return;
        process.stdout.write('\r\x1b[K' + question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
      rl.question(question, (answer) => {
        process.stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

(async () => {
  let password = process.argv[2];
  if (!password) {
    password = await ask('请输入新的管理员密码：');
    const again = await ask('再输入一次确认：');
    if (password !== again) {
      console.error('两次输入不一致，已取消。');
      db.close();
      process.exitCode = 1;
      return;
    }
  }

  const err = u.validateAdminPassword(password);
  if (err) {
    console.error(`密码不合要求：${err}`);
    db.close();
    process.exitCode = 1;
    return;
  }

  const { salt, hash } = await u.hashPassword(password);
  db.setSetting('admin_password_salt', salt);
  db.setSetting('admin_password_hash', hash);
  db.run('DELETE FROM admin_sessions');
  db.logAudit({ action: 'admin.password_reset', detail: '通过命令行重置' });

  console.log('管理员密码已重置，所有旧会话已失效。');
  db.close();
})();
