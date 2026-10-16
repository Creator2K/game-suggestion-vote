'use strict';

/** 手动备份：node scripts/backup.js */

const path = require('node:path');
const db = require('../src/db');
const backup = require('../src/backup');

db.init();

try {
  const r = backup.runBackup();
  console.log(`备份完成：${r.file}`);
  console.log(`大小：${Math.round(r.size / 1024)} KB`);
  if (r.removed.length) console.log(`已清理旧备份：${r.removed.join(', ')}`);
  console.log(`当前保留 ${backup.listBackups().length} 份`);
} catch (err) {
  console.error('备份失败：', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
