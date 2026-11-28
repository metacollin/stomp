// The engine for the tools: the C++ engine as WebAssembly, through the editor's adapter
// (demo/js/engine.js). engine() compiles with the standard library as stdlib/ has it now,
// so a build that has just rewritten demo/js/stdlib.js gets the same library.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);

/** stdlib/*.stomp in the order the library is read (stdlib/ORDER, then by name): [{ file, source }]. */
export function libraryFiles() {
  const dir = join(repo, 'stdlib');
  const order = readFileSync(join(dir, 'ORDER'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const at = (f) => { const i = order.indexOf(f); return i < 0 ? order.length : i; };
  return readdirSync(dir).filter((f) => f.endsWith('.stomp')).sort((a, b) => at(a) - at(b) || a.localeCompare(b))
    .map((file) => ({ file, source: readFileSync(join(dir, file), 'utf8') }));
}

const E = await require('../js/engine.js').ready;

/** The engine, with stdlib/ as the library. */
export function engine() {
  E.setLibrary(libraryFiles());
  return E;
}
