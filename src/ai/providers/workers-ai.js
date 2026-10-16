'use strict';

/**
 * Workers AI 判定器：Durable Object 里注入 env.AI 绑定后使用。
 *
 * 分工：
 *   - embedding 模型（bge-m3，多语言）负责「找出可能相似的那几条」；
 *   - 对话模型（glm-4.7-flash）只负责判断题——「这两条是不是一件事」、
 *     「这条是不是垃圾」——不让它做全库扫描，那样又贵又不准。
 *
 * 模型名可以在 worker 里通过环境变量覆盖（AI_EMBED_MODEL / AI_CHAT_MODEL），
 * 换模型不用改代码。
 */

const DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3';
/**
 * 判定用的对话模型。挑模型的实测经验（2026-10 在免费计划上试过）：
 *   - glm-4.7-flash / qwen3-30b-a3b-fp8 —— 会把答案塞进 tool_calls，
 *     message.content 是 null，拿不到文本，不能用；
 *   - gemma-4-26b-a4b-it —— 返回空字符串；
 *   - mistral-small-3.1-24b-instruct —— 能用，但一次要 15 秒；
 *   - llama-3.1-8b-instruct-fp8 —— 能用，1.9 秒，模型小；
 *   - llama-3.3-70b-instruct-fp8-fast —— 能用且最快（0.8 秒），默认用它。
 * 换模型只改 wrangler.jsonc 里的 AI_CHAT_MODEL，不用动代码。
 */
const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** 兼容几种返回形态，取文本 */
function pickText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.response === 'string') return out.response;
  // 有的模型把结构化结果放在对象里
  if (out.response && typeof out.response === 'object') {
    if (typeof out.response.content === 'string') return out.response.content;
    if (typeof out.response.text === 'string') return out.response.text;
  }
  const choice = out.choices && out.choices[0];
  if (choice) {
    const msg = choice.message || choice.delta || {};
    if (typeof msg.content === 'string') return msg.content;
    // OpenAI 兼容格式里 content 可能是分片数组
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
        .join('');
    }
    if (typeof choice.text === 'string') return choice.text;
  }
  if (typeof out.text === 'string') return out.text;
  if (out.result && typeof out.result === 'object') return pickText(out.result);
  return '';
}

function pickVectors(out) {
  if (!out) return [];
  if (Array.isArray(out.data)) return out.data;
  if (out.result && Array.isArray(out.result.data)) return out.result.data;
  if (Array.isArray(out.response)) return out.response;
  return [];
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 不能简单地取「第一个 { 到最后一个 }」：这是带思考过程的模型，
 * 正文里可能夹着别的大括号，那样切出来的是坏 JSON。
 * 这里按括号配对切出所有候选对象，从后往前试——答案通常在最后。
 */
function extractJson(raw) {
  const s = String(raw || '');
  const candidates = [];
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    for (let j = i; j < s.length; j += 1) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(s.slice(i, j + 1));
          break;
        }
      }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k -= 1) {
    try {
      const v = JSON.parse(candidates[k]);
      if (v && typeof v === 'object') return v;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const SAME_SYSTEM = [
  '你是游戏建议投票站的内容审核助手。',
  '判断两条玩家建议是不是在提同一件事。',
  '标准：玩家想要的改动是不是同一个。说法不同、详略不同、分类不同都算同一件事。',
  '只输出 JSON，不要解释，不要代码围栏，格式：',
  '{"same":true或false,"confidence":0到1之间的小数,"reason":"不超过30个字的中文理由"}',
].join('\n');

const JUNK_SYSTEM = [
  '你是游戏建议投票站的内容审核助手。',
  '判断一条玩家建议是不是垃圾内容。',
  '重要：内容短不等于垃圾。一句话的正常需求（例如「加个夜间模式」）是正常建议，',
  '不要因为字少就判成垃圾。乱码、纯符号、纯表情、与游戏完全无关的推广才算。',
  '只输出 JSON，不要解释，不要代码围栏，格式：',
  '{"kind":"ok或junk或ad或bot","confidence":0到1之间的小数,"reason":"不超过30个字的中文理由"}',
  '含义：ok=正常建议；junk=读不出任何有用内容；ad=广告引流联系方式；bot=批量灌水或机器生成。',
].join('\n');

function create(ai, opts = {}) {
  const embedModel = opts.embedModel || DEFAULT_EMBED_MODEL;
  const chatModel = opts.chatModel || DEFAULT_CHAT_MODEL;

  async function chatJson(system, user, maxTokens) {
    const out = await ai.run(chatModel, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: maxTokens || 300,
      // 这个模型（以及别的「会调工具」的模型）默认可能去调工具，
      // 那样 message.content 是 null，答案全在 tool_calls 里。
      // 我们只要一个判断题的答案，明确关掉工具。
      tool_choice: 'none',
    });
    const text = pickText(out);
    const json = extractJson(text);
    // 解析不出来时把原文和返回结构打出来：换模型、改返回格式时日志里能直接看到原因
    if (!json) {
      console.error(
        '[AI] 无法解析模型输出：',
        String(text).slice(0, 400),
        '| 原始返回：',
        JSON.stringify(out).slice(0, 800)
      );
    }
    return json;
  }

  return {
    name: 'workers-ai',
    label: 'Workers AI',
    mode: 'embedding',
    detail: `${embedModel} + ${chatModel}`,
    embedModel,
    chatModel,
    retrieveMin: 0.78,

    /** 批量算向量，返回 number[][] */
    async embed(texts) {
      if (!texts.length) return [];
      const out = await ai.run(embedModel, { text: texts });
      const data = pickVectors(out);
      if (!data.length) throw new Error('embedding 返回为空');
      return data;
    },

    async sameThing(a, b) {
      const user = [
        `【建议A】标题：${a.title}`,
        `正文：${String(a.body || '').slice(0, 300)}`,
        `分类：${a.category || ''}`,
        '',
        `【建议B】标题：${b.title}`,
        `正文：${String(b.body || '').slice(0, 300)}`,
        `分类：${b.category || ''}`,
      ].join('\n');
      const json = await chatJson(SAME_SYSTEM, user, 200);
      if (!json) return { same: false, confidence: 0, reason: 'AI 返回无法解析' };
      const confidence = Number(json.confidence);
      return {
        same: json.same === true || json.same === 'true',
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
        reason: String(json.reason || '').slice(0, 40),
      };
    },

    async classify(item) {
      const user = [
        `标题：${item.title}`,
        `正文：${String(item.body || '').slice(0, 400)}`,
        `分类：${item.category || ''}`,
      ].join('\n');
      const json = await chatJson(JUNK_SYSTEM, user, 200);
      if (!json) return { kind: 'ok', confidence: 0, reason: 'AI 返回无法解析' };
      const kinds = ['ok', 'junk', 'ad', 'bot'];
      const kind = kinds.includes(json.kind) ? json.kind : 'ok';
      const confidence = Number(json.confidence);
      return {
        kind,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
        reason: String(json.reason || '').slice(0, 40),
      };
    },
  };
}

module.exports = { create, DEFAULT_EMBED_MODEL, DEFAULT_CHAT_MODEL, extractJson, pickText };
