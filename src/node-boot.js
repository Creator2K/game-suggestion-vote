'use strict';

/**
 * Node 侧的一次性装配。
 *
 * 把「这个宿主特有」的三件事装好，之后 src/ 下的业务代码就是运行时无关的了：
 *   - 数据引擎：node:sqlite
 *   - 截图存储：写到磁盘
 *   - 会话有效期：读环境变量
 *
 * 入口（src/app.js）和几个脚本都调 boot()，重复调用不会重复打开数据库。
 */

const config = require('./config');
const db = require('./db');
const runtime = require('./runtime');
const template = require('./template');
const nodeSqlite = require('./engines/node-sqlite');
const fsStore = require('./stores/fs');
const fsViews = require('./loaders/fs-views');

let booted = false;

function boot() {
  if (booted) return db;

  db.install(
    nodeSqlite.open({
      dataDir: config.DATA_DIR,
      uploadDir: config.UPLOAD_DIR,
      dbFile: config.DB_FILE,
    })
  );
  runtime.configure({
    sessionDays: config.SESSION_DAYS,
    screenshotStore: fsStore.create(config.UPLOAD_DIR),
    resetToken: config.RESET_TOKEN,
  });
  template.setLoader(fsViews.create(config.PUBLIC_DIR));
  db.migrate();

  booted = true;
  return db;
}

module.exports = { boot };
