// The C++ engine as WebAssembly (stomp-core.js, through engine.js) against the
// JavaScript engine, while both exist: the same tokens for every file.
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
