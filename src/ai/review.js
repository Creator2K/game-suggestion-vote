'use strict';

/**
 * AI 一键审核引擎。
 *
 * 一次运行 = 一批（batch），按 id 从小到大扫待审建议，每条：
 *   1) 先判垃圾／广告／机器人；命中了就拒绝（可整轮撤销）；
 *   2) 再找相似建议：
 *        · 与「已实现 / 已过审 / 更早提交的待审」重复 → 直接拒绝，理由指向保留的那条；
 *        · 与「已拒绝 / 已删除」相似 → 只出候选，不服由人来定；
 *        · 置信度不够 → 也只出候选（宁可多让管理员看一眼，也不误拒）。
 *   3) 机器人／广告只做「拒绝 + 标记」，绝不自动封禁——封禁是一键按钮，由人按。
 *
 * 两个运行时共用这份逻辑：Workers 上注入 env.AI（embedding 找候选 + 对话模型确认），
 * 本机 Node 没有 AI 就用 src/ai/local.js 的字符相似度兜底，界面上会写明用的是哪个。
 */

const db = require('../db');
const runtime = require('../runtime');
const text = require('./text');
const vectors = require('./vectors');
const localProvider = require('./local');

/** 每条建议最多看几个相似候选 */
const TOP_K = 5;
/** 单次运行最多补算多少个向量 */
const EMBED_BUDGET = 60;
/** 向量一次请求算几条 */
const EMBED_CHUNK = 16;
/** 每条建议最多做几次「是不是同一件事」的确认，控成本 */
const CONFIRM_MAX = 2;
/** AI 确认「同一件事」的置信度下限，低于它只出候选 */
const SAME_MIN = 0.7;
/** 垃圾判定置信度下限 */
const JUNK_MIN = 0.8;
const REASON_MAX = 200;

const DUP_RULES = new Set(['done_dup', 'approved_dup', 'pending_dup']);

function activeProvider() {
  return runtime.ai() || localProvider.create();
}

/**
 * 相似度门槛：设置里留空就跟随判定器的默认值。
 * 两种模式的尺度不一样（向量余弦 vs 字符重合度），所以不能共用一个固定数字。
 */
function retrieveMinFor(prov) {
  const raw = Number(db.getSetting('ai_retrieve_min', ''));
  if (Number.isFinite(raw) && raw > 0) return raw;
  return prov.retrieveMin;
}

function providerInfo() {
  const prov = activeProvider();
  return {
    name: prov.name,
    label: prov.label,
    detail: prov.detail,
    mode: prov.mode,
    enabled: db.getSetting('ai_review_enabled', '1') === '1',
    retrieveMin: retrieveMinFor(prov),
    retrieveMinDefault: prov.retrieveMin,
    batchSize: batchSize(),
  };
}

function batchSize() {
  const n = Number(db.getSetting('ai_batch_size', ''));
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(30, Math.max(1, Math.round(n)));
}

/* ------------------------------------------------------------------ *
 * 语料与向量
 * ------------------------------------------------------------------ */

function loadCorpus() {
  const rows = db.all(
    `SELECT id, title, body, category, status, created_at AS createdAt,
            deleted_at AS deletedAt, ai_flag AS aiFlag
     FROM suggestions`
  );
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.id), {
      id: Number(r.id),
      title: String(r.title || ''),
      body: String(r.body || ''),
      category: String(r.category || ''),
      status: String(r.status || ''),
      createdAt: Number(r.createdAt),
      deletedAt: r.deletedAt ? Number(r.deletedAt) : null,
      aiFlag: r.aiFlag || null,
      vec: null,
    });
  }
  return map;
}

function embedInput(item) {
  return [item.title, String(item.body).slice(0, 300), `分类：${item.category}`].join('\n');
}

function fingerprintOf(prov, item) {
  return text.fingerprint(prov.embedModel || 'lexical', item.title, item.body, item.category);
}

