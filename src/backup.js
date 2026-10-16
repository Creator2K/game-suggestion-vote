'use strict';

/**
 * 备份：用 SQLite 的 VACUUM INTO 做一致性快照。
 * 不需要停服，不会拷到写了一半的 WAL 数据。
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 20261016-183000 */
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 本地日期 YYYYMMDD，用于判断「今天备份过了吗」 */
function todayKey(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function listBackups() {
  if (!fs.existsSync(config.BACKUP_DIR)) return [];
  return fs
    .readdirSync(config.BACKUP_DIR)
    .filter((f) => /^vote-\d{8}-\d{6}\.db$/.test(f))
    .sort();
}

/** 只保留最近 BACKUP_KEEP 份 */
function prune() {
  const files = listBackups();
  const removed = [];
  while (files.length > config.BACKUP_KEEP) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(config.BACKUP_DIR, oldest));
      removed.push(oldest);
    } catch {
      /* 删不掉就留着，不影响主流程 */
    }
  }
  return removed;
}

/** 执行一次备份，返回生成的文件路径 */
function runBackup() {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  const file = path.join(config.BACKUP_DIR, `vote-${stamp()}.db`);
  const escaped = file.replace(/'/g, "''");
  db.raw.exec(`VACUUM INTO '${escaped}'`);
  const removed = prune();

  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return { file, size, removed };
}

/**
 * 每天凌晨 3 点后自动备份一次。
 * 用「今天是否已有备份文件」判断，重启不会重复备份。
 */
function startScheduler() {
  const tick = () => {
    try {
      const now = new Date();
      if (now.getHours() < 3) return;
      const already = listBackups().some((f) => f.includes(todayKey(now)));
      if (already) return;
      const r = runBackup();
      console.log(`[备份] ${path.basename(r.file)} (${Math.round(r.size / 1024)} KB)`);
    } catch (err) {
      console.error('[备份] 失败：', err.message);
    }
  };

  // 启动 30 秒后试一次（覆盖「凌晨关机白天才开机」的情况），之后每 30 分钟检查
  setTimeout(tick, 30 * 1000).unref?.();
  const timer = setInterval(tick, 30 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { runBackup, listBackups, prune, startScheduler, todayKey };
