'use strict';

/**
 * 本地规则「判定器」：没有 AI 时（本机 Node）用它兜底。
 *
 * 它只做两件有把握的事：字面高度重合算重复、一眼能看出的引流词算广告。
 * 语义相近但说法不同的情况它抓不到——那是 embedding 的活。
 * 所以后台界面上会明确标出「本地规则」还是「Workers AI」，不让人误以为
 * 本地规则的结果和 AI 一样可靠。
 */

const text = require('./text');

/** 本地模式下：低于它不进候选 */
const RETRIEVE_MIN = 0.6;
/** 本地模式下：高于它算「同一件事」 */
const SAME_MIN = 0.8;

function create() {
  return {
    name: 'local',
    label: '本地规则',
    mode: 'lexical',
    detail: '字符 2-gram 相似度（无语义理解）',
    retrieveMin: RETRIEVE_MIN,

    score(a, b) {
      return text.score(a, b);
    },

    async sameThing(a, b) {
      const score = text.score(a, b);
      return {
        same: score >= SAME_MIN,
        confidence: Number(score.toFixed(4)),
        reason: `文字重合度 ${(score * 100).toFixed(0)}%`,
      };
    },

    async classify(item) {
      return text.localJunk(item);
    },
  };
}

module.exports = { create, RETRIEVE_MIN, SAME_MIN };
