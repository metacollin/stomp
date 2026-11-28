// The C++ engine's math against Node's Math, bit for bit: sin, cos, tan, asin, acos,
// atan2, hypot and round, N samples in all.
//   node tests/compare/math.mjs N build/native-release/stomp dev math
// The command reads (function, a, b) records of doubles and writes one double each.
import { spawnSync } from 'node:child_process';

const N = +process.argv[2];
const cmd = process.argv.slice(3);
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const bits = new BigUint64Array(1), dv = new Float64Array(bits.buffer);
const anyDouble = () => { bits[0] = (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32)); return dv[0]; };
const specials = [0, -0, Infinity, -Infinity, NaN, 5e-324, -5e-324, 1e-310, Math.PI / 2, -Math.PI / 2, Math.PI, 2 * Math.PI, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, 0.49999999999999994, 4503599627370497, 1e300, -1e300];
const sample = (k) => {
  const r = rnd();
  if (k < specials.length * 3) return specials[k % specials.length];
  if (r < 0.3) return (rnd() * 2 - 1) * 10;                  // the everyday range
  if (r < 0.45) return (rnd() * 2 - 1) * 1e6;
  if (r < 0.55) return Math.round(rnd() * 64 - 32) * Math.PI / 4 + (rnd() - 0.5) * 1e-9;   // near multiples of pi/4
  if (r < 0.65) return (rnd() * 2 - 1) * 1e-8;
  if (r < 0.75) return Math.round((rnd() * 2 - 1) * 1e4) / 8; // halves and eighths, for round
  return anyDouble();
};
const NAMES = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan2', 'hypot', 'round'];
const ref = [(a) => Math.sin(a), (a) => Math.cos(a), (a) => Math.tan(a), (a) => Math.asin(a), (a) => Math.acos(a),
  (a, b) => Math.atan2(a, b), (a, b) => Math.hypot(a, b), (a) => Math.round(a)];
const recs = new Float64Array(N * 3), want = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const fn = i % 8;
  let a = sample(Math.floor(i / 8)), b = sample(Math.floor(i / 8) + 7);
  if ((fn === 3 || fn === 4) && rnd() < 0.8) a = rnd() * 2 - 1;   // asin/acos: mostly in domain
  recs[i * 3] = fn; recs[i * 3 + 1] = a; recs[i * 3 + 2] = b;
  want[i] = ref[fn](a, b);
}
const r = spawnSync(cmd[0], cmd.slice(1), { input: Buffer.from(recs.buffer), maxBuffer: 1 << 30 });
if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }
const got = new Float64Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 8);
const bad = new Array(8).fill(0), shown = [];
const same = (x, y) => Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y));
for (let i = 0; i < N; i++) {
  if (!same(got[i], want[i])) {
    bad[i % 8]++;
    if (shown.length < 6) shown.push(`${NAMES[i % 8]}(${recs[i * 3 + 1]}, ${recs[i * 3 + 2]}): js ${want[i]} c++ ${got[i]}`);
  }
}
console.log(NAMES.map((n, k) => `${n} ${bad[k]}`).join(' | '), `(of ${N / 8} each)`);
for (const s of shown) console.log('  ' + s);
process.exit(bad.some((b) => b) ? 1 : 0);
