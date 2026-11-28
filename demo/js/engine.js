/* stomp: the C++ engine (stomp-core.js, WebAssembly) as the rest of the editor sees it.
 *
 * Stomp.ready resolves once the module has loaded; after that every call is synchronous.
 * The API is the one the editor used with the JavaScript engine this replaced:
 *   Stomp.compile(source, { stdlib, cache })   Stomp.compiler.{ locate, clearCache, D, HOOKS, UNIT_MM }
 *   Stomp.lexer.lex(text)                      Stomp.model3d.{ build, board, toVRML, toSTL }
 *   Stomp.kicad.{ footprint, library, checksum, murmur3x64, zstdFrame, base64 }
 * The standard library compiles use is the page's (stdlib.js, loaded before this file),
 * handed to the engine when it starts.
 *
 * Results and models stay in the engine; the objects here carry their ids. A footprint
 * that comes back unchanged from the build cache is the same object as before, so maps
 * keyed by results keep working. A result's silk, assembly and courtyard, and its pads'
 * and holes' outlines, load on first use.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stomp-core.js'), () => require('./stdlib.js'));
  else {
    const S = root.Stomp = root.Stomp || {};
    const api = factory(S.core, () => S.stdlib);
    S.engine = api;
    S.ready = api.ready;
    S.compile = api.compile;
    S.compiler = api.compiler;
    S.lexer = api.lexer;
    S.model3d = api.model3d;
    S.kicad = api.kicad;
  }
})(typeof self !== 'undefined' ? self : this, function (core, stdlib) {
  'use strict';
  let M = null;
  let K = null;   // the engine's constants
  const ready = core.then((m) => {
    M = m;
    if (M._stomp_constants() !== 0) throw new Error('stomp: the engine failed to start');
    K = JSON.parse(outText());
    // the library is the page's (stdlib.js), so the editor shows the files it compiles with
    const lib = stdlib();
    if (lib) setLibrary(lib);
    return api;
  });
  const need = () => { if (!M) throw new Error('stomp: the engine is still loading (wait for Stomp.ready)'); };

  const enc = new TextEncoder(), dec = new TextDecoder();
  // Text goes in as UTF-16 through buffers that grow as needed (two, for calls that take two)
  const bufs = [{ ptr: 0, cap: 0 }, { ptr: 0, cap: 0 }];
  function put(text, k) {
    const b = bufs[k || 0], n = text.length;
    if (n * 2 + 2 > b.cap) {
      if (b.ptr) M._free(b.ptr);
      b.cap = Math.max(n * 2 + 2, 1 << 16);
      b.ptr = M._malloc(b.cap);
    }
    const h = M.HEAPU16, base = b.ptr >> 1;
    for (let i = 0; i < n; i++) h[base + i] = text.charCodeAt(i);
    return b.ptr;
  }
  /** Bytes into a fresh allocation, freed by the caller. */
  function putBytes(bytes) {
    const p = M._malloc(Math.max(1, bytes.length));
    M.HEAPU8.set(bytes, p);
    return p;
  }
  const outBytes = () => M.HEAPU8.subarray(M._stomp_out_ptr(), M._stomp_out_ptr() + M._stomp_out_len());
  const outText = () => dec.decode(outBytes());
  const fail = () => new Error(`stomp: ${outText()}`);
  const json = (rc) => { if (rc !== 0) throw fail(); return JSON.parse(outText()); };
  function out32() {
    const p = M._stomp_out32_ptr() >> 2, n = M._stomp_out32_len();
    return M.HEAP32.subarray(p, p + n);
  }

  // Lexing (wasm/exports.cpp put_token)

  const TYPES = ['word', 'num', 'str', 'p', 'nl', 'comment', 'bad', 'eof'];

  /** The tokens of text: { tokens, all, eof }, the parser's stream sharing its token objects with `all`. */
  function lex(text) {
    need();
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

  // Results and models

  // The engine keeps the last compile's results and the most recently used others, and
  // lets older ones go. An object here remembers where it came from: if the engine let its
  // result go, it is compiled again (the values are the same), and a model is built again.
  const HANDLE = Symbol('stomp id'), ORIGIN = Symbol('stomp origin');
  const RELEASED_RESULT = 2, RELEASED_MODEL = 3;
  const LAZY = ['silk', 'assembly', 'courtyard', 'bbox', 'courtyardBox', 'courtyardClearance'];
  const PAD_OUTLINES = ['land', 'copper', 'mask', 'paste', 'drillShape'], HOLE_OUTLINES = ['land', 'mask'];
  const live = new Map();   // result id -> WeakRef to its object, so a cached footprint is the same object
  const forget = new FinalizationRegistry((id) => {
    const ref = live.get(id);
    if (ref && !ref.deref()) live.delete(id);
  });
  const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, configurable: true });
  const getter = (o, k, get) => Object.defineProperty(o, k, { get, enumerable: true, configurable: true });
  // A pad's and a hole's outlines come with nulls in their places; these getters, shared by
  // every pad and hole, load them: AT holds the result's loader and the item's index.
  const AT = Symbol('stomp outlines');
  const outlineGetters = (list, keys) => Object.fromEntries(keys.map((k, j) => [k, {
    get() { const [load, i] = this[AT]; return load()[list][i][j]; }, enumerable: true, configurable: true,
  }]));
  const PAD_GETTERS = outlineGetters('pads', PAD_OUTLINES), HOLE_GETTERS = outlineGetters('holes', HOLE_OUTLINES);

  /** Run fn(resultId, modelId) until the engine has what it needs; it returns 0 when done. */
  function run(fn, res, model) {
    for (let tries = 0; ; tries++) {
      const rc = fn(res ? res[HANDLE] : 0, model ? model[HANDLE] : 0);
      if (rc === 0) return;
      if (tries < 4 && rc === RELEASED_RESULT && res) recompile(res);
      else if (tries < 4 && rc === RELEASED_MODEL && model) rebuild(model);
      else throw fail();
    }
  }
  const parsed = (fn, res, model) => { run(fn, res, model); return JSON.parse(outText()); };
  const made = { recompiled: 0, rebuilt: 0 };   // for the tests
  function recompile(r) {
    made.recompiled++;
    const { job, index } = r[ORIGIN];
    const lp = job.lib ? putBytes(job.lib) : 0;
    let rc;
    try { rc = M._stomp_recompile(put(job.source), job.source.length, lp, job.lib ? job.lib.length : 0, 0, index); } finally { if (lp) M._free(lp); }
    if (rc !== 0) throw fail();
    const id = M._stomp_last_id();
    r[HANDLE] = id;
    // a later compile that finds this result in the cache gets this object back
    const ref = live.get(id);
    if (!(ref && ref.deref())) {
      live.set(id, new WeakRef(r));
      forget.register(r, id);
    }
  }
  function rebuild(m) {
    made.rebuilt++;
    const { res, flags } = m[ORIGIN];
    run((rid) => M._stomp_model(rid, flags | 4), res);
    m[HANDLE] = M._stomp_last_id();
  }
  const checkResult = (r) => { if (!r || r[HANDLE] == null) throw new Error('stomp: that is not a compile result'); };
  const modelArg = (m) => (m && m[HANDLE] ? m : null);

  function resultOf(id, job, index) {
    const ref = live.get(id);
    const have = ref && ref.deref();
    if (have) {
      have[HANDLE] = id;
      have[ORIGIN] = { job, index };
      return have;
    }
    const r = json(M._stomp_result(id));
    hidden(r, HANDLE, id);
    hidden(r, ORIGIN, { job, index });
    let layers = null, outlines = null;
    const lay = () => layers || (layers = parsed((rid) => M._stomp_layers(rid), r));
    const out = () => outlines || (outlines = parsed((rid) => M._stomp_contours(rid), r));
    for (const k of LAZY) getter(r, k, () => lay()[k]);
    r.pads.forEach((p, i) => { Object.defineProperty(p, AT, { value: [out, i] }); Object.defineProperties(p, PAD_GETTERS); });
    r.holes.forEach((h, i) => { Object.defineProperty(h, AT, { value: [out, i] }); Object.defineProperties(h, HOLE_GETTERS); });
    live.set(id, new WeakRef(r));
    forget.register(r, id);
    return r;
  }

  const libraryJson = (files) => enc.encode(JSON.stringify(files.map((f) => ({ file: f.file, source: f.source }))));
  let defaultLib = null;   // what setLibrary sent, so a result compiled again gets the library it had

  /** Compile a file (opts: { stdlib, cache }): { diagnostics, footprints, templates, tables, library }. */
  function compile(source, opts) {
    need();
    source = String(source);
    const own = opts && opts.stdlib ? libraryJson(opts.stdlib) : null;
    const job = { source, lib: own || defaultLib };
    const lp = own ? putBytes(own) : 0;
    let rc;
    try { rc = M._stomp_compile(put(source), source.length, lp, own ? own.length : 0, opts && opts.cache === false ? 1 : 0); } finally { if (lp) M._free(lp); }
    const out = json(rc);
    out.footprints.forEach((f, i) => { f.result = f.result == null ? null : resultOf(f.result, job, i); });
    return out;
  }

  /** The library compiles use when they're given none: [{ file, source }]. */
  function setLibrary(files) {
    need();
    const b = libraryJson(files);
    const p = putBytes(b);
    try { if (M._stomp_set_library(p, b.length) !== 0) throw fail(); } finally { M._free(p); }
    defaultLib = b;
  }

  /** Line and column for diagnostics with offsets into source. */
  function locate(diags, source) {
    need();
    const b = enc.encode(JSON.stringify(diags));
    const p = putBytes(b);
    try { return json(M._stomp_locate(p, b.length, put(String(source)), String(source).length)); } finally { M._free(p); }
  }

  /** Meshes' arrays from the engine's float and index buffers (exports.cpp put_model). */
  function meshes(m) {
    const fp = M._stomp_outF_ptr() >> 2, fn = M._stomp_outF_len();
    const ip = M._stomp_out32_ptr() >> 2, inn = M._stomp_out32_len();
    const F = M.HEAPF32.subarray(fp, fp + fn), I = M.HEAPU32.subarray(ip, ip + inn);
    let f = 0, i = 0;
    for (const me of m.meshes) {
      const n = me.n * 3, t = me.t;
      delete me.n;
      delete me.t;
      me.pos = F.slice(f, f + n); f += n;
      me.nrm = F.slice(f, f + n); f += n;
      me.idx = I.slice(i, i + t); i += t;
    }
    return m;
  }
  /** A footprint's 3D model. opts.strict throws on a problem; opts.recordHooks lists the hooks bound (hookCalls). */
  function build(res, opts) {
    need();
    checkResult(res);
    const flags = (opts && opts.strict ? 1 : 0) | (opts && opts.recordHooks ? 2 : 0);
    const m = meshes(parsed((rid) => M._stomp_model(rid, flags), res));
    hidden(m, HANDLE, M._stomp_last_id());
    hidden(m, ORIGIN, { res, flags: flags & 1 });
    return m;
  }
  /** The board under the part, for the viewer. */
  function board(res, model) {
    need();
    checkResult(res);
    return meshes(parsed((rid, mid) => M._stomp_board(rid, mid), res, modelArg(model)));
  }
  const checkModel = (m) => { if (!m || !m[HANDLE]) throw new Error('stomp: that is not a built model'); };
  function toVRML(model, name) {
    need();
    checkModel(model);
    const nm = String(name || '');
    run((rid, mid) => M._stomp_vrml(mid, put(nm), nm.length), null, model);
    return outText();
  }
  function toSTL(model, name) {
    need();
    checkModel(model);
    const nm = String(name || '');
    run((rid, mid) => M._stomp_stl(mid, put(nm), nm.length), null, model);
    return outBytes().slice();
  }

  // KiCad

  /** One footprint as a KiCad 9 .kicad_mod: { name, file, text, embedded, notes }. */
  function footprint(res, opts) {
    need();
    checkResult(res);
    const nm = String((opts && opts.name) || '');
    return parsed((rid, mid) => M._stomp_kicad(rid, put(nm), nm.length, mid), res, modelArg(opts && opts.model));
  }
  const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/g;
  const safeName = (n) => String(n).replace(BAD_NAME, '_').trim() || 'footprint';
  /**
   * A .pretty library as zip entries [{ name, data }].
   *   fps:  [{ name, result, model, skip }] in file order; skip says why it isn't exported
   *   opts: { lib (library name), source (file the footprints came from) }
   */
  function library(fps, opts) {
    opts = opts || {};
    const lib = safeName(opts.lib || 'stomp').replace(/\.pretty$/, '');
    const files = [], done = [], skipped = [];
    const used = new Set();
    let nModels = 0;
    for (const f of fps) {
      if (f.skip || !f.result) { skipped.push({ name: f.name, why: f.skip || 'it has errors' }); continue; }
      const out = footprint(f.result, { name: f.name, model: f.model });
      let file = out.file;
      for (let k = 2; used.has(file.toLowerCase()); k++) file = `${out.name}_${k}.kicad_mod`;
      used.add(file.toLowerCase());
      files.push({ name: `${lib}.pretty/${file}`, data: enc.encode(out.text) });
      done.push(out);
      if (out.embedded) nModels++;
    }
    const lines = [
      `${lib}.pretty: ${done.length} footprint${done.length === 1 ? '' : 's'}${opts.source ? ` from ${opts.source}` : ''}, exported by stomp.`,
      '',
      nModels ? `${nModels} of them embed their generated 3D model (VRML), so the library needs no 3D model folder.` : 'None of them has a 3D model.',
      'These are KiCad 9 footprints. They open in KiCad 9 or later.',
      '',
      'To use the library in KiCad: unzip it, then Preferences > Manage Footprint Libraries,',
      '"Add existing library" (the folder button), and choose the .pretty folder.',
    ];
    if (skipped.length) lines.push('', 'Not exported:', ...skipped.map((s) => `  ${s.name}: ${s.why}`));
    files.push({ name: 'README.txt', data: enc.encode(lines.join('\n') + '\n') });
    return { lib, files, count: done.length, models: nModels, skipped };
  }
  function encode(op, bytes, seed) {
    need();
    const p = putBytes(bytes);
    try { if (M._stomp_encode(op, p, bytes.length, seed >>> 0) !== 0) throw fail(); } finally { M._free(p); }
  }
  const SEED = 0xABBA2345;

  // For tools and tests: a file's items and the problems the parser finds
  function outline(text) { need(); return json(M._stomp_outline(put(text), text.length)); }
  function syntax(text) { need(); return json(M._stomp_syntax(put(text), text.length)); }

  const api = {
    ready,
    version: () => M.UTF8ToString(M._stomp_version()),
    /** The engine's memory: bytes in use, and the size of its heap (which never shrinks). */
    memory: () => ({ used: M._stomp_memory() >>> 0, heap: M.HEAPU8.length }),
    /** How many results were compiled again, and models built again, because the engine had let them go. */
    remade: () => Object.assign({}, made),
    lex,
    compile,
    setLibrary,
    outline,
    syntax,
    compiler: {
      compile,
      locate,
      clearCache: () => { need(); M._stomp_clear_cache(); },
      get D() { need(); return K.D; },
      get HOOKS() { need(); return K.HOOKS; },
      get UNIT_MM() { need(); return K.UNIT_MM; },
    },
    lexer: { lex },
    model3d: { build, board, toVRML, toSTL, BOARD_T: 1.6 },
    kicad: {
      footprint,
      library,
      utf8: (s) => enc.encode(s),
      checksum: (bytes, seed) => { encode(0, bytes, seed == null ? SEED : seed); return outText(); },
      murmur3x64: (bytes, seed) => { encode(1, bytes, seed); return outBytes().slice(); },
      zstdFrame: (bytes) => { encode(2, bytes, 0); return outBytes().slice(); },
      base64: (bytes) => { encode(3, bytes, 0); return outText(); },
      KICAD_VERSION: 20241229,
      SEED,
    },
  };
  return api;
});
