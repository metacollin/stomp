/* stomp live demo: the parser.
 *
 * Recursive descent over the tokens, following grammar.peg rule by rule (choices
 * are tried in the grammar's order). Every node has its source range { s, e }
 * (character offsets), and statements also record the file's `units` setting.
 *
 * Errors are recovered one statement at a time: a bad statement is reported and
 * skipped to its end at the same brace depth, so one typo doesn't hide the rest
 * of the footprint. An inner block ({ ... } after a pad, or in silk, model or
 * pins) that runs into a footprint-level keyword is taken to be missing its
 * closing brace.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).parser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ParseError extends Error {
    constructor(message, s, e) { super(message); this.s = s; this.e = e; }
  }

  const SHAPES = new Set(['rect', 'oval', 'roundrect', 'dshape', 'circle', 'polygon']);
  const KINDS = new Set(['pad', 'hole', 'row', 'group', 'ball']);
  const SIDE_WORDS = new Set(['left', 'right', 'top', 'bottom']);
  const ANCHORS = new Set(['center', 'inner', 'outer', 'left', 'right', 'top', 'bottom']);
  const UNITS = new Set(['mm', 'um', 'nm', 'mil', 'in']);
  const LEAD_FORMS = new Set(['gullwing', 'jlead', 'flat', 'endcap', 'ball', 'pin', 'wire', 'tab', 'castellated']);
  const ARRANGEMENTS = new Set(['dual', 'quad', 'horizontal', 'vertical']);
  const SCHEMES = new Set(['ccw', 'cw', 'zigzag', 'row-major', 'col-major', 'bga']);
  const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  const PAD_PROPS = new Set(['rotate', 'mask', 'paste', 'vias']);
  const META = new Set(['description', 'datasheet', 'manufacturer', 'mpn', 'refdes']);

  // words that begin a footprint-level statement (for inner-block recovery and hints)
  const STMT_WORDS = [
    'description', 'datasheet', 'manufacturer', 'mpn', 'refdes', 'tags', 'let', 'origin', 'body', 'pins',
    'balls', 'lead', 'thermal', 'span', 'gap', 'pitch', 'density', 'omit', 'only', 'pin1', 'polarized',
    'default', 'pad', 'pads', 'hole', 'delete', 'row', 'group', 'align', 'silk', 'courtyard', 'assembly',
    'text', 'model', 'no', 'name', 'footprint', 'footprints', 'template', 'units'];
  const STMT_SET = new Set(STMT_WORDS);
  const INNER = {
    pad: new Set(['shape', 'size', 'width', 'length', 'drill', 'rotate', 'mask', 'paste', 'vias']),
    gfx: new Set(['outline', 'line', 'arc', 'circle', 'rect', 'polygon', 'text']),
    model: new Set(['standoff', 'height', 'draft', 'body', 'leads', 'pin1', 'box', 'cylinder', 'step']),
    sides: new Set(['left', 'right', 'top', 'bottom']),
  };

  function describe(k) {
    switch (k.t) {
      case 'nl': return 'end of line';
      case 'eof': return 'end of file';
      case 'str': return k.parts ? 'a string' : `"${k.v}"`;
      case 'num': return `\`${k.text}\``;
      default: return `\`${k.v}\``;
    }
  }

  function parse(tokens, diags) {
    return new Parser(tokens, diags).file();
  }

  class Parser {
    constructor(tokens, diags) {
      this.t = tokens;
      this.i = 0;
      this.diags = diags;
      this.unit = 'mm';
    }

    // Token cursor
    get cur() { return this.t[this.i]; }
    peek(k) { return this.t[Math.min(this.i + (k || 0), this.t.length - 1)]; }
    advance() { const k = this.t[this.i]; if (k.t !== 'eof') this.i++; return k; }
    prevEnd() { return this.i > 0 ? this.t[this.i - 1].e : 0; }
    isWord(v, k) { const x = this.peek(k); return x.t === 'word' && x.v === v; }
    isP(v, k) { const x = this.peek(k); return x.t === 'p' && x.v === v; }
    acceptWord(v) { return this.isWord(v) ? this.advance() : null; }
    acceptP(v) { return this.isP(v) ? this.advance() : null; }
    expectWord(v, what) {
      if (this.isWord(v)) return this.advance();
      return this.expected(`\`${v}\`${what ? ' ' + what : ''}`);
    }
    expectP(v, what) {
      if (this.isP(v)) return this.advance();
      return this.expected(`\`${v}\`${what ? ' ' + what : ''}`);
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

    atStmtEnd() {
      const k = this.cur;
      return k.t === 'nl' || k.t === 'eof' || (k.t === 'p' && (k.v === ';' || k.v === '}'));
    }
    skipEOS() { while (this.cur.t === 'nl' || this.isP(';')) this.advance(); }
    endStmt() {
      if (this.softEnd) { this.softEnd = false; return; }   // an inner block was force-closed
      if (this.atStmtEnd()) return;
      this.failAt(`unexpected ${describe(this.cur)} — expected the end of the statement`);
    }
    /** Skip to the end of the current statement at brace depth 0. */
    sync() {
      let depth = 0;
      while (this.cur.t !== 'eof') {
        const k = this.cur;
        if (k.t === 'p' && k.v === '{') depth++;
        else if (k.t === 'p' && k.v === '}') { if (depth === 0) return; depth--; }
        else if (depth === 0 && (k.t === 'nl' || (k.t === 'p' && k.v === ';'))) return;
        this.advance();
      }
    }

    /** `{ stmt EOS ... }` with per-statement recovery. */
    block(parseStmt, inner) {
      const open = this.expectP('{');
      const stmts = [];
      this.skipEOS();
      while (!this.isP('}') && this.cur.t !== 'eof') {
        const k = this.cur;
        if (k.t === 'word' && STMT_SET.has(k.v) && !(inner && inner.has(k.v)) && (inner || k.v === 'footprint' || k.v === 'footprints' || k.v === 'template' || k.v === 'units')) {
          this.diags.push({
            severity: 'error', message: `missing \`}\` to close the block opened on line ${open.line}`,
            s: open.s, e: open.e, syntax: true,
          });
          this.softEnd = true;
          return { stmts, open, close: null };
        }
        const start = this.i;
        const outerTarget = this.stmtTarget;
        this.stmtTarget = null;
        try {
          const st = parseStmt();
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
      if (this.cur.t === 'eof') {
        this.diags.push({
          severity: 'error', message: `missing \`}\` to close the block opened on line ${open.line}`,
          s: open.s, e: open.e, syntax: true,
        });
        return { stmts, open, close: null };
      }
      const close = this.advance();
      return { stmts, open, close };
    }

    // File
    file() {
      const items = [];
      this.skipEOS();
      while (this.cur.t !== 'eof') {
        const start = this.i;
        try {
          const it = this.topStmt();
          if (it) items.push(it);          // kept even if junk follows it
          this.endStmt();
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          this.report(err);
          this.sync();
          if (this.i === start) this.advance();
        }
        this.skipEOS();
      }
      return { type: 'File', items };
    }

    topStmt() {
      const k = this.cur;
      const s = k.s;
      let node;
      if (this.isWord('units')) {
        this.advance();
        const u = this.cur;
        if (u.t !== 'word' || !UNITS.has(u.v)) this.expected('a unit: mm, um, nm, mil or in');
        this.advance();
        this.unit = u.v;
        node = { type: 'Units', unit: u.v };
      } else if (this.isWord('let')) {
        node = this.letStmt();
      } else if (this.isWord('template')) {
        node = this.template();
      } else if (this.isWord('footprint')) {
        node = this.footprint();
      } else if (this.isWord('footprints')) {
        node = this.table();
      } else if (k.t === 'word' && STMT_SET.has(k.v)) {
        this.failAt(`\`${k.v}\` statements belong inside a \`footprint "NAME" { … }\` block`);
      } else {
        this.expected('`footprint`, `footprints`, `template`, `let` or `units`');
      }
      node.s = s; node.e = this.prevEnd(); node.unit = node.unit && node.type === 'Units' ? node.unit : this.unit;
      return node;
    }

    letStmt() {
      this.expectWord('let');
      const k = this.cur;
      if (k.t === 'word' && k.kw) this.failAt(`\`${k.v}\` is a reserved word and can't be a \`let\` name`);
      if (k.t !== 'word') this.expected('a name for the `let`');
      this.advance();
      this.expectP('=', `after \`let ${k.v}\``);
      const x = this.expr();
      return { type: 'Let', name: k.v, nameS: k.s, nameE: k.e, x };
    }

    template() {
      this.expectWord('template');
      const k = this.cur;
      if (k.t !== 'word' || k.kw) this.expected('a template name (an identifier)');
      this.advance();
      this.expectP('(', 'to open the parameter list');
      const params = [];
      if (!this.isP(')')) {
        do {
          const p = this.cur;
          if (p.t === 'word' && p.kw) this.failAt(`\`${p.v}\` is a keyword and can't be a template parameter`);
          if (p.t !== 'word') this.expected('a parameter name');
          this.advance();
          let def = null;
          if (this.acceptP('=')) def = this.expr();
          params.push({ name: p.v, def, s: p.s, e: this.prevEnd() });
        } while (this.acceptP(','));
      }
      this.expectP(')');
      const blk = this.block(() => this.statement());
      return { type: 'Template', name: k.v, nameS: k.s, nameE: k.e, params, body: blk.stmts, open: blk.open };
    }

    footprint() {
      this.expectWord('footprint');
      // `footprint from qfn(...)` can leave the name to the template
      const name = this.isWord('from') ? null : this.name('a footprint name, or `from TEMPLATE(…)`');
      const node = { type: 'Footprint', name: name ? name.name : null, nameS: name ? name.s : null, nameE: name ? name.e : null, mode: 'block', body: null };
      if (name && this.acceptWord('extends')) {
        node.mode = 'extends';
        node.parent = this.name('the parent footprint name');
        node.body = this.block(() => this.statement()).stmts;
      } else if (this.acceptWord('from')) {
        node.mode = 'from';
        const t = this.cur;
        if (t.t !== 'word' || t.kw) this.expected('a template name');
        this.advance();
        node.template = { name: t.v, s: t.s, e: t.e };
        node.args = this.callArgs();
        node.callS = t.s;
        node.callE = this.prevEnd();
        if (!name) { node.nameS = t.s; node.nameE = node.callE; }
        if (this.isP('{')) node.body = this.block(() => this.statement()).stmts;
      } else if (this.isP('{')) {
        node.body = this.block(() => this.statement()).stmts;
      } else {
        this.expected('`{`, `extends` or `from` after the footprint name');
      }
      return node;
    }

    /** `( arg, key = arg, ... )` */
    callArgs() {
      this.expectP('(');
      const args = [];
      if (!this.isP(')')) {
        do {
          const s = this.cur.s;
          let key = null;
          if (this.cur.t === 'word' && !this.cur.kw && this.isP('=', 1)) { key = this.advance().v; this.advance(); }
          const x = this.expr();
          args.push({ key, x, s, e: this.prevEnd() });
        } while (this.acceptP(','));
      }
      this.expectP(')');
      return args;
    }

    /**
     * footprints from TEMPLATE [(fixed args)] {
     *   COLUMN COLUMN ...      header: template parameter names
     *   cell   cell   ...      one row per footprint
     * }
     */
    table() {
      this.expectWord('footprints');
      this.expectWord('from', '(`footprints from TEMPLATE { … }`)');
      const t = this.cur;
      if (t.t !== 'word' || t.kw) this.expected('a template name');
      this.advance();
      const node = { type: 'Table', template: { name: t.v, s: t.s, e: t.e }, args: [], header: [], rows: [] };
      if (this.isP('(')) node.args = this.callArgs();
      node.callS = t.s;
      node.callE = this.prevEnd();
      const open = this.expectP('{', 'and a table: a header row of parameter names, then one row per footprint');
      this.skipEOS();
      node.headerS = this.cur.s;
      while (this.cur.t === 'word') {
        const h = this.cur;
        if (h.kw) this.failAt(`\`${h.v}\` is a keyword, so it can't be a template parameter or head a column`);
        this.advance();
        node.header.push({ name: h.v, s: h.s, e: h.e });
      }
      if (!node.header.length) this.expected('a header row naming the template parameter each column fills');
      node.headerE = this.prevEnd();
      if (!this.atStmtEnd()) this.failAt(`the header row holds parameter names only — found ${describe(this.cur)}`);
      this.skipEOS();
      while (!this.isP('}') && this.cur.t !== 'eof') {
        const start = this.i;
        const rs = this.cur.s;
        try {
          const cells = [];
          while (!this.atStmtEnd()) cells.push(this.cell());
          const re = this.prevEnd();
          if (cells.length !== node.header.length) {
            const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
            throw new ParseError(`this row has ${plural(cells.length, 'value')} but the header names ${plural(node.header.length, 'column')}`, rs, re);
          }
          node.rows.push({ cells, s: rs, e: re, line: this.t[start].line });
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          this.report(err);
          this.sync();
          if (this.i === start) this.advance();
        }
        this.skipEOS();
      }
      if (this.cur.t === 'eof') {
        this.diags.push({ severity: 'error', message: `missing \`}\` to close the table opened on line ${open.line}`, s: open.s, e: open.e, syntax: true });
      } else this.advance();
      return node;
    }

    /** One table cell: a number, a name, a "string" or a (parenthesized expression). */
    cell() {
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
      if (k.t === 'num' || (k.t === 'word' && !k.kw)) { const x = this.primary(); return { x, s: x.s, e: x.e }; }
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
      if (k.t === 'word') {
        switch (k.v) {
          case 'description': case 'datasheet': case 'manufacturer': case 'mpn': case 'refdes': {
            this.advance();
            const v = this.cur;
            if (v.t !== 'str') this.expected(`a "quoted string" after \`${k.v}\``);
            this.advance();
            node = { type: 'Meta', key: k.v, value: this.strNode(v) };
            break;
          }
          case 'name': {
            this.advance();
            const v = this.cur;
            if (v.t !== 'str') this.expected('the footprint name as a "string", e.g. `name "QFN-{n}"`');
            this.advance();
            node = { type: 'Name', value: this.strNode(v), vs: v.s, ve: v.e };
            break;
          }
          case 'tags': {
            this.advance();
            const tags = [this.name('a tag').name];
            while (this.acceptP(',')) tags.push(this.name('a tag').name);
            node = { type: 'Meta', key: 'tags', value: tags };
            break;
          }
          case 'let': node = this.letStmt(); break;
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
            this.advance();
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
            this.advance();
            const v = this.cur;
            if (v.t !== 'word' || !['dot', 'chamfer', 'notch', 'bar', 'none'].includes(v.v)) {
              this.expected('a pin-1 marker: `dot`, `chamfer`, `notch`, `bar` or `none`');
            }
            this.advance();
            node = { type: 'Pin1', style: v.v };
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
            if (!this.isP('{')) this.expected('a `{ … }` block of pad properties after the selector');
            node = { type: 'Pads', sel, block: this.padBlock() };
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
            this.advance();
            if (this.acceptWord('auto')) node = { type: 'Layer', layer: k.v, mode: 'auto' };
            else if (this.acceptWord('none')) node = { type: 'Layer', layer: k.v, mode: 'none' };
            else if (this.isP('{')) node = { type: 'Layer', layer: k.v, mode: 'block', items: this.gfxBlock() };
            else this.expected('`auto`, `none` or a `{ … }` block');
            break;
          }
          case 'courtyard': {
            this.advance();
            if (this.acceptWord('auto')) {
              node = { type: 'Layer', layer: 'courtyard', mode: 'auto', clearance: this.exprStart() ? this.expr() : null };
            } else if (this.acceptWord('rect')) {
              node = { type: 'Layer', layer: 'courtyard', mode: 'rect', size: this.size() };
            } else if (this.isP('{')) {
              node = { type: 'Layer', layer: 'courtyard', mode: 'block', items: this.gfxBlock() };
            } else this.expected('`auto`, `rect W x L` or a `{ … }` block');
            break;
          }
          case 'text': node = this.text(); break;
          case 'model': case 'no': node = this.model(); break;
          case 'footprint': case 'template': case 'units':
            this.failAt(`\`${k.v}\` can't appear inside a block — is a \`}\` missing above?`);
            break;
          default: node = this.placement();
        }
      } else {
        node = this.placement();
      }
      node.s = s; node.e = this.prevEnd(); node.unit = this.unit;
      return node;
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

    bodyOrPlacement() {
      if (this.isWord('cylinder', 1)) {
        this.advance(); this.advance();
        this.expectWord('d', '(cylinder diameter: `body cylinder d 8 h 11.5`)');
        const d = this.expr();
        this.expectWord('h', '(cylinder height)');
        const h = this.expr();
        return { type: 'Body', cyl: true, d, h };
      }
      if (this.exprStart(1)) {
        this.advance();
        const w = this.expr();
        this.expectWord('x', 'between body width and length (`body 3.9 x 4.9 x 1.5`)');
        const l = this.expr();
        const h = this.acceptWord('x') ? this.expr() : null;
        return { type: 'Body', w, l, h };
      }
      return this.placement();
    }

    pins() {
      this.expectWord('pins');
      if (this.isP('{')) return { type: 'Pins', form: 'sides', sides: this.sidesBlock(), clauses: {} };
      if (this.acceptWord('grid')) {
        const nx = this.count();
        this.expectWord('x', '(`pins grid COLS x ROWS`)');
        const ny = this.count();
        return { type: 'Pins', form: 'grid', nx, ny, clauses: this.pinsClauses() };
      }
      const count = this.count();
      let arrangement = null, side = null;
      const a = this.cur;
      if (a.t === 'word' && ARRANGEMENTS.has(a.v)) { this.advance(); arrangement = a.v; }
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
      if (k.t === 'word' && !k.kw) { this.advance(); return { id: k.v, s: k.s, e: k.e }; }
      if (k.t === 'num') this.failAt(`a count must be a whole number, found \`${k.text}\``);
      return this.expected('a pin count');
    }

    pinsClauses() {
      const c = {};
      const once = (key, tok) => { if (c[key]) this.failAt(`\`${key}\` is given twice`, tok); };
      for (;;) {
        const k = this.cur;
        if (this.isWord('pitch')) {
          once('pitch', k); this.advance();
          const x = this.expr();
          const y = this.acceptWord('x') ? this.expr() : null;
          c.pitch = { x, y, s: k.s, e: this.prevEnd() };
        } else if (this.isWord('span')) {
          once('span', k); this.advance();
          const x = this.expr();
          c.span = { x, qual: this.spanQual(), s: k.s, e: this.prevEnd() };
        } else if (this.isWord('pad')) {
          once('pad', k); this.advance();
          c.pad = this.padGeom();
        } else if (this.isWord('numbering')) {
          once('numbering', k); this.advance();
          const v = this.cur;
          if (v.t !== 'word' || !SCHEMES.has(v.v)) this.expected('a numbering scheme: ccw, cw, zigzag, row-major, col-major or bga');
          this.advance();
          c.numbering = { v: v.v, s: v.s, e: v.e };
        } else if (this.isWord('start')) {
          once('start', k); this.advance();
          const v = this.cur;
          if (v.t !== 'word' || !CORNERS.has(v.v)) this.expected('a corner: top-left, top-right, bottom-left or bottom-right');
          this.advance();
          c.start = { v: v.v, s: v.s, e: v.e };
        } else break;
      }
      return c;
    }

    sidesBlock() {
      return this.block(() => {
        const k = this.cur;
        const side = this.sideWord();
        this.expectP(':', `after \`${side}\``);
        const positions = [];
        do {
          const p = this.cur;
          if (this.acceptWord('nc')) positions.push({ nc: true, s: p.s, e: p.e });
          else { const nm = this.name('a pin name or `nc`'); positions.push({ name: nm.name, s: nm.s, e: nm.e }); }
        } while (this.acceptP(','));
        const pitch = this.acceptWord('pitch') ? this.expr() : null;
        return { side, positions, pitch, s: k.s, e: this.prevEnd() };
      }, INNER.sides).stmts;
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
            this.expected('a lead form for these pins (gullwing, jlead, flat, endcap, ball, pin, wire, tab, castellated) or `none`');
          }
        } else {
          this.expected('a lead form: gullwing, jlead, flat, endcap, ball, pin, wire, tab or castellated');
        }
      }
      this.advance();
      let dims = null;
      if (this.acceptWord('d')) dims = { d: this.expr() };
      else if (this.exprStart()) {
        const a = this.expr();
        dims = this.acceptWord('x') ? { w: a, l: this.expr() } : { v: a };
      }
      let span = null;
      if (this.isWord('span')) {
        const k = this.advance();
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
      const block = this.isP('{') ? this.padBlock() : null;
      return { type: 'Thermal', name, size, block };
    }

    measure() {
      const word = this.advance().v;
      const save = this.i;
      let a = null;
      try { a = this.objref(); } catch (err) { if (!(err instanceof ParseError)) throw err; a = null; }
      if (a && this.isWord('to')) {
        this.advance();
        const b = this.objref();
        this.expectWord('is', `(\`${word} A to B is VALUE\`)`);
        const x = this.expr();
        return { type: 'MeasurePair', word, a, b, x, axis: this.axisAdv() };
      }
      this.i = save;
      const x = this.expr();
      return { type: 'MeasureBare', word, x, qual: this.spanQual() };
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

    padOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a pad name');
      this.stmtTarget = { kind: 'pad', name: name.name };
      const k = this.cur;
      if (this.isWord('tht') || (k.t === 'word' && SHAPES.has(k.v))) {
        return { type: 'Pad', name, geom: this.padGeom() };
      }
      if (this.isP('{')) return { type: 'Pad', name, block: this.padBlock() };
      this.i = save;
      return this.placement('a pad shape, `{`, `at`, `is` or `mirrors`');
    }

    holeOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a hole name');
      this.stmtTarget = { kind: 'hole', name: name.name };
      if (this.acceptWord('slot')) return { type: 'Hole', name, slot: this.size() };
      if (this.exprStart()) return { type: 'Hole', name, d: this.expr() };
      this.i = save;
      return this.placement('a hole diameter, `slot W x L`, `at`, `is` or `mirrors`');
    }

    rowOrPlacement() {
      const save = this.i;
      this.advance();
      const name = this.name('a row name');
      if (this.acceptWord('pads')) {
        const sel = this.selList();
        this.expectWord('pitch', '(`row NAME pads 1..4 pitch P going down`)');
        const pitch = this.expr();
        let going = null;
        if (this.acceptWord('going')) {
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
        this.advance();
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
    padGeom() {
      const s = this.cur.s;
      const tht = !!this.acceptWord('tht');
      const shape = this.shapeSpec();
      const drill = this.isWord('drill') ? this.drillSpec() : null;
      const props = [];
      while (this.cur.t === 'word' && PAD_PROPS.has(this.cur.v)) props.push(this.padProp());
      return { tht, shape, drill, props, s, e: this.prevEnd() };
    }

    shapeSpec() {
      const k = this.cur;
      if (k.t !== 'word' || !SHAPES.has(k.v)) this.expected('a pad shape: rect, oval, roundrect, dshape, circle or polygon');
      this.advance();
      const s = k.s;
      switch (k.v) {
        case 'rect': case 'oval': return { kind: k.v, size: this.size(), s, e: this.prevEnd() };
        case 'roundrect': {
          const size = this.size();
          this.expectWord('r', 'and a corner radius (`r 25%` or `r 0.1`)');
          const r = this.lengthOrPct();
          return { kind: 'roundrect', size, r, s, e: this.prevEnd() };
        }
        case 'dshape': {
          const size = this.size();
          const flat = this.acceptWord('flat') ? this.sideWord() : null;
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
      const k = this.expectWord('drill');
      if (this.acceptWord('slot')) return { slot: this.size(), s: k.s, e: this.prevEnd() };
      return { d: this.expr(), s: k.s, e: this.prevEnd() };
    }

    padProp() {
      const k = this.advance();
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
            if (this.acceptWord('coverage')) coverage = this.percent();
            else if (this.acceptWord('gutter')) gutter = this.expr();
            return { prop: 'paste', mode: 'divide', nx, ny, coverage, gutter, s, e: this.prevEnd() };
          }
          return { prop: 'paste', mode: 'expand', value: this.signedExpr(), s, e: this.prevEnd() };
        default: {   // vias
          const nx = this.count();
          this.expectWord('x');
          const ny = this.count();
          this.expectWord('drill');
          const drill = this.expr();
          this.expectWord('pitch');
          const pitch = this.expr();
          return { prop: 'vias', nx, ny, drill, pitch, s, e: this.prevEnd() };
        }
      }
    }

    padBlock() {
      const blk = this.block(() => {
        const k = this.cur;
        const s = k.s;
        if (this.acceptWord('shape')) return { op: 'shape', shape: this.shapeSpec(), s, e: this.prevEnd() };
        if (this.acceptWord('size')) return { op: 'size', size: this.size(), s, e: this.prevEnd() };
        if (this.acceptWord('width')) return { op: 'width', x: this.expr(), s, e: this.prevEnd() };
        if (this.acceptWord('length')) return { op: 'length', x: this.expr(), s, e: this.prevEnd() };
        if (this.isWord('drill')) return { op: 'drill', drill: this.drillSpec(), s, e: this.prevEnd() };
        if (k.t === 'word' && PAD_PROPS.has(k.v)) return { op: 'prop', prop: this.padProp(), s, e: this.prevEnd() };
        return this.expected('a pad property: shape, size, width, length, drill, rotate, mask, paste or vias');
      }, INNER.pad);
      return blk.stmts;
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

    angle() {
      const s = this.cur.s;
      const neg = !!this.acceptP('-');
      const k = this.cur;
      if (k.t !== 'num' || k.suffix === '%' || (k.suffix && !['deg', 'rad'].includes(k.suffix))) {
        this.expected('an angle such as `45`, `45deg` or `0.7854rad`');
      }
      this.advance();
      let suffix = k.suffix;
      if (!suffix && (this.isWord('deg') || this.isWord('rad'))) suffix = this.advance().v;
      let v = k.v * (neg ? -1 : 1);
      if (suffix === 'rad') v = (v * 180) / Math.PI;
      return { deg: v, s, e: this.prevEnd() };
    }

    // Graphics
    gfxBlock() {
      return this.block(() => this.gfxStmt(), INNER.gfx).stmts;
    }

    gfxStmt() {
      const k = this.cur;
      const s = k.s;
      const width = () => (this.acceptWord('width') ? this.expr() : null);
      const fillOrWidth = (node) => {
        if (this.acceptWord('fill')) node.fill = true;
        else node.width = width();
        return node;
      };
      let node;
      if (this.acceptWord('outline')) {
        this.expectWord('body', '(`outline body offset 0.15`)');
        node = { op: 'outline', offset: this.acceptWord('offset') ? this.expr() : null };
      } else if (this.acceptWord('line')) {
        node = { op: 'line', a: this.point(), b: this.point() };
        node.width = width();
      } else if (this.acceptWord('arc')) {
        const c = this.point();
        this.expectWord('r');
        const r = this.expr();
        this.expectWord('from');
        const from = this.angle();
        this.expectWord('to');
        const to = this.angle();
        node = { op: 'arc', c, r, from, to, width: width() };
      } else if (this.acceptWord('circle')) {
        const c = this.point();
        this.expectWord('d', '(circle diameter)');
        node = fillOrWidth({ op: 'circle', c, d: this.expr() });
      } else if (this.acceptWord('rect')) {
        const c = this.point();
        node = fillOrWidth({ op: 'rect', c, size: this.size() });
      } else if (this.acceptWord('polygon')) {
        const pts = [this.point(), this.point(), this.point()];
        while (this.isP('(')) pts.push(this.point());
        node = { op: 'polygon', pts, fill: !!this.acceptWord('fill') };
      } else if (this.isWord('text')) {
        node = this.text();
        node.op = 'text';
      } else {
        return this.expected('a graphic: outline, line, arc, circle, rect, polygon or text');
      }
      node.s = s; node.e = this.prevEnd();
      return node;
    }

    text() {
      this.expectWord('text');
      const k = this.cur;
      let which;
      if (this.acceptWord('ref')) which = { field: 'ref' };
      else if (this.acceptWord('value')) which = { field: 'value' };
      else if (k.t === 'str') { this.advance(); which = { str: this.strNode(k) }; }
      else this.expected('`ref`, `value` or a "string"');
      this.expectWord('at');
      const at = this.point();
      const size = this.acceptWord('size') ? this.expr() : null;
      let layer = null;
      if (this.acceptWord('layer')) {
        const l = this.cur;
        if (l.t !== 'word' || !['silk', 'assembly', 'copper', 'mask'].includes(l.v)) this.expected('`silk`, `assembly`, `copper` or `mask`');
        this.advance();
        layer = l.v;
      }
      return { type: 'Text', which, at, size, layer };
    }

    model() {
      if (this.acceptWord('no')) {
        this.expectWord('model', 'after `no`');
        return { type: 'Model', none: true };
      }
      this.expectWord('model');
      const props = this.block(() => {
        const k = this.cur;
        const s = k.s;
        let p;
        if (this.acceptWord('standoff')) p = { key: 'standoff', x: this.expr() };
        else if (this.acceptWord('height')) p = { key: 'height', x: this.expr() };
        else if (this.acceptWord('draft')) p = { key: 'draft', angle: this.angle() };
        else if (this.acceptWord('body')) {
          this.expectWord('color', 'after `body` (`body color …`)');
          p = { key: 'bodyColor', color: this.color() };
        } else if (this.acceptWord('leads')) {
          if (this.acceptWord('color')) p = { key: 'leadsColor', color: this.color() };
          else if (this.acceptWord('thickness')) p = { key: 'thickness', x: this.expr() };
          else if (this.acceptWord('below')) p = { key: 'below', x: this.expr() };
          else if (this.acceptWord('above')) p = { key: 'above', x: this.expr() };
          else return this.expected('`color`, `thickness`, `below` or `above` after `leads`');
        } else if (this.acceptWord('pin1')) {
          const v = this.cur;
          if (v.t !== 'word' || !['dimple', 'dot', 'notch', 'stripe', 'none'].includes(v.v)) this.expected('a pin-1 mark: `dimple`, `dot`, `notch`, `stripe` or `none`');
          this.advance();
          p = { key: 'pin1', v: v.v };
        } else if (this.isWord('box') || this.isWord('cylinder')) {
          p = this.solid();
        } else if (this.acceptWord('step')) {
          const f = this.cur;
          if (f.t !== 'str') this.expected('a "file path" for the STEP model');
          this.advance();
          p = { key: 'step', file: this.strNode(f), xform: {} };
          for (;;) {
            if (this.acceptWord('offset')) p.xform.offset = this.point3();
            else if (this.acceptWord('rotate')) p.xform.rotate = this.point3();
            else if (this.acceptWord('scale')) p.xform.scale = this.expr();
            else break;
          }
        } else {
          return this.expected('a model property: standoff, height, draft, body color, leads …, pin1, box, cylinder or step');
        }
        p.s = s; p.e = this.prevEnd();
        return p;
      }, INNER.model).stmts;
      return { type: 'Model', props };
    }

    /** `box W x L x H ...` or `cylinder d D h H ...`, with `at`, `on body`, `rotate` and `color`. */
    solid() {
      const k = this.advance();
      let p;
      if (k.v === 'box') {
        const w = this.expr();
        this.expectWord('x', '(a box is `W x L x H`)');
        const l = this.expr();
        this.expectWord('x', '(a box is `W x L x H`)');
        const h = this.expr();
        p = { key: 'solid', kind: 'box', w, l, h };
      } else {
        this.expectWord('d', 'after `cylinder` (`cylinder d D h H`)');
        const d = this.expr();
        this.expectWord('h', '(a cylinder is `d D h H`)');
        const h = this.expr();
        p = { key: 'solid', kind: 'cyl', d, h };
      }
      for (;;) {
        const c = this.cur;
        if (this.acceptWord('at')) {
          if (p.at) this.failAt('`at` is given twice', c);
          const open = this.expectP('(', '(a point `(x, y)` or `(x, y, z)`)');
          const x = this.expr();
          this.expectP(',', 'between the coordinates');
          const y = this.expr();
          const z = this.acceptP(',') ? this.expr() : null;
          const close = this.expectP(')');
          p.at = { x, y, z, s: open.s, e: close.e };
        } else if (this.acceptWord('on')) {
          this.expectWord('body', 'after `on` (`on body`)');
          p.onBody = true;
        } else if (this.acceptWord('rotate')) p.rotate = this.point3();
        else if (this.acceptWord('color')) p.color = this.color();
        else break;
      }
      return p;
    }

    color() {
      const k = this.cur;
      if (k.t === 'str') { this.advance(); return this.strNode(k); }
      // any word: some color names (`copper`) are also keywords; compile checks the name
      if (k.t === 'word' && !STMT_SET.has(k.v)) { this.advance(); return k.v; }
      return this.expected('a color: a "#rrggbb" string or a name such as black, tin or gold');
    }

    // Values
    exprStart(k) {
      const x = this.peek(k);
      if (x.t === 'num') return !x.suffix || !['%', 'deg', 'rad'].includes(x.suffix);
      if (x.t === 'word') return !x.kw;
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
        if (k.suffix === 'deg' || k.suffix === 'rad') this.failAt('an angle isn\'t allowed here');
        this.advance();
        return { type: 'num', v: k.v, unit: k.suffix, s: k.s, e: k.e };
      }
      if (k.t === 'word' && !k.kw) { this.advance(); return { type: 'id', name: k.v, s: k.s, e: k.e }; }
      if (k.t === 'str') { this.advance(); return { type: 'str', value: this.strNode(k), s: k.s, e: k.e }; }
      if (this.isP('(')) {
        this.advance();
        const x = this.expr();
        const close = this.expectP(')');
        return { type: 'paren', x, s: k.s, e: close.e };
      }
      if (k.t === 'word' && k.kw) this.failAt(`expected a number, found the keyword \`${k.v}\``);
      return this.expected('a number');
    }

    size() {
      const w = this.expr();
      this.expectWord('x', '(sizes are written `WIDTH x LENGTH`)');
      const l = this.expr();
      return { w, l, s: w.s, e: l.e };
    }

    point() {
      const open = this.expectP('(', '(a point `(x, y)`)');
      const x = this.expr();
      this.expectP(',', 'between the x and y of a point');
      const y = this.expr();
      const close = this.expectP(')');
      return { x, y, s: open.s, e: close.e };
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

  return { parse, ParseError, suggest, levenshtein, SHAPES, ANCHORS };
});
