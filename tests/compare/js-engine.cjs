// The JavaScript engine (demo/js, or a copy of it) as the comparison harness sees it:
// one canonical text per input and layer. See canon.cjs.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { canon } = require('./canon.cjs');

const FILES = ['geom.js', 'lexer.js', 'parser.js', 'stdlib.js', 'compile.js', 'model3d.js', 'kicad.js'];

/** Load the engine in DIR afresh (its own module instances). */
function load(dir) {
  dir = path.resolve(dir);
  for (const f of FILES) delete require.cache[path.join(dir, f)];
  const req = (f) => require(path.join(dir, f));
  return { L: req('lexer.js'), P: req('parser.js'), C: req('compile.js'), M: req('model3d.js'), K: req('kicad.js'), stdlib: req('stdlib.js') };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function engine(dir) {
  const { L, P, C, M, K } = load(dir);

  // lex: every token, the parser's stream (as indices into `all`, or the token itself
  // when the lexer made one up, like the `end` a `}` becomes), and the diagnostics
  function lex(src) {
    const diags = [];
    const lx = L.lex(src, diags);
    const index = new Map(lx.all.map((t, i) => [t, i]));
    const stream = lx.tokens.map((t) => (index.has(t) ? index.get(t) : t));
    return canon({ all: lx.all, stream, eof: lx.eof, diags }, null);
  }

  function parse(src) {
    const ld = [], pd = [];
    const lx = L.lex(src, ld);
    const ast = P.parse(lx.tokens, pd);
    return canon({ ast, diags: pd }, null);
  }

  // compile: everything but the tokens and the AST (the layers above), with the lazy
  // layers computed and AST nodes inside results summarized
  function compile(src, stdlib) {
    const out = C.compile(src, stdlib ? { cache: false, stdlib } : { cache: false });
    const isAst = astTest(out.ast);
    const view = {
      diagnostics: out.diagnostics,
      footprints: out.footprints,
      templates: out.templates,
      tables: out.tables,
      library: { diagnostics: out.library && out.library.diagnostics },
    };
    return { text: canon(view, isAst), out, isAst };
  }

  // core: the compile view without the lazy layers (silk, assembly, courtyard and the
  // boxes that come with them), which are getters on each result
  const plain = (r) => {
    if (!r) return r;
    const o = {};
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(r))) if ('value' in d) o[k] = d.value;
    return o;
  };
  function coreText(out) {
    const view = {
      diagnostics: out.diagnostics,
      footprints: out.footprints.map((f) => Object.assign({}, f, { result: plain(f.result) })),
      templates: out.templates,
      tables: out.tables,
      library: { diagnostics: out.library && out.library.diagnostics },
    };
    return canon(view, astTest(out.ast));
  }
  function core(src, stdlib) {
    return coreText(C.compile(src, stdlib ? { cache: false, stdlib } : { cache: false }));
  }

  // cache: a sequence of sources (a JSON array) compiled with the cache on, as the editor
  // does; for each compile, which footprints reused an earlier result, then its core view
  function cache(seqText, stdlib) {
    const seq = JSON.parse(seqText);
    C.clearCache();
    const seen = new Set();
    const parts = [];
    for (const src of seq) {
      const out = C.compile(src, stdlib ? { stdlib } : {});
      const hits = out.footprints.map((f) => (f.result && seen.has(f.result) ? 1 : 0));
      for (const f of out.footprints) if (f.result) seen.add(f.result);
      parts.push(JSON.stringify(hits) + coreText(out));
    }
    C.clearCache();
    return parts.join('\n');
  }

  // kicad: each footprint's KiCad text, without its 3D model (models compares those)
  function kicad(src, stdlib) {
    const out = C.compile(src, stdlib ? { cache: false, stdlib } : { cache: false });
    return out.footprints.map((fp) => (fp.result ? K.footprint(fp.result, { name: fp.name }).text : `(none ${fp.name})\n`)).join('');
  }

  // model: each footprint's model and board; exports: KiCad text, VRML, STL
  function models(src, stdlib) {
    const { out, isAst } = compile(src, stdlib);
    const rows = [];
    for (const fp of out.footprints) {
      if (!fp.result) { rows.push({ name: fp.name, none: true }); continue; }
      let model, board, err = null;
      try { model = M.build(fp.result); board = M.board(fp.result, model); } catch (e) { err = String(e && e.message || e); }
      if (err) { rows.push({ name: fp.name, error: err }); continue; }
      const ki = K.footprint(fp.result, { name: fp.name, model });
      rows.push({
        name: fp.name,
        model: canon(Object.assign({}, model, { hooks: undefined }), isAst),
        board: canon(board, isAst),
        kicad: ki.text,
        vrml: model.none ? '' : M.toVRML(model),
        stl: model.none ? '' : sha(Buffer.from(M.toSTL(model))),
      });
    }
    return rows;
  }

  return { lex, parse, core, cache, kicad, compile: (src, stdlib) => compile(src, stdlib).text, models, raw: { L, P, C, M, K } };
}

/**
 * Objects reachable from the AST are AST nodes; so is anything from the standard
 * library, whose offsets start at 1e9. Arrays are never summarized.
 */
function astTest(ast) {
  const set = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || set.has(o)) return;
    set.add(o);
    for (const k of Object.keys(o)) walk(o[k]);
  })(ast);
  return (o) => !Array.isArray(o) && (set.has(o) || (typeof o.s === 'number' && o.s >= 1e9));
}

module.exports = { engine, load, sha };
