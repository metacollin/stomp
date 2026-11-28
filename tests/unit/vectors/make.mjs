// Writes tests/unit/vectors/js.json: what JavaScript (Node) and the JavaScript engine's
// encoders give for a spread of inputs, for the C++ tests (tests/unit/jsrt_test.cpp).
// Doubles are 16 hex digits of their bits, so -0, NaN and the infinities travel exactly.
//   node tests/unit/vectors/make.mjs ENGINE_DIR
// ENGINE_DIR is demo/js from the last commit with the JavaScript engine:
//   git archive 597ad62 demo/js | tar -x -C T, then ENGINE_DIR is T/demo/js
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('usage: node tests/unit/vectors/make.mjs ENGINE_DIR (see the top of this file)');
const engine = resolve(process.argv[2]);
const require = createRequire(import.meta.url);
const K = require(join(engine, 'kicad.js'));
const P = require(join(engine, 'parser.js'));

let s = 4242;
const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const bits = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };
const anyDouble = () => { u64[0] = (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32)); return f64[0]; };

const specials = [0, -0, NaN, Infinity, -Infinity, 1, -1, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 1e21, 1e-7, 1e-6, 123456789012345680000,
  999999999999999900000, 1.5, 2.5, -2.5, 0.5, -0.5, 0.125, 0.375, 1.005, 1.045, 9.995, 5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, 4503599627370496.5, 4503599627370497, 1e100, 1.23e-20, 100, 1234.5678, -0.0001, 0.000001, 1e-10];
const numbers = specials.slice();
for (let i = 0; i < 800; i++) {
  const r = rnd();
  if (r < 0.3) numbers.push((rnd() * 2 - 1) * 100);
  else if (r < 0.5) numbers.push(Math.round((rnd() * 2 - 1) * 1e6) / 1e4);           // round decimals
  else if (r < 0.6) numbers.push(Math.round(rnd() * 2000 - 1000) / 8);                  // exact ties
  else if (r < 0.7) numbers.push((rnd() * 2 - 1) * 10 ** Math.floor(rnd() * 44 - 22));
  else numbers.push(anyDouble());
}

const out = {};
out.to_string = numbers.map((x) => [bits(x), String(x)]);
out.to_fixed = [];
for (const x of numbers) for (const d of [0, 2, 4, 6]) out.to_fixed.push([bits(x), d, x.toFixed(d)]);
for (const x of numbers.slice(0, 80)) out.to_fixed.push([bits(x), 20, x.toFixed(20)]);
out.round = numbers.map((x) => [bits(x), bits(Math.round(x))]);
out.hypot = [];
for (let i = 0; i < 400; i++) {
  const a = numbers[Math.floor(rnd() * numbers.length)], b = numbers[Math.floor(rnd() * numbers.length)];
  out.hypot.push([bits(a), bits(b), bits(Math.hypot(a, b))]);
}
out.min_max_sign = [];
for (const [a, b] of [[0, -0], [-0, 0], [NaN, 1], [1, NaN], [2, 3], [-1, -2], [-0, -0], [Infinity, -Infinity]])
  out.min_max_sign.push([bits(a), bits(b), bits(Math.min(a, b)), bits(Math.max(a, b)), bits(Math.sign(a))]);
out.int32 = [0, -0, 1.9, -1.9, 2 ** 31, 2 ** 32 + 5, -(2 ** 31) - 1, 1e20, NaN, Infinity, 4294967295.7]
  .map((x) => [bits(x), x | 0, x >>> 0]);
out.parse_float = ['0', '1', '1.', '.5', '1.27', '0.1', '1e3', '1E-3', '2.5e+2', '123456789012345678901234567890', '1e400', '1e-400',
  '4.9e-325', '3e-324', '0.30000000000000004', '00012', '1.00000000000000011102230246251565404236316680908203125']
  .map((t) => [t, bits(parseFloat(t))]);

const strings = ['ABC def', 'ΑΣ', 'ΑΣ.', 'ΑΣΑ', 'Σ', 'aΣ', "a'Σ", 'ΑΣ ΑΣ', 'ß', 'İstanbul', 'ﬃ', 'ΐ', 'µΩ°', 'ſw', 'ı',
  'Ǆ ǅ ǆ', '𐐀𐐨', '\ud800x', 'x\udc00', 'Grüße', 'ΌΣΟΣ', 'ἈΙ', 'Ⅻ', 'Ⓐ', 'Ａ'];
for (let i = 0; i < 300; i++) {
  let t = '';
  const n = 1 + Math.floor(rnd() * 6);
  for (let k = 0; k < n; k++) {
    const r = rnd();
    t += r < 0.4 ? String.fromCharCode(0x41 + Math.floor(rnd() * 58)) : r < 0.8 ? String.fromCodePoint(0xa0 + Math.floor(rnd() * 0x500)) : String.fromCodePoint(0x1e00 + Math.floor(rnd() * 0x300));
  }
  strings.push(t);
}
out.lower = strings.map((t) => [t, t.toLowerCase()]);
out.upper = strings.map((t) => [t, t.toUpperCase()]);
out.trim = [' a ', '\t\n x ', ' y　', '﻿z ', 'no', '', ' ᠎ '].map((t) => [t, t.trim()]);

// the encoders: inputs come from the same generator in C++ (seed, length)
const bytesOf = (seed, n) => { let q = seed; const b = new Uint8Array(n); for (let i = 0; i < n; i++) { q = (q * 1103515245 + 12345) % 2147483648; b[i] = q & 255; } return b; };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
out.encoders = [];
for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 16, 17, 31, 32, 33, 100, 1000, 131071, 131072, 131073, 300000]) {
  const b = bytesOf(n + 7, n);
  out.encoders.push({
    seed: n + 7, n,
    checksum: K.checksum(b),
    checksum_seed0: K.checksum(b, 0),
    murmur: hex(K.murmur3x64(b, 0x9747b28c)),
    zstd_checksum: K.checksum(K.zstdFrame(b)),
    zstd_len: K.zstdFrame(b).length,
    base64: n <= 1000 ? K.base64(b) : null,
  });
}
out.levenshtein = [['', ''], ['a', ''], ['kitten', 'sitting'], ['pitch', 'ptich'], ['gullwing', 'gulwing'], ['Ω', 'ω']]
  .map(([a, b]) => [a, b, P.levenshtein(a, b)]);
const words = ['pitch', 'span', 'pads', 'drill', 'gullwing', 'jlead', 'courtyard', 'silk', 'tin', 'can_blue'];
out.suggest = [['pich', words], ['spam', words], ['zzzz', words], ['GULLWING', words], ['ab', words], ['silks', words], ['x', ['y', 'z']]]
  .map(([w, c]) => [w, c, P.suggest(w, c)]);

writeFileSync(join(here, 'js.json'), JSON.stringify(out) + '\n');
console.log(`wrote ${Object.entries(out).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
