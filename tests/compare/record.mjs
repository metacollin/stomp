// Records every source the test suite compiles, for the comparison corpus:
//   STOMP_RECORD=build/compare/recorded.jsonl node --import ./tests/compare/record.mjs --test demo/test/*.test.mjs
// Each line is {h, src, stdlib?}; compare.mjs removes the repeats.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Module from 'node:module';

const out = process.env.STOMP_RECORD;
if (out) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    // the engine's adapter (demo/js/engine.js), whose compile the tests call
    if (/(^|[\\/])engine\.js$/.test(request) && m && typeof m.compile === 'function' && !m.compile.recorded) {
      const compile = m.compile;
      const wrapped = function (src, opts) {
        const stdlib = opts && opts.stdlib ? opts.stdlib.map((f) => ({ file: f.file, source: f.source })) : undefined;
        const h = createHash('sha256').update(JSON.stringify([src, stdlib || null])).digest('hex').slice(0, 16);
        try { appendFileSync(out, JSON.stringify({ h, src, stdlib }) + '\n'); } catch (e) { /* best effort */ }
        return compile.apply(this, arguments);
      };
      wrapped.recorded = true;
      m.compile = wrapped;
      if (m.compiler) m.compiler.compile = wrapped;
    }
    return m;
  };
}
