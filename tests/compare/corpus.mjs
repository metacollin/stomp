// The comparison harness's inputs: every example, the test corpus, the standard
// library, every stomp block in the docs, the sources the test suite compiled
// (record.mjs), and seeded random edits of all of them.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = ['README.md', 'SPEC.md', 'docs/tutorial.md', 'docs/reference.md', 'docs/using.md', 'stdlib/README.md', 'demo/README.md'];

export function baseCorpus(repo, recorded) {
  const out = [];
  const stomps = (dir) => readdirSync(join(repo, dir)).filter((f) => f.endsWith('.stomp')).sort();
  for (const f of stomps('examples')) out.push({ id: `example:${f}`, src: readFileSync(join(repo, 'examples', f), 'utf8') });
  out.push({ id: 'fixture:corpus.stomp', src: readFileSync(join(repo, 'demo/test/fixtures/corpus.stomp'), 'utf8') });
  for (const f of stomps('stdlib')) out.push({ id: `stdlib:${f}`, src: readFileSync(join(repo, 'stdlib', f), 'utf8') });
  for (const d of DOCS) {
    const text = readFileSync(join(repo, d), 'utf8');
    let k = 0;
    for (const m of text.matchAll(/^```stomp\n([\s\S]*?)^```/gm)) out.push({ id: `doc:${d}#${++k}`, src: m[1] });
  }
  if (recorded && existsSync(recorded)) {
    for (const line of readFileSync(recorded, 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      out.push({ id: `rec:${r.h}`, src: r.src, stdlib: r.stdlib });
    }
  }
  return out;
}

// Pieces of stomp, and of not-quite-stomp, to splice in
const FRAGMENTS = [
  'end', '}', '{', '\n', '\nend\n', ' x ', 'x', ':', ';', ',', '(', ')', '..', '"', '"a{1+}"', '{n}', '#',
  'pad 1 at (0, 0)\n', 'pads 1..4 mask: +2\n', 'footprint "F"\n', 'template t(n)\n', 'feature f(d)\n',
  'section s\n', 'body 1 x 2 x 3\n', 'pins 8 dual pitch: 1.27\n', 'lead gullwing 0.4 x 1 span: 6\n',
  'pitch: ', 'pitch 1.27', 'at: (1, 2)', ' is 2 right of ', ' center of ', 'mils', '1.27mm', '43milw', '(D)w',
  '0.5h', '10deg', '1e3', '-', '*', '/', '+', '=', 'a = 1\n', 'units: mm\n', 'units: inch\n',
  'courtyard: auto 0.5\n', 'silk: none\n', 'model\n', 'standoff: 0.1\n', 'box 1 x 2 x 3 color: tin\n',
  'cylinder d: 1 h: 2\n', 'row "r" pads 1..4\n', 'delete pad 2\n', 'thermal pad 3 x 3\n', '\t', '  ',
  'µΩ°', '"µ{1}Ω"', '\r\n', '1.', '.5', '1..4', 'from soic(8)\n', 'with\n', 'footprints from t()\n  n\n  1\nend\n',
];

/** n edited copies of the corpus, the same ones for the same seed. */
export function fuzzed(corpus, n, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const bases = corpus.filter((c) => c.src.length > 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = pick(bases);
    let t = base.src;
    if (rnd() < 0.2) t = t.slice(0, Math.floor(rnd() * t.length));          // cut off mid-file
    const edits = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(rnd() * (t.length + 1));
      const r = rnd();
      if (r < 0.5) t = t.slice(0, at) + pick(FRAGMENTS) + t.slice(at);
      else if (r < 0.8) t = t.slice(0, at) + t.slice(at + Math.floor(rnd() * 8));
      else {                                                                  // repeat a line
        const ls = t.split('\n'), j = Math.floor(rnd() * ls.length);
        ls.splice(j, 0, ls[j]);
        t = ls.join('\n');
      }
    }
    out.push({ id: `fuzz:${seed}:${i}<${base.id}`, src: t, stdlib: base.stdlib });
  }
  return out;
}

/**
 * A sequence of sources, each a small edit of the one before (a digit changed, a fragment
 * typed in, a few characters deleted, a line repeated), the same for the same seed. For
 * the cache layer: an editor's compiles, one keystroke-sized change apart.
 */
export function edits(src, steps, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = [src];
  let t = src;
  for (let k = 0; k < steps; k++) {
    const r = rnd();
    const digits = [...t.matchAll(/[0-9]/g)];
    if (r < 0.4 && digits.length) {
      const m = pick(digits);
      t = t.slice(0, m.index) + String(Math.floor(rnd() * 10)) + t.slice(m.index + 1);
    } else {
      const at = Math.floor(rnd() * (t.length + 1));
      if (r < 0.6) t = t.slice(0, at) + pick(FRAGMENTS) + t.slice(at);
      else if (r < 0.8) t = t.slice(0, at) + t.slice(at + 1 + Math.floor(rnd() * 4));
      else {
        const ls = t.split('\n'), j = Math.floor(rnd() * ls.length);
        ls.splice(j, 0, ls[j]);
        t = ls.join('\n');
      }
    }
    out.push(t);
  }
  return out;
}
