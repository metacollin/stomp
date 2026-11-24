/* stomp live demo: the lexer (the lexical layer of grammar.peg, SPEC 4).
 *
 * Produces two streams:
 *   tokens: what the parser reads. Comments are dropped, and so are newlines that
 *           can't end a statement (inside ( ... ) and after ',' or an operator).
 *   all:    every token, comments included, for syntax highlighting.
 *
 * There are no braces: a block ends with the word `end`. A `{` or `}` is reported,
 * and a `}` still closes a block, so the rest of the file reads as meant.
 *
 * Token: { t, v, s, e, line, col }
 *   t: 'word' | 'num' | 'str' | 'p' (punctuation) | 'nl' | 'comment' | 'bad' | 'eof'
 *   word: v = text, kw = a keyword?           num: v = value, text, suffix, axis, isInt
 *   str:  v = unescaped value                 p:   v = '(' ')' ',' ';' ':' '=' '+' '-' '*' '/' '..'
 *         parts = null, or (interpolated) [{ lit, s, e } | { open, close, codeS, codeE, fmt, toks, all }]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).lexer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Keywords. Only `x` and `end` are reserved everywhere (HARD); the rest mean
  // something only where the grammar expects them, and can be names elsewhere,
  // though an object (a pad, hole, row or group) named after one needs quotes.
  const RESERVED = new Set((
    'above across align and arc assembly at auto ball balls bar below between ' +
    'bga body bottom bottom-left bottom-right box castellated ccw center centered ' +
    'centers chamfer circle col-major color cols column copper courtyard coverage cw ' +
    'cylinder d datasheet default defined deg delete density description ' +
    'dimple divide dot down draft drill dshape dual end endcap extends feature fill flat ' +
    'footprint footprints from gap going grid group gullwing gutter h height hole ' +
    'horizontal horizontally in inner is jlead layer lbend lead leads least left ' +
    'length line manufacturer mask mil mirrors mm model most mpn name nc nm no ' +
    'nominal none notch numbering of offset omit on only origin outer outline ' +
    'oval pad pads paste pin pin1 pins pitch polarized polygon quad r rad ' +
    'rect ref refdes right rotate roundrect row row-major rows scale shape ' +
    'side silk single size slot span standoff start step straight stripe tab tags ' +
    'template text thermal thickness tht to top top-left top-right um units up value ' +
    'vertical vertically vias wire with width x y zigzag ' +
    // 3D solids and feature sections
    'section loft sweep prism sphere disc face slab hatch').split(/\s+/));
  const HARD = new Set(['x', 'end']);
  // words that start a top-level item: an unclosed `(` stops swallowing newlines there
  const RESET = new Set(['end', 'footprint', 'footprints', 'template']);

  const HYPHENATED = ['row-major', 'col-major', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const UNIT_SUFFIX = new Set(['mm', 'um', 'nm', 'mil', 'in']);
  const ANGLE_SUFFIX = new Set(['deg', 'rad']);

  // A number's suffix: a unit or an angle unit, and/or a side mark. `w` and `h` mark
  // which side of a size a number is (`1.6h x 1.1w`), after any unit: `43milw`.
  function splitSuffix(word) {
    if (UNIT_SUFFIX.has(word) || ANGLE_SUFFIX.has(word)) return { unit: word, axis: null };
    const mark = word.slice(-1), unit = word.slice(0, -1);
    if ((mark === 'w' || mark === 'h') && (unit === '' || UNIT_SUFFIX.has(unit))) return { unit: unit || null, axis: mark };
    return null;
  }
  function suffixHint(word, text) {
    if (/^x/.test(word)) return `put spaces around the size separator: \`${text} x ${word.slice(1) || '...'}\``;
    const m = /^([wh])(mm|um|nm|mil|in)$/.exec(word);
    if (m) return `put the unit before the side mark: \`${text}${m[2]}${m[1]}\``;
    if (/^mils?[wh]?$/.test(word) || word === 'mils') return 'write mils as `mil`';
    if (/^inch(es)?$/.test(word)) return 'write inches as `in`';
    if (/^(mm|um|nm|mil|in)?[WH]$/.test(word)) return 'side marks are lowercase: `w` and `h`';
    return 'units are mm, um, nm, mil and in (angles: deg, rad), and `w` and `h` mark the sides of a size';
  }
  const PUNCT = new Set(['(', ')', ',', ';', ':', '=', '+', '-', '*', '/']);
  // a newline right after one of these doesn't end a statement (SPEC 4)
  const JOINERS = new Set([',', '+', '-', '*', '/']);

  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdChar = (c) => isIdStart(c) || isDigit(c);

  function lex(src, diags) {
    const all = [];
    let i = 0, line = 1, lineStart = 0;
    const n = src.length;
    const report = (msg, s, e) => diags && diags.push({ severity: 'error', message: msg, s, e, syntax: true });

    const tok = (t, s, e, extra) => {
      const k = Object.assign({ t, s, e, line, col: s - lineStart + 1 }, extra);
      all.push(k);
      return k;
    };

    while (i < n) {
      const c = src[i];
      const s = i;
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\n') {
        tok('nl', s, s + 1);
        i++; line++; lineStart = i;
        continue;
      }
      if (c === '#') {
        while (i < n && src[i] !== '\n') i++;
        tok('comment', s, i, { v: src.slice(s, i) });
        continue;
      }
      if (c === '"') {
        // interpolation: "text {expr} text {expr:.2}" (SPEC 7); \" \\ \{ \} are escapes
        let lit = '', litS = i + 1, parts = null;
        i++;
        let closed = false;
        while (i < n && src[i] !== '\n') {
          const ch = src[i];
          if (ch === '\\' && /["\\{}]/.test(src[i + 1] || '')) { lit += src[i + 1]; i += 2; continue; }
          if (ch === '"') { closed = true; i++; break; }
          if (ch === '{') {
            const open = i;
            let j = i + 1;
            while (j < n && src[j] !== '}' && src[j] !== '"' && src[j] !== '\n') j++;
            if (src[j] !== '}') {
              report('unclosed `{` in a string — close it with `}`, or write a literal brace as `\\{`', open, j);
              lit += src.slice(open, j);
              i = j;
              continue;
            }
            const inner = src.slice(open + 1, j);
            const colon = inner.lastIndexOf(':');
            let codeE = j, fmt = null, fmtS = null;
            if (colon >= 0) {
              codeE = open + 1 + colon;
              fmtS = codeE;
              const spec = inner.slice(colon + 1).trim();
              if (/^\.\d$/.test(spec)) fmt = +spec.slice(1);
              else report(`unknown format \`:${spec}\` — use \`:.N\` for N decimal places, e.g. \`{e:.2}\``, fmtS, j);
            }
            if (!src.slice(open + 1, codeE).trim()) {
              report('empty `{}` in a string — put an expression inside, or write `\\{\\}` for literal braces', open, j + 1);
            }
            parts = parts || [];
            if (lit) parts.push({ lit, s: litS, e: open });
            lit = '';
            const code = lexRange(src, open + 1, codeE, diags, line, lineStart);
            parts.push({ open, close: j, codeS: open + 1, codeE, fmt, fmtS, toks: code.tokens, all: code.all });
            i = j + 1;
            litS = i;
            continue;
          }
          lit += ch;
          i++;
        }
        if (!closed) report('unterminated string — add a closing "', s, i);
        if (parts && lit) parts.push({ lit, s: litS, e: closed ? i - 1 : i });
        tok('str', s, i, { v: parts ? null : lit, parts });
        continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        while (i < n && isDigit(src[i])) i++;
        let isInt = c !== '.';
        if (c === '.') {                       // .5
          i++;
          while (i < n && isDigit(src[i])) i++;
          isInt = false;
        } else if (src[i] === '.' && src[i + 1] !== '.') {   // 1.25 / 1.   (but 1..4 is INT '..' INT)
          i++;
          while (i < n && isDigit(src[i])) i++;
          isInt = false;
        }
        // an exponent: 1e-9, 2.5E3
        if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1] || '') || ((src[i + 1] === '-' || src[i + 1] === '+') && isDigit(src[i + 2] || '')))) {
          i += src[i + 1] === '-' || src[i + 1] === '+' ? 2 : 1;
          while (i < n && isDigit(src[i])) i++;
          isInt = false;
        }
        const text = src.slice(s, i);
        const value = parseFloat(text.startsWith('.') ? '0' + text : text);
        let suffix = null, axis = null;
        if (src[i] === '%') { suffix = '%'; i++; isInt = false; }
        else if (src[i] === 'x' && /[0-9.(\s-]/.test(src[i + 1] || ' ')) {
          // `0.6x1.5`: the size separator can touch the number, so emit it as its
          // own keyword token
          tok('num', s, i, { v: value, text: src.slice(s, i), num: text, suffix: null, isInt });
          tok('word', i, i + 1, { v: 'x', kw: true });
          i++;
          continue;
        }
        else if (i < n && isIdStart(src[i])) {
          const ss = i;
          let j = i;
          while (j < n && /[A-Za-z]/.test(src[j])) j++;
          let word = src.slice(ss, j);
          const touching = word.length > 1 && word.endsWith('x') && splitSuffix(word.slice(0, -1));
          if (touching && /[0-9.(\s-]/.test(src[j] || ' ')) {
            // `1.1wx1.6h`, `0.6mmx1.5`: the separator touches a suffix
            i = j - 1;
            tok('num', s, i, { v: value, text: src.slice(s, i), num: text, suffix: touching.unit, axis: touching.axis, isInt: false });
            tok('word', i, i + 1, { v: 'x', kw: true });
            i++;
            continue;
          }
          while (j < n && isIdChar(src[j])) j++;
          word = src.slice(ss, j);
          i = j;
          const sf = splitSuffix(word);
          if (sf) { suffix = sf.unit; axis = sf.axis; isInt = false; }
          else {
            report(`unknown suffix \`${word}\` on number ${text} — ${suffixHint(word, text)}`, ss, i);
            tok('bad', s, i, { v: src.slice(s, i) });
            continue;
          }
        }
        tok('num', s, i, { v: value, text: src.slice(s, i), num: text, suffix, axis, isInt });
        continue;
      }
      if (isIdStart(c)) {
        while (i < n && isIdChar(src[i])) i++;
        let word = src.slice(s, i);
        if (src[i] === '-') {
          for (const h of HYPHENATED) {
            if (h.startsWith(word + '-') && src.startsWith(h, s) && !isIdChar(src[s + h.length] || '')) {
              word = h; i = s + h.length; break;
            }
          }
        }
        tok('word', s, i, { v: word, kw: RESERVED.has(word) });
        continue;
      }
      if (c === '.' && src[i + 1] === '.') { i += 2; tok('p', s, i, { v: '..' }); continue; }
      if (c === '{' || c === '}') {
        i++;
        report(c === '{' ? 'stomp has no braces: a block starts on the line after its header, and closes with `end`' : 'close a block with `end`, not `}`', s, i);
        tok('bad', s, i, { v: c, brace: c });
        continue;
      }
      if (PUNCT.has(c)) { i++; tok('p', s, i, { v: c }); continue; }
      // anything else
      i++;
      if (c.charCodeAt(0) > 127) {
        while (i < n && src.charCodeAt(i) > 127 && src[i] !== '\n') i++;
        report('non-ASCII text is only allowed inside "strings" and # comments', s, i);
      } else {
        report(`unexpected character \`${c}\``, s, i);
      }
      tok('bad', s, i, { v: src.slice(s, i) });
    }
    const eof = { t: 'eof', s: n, e: n, line, col: n - lineStart + 1 };

    // significant stream for the parser
    const tokens = [];
    let depth = 0;
    let prev = null;
    for (let k of all) {
      if (k.t === 'comment') continue;
      if (k.t === 'bad') {
        if (k.brace !== '}') continue;
        k = { t: 'word', v: 'end', kw: true, s: k.s, e: k.e, line: k.line, col: k.col, brace: true };
      }
      if (k.t === 'nl') {
        if (depth > 0) continue;
        if (prev && prev.t === 'p' && JOINERS.has(prev.v)) continue;
        if (prev && prev.t === 'nl') continue;          // collapse blank lines
        if (!prev) continue;                             // leading newlines
      }
      if (k.t === 'p' && k.v === '(') depth++;
      if (k.t === 'p' && k.v === ')' && depth > 0) depth--;
      // parentheses never span blocks; resetting keeps an unclosed '(' typed
      // mid-edit from swallowing the newlines of the rest of the file
      if (k.t === 'word' && RESET.has(k.v)) depth = 0;
      tokens.push(k);
      prev = k;
    }
    tokens.push(eof);
    return { tokens, all, eof };
  }

  /** Lex src[a, b) (the code inside a string's {...}) with absolute offsets. */
  function lexRange(src, a, b, diags, line, lineStart) {
    const sub = [];
    const r = lex(src.slice(a, b), sub);
    const shift = (k) => { k.s += a; k.e += a; k.line = line; k.col = k.s - lineStart + 1; return k; };
    for (const d of sub) { d.s += a; d.e += a; if (diags) diags.push(d); }
    for (const k of r.all) shift(k);
    const tokens = r.tokens.filter((k) => k.t !== 'eof' && k.t !== 'nl');
    for (const k of tokens) if (!r.all.includes(k)) shift(k);
    return { tokens, all: r.all.filter((k) => k.t !== 'nl') };
  }

  return { lex, RESERVED, HARD, UNIT_SUFFIX };
});
