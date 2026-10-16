import { DurableObject } from 'cloudflare:workers';

import dbModule from '../src/db.js';
import runtimeModule from '../src/runtime.js';
import templateModule from '../src/template.js';
import utilModule from '../src/util.js';
import appModule from './app.js';
import doSqlModule from './engines/do-sql.js';
import doBlobModule from './stores/do-blob.js';
import assetsViewsModule from './loaders/assets-views.js';

const db = dbModule;
const runtime = runtimeModule;
const template = templateModule;
const util = utilModule;
const { createApp } = appModule;
const doSql = doSqlModule;
const doBlob = doBlobModule;
const assetsViews = assetsViewsModule;

/**
 * 整个站点只有一个 Durable Object 实例（名字固定为 "board"）。
 *
 * 这样做的理由：原版是「一个 Node 进程 + 一个 SQLite 文件」，写操作天然串行、
 * 事务简单。Durable Object 恰好也是单实例串行执行，两者模型一致，
 * 所以数据层几乎可以原样搬过来，不用改成 D1 那种多写者的异步模型。
 *
 * 代价是所有请求都排这一个实例，对建议投票站这个量级完全够用。
 */
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // 装入 DO SQLite 引擎；之后 src/db.js 及以上的写法与 Node 版完全一样
    db.install(doSql.create({ sql: ctx.storage.sql, storage: ctx.storage }));

    // 建表必须在处理第一个请求之前完成
    ctx.blockConcurrencyWhile(async () => {
      db.migrate();
      runtime.configure({
        sessionDays: Number(env.SESSION_DAYS) || 7,
        screenshotStore: doBlob.create(db),
        resetToken: env.RESET_TOKEN || '',
      });
    });

    // 口令哈希的迭代次数：免费计划每次调用只有 10ms CPU，按实测值调
    if (env.PBKDF2_ITERATIONS) util.setKdfIterations(env.PBKDF2_ITERATIONS);

    template.setLoader(assetsViews.create(env.ASSETS));
    this.app = createApp(env);
  }

  async fetch(request) {
    return this.app.handle(request);
  }

  /** 由 Cron Trigger 调用：清掉过期会话与陈旧的限频事件 */
  async runCleanup() {
    db.cleanup();
    return { ok: true };
  }
}
