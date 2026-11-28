// The C++ engine as WebAssembly (stomp-core.js) through the editor's adapter (engine.js):
// its tokens against the JavaScript lexer's while both exist, the objects it hands out,
// and the results and models the engine lets go and makes again when they're used.
// Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const E = await require('../js/engine.js').ready;
const L = require('../js/lexer.js');

const sources = [];
for (const dir of ['examples', 'stdlib']) {
  for (const f of readdirSync(join(repo, dir)).filter((x) => x.endsWith('.stomp'))) sources.push([`${dir}/${f}`, readFileSync(join(repo, dir, f), 'utf8')]);
}
sources.push(['corpus', readFileSync(join(here, 'fixtures/corpus.stomp'), 'utf8')]);
sources.push(['odd', 'footprint "A" {\n  pad 1 at (0,0 1.27mmx2 43milw 1.1wx1.6h 5%\n"v{n:.2} {x:q} {} {" µΩ° 1e-3 .5 1..4 }\nend\n\t\v']);

test('the WebAssembly lexer gives the JavaScript lexer\'s tokens', () => {
  for (const [name, src] of sources) {
    const a = E.lex(src), b = L.lex(src, null);
    assert.deepEqual(a.all, b.all, `${name}: every token`);
    assert.deepEqual(a.tokens, b.tokens, `${name}: the parser's stream`);
    assert.deepEqual(a.eof, b.eof, `${name}: the end`);
    // the stream shares its tokens with `all` (the editor's annotations rely on it)
    const shared = (lx) => lx.tokens.map((k) => lx.all.indexOf(k));
    assert.deepEqual(shared(a), shared(b), `${name}: shared tokens`);
  }
});

test('the module says its version', () => {
  assert.match(E.version(), /^\d+\.\d+\.\d+$/);
});

test('a footprint the cache keeps is the same object', () => {
  const src = 'footprint "A"\n  pad 1 rect 1 x 1\n  pad 1 at (0, 0)\nend\nfootprint "B"\n  pad 1 rect 2 x 2\n  pad 1 at (0, 0)\nend\n';
  const a = E.compile(src).footprints;
  const b = E.compile(src.replace('rect 1 x 1', 'rect 3 x 1')).footprints;
  assert.notEqual(a[0].result, b[0].result, 'A changed');
  assert.equal(a[1].result, b[1].result, 'B is the same object');
  // its outlines load once, for every compile that hands it out
  assert.equal(b[1].result.pads[0].land, a[1].result.pads[0].land);
});

test('results and models the engine let go are made again when used', () => {
  const src = (k) => `footprint "F${k}"\n  body 2 x 3 x 1\n  pins ${4 + 2 * (k % 5)} dual pitch: 0.65 span: 4\n  pad 1 rect 0.4 x 1.2\nend\n`;
  const first = E.compile(src(0)).footprints[0].result;
  const fresh = () => E.compile(src(0), { cache: false }).footprints[0].result;
  const model = E.model3d.build(first);
  const vrml = E.model3d.toVRML(model, 'F0');
  // enough other compiles and models that the engine keeps neither
  for (let k = 1; k <= 300; k++) {
    const r = E.compile(src(k), { cache: false }).footprints[0].result;
    if (k % 30 === 0) E.model3d.build(r);
  }
  const used = E.memory().used;
  const before = E.remade();
  assert.ok(used < 256 * 1048576, `the engine's memory stays bounded (${(used / 1048576).toFixed(0)} MB)`);
  // the lazy layers and the outlines, never loaded, still come
  const again = fresh();
  assert.deepEqual(first.silk, again.silk, 'silk');
  assert.deepEqual(first.courtyardBox, again.courtyardBox, 'courtyard box');
  assert.deepEqual(first.pads.map((p) => p.land), again.pads.map((p) => p.land), 'pad outlines');
  // the model's exports, and a new model and export of the result
  assert.equal(E.model3d.toVRML(model, 'F0'), vrml, 'VRML of the old model');
  assert.equal(E.kicad.footprint(first, { model }).text, E.kicad.footprint(again, { model: E.model3d.build(again) }).text, 'KiCad export');
  assert.equal(E.model3d.toVRML(E.model3d.build(first), 'F0'), vrml, 'a new model of the old result');
  const after = E.remade();
  assert.ok(after.recompiled > before.recompiled && after.rebuilt > before.rebuilt, 'the engine had let both go');
});
