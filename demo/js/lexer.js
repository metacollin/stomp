/* stomp live demo — lexer (grammar.peg "LEXICAL LAYER", SPEC §4).
 *
 * Produces two streams:
 *   tokens — significant tokens for the parser (comments dropped, insignificant
 *            newlines suppressed: inside ( … ) and after '{', ',' or an infix op)
 *   all    — every token including comments, for syntax highlighting
 *
 * Token: { t, v, s, e, line, col }
 *   t: 'word' | 'num' | 'str' | 'p' (punctuation) | 'nl' | 'comment' | 'bad' | 'eof'
 *   word: v = text, kw = reserved?            num: v = value, text, suffix, isInt
 *   str:  v = unescaped value                 p:   v = '{' '}' '(' ')' ',' ';' ':' '=' '+' '-' '*' '/' '..'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).lexer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RESERVED = new Set((
    'above across align and arc assembly at auto ball balls bar below between ' +
    'bga body bottom bottom-left bottom-right castellated ccw center centered ' +
    'centers chamfer circle col-major color cols copper courtyard coverage cw ' +
    'cylinder d datasheet default defined deg delete density description ' +
    'dimple divide dot down drill dshape dual endcap extends fill flat ' +
    'footprint from gap going grid group gullwing gutter h height hole ' +
    'horizontal horizontally in inner is jlead layer lead leads least left ' +
    'length let line manufacturer mask mil mirrors mm model most mpn nc nm no ' +
    'nominal none notch numbering of offset omit on only origin outer outline ' +
    'oval pad pads paste pin pin1 pins pitch polarized polygon quad r rad ' +
    'rect ref refdes right rotate roundrect row row-major rows scale shape ' +
    'side silk single size slot span standoff start step stripe tab tags ' +
    'template text thermal tht to top top-left top-right um units up value ' +
    'vertical vertically vias wire with width x y zigzag').split(/\s+/));

  const HYPHENATED = ['row-major', 'col-major', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const UNIT_SUFFIX = new Set(['mm', 'um', 'nm', 'mil', 'in']);
  const ANGLE_SUFFIX = new Set(['deg', 'rad']);
  const PUNCT = new Set(['{', '}', '(', ')', ',', ';', ':', '=', '+', '-', '*', '/']);
  // a newline right after one of these is not a statement end (SPEC §4)
  const JOINERS = new Set(['{', ',', '+', '-', '*', '/']);

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
        let v = '';
        i++;
        let closed = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) { v += src[i + 1]; i += 2; continue; }
          if (src[i] === '"') { closed = true; i++; break; }
          v += src[i++];
        }
        if (!closed) report('unterminated string — add a closing "', s, i);
        tok('str', s, i, { v });
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
        const text = src.slice(s, i);
        const value = parseFloat(text.startsWith('.') ? '0' + text : text);
        let suffix = null;
        if (src[i] === '%') { suffix = '%'; i++; isInt = false; }
        else if (src[i] === 'x' && /[0-9.(\s-]/.test(src[i + 1] || ' ')) {
          // `0.6x1.5`: the PEG's implicit optional whitespace lets the size
          // separator touch the number; emit it as its own keyword token
          tok('num', s, i, { v: value, text: src.slice(s, i), num: text, suffix: null, isInt });
          tok('word', i, i + 1, { v: 'x', kw: true });
          i++;
          continue;
        }
        else if (i < n && isIdStart(src[i])) {
          const ss = i;
          while (i < n && isIdChar(src[i])) i++;
          const word = src.slice(ss, i);
          if (UNIT_SUFFIX.has(word) || ANGLE_SUFFIX.has(word)) { suffix = word; isInt = false; }
          else {
            const hint = /^x/.test(word)
              ? `put spaces around the size separator: \`${text} x ${word.slice(1) || '…'}\``
              : `units are mm, um, nm, mil, in (angles: deg, rad)`;
            report(`unknown suffix \`${word}\` on number ${text} — ${hint}`, ss, i);
            tok('bad', s, i, { v: src.slice(s, i) });
            continue;
          }
        }
        tok('num', s, i, { v: value, text: src.slice(s, i), num: text, suffix, isInt });
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
    for (const k of all) {
      if (k.t === 'comment' || k.t === 'bad') continue;
      if (k.t === 'nl') {
        if (depth > 0) continue;
        if (prev && prev.t === 'p' && JOINERS.has(prev.v)) continue;
        if (prev && prev.t === 'nl') continue;          // collapse blank lines
        if (!prev) continue;                             // leading newlines
      }
      if (k.t === 'p' && k.v === '(') depth++;
      if (k.t === 'p' && k.v === ')' && depth > 0) depth--;
      // parentheses never span braces; resetting keeps an unclosed '(' typed
      // mid-edit from swallowing the newlines of the rest of the file
      if (k.t === 'p' && (k.v === '{' || k.v === '}')) depth = 0;
      tokens.push(k);
      prev = k;
    }
    tokens.push(eof);
    return { tokens, all, eof };
  }

  return { lex, RESERVED, UNIT_SUFFIX };
});