function writeVector(item, prov, fp, vec) {
  db.run(
    `INSERT INTO ai_vectors (suggestion_id, model, dim, b64, fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(suggestion_id) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, b64 = excluded.b64,
       fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
    item.id,
    prov.embedModel,
    vec.length,
    vectors.encode(vec),
    fp,
    Date.now()
  );
}

/** 把缺的向量补上；返回统计。算不动了不报错，退化成字面相似度 */
async function ensureVectors(prov, corpus, budget) {
  if (prov.mode !== 'embedding') return { embedded: 0, failed: 0, pending: 0 };

  const stored = new Map();
  for (const r of db.all('SELECT suggestion_id AS id, model, fingerprint, b64 FROM ai_vectors')) {
    stored.set(Number(r.id), r);
  }

  const vecMap = new Map();
  const todo = [];
  for (const item of corpus.values()) {
    if (item.deletedAt) continue;
    const fp = fingerprintOf(prov, item);
    const row = stored.get(item.id);
    if (row && row.model === prov.embedModel && row.fingerprint === fp) {
      try {
        item.vec = vectors.decode(row.b64);
        vecMap.set(item.id, item.vec);
        continue;
      } catch {
        /* 存坏了就当没有，重新算 */
      }
    }
    todo.push({ item, fp });
  }

  const slice = todo.slice(0, Math.max(0, budget));
  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < slice.length; i += EMBED_CHUNK) {
    const chunk = slice.slice(i, i + EMBED_CHUNK);
    let out;
    try {
      out = await prov.embed(chunk.map(({ item }) => embedInput(item)));
    } catch {
      failed += chunk.length;
      break; // 服务出问题就不再往下烧时间，剩下的这轮按字面相似度处理
    }
    chunk.forEach(({ item, fp }, j) => {
      const raw = out[j];
      if (!raw || !raw.length) return;
      const vec = vectors.normalizeInPlace(Float32Array.from(raw));
      item.vec = vec;
      vecMap.set(item.id, vec);
      writeVector(item, prov, fp, vec);
      embedded += 1;
    });
  }

  return { embedded, failed, pending: Math.max(0, todo.length - slice.length) };
}

function scorePair(prov, a, b) {
  if (prov.mode === 'embedding' && a.vec && b.vec) return vectors.cosine(a.vec, b.vec);
  return text.score(a, b);
}

function candidates(prov, target, corpus, retrieveMin) {
  const out = [];
  for (const other of corpus.values()) {
    if (other.id === target.id) continue;
    const score = scorePair(prov, target, other);
    if (score >= retrieveMin) out.push({ item: other, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, TOP_K);
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

function ruleFor(ev) {
  if (ev.deletedAt) return 'similar_deleted';
  if (ev.status === 'done') return 'done_dup';
  if (ev.status === 'approved') return 'approved_dup';
  if (ev.status === 'pending') return 'pending_dup';
  if (ev.status === 'rejected') return 'similar_rejected';
  return 'similar';
}

function shortTitle(ev) {
  return `「${String(ev.title || '').slice(0, 30)}」`;
}

function dupReason(rule, ev) {
  const name = shortTitle(ev);
  if (rule === 'done_dup') return `这个需求已经实现了（见 ${name}），同类的不用重复提`;
  if (rule === 'approved_dup') return `已经有一样的建议在投票了（见 ${name}），去给它投票更有效`;
  if (rule === 'pending_dup') return `和更早提交的 ${name} 是同一件事，重复的建议会分散票数，先并到那条`;
  return `和 ${name} 重复`;
}

function softReason(rule, ev, note) {
  const name = shortTitle(ev);
  const tail = note ? `（${note}）` : '';
  if (rule === 'similar_rejected') return `和之前被拒绝过的 ${name} 相似，要不要再拒一次由你定${tail}`;
  if (rule === 'similar_deleted') return `和一条已删除的建议 ${name} 相似${tail}`;
  return `可能和 ${name} 重复，AI 没把握，需要你确认${tail}`;
}

function junkReason(cls) {
  const tail = cls.reason ? `（${cls.reason}）` : '';
  if (cls.kind === 'ad') return `看起来是广告／引流内容${tail}`;
  if (cls.kind === 'bot') return `看起来是批量灌水或机器生成${tail}`;
  return `读不出有用的建议内容${tail}`;
}

/** 顺着「AI 之前判的重复」往上找根证据，避免重复判同一个东西 */
function resolveEvidence(item, corpus, chain) {
  let cur = item;
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    if (cur.status !== 'rejected' || seen.has(cur.id)) return cur;
    seen.add(cur.id);

    let rootId = chain.get(cur.id) || null;
    if (!rootId) {
      const row = db.get(
        `SELECT target_id AS targetId, rule FROM ai_review_actions
         WHERE suggestion_id = ? AND action = 'reject' AND status = 'applied' AND target_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        cur.id
      );
      if (row && DUP_RULES.has(String(row.rule))) rootId = Number(row.targetId);
    }
    if (!rootId) return cur;

    const root = corpus.get(rootId);
    if (!root) return cur;
    cur = root;
  }
  return cur;
}

