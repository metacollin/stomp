// A canonical text form of engine output, for comparing two engines. The C++ engine's
// `stomp dev` prints the same form (src/dev/canon.cpp).
//
//   - object keys sorted; undefined and function values left out;
//   - numbers as JavaScript prints them, with -0, NaN, Infinity and -Infinity kept;
//   - typed arrays as Float32Array[...] etc.;
//   - an AST node inside a result as {type, s, e} only (whichever of those it has):
//     results point at the statements they came from, and only those fields are used.
'use strict';

function num(n) {
  if (Object.is(n, -0)) return '-0';
  return String(n);   // NaN, Infinity, -Infinity, 1e+21 ... as JavaScript prints them
}

/**
 * canon(value, isAst): text. isAst(o) says whether an object is an AST node to
 * summarize; pass null to print everything in full (the AST itself).
 */
function canon(value, isAst) {
  const stack = new Set();
  const out = [];
  (function put(v) {
    if (v === null) { out.push('null'); return; }
    switch (typeof v) {
      case 'undefined': out.push('undefined'); return;
      case 'boolean': out.push(v ? 'true' : 'false'); return;
      case 'number': out.push(num(v)); return;
      case 'string': out.push(JSON.stringify(v)); return;
      case 'bigint': out.push(String(v) + 'n'); return;
      case 'function': out.push('<function>'); return;
      default: break;
    }
    if (ArrayBuffer.isView(v)) {
      out.push(v.constructor.name, '[');
      for (let i = 0; i < v.length; i++) { if (i) out.push(','); out.push(typeof v[i] === 'bigint' ? String(v[i]) + 'n' : num(v[i])); }
      out.push(']');
      return;
    }
    if (stack.has(v)) { out.push('"<cycle>"'); return; }
    if (isAst && isAst(v)) {
      // printed as is: the summary is never summarized again
      const keys = ['e', 's', 'type'].filter((k) => v[k] !== undefined);
      out.push('{');
      keys.forEach((k, i) => { if (i) out.push(','); out.push(JSON.stringify(k), ':'); put(v[k]); });
      out.push('}');
      return;
    }
    stack.add(v);
    if (Array.isArray(v)) {
      out.push('[');
      for (let i = 0; i < v.length; i++) { if (i) out.push(','); put(v[i]); }
      out.push(']');
    } else if (v instanceof Map || v instanceof Set) {
      out.push(v instanceof Map ? 'Map' : 'Set');
      put([...v]);
    } else {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
      out.push('{');
      keys.forEach((k, i) => { if (i) out.push(','); out.push(JSON.stringify(k), ':'); put(v[k]); });
      out.push('}');
    }
    stack.delete(v);
  })(value);
  return out.join('');
}

module.exports = { canon, num };
