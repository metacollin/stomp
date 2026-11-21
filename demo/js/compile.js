/* stomp live demo — evaluator: source text → solved footprint geometry.
 *
 *   compile(source) → { diagnostics, footprints: [{ name, s, e, result }], templates, tokens }
 *
 * Pipeline per footprint (SPEC section in brackets):
 *   flatten   `from` templates and `extends` parents into one statement list,
 *             tagging each with its inheritance level                     [§14]
 *   gather    singletons (body, lead, density, …), objects, placements    [§5–§13]
 *   generate  pins / balls / sides → named pads with weak default places  [§11]
 *   geometry  explicit > mirror > pins-pad / default pad > IPC-derived    [§10, §11.3]
 *   solve     per-axis single-assignment constraint propagation            [§9]
 *   layers    copper, mask, paste, drills, silk, courtyard, assembly       [§12]
 *
 * Semantic decisions the draft spec leaves open are marked "DEMO DECISION".
 * Internally lengths are float millimetres (the spec's int64 nm is a target
 * for the real implementation; display rounds to 1 nm).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./geom.js'), require('./lexer.js'), require('./parser.js'));
  } else {
    const S = root.Stomp;
    S.compiler = factory(S.geom, S.lexer, S.parser);
    S.compile = S.compiler.compile;
  }
})(typeof self !== 'undefined' ? self : this, function (G, Lexer, Parser) {
  'use strict';

  const UNIT_MM = { mm: 1, um: 0.001, nm: 1e-6, mil: 0.0254, in: 25.4 };
  const AXES = ['x', 'y'];
  const OTHER = { x: 'y', y: 'x' };

  // Stack-rule placeholders and drawing defaults (DEMO DECISION: no stack file yet)
  const D = {
    mask: 0.05,             // solder-mask expansion per side
    maskDefinedOverlap: 0.05, // copper beyond the mask opening on `mask defined` pads
    holeMask: 0.05,
    silkW: 0.12, silkClear: 0.15, silkOffset: 0.11,
    fabW: 0.1, crtW: 0.05,
    dot: 0.3,
    tol: Math.hypot(0.05, 0.025),  // IPC fabrication (F) ⊕ placement (P) tolerance, no part tolerance
  };

  // IPC-7351B-style fillet goals [most, nominal, least] (mm)
  const LEVEL = { most: 0, nominal: 1, least: 2 };
  const IPC = {
    gullwing: { name: 'gull-wing', toe: [0.55, 0.35, 0.15], heel: [0.45, 0.35, 0.25], side: [0.05, 0.03, 0.01], cy: [0.5, 0.25, 0.1] },
    gullwingFine: { name: 'gull-wing ≤0.625 pitch', toe: [0.55, 0.35, 0.15], heel: [0.45, 0.35, 0.25], side: [0.01, -0.02, -0.04], cy: [0.5, 0.25, 0.1] },
    jlead: { name: 'J-lead', toe: [0.55, 0.35, 0.15], heel: [0.10, 0.00, -0.10], side: [0.05, 0.03, 0.01], cy: [0.5, 0.25, 0.1] },
    flat: { name: 'flat no-lead', toe: [0.40, 0.30, 0.20], heel: [0, 0, 0], side: [-0.04, -0.04, -0.04], cy: [0.5, 0.25, 0.1] },
    chip: { name: 'chip ≥1608', toe: [0.55, 0.35, 0.15], heel: [0.00, -0.05, -0.10], side: [0.05, 0.00, -0.05], cy: [0.5, 0.25, 0.1] },
    chipSmall: { name: 'chip <1608', toe: [0.20, 0.10, 0.05], heel: [0, 0, 0], side: [0.05, 0.00, -0.05], cy: [0.2, 0.15, 0.1] },
  };
  const THT = { allowance: [0.25, 0.20, 0.15], ring: [0.40, 0.30, 0.20] };
  const CY_DEFAULT = [0.5, 0.25, 0.1];
  const BALL_LAND = 0.8;
  const JEDEC_ROWS = 'ABCDEFGHJKLMNPRTUVWY';

  class StompError extends Error {
    constructor(message, node, related) { super(message); this.node = node; this.related = related; }
  }
  const SILENT = (node) => Object.assign(new StompError('', node), { silent: true });

  // ===================================================================== values

  // Value kinds: 'num' (plain literal-derived; becomes a length in the file's
  // default unit where one is needed), 'ratio' (length ÷ length), 'len' (mm),
  // 'str' (text — only usable inside a string's `{…}`).
  const KIND_NAME = { num: 'number', ratio: 'ratio', len: 'length', str: 'text' };

  function evalExpr(x, env) {
    switch (x.type) {
      case 'num': return x.unit ? { k: 'len', v: x.v * UNIT_MM[x.unit] } : { k: 'num', v: x.v };
      case 'id': return env.scope.lookup(x.name, x);
      case 'str': return { k: 'str', v: interpolate(x.value, env) };
      case 'paren': return evalExpr(x.x, env);
      case 'neg': {
        const a = evalExpr(x.x, env);
        if (a.k === 'str') throw new StompError('text can\'t be negated — text values are only for `{…}` in strings', x);
        return { k: a.k, v: -a.v };
      }
      case 'bin': {
        const a = evalExpr(x.a, env), b = evalExpr(x.b, env);
        if (a.k === 'str' || b.k === 'str') {
          throw new StompError('text can\'t take part in arithmetic — to build a string, write the pieces into one: "{a}-{b}"', x);
        }
        if (x.op === '+' || x.op === '-') {
          const sg = x.op === '+' ? 1 : -1;
          if (a.k === b.k) return { k: a.k, v: a.v + sg * b.v };
          if (a.k === 'len' && b.k === 'num') return { k: 'len', v: a.v + sg * b.v * env.scale };
          if (a.k === 'num' && b.k === 'len') return { k: 'len', v: a.v * env.scale + sg * b.v };
          if (a.k !== 'len' && b.k !== 'len') return { k: 'ratio', v: a.v + sg * b.v };
          throw new StompError(`can't ${x.op === '+' ? 'add' : 'subtract'} a ${KIND_NAME[b.k]} ${x.op === '+' ? 'to' : 'from'} a ${KIND_NAME[a.k]}`, x);
        }
        if (x.op === '*') {
          if (a.k === 'len' && b.k === 'len') throw new StompError('multiplying two lengths gives an area — a unit error', x);
          if (a.k === 'len' || b.k === 'len') return { k: 'len', v: a.v * b.v };
          return { k: a.k === 'ratio' || b.k === 'ratio' ? 'ratio' : 'num', v: a.v * b.v };
        }
        if (b.v === 0) throw new StompError('division by zero', x);
        if (a.k === 'len' && b.k === 'len') return { k: 'ratio', v: a.v / b.v };
        if (b.k === 'len') throw new StompError(`can't divide a ${KIND_NAME[a.k]} by a length`, x);
        if (a.k === 'len') return { k: 'len', v: a.v / b.v };
        return { k: a.k === 'ratio' || b.k === 'ratio' ? 'ratio' : 'num', v: a.v / b.v };
      }
      default: throw new StompError('bad expression', x);
    }
  }

  /** A string literal: plain text, or { interp: [text | { x, fmt }] } evaluated in env. */
  function interpolate(value, env) {
    if (typeof value === 'string') return value;
    let out = '';
    for (const p of value.interp) out += typeof p === 'string' ? p : formatValue(p.x ? evalExpr(p.x, env) : null, p.fmt, env);
    return out;
  }

  /** How a value prints inside `{…}`: text verbatim, numbers in their shortest form,
   *  lengths in the file's units; `{x:.N}` fixes N decimal places. */
  function formatValue(v, fmt, env) {
    if (!v) return '';
    if (v.k === 'str') return v.v;
    const n = v.k === 'len' ? v.v / env.scale : v.v;
    return formatNumber(n, fmt);
  }
  function formatNumber(n, fmt) {
    if (fmt != null) {
      const t = n.toFixed(fmt);
      return /^-0\.?0*$/.test(t) ? t.slice(1) : t;
    }
    let r = +n.toFixed(6);
    if (Object.is(r, -0)) r = 0;
    return String(r);
  }

  class Scope {
    constructor(parent) { this.parent = parent; this.defs = new Map(); }
    lookup(name, node) {
      for (let sc = this; sc; sc = sc.parent) {
        const d = sc.defs.get(name);
        if (!d) continue;
        if (d.value) return d.value;
        if (d.busy) throw new StompError(`\`${name}\` is defined in terms of itself`, node);
        d.busy = true;
        try { d.value = evalExpr(d.x, { scope: d.scope || sc, scale: UNIT_MM[d.unit || 'mm'] }); } finally { d.busy = false; }
        return d.value;
      }
      const all = [];
      for (let sc = this; sc; sc = sc.parent) all.push(...sc.defs.keys());
      const hint = Parser.suggest(name, all);
      throw new StompError(`unknown name \`${name}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`, node);
    }
  }

  // ===================================================================== compile

  // Results of earlier compiles, keyed by everything a footprint is built from. Editing
  // one row of a big table then re-evaluates just that row. Keys hold the source text
  // (and, where results carry source offsets, those offsets) of the footprint, its
  // template and the file's lets; a table row's own offset is left out, and
  // diagnostics inside the row are shifted when replayed.
  const CACHE = new Map();
  const CACHE_MAX = 1500;

  function compile(source, opts) {
    const useCache = !(opts && opts.cache === false);
    const diags = [];
    const lx = Lexer.lex(source, diags);
    const ast = Parser.parse(lx.tokens, diags);
    const file = buildFile(ast, diags);

    // every footprint declaration, with each table row as a `from` call [§14]
    const decls = [];
    const tables = [];
    for (const it of ast.items) {
      if (it.type === 'Footprint') decls.push(it);
      else if (it.type === 'Table') {
        const rows = rowDecls(it);
        decls.push(...rows);
        tables.push({ node: it, rows });
        if (!it.rows.length) diags.push({ severity: 'warning', message: 'this table has no rows yet', s: it.callS, e: it.callE });
      }
    }

    // pass 1: name every footprint (templates may compute names), then register them
    const letsSig = JSON.stringify(ast.items.filter((i) => i.type === 'Let').map((i) => [i.s, source.slice(i.s, i.e), i.unit]));
    const builders = decls.map((d) => {
      const b = new FootprintBuilder(d, file, [], source);
      b.key = useCache ? cacheKey(d, source, file, letsSig) : null;
      const hit = b.key && CACHE.get(b.key);
      if (hit) {
        CACHE.delete(b.key); CACHE.set(b.key, hit);       // keep recently used entries
        b.cached = hit; b.name = hit.name; b.tmpl = hit.tmpl;
      }
      return b;
    });
    for (const b of builders) {
      const d = b.decl;
      if (b.cached) continue;
      safely(b, () => {
        if (d.mode !== 'extends') b.prepare();
        b.name = b.computeName();
      });
      if (d.mode === 'extends') d.parentName = safely(b, () => b.nameOf(d.parent));
      if (!b.name) {
        // placeholders depend on position, which cache keys leave out: don't cache them
        b.key = null;
        b.name = d.table ? `${d.template.name} row ${d.rowIndex + 1}` : `(unnamed, line ${b.lineAt(d.s)})`;
      }
    }
    const seen = new Map();
    for (const b of builders) {
      const d = b.decl;
      const first = seen.get(b.name);
      if (first) {
        const where = first.decl.table && first.decl.table === d.table ? `row ${first.decl.rowIndex + 1} of this table` : `line ${b.lineAt(first.decl.s)}`;
        diags.push({
          severity: 'error', message: `footprint name "${b.name}" is already used by ${where} — names must be unique`,
          s: d.nameS, e: d.nameE, related: [{ message: 'first used here', s: first.decl.nameS, e: first.decl.nameE }],
        });
        let k = 2;
        while (seen.has(`${b.name} #${k}`)) k++;
        b.name = `${b.name} #${k}`;
        b.cached = null;      // a renamed duplicate is rebuilt under its new name
      }
      seen.set(b.name, b);
      d.computedName = b.name;
      if (!file.footprints.has(b.name)) file.footprints.set(b.name, d);
    }

    // pass 2: build (or replay a cached build)
    const footprints = [];
    for (const b of builders) {
      const d = b.decl;
      let result;
      if (b.cached) {
        result = b.cached.result;
        diags.push(...replay(b.cached, d));
      } else {
        result = safely(b, () => b.build()) || null;
        if (b.key) {
          CACHE.set(b.key, { name: b.name, result, diags: b.diags.slice(), tmpl: b.tmpl, rowS: d.s, rowE: d.e });
          if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
        }
        diags.push(...b.diags);
        b.src = null;
      }
      footprints.push({
        name: b.name, s: d.s, e: d.e, nameS: d.nameS, nameE: d.nameE, mode: d.mode, result, deps: depRanges(d, file),
        origin: d.table ? { kind: 'row', row: d.rowIndex + 1, template: d.template.name, tableS: d.table.s }
          : d.mode === 'from' ? { kind: 'call', template: d.template.name } : { kind: d.mode },
      });
    }
    const users = (name) => builders.filter((b) => b.decl.mode === 'from' && b.decl.template.name === name).map((b) => b.name);
    const templates = ast.items.filter((i) => i.type === 'Template').map((t) => ({ name: t.name, s: t.s, e: t.e, users: users(t.name) }));
    const tableInfo = tables.map(({ node, rows }) => ({
      template: node.template.name, s: node.s, e: node.e, head: source.slice(node.s, node.callE), users: rows.map((r) => r.computedName),
    }));
    // instantiations per template, for deciding where template diagnostics belong
    const instCount = new Map();
    for (const b of builders) if (b.tmpl) instCount.set(b.tmpl.name, (instCount.get(b.tmpl.name) || 0) + 1);
    return { diagnostics: finishDiags(rehome(diags, instCount), source), footprints, templates, tables: tableInfo, tokens: lx.all, ast };
  }

  function safely(b, fn) {
    const diags = b.diags;
    try { return fn(); } catch (err) {
      const d = b.decl;
      if (err instanceof StompError) {
        if (!err.silent) diags.push({ severity: 'error', message: err.message, s: err.node ? err.node.s : d.s, e: err.node ? err.node.e : d.e });
      } else {
        diags.push({ severity: 'error', message: `internal error while evaluating "${b.name || d.computedName || 'footprint'}": ${err && err.message}`, s: d.nameS, e: d.nameE });
        if (typeof console !== 'undefined') console.error(err);
      }
      return undefined;
    }
  }

  /** Everything a footprint's build depends on, or null when it isn't cached (extends). */
  function cacheKey(d, source, file, letsSig) {
    const txt = (a, b) => source.slice(a, b);
    if (d.mode === 'from') {
      const t = file.templates.get(d.template.name);
      const tmpl = t ? [t.s, txt(t.s, t.e), t.unit] : ['?', d.template.name];
      if (d.table) {
        const tb = d.table;
        return JSON.stringify(['row', tmpl, d.unit, d.args.map((a) => [a.key, txt(a.s, a.e)]), tb.callS, txt(tb.callS, tb.headerE), letsSig]);
      }
      return JSON.stringify(['call', tmpl, d.unit, d.s, txt(d.s, d.e), letsSig]);
    }
    if (d.mode === 'block') return JSON.stringify(['block', d.s, txt(d.s, d.e), d.unit, letsSig]);
    return null;
  }

  /** Diagnostics of a cached build, moved along with their table row. */
  function replay(entry, d) {
    const delta = d.table ? d.s - entry.rowS : 0;
    const move = (o) => {
      if (!o || !delta || o.s < entry.rowS || o.e > entry.rowE) return o ? Object.assign({}, o) : o;
      return Object.assign({}, o, { s: o.s + delta, e: o.e + delta });
    };
    return entry.diags.map((x) => Object.assign(move(x), { inst: move(x.inst), related: (x.related || []).map(move) }));
  }

  /** Each table row is a `from` call of the table's template [§14]. */
  function rowDecls(table) {
    return table.rows.map((row, i) => ({
      type: 'Footprint', mode: 'from', name: null, template: table.template,
      args: table.args.concat(row.cells.map((c, j) => ({ key: table.header[j].name, x: c.x, s: c.s, e: c.e, hdr: table.header[j] }))),
      body: null, s: row.s, e: row.e, nameS: row.s, nameE: row.e, callS: row.s, callE: row.e,
      unit: table.unit, table, row, rowIndex: i, missingAt: { s: table.callS, e: table.headerE },
    }));
  }

  /**
   * A diagnostic inside a template body is reported once at the template when every
   * call of the template produces it (a bug in the template), and otherwise on the
   * calls that produce it — the table row or `from` call with the bad values.
   */
  function rehome(diags, instCount) {
    const out = [];
    const groups = new Map();
    for (const d of diags) {
      if (!d.inst) { out.push(d); continue; }
      const k = `${d.severity}|${d.s}|${d.e}|${d.message}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    for (const list of groups.values()) {
      const t = list[0].inst.tmpl;
      const calls = new Set(list.map((d) => `${d.inst.s}:${d.inst.e}`));
      if (calls.size >= (instCount.get(t) || 1)) { out.push(Object.assign({}, list[0], { inst: undefined })); continue; }
      for (const d of list) {
        out.push(Object.assign({}, d, {
          s: d.inst.s, e: d.inst.e, inst: undefined,
          related: [{ message: `in template ${t}`, s: d.s, e: d.e }].concat(d.related || []),
        }));
      }
    }
    return out;
  }

  /** Source ranges a footprint is built from: itself, its table header, its template, its ancestors. */
  function depRanges(decl, file, seen) {
    const out = [{ s: decl.s, e: decl.e }];
    const chain = seen || new Set();
    const key = decl.computedName || decl.name;
    if (chain.has(key)) return out;
    chain.add(key);
    if (decl.table) out.push({ s: decl.table.s, e: decl.table.headerE });
    if (decl.mode === 'from') {
      const t = file.templates.get(decl.template.name);
      if (t) out.push({ s: t.s, e: t.e });
    } else if (decl.mode === 'extends') {
      const p = decl.parentName != null ? file.footprints.get(decl.parentName) : null;
      if (p) out.push(...depRanges(p, file, chain));
    }
    return out;
  }

  function buildFile(ast, diags) {
    const lets = new Scope(null);
    const templates = new Map();
    const footprints = new Map();
    for (const it of ast.items) {
      if (it.type === 'Let') {
        if (lets.defs.has(it.name)) {
          diags.push({ severity: 'error', message: `\`let ${it.name}\` is already defined — let names are single-assignment`, s: it.nameS, e: it.nameE });
        } else lets.defs.set(it.name, { x: it.x, unit: it.unit, scope: lets });
      } else if (it.type === 'Template') {
        if (templates.has(it.name)) diags.push({ severity: 'error', message: `template \`${it.name}\` is defined twice`, s: it.nameS, e: it.nameE });
        else templates.set(it.name, it);
      }
    }
    // footprints are registered by compile() once their (possibly computed) names are known
    return { lets, templates, footprints };
  }

  function finishDiags(diags, source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const pos = (off) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return { line: lo + 1, col: off - starts[lo] + 1 };
    };
    const seen = new Set();
    const out = [];
    for (const d of diags) {
      const s = Math.max(0, Math.min(d.s == null ? 0 : d.s, source.length));
      let e = Math.max(s, Math.min(d.e == null ? s : d.e, source.length));
      const key = `${d.severity}|${s}|${e}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = pos(s), q = pos(e);
      out.push(Object.assign({}, d, {
        s, e, line: p.line, col: p.col, endLine: q.line, endCol: q.col,
        related: (d.related || []).map((r) => Object.assign({}, r, pos(r.s))),
      }));
    }
    out.sort((a, b) => a.s - b.s || (a.severity === 'error' ? -1 : 1));
    return out;
  }

  // ===================================================================== footprint

  class FootprintBuilder {
    constructor(decl, file, diags, source) {
      this.decl = decl;
      this.file = file;
      this.diags = diags;
      this.src = source;
      this.name = typeof decl.name === 'string' ? decl.name : null;   // computed names arrive from compile()
      this.scope = new Scope(file.lets);
    }

    // ---------------------------------------------------------- reporting
    report(sev, msg, node, related) {
      const n = node || this.decl;
      if (sev === 'error') this.errorCount = (this.errorCount || 0) + 1;
      const d = {
        severity: sev, message: msg, s: n.s, e: n.e, footprint: this.name,
        related: (related || []).filter((r) => r && r.node).map((r) => ({ message: r.message, s: r.node.s, e: r.node.e })),
      };
      // inside the template body of a `from` call: remember the call (see rehome())
      const t = this.tmpl;
      if (t && n.s != null && n.s >= t.s && n.e <= t.e) {
        const c = this.decl.callS != null ? [this.decl.callS, this.decl.callE] : [this.decl.nameS, this.decl.nameE];
        d.inst = { s: c[0], e: c[1], tmpl: t.name };
      }
      this.diags.push(d);
    }
    err(msg, node, related) { this.report('error', msg, node, related); }
    warn(msg, node, related) { this.report('warning', msg, node, related); }
    stmtText(node) {
      if (!node || node.s == null) return 'another statement';
      const t = this.src.slice(node.s, node.e).replace(/\s+/g, ' ').trim();
      return t.length > 48 ? t.slice(0, 45) + '…' : t;
    }
    lineAt(off) {
      let n = 1;
      for (let i = 0; i < off && i < this.src.length; i++) if (this.src.charCodeAt(i) === 10) n++;
      return n;
    }
    guard(node, fn) {
      try { return fn(); } catch (e) {
        if (e instanceof StompError) { if (!e.silent) this.err(e.message, e.node || node, e.related); return undefined; }
        throw e;
      }
    }

    // ---------------------------------------------------------- values
    env(stmt) { return { scope: this.scope, scale: UNIT_MM[(stmt && stmt.unit) || 'mm'] }; }
    val(x, stmt) { return evalExpr(x, this.env(stmt)); }
    len(x, stmt) {
      const v = this.val(x, stmt);
      if (v.k === 'len') return v.v;
      if (v.k === 'num') return v.v * UNIT_MM[(stmt && stmt.unit) || 'mm'];
      if (v.k === 'str') throw new StompError(`this is text ("${v.v}"), but a length is needed here`, x);
      throw new StompError('a ratio (length ÷ length) can\'t be used as a length', x);
    }
    plen(x, stmt, what) {
      const v = this.len(x, stmt);
      if (v < 0) throw new StompError(`${what || 'this size'} must not be negative (got ${fmtMM(v)})`, x);
      if (v === 0) this.warn(`${what || 'this size'} is zero`, x);
      return v;
    }
    countOf(c, stmt) {
      if (c.v != null) return c.v;
      const v = this.val({ type: 'id', name: c.id, s: c.s, e: c.e }, stmt);
      if (v.k === 'len') throw new StompError(`\`${c.id}\` is a length, but a count is needed here`, c);
      if (v.k === 'str') throw new StompError(`\`${c.id}\` is text ("${v.v}"), but a count is needed here`, c);
      if (!Number.isInteger(Math.round(v.v * 1e9) / 1e9) || v.v < 0) throw new StompError(`a count must be a whole number (\`${c.id}\` = ${v.v})`, c);
      return Math.round(v.v);
    }

    // ================================================================ build
    /** Flatten templates/parents, bind parameters, define lets, resolve interpolated strings. */
    prepare() {
      if (this.prepared) return;
      this.prepared = true;
      const flat = this.flatten(this.decl, []);
      this.ownLevel = flat.max;
      this.bindParams(flat.params);
      this.items = flat.items;
      this.defineLets();
      this.items = this.items.map((it) => ({ s: this.resolveStmt(it.s), level: it.level }));
    }

    /** The footprint's name: its header, else the template's `name` statement [§14]. */
    computeName() {
      const d = this.decl;
      if (d.name != null) return this.nameOf({ name: d.name, s: d.nameS, e: d.nameE }, d.unit);
      if (d.mode !== 'from') return null;
      let best = null;
      for (const it of this.items || []) if (it.s.type === 'Name' && (!best || it.level >= best.level)) best = it;
      if (!best) {
        const t = d.template.name;
        this.err(d.table
          ? `template \`${t}\` doesn't name its footprints, so these rows have no names — add \`name "…"\` to the template, e.g. \`name "${t.toUpperCase()}-{…}"\``
          : `this footprint has no name — add one (\`footprint "NAME" from ${t}(…)\`) or give template \`${t}\` a \`name "…"\` statement`,
        d.table ? { s: d.table.callS, e: d.table.callE } : { s: d.callS, e: d.callE });
        return null;
      }
      return typeof best.s.value === 'string' ? best.s.value : null;
    }

    /** A name node (plain or interpolated) as text, evaluated in this footprint's scope. */
    nameOf(n, unit) {
      if (!n) return null;
      if (typeof n.name === 'string') return n.name;
      return interpolate(n.name, { scope: this.scope, scale: UNIT_MM[unit || this.decl.unit || 'mm'] });
    }

    /** Copy-on-write: replace every interpolated string in a statement with its text. */
    resolveStmt(stmt) {
      const env = this.env(stmt);
      const EXPR = new Set(['num', 'id', 'str', 'neg', 'paren', 'bin']);
      const walk = (n) => {
        if (n === null || typeof n !== 'object') return n;
        if (Array.isArray(n.interp)) {
          try { return interpolate(n, env); } catch (e) {
            if (!(e instanceof StompError)) throw e;
            this.err(e.message, e.node || n);
            return '?';
          }
        }
        if (Array.isArray(n)) {
          let out = null;
          n.forEach((x, i) => { const y = walk(x); if (y !== x) { out = out || n.slice(); out[i] = y; } });
          return out || n;
        }
        if (EXPR.has(n.type)) return n;     // expressions evaluate their strings lazily
        let out = null;
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (v === null || typeof v !== 'object') continue;
          const w = walk(v);
          if (w !== v) { out = out || Object.assign({}, n); out[k] = w; }
        }
        return out || n;
      };
      return walk(stmt);
    }

    build() {
      this.prepare();
      this.gather();
      this.generate();
      this.makeObjects();
      this.resolveGeometry();
      this.solve();
      this.layers();
      this.checks();
      return this.output();
    }

    // ---------------------------------------------------------- flatten [§14]
    flatten(decl, chain) {
      const key = decl.computedName || (typeof decl.name === 'string' ? decl.name : `@${decl.s}`);
      if (chain.includes(key)) {
        this.err(`inheritance cycle: ${chain.concat(key).map((n) => `"${n}"`).join(' → ')}`, { s: decl.nameS, e: decl.nameE });
        return { items: [], params: [], max: 0 };
      }
      const next = chain.concat(key);
      const body = (decl.body || []);
      if (decl.mode === 'from') {
        const t = this.file.templates.get(decl.template.name);
        if (!t) {
          const hint = Parser.suggest(decl.template.name, [...this.file.templates.keys()]);
          this.err(`unknown template \`${decl.template.name}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`, decl.template);
          return { items: body.map((s) => ({ s, level: 1 })), params: [], max: 1 };
        }
        if (!this.tmpl) this.tmpl = { s: t.s, e: t.e, name: t.name };
        return {
          items: t.body.map((s) => ({ s, level: 0 })).concat(body.map((s) => ({ s, level: 1 }))),
          params: [{ template: t, decl }],
          max: 1,
        };
      }
      if (decl.mode === 'extends') {
        const pname = decl.parentName != null ? decl.parentName : this.nameOf(decl.parent);
        const p = pname != null ? this.file.footprints.get(pname) : null;
        if (!p) {
          const hint = Parser.suggest(String(pname), [...this.file.footprints.keys()]);
          this.err(`unknown parent footprint "${pname}"${hint ? ` — did you mean "${hint}"?` : ''}`, decl.parent);
          return { items: body.map((s) => ({ s, level: 0 })), params: [], max: 0 };
        }
        const base = this.flatten(p, next);
        const L = base.max + 1;
        return { items: base.items.concat(body.map((s) => ({ s, level: L }))), params: base.params, max: L };
      }
      return { items: body.map((s) => ({ s, level: 0 })), params: [], max: 0 };
    }

    bindParams(list) {
      for (const { template: t, decl } of list) {
        const given = new Map();
        const pos = decl.args.filter((a) => !a.key);
        if (pos.length > t.params.length) this.err(`template \`${t.name}\` takes ${t.params.length} parameter(s), got ${pos.length}`, pos[t.params.length]);
        pos.forEach((a, i) => { if (i < t.params.length) given.set(t.params[i].name, a); });
        for (const a of decl.args.filter((x) => x.key)) {
          if (!t.params.some((p) => p.name === a.key)) {
            const hint = Parser.suggest(a.key, t.params.map((p) => p.name));
            this.err(`template \`${t.name}\` has no parameter \`${a.key}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`, a.hdr || a);
          } else if (given.has(a.key)) this.err(`parameter \`${a.key}\` is given twice${a.hdr ? ' — in the call and as a column' : ''}`, a.hdr || a);
          else given.set(a.key, a);
        }
        for (const p of t.params) {
          const a = given.get(p.name);
          if (a) this.scope.defs.set(p.name, { x: a.x, unit: decl.unit, scope: this.file.lets, level: 0 });
          else if (p.def) this.scope.defs.set(p.name, { x: p.def, unit: t.unit, scope: this.scope, level: 0 });
          else {
            this.err(decl.table
              ? `template parameter \`${p.name}\` has no value — add a \`${p.name}\` column, or give it in the call: \`footprints from ${t.name}(${p.name} = …)\``
              : `missing argument for template parameter \`${p.name}\``, decl.missingAt || { s: decl.template.s, e: decl.e });
          }
        }
      }
    }

    /** Footprint-scoped lets (lazy, any order); later inheritance levels replace earlier ones. */
    defineLets() {
      for (const it of this.items) {
        const s = it.s;
        if (s.type !== 'Let') continue;
        const prev = this.scope.defs.get(s.name);
        if (prev && prev.level === it.level && prev.node) {
          this.err(`\`let ${s.name}\` is already defined in this footprint — let names are single-assignment`, { s: s.nameS, e: s.nameE });
          continue;
        }
        if (!prev || prev.level <= it.level) this.scope.defs.set(s.name, { x: s.x, unit: s.unit, scope: this.scope, level: it.level, node: s });
      }
    }

    // ---------------------------------------------------------- gather
    gather() {
      this.broken = new Set();
      const st = this.st = {
        meta: {}, body: null, gen: null, lead: null, density: null, pin1: null, polarized: null,
        defaultPad: null, origin: null, bareSpan: null, barePitch: null, model: null,
        omits: [], onlys: [], padStmts: [], padsStmts: [], holes: [], deletes: [], rows: [], groups: [],
        places: [], thermals: [], texts: [], silk: [], assembly: [], courtyard: [],
      };
      const singles = {};
      const single = (key, it, label) => {
        const prev = singles[key];
        if (prev && prev.level === it.level) {
          this.err(`\`${label}\` is given twice in this footprint (first on line ${this.lineAt(prev.s.s)})`, it.s, [{ message: 'first given here', node: prev.s }]);
          return;
        }
        if (!prev || prev.level < it.level) { singles[key] = it; st[key] = it; }
      };
      for (const it of this.items) {
        const s = it.s;
        switch (s.type) {
          case 'Let': break;
          case 'Broken':
            if (s.target && s.target.name != null) this.broken.add(String(s.target.name));
            if (s.target && s.target.kind === 'body') this.broken.add('#body');
            break;
          case 'Meta': st.meta[s.key] = { value: s.value, node: s }; break;
          case 'Name':
            if (this.decl.mode !== 'from' && it.level === this.ownLevel) {
              this.err('`name` belongs in a template (or a `from` call\'s block) — this footprint is already named in its header', s);
            }
            break;
          case 'Body': single('body', it, 'body'); break;
          case 'Pins': case 'Balls': single('gen', it, s.type === 'Balls' ? 'balls' : 'pins'); break;
          case 'Lead': single('lead', it, 'lead'); break;
          case 'Density': single('density', it, 'density'); break;
          case 'Pin1': single('pin1', it, 'pin1'); break;
          case 'Polarized': st.polarized = it; break;
          case 'DefaultPad': single('defaultPad', it, 'default pad'); break;
          case 'Origin': single('origin', it, 'origin'); break;
          case 'MeasureBare':
            if (s.word === 'pitch') single('barePitch', it, 'pitch');
            else single('bareSpan', it, 'span/gap');
            break;
          case 'Model': single('model', it, 'model'); break;
          case 'Omit': st.omits.push(it); break;
          case 'Only': st.onlys.push(it); break;
          case 'Pad': st.padStmts.push(it); break;
          case 'Pads': st.padsStmts.push(it); break;
          case 'Hole': st.holes.push(it); break;
          case 'Delete': st.deletes.push(it); break;
          case 'Row': st.rows.push(it); break;
          case 'Group': st.groups.push(it); break;
          case 'Thermal': st.thermals.push(it); break;
          case 'Text': st.texts.push(it); break;
          case 'Layer': st[s.layer].push(it); break;
          case 'At': case 'Is': case 'Centered': case 'Mirrors': case 'Align': case 'MeasurePair':
            st.places.push(it); break;
          default: break;
        }
      }
      this.density = st.density ? st.density.s.level : 'nominal';
      this.lv = LEVEL[this.density];
      // body
      this.body = null;
      if (st.body) {
        const b = st.body.s;
        this.bodyFailed = true;
        this.guard(b, () => {
          this.body = b.cyl
            ? { kind: 'cyl', w: this.plen(b.d, b, 'body diameter'), l: 0, h: this.plen(b.h, b, 'body height'), node: b }
            : { kind: 'box', w: this.plen(b.w, b, 'body width'), l: this.plen(b.l, b, 'body length'), h: b.h ? this.plen(b.h, b, 'body height') : null, node: b };
          if (this.body.kind === 'cyl') this.body.l = this.body.w;
          this.bodyFailed = false;
        });
      }
      // lead
      this.lead = null;
      if (st.lead) {
        const n = st.lead.s;
        this.guard(n, () => {
          const L = { form: n.form, node: n };
          if (n.dims) {
            if (n.dims.d) L.d = this.plen(n.dims.d, n, 'lead diameter');
            else if (n.dims.w) { L.w = this.plen(n.dims.w, n, 'lead width'); L.l = this.plen(n.dims.l, n, 'lead length'); }
            else L.v = this.plen(n.dims.v, n, 'lead size');
          }
          if (n.span) L.span = { v: this.plen(n.span.x, n, 'span'), qual: n.span.qual || 'outer', node: n.span };
          this.lead = L;
          if (n.form === 'castellated') this.warn('castellated leads are provisional (SPEC §17.7): the demo draws a plain edge land', n);
        });
      }
      // default pad
      this.defaultSpec = null;
      if (st.defaultPad) this.defaultSpec = this.guard(st.defaultPad.s, () => this.specFromGeom(st.defaultPad.s.geom, st.defaultPad.s));
      if (st.polarized) this.polarized = true;
    }

    // ---------------------------------------------------------- pad specs [§10]
    shapeFrom(sh, stmt) {
      const L = (x, what) => this.plen(x, stmt, what);
      switch (sh.kind) {
        case 'rect': case 'oval':
          return { kind: sh.kind, w: L(sh.size.w, 'pad width'), l: L(sh.size.l, 'pad length') };
        case 'roundrect': {
          const w = L(sh.size.w, 'pad width'), l = L(sh.size.l, 'pad length');
          if (sh.r.pct != null) return { kind: 'roundrect', w, l, rPct: sh.r.pct, r: (sh.r.pct / 100) * Math.min(w, l) };
          return { kind: 'roundrect', w, l, r: L(sh.r.x, 'corner radius') };
        }
        case 'dshape':
          return { kind: 'dshape', w: L(sh.size.w, 'pad width'), l: L(sh.size.l, 'pad length'), flat: sh.flat || 'left' };
        case 'circle':
          return { kind: 'circle', d: L(sh.d, 'pad diameter') };
        case 'polygon': {
          const pts = sh.pts.map((p) => [this.len(p.x, stmt), this.len(p.y, stmt)]);
          if (Math.abs(G.polyArea(pts)) < 1e-12) throw new StompError('polygon pad has no area', sh);
          const c = G.polyCentroid(pts);
          const rel = G.ensureCCW(pts.map((p) => [p[0] - c[0], p[1] - c[1]]));
          return { kind: 'polygon', pts: rel };
        }
        default: throw new StompError('unknown shape', sh);
      }
    }

    drillFrom(d, stmt) {
      if (d.slot) return { slot: { w: this.plen(d.slot.w, stmt, 'slot width'), l: this.plen(d.slot.l, stmt, 'slot length') } };
      return { d: this.plen(d.d, stmt, 'drill diameter') };
    }

    applyProp(spec, p, stmt) {
      switch (p.prop) {
        case 'rotate': spec.rot = p.angle.deg; break;
        case 'mask':
          spec.mask = p.mode === 'expand' ? { mode: 'expand', v: p.value.sign * this.len(p.value.x, stmt) } : { mode: p.mode };
          break;
        case 'paste':
          if (p.mode === 'expand') spec.paste = { mode: 'expand', v: p.value.sign * this.len(p.value.x, stmt) };
          else if (p.mode === 'divide') {
            const nx = this.countOf(p.nx, stmt), ny = this.countOf(p.ny, stmt);
            if (nx < 1 || ny < 1) throw new StompError('paste divide needs at least 1 x 1 windows', p);
            spec.paste = {
              mode: 'divide', nx, ny,
              coverage: p.coverage ? p.coverage.pct / 100 : null,
              gutter: p.gutter ? this.plen(p.gutter, stmt, 'gutter') : null,
            };
            if (spec.paste.coverage != null && !(spec.paste.coverage > 0 && spec.paste.coverage <= 1)) {
              throw new StompError('paste coverage must be between 0% and 100%', p.coverage);
            }
          } else spec.paste = { mode: p.mode };
          break;
        case 'vias':
          spec.vias = { nx: this.countOf(p.nx, stmt), ny: this.countOf(p.ny, stmt), drill: this.plen(p.drill, stmt, 'via drill'), pitch: this.plen(p.pitch, stmt, 'via pitch') };
          break;
        default: break;
      }
      (spec.src = spec.src || []).push(p);
    }

    specFromGeom(g, stmt) {
      const spec = { shape: this.shapeFrom(g.shape, stmt), tht: !!g.tht, drill: g.drill ? this.drillFrom(g.drill, stmt) : null, rot: 0, mask: null, paste: null, vias: null };
      for (const p of g.props) this.applyProp(spec, p, stmt);
      if (spec.tht && !spec.drill) throw new StompError('a `tht` pad needs a drill: add `drill D` or `drill slot W x L`', g);
      if (!spec.tht && spec.drill) {
        this.warn('this pad has a drill but isn\'t marked `tht`; treating it as through-hole', g);
        spec.tht = true;
      }
      return spec;
    }

    applyBlock(spec, stmts, stmt) {
      for (const b of stmts) {
        this.guard(b, () => {
          switch (b.op) {
            case 'shape': spec.shape = this.shapeFrom(b.shape, stmt); break;
            case 'size': this.resize(spec, this.plen(b.size.w, stmt, 'pad width'), this.plen(b.size.l, stmt, 'pad length'), b); break;
            case 'width': this.resize(spec, this.plen(b.x, stmt, 'pad width'), null, b); break;
            case 'length': this.resize(spec, null, this.plen(b.x, stmt, 'pad length'), b); break;
            case 'drill':
              spec.drill = this.drillFrom(b.drill, stmt);
              if (!spec.tht) { this.warn('adding a drill makes this an SMD pad through-hole', b); spec.tht = true; }
              break;
            case 'prop': this.applyProp(spec, b.prop, stmt); break;
            default: break;
          }
        });
      }
    }

    resize(spec, w, l, node) {
      const sh = spec.shape;
      if (sh.kind === 'polygon') throw new StompError('`width`/`length`/`size` can\'t resize a polygon pad — give it a new `shape`', node);
      if (sh.kind === 'circle') {
        const W = w == null ? sh.d : w, Lg = l == null ? sh.d : l;
        spec.shape = Math.abs(W - Lg) < 1e-12 ? { kind: 'circle', d: W } : { kind: 'oval', w: W, l: Lg };
        return;
      }
      if (w != null) sh.w = w;
      if (l != null) sh.l = l;
      if (sh.kind === 'roundrect' && sh.rPct != null) sh.r = (sh.rPct / 100) * Math.min(sh.w, sh.l);
    }

    // ---------------------------------------------------------- generator [§11]
    generate() {
      this.gen = null;
      const it = this.st.gen;
      if (!it) {
        if (this.lead && !this.st.thermals.length) {
          this.warn('`lead` describes leads, but there is no `pins`/`balls` statement to place them', this.lead.node);
        }
        return;
      }
      const node = it.s;
      this.guard(node, () => this.runGenerator(node));
    }

    runGenerator(node) {
      const C = node.clauses || {};
      const lead = this.lead;
      const pitchFrom = () => {
        if (C.pitch) return { x: this.plen(C.pitch.x, node, 'pitch'), y: C.pitch.y ? this.plen(C.pitch.y, node, 'pitch') : null };
        if (this.st.barePitch) { const b = this.st.barePitch.s; return { x: this.plen(b.x, b, 'pitch'), y: null }; }
        return null;
      };
      const pitch = pitchFrom();
      const clauseSpec = C.pad ? this.specFromGeom(C.pad, node) : null;
      const proto = clauseSpec || this.defaultSpec;
      const scheme = C.numbering ? C.numbering.v : null;
      const start = C.start ? C.start.v : 'top-left';
      const gen = this.gen = { node, kind: null, positions: [], sides: {}, pin1: null, proto, protoSrc: clauseSpec ? C.pad : (this.defaultSpec ? this.st.defaultPad.s : null) };

      if (node.type === 'Balls' || node.form === 'grid') {
        const nx = this.countOf(node.nx, node), ny = this.countOf(node.ny, node);
        if (nx < 1 || ny < 1) throw new StompError('a grid needs at least one row and one column', node);
        const px = pitch ? pitch.x : null, py = pitch ? (pitch.y != null ? pitch.y : pitch.x) : null;
        if ((nx > 1 || ny > 1) && px == null) throw new StompError('the grid needs a `pitch`', node);
        const isBalls = node.type === 'Balls';
        gen.kind = isBalls ? 'balls' : 'grid';
        if (isBalls && lead && lead.form !== 'ball') this.warn('`balls` implies `lead ball`, but the lead form here is `' + lead.form + '`', lead.node);
        let gridProto = proto;
        if (!gridProto) gridProto = this.ipcGridSpec(isBalls, node);
        const sch = scheme || (isBalls ? 'bga' : 'zigzag');
        if (sch === 'ccw' || sch === 'cw') throw new StompError(`\`numbering ${sch}\` walks the package perimeter; grids use zigzag, row-major, col-major or bga`, C.numbering);
        const names = numberGrid(nx, ny, sch, start, px, py);
        for (let r = 0; r < ny; r++) {
          for (let c = 0; c < nx; c++) {
            gen.positions.push({
              name: names.name(c, r), x: (c - (nx - 1) / 2) * (px || 0), y: ((ny - 1) / 2 - r) * (py || 0),
              side: null, rot: 0, col: c, row: r, rowKey: names.rowKey(r), colKey: names.colKey(c), order: names.order(c, r), proto: gridProto,
            });
          }
        }
        gen.grid = { nx, ny, scheme: sch, start, names };
      } else if (node.form === 'sides') {
        gen.kind = 'sides';
        this.sidesLayout(node, pitch, proto);
      } else {
        this.countLayout(node, pitch, proto, scheme, start);
      }
      // pin 1 = first in numbering order (kept even if later omitted, for markers)
      const sorted = gen.positions.slice().sort((a, b) => a.order - b.order);
      gen.pin1 = sorted.length ? sorted[0] : null;
      // duplicate names
      const seen = new Map();
      for (const p of gen.positions) {
        if (seen.has(p.name)) throw new StompError(`pin name ${p.name} is used twice by this generator`, node);
        seen.set(p.name, p);
      }
      this.depopulate();
    }

    ipcGridSpec(isBalls, node) {
      const lead = this.lead;
      if (!lead) throw new StompError('no pad geometry for the grid: add `default pad …`, a `pad …` clause, or a `lead`', node);
      if (lead.form === 'ball') {
        const d = lead.v != null ? lead.v : lead.d;
        if (d == null) throw new StompError('`lead ball` needs the ball diameter', lead.node);
        this.ipcNote = `ball lands: ${Math.round(BALL_LAND * 100)}% of the ${fmtMM(d)} ball (NSMD)`;
        return { shape: { kind: 'circle', d: ceilTo(d * BALL_LAND, 0.01) }, tht: false, drill: null, rot: 0, mask: null, paste: null, vias: null, ipc: true };
      }
      if (lead.form === 'pin' || lead.form === 'wire') return this.thtSpec(lead);
      throw new StompError(`can't derive grid pads from a \`${lead.form}\` lead — give \`default pad …\``, lead.node);
    }

    thtSpec(lead) {
      const lv = this.lv;
      const dim = lead.d != null ? lead.d : lead.w != null ? Math.hypot(lead.w, lead.l) : lead.v;
      if (dim == null) throw new StompError(`\`lead ${lead.form}\` needs its size (\`d 0.6\` or \`W x L\`)`, lead.node);
      const drill = ceilTo(dim + THT.allowance[lv], 0.05);
      const pad = ceilTo(drill + 2 * THT.ring[lv], 0.05);
      this.ipcNote = `through-hole: drill = lead ${fmtMM(dim)} + ${fmtMM(THT.allowance[lv])}, pad = drill + 2 × ${fmtMM(THT.ring[lv])} ring`;
      return { shape: { kind: 'circle', d: pad }, tht: true, drill: { d: drill }, rot: 0, mask: null, paste: null, vias: null, ipc: true };
    }

    /** Centre-to-centre row spacing along `axis` (x: left/right rows, y: top/bottom). */
    rowSpacing(axis, proto, ctx) {
      const st = this.st;
      const body = this.body;
      const bodyAlong = body ? (axis === 'x' ? body.w : body.l) : null;
      const bodyAcross = body ? (axis === 'x' ? body.l : body.w) : null;
      const node = ctx.node;
      const C = node.clauses || {};
      const padLen = () => {
        if (!proto) throw new StompError('a pad-measured span needs pad geometry — add `default pad …`', node);
        const bb = G.contourBBox(G.transformContour(G.shapeContour(proto.shape, 0), rad(proto.rot || 0), 0, 0));
        if (!G.boxValid(bb)) throw new StompError('the default pad has zero size, so a pad-measured span can\'t place it', node);
        return bb.y1 - bb.y0;   // canonical: the lead runs along y
      };
      const padMeasured = (v, qual) => {
        const q = qual || 'outer';
        return q === 'centers' ? v : q === 'inner' ? v + padLen() : v - padLen();
      };
      // 1. bare `span` / `gap` measures pads and overrides everything
      if (st.bareSpan) {
        const b = st.bareSpan.s;
        const v = this.plen(b.x, b, b.word);
        const qual = b.word === 'gap' ? 'inner' : (b.qual || 'outer');
        if (b.word === 'gap' && b.qual && b.qual !== 'inner') this.warn('`gap` is always inner-to-inner; the qualifier is ignored', b);
        ctx.src.push(b);
        return { C: padMeasured(v, qual), how: `${b.word} ${fmtMM(v)} (pads, ${qual})` };
      }
      const pspan = C.span ? { v: this.plen(C.span.x, node, 'span'), qual: C.span.qual || 'outer' } : null;
      const lead = this.lead;
      if (!lead) {
        if (pspan) return { C: padMeasured(pspan.v, pspan.qual), how: `span ${fmtMM(pspan.v)} (pads, ${pspan.qual})` };
        if (ctx.twoPin && ctx.pitch != null) return { C: ctx.pitch, how: `pitch ${fmtMM(ctx.pitch)} (centres)` };
        throw new StompError('the pad rows need a spacing: add `span …` / `gap …` (measured on the pads), or describe the leads with `lead … span …`', node);
      }
      ctx.src.push(lead.node);
      const span = pspan || lead.span;
      const f = lead.form;
      if (f === 'pin' || f === 'wire') {
        const t = lead.d != null ? lead.d : lead.l != null ? lead.l : lead.v;
        if (!span) {
          if (ctx.twoPin && ctx.pitch != null) return { C: ctx.pitch, how: `pitch ${fmtMM(ctx.pitch)} (lead centres)` };
          throw new StompError(`through-hole rows need the lead spacing: add \`span … centers\` to \`pins\` or \`lead\``, node);
        }
        const v = span.qual === 'centers' ? span.v : span.qual === 'inner' ? span.v + (t || 0) : span.v - (t || 0);
        return { C: v, how: `lead span ${fmtMM(span.v)} ${span.qual}` };
      }
      if (f === 'ball') throw new StompError('`lead ball` belongs with `balls` or `pins grid`', lead.node);
      // SMD lead forms: IPC land from the lead span
      let T, W;
      if (f === 'castellated') {
        const d = lead.d != null ? lead.d : lead.v;
        if (d == null) throw new StompError('`lead castellated` needs the hole size: `lead castellated d 0.6`', lead.node);
        const Lc = span ? toOuter(span, 0) : bodyAlong;
        if (Lc == null) throw new StompError('castellations need a `body` (they sit on its edges) or a span', node);
        return { C: Lc, how: 'castellations on the body edge', castellated: d };
      }
      if (f === 'endcap') {
        if (lead.w != null) { W = lead.w; T = lead.l; } else { T = lead.v != null ? lead.v : lead.d; W = bodyAcross; }
        if (T == null) throw new StompError('`lead endcap` needs the termination length: `lead endcap 0.3`', lead.node);
        if (W == null) throw new StompError('endcap width defaults to the body width — add a `body`', lead.node);
      } else {
        if (lead.w == null) throw new StompError(`\`lead ${f}\` needs \`W x L\` (lead width x foot length)`, lead.node);
        W = lead.w; T = lead.l;
      }
      let L;
      if (span) L = toOuter(span, T);
      else if ((f === 'flat' || f === 'endcap' || f === 'tab') && bodyAlong != null) L = bodyAlong;
      else if (ctx.twoPin && ctx.pitch != null) return { C: ctx.pitch, how: `pitch ${fmtMM(ctx.pitch)} (centres)` };
      else if (this.bodyFailed && (f === 'flat' || f === 'endcap' || f === 'tab')) throw SILENT(lead.node);   // follows from the body error
      else throw new StompError(`\`lead ${f}\` needs a span: \`lead ${f} … span S\` (outer edge to outer edge)`, lead.node);
      let table;
      if (f === 'gullwing') table = ctx.pitch != null && ctx.pitch <= 0.625 + 1e-9 ? IPC.gullwingFine : IPC.gullwing;
      else if (f === 'jlead') table = IPC.jlead;
      else if (f === 'endcap') table = (bodyAlong != null && bodyAlong < 1.6 - 1e-9) ? IPC.chipSmall : IPC.chip;
      else table = IPC.flat;
      const lv = this.lv;
      const Z = ceilTo(L + 2 * table.toe[lv] + D.tol, 0.01);
      let Gm = floorTo(L - 2 * T - 2 * table.heel[lv] - D.tol, 0.01);
      if (Gm < 0) Gm = 0;
      const X = ceilTo(W + 2 * table.side[lv] + D.tol, 0.01);
      const ipc = { Z, G: Gm, X, len: (Z - Gm) / 2, table, L, T, W };
      this.courtyardExcess = table.cy[lv];
      this.ipcNote = `${table.name}, density ${this.density}: Z = ${fmtMM(Z)}, G = ${fmtMM(Gm)}, X = ${fmtMM(X)} (toe ${fmtMM(table.toe[lv])}, heel ${fmtMM(table.heel[lv])}, side ${fmtMM(table.side[lv])})`;
      return { C: (Z + Gm) / 2, ipc, how: `IPC land from lead span ${fmtMM(L)}` };
    }

    ipcSpec(ipc) {
      const r = Math.min(0.25 * Math.min(ipc.X, ipc.len), 0.25);
      return { shape: { kind: 'roundrect', w: ipc.X, l: ipc.len, r }, tht: false, drill: null, rot: 0, mask: null, paste: null, vias: null, ipc: true };
    }

    countLayout(node, pitch, proto, scheme, start) {
      const gen = this.gen;
      const N = this.countOf(node.count, node);
      let arr = node.arrangement;
      if (!arr) arr = N === 2 ? 'horizontal' : 'dual';
      let sides;
      switch (arr) {
        case 'dual':
          if (N < 2 || N % 2) throw new StompError(`\`pins ${N} dual\` needs an even count`, node.count);
          sides = [['left', N / 2], ['right', N / 2]]; break;
        case 'quad':
          if (N < 4 || N % 4) throw new StompError(`\`pins ${N} quad\` needs a multiple of 4 (use a \`pins { … }\` side block for uneven sides)`, node.count);
          sides = [['left', N / 4], ['bottom', N / 4], ['right', N / 4], ['top', N / 4]]; break;
        case 'horizontal':
          if (N !== 2) throw new StompError('`horizontal` is for two-terminal parts: `pins 2 horizontal`', node.count);
          sides = [['left', 1], ['right', 1]]; break;
        case 'vertical':
          if (N !== 2) throw new StompError('`vertical` is for two-terminal parts: `pins 2 vertical`', node.count);
          sides = [['top', 1], ['bottom', 1]]; break;
        default:
          if (N < 1) throw new StompError('a single row needs at least one pin', node.count);
          sides = [[node.side, N]];
      }
      gen.kind = arr === 'horizontal' || arr === 'vertical' ? 'two' : arr;
      const twoPin = gen.kind === 'two';
      const P = pitch ? pitch.x : null;
      if (!twoPin && sides.some(([, k]) => k > 1) && P == null) throw new StompError('this package needs a `pitch`', node);
      this.layoutSides(node, sides.map(([side, k]) => ({ side, slots: Array.from({ length: k }, () => ({})), pitch: P })), proto, { twoPin, pitch: P });
      // numbering
      const sch = scheme || 'ccw';
      const pos = gen.positions;
      if (sch === 'bga') throw new StompError('`numbering bga` needs a grid (`balls` or `pins grid`)', node.clauses.numbering);
      if (sch === 'ccw' || sch === 'cw') {
        const order = walkOrder(pos, sch, start, arr === 'single');
        order.forEach((idx, k) => { pos[idx].name = String(k + 1); pos[idx].order = k; });
      } else {
        if (arr === 'quad') throw new StompError(`\`numbering ${sch}\` needs rows and columns; quad packages use ccw or cw`, node.clauses.numbering);
        // treat the arrangement as a small grid
        let cols = 1, rows = 1;
        for (const p of pos) {
          if (arr === 'dual' || arr === 'horizontal') { p.col = p.side === 'left' ? 0 : 1; }
          if (arr === 'vertical') { p.row = p.side === 'top' ? 0 : 1; }
        }
        if (arr === 'dual') {
          const k = N / 2; cols = 2; rows = k;
          for (const p of pos) p.row = p.side === 'left' ? p.walk : k - 1 - p.walk;
        } else if (arr === 'horizontal') { cols = 2; rows = 1; for (const p of pos) p.row = 0; }
        else if (arr === 'vertical') { cols = 1; rows = 2; for (const p of pos) p.col = 0; }
        else {
          const s = node.side;
          for (const p of pos) {
            if (s === 'bottom') { p.col = p.walk; p.row = 0; cols = N; }
            else if (s === 'top') { p.col = N - 1 - p.walk; p.row = 0; cols = N; }
            else if (s === 'left') { p.row = p.walk; p.col = 0; rows = N; }
            else { p.row = N - 1 - p.walk; p.col = 0; rows = N; }
          }
        }
        const names = numberGrid(cols, rows, sch, start, P, P);
        for (const p of pos) { p.name = names.name(p.col, p.row); p.order = names.order(p.col, p.row); }
      }
    }

    sidesLayout(node, pitch, proto) {
      const seenSide = new Set();
      const entries = [];
      let lastPitch = pitch ? pitch.x : null;
      for (const ent of node.sides) {
        if (seenSide.has(ent.side)) { this.err(`side \`${ent.side}\` is listed twice`, ent); continue; }
        seenSide.add(ent.side);
        const P = ent.pitch ? this.plen(ent.pitch, node, 'pitch') : null;
        entries.push({ side: ent.side, slots: ent.positions.map((p) => (p.nc ? { nc: true } : { name: p.name, node: p })), pitchGiven: P, node: ent });
        if (P != null && lastPitch == null) lastPitch = P;
      }
      for (const e of entries) {
        e.pitch = e.pitchGiven != null ? e.pitchGiven : lastPitch;
        if (e.slots.length > 1 && e.pitch == null) throw new StompError(`side \`${e.side}\` needs a pitch`, e.node);
      }
      const order = ['left', 'bottom', 'right', 'top'];
      entries.sort((a, b) => order.indexOf(a.side) - order.indexOf(b.side));
      if (!entries.length) throw new StompError('the side block lists no pins', node);
      this.layoutSides(node, entries, proto, { twoPin: false, pitch: entries[0].pitch });
      let k = 0;
      // order = CCW walk as listed
      for (const p of this.gen.positions) { p.order = k++; }
    }

    /** Place pins on package sides (CCW walk order inside each side). */
    layoutSides(node, entries, proto, ctx) {
      const gen = this.gen;
      const has = (s) => entries.some((e) => e.side === s);
      const spacing = {};
      const src = [];
      const needX = has('left') || has('right'), needY = has('top') || has('bottom');
      const single = entries.length === 1;
      const c = { node, twoPin: ctx.twoPin, pitch: ctx.pitch, src };
      if (needX) spacing.x = this.rowSpacing('x', proto, c);
      if (needY) spacing.y = this.rowSpacing('y', proto, c);
      gen.spacing = spacing;
      gen.src = src;
      const ROT = { bottom: 0, right: 90, top: 180, left: 270 };
      for (const e of entries) {
        const axis = (e.side === 'left' || e.side === 'right') ? 'x' : 'y';
        const sp = spacing[axis];
        if (!Number.isFinite(sp.C)) throw new StompError('the pad rows\' spacing came out undefined — check the span and pad sizes', node);
        const line = (e.side === 'left' || e.side === 'bottom' ? -1 : 1) * sp.C / 2;
        let pr = proto;
        if (!pr && sp.ipc) pr = this.ipcSpec(sp.ipc);
        if (!pr && sp.castellated != null) {
          const d = sp.castellated;
          pr = { shape: { kind: 'rect', w: ceilTo(d + 0.4, 0.01), l: ceilTo(d + 0.8, 0.01) }, tht: false, drill: null, rot: 0, mask: null, paste: null, vias: null, ipc: true, castellated: d };
        }
        if (!pr && this.lead && (this.lead.form === 'pin' || this.lead.form === 'wire')) pr = this.thtSpec(this.lead);
        const k = e.slots.length;
        const P = e.pitch || 0;
        e.slots.forEach((slot, i) => {
          if (slot.nc) return;
          const o = (i - (k - 1) / 2) * P;
          let x, y;
          switch (e.side) {
            case 'left': x = line; y = -o; break;
            case 'bottom': x = o; y = line; break;
            case 'right': x = line; y = o; break;
            default: x = -o; y = line; break;
          }
          let shift = 0;
          if (sp.castellated != null) shift = 0.2;   // nudge edge lands outward
          if (e.side === 'left') x -= shift; if (e.side === 'right') x += shift;
          if (e.side === 'bottom') y -= shift; if (e.side === 'top') y += shift;
          gen.positions.push({ name: slot.name, x, y, side: e.side, rot: ROT[e.side], walk: i, proto: pr, node: slot.node });
        });
      }
      if (single && entries[0].slots.length && !gen.positions.length) throw new StompError('every position is `nc`', node);
    }

    depopulate() {
      const gen = this.gen;
      const byName = new Map(gen.positions.map((p) => [p.name, p]));
      const regionMatch = (p, it, node) => {
        if (!gen.grid) throw new StompError('`rows`/`cols` regions apply to grids (`balls` / `pins grid`)', node);
        const inRange = (key, range, isRow) => {
          const ix = (v) => {
            if (isRow && /^[A-Z]{1,2}$/.test(v)) return jedecIndex(v);
            if (/^\d+$/.test(v)) return parseInt(v, 10) - 1;
            throw new StompError(`\`${v}\` isn't a ${isRow ? 'row letter or number' : 'column number'}`, node);
          };
          const a = ix(range[0].name), b = ix(range[1].name);
          return key >= Math.min(a, b) && key <= Math.max(a, b);
        };
        const rIdx = gen.grid.names.rowIndex(p.row), cIdx = gen.grid.names.colIndex(p.col);
        if (it.rows && !inRange(rIdx, it.rows, true)) return false;
        if (it.cols && !inRange(cIdx, it.cols, false)) return false;
        return true;
      };
      const select = (it, node) => {
        if (it.rows || it.cols) return gen.positions.filter((p) => regionMatch(p, it, node));
        const names = it.range ? expandRange(it.range[0], it.range[1], node) : [it.name.name];
        const out = [];
        for (const n of names) {
          const p = byName.get(n);
          if (!p) {
            const hint = Parser.suggest(n, [...byName.keys()]);
            this.err(`there is no generated pin \`${n}\` to ${node.type === 'Omit' ? 'omit' : 'keep'}${hint ? ` — did you mean \`${hint}\`?` : ''}`, it.name || it);
          } else out.push(p);
        }
        return out;
      };
      let keep = null;
      for (const o of this.st.onlys) {
        this.guard(o.s, () => {
          keep = keep || new Set();
          for (const it of o.s.items) select(it, o.s).forEach((p) => keep.add(p));
        });
      }
      const drop = new Set();
      for (const o of this.st.omits) {
        this.guard(o.s, () => { for (const it of o.s.items) select(it, o.s).forEach((p) => drop.add(p)); });
      }
      gen.omitted = gen.positions.filter((p) => drop.has(p) || (keep && !keep.has(p)));
      gen.positions = gen.positions.filter((p) => !drop.has(p) && (!keep || keep.has(p)));
    }

    // ---------------------------------------------------------- objects [§8]
    makeObjects() {
      const st = this.st;
      this.pads = new Map();
      this.holes = new Map();
      this.rows = new Map();
      this.groups = new Map();
      this.sides = {};
      const gen = this.gen;
      const newPad = (name, extra) => {
        const p = Object.assign({ kind: 'pad', name, explicit: null, partials: [], mirror: null, src: [], gen: null }, extra);
        this.pads.set(name, p);
        return p;
      };
      if (gen) {
        for (const g of gen.positions) {
          const p = newPad(g.name, { gen: g, generated: true });
          p.src.push(gen.node);
          if (gen.protoSrc) p.src.push(gen.protoSrc);
          if (gen.src) p.src.push(...gen.src);
          if (g.side) (this.sides[g.side] = this.sides[g.side] || []).push(g.name);
        }
      }
      for (const it of st.thermals) {
        this.guard(it.s, () => {
          const s = it.s;
          const name = s.name ? s.name.name : 'EP';
          if (this.pads.has(name)) throw new StompError(`thermal pad \`${name}\` collides with an existing pad of that name — name it: \`thermal pad 33 W x L\``, s);
          const proto = { shape: { kind: 'rect', w: this.plen(s.size.w, s, 'thermal pad width'), l: this.plen(s.size.l, s, 'thermal pad length') }, tht: false, drill: null, rot: 0, mask: null, paste: null, vias: null };
          const p = newPad(name, { gen: { x: 0, y: 0, rot: 0, side: null, proto, thermal: true }, thermal: true });
          p.src.push(s);
          if (s.block) p.partials.push({ stmts: s.block, stmt: s, level: it.level });
        });
      }
      // explicit pads and pad blocks
      const explicitAt = new Map();
      for (const it of st.padStmts) {
        const s = it.s;
        const name = s.name.name;
        let p = this.pads.get(name);
        if (s.geom) {
          const spec = this.guard(s, () => this.specFromGeom(s.geom, s));
          if (!p) p = newPad(name, {});
          if (!spec) p.geomFailed = true;
          const prev = explicitAt.get(name);
          if (prev && prev.level === it.level) {
            this.err(`pad ${name} is defined twice (first on line ${this.lineAt(prev.s.s)})`, s.name, [{ message: 'first definition', node: prev.s }]);
            continue;
          }
          if (!prev || prev.level < it.level) {
            explicitAt.set(name, it);
            if (spec) p.explicit = { spec, level: it.level, node: s };
          }
          p.src.push(s);
        } else {
          if (!p) p = newPad(name, {});
          p.partials.push({ stmts: s.block, stmt: s, level: it.level });
          p.src.push(s);
        }
      }
      for (const it of st.holes) {
        const s = it.s;
        const name = s.name.name;
        if (this.holes.has(name) && this.holes.get(name).level === it.level) { this.err(`hole ${name} is defined twice`, s.name); continue; }
        if (this.pads.has(name)) { this.err(`\`${name}\` is already a pad — pads and holes share one namespace`, s.name); continue; }
        this.guard(s, () => {
          const h = s.slot
            ? { kind: 'hole', name, shape: { kind: 'oval', w: this.plen(s.slot.w, s, 'slot width'), l: this.plen(s.slot.l, s, 'slot length') }, slot: true }
            : { kind: 'hole', name, shape: { kind: 'circle', d: this.plen(s.d, s, 'hole diameter') } };
          h.src = [s]; h.level = it.level; h.mirror = null;
          this.holes.set(name, h);
        });
      }
      // rows (create missing member pads)
      for (const it of st.rows) {
        const s = it.s;
        this.guard(s, () => {
          const name = s.name.name;
          if (this.rows.has(name)) throw new StompError(`row ${name} is defined twice`, s.name);
          const members = [];
          for (const sel of s.sel) {
            const names = sel.range ? expandRange(sel.range[0], sel.range[1], sel) : [sel.name.name];
            for (const n of names) {
              if (this.holes.has(n)) throw new StompError(`rows hold pads; \`${n}\` is a hole`, sel);
              let p = this.pads.get(n);
              if (!p) p = newPad(n, {});
              p.src.push(s);
              members.push(p);
            }
          }
          this.rows.set(name, { kind: 'row', name, members, pitch: this.plen(s.pitch, s, 'row pitch'), going: s.going || 'right', node: s });
        });
      }
      // mirrors create their target if needed (kind follows the prototype)
      for (const it of st.places) {
        const s = it.s;
        if (s.type !== 'Mirrors') continue;
        const tk = s.target.kind, pk = s.proto.kind;
        const pname = s.proto.name;
        const protoIsHole = (pk === 'hole' || pk == null) && this.holes.has(pname);
        const protoIsPad = (pk === 'pad' || pk == null) && this.pads.has(pname);
        if (!protoIsHole && !protoIsPad) continue;   // reported later as unknown
        const tname = s.target.name;
        if (tk && tk !== 'pad' && tk !== 'hole') continue;
        if (protoIsHole) {
          let h = this.holes.get(tname);
          if (!h && !this.pads.has(tname)) {
            const proto = this.holes.get(pname);
            h = { kind: 'hole', name: tname, shape: Object.assign({}, proto.shape), slot: proto.slot, src: [s], level: it.level, mirror: null };
            this.holes.set(tname, h);
          }
          if (h) { h.mirror = { proto: pname, axis: s.axis, node: s }; h.src.push(s); }
        } else {
          let p = this.pads.get(tname);
          if (!p && !this.holes.has(tname)) p = newPad(tname, {});
          if (p) {
            if (p.mirror) this.err(`pad ${tname} already mirrors pad ${p.mirror.proto}`, s, [{ message: 'first mirror', node: p.mirror.node }]);
            else p.mirror = { proto: pname, axis: s.axis, node: s };
            p.src.push(s);
          }
        }
      }
      // deletes
      for (const it of st.deletes) {
        const r = it.s.ref;
        const kind = r.kind;
        if (kind === 'pad' || (kind == null && this.pads.has(r.name))) {
          if (!this.pads.delete(r.name)) this.unknown(r, it.s);
          else for (const k of Object.keys(this.sides)) this.sides[k] = this.sides[k].filter((n) => n !== r.name);
        } else if (kind === 'hole' || (kind == null && this.holes.has(r.name))) {
          if (!this.holes.delete(r.name)) this.unknown(r, it.s);
        } else if (kind == null) this.unknown(r, it.s);
        else this.err(`\`delete\` removes pads and holes, not ${kind === 'side' ? 'sides' : kind + 's'}`, r);
      }
      for (const row of this.rows.values()) row.members = row.members.filter((p) => this.pads.get(p.name) === p);
      // bulk overrides
      for (const it of st.padsStmts) {
        const s = it.s;
        this.guard(s, () => {
          for (const sel of s.sel) {
            const names = sel.range ? expandRange(sel.range[0], sel.range[1], sel) : [sel.name.name];
            for (const n of names) {
              const p = this.pads.get(n);
              if (!p) { this.unknown({ kind: 'pad', name: n, s: sel.s, e: sel.e }, sel); continue; }
              p.partials.push({ stmts: s.block, stmt: s, level: it.level });
              p.src.push(s);
            }
          }
        });
      }
      // order partials: inherited first, then source order
      for (const p of this.pads.values()) p.partials.sort((a, b) => a.level - b.level || a.stmt.s - b.stmt.s);
      // groups
      for (const it of st.groups) {
        const s = it.s;
        const name = s.name.name;
        if (this.groups.has(name) || this.pads.has(name) || this.holes.has(name) || this.rows.has(name)) {
          this.err(`the name \`${name}\` is already used — pads, holes, rows and groups share one namespace`, s.name);
          continue;
        }
        this.groups.set(name, { kind: 'group', name, refs: s.members, node: s });
      }
      for (const r of this.rows.keys()) {
        if (this.pads.has(r) || this.holes.has(r)) this.err(`the name \`${r}\` is already used by a pad or hole`, this.rows.get(r).node.name);
      }
    }

    unknown(r, node) {
      if (this.broken.has(String(r.name))) return;
      const all = [...this.pads.keys(), ...this.holes.keys(), ...this.rows.keys(), ...this.groups.keys()];
      const hint = Parser.suggest(String(r.name), all);
      const label = r.kind && r.kind !== 'side' ? `${r.alias || r.kind} ${quoteName(r.name)}` : quoteName(r.name);
      this.err(`unknown object: ${label}${hint ? ` — did you mean ${quoteName(hint)}?` : ''}`, r.s != null ? r : node);
    }

    // ---------------------------------------------------------- geometry
    resolveGeometry() {
      for (const p of this.pads.values()) this.resolvePad(p, []);
      for (const h of this.holes.values()) {
        if (h.mirror) {
          const proto = this.holes.get(h.mirror.proto);
          if (proto && !h.src.some((n) => n.type === 'Hole')) h.shape = G.mirrorShape(proto.shape, h.mirror.axis);
        }
        h.rot = 0;
        h.bb = bbOf(h.shape, 0);
      }
    }

    resolvePad(p, chain) {
      if (p.spec) return p.spec;
      if (chain.includes(p)) {
        this.err(`mirror cycle: ${chain.map((x) => 'pad ' + x.name).join(' → ')} → pad ${p.name}`, p.mirror.node);
        return null;
      }
      let base = null, sideRot = p.gen ? p.gen.rot || 0 : 0;
      if (p.explicit) base = cloneSpec(p.explicit.spec);
      else if (p.mirror) {
        const proto = this.pads.get(p.mirror.proto);
        if (proto) {
          const ps = this.resolvePad(proto, chain.concat(p));
          if (ps) {
            base = cloneSpec(ps);
            base.shape = G.mirrorShape(ps.shape, p.mirror.axis);
            base.rot = -((proto.sideRot || 0) + (ps.rot || 0));
            sideRot = 0;
          }
        }
      }
      if (!base && p.gen && p.gen.proto) base = cloneSpec(p.gen.proto);
      if (!base && this.defaultSpec) base = cloneSpec(this.defaultSpec);
      if (!base) {
        const node = p.src[0] || this.decl;
        if (!p.geomFailed && !this.broken.has(p.name)) this.err(`pad ${p.name} has no geometry — give it a shape, add \`default pad …\`, or describe the leads with \`lead …\``, node);
        base = { shape: { kind: 'rect', w: 0.5, l: 0.5 }, tht: false, drill: null, rot: 0, mask: null, paste: null, vias: null, missing: true };
      }
      for (const part of p.partials) this.applyBlock(base, part.stmts, part.stmt);
      p.spec = base;
      p.sideRot = sideRot;
      p.rot = sideRot + (base.rot || 0);
      p.bb = bbOf(base.shape, p.rot);
      if (base.drill) {
        const dd = base.drill.d != null ? [base.drill.d, base.drill.d] : [base.drill.slot.w, base.drill.slot.l];
        const sh = base.shape;
        const pw = sh.kind === 'circle' ? sh.d : sh.w, pl = sh.kind === 'circle' ? sh.d : sh.l;
        if (pw != null && (dd[0] >= pw - 1e-9 || dd[1] >= pl - 1e-9)) {
          this.warn(`pad ${p.name}: the drill is as large as the pad — no annular ring`, p.src[p.src.length - 1] || this.decl);
        }
      }
      return base;
    }

    // ---------------------------------------------------------- solver [§9]
    solve() {
      const units = this.units = [];
      const mk = (kind, label, obj) => { const u = { id: units.length, kind, label, obj }; units.push(u); return u; };
      this.bodyUnit = this.body ? mk('body', 'body', null) : null;
      this.originUnit = mk('origin', 'origin', null);
      // rows: rigid units
      const rowOf = new Map();
      for (const row of this.rows.values()) {
        const u = mk('row', `row ${row.name}`, row);
        row.unit = u;
        const dir = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] }[row.going];
        row.members.forEach((p, i) => {
          if (rowOf.has(p)) {
            this.err(`pad ${p.name} is in two rows (${rowOf.get(p).name} and ${row.name})`, row.node);
            return;
          }
          rowOf.set(p, row);
          p.unit = u;
          p.off = { x: dir[0] * i * row.pitch, y: dir[1] * i * row.pitch };
        });
        const bb = { x: { lo: Infinity, hi: -Infinity }, y: { lo: Infinity, hi: -Infinity } };
        for (const p of row.members) {
          if (p.unit !== u) continue;
          for (const a of AXES) {
            bb[a].lo = Math.min(bb[a].lo, p.off[a] + p.bb[a].lo);
            bb[a].hi = Math.max(bb[a].hi, p.off[a] + p.bb[a].hi);
          }
        }
        row.bb = bb;
      }
      for (const p of this.pads.values()) {
        if (!p.unit) { p.unit = mk('pad', `pad ${p.name}`, p); p.off = { x: 0, y: 0 }; }
      }
      for (const h of this.holes.values()) { h.unit = mk('hole', `hole ${h.name}`, h); h.off = { x: 0, y: 0 }; }

      const cons = this.cons = [];
      const add = (c) => { cons.push(c); return c; };
      this.originUsed = false;

      // generator defaults (weak, absolute) — explicit always beats generated
      for (const p of this.pads.values()) {
        if (!p.gen) continue;
        for (const a of AXES) {
          if (p.gen.thermal && this.bodyUnit) {
            const bu = this.bodyUnit.id, off = p.off[a];
            add({ unit: p.unit.id, axis: a, strength: 'gen', level: -1, deps: [bu], abs: false, f: (v) => v[bu] - off, node: p.src[0], label: `${p.unit.label} (centred on body)` });
          } else {
            const g = p.gen[a] - p.off[a];
            add({ unit: p.unit.id, axis: a, strength: 'gen', level: -1, deps: [], abs: true, f: () => g, node: p.src[0], label: `${p.unit.label} (generated)` });
          }
        }
      }
      if (this.bodyUnit && this.gen) {
        for (const a of AXES) add({ unit: this.bodyUnit.id, axis: a, strength: 'gen', level: -1, deps: [], abs: true, f: () => 0, node: this.body.node, label: 'body (generator centre)' });
      }
      // explicit placements; a statement that fails still "claims" its target,
      // so the target isn't also reported as under-constrained
      for (const it of this.st.places) {
        const before = this.cons.length;
        this.guard(it.s, () => this.constrain(it, add));
        if (it.s.type !== 'MeasurePair' && this.cons.length === before) {
          const t = it.s.target || it.s.a;
          if (t && t.name != null) this.broken.add(String(t.name));
          if (t && t.kind === 'body') this.broken.add('#body');
        }
      }
      // measure statements: decide which side they place
      this.resolveMeasures(add);
      // origin, when something measures from it
      if (this.originUsed) this.constrainOrigin(add);

      this.solveAxes();
    }

    info(r, node) {
      switch (r.kind) {
        case 'origin':
          this.originUsed = true;
          return { type: 'single', unit: this.originUnit, off: { x: 0, y: 0 }, bb: ZERO_BB, label: 'origin' };
        case 'body':
          if (!this.body) throw new StompError('there is no `body` to refer to — add `body W x L`', r);
          return { type: 'single', unit: this.bodyUnit, off: { x: 0, y: 0 }, bb: bbOfBody(this.body), label: 'body' };
        case 'side': {
          const names = this.sides[r.name];
          if (!names || !names.length) throw new StompError(`there is no \`side ${r.name}\` — sides come from \`pins … dual/quad/single\` and side blocks`, r);
          return { type: 'set', label: `side ${r.name}`, members: names.map((n) => this.padInfo(this.pads.get(n))) };
        }
        default: break;
      }
      const name = r.name;
      const k = r.kind;
      if ((k === 'pad' || k == null) && this.pads.has(name)) return this.padInfo(this.pads.get(name));
      if ((k === 'hole' || k == null) && this.holes.has(name)) {
        const h = this.holes.get(name);
        return { type: 'single', unit: h.unit, off: h.off, bb: h.bb, label: `hole ${name}`, obj: h };
      }
      if ((k === 'row' || k == null) && this.rows.has(name)) {
        const row = this.rows.get(name);
        return { type: 'row', unit: row.unit, bb: row.bb, label: `row ${name}`, obj: row };
      }
      if ((k === 'group' || k == null) && this.groups.has(name)) return this.groupInfo(this.groups.get(name), []);
      // wrong kind keyword?
      const actual = this.pads.has(name) ? 'pad' : this.holes.has(name) ? 'hole' : this.rows.has(name) ? 'row' : this.groups.has(name) ? 'group' : null;
      if (actual) throw new StompError(`\`${name}\` is a ${actual}, not a ${r.alias || k}`, r);
      if (this.broken.has(String(name))) throw SILENT(r);
      const all = [...this.pads.keys(), ...this.holes.keys(), ...this.rows.keys(), ...this.groups.keys()];
      const hint = Parser.suggest(String(name), all);
      throw new StompError(`unknown object: ${k ? (r.alias || k) + ' ' : ''}${quoteName(name)}${hint ? ` — did you mean ${quoteName(hint)}?` : ''}`, r);
    }

    padInfo(p) { return { type: 'single', unit: p.unit, off: p.off, bb: p.bb, label: `pad ${p.name}`, obj: p }; }

    groupInfo(g, chain) {
      if (chain.includes(g)) throw new StompError(`group ${g.name} contains itself`, g.node);
      const members = g.refs.map((r) => (r.kind === 'group' || (r.kind == null && this.groups.has(r.name) && !this.pads.has(r.name))
        ? this.groupInfo(this.groups.get(r.name) || (() => { throw new StompError(`unknown group ${r.name}`, r); })(), chain.concat(g))
        : this.info(r, g.node)));
      return { type: 'set', label: `group ${g.name}`, members };
    }

    /** Coordinate of an anchor ('center' | 'lo' | 'hi') as a function of solved unit values. */
    anchor(inf, axis, which) {
      if (inf.type === 'single') {
        const u = inf.unit.id, k = inf.off[axis] + (which === 'center' ? 0 : which === 'lo' ? inf.bb[axis].lo : inf.bb[axis].hi);
        return { deps: [u], f: (v) => v[u] + k };
      }
      if (inf.type === 'row') {
        const u = inf.unit.id, bb = inf.bb[axis];
        const k = which === 'center' ? (bb.lo + bb.hi) / 2 : which === 'lo' ? bb.lo : bb.hi;
        return { deps: [u], f: (v) => v[u] + k };
      }
      const parts = inf.members.map((m) => ({ lo: this.anchor(m, axis, 'lo'), hi: this.anchor(m, axis, 'hi') }));
      const deps = [...new Set(parts.flatMap((p) => p.lo.deps))];
      return {
        deps,
        f: (v) => {
          let lo = Infinity, hi = -Infinity;
          for (const p of parts) { lo = Math.min(lo, p.lo.f(v)); hi = Math.max(hi, p.hi.f(v)); }
          return which === 'center' ? (lo + hi) / 2 : which === 'lo' ? lo : hi;
        },
      };
    }

    /** Offset of an anchor from the target unit's variable. */
    toff(inf, axis, which) {
      if (inf.type === 'single') return inf.off[axis] + (which === 'center' ? 0 : which === 'lo' ? inf.bb[axis].lo : inf.bb[axis].hi);
      const bb = inf.bb[axis];
      return which === 'center' ? (bb.lo + bb.hi) / 2 : which === 'lo' ? bb.lo : bb.hi;
    }

    /** Map an anchor word to lo/hi/center on an axis. s: +1/−1 relation sign (0 = none). */
    which(ref, axis, s, role) {
      const a = ref.anchor || 'center';
      switch (a) {
        case 'center': return 'center';
        case 'inner': case 'outer':
          if (!s) throw new StompError(`\`${a}\` is measured toward/away from another object, so it only works in \`is … of\` relations`, ref);
          return (a === 'inner') === (role === 'ref') ? (s > 0 ? 'hi' : 'lo') : (s > 0 ? 'lo' : 'hi');
        case 'left': case 'right':
          if (axis !== 'x') throw new StompError(`anchor \`${a}\` is a horizontal edge, but this measurement is vertical — use \`top\`, \`bottom\`, \`inner\` or \`outer\``, ref);
          return a === 'left' ? 'lo' : 'hi';
        default:
          if (axis !== 'y') throw new StompError(`anchor \`${a}\` is a vertical edge, but this measurement is horizontal — use \`left\`, \`right\`, \`inner\` or \`outer\``, ref);
          return a === 'bottom' ? 'lo' : 'hi';
      }
    }

    /** `at`/`align`/`centered` use only absolute anchors, on their own axis. */
    whichStatic(ref, axis) {
      const a = ref.anchor;
      if (!a || a === 'center') return 'center';
      if (a === 'inner' || a === 'outer') return this.which(ref, axis, 0, 'target');
      if ((a === 'left' || a === 'right') && axis === 'x') return a === 'left' ? 'lo' : 'hi';
      if ((a === 'top' || a === 'bottom') && axis === 'y') return a === 'bottom' ? 'lo' : 'hi';
      return 'center';
    }

    target(r) {
      if (r.kind === 'origin') throw new StompError('`origin` is moved with an `origin` statement, not placed like an object', r);
      const inf = this.info(r);
      if (inf.type === 'set') throw new StompError(`${inf.label} can't be placed — groups and sides only provide a bounding box to measure against; place their members instead`, r);
      if (inf.unit === this.originUnit) throw new StompError('`origin` is moved with an `origin` statement, not placed like an object', r);
      return inf;
    }

    constrain(it, add) {
      const s = it.s;
      const level = it.level;
      const base = { level, node: s };
      switch (s.type) {
        case 'At': {
          const ti = this.target(s.target);
          const P = { x: this.len(s.point.x, s), y: this.len(s.point.y, s) };
          for (const a of AXES) {
            const k = this.toff(ti, a, this.whichStatic(s.target, a));
            add(Object.assign({}, base, {
              unit: ti.unit.id, axis: a, strength: 'strong', deps: [], abs: true, f: () => P[a] - k,
              label: `${ti.label} at (${fmtMM(P.x)}, ${fmtMM(P.y)})`, viz: { kind: 'at', point: P, ti, which: this.whichStatic(s.target, a) },
            }));
          }
          break;
        }
        case 'Is': {
          const ti = this.target(s.target);
          for (const cl of s.clauses) {
            this.guard(cl, () => {
              const axis = cl.dir === 'left' || cl.dir === 'right' ? 'x' : 'y';
              const sg = cl.dir === 'right' || cl.dir === 'above' ? 1 : -1;
              const d = this.len(cl.dist, s);
              const ri = this.info(cl.ref);
              const rw = this.which(cl.ref, axis, sg, 'ref');
              const tw = this.which(s.target, axis, sg, 'target');
              const RA = this.anchor(ri, axis, rw);
              if (RA.deps.includes(ti.unit.id)) {
                throw new StompError(ri.unit === ti.unit && ri.type !== 'set'
                  ? (ti.unit.kind === 'row' ? `${ti.label} and ${ri.label} move together as one row; their spacing comes from the row's pitch` : `${ti.label} can't be placed relative to itself`)
                  : `${ti.label} can't be placed relative to a group that contains it`, cl);
              }
              const k = this.toff(ti, axis, tw);
              add(Object.assign({}, base, {
                unit: ti.unit.id, axis, strength: 'strong', deps: RA.deps, abs: false, f: (v) => RA.f(v) + sg * d - k, node: s, clause: cl,
                label: `${ti.label}${s.target.anchor ? ' ' + s.target.anchor : ''} is ${exprText(this.src, cl.dist)} ${cl.dir}${cl.dir === 'left' || cl.dir === 'right' ? ' of' : ''} ${ri.label}${cl.ref.anchor ? ' ' + cl.ref.anchor : ''}`,
                viz: { kind: 'dim', axis, ri, rw, ti, tw, d, sg, text: exprText(this.src, cl.dist), plain: cl.dist.type === 'num' },
              }));
              // weak cross-axis alignment, centre to centre [§9.2]
              const o = OTHER[axis];
              const RC = this.anchor(ri, o, 'center');
              const kc = this.toff(ti, o, 'center');
              add({ unit: ti.unit.id, axis: o, strength: 'weak', level, deps: RC.deps, abs: false, f: (v) => RC.f(v) - kc, node: s, label: `${ti.label} (aligned with ${ri.label})` });
            });
          }
          break;
        }
        case 'Centered': {
          const ti = this.target(s.target);
          const axes = s.axis === 'horizontally' ? ['x'] : s.axis === 'vertically' ? ['y'] : AXES;
          if (s.target.anchor && s.target.anchor !== 'center') throw new StompError('`centered` places the object\'s centre; drop the anchor', s.target);
          for (const a of axes) {
            const k = this.toff(ti, a, 'center');
            if (s.between) {
              const A = this.anchor(this.info(s.between[0]), a, 'center');
              const B = this.anchor(this.info(s.between[1]), a, 'center');
              const deps = [...new Set(A.deps.concat(B.deps))];
              if (deps.includes(ti.unit.id)) throw new StompError(`${ti.label} can't be centred between objects that move with it`, s);
              add(Object.assign({}, base, {
                unit: ti.unit.id, axis: a, strength: 'strong', deps, abs: false, f: (v) => (A.f(v) + B.f(v)) / 2 - k,
                label: `${ti.label} centred between ${this.info(s.between[0]).label} and ${this.info(s.between[1]).label}`,
                viz: { kind: 'between', axis: a, ai: this.info(s.between[0]), bi: this.info(s.between[1]), ti },
              }));
            } else {
              const oi = this.info(s.on);
              const O = this.anchor(oi, a, 'center');
              if (O.deps.includes(ti.unit.id)) throw new StompError(`${ti.label} can't be centred on something that moves with it`, s);
              add(Object.assign({}, base, {
                unit: ti.unit.id, axis: a, strength: 'strong', deps: O.deps, abs: false, f: (v) => O.f(v) - k,
                label: `${ti.label} centred on ${oi.label}`, viz: { kind: 'on', axis: a, oi, ti },
              }));
            }
          }
          break;
        }
        case 'Align': {
          const ti = this.target(s.a);
          const a = s.axis === 'horizontally' ? 'y' : 'x';
          const bi = this.info(s.b);
          const B = this.anchor(bi, a, this.whichStatic(s.b, a));
          if (B.deps.includes(ti.unit.id)) throw new StompError(`${ti.label} is already rigidly tied to ${bi.label}`, s);
          const k = this.toff(ti, a, this.whichStatic(s.a, a));
          add(Object.assign({}, base, {
            unit: ti.unit.id, axis: a, strength: 'strong', deps: B.deps, abs: false, f: (v) => B.f(v) - k,
            label: `${ti.label} aligned ${s.axis} with ${bi.label}`, viz: { kind: 'align', axis: a, ti, bi },
          }));
          break;
        }
        case 'Mirrors': {
          const pi = this.info(s.proto);
          const ti = this.target(s.target);
          if (pi.type !== 'single' || !pi.obj) throw new StompError('`mirrors` works between pads or holes', s.proto);
          if (ti.type !== 'single' || !ti.obj) throw new StompError('`mirrors` works between pads or holes', s.target);
          if (pi.unit === ti.unit) throw new StompError('an object can\'t mirror itself', s);
          const m = s.axis === 'y' ? 'x' : 'y';   // across y flips x
          for (const a of AXES) {
            const P = this.anchor(pi, a, 'center');
            const k = this.toff(ti, a, 'center');
            const flip = a === m;
            add(Object.assign({}, base, {
              unit: ti.unit.id, axis: a, strength: 'strong', deps: P.deps, abs: flip, f: flip ? (v) => -P.f(v) - k : (v) => P.f(v) - k,
              label: `${ti.label} mirrors ${pi.label} across ${s.axis}`, mirror: { pi, ti, axis: s.axis }, viz: flip ? { kind: 'mirror', axis: m, pi, ti } : null,
            }));
          }
          break;
        }
        case 'MeasurePair': break;   // resolveMeasures
        default: break;
      }
    }

    resolveMeasures(add) {
      const count = new Map();
      const key = (u, a) => `${u}:${a}`;
      const bump = (c) => {
        if (c.strength !== 'strong') return;
        const k = key(c.unit, c.axis);
        const prev = count.get(k);
        if (!prev || prev.level < c.level) count.set(k, { level: c.level, n: 1, c });
        else if (prev.level === c.level) prev.n++;
      };
      this.cons.forEach(bump);
      const strongAt = (u, a, level) => { const p = count.get(key(u, a)); return p && p.level >= level ? p : null; };
      for (const it of this.st.places) {
        const s = it.s;
        if (s.type !== 'MeasurePair') continue;
        this.guard(s, () => {
          const ai = this.info(s.a), bi = this.info(s.b);
          if (s.a.anchor || s.b.anchor) throw new StompError(`\`${s.word}\` decides the anchors itself (span: outer edges, gap: facing edges, pitch: centres) — drop \`${s.a.anchor || s.b.anchor}\``, s.a.anchor ? s.a : s.b);
          // a mirror pair between the two?
          const mir = this.cons.find((c) => c.mirror && c.viz && ((c.mirror.pi.unit === ai.unit && c.mirror.ti.unit === bi.unit) || (c.mirror.pi.unit === bi.unit && c.mirror.ti.unit === ai.unit)));
          let axis = s.axis === 'horizontally' ? 'x' : s.axis === 'vertically' ? 'y' : null;
          if (!axis && mir) axis = mir.viz.axis;
          if (!axis) {
            const al = this.cons.find((c) => c.viz && c.viz.kind === 'align' && ((c.viz.ti.unit === ai.unit && c.viz.bi.unit === bi.unit) || (c.viz.ti.unit === bi.unit && c.viz.bi.unit === ai.unit)));
            if (al) axis = OTHER[al.axis];
          }
          if (!axis) throw new StompError(`can't tell which way \`${s.word}\` measures — append \`horizontally\` or \`vertically\``, s);
          const d = this.len(s.x, s);
          const text = exprText(this.src, s.x);
          if (mir && mir.viz.axis === axis) {
            // symmetric unknown: the prototype takes −x (across y) / +y (across x) [§9.4]
            const proto = mir.mirror.pi, tgt = mir.mirror.ti;
            const prev = strongAt(proto.unit.id, axis, it.level);
            if (prev) {
              throw new StompError(`${proto.label} is already placed on ${axis} (and ${tgt.label} mirrors it), so this ${s.word} over-constrains the pair`, s, [{ message: 'placed here', node: prev.c.node }]);
            }
            const sgn = mir.mirror.axis === 'y' ? -1 : 1;     // side the prototype takes
            const pb = proto.bb[axis], tb = tgt.bb[axis];
            const po = proto.off[axis];
            // measurement m(c) for prototype reference coordinate c, target at −c (mirror)
            const meas = (c) => {
              const t = -c;
              const P = { lo: c + pb.lo, hi: c + pb.hi, c };
              const T = { lo: t + tb.lo, hi: t + tb.hi, c: t };
              const [lowObj, highObj] = sgn < 0 ? [P, T] : [T, P];
              if (s.word === 'pitch') return highObj.c - lowObj.c;
              if (s.word === 'gap') return highObj.lo - lowObj.hi;
              return highObj.hi - lowObj.lo;
            };
            const m0 = meas(0), m1 = meas(1);
            const slope = m1 - m0;
            const c = (d - m0) / slope;
            add({
              unit: proto.unit.id, axis, strength: 'strong', level: it.level, deps: [], abs: true, f: () => c - po, node: s,
              label: `${s.word} ${proto.label} to ${tgt.label} is ${text}`,
              viz: { kind: 'measure', word: s.word, axis, ai: proto, bi: tgt, d, text, plain: s.x.type === 'num' },
            });
            const k = key(proto.unit.id, axis);
            count.set(k, { level: it.level, n: 1, c: { node: s } });
            return;
          }
          // ordinary pair: B on the + side of A by default; place whichever is still free
          let tgtInf, refInf, sg;
          if (!strongAt(bi.unit.id, axis, it.level)) { tgtInf = bi; refInf = ai; sg = 1; }
          else if (!strongAt(ai.unit.id, axis, it.level)) { tgtInf = ai; refInf = bi; sg = -1; }
          else {
            const pa = strongAt(ai.unit.id, axis, it.level), pb = strongAt(bi.unit.id, axis, it.level);
            throw new StompError(`both ${ai.label} and ${bi.label} are already placed on ${axis}, so this ${s.word} over-constrains them`, s,
              [{ message: `${ai.label} placed here`, node: pa.c.node }, { message: `${bi.label} placed here`, node: pb.c.node }]);
          }
          if (tgtInf.type === 'set') throw new StompError(`${tgtInf.label} can't be placed; measure to one of its members`, s);
          const wR = s.word === 'pitch' ? 'center' : s.word === 'gap' ? (sg > 0 ? 'hi' : 'lo') : (sg > 0 ? 'lo' : 'hi');
          const wT = s.word === 'pitch' ? 'center' : s.word === 'gap' ? (sg > 0 ? 'lo' : 'hi') : (sg > 0 ? 'hi' : 'lo');
          const RA = this.anchor(refInf, axis, wR);
          if (RA.deps.includes(tgtInf.unit.id)) throw new StompError(`${ai.label} and ${bi.label} move together; their distance is already fixed`, s);
          const k = this.toff(tgtInf, axis, wT);
          add({
            unit: tgtInf.unit.id, axis, strength: 'strong', level: it.level, deps: RA.deps, abs: false, f: (v) => RA.f(v) + sg * d - k, node: s,
            label: `${s.word} ${ai.label} to ${bi.label} is ${text}`,
            viz: { kind: 'measure', word: s.word, axis, ai, bi, d, text, plain: s.x.type === 'num' },
          });
          count.set(key(tgtInf.unit.id, axis), { level: it.level, n: 1, c: { node: s } });
        });
      }
    }

    constrainOrigin(add) {
      const o = this.st.origin;
      const u = this.originUnit.id;
      if (!o) { for (const a of AXES) add({ unit: u, axis: a, strength: 'strong', level: 0, deps: [], abs: true, f: () => 0, node: this.decl, label: 'origin' }); return; }
      const s = o.s;
      this.guard(s, () => {
        if (s.point) {
          const P = { x: this.len(s.point.x, s), y: this.len(s.point.y, s) };
          for (const a of AXES) add({ unit: u, axis: a, strength: 'strong', level: o.level, deps: [], abs: true, f: () => P[a], node: s, label: 'origin' });
        } else if (s.ref) {
          const inf = this.info(s.ref);
          for (const a of AXES) {
            const A = this.anchor(inf, a, this.whichStatic(s.ref, a));
            add({ unit: u, axis: a, strength: 'strong', level: o.level, deps: A.deps, abs: false, f: A.f, node: s, label: `origin at ${inf.label}` });
          }
        } else {
          const A0 = this.info(s.between[0]), B0 = this.info(s.between[1]);
          for (const a of AXES) {
            const A = this.anchor(A0, a, 'center'), B = this.anchor(B0, a, 'center');
            add({ unit: u, axis: a, strength: 'strong', level: o.level, deps: [...new Set(A.deps.concat(B.deps))], abs: false, f: (v) => (A.f(v) + B.f(v)) / 2, node: s, label: 'origin' });
          }
        }
      });
    }

    solveAxes() {
      const units = this.units;
      const byVar = new Map();
      for (const c of this.cons) {
        const k = `${c.unit}:${c.axis}`;
        if (!byVar.has(k)) byVar.set(k, []);
        byVar.get(k).push(c);
      }
      this.chosen = new Map();
      for (const [k, list] of byVar) {
        const strong = list.filter((c) => c.strength === 'strong');
        if (strong.length) {
          const top = Math.max(...strong.map((c) => c.level));
          const tops = strong.filter((c) => c.level === top).sort((a, b) => (a.node.s || 0) - (b.node.s || 0));
          this.chosen.set(k, tops[0]);
          for (const extra of tops.slice(1)) {
            const u = units[extra.unit];
            this.err(`${u.label}: its ${extra.axis} position is already set by \`${this.stmtText(tops[0].node)}\` (line ${this.lineAt(tops[0].node.s)}) — each axis takes exactly one placement (over-constrained)`,
              extra.clause || extra.node, [{ message: `${extra.axis} first set here`, node: tops[0].clause || tops[0].node }]);
          }
        } else {
          const w = list.find((c) => c.strength === 'weak') || list.find((c) => c.strength === 'gen');
          if (w) this.chosen.set(k, w);
        }
      }
      this.V = { x: new Array(units.length).fill(0), y: new Array(units.length).fill(0) };
      this.unplaced = new Set();
      this.floatingAxes = {};
      this.under = new Map();
      this.cycles = [];
      for (const axis of AXES) this.solveAxis(axis);
      for (const [u, info] of this.under) {
        const unit = units[u];
        const nm = unit.kind === 'body' ? '#body' : unit.obj && unit.obj.name != null ? String(unit.obj.name) : null;
        if (nm && this.broken.has(nm)) continue;
        const axes = info.axes.join(' and ');
        const node = (unit.obj && unit.obj.src && unit.obj.src[0]) || (unit.obj && unit.obj.node) || (unit.kind === 'body' && this.body ? this.body.node : this.decl);
        if (info.why) {
          this.err(`${unit.label} and the objects placed from it float free of the rest of the footprint on ${axes} — tie ${unit.label} to something already placed (under-constrained)`, node);
          continue;
        }
        const how = info.axes.length > 1 ? '`at (x, y)`, a relation (`is … right of …`) or `centered …`'
          : info.axes[0] === 'x' ? '`at`, `is … left of / right of …`, `centered … horizontally` or `align … vertically`'
            : '`at`, `is … above / below …`, `centered … vertically` or `align … horizontally`';
        this.err(`${unit.label} has no ${axes} position — place it with ${how} (under-constrained)`, node);
      }
      const merged = new Map();
      for (const c of this.cycles) {
        const k = c.units.join(',');
        if (merged.has(k)) merged.get(k).axes.push(c.axis); else merged.set(k, Object.assign({}, c, { axes: [c.axis] }));
      }
      for (const c of merged.values()) {
        this.err(`circular placement on ${c.axes.join(' and ')}: ${c.units.map((u) => units[u].label).join(', ')} each depend on another — place one of them from a fixed point to break the cycle`,
          c.nodes[0], c.nodes.slice(1).map((n) => ({ message: 'part of the cycle', node: n })));
      }
    }

    solveAxis(axis) {
      const units = this.units;
      const chosen = (u) => this.chosen.get(`${u}:${axis}`);
      const depended = new Set();
      for (const c of this.chosen.values()) if (c.axis === axis) c.deps.forEach((d) => depended.add(d));
      // which units take part
      const vars = units.filter((u) => {
        if (u.kind === 'origin') return this.originUsed;
        if (u.kind === 'body') return !!chosen(u.id) || depended.has(u.id);
        if (u.kind === 'row') return u.obj.members.some((p) => p.unit === u);
        return true;
      }).map((u) => u.id);
      const inVars = new Set(vars);
      (this.varsByAxis = this.varsByAxis || {})[axis] = inVars;
      // union-find components
      const parent = new Map(vars.map((v) => [v, v]));
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      for (const v of vars) {
        const c = chosen(v);
        if (!c) continue;
        for (const d of c.deps) if (inVars.has(d)) parent.set(find(d), find(v));
      }
      const comps = new Map();
      for (const v of vars) {
        const r = find(v);
        if (!comps.has(r)) comps.set(r, { units: [], anchored: false, roots: [] });
        const comp = comps.get(r);
        comp.units.push(v);
        const c = chosen(v);
        if (!c) comp.roots.push(v);
        else if (c.abs) comp.anchored = true;
      }
      const list = [...comps.values()];
      const anyAnchored = list.some((c) => c.anchored);
      let main = null;
      if (!anyAnchored && list.length) {
        main = list.find((c) => this.bodyUnit && c.units.includes(this.bodyUnit.id))
          || list.slice().sort((a, b) => b.units.length - a.units.length)[0];
      }
      const V = this.V[axis];
      const label = (u) => units[u].label;
      const under = (u, why) => {
        this.unplaced.add(u);
        if (!this.under.has(u)) this.under.set(u, { axes: [], why });
        this.under.get(u).axes.push(axis);
      };
      for (const comp of list) {
        if (comp.anchored) comp.roots.forEach((u) => under(u, ''));
        else if (comp === main) {
          comp.roots.slice(1).forEach((u) => under(u, ''));
          comp.floating = true;
        } else {
          // a lone object with no placement at all just "has no position"; a
          // placed cluster floating free of the rest "isn't tied" to it
          comp.roots.forEach((u) => under(u, comp.units.length > 1));
          comp.units.forEach((u) => this.unplaced.add(u));   // positions are arbitrary
        }
        comp.roots.forEach((u) => { V[u] = 0; });
      }
      // topological evaluation
      const done = new Set();
      for (const comp of list) comp.roots.forEach((u) => done.add(u));
      let progress = true;
      const pending = vars.filter((u) => !done.has(u));
      while (progress) {
        progress = false;
        for (let i = 0; i < pending.length; i++) {
          const u = pending[i];
          if (done.has(u)) continue;
          const c = chosen(u);
          if (c.deps.every((d) => done.has(d) || !inVars.has(d))) {
            V[u] = c.f(V);
            done.add(u);
            progress = true;
          }
        }
      }
      const stuck = pending.filter((u) => !done.has(u));
      if (stuck.length) {
        const nodes = [...new Set(stuck.map((u) => chosen(u).node))];
        this.cycles.push({ axis, units: stuck, nodes });
        stuck.forEach((u) => { V[u] = 0; this.unplaced.add(u); });
      }
      // floating layout: the origin rule fixes the translation (body centroid, else land centre) [§6]
      if (main && main.floating) {
        this.floatingAxes[axis] = true;
        let ref = null;
        if (this.bodyUnit && main.units.includes(this.bodyUnit.id)) ref = V[this.bodyUnit.id];
        else {
          let lo = Infinity, hi = -Infinity;
          for (const u of main.units) {
            const o = units[u].obj;
            const objs = units[u].kind === 'row' ? units[u].obj.members : (o && o.bb ? [o] : []);
            for (const m of objs) { lo = Math.min(lo, V[u] + m.off[axis] + m.bb[axis].lo); hi = Math.max(hi, V[u] + m.off[axis] + m.bb[axis].hi); }
          }
          if (lo <= hi) ref = (lo + hi) / 2;
        }
        if (ref != null) for (const u of main.units) V[u] -= ref;
      }
    }

    // ---------------------------------------------------------- final positions & layers [§12]
    layers() {
      const V = this.V;
      const pos = (obj) => ({ x: V.x[obj.unit.id] + obj.off.x, y: V.y[obj.unit.id] + obj.off.y });
      for (const p of this.pads.values()) Object.assign(p, pos(p));
      for (const h of this.holes.values()) Object.assign(h, pos(h));
      // body: placed, generator-centred, or centred on the land pattern
      if (this.body) {
        const b = this.body;
        const land = this.landBox();
        for (const a of AXES) {
          const solved = this.varsByAxis[a].has(this.bodyUnit.id);
          b[a] = solved ? V[a][this.bodyUnit.id] : (land ? (a === 'x' ? (land.x0 + land.x1) / 2 : (land.y0 + land.y1) / 2) : 0);
          V[a][this.bodyUnit.id] = b[a];
        }
      }
      // final origin [§6]
      let O = { x: 0, y: 0 };
      const o = this.st.origin;
      if (this.originUsed) O = { x: V.x[this.originUnit.id], y: V.y[this.originUnit.id] };
      else if (o) {
        const s = o.s;
        this.guard(s, () => {
          if (s.point) O = { x: this.len(s.point.x, s), y: this.len(s.point.y, s) };
          else if (s.ref) {
            const inf = this.info(s.ref);
            const vals = { x: V.x, y: V.y };
            O = { x: this.anchor(inf, 'x', this.whichStatic(s.ref, 'x')).f(vals.x), y: this.anchor(inf, 'y', this.whichStatic(s.ref, 'y')).f(vals.y) };
          } else {
            const A = this.info(s.between[0]), B = this.info(s.between[1]);
            O = {
              x: (this.anchor(A, 'x', 'center').f(V.x) + this.anchor(B, 'x', 'center').f(V.x)) / 2,
              y: (this.anchor(A, 'y', 'center').f(V.y) + this.anchor(B, 'y', 'center').f(V.y)) / 2,
            };
          }
        });
      }
      this.O = O;
      const floatAxes = AXES.filter((a) => this.floatingAxes[a]);
      if (o) this.originNote = this.stmtText(o.s);
      else if (floatAxes.length) {
        this.originNote = `${this.body ? 'body centre' : 'land-pattern centre'} — nothing places the layout absolutely on ${floatAxes.join(' or ')}, so the origin rule anchors it (§6)`;
      } else if (this.body && this.gen) this.originNote = 'body centre (generated package)';
      else this.originNote = '(0, 0) as the placements give it';
      const sh = (p) => [p[0] - O.x, p[1] - O.y];
      this.shift = sh;
      for (const p of this.pads.values()) { p.x -= O.x; p.y -= O.y; }
      for (const h of this.holes.values()) { h.x -= O.x; h.y -= O.y; }
      if (this.body) { this.body.x -= O.x; this.body.y -= O.y; }
      // copper / mask / paste / drills
      this.L = { silk: [], courtyard: [], assembly: [], texts: [] };
      this.manual = { silk: [], courtyard: [], assembly: [], texts: [] };
      for (const p of this.pads.values()) this.padLayers(p);
      for (const h of this.holes.values()) this.holeLayers(h);
      // Everything that can report a problem runs now; the automatic silk, assembly
      // and courtyard geometry waits for finishLayers(), on first use.
      for (const [name, fn] of [['pin 1', this.pin1Info], ['graphics', this.manualLayers], ['text', this.textLayer]]) {
        try { fn.call(this); } catch (e) {
          if (e instanceof StompError) { if (!e.silent) this.err(e.message, e.node); continue; }
          this.err(`internal error while drawing the ${name} layer: ${e && e.message}`, { s: this.decl.nameS, e: this.decl.nameE });
          if (typeof console !== 'undefined') console.error(e);
        }
      }
    }

    /** Manual graphics, text and courtyard settings — evaluated eagerly for their diagnostics. */
    manualLayers() {
      for (const it of this.st.silk) if (it.s.mode === 'block') this.gfx(it.s.items, 'silk', this.manual.silk, D.silkW);
      for (const it of this.st.assembly) if (it.s.mode === 'block') this.gfx(it.s.items, 'assembly', this.manual.assembly, D.fabW);
      // courtyard: base (auto [clearance] | rect W x L | none) plus blocks
      const items = this.st.courtyard;
      let base = { mode: 'auto', clearance: null, node: null };
      let anyBlock = false, explicitBase = false;
      for (const it of items) {
        if (it.s.mode === 'block') { anyBlock = true; continue; }
        explicitBase = true;
        base = { mode: it.s.mode, node: it.s, clearance: it.s.clearance, size: it.s.size };
      }
      if (anyBlock && !explicitBase) base = { mode: 'none' };   // DEMO DECISION: a manual courtyard replaces the auto one
      if (base.mode === 'auto') {
        let c = this.courtyardExcess != null ? this.courtyardExcess : CY_DEFAULT[this.lv];
        if (base.clearance) c = this.guard(base.node, () => this.plen(base.clearance, base.node, 'courtyard clearance'));
        base.c = c == null ? CY_DEFAULT[this.lv] : c;
      } else if (base.mode === 'rect') {
        this.guard(base.node, () => {
          base.w = this.plen(base.size.w, base.node, 'courtyard width');
          base.l = this.plen(base.size.l, base.node, 'courtyard length');
        });
      }
      this.cyBase = base;
      for (const it of items) if (it.s.mode === 'block') this.gfx(it.s.items, 'courtyard', this.manual.courtyard, D.crtW);
      // polarity marks need a two-terminal part
      if (this.polarized && this.layerBase('silk') === 'auto') {
        const g = this.gen;
        if (!g || g.kind !== 'two' || !this.pads.get('2')) this.warn('`polarized` marks two-terminal parts (pins 1 and 2)', this.st.polarized.s);
      }
    }

    /** Automatic silk / assembly / courtyard (deferred: only footprints on screen need them). */
    finishLayers() {
      if (this.finished) return;
      this.finished = true;
      this.keepouts = [];
      for (const p of this.pads.values()) {
        const m = p.spec.mask && p.spec.mask.mode === 'none' ? 0 : (p.spec.mask && p.spec.mask.mode === 'expand' ? Math.max(0, p.spec.mask.v) : D.mask);
        const grow = (p.spec.mask && p.spec.mask.mode === 'defined' ? D.maskDefinedOverlap : m) + D.silkClear + D.silkW / 2;
        this.keepouts.push(G.contourToPoly(G.transformContour(G.shapeContour(p.spec.shape, grow), rad(p.rot), p.x, p.y), rad(8)));
      }
      for (const h of this.holes.values()) {
        this.keepouts.push(G.contourToPoly(G.transformContour(G.shapeContour(h.shape, D.holeMask + D.silkClear + D.silkW / 2), 0, h.x, h.y), rad(8)));
      }
      for (const fn of [this.silkLayer, this.assemblyLayer, this.courtyardLayer]) {
        try { fn.call(this); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
      }
      // manual items and footprint-level text come after the automatic ones
      for (const k of ['silk', 'assembly', 'courtyard']) this.L[k].push(...this.manual[k]);
    }

    landBox() {
      let bb = G.emptyBox();
      for (const o of [...this.pads.values(), ...this.holes.values()]) {
        if (!o.bb) continue;
        bb = G.unionBox(bb, { x0: o.x + o.bb.x.lo, x1: o.x + o.bb.x.hi, y0: o.y + o.bb.y.lo, y1: o.y + o.bb.y.hi });
      }
      return G.boxValid(bb) ? bb : null;
    }

    padLayers(p) {
      const s = p.spec;
      const r = rad(p.rot);
      const at = (edges) => G.transformContour(edges, r, p.x, p.y);
      p.land = at(G.shapeContour(s.shape, 0));
      const maskMode = s.mask ? s.mask.mode : 'default';
      p.copper = maskMode === 'defined' ? at(G.shapeContour(s.shape, D.maskDefinedOverlap)) : p.land;
      p.maskOpen = maskMode === 'none' ? null
        : maskMode === 'defined' ? p.land
          : at(G.shapeContour(s.shape, maskMode === 'expand' ? s.mask.v : D.mask));
      // paste
      let paste = null;
      const pm = s.paste ? s.paste.mode : (s.tht ? 'none' : 'default');
      if (pm === 'default') paste = [p.land];
      else if (pm === 'expand') paste = [at(G.shapeContour(s.shape, s.paste.v))];
      else if (pm === 'divide') paste = this.pasteWindows(s, at);
      p.paste = paste;
      // drill
      p.drillShape = null;
      if (s.drill) {
        p.drillShape = s.drill.d != null
          ? G.circleContour(s.drill.d / 2, [p.x, p.y])
          : at(G.shapeContour({ kind: 'oval', w: s.drill.slot.w, l: s.drill.slot.l }, 0));
      }
      // thermal vias
      p.viaList = [];
      if (s.vias) {
        const v = s.vias;
        const c = Math.cos(r), sn = Math.sin(r);
        for (let i = 0; i < v.nx; i++) {
          for (let j = 0; j < v.ny; j++) {
            const lx = (i - (v.nx - 1) / 2) * v.pitch, ly = ((v.ny - 1) / 2 - j) * v.pitch;
            p.viaList.push({ x: p.x + lx * c - ly * sn, y: p.y + lx * sn + ly * c, d: v.drill });
          }
        }
        const bw = p.bb.x.hi - p.bb.x.lo, bl = p.bb.y.hi - p.bb.y.lo;
        if ((v.nx - 1) * v.pitch + v.drill > Math.max(bw, bl) + 1e-9 || (v.ny - 1) * v.pitch + v.drill > Math.max(bw, bl) + 1e-9) {
          this.warn(`pad ${p.name}: the via array extends beyond the pad`, (s.src || []).find((n) => n.prop === 'vias') || p.src[0]);
        }
      }
    }

    pasteWindows(s, at) {
      const sh = s.shape;
      const bb = G.contourBBox(G.shapeContour(sh, 0));
      const W = bb.x1 - bb.x0, L = bb.y1 - bb.y0;
      const { nx, ny } = s.paste;
      const out = [];
      if (s.paste.gutter != null) {
        const g = s.paste.gutter;
        const w = (W - (nx - 1) * g) / nx, l = (L - (ny - 1) * g) / ny;
        if (w <= 0 || l <= 0) { this.warn('paste gutter is too wide for this pad — no windows left', (s.src || []).find((n) => n.prop === 'paste')); return []; }
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const cx = bb.x0 + i * (w + g) + w / 2, cy = bb.y0 + j * (l + g) + l / 2;
          out.push(at(G.transformContour(G.rrectContour(w, l, {}), 0, cx, cy)));
        }
        return out;
      }
      const cov = s.paste.coverage != null ? s.paste.coverage : 0.5;
      const k = Math.sqrt(cov);
      const cw = W / nx, cl = L / ny;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const cx = bb.x0 + (i + 0.5) * cw, cy = bb.y0 + (j + 0.5) * cl;
        out.push(at(G.transformContour(G.rrectContour(cw * k, cl * k, {}), 0, cx, cy)));
      }
      return out;
    }

    holeLayers(h) {
      h.rot = 0;
      h.land = G.transformContour(G.shapeContour(h.shape, 0), 0, h.x, h.y);
      h.maskOpen = G.transformContour(G.shapeContour(h.shape, D.holeMask), 0, h.x, h.y);
    }

    pin1Info() {
      this.pin1 = null;
      const gen = this.gen;
      const named = this.pads.get('1') || (gen && gen.kind === 'balls' ? this.pads.get('A1') : null);
      if (named) this.pin1 = { x: named.x, y: named.y, pad: named };
      else if (gen && gen.pin1) {
        const p = this.pads.get(gen.pin1.name);
        if (p) this.pin1 = { x: p.x, y: p.y, pad: p };
        else this.pin1 = { x: gen.pin1.x - this.O.x, y: gen.pin1.y - this.O.y, pad: null, side: gen.pin1.side };
      }
      const style = this.st.pin1 ? this.st.pin1.s.style
        : (gen && ['dual', 'quad', 'single', 'sides'].includes(gen.kind) ? 'dot' : 'none');
      this.pin1Style = style;
    }

    /** Body outline as a closed polyline (offset o), with optional pin-1 chamfer / notch. */
    bodyOutline(o, mods) {
      const b = this.body;
      if (b.kind === 'cyl') return G.arcPoints([b.x, b.y], b.w / 2 + o, 0, Math.PI * 2, rad(3)).slice(0, -1);
      const hw = b.w / 2 + o, hl = b.l / 2 + o;
      const C = { bl: [b.x - hw, b.y - hl], br: [b.x + hw, b.y - hl], tr: [b.x + hw, b.y + hl], tl: [b.x - hw, b.y + hl] };
      const seq = ['bl', 'br', 'tr', 'tl'];
      const pts = [];
      seq.forEach((k, i) => {
        if (mods && mods.chamfer && mods.chamfer.corner === k && mods.chamfer.c > 0) {
          const prev = C[seq[(i + 3) % 4]], next = C[seq[(i + 1) % 4]], cur = C[k];
          const cc = mods.chamfer.c;
          const tow = (q) => { const d = G.dist(cur, q); return d < 1e-12 ? cur : [cur[0] + ((q[0] - cur[0]) / d) * cc, cur[1] + ((q[1] - cur[1]) / d) * cc]; };
          pts.push(tow(prev), tow(next));
        } else pts.push(C[k]);
        if (mods && mods.notch) {
          // edge from this corner to the next
          const edgeName = { bl: 'bottom', br: 'right', tr: 'top', tl: 'left' }[k];
          if (edgeName === mods.notch.edge) {
            const a = C[k], bnext = C[seq[(i + 1) % 4]];
            const m = [(a[0] + bnext[0]) / 2, (a[1] + bnext[1]) / 2];
            const len = G.dist(a, bnext);
            const t = [(bnext[0] - a[0]) / len, (bnext[1] - a[1]) / len];
            const n = [-t[1], t[0]];   // inward for a CCW outline
            const r = mods.notch.r;
            for (let j = 0; j <= 16; j++) {
              const phi = (Math.PI * j) / 16;
              pts.push([m[0] - r * t[0] * Math.cos(phi) + r * n[0] * Math.sin(phi), m[1] - r * t[1] * Math.cos(phi) + r * n[1] * Math.sin(phi)]);
            }
          }
        }
      });
      return pts;
    }

    silkLayer() {
      const out = this.L.silk;
      const base = this.layerBase('silk');
      const w = D.silkW;
      if (base === 'auto') {
        const auto = [];
        const style = this.pin1Style;
        const b = this.body;
        const p1 = this.pin1;
        let corner = null;
        if (b && p1 && b.kind === 'box') corner = (p1.x <= b.x ? 'l' : 'r') === 'l' ? (p1.y >= b.y ? 'tl' : 'bl') : (p1.y >= b.y ? 'tr' : 'br');
        if (b) {
          const mods = {};
          if (b.kind === 'box' && p1 && style === 'chamfer') {
            const c = this.chamferSize(corner);
            if (c) mods.chamfer = { corner, c };
          }
          if (b.kind === 'box' && p1 && style === 'notch') {
            const edge = this.pin1End(corner);
            const edgeLen = edge === 'top' || edge === 'bottom' ? b.w : b.l;
            mods.notch = { edge, r: Math.min(1.0, 0.15 * edgeLen) };
          }
          auto.push({ pts: this.bodyOutline(D.silkOffset, mods), closed: true });
          if (b.kind === 'box' && p1 && style === 'bar') {
            const edge = this.pin1End(corner);
            const inset = Math.max(0.25, 0.08 * (edge === 'top' || edge === 'bottom' ? b.l : b.w));
            const hw = b.w / 2 + D.silkOffset, hl = b.l / 2 + D.silkOffset;
            const seg = {
              top: [[b.x - hw, b.y + hl - inset], [b.x + hw, b.y + hl - inset]],
              bottom: [[b.x - hw, b.y - hl + inset], [b.x + hw, b.y - hl + inset]],
              left: [[b.x - hw + inset, b.y - hl], [b.x - hw + inset, b.y + hl]],
              right: [[b.x + hw - inset, b.y - hl], [b.x + hw - inset, b.y + hl]],
            }[edge];
            auto.push({ pts: seg, closed: false });
          }
        }
        if (this.polarized) this.polarityMarks(auto, out);
        // clip against copper keep-outs
        for (const pl of auto) {
          for (const piece of G.clipPolylineOutside(pl.pts, this.keepouts, pl.closed)) out.push({ type: 'line', pts: piece, w, auto: true });
        }
        if (p1 && (style === 'dot' || (style === 'chamfer' && !(b && b.kind === 'box')))) this.pin1Dot(out);
        if (p1 && style === 'chamfer' && b && b.kind === 'box' && !this.chamferSize(corner)) this.pin1Dot(out);
      }
    }

    pin1End(corner) {
      const b = this.body, p1 = this.pin1;
      const g = this.gen;
      const pad = p1.pad;
      const side = (pad && pad.gen && pad.gen.side) || p1.side || null;
      const two = g && g.kind === 'two';
      if (two && side) return side;
      if (side === 'left' || side === 'right') return corner && corner[0] === 't' ? 'top' : 'bottom';
      if (side === 'top' || side === 'bottom') return corner && corner[1] === 'l' ? 'left' : 'right';
      // no side info: the body edge nearest pin 1
      const dx = (p1.x - b.x) / b.w, dy = (p1.y - b.y) / b.l;
      return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'bottom' : 'top');
    }

    chamferSize(corner) {
      const b = this.body;
      if (!corner) return 0;
      const o = D.silkOffset;
      const hw = b.w / 2 + o, hl = b.l / 2 + o;
      const K = [b.x + (corner[1] === 'l' ? -hw : hw), b.y + (corner[0] === 't' ? hl : -hl)];
      const leg = (dir, len) => {
        const end = [K[0] + dir[0] * len, K[1] + dir[1] * len];
        const pieces = G.clipPolylineOutside([K, end], this.keepouts, false);
        const first = pieces.find((pc) => G.dist(pc[0], K) < 1e-6);
        return first ? G.pathLength(first) : 0;
      };
      const lx = leg([corner[1] === 'l' ? 1 : -1, 0], 2 * hw);
      const ly = leg([0, corner[0] === 't' ? -1 : 1], 2 * hl);
      let c = Math.min(lx, ly, 1.0, 0.25 * Math.min(b.w, b.l));
      if (c < 0.15) return 0;
      return c;
    }

    pin1Dot(out) {
      const p1 = this.pin1, b = this.body;
      const r = D.dot / 2;
      const cands = [];
      if (b && b.kind === 'box') {
        const sx = p1.x <= b.x ? -1 : 1, sy = p1.y >= b.y ? 1 : -1;
        const k = D.silkOffset + r + 0.15;
        cands.push([b.x + sx * (b.w / 2 + k), b.y + sy * (b.l / 2 + k)]);
      }
      if (p1.pad) {
        const pd = p1.pad;
        const side = pd.gen && pd.gen.side;
        const cx = b ? b.x : 0, cy = b ? b.y : 0;
        const out2 = side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'top' ? [0, 1] : side === 'bottom' ? [0, -1]
          : (Math.abs(pd.x - cx) >= Math.abs(pd.y - cy) ? [Math.sign(pd.x - cx) || -1, 0] : [0, Math.sign(pd.y - cy) || 1]);
        const ext = out2[0] ? (out2[0] > 0 ? pd.bb.x.hi : -pd.bb.x.lo) : (out2[1] > 0 ? pd.bb.y.hi : -pd.bb.y.lo);
        const k = ext + D.mask + D.silkClear + r + 0.1;
        cands.push([pd.x + out2[0] * k, pd.y + out2[1] * k]);
        const along = out2[0] ? [0, 1] : [-1, 0];
        const ext2 = along[1] ? pd.bb.y.hi : -pd.bb.x.lo;
        const k2 = ext2 + D.mask + D.silkClear + r + 0.1;
        cands.push([pd.x + along[0] * k2, pd.y + along[1] * k2]);
      } else if (!b) cands.push([p1.x - 1, p1.y + 1]);
      const free = cands.find((c) => !this.keepouts.some((k) => G.pointInPoly(c, k) || minDistToPoly(c, k) < r));
      const c = free || cands[0];
      if (c) out.push({ type: 'circle', c, r, fill: true, auto: true });
    }

    polarityMarks(auto, out) {
      const g = this.gen;
      const p2 = this.pads.get('2');
      const p1 = this.pads.get('1');
      if (!g || g.kind !== 'two' || !p2) return;   // reported by manualLayers()
      const b = this.body;
      const cx = b ? b.x : (p1 ? (p1.x + p2.x) / 2 : 0), cy = b ? b.y : (p1 ? (p1.y + p2.y) / 2 : 0);
      const horiz = Math.abs(p2.x - cx) >= Math.abs(p2.y - cy);
      if (b && b.kind === 'cyl') {
        // hatched stripe on the negative (pin 2) side, '+' by pin 1
        const R = b.w / 2 + D.silkOffset;
        const u = horiz ? [Math.sign(p2.x - cx) || 1, 0] : [0, Math.sign(p2.y - cy) || 1];
        const v = [-u[1], u[0]];
        for (let t = R * 0.55; t < R - 0.05; t += 0.25) {
          const h = Math.sqrt(R * R - t * t);
          auto.push({ pts: [[cx + u[0] * t - v[0] * h, cy + u[1] * t - v[1] * h], [cx + u[0] * t + v[0] * h, cy + u[1] * t + v[1] * h]], closed: false });
        }
        if (p1) {
          const s = 0.5;
          const ext = (horiz ? (p1.bb.x.hi - p1.bb.x.lo) : (p1.bb.y.hi - p1.bb.y.lo)) / 2;
          const k = ext + 0.55;
          const pc = horiz ? [p1.x, p1.y + k] : [p1.x + k, p1.y];
          out.push({ type: 'line', pts: [[pc[0] - s / 2, pc[1]], [pc[0] + s / 2, pc[1]]], w: D.silkW, auto: true });
          out.push({ type: 'line', pts: [[pc[0], pc[1] - s / 2], [pc[0], pc[1] + s / 2]], w: D.silkW, auto: true });
        }
        return;
      }
      // bar beyond the pin-2 land
      const grow = D.mask + D.silkClear + D.silkW / 2 + 0.05;
      if (horiz) {
        const sgn = Math.sign(p2.x - cx) || 1;
        const x = sgn > 0 ? p2.x + p2.bb.x.hi + grow : p2.x + p2.bb.x.lo - grow;
        const half = Math.max(b ? b.l / 2 + D.silkOffset : 0, (p2.bb.y.hi - p2.bb.y.lo) / 2 + 0.1);
        out.push({ type: 'line', pts: [[x, cy - half], [x, cy + half]], w: D.silkW, auto: true });
      } else {
        const sgn = Math.sign(p2.y - cy) || 1;
        const y = sgn > 0 ? p2.y + p2.bb.y.hi + grow : p2.y + p2.bb.y.lo - grow;
        const half = Math.max(b ? b.w / 2 + D.silkOffset : 0, (p2.bb.x.hi - p2.bb.x.lo) / 2 + 0.1);
        out.push({ type: 'line', pts: [[cx - half, y], [cx + half, y]], w: D.silkW, auto: true });
      }
    }

    assemblyLayer() {
      const out = this.L.assembly;
      const base = this.layerBase('assembly');
      const b = this.body;
      if (base === 'auto' && b) {
        const mods = {};
        const p1 = this.pin1;
        const g = this.gen;
        if (b.kind === 'box' && p1 && g && g.kind !== 'two' && this.pin1Style !== 'none') {
          const corner = (p1.y >= b.y ? 't' : 'b') + (p1.x <= b.x ? 'l' : 'r');
          mods.chamfer = { corner, c: Math.min(1.0, 0.25 * Math.min(b.w, b.l)) };
        }
        out.push({ type: 'line', pts: this.bodyOutline(0, mods).concat([this.bodyOutline(0, mods)[0]]), w: D.fabW, auto: true });
        const label = this.refLabel();
        const size = clamp(0.3 * Math.min(b.w, b.l), 0.2, 1.0);
        const maxW = 0.85 * (b.kind === 'cyl' ? b.w * 0.7 : b.w);
        const fit = Math.min(size, maxW / (0.62 * label.length));
        out.push({ type: 'text', at: [b.x, b.y], size: fit, str: label, auto: true });
        // castellation half-holes
        if (g && this.lead && this.lead.form === 'castellated') {
          const d = this.lead.d != null ? this.lead.d : this.lead.v;
          for (const p of this.pads.values()) {
            if (!p.gen || !p.gen.side) continue;
            const side = p.gen.side;
            const ex = side === 'left' ? b.x - b.w / 2 : side === 'right' ? b.x + b.w / 2 : p.x;
            const ey = side === 'bottom' ? b.y - b.l / 2 : side === 'top' ? b.y + b.l / 2 : p.y;
            const a0 = { bottom: 0, right: Math.PI / 2, top: Math.PI, left: -Math.PI / 2 }[side];
            out.push({ type: 'line', pts: G.arcPoints([side === 'left' || side === 'right' ? ex : p.x, side === 'top' || side === 'bottom' ? ey : p.y], d / 2, a0, a0 + Math.PI), w: D.fabW, auto: true });
          }
        }
      }
    }

    courtyardLayer() {
      const out = this.L.courtyard;
      const base = this.cyBase || { mode: 'none' };
      if (base.mode === 'auto') {
        const c = base.c;
        const pts = [];
        for (const p of this.pads.values()) pts.push(...G.contourToPoly(p.copper, rad(10)));
        for (const h of this.holes.values()) pts.push(...G.contourToPoly(h.land, rad(10)));
        if (this.body) pts.push(...this.bodyOutline(0, null));
        if (pts.length >= 3) {
          const hull = G.convexHull(pts);
          const off = G.offsetPolygon(hull, c);
          const cen = G.polyCentroid(off);
          const snapped = off.map(([x, y]) => [x >= cen[0] ? ceilTo(x, 0.01) : floorTo(x, 0.01), y >= cen[1] ? ceilTo(y, 0.01) : floorTo(y, 0.01)]);
          out.push({ type: 'line', pts: snapped.concat([snapped[0]]), w: D.crtW, auto: true });
          this.courtyardClearance = c;
        }
      } else if (base.mode === 'rect' && base.w != null && base.l != null) {
        const w = base.w, l = base.l;
        const c = this.body ? [this.body.x, this.body.y] : this.shift([0, 0]);
        const pts = [[c[0] - w / 2, c[1] - l / 2], [c[0] + w / 2, c[1] - l / 2], [c[0] + w / 2, c[1] + l / 2], [c[0] - w / 2, c[1] + l / 2]];
        out.push({ type: 'line', pts: pts.concat([pts[0]]), w: D.crtW, src: base.node });
      }
    }

    layerBase(layer) {
      let base = 'auto';
      for (const it of this.st[layer]) if (it.s.mode === 'auto' || it.s.mode === 'none') base = it.s.mode;
      return base;
    }

    refLabel() {
      const r = this.st.meta.refdes ? this.st.meta.refdes.value : 'REF';
      return `${r}?`;
    }

    gfx(items, layer, out, defW) {
      const P = (pt, s) => this.shift([this.len(pt.x, s), this.len(pt.y, s)]);
      for (const g of items) {
        this.guard(g, () => {
          const wOf = () => (g.width ? this.plen(g.width, g, 'line width') : defW);
          switch (g.op) {
            case 'outline': {
              if (!this.body) throw new StompError('`outline body` needs a `body`', g);
              const o = g.offset ? this.len(g.offset, g) : 0;
              const pts = this.bodyOutline(o, null);
              out.push({ type: 'line', pts: pts.concat([pts[0]]), w: defW, src: g });
              break;
            }
            case 'line': out.push({ type: 'line', pts: [P(g.a, g), P(g.b, g)], w: wOf(), src: g }); break;
            case 'arc': {
              const c = P(g.c, g), r = this.plen(g.r, g, 'arc radius');
              let a0 = g.from.deg, a1 = g.to.deg;
              while (a1 <= a0) a1 += 360;
              out.push({ type: 'line', pts: G.arcPoints(c, r, rad(a0), rad(a1)), w: wOf(), src: g });
              break;
            }
            case 'circle': {
              const c = P(g.c, g), r = this.plen(g.d, g, 'circle diameter') / 2;
              out.push(g.fill ? { type: 'circle', c, r, fill: true, src: g } : { type: 'circle', c, r, w: wOf(), src: g });
              break;
            }
            case 'rect': {
              const c = P(g.c, g), w = this.plen(g.size.w, g, 'width'), l = this.plen(g.size.l, g, 'length');
              const pts = [[c[0] - w / 2, c[1] - l / 2], [c[0] + w / 2, c[1] - l / 2], [c[0] + w / 2, c[1] + l / 2], [c[0] - w / 2, c[1] + l / 2]];
              out.push(g.fill ? { type: 'poly', pts, fill: true, src: g } : { type: 'line', pts: pts.concat([pts[0]]), w: wOf(), src: g });
              break;
            }
            case 'polygon': {
              const pts = g.pts.map((p) => P(p, g));
              out.push(g.fill ? { type: 'poly', pts, fill: true, src: g } : { type: 'line', pts: pts.concat([pts[0]]), w: defW, src: g });
              break;
            }
            case 'text': this.textItem(g, layer, out); break;
            default: break;
          }
        });
      }
    }

    textItem(t, layerDefault, outDefault) {
      const at = this.shift([this.len(t.at.x, t), this.len(t.at.y, t)]);
      const size = t.size ? this.plen(t.size, t, 'text size') : 1.0;
      const field = t.which.field;
      const str = field === 'ref' ? this.refLabel() : field === 'value' ? this.name : t.which.str;
      const layer = t.layer || layerDefault || (field === 'value' ? 'assembly' : 'silk');
      const item = { type: 'text', at, size, str, src: t, field: field || null };
      if (layer === 'silk') this.manual.silk.push(item);
      else if (layer === 'assembly') this.manual.assembly.push(item);
      else if (layer === 'copper' || layer === 'mask') this.L.texts.push(Object.assign(item, { layer }));
      else outDefault.push(item);
    }

    textLayer() {
      for (const it of this.st.texts) this.guard(it.s, () => this.textItem(it.s, null, this.manual.silk));
    }

    // ---------------------------------------------------------- checks [§15]
    checks() {
      const unplacedUnits = this.unplaced;
      const pads = [...this.pads.values()].filter((p) => !p.spec.missing && !unplacedUnits.has(p.unit.id));
      const items = pads.map((p, i) => ({ p, i, bb: G.contourBBox(p.copper), poly: null }));
      const poly = (it) => it.poly || (it.poly = G.contourToPoly(it.p.copper, rad(10)));
      const sorted = items.slice().sort((a, b) => a.bb.x0 - b.bb.x0);
      const hits = [];
      for (let i = 0; i < sorted.length; i++) {
        const A = sorted[i];
        for (let j = i + 1; j < sorted.length && sorted[j].bb.x0 <= A.bb.x1; j++) {
          const B = sorted[j];
          if (!G.boxOverlap(A.bb, B.bb)) continue;
          if (G.polysOverlap(poly(A), poly(B))) hits.push(A.i < B.i ? [A, B] : [B, A]);
        }
      }
      hits.sort((a, b) => a[0].i - b[0].i || a[1].i - b[1].i);
      for (const [A, B] of hits.slice(0, 12)) {
        const node = B.p.src[B.p.src.length - 1] || this.decl;
        this.warn(`pads ${A.p.name} and ${B.p.name} overlap — intentional only if they share a net`, node);
        A.p.overlap = B.p.overlap = true;
      }
      // unused group / sanity
      if (!this.pads.size && !this.holes.size && !this.errorCount && !this.broken.size) this.warn(`footprint "${this.name}" has no pads`, { s: this.decl.nameS, e: this.decl.nameE });
    }

    // ---------------------------------------------------------- output
    output() {
      const unplacedObj = new Set();
      for (const u of this.unplaced) { const o = this.units[u].obj; if (o) unplacedObj.add(o); if (this.units[u].kind === 'row') this.units[u].obj.members.forEach((m) => unplacedObj.add(m)); }
      const ranges = (nodes) => uniqRanges(nodes.filter(Boolean).map((n) => ({ s: n.s, e: n.e })));
      // placements in effect also "belong" to the objects they move
      const placedBy = new Map();
      for (const c of this.chosen.values()) {
        if (c.strength !== 'strong' || !c.node || c.node === this.decl) continue;
        if (!placedBy.has(c.unit)) placedBy.set(c.unit, []);
        placedBy.get(c.unit).push(c.node);
      }
      const more = (o) => (o.unit && placedBy.get(o.unit.id)) || [];
      const defOf = (p) => {
        const n = (p.explicit && p.explicit.node) || p.src.find((x) => x.type === 'Thermal' || x.type === 'Hole')
          || (p.mirror && p.mirror.node) || p.src.find((x) => x.type === 'Row') || more(p)[0] || p.src[0];
        return n ? { s: n.s, e: n.e } : null;
      };
      const pads = [...this.pads.values()].map((p) => ({
        kind: 'pad', name: p.name, x: p.x, y: p.y, rot: p.rot, spec: p.spec, shape: p.spec.shape, tht: p.spec.tht, drill: p.spec.drill,
        land: p.land, copper: p.copper, mask: p.maskOpen, paste: p.paste, drillShape: p.drillShape, vias: p.viaList,
        bbox: { x0: p.x + p.bb.x.lo, x1: p.x + p.bb.x.hi, y0: p.y + p.bb.y.lo, y1: p.y + p.bb.y.hi },
        generated: !!p.generated, thermal: !!p.thermal, side: p.gen ? p.gen.side : null, ipc: !!p.spec.ipc && !p.explicit,
        unplaced: unplacedObj.has(p) || (p.unit && unplacedObj.has(p.unit.obj)), overlap: !!p.overlap, missing: !!p.spec.missing,
        src: ranges(p.src.concat(more(p))), def: defOf(p), row: p.unit && p.unit.kind === 'row' ? p.unit.obj.name : null,
      }));
      const holes = [...this.holes.values()].map((h) => ({
        kind: 'hole', name: h.name, x: h.x, y: h.y, rot: 0, shape: h.shape, land: h.land, mask: h.maskOpen,
        bbox: { x0: h.x + h.bb.x.lo, x1: h.x + h.bb.x.hi, y0: h.y + h.bb.y.lo, y1: h.y + h.bb.y.hi },
        unplaced: unplacedObj.has(h), src: ranges(h.src.concat(more(h))), def: defOf(h),
      }));
      // dimension overlays for each placement in effect
      const P = (inf, axis, which) => {
        const vals = this.V[axis];
        return this.anchor(inf, axis, which).f(vals) - this.O[axis];
      };
      const span = (inf, axis) => [P(inf, axis, 'lo'), P(inf, axis, 'hi')];
      const dims = [];
      for (const c of this.chosen.values()) {
        if (c.strength !== 'strong' || !c.viz) continue;
        const v = c.viz;
        try {
          const node = c.clause || c.node;
          const base = { s: node.s, e: node.e, stmtS: c.node.s, stmtE: c.node.e, label: c.label };
          if (v.kind === 'dim') {
            dims.push(Object.assign(base, {
              kind: 'dim', axis: v.axis, a: P(v.ri, v.axis, v.rw), b: P(v.ti, v.axis, v.tw),
              ra: span(v.ri, OTHER[v.axis]), ta: span(v.ti, OTHER[v.axis]), text: v.text, value: v.d, plain: v.plain,
              rbox: boxOfInf(v.ri, P), tbox: boxOfInf(v.ti, P),
            }));
          } else if (v.kind === 'measure') {
            const ia = v.word === 'pitch' ? ['center', 'center'] : null;
            const pa = P(v.ai, v.axis, 'center'), pb = P(v.bi, v.axis, 'center');
            const [lo, hi] = pa <= pb ? [v.ai, v.bi] : [v.bi, v.ai];
            const a = ia ? P(lo, v.axis, 'center') : v.word === 'gap' ? P(lo, v.axis, 'hi') : P(lo, v.axis, 'lo');
            const b = ia ? P(hi, v.axis, 'center') : v.word === 'gap' ? P(hi, v.axis, 'lo') : P(hi, v.axis, 'hi');
            dims.push(Object.assign(base, {
              kind: 'dim', axis: v.axis, a, b, ra: span(lo, OTHER[v.axis]), ta: span(hi, OTHER[v.axis]),
              text: `${v.word} ${v.text}`, value: v.d, plain: v.plain, rbox: boxOfInf(lo, P), tbox: boxOfInf(hi, P),
            }));
          } else if (v.kind === 'between') {
            dims.push(Object.assign(base, { kind: 'between', axis: v.axis, a: [P(v.ai, 'x', 'center'), P(v.ai, 'y', 'center')], b: [P(v.bi, 'x', 'center'), P(v.bi, 'y', 'center')], t: [P(v.ti, 'x', 'center'), P(v.ti, 'y', 'center')], tbox: boxOfInf(v.ti, P) }));
          } else if (v.kind === 'on') {
            dims.push(Object.assign(base, { kind: 'on', axis: v.axis, o: [P(v.oi, 'x', 'center'), P(v.oi, 'y', 'center')], t: [P(v.ti, 'x', 'center'), P(v.ti, 'y', 'center')], obox: boxOfInf(v.oi, P), tbox: boxOfInf(v.ti, P) }));
          } else if (v.kind === 'align') {
            dims.push(Object.assign(base, { kind: 'align', axis: v.axis, a: [P(v.ti, 'x', 'center'), P(v.ti, 'y', 'center')], b: [P(v.bi, 'x', 'center'), P(v.bi, 'y', 'center')], tbox: boxOfInf(v.ti, P), bbox: boxOfInf(v.bi, P) }));
          } else if (v.kind === 'mirror') {
            const line = -this.O[v.axis];
            dims.push(Object.assign(base, { kind: 'mirror', axis: v.axis, line, p: [P(v.pi, 'x', 'center'), P(v.pi, 'y', 'center')], t: [P(v.ti, 'x', 'center'), P(v.ti, 'y', 'center')], pbox: boxOfInf(v.pi, P), tbox: boxOfInf(v.ti, P) }));
          } else if (v.kind === 'at') {
            if (c.axis !== 'x') continue;
            dims.push(Object.assign(base, { kind: 'at', point: [v.point.x - this.O.x, v.point.y - this.O.y], tbox: boxOfInf(v.ti, P) }));
          }
        } catch (e) { /* overlay is best-effort */ }
      }
      const b = this.body;
      const bodyOut = b ? {
        kind: b.kind, w: b.w, l: b.l, h: b.h, x: b.x, y: b.y,
        outline: this.bodyOutline(0, null), src: ranges([b.node].concat(this.cons.filter((c) => this.bodyUnit && c.unit === this.bodyUnit.id && c.strength === 'strong').map((c) => c.node))),
      } : null;
      const meta = {};
      for (const k of Object.keys(this.st.meta)) meta[k] = this.st.meta[k].value;
      // extents of pads, holes and body: cheap, and enough for a thumbnail
      let core = G.emptyBox();
      for (const o of [...pads, ...holes]) core = G.unionBox(core, o.bbox);
      if (b) for (const p of bodyOut.outline) G.addPt(core, p);
      if (!G.boxValid(core)) core = { x0: -1, y0: -1, x1: 1, y1: 1 };
      const model = this.modelInfo();
      const res = {
        name: this.name, meta, density: this.density, pads, holes, body: bodyOut, coreBox: core,
        extraTexts: this.L.texts, dims, origin: { x: 0, y: 0 }, originShift: this.O,
        pin1: this.pin1 ? { x: this.pin1.x, y: this.pin1.y, style: this.pin1Style } : null,
        generator: this.gen ? {
          kind: this.gen.kind, count: this.gen.positions.length, omitted: (this.gen.omitted || []).map((p) => p.name),
          spacing: Object.fromEntries(Object.entries(this.gen.spacing || {}).map(([k, v]) => [k, { C: v.C, how: v.how }])),
          src: ranges([this.gen.node]),
        } : null,
        ipcNote: this.ipcNote || null,
        floating: this.floatingAxes, originNote: this.originNote, model, extends: this.decl.mode === 'extends' ? this.decl.parentName : null,
        template: this.decl.mode === 'from' ? this.decl.template.name : null,
      };
      // silk, assembly and courtyard are computed on first access (see finishLayers)
      let full = null;
      const finish = () => {
        if (full) return full;
        this.finishLayers();
        let bb = { x0: core.x0, y0: core.y0, x1: core.x1, y1: core.y1 };
        for (const layer of ['silk', 'courtyard', 'assembly']) {
          for (const it of this.L[layer]) {
            if (it.pts) it.pts.forEach((p) => G.addPt(bb, p));
            if (it.c) { G.addPt(bb, [it.c[0] - it.r, it.c[1] - it.r]); G.addPt(bb, [it.c[0] + it.r, it.c[1] + it.r]); }
            if (it.at) G.addPt(bb, it.at);
          }
        }
        let cy = G.emptyBox();
        for (const it of this.L.courtyard) if (it.pts) it.pts.forEach((p) => G.addPt(cy, p));
        full = { bbox: bb, courtyardBox: G.boxValid(cy) ? cy : null, courtyardClearance: this.courtyardClearance };
        return full;
      };
      const lazy = (get) => ({ get, enumerable: true });
      Object.defineProperties(res, {
        silk: lazy(() => { finish(); return this.L.silk; }),
        assembly: lazy(() => { finish(); return this.L.assembly; }),
        courtyard: lazy(() => { finish(); return this.L.courtyard; }),
        bbox: lazy(() => finish().bbox),
        courtyardBox: lazy(() => finish().courtyardBox),
        courtyardClearance: lazy(() => finish().courtyardClearance),
      });
      return res;
    }

    modelInfo() {
      const m = this.st.model;
      if (m && m.s.none) return { none: true };
      const info = { none: false, props: {} };
      if (m) {
        for (const p of m.s.props) {
          this.guard(p, () => {
            if (p.key === 'standoff' || p.key === 'height') info.props[p.key] = this.len(p.x, m.s);
            else if (p.key === 'bodyColor' || p.key === 'leadsColor') info.props[p.key] = p.color;
            else if (p.key === 'pin1') info.props.pin1 = p.v;
            else if (p.key === 'step') info.props.step = p.file;
          });
        }
      }
      info.generated = !!(this.body && !info.props.step);
      return info;
    }
  }

  // ===================================================================== helpers

  const ZERO_BB = { x: { lo: 0, hi: 0 }, y: { lo: 0, hi: 0 } };

  function bbOf(shape, rotDeg) {
    const bb = G.contourBBox(G.transformContour(G.shapeContour(shape, 0), rad(rotDeg || 0), 0, 0));
    if (!G.boxValid(bb)) return { x: { lo: 0, hi: 0 }, y: { lo: 0, hi: 0 } };
    return { x: { lo: bb.x0, hi: bb.x1 }, y: { lo: bb.y0, hi: bb.y1 } };
  }
  function bbOfBody(b) { return { x: { lo: -b.w / 2, hi: b.w / 2 }, y: { lo: -b.l / 2, hi: b.l / 2 } }; }
  function boxOfInf(inf, P) {
    return { x0: P(inf, 'x', 'lo'), x1: P(inf, 'x', 'hi'), y0: P(inf, 'y', 'lo'), y1: P(inf, 'y', 'hi') };
  }

  function cloneSpec(s) {
    return {
      shape: Object.assign({}, s.shape, s.shape.pts ? { pts: s.shape.pts.map((p) => p.slice()) } : {}),
      tht: s.tht, drill: s.drill ? JSON.parse(JSON.stringify(s.drill)) : null, rot: s.rot || 0,
      mask: s.mask ? Object.assign({}, s.mask) : null, paste: s.paste ? Object.assign({}, s.paste) : null,
      vias: s.vias ? Object.assign({}, s.vias) : null, ipc: s.ipc, castellated: s.castellated, src: (s.src || []).slice(),
    };
  }

  function toOuter(span, T) {
    return span.qual === 'outer' ? span.v : span.qual === 'inner' ? span.v + 2 * T : span.v + T;
  }

  /** CCW-walk numbering for perimeter packages; returns position indices in pin order. */
  function walkOrder(pos, scheme, start, single) {
    const n = pos.length;
    if (!n) return [];
    const bb = G.emptyBox();
    pos.forEach((p) => G.addPt(bb, [p.x, p.y]));
    const corner = [start.endsWith('left') ? bb.x0 : bb.x1, start.startsWith('top') ? bb.y1 : bb.y0];
    let best = Infinity, cands = [];
    pos.forEach((p, i) => {
      const d = Math.hypot(p.x - corner[0], p.y - corner[1]);
      if (d < best - 1e-9) { best = d; cands = [i]; } else if (Math.abs(d - best) <= 1e-9) cands.push(i);
    });
    const ccwFirst = { 'top-left': 'left', 'bottom-left': 'bottom', 'bottom-right': 'right', 'top-right': 'top' };
    const cwFirst = { 'top-left': 'top', 'top-right': 'right', 'bottom-right': 'bottom', 'bottom-left': 'left' };
    const pref = (scheme === 'cw' ? cwFirst : ccwFirst)[start];
    let i0 = cands.find((i) => pos[i].side === pref);
    if (i0 === undefined) i0 = cands.length ? cands[0] : 0;
    if (single) {
      // one row: number away from pin 1, no wrap-around
      const others = pos.map((p, i) => i).filter((i) => i !== i0);
      others.sort((a, b) => Math.hypot(pos[a].x - pos[i0].x, pos[a].y - pos[i0].y) - Math.hypot(pos[b].x - pos[i0].x, pos[b].y - pos[i0].y));
      return [i0].concat(others);
    }
    const dir = scheme === 'cw' ? -1 : 1;
    return Array.from({ length: n }, (_, k) => ((i0 + dir * k) % n + n) % n);
  }

  /** Grid numbering (zigzag / row-major / col-major / bga), reoriented by the start corner. */
  function numberGrid(cols, rows, scheme, start, px, py) {
    const leftToRight = start.endsWith('left');
    const topToBottom = start.startsWith('top');
    const ci = (c) => (leftToRight ? c : cols - 1 - c);
    const ri = (r) => (topToBottom ? r : rows - 1 - r);
    let sch = scheme;
    if (sch === 'zigzag') {
      // 1-2 across the short direction, then advance
      const acrossRows = rows < cols || (rows === cols && (py || 0) <= (px || 0));
      sch = acrossRows ? 'col-major' : 'row-major';
    }
    const order = (c, r) => (sch === 'col-major' ? ci(c) * rows + ri(r) : ri(r) * cols + ci(c));
    return {
      name: (c, r) => (scheme === 'bga' ? jedecRow(ri(r)) + (ci(c) + 1) : String(order(c, r) + 1)),
      order,
      rowKey: (r) => (scheme === 'bga' ? jedecRow(ri(r)) : String(ri(r) + 1)),
      colKey: (c) => String(ci(c) + 1),
      rowIndex: ri,
      colIndex: ci,
    };
  }

  function jedecRow(i) {
    const n = JEDEC_ROWS.length;
    if (i < n) return JEDEC_ROWS[i];
    const k = i - n;
    return JEDEC_ROWS[Math.floor(k / n) % n] + JEDEC_ROWS[k % n];
  }
  function jedecIndex(s) {
    if (s.length === 1) return JEDEC_ROWS.indexOf(s);
    return JEDEC_ROWS.length + JEDEC_ROWS.indexOf(s[0]) * JEDEC_ROWS.length + JEDEC_ROWS.indexOf(s[1]);
  }

  function expandRange(a, b, node) {
    const A = a.name, B = b.name;
    if (/^\d+$/.test(A) && /^\d+$/.test(B)) return seq(parseInt(A, 10), parseInt(B, 10)).map(String);
    const ma = /^([A-Za-z_]+)(\d+)$/.exec(A), mb = /^([A-Za-z_]+)(\d+)$/.exec(B);
    if (ma && mb && ma[1] === mb[1]) return seq(parseInt(ma[2], 10), parseInt(mb[2], 10)).map((n) => ma[1] + n);
    if (/^[A-Z]$/.test(A) && /^[A-Z]$/.test(B)) return seq(A.charCodeAt(0), B.charCodeAt(0)).map((c) => String.fromCharCode(c));
    throw new StompError(`can't expand the range ${A}..${B} — ranges run between numbers (1..4) or names with the same prefix (A1..A8)`, node);
  }
  function seq(a, b) {
    const out = [];
    const st = a <= b ? 1 : -1;
    for (let i = a; st > 0 ? i <= b : i >= b; i += st) out.push(i);
    if (out.length > 10000) throw new StompError('range too large', null);
    return out;
  }

  function uniqRanges(list) {
    const seen = new Set();
    return list.filter((r) => { const k = r.s + ':' + r.e; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function exprText(src, x) { return src && x ? src.slice(x.s, x.e) : ''; }
  function quoteName(n) { return /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(n) ? n : `"${n}"`; }
  function rad(d) { return (d * Math.PI) / 180; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function ceilTo(v, q) { return Math.ceil(v / q - 1e-6) * q; }
  function floorTo(v, q) { return Math.floor(v / q + 1e-6) * q; }
  function fmtMM(v) { return `${+v.toFixed(4)} mm`; }
  function minDistToPoly(p, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
    }
    return best;
  }

  return { compile, clearCache: () => CACHE.clear(), UNIT_MM, IPC, D, jedecRow, expandRange, formatNumber };
});