/**
 * 判一条待审建议。
 * @returns {Promise<null|object>} null 表示这条没什么问题
 */
async function judge(prov, target, corpus, opts) {
  /* 1) 垃圾／广告／机器人 */
  let cls = null;
  try {
    cls = await prov.classify(target);
  } catch (err) {
    // 判定服务出问题时只记日志：这条会留在待审列表里，不会因为报错就被误处理
    console.error('[AI] 垃圾判定失败：', (err && err.message) || err);
    cls = null;
  }
  if (cls && cls.kind && cls.kind !== 'ok' && Number(cls.confidence) >= JUNK_MIN) {
    const isBot = cls.kind === 'bot';
    return {
      action: isBot ? 'reject_ban' : 'reject',
      rule: cls.kind === 'ad' ? 'ad' : isBot ? 'bot' : 'junk',
      targetId: null,
      flag: cls.kind,
      banHint: isBot ? 1 : 0,
      applied: true,
      confidence: Number(cls.confidence),
      reason: junkReason(cls).slice(0, REASON_MAX),
    };
  }

  /* 2) 重复 */
  const list = candidates(prov, target, corpus, opts.retrieveMin);
  let soft = null;
  let confirms = 0;

  for (const cand of list) {
    const ev = resolveEvidence(cand.item, corpus, opts.chain);
    if (!ev || ev.id === target.id) continue;

    // 候选比本条更晚、且都还在待审：本条是「更早的那条」，保留它，等轮到对方时再判
    if (ev.status === 'pending' && ev.createdAt > target.createdAt) continue;

    const autoEligible =
      ev.status === 'done' ||
      ev.status === 'approved' ||
      (ev.status === 'pending' && ev.createdAt <= target.createdAt);

    if (!autoEligible) {
      if (!soft) soft = { ev, rule: ruleFor(ev) };
      continue;
    }

    if (confirms >= CONFIRM_MAX) {
      if (!soft) soft = { ev, rule: ruleFor(ev) };
      break;
    }
    confirms += 1;

    let verdict = null;
    try {
      verdict = await prov.sameThing(target, ev);
    } catch (err) {
      console.error('[AI] 相似判定失败：', (err && err.message) || err);
      verdict = null;
    }

    const rule = ruleFor(ev);
    if (verdict && verdict.same && Number(verdict.confidence) >= SAME_MIN) {
      return {
        action: 'reject',
        rule,
        targetId: ev.id,
        flag: 'duplicate',
        banHint: 0,
        applied: true,
        confidence: Number(verdict.confidence),
        reason: dupReason(rule, ev).slice(0, REASON_MAX),
      };
    }
    if (!soft) soft = { ev, rule, note: verdict ? verdict.reason : '判定调用没成功' };
  }

  if (soft) {
    return {
      action: 'reject',
      rule: soft.rule,
      targetId: soft.ev.id,
      flag: soft.rule === 'similar_rejected' || soft.rule === 'similar_deleted' ? null : 'duplicate',
      banHint: 0,
      applied: false, // 只出候选，人来定
      confidence: null,
      reason: softReason(soft.rule, soft.ev, soft.note).slice(0, REASON_MAX),
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 执行与留档
 * ------------------------------------------------------------------ */

function applyReject(target, decision, now) {
  db.run(
    `UPDATE suggestions
     SET status = 'rejected', reject_reason = ?, reviewed_at = ?, ai_flag = ?, ai_note = ?, ai_at = ?
     WHERE id = ?`,
    decision.reason,
    now,
    decision.flag || null,
    decision.reason,
    now,
    target.id
  );
  target.status = 'rejected';
  target.aiFlag = decision.flag || null;
}

function markCandidate(target, decision, now) {
  db.run(
    `UPDATE suggestions SET ai_flag = ?, ai_note = ?, ai_at = ? WHERE id = ?`,
    decision.flag || 'duplicate',
    decision.reason,
    now,
    target.id
  );
  target.aiFlag = decision.flag || 'duplicate';
}

function clearMarks(suggestionId) {
  db.run(
    `UPDATE suggestions SET ai_flag = NULL, ai_note = NULL, ai_at = NULL WHERE id = ?`,
    suggestionId
  );
}

function recordAction({ batchId, target, decision, applied, prov, chain }) {
  const now = Date.now();
  const r = db.run(
    `INSERT INTO ai_review_actions
       (batch_id, suggestion_id, action, rule, target_id, reason, confidence, source,
        status, ban_hint, prev_status, prev_flag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchId,
    target.id,
    decision.action,
    decision.rule,
    decision.targetId,
    decision.reason,
    decision.confidence,
    prov.name,
    applied ? 'applied' : 'candidate',
    decision.banHint || 0,
    target.status,
    target.aiFlag,
    now
  );

  if (applied) {
    applyReject(target, decision, now);
    if (DUP_RULES.has(decision.rule) && decision.targetId) {
      chain.set(target.id, decision.targetId);
    }
  } else {
    markCandidate(target, decision, now);
  }

  return Number(r.lastInsertRowid);
}

/**
 * 跑一轮（或继续上一轮没跑完的批次）。
 */
async function runBatch({ actor = 'ai-review', ip = null } = {}) {
  // 同一份数据上并发跑两轮会各自读到同一个游标，做出重复动作，这里直接挡掉
  if (running) {
    const err = new Error('上一轮还没跑完，稍等一下再点');
    err.status = 409;
    throw err;
  }
  running = true;
  try {
    return await runBatchInner({ actor, ip });
  } finally {
    running = false;
  }
}

let running = false;

async function runBatchInner({ actor = 'ai-review', ip = null } = {}) {
  const prov = activeProvider();
  const enabled = db.getSetting('ai_review_enabled', '1') === '1';
  const retrieveMin = retrieveMinFor(prov);
  const size = batchSize();

  let batch = db.get(
    'SELECT * FROM ai_review_batches WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1'
  );
  if (!batch) {
    const ins = db.run(
      `INSERT INTO ai_review_batches (started_at, source, model, cursor_id) VALUES (?, ?, ?, 0)`,
      Date.now(),
      prov.name,
      prov.detail
    );
    batch = db.get('SELECT * FROM ai_review_batches WHERE id = ?', Number(ins.lastInsertRowid));
  }
  const batchId = Number(batch.id);
  const cursor = Number(batch.cursor_id) || 0;

  const corpus = loadCorpus();
  const vecStat = await ensureVectors(prov, corpus, EMBED_BUDGET);

  const queue = db.all(
    `SELECT id FROM suggestions
     WHERE status = 'pending' AND deleted_at IS NULL AND id > ?
     ORDER BY id ASC LIMIT ?`,
    cursor,
    size
  );

  const chain = new Map();
  let scanned = 0;
  let acted = 0;
  let failed = 0;
  const actionIds = [];
  const failedIds = [];

  for (const row of queue) {
    const target = corpus.get(Number(row.id));
    scanned += 1;
    if (!target) continue;

    let decision = null;
    try {
      decision = await judge(prov, target, corpus, { retrieveMin, chain });
    } catch {
      failed += 1;
      failedIds.push(Number(row.id));
      continue;
    }
    if (!decision) continue;

    const applied = enabled && decision.applied;
    actionIds.push(
      recordAction({ batchId, target, decision, applied, prov, chain })
    );
    if (applied) acted += 1;
  }

  const newCursor = queue.length ? Number(queue[queue.length - 1].id) : cursor;
  const restRow = db.get(
    `SELECT COUNT(*) AS c FROM suggestions WHERE status = 'pending' AND deleted_at IS NULL AND id > ?`,
    newCursor
  );
  const remaining = Number(restRow ? restRow.c : 0);

  db.run(
    `UPDATE ai_review_batches
     SET scanned = scanned + ?, acted = acted + ?, failed = failed + ?,
         remaining = ?, cursor_id = ?, finished_at = ?, model = ?
     WHERE id = ?`,
    scanned,
    acted,
    failed,
    remaining,
    newCursor,
    remaining === 0 ? Date.now() : null,
    prov.detail,
    batchId
  );

  db.logAudit({
    actor,
    action: 'ai.review',
    targetType: 'batch',
    targetId: batchId,
    detail: { source: prov.name, scanned, acted, failed, remaining },
    ip,
  });

  return {
    batchId,
    provider: { name: prov.name, label: prov.label, detail: prov.detail, mode: prov.mode },
    enabled,
    retrieveMin,
    scanned,
    acted,
    failed,
    failedIds,
    remaining,
    embedded: vecStat.embedded,
    embedPending: vecStat.pending,
    actionIds,
  };
}

/* ------------------------------------------------------------------ *
 * 报告与撤销
 * ------------------------------------------------------------------ */

function serializeAction(a) {
  return {
    id: Number(a.id),
    batchId: Number(a.batch_id),
    suggestionId: Number(a.suggestion_id),
    title: a.title,
    authorEmail: a.authorEmail || null,
    authorNickname: a.authorNickname || null,
    authorIp: a.authorIp || null,
    currentStatus: a.currentStatus,
    deleted: !!a.deletedAt,
    action: a.action,
    rule: a.rule,
    targetId: a.target_id == null ? null : Number(a.target_id),
    targetTitle: a.targetTitle || null,
    reason: a.reason,
    confidence: a.confidence == null ? null : Number(a.confidence),
    source: a.source,
    status: a.status,
    banHint: Number(a.ban_hint) === 1,
    createdAt: Number(a.created_at),
    resolvedAt: a.resolved_at == null ? null : Number(a.resolved_at),
  };
}

function serializeBatch(b) {
  return {
    id: Number(b.id),
    startedAt: Number(b.started_at),
    finishedAt: b.finished_at == null ? null : Number(b.finished_at),
    source: b.source,
    model: b.model,
    scanned: Number(b.scanned),
    acted: Number(b.acted),
    failed: Number(b.failed),
    remaining: Number(b.remaining),
    cursorId: Number(b.cursor_id),
  };
}

function actionRows(batchId) {
  return db.all(
    `SELECT a.*, s.title AS title, s.status AS currentStatus, s.deleted_at AS deletedAt,
            p.email AS authorEmail, p.nickname AS authorNickname, p.last_ip AS authorIp,
            t.title AS targetTitle
     FROM ai_review_actions a
     JOIN suggestions s ON s.id = a.suggestion_id
     LEFT JOIN players p ON p.id = s.author_id
     LEFT JOIN suggestions t ON t.id = a.target_id
     WHERE a.batch_id = ?
     ORDER BY (a.status = 'candidate') DESC, a.id ASC`,
    batchId
  );
}

function report(batchId) {
  const batch = batchId
    ? db.get('SELECT * FROM ai_review_batches WHERE id = ?', batchId)
    : db.get('SELECT * FROM ai_review_batches ORDER BY id DESC LIMIT 1');
  if (!batch) return null;
  const actions = actionRows(Number(batch.id)).map(serializeAction);
  const counts = {
    applied: 0,
    candidate: 0,
    dismissed: 0,
    undone: 0,
    banHint: 0,
  };
  for (const a of actions) {
    if (counts[a.status] != null) counts[a.status] += 1;
    if (a.banHint && a.status !== 'undone') counts.banHint += 1;
  }
  return { batch: serializeBatch(batch), actions, counts, provider: providerInfo() };
}

function recentBatches(limit = 10) {
  const rows = db.all(
    `SELECT b.*,
            (SELECT COUNT(*) FROM ai_review_actions a WHERE a.batch_id = b.id AND a.status = 'applied') AS appliedCount,
            (SELECT COUNT(*) FROM ai_review_actions a WHERE a.batch_id = b.id AND a.status = 'candidate') AS candidateCount,
            (SELECT COUNT(*) FROM ai_review_actions a WHERE a.batch_id = b.id AND a.status = 'undone') AS undoneCount
     FROM ai_review_batches b
     ORDER BY b.id DESC LIMIT ?`,
    Math.min(50, Math.max(1, limit))
  );
  return rows.map((r) => ({
    ...serializeBatch(r),
    appliedCount: Number(r.appliedCount),
    candidateCount: Number(r.candidateCount),
    undoneCount: Number(r.undoneCount),
  }));
}

/** 撤销一条已执行的判定 */
function undoAction(actionId) {
  const id = Number(actionId) || 0;
  const a = db.get('SELECT * FROM ai_review_actions WHERE id = ?', id);
  if (!a) return { error: '找不到这条记录', status: 404 };
  if (a.status === 'undone') return { error: '这条已经撤销过了', status: 409 };
  if (a.status === 'candidate') return { error: '这条还没执行，用「忽略」即可', status: 409 };

  const target = db.get('SELECT id, status FROM suggestions WHERE id = ?', a.suggestion_id);
  if (!target) return { error: '建议不存在', status: 404 };
  if (target.status !== 'rejected') {
    return {
      error: `这条现在是「${target.status}」，状态已经被人改过，撤销会覆盖它，请手动处理`,
      status: 409,
    };
  }

  db.tx(() => {
    db.run(
      `UPDATE suggestions SET status = ?, reject_reason = NULL WHERE id = ?`,
      a.prev_status || 'pending',
      a.suggestion_id
    );
    clearMarks(a.suggestion_id);
    db.run(
      `UPDATE ai_review_actions SET status = 'undone', resolved_at = ? WHERE id = ?`,
      Date.now(),
      a.id
    );
  });

  return { ok: true, suggestionId: Number(a.suggestion_id) };
}

/** 撤销一整轮 */
function undoBatch(batchId) {
  const id = Number(batchId) || 0;
  const rows = db.all(
    `SELECT id FROM ai_review_actions WHERE batch_id = ? AND status = 'applied'`,
    id
  );
  let undone = 0;
  const skipped = [];
  for (const row of rows) {
    const r = undoAction(Number(row.id));
    if (r.ok) undone += 1;
    else skipped.push({ id: Number(row.id), error: r.error });
  }
  return { ok: true, undone, skipped };
}

/** 处理候选：reject=照 AI 的判断拒绝，keep=保留（清掉标记） */
function resolveCandidate(actionId, decision) {
  const id = Number(actionId) || 0;
  const a = db.get('SELECT * FROM ai_review_actions WHERE id = ?', id);
  if (!a) return { error: '找不到这条记录', status: 404 };
  if (a.status !== 'candidate') return { error: '这条不是待确认的候选', status: 409 };

  const now = Date.now();
  if (decision === 'reject') {
    db.tx(() => {
      db.run(
        `UPDATE suggestions SET status = 'rejected', reject_reason = ?, reviewed_at = ?,
           ai_flag = ?, ai_note = ?, ai_at = ? WHERE id = ?`,
        a.reason,
        now,
        a.rule === 'similar_rejected' || a.rule === 'similar_deleted' ? null : 'duplicate',
        a.reason,
        now,
        a.suggestion_id
      );
      db.run(
        `UPDATE ai_review_actions SET status = 'applied', resolved_at = ? WHERE id = ?`,
        now,
        a.id
      );
    });
  } else {
    db.tx(() => {
      clearMarks(a.suggestion_id);
      db.run(
        `UPDATE ai_review_actions SET status = 'dismissed', resolved_at = ? WHERE id = ?`,
        now,
        a.id
      );
    });
  }

  return { ok: true, suggestionId: Number(a.suggestion_id), decision };
}

module.exports = {
  runBatch,
  report,
  recentBatches,
  undoAction,
  undoBatch,
  resolveCandidate,
  providerInfo,
  // 供测试直接调用的内部件
  loadCorpus,
  judge,
  ruleFor,
  DUP_RULES,
};
