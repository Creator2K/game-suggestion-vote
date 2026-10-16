'use strict';

/**
 * 运行时插槽。
 *
 * 这个项目同时跑在两个完全不同的宿主上：
 *   Node            —— 一个常驻进程，数据落在磁盘上的 SQLite 文件里
 *   Cloudflare Workers —— 一个 Worker 加一个 Durable Object，数据在 DO 的 SQLite 里
 *
 * 业务代码（src/routes、src/middleware）两边共用，所以「随宿主不同的部分」
 * 必须集中到插槽里由各自的入口注入：
 *   - db.install()     数据引擎（src/db.js）
 *   - runtime.configure() 截图存储、会话有效期（本文件）
 *   - template.setLoader() 模板来源（src/template.js）
 */

const state = {
  /** 后台会话有效期（天） */
  sessionDays: 7,
  /** 截图存储，见 src/stores/ */
  screenshotStore: null,
  /**
   * 管理员密码重置令牌。非空时开放 POST /api/admin/force-reset，
   * 用于忘记密码时自救（Workers 上没有能改数据库的命令行脚本）。
   * 留空即关闭该入口。
   */
  resetToken: '',
  /**
   * AI 判定器（见 src/ai/）。Workers 上由 Durable Object 注入 env.AI；
   * 本机 Node 没有绑定，留空即退化成字符相似度的本地规则。
   */
  ai: null,
};

function configure(opts = {}) {
  if (opts.sessionDays != null) {
    const n = Number(opts.sessionDays);
    if (Number.isFinite(n) && n > 0) state.sessionDays = n;
  }
  if (opts.screenshotStore) state.screenshotStore = opts.screenshotStore;
  if (opts.resetToken != null) state.resetToken = String(opts.resetToken);
  if (opts.ai !== undefined) state.ai = opts.ai || null;
  return state;
}

/** 取截图存储；未注入直接报错，避免静默写出半个功能 */
function screenshots() {
  if (!state.screenshotStore) throw new Error('截图存储未初始化');
  return state.screenshotStore;
}

module.exports = {
  configure,
  screenshots,
  /** 取 AI 判定器；没注入返回 null，调用方自己退化成本地规则 */
  ai() {
    return state.ai;
  },
  get sessionDays() {
    return state.sessionDays;
  },
  get resetToken() {
    return state.resetToken;
  },
};
