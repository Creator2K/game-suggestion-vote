'use strict';

/** AI 一键审核：跑一轮、看报告、逐条或整轮撤销 */

(function () {
  const RULE_LABEL = {
    done_dup: '与已实现重复',
    approved_dup: '与投票中的重复',
    pending_dup: '与更早的重复',
    similar_rejected: '与已拒绝相似',
    similar_deleted: '与已删除相似',
    similar: '疑似重复',
    junk: '无意义内容',
    ad: '广告引流',
    bot: '疑似机器人',
  };

  const STATUS_LABEL = {
    applied: '已处理',
    candidate: '待你确认',
    dismissed: '已保留',
    undone: '已撤销',
  };

  const COLS = 6;

  let currentBatch = 0;
  let running = false;
  const banned = {}; // 本轮页面里已经点过封禁的邮箱/IP，避免重复点

  const runBtn = App.$('#run-btn');
  const rowsBox = App.$('#rows');
  const batchBox = App.$('#batch-rows');

  function ruleLabel(a) {
    return RULE_LABEL[a.rule] || a.rule || a.action;
  }

  function chip(text, cls) {
    return App.el('span', { class: 'px-badge px-badge--' + (cls || 'cat'), text: text });
  }

  /* ============================ 报告 ============================ */

  function renderRows(actions) {
    App.clear(rowsBox);

    if (!actions.length) {
      rowsBox.appendChild(
        Admin.emptyRow(COLS, '这一轮没有要处理的', '点右上角「开始一键审核」，或者等有新的待审建议。')
      );
      return;
    }

    actions.forEach(function (a) {
      const titleCell = App.el('td', {}, [
        App.el('span', { class: 'cell-title', text: a.title }),
        App.el('span', {
          class: 'cell-sub',
          text: '#' + a.suggestionId + (a.authorNickname ? ' · ' + a.authorNickname : '') +
            (a.authorEmail ? ' · ' + a.authorEmail : ''),
        }),
      ]);

      const verdictCell = App.el('td', {}, [
        chip(STATUS_LABEL[a.status] || a.status, a.status === 'candidate' ? 'pending' : a.status === 'undone' ? 'rejected' : 'approved'),
        App.el('div', { class: 'cell-sub', text: ruleLabel(a) }),
      ]);

      const targetCell = App.el('td', {}, [
        App.el('span', {
          class: 'cell-sub',
          text: a.targetId ? '#' + a.targetId + ' ' + (a.targetTitle || '') : '—',
        }),
      ]);

      const reasonCell = App.el('td', {}, [
        App.el('span', { class: 'cell-sub', text: a.reason || '—' }),
        a.confidence == null
          ? null
          : App.el('span', { class: 'cell-sub', text: '置信度 ' + Number(a.confidence).toFixed(2) + ' · ' + (a.source === 'local' ? '本地规则' : 'AI') }),
      ]);

      const actions2 = [];
      const btn = function (text, cls, fn) {
        const b = App.el('button', { class: 'px-btn px-btn--sm ' + (cls || ''), type: 'button', text: text });
        b.addEventListener('click', fn);
        return b;
      };

      if (a.status === 'applied') {
        actions2.push(
          btn('撤销', '', function () {
            doApi('/ai/undo', { actionId: a.id }, '已撤销');
          })
        );
      } else if (a.status === 'candidate') {
        actions2.push(
          btn('拒绝', 'px-btn--danger', function () {
            doApi('/ai/resolve', { actionId: a.id, decision: 'reject' }, '已拒绝');
          }),
          btn('保留', '', function () {
            doApi('/ai/resolve', { actionId: a.id, decision: 'keep' }, '已保留，标记已清掉');
          })
        );
      }

      if (a.banHint && a.status !== 'undone') {
        if (a.authorEmail) {
          const key = 'email:' + a.authorEmail;
          actions2.push(
            banned[key]
              ? App.el('span', { class: 'fs1 muted', text: '已封禁邮箱' })
              : btn('封禁邮箱', 'px-btn--danger', function () {
                  ban({ kind: 'email', value: a.authorEmail, reason: 'AI 判定疑似广告／机器人：' + (a.title || '') }, key);
                })
          );
        }
        if (a.authorIp) {
          const key = 'ip:' + a.authorIp;
          actions2.push(
            banned[key]
              ? App.el('span', { class: 'fs1 muted', text: '已封禁 IP' })
              : btn('封禁 IP', 'px-btn--danger', function () {
                  ban({ kind: 'ip', value: a.authorIp, reason: 'AI 判定疑似广告／机器人：' + (a.title || '') }, key);
                })
          );
        }
      }

      rowsBox.appendChild(
        App.el('tr', {}, [
          App.el('td', { class: 'cell-id', text: '#' + a.suggestionId }),
          titleCell,
          verdictCell,
          targetCell,
          reasonCell,
          App.el('td', {}, actions2),
        ])
      );
    });
  }

  function renderReport(data) {
    const b = data.batch;
    const counts = data.counts || {};

    if (!b) {
      App.$('#report-meta').textContent = '';
      renderRows([]);
      return;
    }

    currentBatch = b.id;
    App.$('#report-meta').textContent =
      '批次 #' + b.id + ' · ' + App.fmtDateTime(b.startedAt) +
      (b.finishedAt ? '' : ' · 还没跑完') +
      ' · 扫了 ' + b.scanned + ' 条，自动处理 ' + b.acted + ' 条' +
      (b.failed ? '，' + b.failed + ' 条判定失败' : '');

    const parts = [];
    if (counts.candidate) parts.push('待你确认 ' + counts.candidate);
    if (counts.applied) parts.push('已处理 ' + counts.applied);
    if (counts.dismissed) parts.push('已保留 ' + counts.dismissed);
    if (counts.undone) parts.push('已撤销 ' + counts.undone);
    if (counts.banHint) parts.push('疑似待封禁 ' + counts.banHint);

    renderRows(data.actions);
    if (parts.length) App.$('#progress').textContent = '本轮：' + parts.join(' · ');
  }

  function renderBatches(batches) {
    App.clear(batchBox);

    if (!batches.length) {
      batchBox.appendChild(Admin.emptyRow(5, '还没跑过', '跑一轮之后这里会有记录。'));
      return;
    }

    batches.forEach(function (b) {
      const view = App.el('button', { class: 'px-btn px-btn--sm', type: 'button', text: '查看' });
      view.addEventListener('click', function () {
        loadReport(b.id);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });

      const undo = App.el('button', { class: 'px-btn px-btn--sm px-btn--danger', type: 'button', text: '撤销整轮' });
      undo.addEventListener('click', function () {
        doApi('/ai/undo-batch', { batchId: b.id }, '已撤销这一轮');
      });

      batchBox.appendChild(
        App.el('tr', {}, [
          App.el('td', { class: 'cell-id', text: '#' + b.id }),
          App.el('td', { class: 'cell-mono', text: App.fmtDateTime(b.startedAt) }),
          App.el('td', {}, [App.el('span', { class: 'cell-sub', text: b.model || b.source || '—' })]),
          App.el('td', {}, [
            App.el('span', { class: 'cell-sub', text: '扫 ' + b.scanned + ' · 自动 ' + b.appliedCount + ' · 候选 ' + b.candidateCount + ' · 撤销 ' + b.undoneCount + (b.remaining ? ' · 剩 ' + b.remaining : '') }),
          ]),
          App.el('td', {}, [view, undo]),
        ])
      );
    });
  }

  /* ============================ 数据 ============================ */

  async function loadState() {
    try {
      const data = await Admin.api('/ai/state');
      const p = data.provider;

      App.$('#provider-text').textContent = p.label + (p.mode === 'embedding' ? '' : '（没有 AI 绑定）');
      App.$('#pending-count').textContent = String(data.pending);
      App.$('#batch-size').textContent = String(p.batchSize);
      App.$('#retrieve-min').textContent = Number(p.retrieveMin).toFixed(2);
      App.$('#auto-state').textContent = p.enabled ? '开' : '关（只出候选）';

      if (p.mode !== 'embedding') {
        App.$('#provider-text').title =
          '没有检测到 Workers AI 绑定，现在用字符相似度兜底，只能抓字面重复';
      }

      renderBatches(data.batches || []);
      if (data.lastBatch) await loadReport(data.lastBatch.id);
      else renderReport({ batch: null, actions: [], counts: {} });
    } catch (err) {
      App.err(err.message);
    }
  }

  async function loadReport(batchId) {
    try {
      const data = await Admin.api('/ai/report' + (batchId ? '?batch=' + batchId : ''));
      renderReport(data);
    } catch (err) {
      App.err(err.message);
    }
  }

  async function doApi(path, body, okText) {
    try {
      await Admin.api(path, { method: 'POST', body: body });
      if (okText) App.ok(okText);
      await loadState();
    } catch (err) {
      App.err(err.message);
    }
  }

  async function ban(payload, key) {
    const yes = await Admin.confirm({
      title: '确认封禁？',
      text: payload.kind === 'email' ? '封禁邮箱：' + payload.value : '封禁 IP：' + payload.value + '（同一个网络下的其他人也会被挡）',
      okText: '封禁',
      danger: true,
    });
    if (!yes) return;
    try {
      await Admin.api('/bans', { method: 'POST', body: payload });
      banned[key] = true;
      App.ok('已加入封禁名单');
      await loadState();
    } catch (err) {
      App.err(err.message);
    }
  }

  /* ============================ 跑一轮 ============================ */

  async function run() {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = '处理中…';

    let done = 0;
    let batchId = 0;
    let rounds = 0;

    try {
      // 每批十几条，界面自己接着跑，避免一个请求跑太久
      for (; rounds < 80; rounds += 1) {
        const r = await Admin.api('/ai/run', { method: 'POST', body: {} });
        batchId = r.batchId;
        done += r.scanned;

        const bits = ['已处理 ' + done + ' 条'];
        if (r.acted) bits.push('自动处理 ' + r.acted + ' 条');
        if (r.failed) bits.push('失败 ' + r.failed + ' 条');
        if (r.remaining) bits.push('还剩 ' + r.remaining + ' 条');
        App.$('#progress').textContent = bits.join(' · ');

        if (!r.scanned || !r.remaining) break;
      }

      if (!done) App.ok('没有待审建议了');
      else App.ok('这一轮处理了 ' + done + ' 条');
    } catch (err) {
      App.err(err.message);
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = '开始一键审核';
      await loadState();
      if (batchId) await loadReport(batchId);
    }
  }

  runBtn.addEventListener('click', run);
  App.$('#refresh-btn').addEventListener('click', function () {
    loadReport(currentBatch);
  });
  App.$('#undo-all-btn').addEventListener('click', async function () {
    if (!currentBatch) return App.err('还没选择批次');
    const yes = await Admin.confirm({
      title: '撤销整轮 #' + currentBatch + '？',
      text: '这一轮 AI 拒绝掉的建议会全部回到待审，标记也会清掉。',
      okText: '撤销',
      danger: true,
    });
    if (!yes) return;
    doApi('/ai/undo-batch', { batchId: currentBatch }, '已撤销这一轮');
  });

  Admin.boot({ onReady: loadState });
})();
