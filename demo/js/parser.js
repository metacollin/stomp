/* stomp: the parser.
 *
 * Recursive descent over the tokens, following grammar.peg rule by rule (choices
 * are tried in the grammar's order). Every node has its source range { s, e }
 * (character offsets), and statements also record the file's `units` setting.
 *
 * A block is a header line, its statements, then `end`. Errors are recovered one
 * statement at a time: a bad statement is reported and skipped to the end of its
 * line, so one typo doesn't hide the rest of the footprint. A block that runs into
 * something it can't hold (a `footprint` line, a feature declaration at the left
 * margin, a footprint statement after a `model` line) is taken to be missing its
 * `end`.
 *
 * Keywords are contextual: a word means something only where the grammar expects
 * it, so a name can be any word but `x` and `end`. A word followed by `:` names the
 * value after it (`pitch: 1.27`), and `NAME = value` at the start of a statement
 * gives a name a value.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).parser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ParseError extends Error {
    constructor(message, s, e) { super(message); this.s = s; this.e = e; }
  }

  // the only words that are never names: the size separator and the end of a block
  const HARD = new Set(['x', 'end']);
  const SHAPES = new Set(['rect', 'oval', 'roundrect', 'dshape', 'circle', 'polygon']);
  const KINDS = new Set(['pad', 'hole', 'row', 'group', 'ball']);
  const SIDE_WORDS = new Set(['left', 'right', 'top', 'bottom']);
  const ANCHORS = new Set(['center', 'inner', 'outer', 'left', 'right', 'top', 'bottom']);
  const UNITS = new Set(['mm', 'um', 'nm', 'mil', 'in']);
  const LEAD_FORMS = new Set(['gullwing', 'jlead', 'lbend', 'straight', 'flat', 'endcap', 'ball', 'column', 'pin', 'wire', 'tab', 'castellated']);
  const ARRANGEMENTS = new Set(['dual', 'quad', 'horizontal', 'vertical']);
  const SCHEMES = new Set(['ccw', 'cw', 'zigzag', 'row-major', 'col-major', 'bga']);
  const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  // pad properties: after a pad's shape, or on their own to change a pad
  const PAD_PROPS = new Set(['drill', 'rotate', 'mask', 'paste', 'vias']);
  const PAD_KEYS = new Set(['shape', 'size', 'width', 'length', 'drill', 'rotate', 'mask', 'paste', 'vias']);
  // the 3D solids (SPEC 13.3) and the 2D graphics
  const SOLIDS = new Set(['box', 'cylinder', 'sphere', 'disc', 'prism', 'face', 'loft', 'sweep', 'wire', 'slab']);
  const GFX = new Set(['outline', 'line', 'arc', 'circle', 'rect', 'polygon', 'hatch', 'text']);
  const FILLED = new Set(['circle', 'rect', 'polygon']);
  const CLEARED = new Set(['outline', 'line', 'arc', 'rect', 'polygon', 'hatch']);

  // words that begin a footprint statement (for recovery and hints)
  const STMT_WORDS = [
    'description', 'datasheet', 'manufacturer', 'mpn', 'refdes', 'tags', 'origin', 'body', 'pins',
    'balls', 'lead', 'thermal', 'span', 'gap', 'pitch', 'density', 'omit', 'only', 'pin1', 'polarized',
    'default', 'pad', 'pads', 'hole', 'delete', 'row', 'group', 'align', 'silk', 'courtyard', 'assembly',
    'text', 'model', 'no', 'name', 'footprint', 'footprints', 'template', 'units', 'feature',
    'outline', 'line', 'arc', 'circle', 'rect', 'polygon', 'hatch'];
  const STMT_SET = new Set(STMT_WORDS);
  // statements that name a value with a colon (`pin1: dot`); the rest read as a sentence
  const KEY_STMTS = new Set(['units', 'description', 'datasheet', 'manufacturer', 'mpn', 'refdes', 'tags', 'name', 'density', 'pin1', 'silk', 'assembly', 'courtyard']);
  const MEASURES = new Set(['span', 'gap', 'pitch']);
  // what a model block holds
  const MODEL_WORDS = new Set(['standoff', 'height', 'draft', 'body', 'leads', 'pin1', 'step', 'feature', ...SOLIDS]);
  // every word that takes a colon somewhere, for "did you mean" hints
  const KEYS = [
    'units', 'description', 'datasheet', 'manufacturer', 'mpn', 'refdes', 'tags', 'name', 'density', 'pin1',
    'silk', 'assembly', 'courtyard', 'span', 'gap', 'pitch', 'numbering', 'start', 'pad', 'flat', 'drill',
    'rotate', 'mask', 'paste', 'vias', 'gutter', 'coverage', 'size', 'width', 'length', 'shape', 'offset',
    'layer', 'standoff', 'height', 'draft', 'color', 'thickness', 'below', 'above', 'step', 'scale', 'kind',
    'segments', 'fillet', 'going'];

  function describe(k) {
    switch (k.t) {
      case 'nl': return 'end of line';
      case 'eof': return 'end of file';
      case 'str': return k.parts ? 'a string' : `"${k.v}"`;
      case 'num': return `\`${k.text}\``;
      default: return `\`${k.v}\``;
    }
  }
  const hardName = (v) => (v === 'x' ? '`x` separates the sides of a size, so it can\'t be a name' : '`end` closes a block, so it can\'t be a name');

  function parse(tokens, diags) {
    return new Parser(tokens, diags).file();
  }

  class Parser {
    constructor(tokens, diags) {
      this.t = tokens;
      this.i = 0;
      this.diags = diags;
      this.unit = 'mm';
      this.marks = null;     // where a `w`/`h` side mark may appear: 'size', or a reason it can't
      this.softEnd = false;  // a block stopped short of its `end`: the statement holding it is over
      this.dedent = null;    // the first `end` left of its own block's header, for missing-`end` messages
      this.lastFrom = null;  // the `footprint … from …` line just above, if it has no `with` block
    }

    // Token cursor
    get cur() { return this.t[this.i]; }
    peek(k) { return this.t[Math.min(this.i + (k || 0), this.t.length - 1)]; }
    advance() { const k = this.t[this.i]; if (k.t !== 'eof') this.i++; return k; }
    prevEnd() { return this.i > 0 ? this.t[this.i - 1].e : 0; }
    isWord(v, k) { const x = this.peek(k); return x.t === 'word' && x.v === v; }
    isP(v, k) { const x = this.peek(k); return x.t === 'p' && x.v === v; }
    /** `v:` at offset k. */
    isKey(v, k) { return this.isWord(v, k) && this.isP(':', (k || 0) + 1); }
    acceptP(v) { return this.isP(v) ? this.advance() : null; }
    expectP(v, what) {
      if (this.isP(v)) return this.advance();
      return this.expected(`\`${v}\`${what ? ' ' + what : ''}`);
    }
    /** A plain word such as `at`, `from` or `fill`. It takes no colon. */
    acceptWord(v) {
      if (!this.isWord(v)) return null;
      if (this.isP(':', 1)) this.failAt(`\`${v}\` takes no colon`, this.peek(1));
      return this.advance();
    }
    expectWord(v, what) {
      return this.acceptWord(v) || this.expected(`\`${v}\`${what ? ' ' + what : ''}`);
    }
    /** `v: …`: the word and its colon, or null. `v` with a value after it but no
     *  colon is reported. */
    acceptKey(v) {
      if (!this.isWord(v)) return null;
      if (this.isP(':', 1)) { const k = this.advance(); this.advance(); return k; }
      if (this.valueAt(1)) this.missingColon();
      return null;
    }
    expectKey(v, what) {
      if (this.isWord(v) && !this.isP(':', 1)) this.missingColon();
      return this.acceptKey(v) || this.expected(`\`${v}:\`${what ? ' ' + what : ''}`);
    }
    /** Could the token at offset k be a value (so a word before it is missing its colon)? */
    valueAt(k) {
      const x = this.peek(k);
      if (x.t === 'num' || x.t === 'str') return true;
      if (x.t === 'word') return !HARD.has(x.v);
      return x.t === 'p' && (x.v === '(' || x.v === '-' || x.v === '+');
    }
    missingColon() {
      const k = this.cur, nx = this.peek(1);
      let v = '…';
      if (nx.t === 'num') v = nx.text;
      else if (nx.t === 'word') v = nx.v;
      else if (nx.t === 'str') v = '"…"';
      else if (nx.t === 'p' && nx.v === '(') v = '(…)';
      else if (nx.t === 'p' && this.peek(2).t === 'num') v = nx.v + this.peek(2).text;
      this.failAt(`\`${k.v}\` needs a colon: \`${k.v}: ${v}\``, k);
    }
    expected(what, tok) {
      const k = tok || this.cur;
      if ((k.t === 'nl' || k.t === 'eof') && this.i > 0) {
        const prev = this.t[this.i - 1];
        throw new ParseError(`expected ${what} after ${describe(prev)}`, prev.s, prev.e);
      }
      throw new ParseError(`expected ${what}, found ${describe(k)}`, k.s, Math.max(k.e, k.s + 1));
    }
    failAt(msg, tok) {
      const k = tok || this.cur;
      throw new ParseError(msg, k.s, Math.max(k.e, k.s + 1));
    }
    report(err) { this.diags.push({ severity: 'error', message: err.message, s: err.s, e: err.e, syntax: true }); }
    note(msg, s, e) { this.diags.push({ severity: 'error', message: msg, s, e, syntax: true }); }
    /** Run fn with `w`/`h` side marks allowed ('size') or refused for a reason. */
    withMarks(ctx, fn) {
      const outer = this.marks;
      this.marks = ctx;
      try { return fn(); } finally { this.marks = outer; }
    }

    atStmtEnd(k) {
      const x = this.peek(k);
      return x.t === 'nl' || x.t === 'eof' || (x.t === 'p' && x.v === ';') || (x.t === 'word' && x.v === 'end');
    }
    skipEOS() { while (this.cur.t === 'nl' || this.isP(';')) this.advance(); }
    endStmt() {
      if (this.softEnd) { this.softEnd = false; return; }   // a block in it stopped short of its `end`
      if (this.atStmtEnd()) return;
      const k = this.cur;
      if (k.t === 'word' && this.isP(':', 1)) {
        const hint = k.v.length > 2 ? suggest(k.v, KEYS) : null;
        this.failAt(`\`${k.v}:\` isn't an option here${hint && hint !== k.v ? ` — did you mean \`${hint}:\`?` : ''}`, k);
      }
      this.failAt(`unexpected ${describe(k)} — expected the end of the statement`);
    }
    /** Skip to the end of the current statement. */
    sync() { while (!this.atStmtEnd()) this.advance(); }

    /** `NAME = …` at the start of a statement. */
    isDecl() {
      const k = this.cur;
      if (k.t !== 'word' || !this.isP('=', 1)) return false;
      if (HARD.has(k.v)) this.failAt(hardName(k.v));
      return true;
    }
    /** `NAME = expr`: a declaration ('Let') or, in a section, a new value ('Set'). */
    decl(type) {
      const k = this.advance();
      this.advance();
      const x = this.expr();
      return { type, name: k.v, nameS: k.s, nameE: k.e, x };
    }
    /** `let NAME = …`, from before names were declared by `=` alone. */
    oldLet(type) {
      const l = this.advance();
      const k = this.cur;
      if (k.t === 'word' && !HARD.has(k.v) && this.isP('=', 1)) {
        this.note(`there's no \`let\`: write \`${k.v} = …\``, l.s, l.e);
        return this.decl(type);
      }
      return this.failAt('there\'s no `let`: write `NAME = value`', l);
    }

    /**
     * A block's statements, from the end of its header line to its `end`. `head` is
     * the header's first token, and `what` names the block in messages. Options:
     *   units  a footprint or template body, which can start with `units:` (it lasts to the `end`)
     *   stops  true for a statement the block can't hold, so its `end` must be missing
     */
    block(head, what, parseStmt, o) {
      const outerUnit = this.unit;
      try { return this.blockBody(head, what, parseStmt, o || {}); } finally { this.unit = outerUnit; }
    }
    blockBody(head, what, parseStmt, o) {
      const headE = this.prevEnd();
      if (!this.atStmtEnd()) {
        this.note(`unexpected ${describe(this.cur)} — the ${what}'s statements go on the lines below`, this.cur.s, Math.max(this.cur.e, this.cur.s + 1));
        this.sync();
      }
      const stmts = [];
      this.skipEOS();
      while (!this.isWord('end')) {
        const k = this.cur;
        if (k.t === 'eof' || this.startsTopItem() || (o.stops && o.stops())) {
          this.missingEnd(head, headE, what, k);
          this.softEnd = true;
          return { stmts, close: null };
        }
        const start = this.i;
        const outerTarget = this.stmtTarget;
        this.stmtTarget = null;
        try {
          const st = o.units && this.isWord('units') && !this.isP('=', 1) ? this.blockUnits(stmts.length) : parseStmt();
          if (st) {
            if (st.unit === undefined) st.unit = this.unit;   // inner statements use the file units too
            stmts.push(st);                                  // kept even if junk follows it
          }
          this.stmtTarget = null;
          this.endStmt();
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          this.report(err);
          // remember what the broken statement was about, so the evaluator
          // doesn't pile follow-on errors (unplaced / unknown) onto it
          if (this.stmtTarget) stmts.push({ type: 'Broken', target: this.stmtTarget, s: err.s, e: err.e });
          this.sync();
          if (this.i === start) this.advance();
        }
        this.stmtTarget = outerTarget;
        this.skipEOS();
      }
      const close = this.advance();
      if (close.col < head.col && !this.dedent) this.dedent = { head, headE, what, close };
      return { stmts, close };
    }

    /** A block ran out: report its missing `end` at its header. If a block inside it
     *  was closed by an `end` lined up with this one, that block is the culprit. */
    missingEnd(head, headE, what, at) {
      const d = this.dedent;
      if (d && d.head.s > head.s && d.close.col <= head.col) {
        this.dedent = null;
        this.note(`missing \`end\` for this ${d.what} (the \`end\` on line ${d.close.line} lines up with the ${what} on line ${head.line})`, d.head.s, d.headE);
        return;
      }
      this.note(`missing \`end\` for this ${what}${at.t === 'eof' ? '' : ` before line ${at.line}`}`, head.s, headE);
    }

    /** Does a top-level item start here (so an open block is missing its `end`)? */
    startsTopItem() {
      const k = this.cur;
      if (k.t !== 'word' || this.isP('=', 1) || this.isP(':', 1)) return false;
      if (k.v === 'footprint' || k.v === 'footprints' || k.v === 'template') return true;
      // `feature NAME (…)` ending its line at the left margin declares a feature;
      // indented, it's a placement missing its `at`
      return k.v === 'feature' && k.col === 1 && this.featureDeclAhead();
    }
    /** `feature NAME [(…)]` and then the end of the line. */
    featureDeclAhead() {
      let j = this.i + 1;
      if (!this.t[j] || this.t[j].t !== 'word') return false;
      j++;
      if (this.t[j] && this.t[j].t === 'p' && this.t[j].v === '(') j = this.matchParen(j);
      const q = this.t[j];
      return !q || q.t === 'nl' || q.t === 'eof' || (q.t === 'p' && q.v === ';');
    }
    /** The index just past the `)` that closes the `(` at index j (or the line's end). */
    matchParen(j) {
      let depth = 0;
      for (; j < this.t.length; j++) {
        const q = this.t[j];
        if (q.t === 'eof' || q.t === 'nl') return j;
        if (q.t === 'p' && q.v === '(') depth++;
        else if (q.t === 'p' && q.v === ')' && --depth === 0) return j + 1;
      }
      return j;
    }
    /** Is the `(` at offset k a point or tuple (a comma at its own level) rather than
     *  a parenthesized expression? */
    parenHasComma(k) {
      let depth = 0;
      for (let j = this.i + (k || 0); j < this.t.length; j++) {
        const q = this.t[j];
        if (q.t === 'eof' || q.t === 'nl') return false;
        if (q.t !== 'p') continue;
        if (q.v === '(') depth++;
        else if (q.v === ')') { if (--depth === 0) return false; }
        else if (q.v === ',' && depth === 1) return true;
      }
      return false;
    }

    /** `units: mil` at the top of a footprint or template body. */
    blockUnits(before) {
      const k = this.expectKey('units');
      if (before) throw new ParseError('`units:` goes first in a footprint or template, before the statements it applies to', k.s, k.e);
      this.unit = this.unitWord();
      return null;
    }
    /** The word after `units:`. */
    unitWord() {
      const u = this.cur;
      if (u.t === 'word' && UNITS.has(u.v)) return this.advance().v;
      if (u.t === 'word' && u.v === 'mils') this.failAt('write mils as `mil`');
      if (u.t === 'word' && /^inch(es)?$/.test(u.v)) this.failAt('write inches as `in`');
      return this.expected('a unit: mm, um, nm, mil or in');
    }

    // File
    file() {
      const items = [];
      this.skipEOS();
      while (this.cur.t !== 'eof') {
        const start = this.i;
        try {
          if (this.isWord('end')) this.failAt('this `end` has no block to close');
          const it = this.topStmt();
          if (it) items.push(it);          // kept even if junk follows it
          this.endStmt();
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          this.report(err);
          this.sync();
          if (this.i === start) this.advance();
        }
        this.dedent = null;
        this.skipEOS();
      }
      return { type: 'File', items };
    }

    topStmt() {
      const k = this.cur;
      const s = k.s;
      const from = this.lastFrom;
      this.lastFrom = null;
      let node;
      if (this.isDecl()) node = this.decl('Let');
      else if (this.isWord('let')) node = this.oldLet('Let');
      else if (this.isWord('units')) {
        this.expectKey('units');
        this.unit = this.unitWord();
        node = { type: 'Units', unit: this.unit };
      } else if (this.isWord('template')) node = this.template();
      else if (this.isWord('feature')) node = this.featureDecl();
      else if (this.isWord('footprint')) node = this.footprint();
      else if (this.isWord('footprints')) node = this.table();
      else if (k.t === 'word' && STMT_SET.has(k.v)) {
        this.failAt(from
          ? `\`${k.v}\` goes in a footprint: to add statements to the \`footprint … from …\` above, end its line with \`with\` and close them with \`end\``
          : `\`${k.v}\` goes in a footprint (\`footprint "NAME"\`, its statements, then \`end\`)`);
      } else {
        this.expected('`footprint`, `footprints`, `template`, `feature`, `units:` or `NAME = value`');
      }
      if (!node) return null;
      node.s = s; node.e = this.prevEnd(); node.unit = node.unit && node.type === 'Units' ? node.unit : this.unit;
      return node;
    }

    /** A top-level item whose header line is broken: report it, then read its block
     *  anyway (its problems unreported), so its statements aren't taken for
     *  top-level ones. */
    skipBlock(err, head, what, parseStmt) {
      this.report(err);
      this.sync();
      const n = this.diags.length;
      this.block(head, what, parseStmt);
      this.diags.length = n;
      this.softEnd = true;
      return null;
    }
    /** Does this `footprint` line open a block? Unless it's a `from` line without `with`. */
    lineOpensBlock() {
      let from = false, last = null;
      for (let j = this.i; j < this.t.length; j++) {
        const q = this.t[j];
        if (q.t === 'nl' || q.t === 'eof' || (q.t === 'p' && q.v === ';')) break;
        if (q.t === 'word' && q.v === 'from') from = true;
        last = q;
      }
      return !from || !!(last && last.t === 'word' && last.v === 'with');
    }

    /** A name for a template or feature (or a template named in a call): any word but `x` and `end`. */
    declName(what) {
      const k = this.cur;
      if (k.t !== 'word') this.expected(what);
      if (HARD.has(k.v)) this.failAt(hardName(k.v));
      return this.advance();
    }

    template() {
      const head = this.expectWord('template');
      let name, params;
      try {
        name = this.declName('a template name');
        params = this.paramList('template');
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        return this.skipBlock(err, head, '`template`', () => this.statement());
      }
      const blk = this.block(head, '`template`', () => this.statement(), { units: true });
      return { type: 'Template', name: name.v, nameS: name.s, nameE: name.e, params, body: blk.stmts };
    }

    /** `( name, name = default, ... )` for a template or feature. */
    paramList(what) {
      this.expectP('(', 'to open the parameter list');
      const params = [];
      if (!this.isP(')')) {
        do {
          const p = this.cur;
          if (p.t !== 'word') this.expected(`a ${what} parameter name`);
          if (HARD.has(p.v)) this.failAt(hardName(p.v));
          this.advance();
          if (this.isP(':')) this.failAt(`a parameter's default takes \`=\`: \`${p.v} = …\``, this.cur);
          let def = null;
          if (this.acceptP('=')) def = this.expr();
          params.push({ name: p.v, def, s: p.s, e: this.prevEnd() });
        } while (this.acceptP(','));
      }
      this.expectP(')');
      return params;
    }

    /** `feature NAME [(params)]` and its items, then `end`: graphics and solids drawn
     *  around their own origin, placed by `pin1: NAME`, `feature NAME at …` or the 3D model. */
    featureDecl() {
      const head = this.expectWord('feature');
      let name, params;
      try {
        name = this.declName('a feature name');
        params = this.isP('(') ? this.paramList('feature') : [];
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        return this.skipBlock(err, head, '`feature`', () => this.featureItem(false));
      }
      if (this.isWord('at') || (this.isWord('on') && this.isWord('body', 1))) {
        this.failAt('a feature is placed in a footprint or in another feature; here, `feature NAME` defines one', head);
      }
      const blk = this.block(head, '`feature`', () => this.featureItem(false));
      return { type: 'Feature', name: name.v, nameS: name.s, nameE: name.e, params, body: blk.stmts };
    }

    /** One item of a feature, or of a section in it: `NAME = value`, `section`, a
     *  graphic, a solid, or `feature NAME at …`. */
    featureItem(inSection) {
      const k = this.cur;
      const s = k.s;
      let node;
      if (k.t === 'word' && this.isP(':', 1) && (GFX.has(k.v) || SOLIDS.has(k.v) || k.v === 'section' || k.v === 'feature')) {
        this.failAt(`\`${k.v}\` takes no colon`, this.peek(1));
      }
      if (this.isDecl()) node = this.decl(inSection ? 'Set' : 'Let');
      else if (this.isWord('let')) node = this.oldLet(inSection ? 'Set' : 'Let');
      else if (this.isWord('section')) {
        const head = this.advance();
        const names = [this.flagName()];
        for (;;) {
          if (this.acceptP(',')) names.push(this.flagName());
          else if (this.cur.t === 'word' && !this.atStmtEnd() && !HARD.has(this.cur.v)) {
            // `section a b`: reported, and read as `section a, b`, so the block still holds together
            const k = this.cur;
            this.note(`separate the flags with commas: \`section ${names[names.length - 1].name}, ${k.v}\``, k.s, k.e);
            names.push(this.flagName());
          } else break;
        }
        const blk = this.block(head, '`section`', () => this.featureItem(true));
        node = { type: 'Section', names, body: blk.stmts };
      } else if (this.isWord('feature')) node = this.featurePlace();
      else if (k.t === 'word' && GFX.has(k.v)) {
        const g = this.gfxStmt('feature');
        g.unit = this.unit;
        node = { type: 'FeatureLayer', layer: g.layer || 'silk', items: [g] };
      } else if (k.t === 'word' && SOLIDS.has(k.v)) {
        const q = this.solid(true);
        q.unit = this.unit;
        node = { type: 'FeatureModel', items: [q] };
      } else if (k.t === 'word' && (k.v === 'silk' || k.v === 'assembly' || k.v === 'model')) {
        this.failAt(`a feature's graphics and solids go straight in it, with no \`${k.v}\` block${k.v === 'model' ? '' : k.v === 'assembly' ? ': give a graphic `layer: assembly`' : ' (they go on the silk unless they say `layer: assembly`)'}`);
      } else if (this.isWord('units')) {
        this.failAt('`units:` goes at the top of the file, or first in a footprint or template');
      } else if (inSection) {
        this.expected('`NAME = value`, a graphic, a solid, `section` or `feature NAME at …`');
      } else {
        this.expected('a graphic (line, circle, …), a solid (box, cylinder, …), `NAME = value`, `section` or `feature NAME at …`');
      }
      node.s = s; node.e = this.prevEnd();
      return node;
    }

    /** A flag: any word but `x` and `end` (`section dot`, `section gullwing`). */
    flagName() {
      const k = this.cur;
      if (k.t !== 'word') this.expected('a flag name');
      if (HARD.has(k.v)) this.failAt(hardName(k.v));
      this.advance();
      return { name: k.v, s: k.s, e: k.e };
    }

    /** `NAME [(args)]`: the feature a statement places, or `body shape:` names. */
    featureCall() {
      const k = this.declName('the name of a feature');
      return { name: k.v, s: k.s, e: k.e, args: this.isP('(') ? this.callArgs() : [] };
    }

    /** `feature NAME [(args)] at (x, y[, z]) [rotate: R]` in a feature. */
    featurePlace() {
      this.expectWord('feature');
      const feature = this.featureCall();
      let at = null, rotate = null;
      for (;;) {
        const c = this.cur;
        if (this.acceptWord('at')) {
          if (at) this.failAt('`at` is given twice', c);
          if (!this.isP('(')) this.failAt('in a feature, place another feature at a point: `feature NAME at (x, y)`');
          at = this.point3opt();
        } else if (this.acceptKey('rotate')) {
          if (rotate) this.failAt('`rotate:` is given twice', c);
          rotate = this.rotation();
        } else if (this.isWord('on') && this.isWord('body', 1)) {
          this.failAt('`on body` works in a footprint; in a feature, give the height in `at (x, y, z)`');
        } else break;
      }
      if (!at) {
        if (this.atStmtEnd()) this.failAt(`give \`${feature.name}\` a place: \`feature ${feature.name}${feature.args.length ? '(…)' : ''} at (0, 0)\``, feature);
        this.expected('`at (x, y)` or `rotate:`');
      }
      return { type: 'FeaturePlace', feature, at, rotate };
    }

    /** `feature NAME [(args)] at POINT | OBJECT [rotate: R] [on body]` in a footprint:
     *  its graphics, and its solids in the 3D model. */
    featureUse() {
      this.expectWord('feature');
      const feature = this.featureCall();
      let at = null, rotate = null, onBody = false;
      for (;;) {
        const c = this.cur;
        if (this.acceptWord('at')) {
          if (at) this.failAt('`at` is given twice', c);
          at = this.isP('(') ? { point: this.point3opt() } : { ref: this.objref() };
        } else if (this.acceptKey('rotate')) {
          if (rotate) this.failAt('`rotate:` is given twice', c);
          rotate = this.rotation();
        } else if (this.isWord('on') && this.isWord('body', 1)) {
          if (onBody) this.failAt('`on body` is given twice', c);
          this.advance(); this.advance();
          onBody = true;
        } else break;
      }
      if (!at && !onBody) {
        if (this.atStmtEnd()) this.failAt(`give \`${feature.name}\` a place: \`at (x, y)\`, \`at pad 1\` or \`on body\``, feature);
        this.expected('`at`, `rotate:` or `on body`');
      }
      return { type: 'FeatureUse', feature, at, rotate, onBody };
    }

    footprint() {
      const head = this.expectWord('footprint');
      const opens = this.lineOpensBlock();
      const node = { type: 'Footprint', name: null, nameS: null, nameE: null, mode: 'block', body: null };
      try {
        // `footprint from qfn(...)` can leave the name to the template
        const name = this.isWord('from') ? null : this.name('a footprint name, or `from TEMPLATE(…)`');
        if (name) { node.name = name.name; node.nameS = name.s; node.nameE = name.e; }
        if (name && this.acceptWord('extends')) {
          node.mode = 'extends';
          node.parent = this.name('the parent footprint name');
        } else if (this.acceptWord('from')) {
          node.mode = 'from';
          const t = this.declName('a template name');
          node.template = { name: t.v, s: t.s, e: t.e };
          node.args = this.callArgs();
          node.callS = t.s;
          node.callE = this.prevEnd();
          if (!name) { node.nameS = t.s; node.nameE = node.callE; }
          if (!this.acceptWord('with')) {
            if (!this.atStmtEnd()) this.expected('the end of the line, or `with` and the statements to add');
            this.lastFrom = node;
            return node;
          }
        } else if (!this.atStmtEnd()) {
          // reported, and the block read anyway: the footprint still builds
          const k = this.cur;
          const hint = k.t === 'word' ? suggest(k.v, ['extends', 'from']) : null;
          this.note(`unexpected ${describe(k)} after the footprint name${hint ? ` — did you mean \`${hint}\`?` : ': the line ends there, or goes on with `extends NAME` or `from TEMPLATE(…)`'}`, k.s, Math.max(k.e, k.s + 1));
          this.sync();
        }
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        if (!opens) throw err;
        return this.skipBlock(err, head, '`footprint`', () => this.statement());
      }
      node.body = this.block(head, '`footprint`', () => this.statement(), { units: true }).stmts;
      return node;
    }

    /** `( arg, key: arg, ... )`. A lone word (`dot`, `bare`) is kept as a word: the
     *  compiler decides whether it's a flag of the feature called or a value. */
    callArgs() {
      this.expectP('(');
      const args = [];
      if (!this.isP(')')) {
        do {
          const s = this.cur.s;
          const k = this.cur;
          const word = k.t === 'word' && !HARD.has(k.v);
          if (word && this.isP(':', 1)) {
            this.advance(); this.advance();
            const x = this.expr();
            args.push({ key: k.v, x, s, e: this.prevEnd() });
            continue;
          }
          if (word && this.isP('=', 1)) this.failAt(`a named value takes a colon: \`${k.v}: …\``, this.peek(1));
          if (word && (this.isP(',', 1) || this.isP(')', 1))) {
            this.advance();
            args.push({ key: null, word: k.v, x: { type: 'id', name: k.v, s: k.s, e: k.e }, s, e: k.e });
            continue;
          }
          const x = this.expr();
          args.push({ key: null, x, s, e: this.prevEnd() });
        } while (this.acceptP(','));
      }
      this.expectP(')', 'to close the call');
      return args;
    }

    /**
     * footprints from TEMPLATE [(fixed args)]
     *   COLUMN COLUMN ...      header: template parameter names
     *   cell   cell   ...      one row per footprint
     * end
     */
    table() {
      const head = this.expectWord('footprints');
      const node = { type: 'Table', template: null, args: [], header: [], rows: [] };
      try {
        this.expectWord('from', '(`footprints from TEMPLATE`, the table, then `end`)');
        const t = this.declName('a template name');
        node.template = { name: t.v, s: t.s, e: t.e };
        if (this.isP('(')) node.args = this.callArgs();
        node.callS = t.s;
        node.callE = this.prevEnd();
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        return this.skipBlock(err, head, 'table', () => { this.sync(); return null; });
      }
      const headE = this.prevEnd();
      if (!this.atStmtEnd()) {
        this.note(`unexpected ${describe(this.cur)} — the table goes on the lines below: a header row of parameter names, then one row per footprint`, this.cur.s, Math.max(this.cur.e, this.cur.s + 1));
        this.sync();
      }
      this.skipEOS();
      node.headerS = this.cur.s;
      let rowsOk = true;
      try {
        while (this.cur.t === 'word' && !this.isWord('end') && !this.startsTopItem()) {
          const h = this.cur;
          if (HARD.has(h.v)) this.failAt(hardName(h.v));
          this.advance();
          node.header.push({ name: h.v, s: h.s, e: h.e });
        }
        if (!node.header.length) this.expected('a header row naming the template parameter each column fills');
        if (!this.atStmtEnd()) this.failAt(`the header row holds parameter names only — found ${describe(this.cur)}`);
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.report(err);
        this.sync();
        rowsOk = false;     // rows can't be matched to a broken header: skip them
      }
      node.headerE = this.prevEnd();
      this.skipEOS();
      for (;;) {
        if (this.isWord('end')) { this.advance(); break; }
        if (this.cur.t === 'eof' || this.startsTopItem()) {
          this.missingEnd(head, headE, 'table', this.cur);
          this.softEnd = true;
          break;
        }
        const start = this.i;
        const rs = this.cur.s;
        try {
          const cells = [];
          while (!this.atStmtEnd()) cells.push(this.cell());
          const re = this.prevEnd();
          if (rowsOk && cells.length !== node.header.length) {
            const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
            throw new ParseError(`this row has ${plural(cells.length, 'value')} but the header names ${plural(node.header.length, 'column')}`, rs, re);
          }
          if (rowsOk) node.rows.push({ cells, s: rs, e: re, line: this.t[start].line });
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          if (rowsOk) this.report(err);
          this.sync();
          if (this.i === start) this.advance();
        }
        this.skipEOS();
      }
      return node;
    }

    /** One table cell: a number, a name, a "string" or a (parenthesized expression). */
    cell() { return this.withMarks('cell', () => this.cellValue()); }
    cellValue() {
      const k = this.cur;
      if (k.t === 'str') { this.advance(); const x = { type: 'str', value: this.strNode(k), s: k.s, e: k.e }; return { x, s: k.s, e: k.e }; }
      if (this.isP('(')) { const x = this.primary(); return { x, s: x.s, e: x.e }; }
      if (this.isP('-')) {
        const m = this.advance();
        if (this.cur.t !== 'num' || this.cur.s !== m.e) {
          this.failAt('write a negative value as `-0.5` (no space), or put arithmetic in parentheses: `(D - 0.5)`', m);
        }
        const x = this.primary();
        return { x: { type: 'neg', x, s: m.s, e: x.e }, s: m.s, e: x.e };
      }
      if (k.t === 'num' || (k.t === 'word' && !HARD.has(k.v))) { const x = this.primary(); return { x, s: x.s, e: x.e }; }
      if (k.t === 'p' && k.v === ',') this.failAt('table cells are separated by spaces, not commas');
      if (k.t === 'p' && ['+', '*', '/'].includes(k.v)) this.failAt('a cell holds one value — put arithmetic in parentheses: `(D - 0.5)`');
      return this.expected('a value: a number, a name, a "string" or a (parenthesized expression)');
    }

    /** A string token as a plain string, or { interp: [text | { x, fmt, s, e }], s, e }. */
    strNode(k) {
      if (!k.parts) return k.v;
      const parts = [];
      for (const p of k.parts) {
        if (p.lit != null) { parts.push(p.lit); continue; }
        let x = null;
        if (p.toks.length) {
          try {
            const sub = new Parser(p.toks.concat([{ t: 'eof', s: p.codeE, e: p.codeE, line: k.line, col: 0 }]), this.diags);
            sub.unit = this.unit;
            x = sub.expr();
            if (sub.cur.t !== 'eof') sub.failAt(`unexpected ${describe(sub.cur)} — each \`{…}\` holds one expression`);
          } catch (err) {
            if (!(err instanceof ParseError)) throw err;
            this.report(err);
            x = null;
          }
        }
        parts.push({ x, fmt: p.fmt, s: p.open, e: p.close + 1 });
      }
      return { interp: parts, s: k.s, e: k.e };
    }

    // Statements
    statement() {
      const k = this.cur;
      const s = k.s;
      let node;
      if (k.t === 'word' && this.isP(':', 1) && STMT_SET.has(k.v) && !KEY_STMTS.has(k.v) && !MEASURES.has(k.v)) {
        this.failAt(`\`${k.v}\` takes no colon`, this.peek(1));
      }
      if (this.isDecl()) node = this.decl('Let');
      else if (k.t === 'word') {
        switch (k.v) {
          case 'let': node = this.oldLet('Let'); break;
          case 'description': case 'datasheet': case 'manufacturer': case 'mpn': case 'refdes': {
            this.expectKey(k.v);
            const v = this.cur;
            if (v.t !== 'str') this.expected(`a "quoted string" after \`${k.v}:\``);
            this.advance();
            node = { type: 'Meta', key: k.v, value: this.strNode(v) };
            break;
          }
          case 'name': {
            this.expectKey('name');
            const v = this.cur;
            if (v.t !== 'str') this.expected('the footprint name as a "string", e.g. `name: "QFN-{n}"`');
            this.advance();
            node = { type: 'Name', value: this.strNode(v), vs: v.s, ve: v.e };
            break;
          }
          case 'tags': {
            this.expectKey('tags');
            const tags = [this.tag()];
            while (this.acceptP(',')) tags.push(this.tag());
            node = { type: 'Meta', key: 'tags', value: tags };
            break;
          }
          case 'origin':
            node = (this.isWord('at', 1) || this.isWord('centered', 1)) ? this.originStmt() : this.placement();
            break;
          case 'body': node = this.bodyOrPlacement(); break;
          case 'pins': node = this.pins(); break;
          case 'balls': node = this.balls(); break;
          case 'lead': node = this.lead(); break;
          case 'thermal': node = this.thermal(); break;
          case 'span': case 'gap': case 'pitch': node = this.measure(); break;
          case 'density': {
            this.expectKey('density');
            const v = this.cur;
            if (v.t !== 'word' || !['least', 'nominal', 'most'].includes(v.v)) this.expected('`least`, `nominal` or `most`');
            this.advance();
            node = { type: 'Density', level: v.v };
            break;
          }
          case 'omit': case 'only': {
            this.advance();
            const items = [this.regionOrName()];
            while (this.acceptP(',')) items.push(this.regionOrName());
            node = { type: k.v === 'omit' ? 'Omit' : 'Only', items };
            break;
          }
          case 'pin1': {
            this.expectKey('pin1');
            const v = this.cur;
            if (v.t === 'word' && ['dot', 'chamfer', 'notch', 'bar', 'none'].includes(v.v)) {
              this.advance();
              node = { type: 'Pin1', style: v.v };
            } else if (v.t === 'word' && !HARD.has(v.v)) {
              // a custom marker: `pin1: plus`, `pin1: arrow(0.6)`
              node = { type: 'Pin1', style: 'feature', feature: this.featureCall() };
            } else {
              this.expected('a pin-1 marker: `dot`, `chamfer`, `notch`, `bar`, `none`, or the name of a feature');
            }
            break;
          }
          case 'polarized': this.advance(); node = { type: 'Polarized' }; break;
          case 'default':
            this.advance();
            this.expectWord('pad', 'after `default`');
            node = { type: 'DefaultPad', geom: this.padGeom() };
            break;
          case 'pad': node = this.padOrPlacement(); break;
          case 'pads': {
            this.advance();
            const sel = this.selList();
            const block = this.padProps();
            if (!block.length) this.expected('pad properties after the selector, such as `mask: +0.05`');
            node = { type: 'Pads', sel, block };
            break;
          }
          case 'hole': node = this.holeOrPlacement(); break;
          case 'delete': this.advance(); node = { type: 'Delete', ref: this.objref() }; break;
          case 'row': node = this.rowOrPlacement(); break;
          case 'group': node = this.groupOrPlacement(); break;
          case 'align': {
            this.advance();
            const a = this.objref();
            this.expectWord('with');
            const b = this.objref();
            const axis = this.axisAdv();
            if (!axis) this.expected('`horizontally` (same y) or `vertically` (same x)');
            node = { type: 'Align', a, b, axis };
            break;
          }
          case 'silk': case 'assembly': {
            if (!this.isP(':', 1) && !this.isWord('auto', 1) && !this.isWord('none', 1)) {
              this.failAt(`\`${k.v}:\` takes \`auto\` or \`none\`; graphics go straight in the footprint (\`line …\`${k.v === 'assembly' ? ' with `layer: assembly`' : ''})`);
            }
            this.expectKey(k.v);
            if (this.acceptWord('auto')) node = { type: 'Layer', layer: k.v, mode: 'auto' };
            else if (this.acceptWord('none')) node = { type: 'Layer', layer: k.v, mode: 'none' };
            else this.expected('`auto` or `none`');
            break;
          }
          case 'courtyard': node = this.courtyard(); break;
          case 'outline': case 'line': case 'arc': case 'circle': case 'rect': case 'polygon': case 'hatch': {
            const g = this.gfxStmt('footprint');
            g.unit = this.unit;
            node = { type: 'Layer', layer: g.layer || 'silk', mode: 'block', items: [g] };
            break;
          }
          case 'text': node = this.text('footprint'); break;
          case 'feature': node = this.featureUse(); break;
          case 'model': case 'no': node = this.model(); break;
          case 'units': this.failAt('`units:` goes first in a footprint or template, or at the top of the file'); break;
          case 'section': this.failAt('a `section` goes in a feature'); break;
          default:
            if (SOLIDS.has(k.v) && k.kw) this.failAt(`a \`${k.v}\` goes in the footprint's \`model\` block, or in a feature`);
            if ((MODEL_WORDS.has(k.v) && this.isP(':', 1)) || k.v === 'leads') this.failAt(`\`${k.v}${k.v === 'leads' ? ' …' : ':'}\` goes in the footprint's \`model\` block`);
            node = this.placement();
        }
      } else {
        node = this.placement();
      }
      node.s = s; node.e = this.prevEnd(); node.unit = this.unit;
      return node;
    }

    /** A tag: a word, a number or a "string". */
    tag() {
      const k = this.cur;
      if (k.t === 'str') { this.advance(); return this.strNode(k); }
      if (k.t === 'num' && k.isInt) { this.advance(); return String(parseInt(k.text, 10)); }
      if (k.t === 'word' && !HARD.has(k.v)) { this.advance(); return k.v; }
      return this.expected('a tag');
    }

    originStmt() {
      this.expectWord('origin');
      if (this.acceptWord('at')) {
        if (this.isP('(')) return { type: 'Origin', point: this.point() };
        return { type: 'Origin', ref: this.objref() };
      }
      this.expectWord('centered');
      this.expectWord('between');
      const a = this.objref();
      this.expectWord('and');
      const b = this.objref();
      return { type: 'Origin', between: [a, b] };
    }

    /** Is a placement (`at`, `is`, `mirrors`, maybe after an anchor) next, at offset k? */
    isPlaceAhead(k) {
      const place = (j) => this.isWord('at', j) || this.isWord('is', j) || this.isWord('mirrors', j);
      const a = this.peek(k);
      return place(k) || (a.t === 'word' && ANCHORS.has(a.v) && place(k + 1));
    }

    bodyOrPlacement() {
      if (this.isKey('color', 1) || this.isKey('shape', 1)) this.failAt(`\`body ${this.peek(1).v}:\` goes in the footprint's \`model\` block`);
      if (this.isWord('cylinder', 1)) {
        this.advance(); this.advance();
        this.expectKey('d', '(the diameter: `body cylinder d: 8 h: 11.5`)');
        const d = this.expr();
        this.expectKey('h', '(the height: `body cylinder d: 8 h: 11.5`)');
        const h = this.expr();
        return { type: 'Body', cyl: true, d, h };
      }
      if (!this.isPlaceAhead(1) && this.exprStart(1)) {
        this.advance();
        return this.withMarks('body', () => {
          const w = this.expr();
          this.expectWord('x', 'between body width and length (`body 3.9 x 4.9 x 1.5`)');
          const l = this.expr();
          const h = this.acceptWord('x') ? this.expr() : null;
          return { type: 'Body', w, l, h };
        });
      }
      return this.placement();
    }

    pins() {
      const head = this.expectWord('pins');
      if (this.atStmtEnd()) return { type: 'Pins', form: 'sides', sides: this.sidesBlock(head), clauses: {} };
      if (this.acceptWord('grid')) {
        const nx = this.count();
        this.expectWord('x', '(`pins grid COLS x ROWS`)');
        const ny = this.count();
        return { type: 'Pins', form: 'grid', nx, ny, clauses: this.pinsClauses() };
      }
      const count = this.count();
      let arrangement = null, side = null;
      const a = this.cur;
      if (a.t === 'word' && ARRANGEMENTS.has(a.v) && !this.isP(':', 1)) { this.advance(); arrangement = a.v; }
      else if (this.acceptWord('single')) { arrangement = 'single'; side = this.sideWord(); }
      return { type: 'Pins', form: 'count', count, arrangement, side, clauses: this.pinsClauses() };
    }

    balls() {
      this.expectWord('balls');
      const nx = this.count();
      this.expectWord('x', '(`balls COLS x ROWS`)');
      const ny = this.count();
      return { type: 'Balls', nx, ny, clauses: this.pinsClauses() };
    }

    count() {
      const k = this.cur;
      if (k.t === 'num' && k.isInt) { this.advance(); return { v: k.v, s: k.s, e: k.e }; }
      if (k.t === 'word' && !HARD.has(k.v) && !ARRANGEMENTS.has(k.v) && k.v !== 'single' && k.v !== 'grid' && !this.isP(':', 1)) {
        this.advance();
        return { id: k.v, s: k.s, e: k.e };
      }
      if (k.t === 'num') this.failAt(`a count must be a whole number, found \`${k.text}\``);
      return this.expected('a pin count');
    }

    pinsClauses() {
      const c = {};
      const once = (key, tok) => { if (c[key]) this.failAt(`\`${key}:\` is given twice`, tok); };
      for (;;) {
        const k = this.cur;
        if (this.acceptKey('pitch')) {
          once('pitch', k);
          const x = this.expr();
          const y = this.acceptWord('x') ? this.expr() : null;
          c.pitch = { x, y, s: k.s, e: this.prevEnd() };
        } else if (this.acceptKey('span')) {
          once('span', k);
          const x = this.expr();
          c.span = { x, qual: this.spanQual(), s: k.s, e: this.prevEnd() };
        } else if (this.acceptKey('pad')) {
          once('pad', k);
          c.pad = this.padGeom();
        } else if (this.acceptKey('numbering')) {
          once('numbering', k);
          const v = this.cur;
          if (v.t !== 'word' || !SCHEMES.has(v.v)) this.expected('a numbering scheme: ccw, cw, zigzag, row-major, col-major or bga');
          this.advance();
          c.numbering = { v: v.v, s: v.s, e: v.e };
        } else if (this.acceptKey('start')) {
          once('start', k);
          const v = this.cur;
          if (v.t !== 'word' || !CORNERS.has(v.v)) this.expected('a corner: top-left, top-right, bottom-left or bottom-right');
          this.advance();
          c.start = { v: v.v, s: v.s, e: v.e };
        } else break;
      }
      return c;
    }

    /** `pins` alone on its line: a list of sides, `left: 1, 2, 3 [pitch: P]`, then `end`. */
    sidesBlock(head) {
      return this.block(head, '`pins` list', () => {
        const k = this.cur;
        const side = this.sideWord();
        this.expectP(':', `after \`${side}\``);
        const positions = [];
        do {
          const p = this.cur;
          if (this.acceptWord('nc')) positions.push({ nc: true, s: p.s, e: p.e });
          else { const nm = this.name('a pin name or `nc`'); positions.push({ name: nm.name, s: nm.s, e: nm.e }); }
        } while (this.acceptP(','));
        const pitch = this.acceptKey('pitch') ? this.expr() : null;
        return { side, positions, pitch, s: k.s, e: this.prevEnd() };
      }, { stops: () => this.cur.t === 'word' && (STMT_SET.has(this.cur.v) || this.isP('=', 1)) }).stmts;
    }

    lead() {
      this.expectWord('lead');
      let f = this.cur;
      let names = null;
      if (!(f.t === 'word' && LEAD_FORMS.has(f.v))) {
        // per-pin: `lead 4 gullwing ...`, `lead 1, 3 none` (SPEC 11.3)
        if ((f.t === 'num' && f.isInt && !f.suffix) || f.t === 'str' || (f.t === 'word' && !f.kw)) {
          names = this.selList();
          if (this.acceptWord('none')) return { type: 'Lead', names, none: true };
          f = this.cur;
          if (f.t !== 'word' || !LEAD_FORMS.has(f.v)) {
            this.expected('a lead form for these pins (gullwing, jlead, lbend, straight, flat, endcap, ball, column, pin, wire, tab, castellated) or `none`');
          }
        } else {
          this.expected('a lead form: gullwing, jlead, lbend, straight, flat, endcap, ball, column, pin, wire, tab or castellated');
        }
      }
      this.advance();
      let dims = null;
      if (this.acceptKey('d')) dims = { d: this.expr() };
      else if (this.exprStart()) {
        const z = this.sizeOrOne(false);
        dims = z.v ? { v: z.v } : { w: z.w, l: z.l };
      }
      let span = null;
      const k = this.cur;
      if (this.acceptKey('span')) {
        const x = this.expr();
        span = { x, qual: this.spanQual(), s: k.s, e: this.prevEnd() };
      }
      return { type: 'Lead', form: f.v, dims, span, names };
    }

    thermal() {
      this.expectWord('thermal');
      this.expectWord('pad', 'after `thermal`');
      let name = null, size;
      const save = this.i;
      try {
        const nm = this.name();
        size = this.size();
        name = nm;
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.i = save;
        size = this.size();
      }
      const block = this.padProps();
      return { type: 'Thermal', name, size, block: block.length ? block : null };
    }

    /** `span: X`, `gap: X`, `pitch: X`, or `pitch A to B is X [horizontally]`. */
    measure() {
      const k = this.cur;
      const word = k.v;
      const objectsAhead = (j) => {
        const save = this.i;
        this.i += j;
        let a = null;
        try { a = this.objref(); } catch (err) { if (!(err instanceof ParseError)) throw err; a = null; }
        const pair = !!a && this.isWord('to');
        this.i = save;
        return pair ? a : null;
      };
      if (this.isP(':', 1)) {
        const a = objectsAhead(2);
        if (a && a.kind) this.failAt(`a ${word} between two objects takes no colon: \`${word} pad 1 to pad 2 is …\``, this.peek(1));
        this.advance(); this.advance();
        const x = this.expr();
        return { type: 'MeasureBare', word, x, qual: this.spanQual() };
      }
      if (!objectsAhead(1)) {
        if (this.valueAt(1)) this.missingColon();
        return this.expected(`\`${word}:\` and a value, or \`${word} A to B is VALUE\``, this.peek(1));
      }
      this.advance();
      const a = this.objref();
      this.expectWord('to');
      const b = this.objref();
      this.expectWord('is', `(\`${word} A to B is VALUE\`)`);
      const x = this.expr();
      return { type: 'MeasurePair', word, a, b, x, axis: this.axisAdv() };
    }

    spanQual() {
      const k = this.cur;
      if (k.t === 'word' && (k.v === 'outer' || k.v === 'inner' || k.v === 'centers')) { this.advance(); return k.v; }
      return null;
    }

    regionOrName() {
      const k = this.cur;
      if (this.acceptWord('rows')) {
        const rows = this.range();
        const cols = this.acceptWord('cols') ? this.range() : null;
        return { rows, cols, s: k.s, e: this.prevEnd() };
      }
      if (this.acceptWord('cols')) return { cols: this.range(), s: k.s, e: this.prevEnd() };
      const a = this.name('a pin name, `rows …` or `cols …`');
      if (this.acceptP('..')) {
        const b = this.name('the end of the range');
        return { range: [a, b], s: k.s, e: this.prevEnd() };
      }
      return { name: a, s: k.s, e: this.prevEnd() };
    }

    range() {
      const a = this.rangeEnd();
      this.expectP('..', '(a range like `1..4` or `D..E`)');
      const b = this.rangeEnd();
      return [a, b];
    }
    rangeEnd() {
      const k = this.cur;
      if ((k.t === 'num' && k.isInt) || (k.t === 'word' && !k.kw)) return this.name();
      return this.expected('a row/column number or letter');
    }

    selList() {
      const items = [this.selItem()];
      while (this.acceptP(',')) items.push(this.selItem());
      return items;
    }
    selItem() {
      const k = this.cur;
      const a = this.name('a pad name');
      if (this.acceptP('..')) {
        const b = this.name('the end of the range');
        if (a.quoted || b.quoted) this.failAt('range ends must be numbers or identifiers, not "strings"', k);
        return { range: [a, b], s: k.s, e: this.prevEnd() };
      }
      return { name: a, s: k.s, e: this.prevEnd() };
    }

    /** Is a pad property (`size: …`, `mask: …`) next? A known one missing its colon is reported. */
    padKeyAhead(set) {
      const k = this.cur;
      if (k.t !== 'word' || !set.has(k.v)) return false;
      if (this.isP(':', 1)) return true;
      if (this.valueAt(1)) this.missingColon();
      return false;
    }

    padOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a pad name');
      this.stmtTarget = { kind: 'pad', name: name.name };
      const k = this.cur;
      if (this.isWord('tht') || (k.t === 'word' && SHAPES.has(k.v) && !this.isP(':', 1))) {
        return { type: 'Pad', name, geom: this.padGeom() };
      }
      if (this.padKeyAhead(PAD_KEYS)) return { type: 'Pad', name, block: this.padProps() };
      this.i = save;
      return this.placement('a pad shape, a property such as `size: 1 x 2`, `at`, `is` or `mirrors`');
    }

    holeOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a hole name');
      this.stmtTarget = { kind: 'hole', name: name.name };
      if (!this.isPlaceAhead(0)) {
        if (this.acceptWord('slot')) return { type: 'Hole', name, slot: this.size() };
        if (this.exprStart()) return { type: 'Hole', name, d: this.expr() };
      }
      this.i = save;
      return this.placement('a hole diameter, `slot W x L`, `at`, `is` or `mirrors`');
    }

    rowOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a row name');
      if (this.acceptWord('pads')) {
        const sel = this.selList();
        this.expectKey('pitch', '(`row NAME pads 1..4 pitch: P going: down`)');
        const pitch = this.expr();
        let going = null;
        if (this.acceptKey('going')) {
          const g = this.cur;
          if (g.t !== 'word' || !['left', 'right', 'up', 'down'].includes(g.v)) this.expected('`left`, `right`, `up` or `down`');
          this.advance();
          going = g.v;
        }
        return { type: 'Row', name, sel, pitch, going };
      }
      this.i = save;
      return this.placement('`pads …` or a placement');
    }

    groupOrPlacement() {
      if (this.isP('=', 2)) {
        this.advance();
        const name = this.name('a group name');
        this.expectP('=');
        const members = [this.objref()];
        while (this.acceptP(',')) members.push(this.objref());
        return { type: 'Group', name, members };
      }
      return this.placement();
    }

    // placement_stmt <- objref ( at_tail / is_tail / mirrors_tail )
    placement(what) {
      const first = this.cur;
      const target = this.objref();
      this.stmtTarget = target;
      if (this.acceptWord('at')) return { type: 'At', target, point: this.point() };
      if (this.acceptWord('mirrors')) {
        const proto = this.objref();
        this.expectWord('across');
        const ax = this.cur;
        if (!(ax.t === 'word' && (ax.v === 'x' || ax.v === 'y'))) this.expected('`x` or `y` (the axis to mirror across)');
        this.advance();
        return { type: 'Mirrors', target, proto, axis: ax.v };
      }
      if (this.acceptWord('is')) {
        if (this.acceptWord('centered')) {
          if (this.acceptWord('between')) {
            const a = this.objref();
            this.expectWord('and');
            const b = this.objref();
            return { type: 'Centered', target, between: [a, b], axis: this.axisAdv() };
          }
          if (this.acceptWord('on')) return { type: 'Centered', target, on: this.objref(), axis: this.axisAdv() };
          this.expected('`between` or `on` after `centered`');
        }
        const clauses = [this.relClause()];
        while (this.acceptWord('and')) clauses.push(this.relClause());
        return { type: 'Is', target, clauses };
      }
      if (target.kind === null && first.t === 'word' && !first.kw) {
        const hint = suggest(first.v, STMT_WORDS);
        this.failAt(`unknown statement \`${first.v}\`${hint ? ` — did you mean \`${hint}\`?` : ''}`, first);
      }
      return this.expected(what || '`at`, `is` or `mirrors`');
    }

    relClause() {
      const s = this.cur.s;
      const dist = this.expr();
      let dir = null;
      if (this.acceptWord('left')) { this.expectWord('of', '(`left of`)'); dir = 'left'; }
      else if (this.acceptWord('right')) { this.expectWord('of', '(`right of`)'); dir = 'right'; }
      else if (this.acceptWord('above')) dir = 'above';
      else if (this.acceptWord('below')) dir = 'below';
      else this.expected('a direction: `left of`, `right of`, `above` or `below`');
      const ref = this.objref();
      return { dist, dir, ref, s, e: this.prevEnd() };
    }

    axisAdv() {
      if (this.acceptWord('horizontally')) return 'horizontally';
      if (this.acceptWord('vertically')) return 'vertically';
      return null;
    }

    objref() {
      const k = this.cur;
      const s = k.s;
      if (this.acceptWord('origin')) return { kind: 'origin', name: null, anchor: null, s, e: k.e };
      if (this.acceptWord('body')) return { kind: 'body', name: null, anchor: this.anchor(), s, e: this.prevEnd() };
      if (this.acceptWord('side')) {
        const side = this.sideWord();
        return { kind: 'side', name: side, anchor: this.anchor(), s, e: this.prevEnd() };
      }
      if (k.t === 'word' && KINDS.has(k.v)) {
        this.acceptWord(k.v);
        const nm = this.name(`a ${k.v} name`);
        return { kind: k.v === 'ball' ? 'pad' : k.v, alias: k.v, name: nm.name, anchor: this.anchor(), s, e: this.prevEnd() };
      }
      if (k.t === 'str' || (k.t === 'num' && k.isInt) || (k.t === 'word' && !k.kw)) {
        const nm = this.name();
        return { kind: null, name: nm.name, anchor: this.anchor(), s, e: this.prevEnd() };
      }
      return this.expected('an object (`pad 1`, `hole M1`, `row A`, `group G`, `side left`, `body` or `origin`)');
    }

    anchor() {
      const k = this.cur;
      if (k.t === 'word' && ANCHORS.has(k.v)) { this.advance(); return k.v; }
      return null;
    }

    sideWord() {
      const k = this.cur;
      if (k.t !== 'word' || !SIDE_WORDS.has(k.v)) this.expected('`left`, `right`, `top` or `bottom`');
      this.advance();
      return k.v;
    }

    /** An object's name (a pad, hole, row or group): a whole number, an identifier or
     *  a "string". A keyword needs quotes here, since it would read as part of the statement. */
    name(what) {
      const k = this.cur;
      if (k.t === 'str') { this.advance(); return { name: this.strNode(k), s: k.s, e: k.e, quoted: true }; }
      if (k.t === 'num' && k.isInt) { this.advance(); return { name: String(parseInt(k.text, 10)), s: k.s, e: k.e }; }
      if (k.t === 'word' && !k.kw) { this.advance(); return { name: k.v, s: k.s, e: k.e }; }
      if (k.t === 'word' && k.kw) this.failAt(`\`${k.v}\` is a keyword — quote it to use it as a name: "${k.v}"`);
      if (k.t === 'num') this.failAt(`a name must be a whole number, an identifier or a "string", found \`${k.text}\``);
      return this.expected(what || 'a name');
    }

    // Pads
    /** `[tht] SHAPE` and its properties, in any order: `drill: D`, `rotate: A`, `mask: …`,
     *  `paste: …`, `vias: …`. */
    padGeom() {
      const s = this.cur.s;
      const tht = !!this.acceptWord('tht');
      const shape = this.shapeSpec();
      let drill = null;
      const props = [];
      while (this.padKeyAhead(PAD_PROPS)) {
        const k = this.cur;
        if (k.v === 'drill') {
          if (drill) this.failAt('`drill:` is given twice', k);
          drill = this.drillSpec();
        } else props.push(this.padProp());
      }
      return { tht, shape, drill, props, s, e: this.prevEnd() };
    }

    shapeSpec() {
      const k = this.cur;
      if (k.t !== 'word' || !SHAPES.has(k.v)) this.expected('a pad shape: rect, oval, roundrect, dshape, circle or polygon');
      this.acceptWord(k.v);
      const s = k.s;
      switch (k.v) {
        case 'rect': case 'oval': return { kind: k.v, size: this.size(), s, e: this.prevEnd() };
        case 'roundrect': {
          const size = this.size();
          this.expectKey('r', 'and a corner radius (`r: 25%` or `r: 0.1`)');
          const r = this.lengthOrPct();
          return { kind: 'roundrect', size, r, s, e: this.prevEnd() };
        }
        case 'dshape': {
          const size = this.size();
          const flat = this.acceptKey('flat') ? this.sideWord() : null;
          return { kind: 'dshape', size, flat, s, e: this.prevEnd() };
        }
        case 'circle': return { kind: 'circle', d: this.expr(), s, e: this.prevEnd() };
        default: {
          const pts = [this.point(), this.point(), this.point()];
          while (this.isP('(')) pts.push(this.point());
          return { kind: 'polygon', pts, s, e: this.prevEnd() };
        }
      }
    }

    drillSpec() {
      const k = this.expectKey('drill');
      if (this.acceptWord('slot')) return { slot: this.size(), s: k.s, e: this.prevEnd() };
      return { d: this.expr(), s: k.s, e: this.prevEnd() };
    }

    /** `rotate: A`, `mask: …`, `paste: …` or `vias: …`. */
    padProp() {
      const k = this.advance();
      this.advance();   // the colon
      const s = k.s;
      switch (k.v) {
        case 'rotate': return { prop: 'rotate', angle: this.angle(), s, e: this.prevEnd() };
        case 'mask':
          if (this.acceptWord('none')) return { prop: 'mask', mode: 'none', s, e: this.prevEnd() };
          if (this.acceptWord('defined')) return { prop: 'mask', mode: 'defined', s, e: this.prevEnd() };
          return { prop: 'mask', mode: 'expand', value: this.signedExpr(), s, e: this.prevEnd() };
        case 'paste':
          if (this.acceptWord('none')) return { prop: 'paste', mode: 'none', s, e: this.prevEnd() };
          if (this.acceptWord('divide')) {
            const nx = this.count();
            this.expectWord('x');
            const ny = this.count();
            let coverage = null, gutter = null;
            if (this.acceptKey('coverage')) coverage = this.percent();
            else if (this.acceptKey('gutter')) gutter = this.expr();
            return { prop: 'paste', mode: 'divide', nx, ny, coverage, gutter, s, e: this.prevEnd() };
          }
          return { prop: 'paste', mode: 'expand', value: this.signedExpr(), s, e: this.prevEnd() };
        default: {   // vias
          const nx = this.count();
          this.expectWord('x');
          const ny = this.count();
          this.expectKey('drill', '(`vias: 3 x 3 drill: 0.3 pitch: 1.1`)');
          const drill = this.expr();
          this.expectKey('pitch', '(`vias: 3 x 3 drill: 0.3 pitch: 1.1`)');
          const pitch = this.expr();
          return { prop: 'vias', nx, ny, drill, pitch, s, e: this.prevEnd() };
        }
      }
    }

    /** Properties that change a pad, in any order: `shape:`, `size:`, `width:`,
     *  `length:`, `drill:`, `rotate:`, `mask:`, `paste:`, `vias:`. */
    padProps() {
      const ops = [];
      while (this.padKeyAhead(PAD_KEYS)) {
        const k = this.cur;
        const s = k.s;
        switch (k.v) {
          case 'shape': this.expectKey('shape'); ops.push({ op: 'shape', shape: this.shapeSpec(), s, e: this.prevEnd() }); break;
          case 'size': this.expectKey('size'); ops.push({ op: 'size', size: this.size(), s, e: this.prevEnd() }); break;
          case 'width': this.expectKey('width'); ops.push({ op: 'width', x: this.expr(), s, e: this.prevEnd() }); break;
          case 'length': this.expectKey('length'); ops.push({ op: 'length', x: this.expr(), s, e: this.prevEnd() }); break;
          case 'drill': ops.push({ op: 'drill', drill: this.drillSpec(), s, e: this.prevEnd() }); break;
          default: ops.push({ op: 'prop', prop: this.padProp(), s, e: this.prevEnd() });
        }
      }
      for (const op of ops) op.unit = this.unit;
      return ops;
    }

    signedExpr() {
      if (this.acceptP('+')) return { sign: 1, x: this.expr() };
      if (this.acceptP('-')) return { sign: -1, x: this.expr() };
      return this.expected('a signed value such as `+0.05` or `-0.05`, or `none`');
    }

    int() {
      const k = this.cur;
      if (k.t === 'num' && k.isInt) { this.advance(); return k.v; }
      return this.expected('a whole number');
    }

    percent() {
      const k = this.cur;
      if (k.t === 'num' && k.suffix === '%') { this.advance(); return { pct: k.v, s: k.s, e: k.e }; }
      return this.expected('a percentage such as `68%`');
    }

    lengthOrPct() {
      const k = this.cur;
      if (k.t === 'num' && k.suffix === '%') { this.advance(); return { pct: k.v, s: k.s, e: k.e }; }
      return { x: this.expr() };
    }

    /** An angle in degrees: `45`, `45deg`, `0.7854rad` or any expression (`a + 90`).
     *  A constant comes back as { deg }, anything else as { x } to evaluate. */
    angle() {
      const s = this.cur.s;
      if (!this.exprStart() && !(this.cur.t === 'num' && (this.cur.suffix === 'deg' || this.cur.suffix === 'rad'))) {
        this.expected('an angle such as `45`, `45deg` or `0.7854rad`');
      }
      let x = this.withMarks('angle', () => this.expr());
      if (this.isWord('deg')) this.advance();
      else if (this.isWord('rad')) {
        this.advance();
        x = { type: 'bin', op: '*', a: x, b: { type: 'num', v: 180 / Math.PI, s: x.s, e: x.e }, s: x.s, e: x.e };
      }
      const lit = (n) => (n.type === 'num' && !n.unit ? n.v : n.type === 'neg' && n.x.type === 'num' && !n.x.unit ? -n.x.v
        : n.type === 'bin' && n.op === '*' && lit(n.a) != null && lit(n.b) != null ? lit(n.a) * lit(n.b) : null);
      const c = lit(x);
      if (c != null) return { deg: c, s, e: this.prevEnd() };
      return { x, s, e: this.prevEnd() };
    }

    // Graphics
    /**
     * A graphic, then its options in any order (`width: W`, `fill`, `clear`, `layer: L`).
     *   outline body [offset: X]        line P P              arc P r: R from A to B
     *   circle P d: D                   rect P W x L          polygon P P P ...
     *   hatch P d: D from A to B pitch: P                     text ...
     * `where` is 'footprint', 'feature' or 'courtyard' (a rect or polygon, no layer).
     */
    gfxStmt(where) {
      const k = this.cur;
      const s = k.s;
      let node;
      if (this.isWord('text')) {
        node = this.text(where);
        node.op = 'text';
        node.s = s; node.e = this.prevEnd();
        return node;
      }
      if (this.acceptWord('outline')) {
        this.expectWord('body', '(`outline body offset: 0.15`)');
        node = { op: 'outline', offset: null };
      } else if (this.acceptWord('line')) {
        node = { op: 'line', a: this.point(), b: this.point() };
      } else if (this.acceptWord('arc')) {
        const c = this.point();
        this.expectKey('r', '(an arc is `arc (x, y) r: R from A to B`)');
        const r = this.expr();
        this.expectWord('from', '(an arc is `arc (x, y) r: R from A to B`)');
        const from = this.angle();
        this.expectWord('to');
        node = { op: 'arc', c, r, from, to: this.angle() };
      } else if (this.acceptWord('circle')) {
        const c = this.point();
        this.expectKey('d', '(the circle\'s diameter)');
        node = { op: 'circle', c, d: this.expr() };
      } else if (this.acceptWord('rect')) {
        node = { op: 'rect', c: this.point(), size: this.size() };
      } else if (this.acceptWord('polygon')) {
        const pts = [this.point(), this.point(), this.point()];
        while (this.isP('(')) pts.push(this.point());
        node = { op: 'polygon', pts };
      } else if (this.acceptWord('hatch')) {
        // chords of a circle across x, from x = A while x < B, every P
        const c = this.point();
        this.expectKey('d', '(`hatch (x, y) d: D from A to B pitch: P`)');
        const d = this.expr();
        this.expectWord('from', '(`hatch (x, y) d: D from A to B pitch: P`)');
        const from = this.expr();
        this.expectWord('to');
        const to = this.expr();
        this.expectKey('pitch', '(`hatch (x, y) d: D from A to B pitch: P`)');
        node = { op: 'hatch', c, d, from, to, pitch: this.expr() };
      } else {
        return this.expected('a graphic: outline, line, arc, circle, rect, polygon, hatch or text');
      }
      const once = (key, c) => { if (node[key] != null) this.failAt(`\`${c.v}\` is given twice`, c); };
      for (;;) {
        const c = this.cur;
        if (node.op === 'outline' && this.acceptKey('offset')) { once('offset', c); node.offset = this.expr(); }
        else if (this.acceptKey('width')) { once('width', c); node.width = this.expr(); }
        else if (where === 'courtyard') break;
        else if (this.acceptWord('fill')) {
          if (!FILLED.has(node.op)) this.failAt('`fill` fills a circle, rect or polygon', c);
          node.fill = true;
        } else if (this.acceptWord('clear')) {
          if (!CLEARED.has(node.op)) this.failAt('`clear` cuts lines back from the copper, and a circle is left whole', c);
          node.clear = true;
        } else if (this.acceptKey('layer')) { once('layer', c); node.layer = this.layerWord(['silk', 'assembly']); }
        else break;
      }
      if (node.fill && node.width) throw new ParseError('a filled shape has no line width: drop `width:` or `fill`', node.width.s, node.width.e);
      if (node.fill && node.clear) throw new ParseError('`clear` cuts back lines, and a filled shape has none: drop `clear` or `fill`', s, this.prevEnd());
      node.s = s; node.e = this.prevEnd();
      return node;
    }

    /** The word after `layer:`, one of `allowed`. */
    layerWord(allowed) {
      const l = this.cur;
      if (l.t !== 'word' || !allowed.includes(l.v)) {
        const list = allowed.map((a) => `\`${a}\``);
        this.expected(list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1]);
      }
      this.advance();
      return l.v;
    }

    /** `text ref | value | "STRING" at (x, y) [size: X] [layer: L]`. */
    text(where) {
      this.expectWord('text');
      const k = this.cur;
      let which;
      if (this.acceptWord('ref')) which = { field: 'ref' };
      else if (this.acceptWord('value')) which = { field: 'value' };
      else if (k.t === 'str') { this.advance(); which = { str: this.strNode(k) }; }
      else this.expected('`ref`, `value` or a "string"');
      this.expectWord('at');
      const at = this.point();
      let size = null, layer = null;
      for (;;) {
        const c = this.cur;
        if (this.acceptKey('size')) {
          if (size) this.failAt('`size:` is given twice', c);
          size = this.expr();
        } else if (this.acceptKey('layer')) {
          if (layer) this.failAt('`layer:` is given twice', c);
          layer = this.layerWord(where === 'feature' ? ['silk', 'assembly'] : ['silk', 'assembly', 'copper', 'mask']);
        } else break;
      }
      return { type: 'Text', which, at, size, layer };
    }

    /** `courtyard: auto [clearance]`, `rect W x L` (around the body), `rect (x, y) W x L`
     *  or `polygon` with four corners. */
    courtyard() {
      this.expectKey('courtyard');
      if (this.acceptWord('auto')) {
        return { type: 'Layer', layer: 'courtyard', mode: 'auto', clearance: this.exprStart() ? this.expr() : null };
      }
      if (this.isWord('rect') && !(this.isP('(', 1) && this.parenHasComma(1))) {
        this.acceptWord('rect');
        return { type: 'Layer', layer: 'courtyard', mode: 'rect', size: this.size() };
      }
      if (this.isWord('rect') || this.isWord('polygon')) {
        const g = this.gfxStmt('courtyard');
        g.unit = this.unit;
        return { type: 'Layer', layer: 'courtyard', mode: 'block', items: [g] };
      }
      return this.failAt('a courtyard is one rectangle: `courtyard: auto`, `rect W x L`, `rect (x, y) W x L`, or `polygon` and four corners');
    }

    model() {
      if (this.acceptWord('no')) {
        this.expectWord('model', 'after `no`');
        return { type: 'Model', none: true };
      }
      const head = this.expectWord('model');
      const props = this.block(head, '`model`', () => this.modelItem(), { stops: () => this.endsModel() }).stmts;
      return { type: 'Model', props };
    }
    /** A footprint statement that a model block can't hold: its `end` must be missing. */
    endsModel() {
      const k = this.cur;
      if (k.t !== 'word') return false;
      if (this.isP('=', 1)) return true;
      if (MODEL_WORDS.has(k.v)) return k.v === 'body' && !(this.isWord('color', 1) || this.isWord('shape', 1));
      return STMT_SET.has(k.v);
    }

    /** A model setting or solid. */
    modelItem() {
      const k = this.cur;
      const s = k.s;
      let p;
      if (k.t === 'word' && SOLIDS.has(k.v)) {
        if (this.isP(':', 1)) this.failAt(`\`${k.v}\` takes no colon`, this.peek(1));
        p = this.solid(false);
      } else if (this.isWord('feature')) {
        this.failAt('place a feature in the footprint, after the `model` block: `feature NAME at (x, y, z)` adds its solids to the model, and its silk');
      } else if (this.acceptKey('standoff')) p = { key: 'standoff', x: this.expr() };
      else if (this.acceptKey('height')) p = { key: 'height', x: this.expr() };
      else if (this.acceptKey('draft')) p = { key: 'draft', angle: this.angle() };
      else if (this.acceptWord('body')) {
        if (this.acceptKey('color')) p = { key: 'bodyColor', color: this.color() };
        else if (this.acceptKey('shape')) p = { key: 'bodyShape', call: this.featureCall() };
        else return this.expected('`color:` or `shape:` after `body`');
      } else if (this.acceptWord('leads')) {
        if (this.acceptKey('color')) p = { key: 'leadsColor', color: this.color() };
        else if (this.acceptKey('thickness')) p = { key: 'thickness', x: this.expr() };
        else if (this.acceptKey('below')) p = { key: 'below', x: this.expr() };
        else if (this.acceptKey('above')) p = { key: 'above', x: this.expr() };
        else if (this.acceptKey('shape')) p = { key: 'leadsShape', call: this.featureCall() };
        else return this.expected('`color:`, `thickness:`, `below:`, `above:` or `shape:` after `leads`');
      } else if (this.acceptKey('pin1')) {
        const v = this.cur;
        if (v.t !== 'word' || !['dimple', 'dot', 'notch', 'stripe', 'none'].includes(v.v)) this.expected('a pin-1 mark: `dimple`, `dot`, `notch`, `stripe` or `none`');
        this.advance();
        p = { key: 'pin1', v: v.v };
      } else if (this.acceptKey('step')) {
        const f = this.cur;
        if (f.t !== 'str') this.expected('a "file path" for the STEP model');
        this.advance();
        p = { key: 'step', file: this.strNode(f), xform: {} };
        for (;;) {
          const c = this.cur;
          const once = (key) => { if (p.xform[key]) this.failAt(`\`${key}:\` is given twice`, c); };
          if (this.acceptKey('offset')) { once('offset'); p.xform.offset = this.point3(); }
          else if (this.acceptKey('rotate')) { once('rotate'); p.xform.rotate = this.point3(); }
          else if (this.acceptKey('scale')) { once('scale'); p.xform.scale = this.expr(); }
          else break;
        }
      } else {
        return this.expected('a model setting (standoff:, height:, draft:, body color:, body shape:, leads …, pin1:, step:) or a solid');
      }
      p.s = s; p.e = this.prevEnd();
      return p;
    }

    /**
     * A solid: its size, then options in any order (SPEC 13.3).
     *   box W x L x H                 cylinder d: D [to D2] h: H    sphere d: D [h: H]
     *   disc d: D [to D2]             prism PATH h: H               face PATH
     *   loft W x L at Z, ...          sweep W x T [fillet: R [step: A]] along PATH
     *   wire d: D [fillet: R [step: A]] along PATH                  slab W x L x T [castellated]
     */
    solid(inFeature) {
      const k = this.advance();
      const kind = k.v;
      const p = { key: 'solid', kind };
      const dia = (what) => { this.expectKey('d', `after \`${kind}\` (${what})`); return this.expr(); };
      switch (kind) {
        case 'box': case 'slab':
          this.withMarks('box', () => {
            p.w = this.expr();
            this.expectWord('x', `(a ${kind} is \`W x L x H\`)`);
            p.l = this.expr();
            this.expectWord('x', `(a ${kind} is \`W x L x H\`)`);
            p.h = this.expr();
          });
          if (kind === 'slab' && this.acceptWord('castellated')) p.castellated = true;
          break;
        case 'cylinder':
          p.d = dia('`cylinder d: D h: H`');
          if (this.acceptWord('to')) p.d2 = this.expr();
          this.expectKey('h', '(a cylinder is `d: D h: H`)');
          p.h = this.expr();
          break;
        case 'sphere':
          p.d = dia('`sphere d: D`');
          if (this.acceptKey('h')) p.h = this.expr();
          break;
        case 'disc':
          p.d = dia('`disc d: D`');
          if (this.acceptWord('to')) p.d2 = this.expr();
          break;
        case 'prism':
          p.path = this.path();
          this.expectKey('h', '(a prism is `prism PATH h: H`)');
          p.h = this.expr();
          break;
        case 'face':
          p.path = this.path();
          break;
        case 'loft':
          p.rings = [];
          do {
            const rs = this.cur.s;
            const w = this.expr();
            this.expectWord('x', '(each ring of a loft is `W x L at Z`)');
            const l = this.expr();
            this.expectWord('at', '(each ring of a loft is `W x L at Z`)');
            p.rings.push({ w, l, z: this.expr(), s: rs, e: this.prevEnd() });
          } while (this.acceptP(','));
          if (p.rings.length < 2) this.failAt('a loft needs two rings or more: `loft W x L at Z, W x L at Z`');
          break;
        case 'sweep': case 'wire':
          if (kind === 'sweep') {
            p.w = this.expr();
            this.expectWord('x', '(a sweep is `W x T along PATH`)');
            p.t = this.expr();
          } else p.d = dia('`wire d: D along PATH`');
          if (this.acceptKey('fillet')) {
            p.fillet = this.expr();
            if (this.acceptKey('step')) p.step = this.angle();
          }
          if (!this.isWord('along')) this.expected(`\`along\` and a path (\`${kind} … along (x, z), (x, z), …\`)`);
          this.acceptWord('along');
          p.path = this.path();
          break;
        default: break;
      }
      for (;;) {
        const c = this.cur;
        const once = (key) => { if (p[key] != null) this.failAt(`\`${c.v}\` is given twice`, c); };
        if (this.acceptWord('at')) { once('at'); p.at = this.point3opt(); }
        else if (this.isWord('on') && this.isWord('body', 1)) {
          if (inFeature) this.failAt('`on body` works in a footprint\'s model block; in a feature, give the height in `at (x, y, z)`');
          this.advance(); this.advance(); p.onBody = true;
        }
        else if (this.acceptKey('rotate')) { once('rotate'); p.rotate = this.rotation(); }
        else if (this.acceptKey('color')) { once('color'); p.color = this.color(); }
        else if (this.acceptKey('name')) {
          once('name');
          const v = this.cur;
          if (v.t === 'str') { this.advance(); p.name = this.strNode(v); }
          else if (this.exprStart()) p.name = { x: this.expr() };    // a name that holds text: a parameter
          else this.expected('a name for the solid: a "string", or a parameter that holds one');
        } else if (this.acceptKey('kind')) {
          once('solidKind');
          const v = this.cur;
          if (v.t !== 'word' || !['body', 'lead', 'mark'].includes(v.v)) this.expected('`body`, `lead` or `mark`');
          this.advance();
          p.solidKind = v.v;
        } else if (this.acceptWord('open')) {
          once('open');
          p.open = this.acceptWord('top') ? 'top' : this.acceptWord('bottom') ? 'bottom' : 'both';
        } else if (this.acceptWord('from')) {
          once('from');
          p.from = this.angle();
          this.expectWord('to', '(`from A to B`)');
          p.to = this.angle();
        } else if (this.acceptKey('segments')) { once('segments'); p.segments = this.expr(); }
        else if (this.acceptWord('down')) p.down = true;
        else break;
      }
      p.s = k.s; p.e = this.prevEnd();
      return p;
    }

    /** A path: points and arcs, `(x, y), arc (cx, cy) r: R from A to B [segments: N], ...`. */
    path() {
      const items = [];
      do {
        const s = this.cur.s;
        if (this.acceptWord('arc')) {
          const c = this.point();
          this.expectKey('r', '(an arc is `arc (x, y) r: R from A to B`)');
          const r = this.expr();
          this.expectWord('from', '(an arc is `arc (x, y) r: R from A to B`)');
          const from = this.angle();
          this.expectWord('to');
          const to = this.angle();
          const segments = this.acceptKey('segments') ? this.expr() : null;
          items.push({ arc: true, c, r, from, to, segments, s, e: this.prevEnd() });
        } else if (this.isP('(')) {
          items.push({ pt: this.point(), s, e: this.prevEnd() });
        } else this.expected('a point `(x, y)` or `arc (x, y) r: R from A to B`');
      } while (this.acceptP(','));
      return items;
    }

    /** `(rx, ry, rz)` or one angle (about z), in degrees. */
    rotation() {
      if (!(this.isP('(') && this.parenHasComma(0))) {
        const a = this.angle();
        const zero = { type: 'num', v: 0, s: a.s, e: a.s };
        return { x: zero, y: zero, z: a.x || { type: 'num', v: a.deg, s: a.s, e: a.e }, s: a.s, e: a.e };
      }
      const open = this.expectP('(');
      const comp = () => { const a = this.angle(); return a.x || { type: 'num', v: a.deg, s: a.s, e: a.e }; };
      const x = comp();
      this.expectP(',', '(a rotation is `(rx, ry, rz)` in degrees, or one angle about z)');
      const y = comp();
      this.expectP(',', '(a rotation is `(rx, ry, rz)` in degrees, or one angle about z)');
      const z = comp();
      const close = this.expectP(')');
      return { x, y, z, s: open.s, e: close.e };
    }

    /** A color: a name (`tin`, `can_blue`, a parameter), "#rrggbb", or an expression
     *  such as `mix(body_color, "#000000", 0.5)`. */
    color() {
      const k = this.cur;
      if (k.t === 'str') { this.advance(); return { type: 'str', value: this.strNode(k), s: k.s, e: k.e }; }
      if (this.exprStart()) return this.expr();
      return this.expected('a color: a "#rrggbb" string or a name such as black, tin or gold');
    }

    // Values
    /** Can an expression start at offset k? A word followed by `:` names a value instead. */
    exprStart(k) {
      const x = this.peek(k);
      if (x.t === 'num') return !x.suffix || !['%', 'deg', 'rad'].includes(x.suffix);
      if (x.t === 'word') return !HARD.has(x.v) && !this.isP(':', (k || 0) + 1);
      return x.t === 'p' && (x.v === '(' || x.v === '-');
    }

    expr() {
      let a = this.term();
      while (this.isP('+') || this.isP('-')) {
        const op = this.advance().v;
        const b = this.term();
        a = { type: 'bin', op, a, b, s: a.s, e: b.e };
      }
      return a;
    }

    term() {
      let a = this.factor();
      while (this.isP('*') || this.isP('/')) {
        const op = this.advance().v;
        const b = this.factor();
        a = { type: 'bin', op, a, b, s: a.s, e: b.e };
      }
      return a;
    }

    factor() {
      const k = this.cur;
      if (this.acceptP('-')) {
        const x = this.primary();
        return { type: 'neg', x, s: k.s, e: x.e };
      }
      return this.primary();
    }

    primary() {
      const k = this.cur;
      if (k.t === 'num') {
        if (k.suffix === '%') this.failAt('a percentage isn\'t allowed here');
        if (k.suffix === 'deg' || k.suffix === 'rad') {
          if (this.marks !== 'angle') this.failAt('an angle isn\'t allowed here');
          this.advance();
          return { type: 'num', v: k.suffix === 'rad' ? (k.v * 180) / Math.PI : k.v, unit: null, s: k.s, e: k.e };
        }
        if (k.axis && this.marks !== 'size') this.markError(k.axis, k);
        this.advance();
        const node = { type: 'num', v: k.v, unit: k.suffix, s: k.s, e: k.e };
        if (k.axis) node.axis = k.axis;
        return node;
      }
      if (k.t === 'word' && !HARD.has(k.v)) {
        if (this.isP(':', 1)) this.failAt(`expected a value before \`${k.v}:\``);
        // a function call: the name touches its `(` (so table cells `D (D - 1)` stay two)
        if (this.isP('(', 1) && this.peek(1).s === k.e) {
          this.advance();
          this.advance();
          const args = [];
          if (!this.isP(')')) {
            do args.push(this.withMarks(this.marks === 'size' ? null : this.marks, () => this.expr())); while (this.acceptP(','));
          }
          const close = this.expectP(')', `to close \`${k.v}(…)\``);
          return { type: 'call', name: k.v, args, s: k.s, e: close.e, nameE: k.e };
        }
        this.advance();
        return { type: 'id', name: k.v, s: k.s, e: k.e };
      }
      if (k.t === 'str') { this.advance(); return { type: 'str', value: this.strNode(k), s: k.s, e: k.e }; }
      if (this.isP('(')) {
        this.advance();
        const x = this.expr();
        const close = this.expectP(')');
        const node = { type: 'paren', x, s: k.s, e: close.e };
        // `(D - 0.2)w`: a side mark right after the parenthesis
        const m = this.cur;
        if (m.t === 'word' && m.s === close.e && (m.v === 'w' || (m.v === 'h' && this.marks === 'size'))) {
          if (this.marks !== 'size') this.markError(m.v, m);
          this.advance();
          node.axis = m.v; node.e = m.e;
        }
        return node;
      }
      if (k.t === 'word') this.failAt(`expected a value, found \`${k.v}\``);
      return this.expected('a number');
    }

    /** `W x L`. A side marked `w` or `h` (`1.6h x 1.1w`) goes in that slot whatever its place. */
    size() { return this.sizeOrOne(true); }
    /** `W x L`, or (unless a size is required) a single value: { v }. */
    sizeOrOne(required) {
      return this.withMarks('size', () => {
        let w = this.expr();
        const mw = this.sideMark(w);
        if (!required && !this.isWord('x')) {
          if (mw) throw new ParseError(`\`${mw}\` marks a side of a size, but this is a single value`, w.s, w.e);
          return { v: w };
        }
        this.expectWord('x', '(sizes are written `WIDTH x LENGTH`)');
        let l = this.expr();
        const ml = this.sideMark(l);
        if (mw && mw === ml) throw new ParseError(`both sides are marked \`${mw}\`: mark one \`w\` and the other \`h\``, w.s, l.e);
        const s = w.s, e = l.e;
        if (mw === 'h' || ml === 'w') [w, l] = [l, w];
        return { w, l, s, e };
      });
    }
    /** The side mark on an operand of a size. It must come last: `1.1w`, `(e / 2)w`. */
    sideMark(x) {
      let mark = null;
      const walk = (n) => {
        if (n.axis) {
          if (n.e !== x.e) throw new ParseError(`put \`${n.axis}\` after the whole side: \`(${'...'})${n.axis}\``, n.s, n.e);
          mark = n.axis;
        }
        for (const k of ['a', 'b', 'x']) if (n[k] && typeof n[k] === 'object') walk(n[k]);
      };
      walk(x);
      return mark;
    }
    markError(mark, tok) {
      this.failAt({
        body: 'a body is always `W x L x H`, so it takes no `w` or `h` marks',
        box: 'a box is always `W x L x H`, so it takes no `w` or `h` marks',
        cell: 'a table cell holds a plain value; mark the sides in the template\'s sizes instead',
      }[this.marks] || `\`${mark}\` marks a side of a size, as in \`rect 1.1w x 1.6h\`, and can't be used here`, tok);
    }

    point() {
      const open = this.expectP('(', '(a point `(x, y)`)');
      const x = this.expr();
      this.expectP(',', 'between the x and y of a point');
      const y = this.expr();
      const close = this.expectP(')');
      return { x, y, s: open.s, e: close.e };
    }

    /** `(x, y)` or `(x, y, z)`. */
    point3opt() {
      const open = this.expectP('(', '(a point `(x, y)` or `(x, y, z)`)');
      const x = this.expr();
      this.expectP(',', 'between the coordinates');
      const y = this.expr();
      const z = this.acceptP(',') ? this.expr() : null;
      const close = this.expectP(')');
      return { x, y, z, s: open.s, e: close.e };
    }

    point3() {
      const open = this.expectP('(');
      const x = this.expr();
      this.expectP(',');
      const y = this.expr();
      this.expectP(',');
      const z = this.expr();
      const close = this.expectP(')');
      return { x, y, z, s: open.s, e: close.e };
    }
  }

  // Hints
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[m][n];
  }
  function suggest(word, candidates) {
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = levenshtein(word.toLowerCase(), String(c).toLowerCase());
      if (d < bestD) { bestD = d; best = c; }
    }
    const limit = Math.max(1, Math.floor(String(word).length / 3));
    return bestD <= limit ? best : null;
  }

  return { parse, ParseError, suggest, levenshtein, SHAPES, ANCHORS, HARD };
});
