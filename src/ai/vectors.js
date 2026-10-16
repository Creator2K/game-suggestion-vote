'use strict';

/**
 * 向量的存取与比较。
 *
 * 存成 base64 的 Float32 小端字节，而不是 BLOB：两个运行时的 SQLite
 * 对 BLOB 的绑定/读回类型不一致（node:sqlite 给 Uint8Array，DO 给 ArrayBuffer），
 * 用 TEXT 存就没有这个差异，代价只是体积大三分之一左右。
 */

const b64encode = typeof btoa === 'function' ? btoa : (bin) => Buffer.from(bin, 'binary').toString('base64');
const b64decode = typeof atob === 'function' ? atob : (s) => Buffer.from(s, 'base64').toString('binary');

/** Float32Array → base64 */
function encode(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return b64encode(bin);
}

/** base64 → Float32Array */
function decode(text) {
  const bin = b64decode(String(text || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer, 0, Math.floor(u8.length / 4));
}

/** 归一化（之后点积就是余弦），原地改并返回 */
function normalizeInPlace(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i += 1) sum += f32[i] * f32[i];
  const len = Math.sqrt(sum);
  if (len > 0) {
    for (let i = 0; i < f32.length; i += 1) f32[i] /= len;
  }
  return f32;
}

/** 余弦相似度；输入已归一化时就是点积 */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { encode, decode, normalizeInPlace, cosine };
