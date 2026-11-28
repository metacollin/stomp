// Compare two stomp engines, layer by layer, on the same inputs.
//
//   node tests/compare/compare.mjs [--a ENGINE] [--b ENGINE] [--layers lex,parse,core,compile,models]
//                                  [--fuzz N] [--seed S] [--only TEXT] [--show K] [--record]
//
// ENGINE is js:DIR (a copy of the JavaScript engine), oracle (the JavaScript engine as
// committed, HEAD's demo/js), or cli:PATH (the C++ `stomp` tool; `stomp dev dump` prints
// the same canonical text). The defaults compare demo/js with the oracle. The core layer
// is compile without the lazy layers (silk, assembly, courtyard).
//
// --record runs the JavaScript test suite once with record.mjs to collect the sources
// it compiles into build/compare/recorded.jsonl; later runs include them.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseCorpus, edits, fuzzed } from './corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const work = join(repo, 'build', 'compare');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const LAYERS = opt('--layers', 'lex,parse,compile,models').split(',');
const FUZZ = +opt('--fuzz', '0');
const SEED = +opt('--seed', '1');
const ONLY = opt('--only', null);
const SHOW = +opt('--show', '5');

mkdirSync(work, { recursive: true });
const recorded = join(work, 'recorded.jsonl');

if (args.includes('--record')) {
  rmSync(recorded, { force: true });
  spawnSync(process.execPath, ['--import', join(here, 'record.mjs'), '--test', ...listTests()], {
    cwd: repo, env: Object.assign({}, process.env, { STOMP_RECORD: recorded }), stdio: 'ignore',
  });
  // keep one copy of each
  const seen = new Set(), keep = [];
  for (const line of readFileSync(recorded, 'utf8').split('\n')) {
    if (!line) continue;
    const h = JSON.parse(line).h;
    if (!seen.has(h)) { seen.add(h); keep.push(line); }
  }
  writeFileSync(recorded, keep.join('\n') + '\n');
  console.log(`recorded ${keep.length} distinct sources from the test suite`);
}

function listTests() {
  return require('node:fs').readdirSync(join(repo, 'demo/test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('demo/test', f));
}

function engineOf(spec) {
  // the oracle: the JavaScript engine as committed (HEAD's demo/js), so edits in
  // progress don't move the reference
  if (spec === 'oracle') {
    const dir = join(work, 'oracle');
    const tree = execFileSync('git', ['rev-parse', 'HEAD:demo/js'], { cwd: repo }).toString().trim();
    const stamp = join(dir, 'TREE');
    if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== tree) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      execFileSync('sh', ['-c', `git archive HEAD demo/js | tar -x -C "${dir}"`], { cwd: repo });
      writeFileSync(stamp, tree);
    }
    return jsEngine(join(dir, 'demo/js'), `oracle (demo/js ${tree.slice(0, 7)})`);
  }
  if (spec.startsWith('js:')) return jsEngine(resolve(repo, spec.slice(3)), spec);
  if (spec.startsWith('cli:')) return cliEngine(resolve(repo, spec.slice(4)), spec);
  throw new Error(`unknown engine ${spec}`);
}

function jsEngine(dir, name) {
  const { engine } = require('./js-engine.cjs');
  const e = engine(dir);
  return {
    name,
    lex: (c) => e.lex(c.src),
    parse: (c) => e.parse(c.src),
    core: (c) => e.core(c.src, c.stdlib),
    cache: (c) => e.cache(c.src, c.stdlib),
    kicad: (c) => e.kicad(c.src, c.stdlib),
    compile: (c) => e.compile(c.src, c.stdlib),
    models: (c) => JSON.stringify(e.models(c.src, c.stdlib)),
  };
}

// The C++ tool: `stomp dev dump --layer L --batch` reads JSON lines {id, src, stdlib?}
// and writes {id, text} (or {id, error}) for each, in one process per layer.
function cliEngine(path, name) {
  const batch = (layer, inputs) => {
    const lines = inputs.map((c, i) => JSON.stringify({ id: i, src: c.src, stdlib: c.stdlib || null })).join('\n') + '\n';
    const r = spawnSync(path, ['dev', 'dump', '--layer', layer, '--batch'], { input: lines, maxBuffer: 2 ** 30 });
    const out = new Map();
    if (r.status !== 0) {
      const why = `<exit ${r.status} ${r.signal || ''}: ${String(r.stderr).trim().slice(0, 400)}>`;
      inputs.forEach((c, i) => out.set(i, why));
      return out;
    }
    for (const line of String(r.stdout).split('\n')) {
      if (!line) continue;
      const o = JSON.parse(line);
      out.set(o.id, o.error != null ? `<error: ${o.error}>` : o.text);
    }
    return out;
  };
  return { name, batch };
}

// Where two texts first differ, with some context
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 120);
  return `at ${i}:\n    a: …${a.slice(from, i + 120)}\n    b: …${b.slice(from, i + 120)}`;
}

const A = engineOf(opt('--a', 'js:demo/js'));
const B = engineOf(opt('--b', 'oracle'));
let inputs = baseCorpus(repo, recorded);
if (FUZZ) inputs = inputs.concat(fuzzed(inputs, FUZZ, SEED));
if (ONLY) inputs = inputs.filter((c) => c.id.includes(ONLY));
console.log(`${A.name} against ${B.name}: ${inputs.length} inputs, layers ${LAYERS.join(', ')}`);

let failed = 0;
const t0 = Date.now();
// each engine's text for a chunk of inputs (a batch where the engine has one); chunks
// keep the texts in memory few at a time
const CHUNK = 300;
function texts(E, layer, chunk) {
  if (E.batch) return E.batch(layer, chunk);
  const out = new Map();
  chunk.forEach((c, i) => {
    try { out.set(i, E[layer](c)); } catch (e) { out.set(i, `<threw: ${e && e.message}>`); }
  });
  return out;
}
// the cache layer's inputs: each source as a sequence of edits (a JSON array)
const seedOf = (id) => { let h = 7; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h || 1; };
const asSequence = (c) => Object.assign({}, c, { src: JSON.stringify(edits(c.src, 6, seedOf(c.id))) });
function* pairs(layer) {
  for (let k = 0; k < inputs.length; k += CHUNK) {
    let chunk = inputs.slice(k, k + CHUNK);
    if (layer === 'cache') chunk = chunk.map(asSequence);
    const ta = texts(A, layer, chunk), tb = texts(B, layer, chunk);
    for (const [i, c] of chunk.entries()) yield [c, ta.get(i), tb.get(i)];
  }
}

for (const layer of LAYERS) {
  let same = 0, diff = 0;
  const shown = [];
  for (const [c, a, b] of pairs(layer)) {
    if (a === b) { same++; continue; }
    diff++;
    if (shown.length < SHOW) shown.push(`  ${c.id} ${firstDiff(a, b)}`);
  }
  failed += diff;
  console.log(`${layer.padEnd(8)} ${same} same, ${diff} different`);
  for (const s of shown) console.log(s);
}
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
