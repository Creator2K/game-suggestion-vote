'use strict';

/**
 * 全局配置。所有可调项都能用环境变量覆盖，方便云服务器部署。
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  DB_FILE: path.join(DATA_DIR, 'vote.db'),
  BACKUP_DIR: process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(ROOT, 'backups'),

  PORT: intEnv('PORT', 3210),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',

  /** 后台会话有效期（天） */
  SESSION_DAYS: intEnv('SESSION_DAYS', 7),

  /** 部署在 Nginx 后面时必须打开，否则拿到的是反代 IP */
  TRUST_PROXY: boolEnv('TRUST_PROXY', false),

  /** 备份保留份数 */
  BACKUP_KEEP: intEnv('BACKUP_KEEP', 14),

  STARTED_AT: Date.now(),
};
