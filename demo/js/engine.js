/* stomp: the C++ engine (stomp-core.js, WebAssembly) as the rest of the editor sees it.
 *
 * Stomp.ready resolves once the module has loaded; after that every call is synchronous.
 * Stomp.engine.lex(text) gives what the JavaScript lexer gives: { tokens, all, eof }, the
 * parser's stream sharing its token objects with `all`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stomp-core.js'));
  else {
    const S = root.Stomp = root.Stomp || {};
    S.engine = factory(S.core);
    S.ready = S.engine.ready;
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  let M = null;
  const ready = core.then((m) => { M = m; return api; });

  // Text goes in as UTF-16 through one buffer that grows as needed
  let inPtr = 0, inCap = 0;
  function put(text) {
    const n = text.length;
    if (n * 2 > inCap) {
      if (inPtr) M._free(inPtr);
      inCap = Math.max(n * 2, 1 << 16);
      inPtr = M._malloc(inCap);
    }
    const h = M.HEAPU16, base = inPtr >> 1;
    for (let i = 0; i < n; i++) h[base + i] = text.charCodeAt(i);
    return inPtr;
  }
  function out32() {
    const p = M._stomp_out32_ptr() >> 2, n = M._stomp_out32_len();
    return M.HEAP32.subarray(p, p + n);
  }

  const TYPES = ['word', 'num', 'str', 'p', 'nl', 'comment', 'bad', 'eof'];

  /** The tokens of text, decoded from stomp_lex (wasm/exports.cpp put_token). */
  function lex(text) {
    if (!M) throw new Error('stomp: the engine is still loading (wait for Stomp.ready)');
    if (M._stomp_lex(put(text), text.length) !== 0) throw new Error('internal error in the lexer');
    const a = out32();
    let i = 0;
    const starts = [0];
    for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) starts.push(k + 1);
    const lineOf = (off) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const units = () => {
      const n = a[i++];
      let s = '';
      for (let k = 0; k < n; k += 8192) s += String.fromCharCode.apply(null, a.subarray(i + k, i + Math.min(n, k + 8192)));
      i += n;
      return s;
    };
    function token() {
      const t = TYPES[a[i]], s = a[i + 1], e = a[i + 2], info = a[i + 3];
      i += 4;
      const ln = lineOf(s);
      const k = { t, s, e, line: ln + 1, col: s - starts[ln] + 1 };
      switch (t) {
        case 'word':
          k.v = info & 2 ? 'end' : text.slice(s, e);
          k.kw = !!(info & 1);
          if (info & 2) k.brace = true;
          break;
        case 'num': {
          const numLen = info & 0xffff, axis = (info >> 17) & 3;
          const num = text.slice(s, s + numLen);
          k.v = parseFloat(num.startsWith('.') ? '0' + num : num);
          k.text = text.slice(s, e);
          k.num = num;
          k.suffix = info & (1 << 16) ? text.slice(s + numLen, e - (axis ? 1 : 0)) : null;
          if (info & (1 << 19)) k.axis = axis === 1 ? 'w' : axis === 2 ? 'h' : null;
          k.isInt = !!(info & (1 << 20));
          break;
        }
        case 'str':
          if (info < 0) { k.v = units(); k.parts = null; break; }
          k.v = null;
          k.parts = [];
          for (let p = 0; p < info; p++) {
            if (a[i++] === 0) {
              const ps = a[i], pe = a[i + 1];
              i += 2;
              k.parts.push({ lit: units(), s: ps, e: pe });
            } else {
              const part = { open: a[i], close: a[i + 1], codeS: a[i + 2], codeE: a[i + 3], fmt: a[i + 4] < 0 ? null : a[i + 4], fmtS: a[i + 5] < 0 ? null : a[i + 5] };
              const n = a[i + 6];
              i += 7;
              const all = [];
              for (let q = 0; q < n; q++) all.push(token());
              part.toks = all.filter((c) => c.t !== 'comment' && c.t !== 'bad');
              part.all = all;
              k.parts.push(part);
            }
          }
          break;
        case 'p':
        case 'comment':
          k.v = text.slice(s, e);
          break;
        case 'bad':
          k.v = text.slice(s, e);
          if (k.v === '{' || k.v === '}') k.brace = k.v;
          break;
        default:
          break;
      }
      return k;
    }
    const all = [];
    for (let n = a[i++], k = 0; k < n; k++) all.push(token());
    const tokens = [];
    for (let n = a[i++], k = 0; k < n; k++) {
      const at = a[i++];
      tokens.push(at >= 0 ? all[at] : token());
    }
    const es = a[i], ln = lineOf(es);
    const eof = { t: 'eof', s: es, e: a[i + 1], line: ln + 1, col: es - starts[ln] + 1 };
    tokens.push(eof);
    return { tokens, all, eof };
  }

  const api = {
    ready,
    lex,
    version: () => M.UTF8ToString(M._stomp_version()),
  };
  return api;
});
