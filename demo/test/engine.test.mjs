// stomp live demo — engine tests.   Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const { compile } = require('../js/compile.js');
const { lex } = require('../js/lexer.js');

const example = (f) => readFileSync(join(repo, 'examples', f), 'utf8');
const fp = (src, name) => {
  const out = compile(src);
  const f = name ? out.footprints.find((x) => x.name === name) : out.footprints[0];
  assert.ok(f && f.result, `footprint ${name || '(first)'} should build`);
  return { out, r: f.result };
};
const pad = (r, n) => r.pads.find((p) => p.name === String(n));
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: expected ${b}, got ${a}`);
const errors = (out) => out.diagnostics.filter((d) => d.severity === 'error');

test('every example compiles without errors', () => {
  for (const f of readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp'))) {
    const out = compile(example(f));
    assert.deepEqual(errors(out).map((d) => `${f}:${d.line}: ${d.message}`), []);
    for (const x of out.footprints) assert.ok(x.result, `${f}: ${x.name} built`);
  }
});

test('lexer: ranges, hyphenated keywords, attached suffixes', () => {
  const k = lex('1..4 top-left 50mil 25% 0.7854rad 0.6x1.5 row-major', []).tokens.filter((t) => t.t !== 'eof');
  assert.deepEqual(k.map((t) => t.t === 'num' ? `${t.v}${t.suffix || ''}` : t.v),
    ['1', '..', '4', 'top-left', '50mil', '25%', '0.7854rad', '0.6', 'x', '1.5', 'row-major']);
});

test('TO-252: relational dimensions transcribed verbatim', () => {
  const { r } = fp(example('to252.stomp'));
  const p1 = pad(r, 1), p2 = pad(r, 2), p3 = pad(r, 3);
  near(p3.x - p1.x, 4.56, 'pad 3 is 4.56 right of pad 1');
  near(p1.y, p3.y, 'weak cross-axis alignment puts pad 3 on pad 1\'s row');
  near(p2.x, (p1.x + p3.x) / 2, 'tab centred between the pins');
  near(p2.bbox.y0 - p1.y, 1.9, 'tab near edge 1.9 above the pin centres');
  near(r.body.y - r.body.l / 2 - p1.y, 1.1, 'body bottom 1.1 above the pins');
  near(r.body.x, p2.x, 'body centred on the tab');
  near(r.body.x, 0, 'floating layout re-based on the body centroid');
});

test('USB micro-B: chained relations, mirrors and span about the centreline', () => {
  const { r } = fp(example('usb_microb.stomp'));
  near(pad(r, 3).x, 0, 'D+ on the origin'); near(pad(r, 3).y, 0, 'D+ on the origin');
  near(pad(r, 2).x - pad(r, 1).x, 0.65, 'row pitch e');
  const peg1 = r.holes.find((h) => h.name === 'PEG1'), peg2 = r.holes.find((h) => h.name === 'PEG2');
  near(peg1.x, -1.3 - 2.89, 'PEG1 C1 left of pad 1'); near(peg1.y, -0.55, 'PEG1 C2 below pad 1');
  near(peg2.x, -peg1.x, 'PEG2 mirrors PEG1');
  near(pad(r, 'SH4').bbox.x1 - pad(r, 'SH3').bbox.x0, 8.0, 'SH3/SH4 span 8.0');
  near(pad(r, 'SH3').bbox.x0, -4.0, 'prototype takes the −x side');
  near(pad(r, 'SH3').y - pad(r, 'SH1').y, 0.9, 'SH3 0.9 above SH1');
  near(r.body.y + r.body.l / 2 - peg1.y, 0.5, 'body top 0.5 above PEG1');
});

test('SOIC-8: IPC-style gull-wing lands and CCW numbering', () => {
  const { r } = fp(example('soic8.stomp'));
  const p1 = pad(r, 1);
  near(p1.x, -2.48, 'land centre'); near(p1.y, 1.905, 'pin 1 top-left');
  near(p1.bbox.x1 - p1.bbox.x0, 1.8, 'land length (along the lead)');
  near(p1.bbox.y1 - p1.bbox.y0, 0.53, 'land width (across the row)');
  assert.deepEqual([4, 5, 8].map((n) => [Math.sign(pad(r, n).x), Math.sign(pad(r, n).y)]), [[-1, -1], [1, -1], [1, 1]]);
});

test('SOIC-8-HS: default pad overrides IPC geometry, keeping the land centre', () => {
  const { r } = fp(example('soic_family.stomp'), 'SOIC-8-HS');
  const p1 = pad(r, 1);
  near(p1.bbox.x1 - p1.bbox.x0, 2.2, 'W x L: length 2.2 along the lead');
  near(p1.bbox.y1 - p1.bbox.y0, 0.6, 'width 0.6 across the row');
  near(p1.x, -2.48, 'same land centre as the IPC pad');
});

test('templates: parameters, defaults and expression arithmetic', () => {
  const src = example('soic_family.stomp');
  near(fp(src, 'SOIC-14').r.body.l, 6 * 1.27 + 2.0, 'body length (n/2 - 1) * e + 2.0');
  near(fp(src, 'SOIC-16W').r.body.w, 7.5, 'named argument bw');
  assert.equal(fp(src, 'SOIC-16').r.pads.length, 16);
});

test('QFN-32: quad numbering, thermal pad, paste windows, vias', () => {
  const { r } = fp(example('qfn32.stomp'));
  assert.equal(r.pads.length, 33);
  const ep = pad(r, 33);
  near(ep.x, 0, 'EP centred'); near(ep.bbox.x1 - ep.bbox.x0, 3.7, 'EP size');
  assert.equal(ep.paste.length, 4);
  assert.equal(ep.vias.length, 9);
  assert.ok(pad(r, 9).y < 0 && pad(r, 17).x > 0 && pad(r, 25).y > 0, 'CCW: left, bottom, right, top');
});

test('BGA-64: JEDEC rows, omit and delete', () => {
  const src = example('bga64.stomp');
  const { r } = fp(src, 'BGA-64');
  assert.equal(r.pads.length, 62);
  assert.ok(!pad(r, 'A1') && !pad(r, 'H8'));
  near(pad(r, 'A2').y, 2.8, 'row A at the top'); near(pad(r, 'B1').x, -2.8, 'column 1 at the left');
  assert.equal(fp(src, 'BGA-64-DEPOP').r.pads.length, 61);
});

test('through-hole: DIP spans in mil, header zigzag and origin at pad 1', () => {
  const dip = fp(example('dip8.stomp')).r;
  near(pad(dip, 8).x - pad(dip, 1).x, 7.62, '300 mil row spacing');
  near(pad(dip, 1).y - pad(dip, 2).y, 2.54, '100 mil pitch');
  const hdr = fp(example('hdr2x5.stomp')).r;
  near(pad(hdr, 1).x, 0, 'origin at pad 1'); near(pad(hdr, 1).y, 0, 'origin at pad 1');
  near(pad(hdr, 2).y, -2.54, 'zigzag: 2 below 1'); near(pad(hdr, 3).x, 2.54, 'then advance a column');
});

test('syntax zoo: mirrors + measurements, grids, origin re-basing', () => {
  const src = example('syntax_zoo.stomp');
  const shapes = fp(src, 'ZOO-SHAPES').r;
  near(pad(shapes, 6).bbox.y0 - pad(shapes, 7).bbox.y1, 70 * 0.0254, 'gap pad 6 to pad 7 is 70 (mil)');
  near(pad(shapes, 9).x - pad(shapes, 8).x, 300 * 0.0254, 'pitch pad 8 to pad 9 is 300');
  near(pad(shapes, 8).x, -150 * 0.0254, 'prototype on the −x side');
  const grid = fp(src, 'ZOO-GRID').r;
  assert.deepEqual(grid.pads.map((p) => p.name).sort(), ['1', '2', '3', '4', '6']);
  near(pad(grid, 1).y, -15 * 0.0254, 'row-major from bottom-left, origin at (0, -25)');
  const dual = fp(src, 'ZOO-DUAL').r;
  assert.ok(pad(dual, 2).x > 0 && pad(dual, 2).y > 0, 'cw: pin 2 is the top of the right side');
  assert.ok(!pad(dual, 10), 'delete pad 10');
  near(pad(dual, 3).bbox.x1 - pad(dual, 3).bbox.x0, 52 * 0.0254, 'pad 3 { size 34 x 52 }');
  assert.equal(fp(src, 'ZOO-CASTELLATED').r.pads.length, 5, 'only 1..5');
});

test('diagnostics: over-constraint cites both statements', () => {
  const out = compile('footprint "X" {\n  pad 1 rect 1 x 1\n  pad 2 rect 1 x 1\n  pad 1 at (0, 0)\n  pad 2 is 2 right of pad 1\n  pad 2 is 3 right of pad 1\n}');
  const e = errors(out);
  assert.equal(e.length, 1);
  assert.match(e[0].message, /over-constrained/);
  assert.equal(e[0].line, 6);
  assert.equal(e[0].related[0].line, 5);
});

test('diagnostics: under-constraint, unknown names, unit errors', () => {
  assert.match(errors(compile('footprint "X" {\n  pad 1 rect 1 x 1\n  pad 2 rect 1 x 1\n  pad 1 at (0,0)\n}'))[0].message, /pad 2 has no x and y position/);
  assert.match(errors(compile('footprint "X" {\n  pad 1 rect 1 x 1; pad 2 rect 1 x 1\n  pad 1 at (0,0)\n  pad 2 is 1 right of pad 11\n}'))[0].message, /unknown object: pad 11 — did you mean 1\?/);
  assert.match(errors(compile('let e = 1\nfootprint "X" { pad 1 rect ee x 1; pad 1 at (0,0) }'))[0].message, /unknown name `ee` — did you mean `e`\?/);
  assert.match(errors(compile('footprint "X" { pad 1 rect 1mm * 2mm x 1; pad 1 at (0,0) }'))[0].message, /unit error/);
});

test('diagnostics: syntax errors stay local', () => {
  const out = compile('footprint "X" {\n  pins 8 dual pitch 1.27 bogus\n  lead gullwing 0.41 x 1.04 span 6.0\n  pad 9 is 4. right\n  body 3.9 x 4.9\n}');
  const e = errors(out);
  assert.equal(e.length, 2, e.map((d) => d.message).join('; '));
  assert.ok(e.every((d) => d.syntax));
  assert.equal(out.footprints[0].result.pads.length, 8, 'the generator survives trailing junk');
  assert.ok(out.footprints[0].result.body, 'statements after the broken one still count');
});

test('demo/js/examples.js matches examples/', () => {
  execFileSync(process.execPath, [join(repo, 'demo', 'tools', 'build.mjs'), '--check'], { stdio: 'pipe' });
});

test('never throws on half-typed or mangled input (fuzz smoke test)', () => {
  let seed = 4242;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const bits = ['{', '}', '(', ')', ',', 'pad', 'is', 'at', '1', '.', '..', 'x', '#', '"', '\n', 'left of', 'mirrors', 'span',
    'pins 4 dual', 'row r pads 1..2 pitch', 'group g =', 'delete pad 1', 'origin at', 'centered between', 'inner', '-', '/', '%', 'mil'];
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const f of readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp'))) {
      const src = example(f);
      for (let i = 0; i < 120; i++) {
        let s = rnd(3) === 0 ? src.slice(0, rnd(src.length + 1)) : src;
        for (let k = 0, n = 1 + rnd(4); k < n; k++) {
          const a = rnd(s.length + 1);
          s = rnd(2) ? s.slice(0, a) + bits[rnd(bits.length)] + s.slice(a) : s.slice(0, a) + s.slice(a + rnd(8));
        }
        const out = compile(s);
        const internal = out.diagnostics.filter((d) => d.message.startsWith('internal error'));
        assert.deepEqual(internal.map((d) => d.message), [], `${f} mutation ${i}`);
        for (const x of out.footprints) {
          if (!x.result) continue;
          for (const p of x.result.pads) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${f} mutation ${i}: pad ${p.name} position is finite`);
        }
      }
    }
  } finally {
    console.error = quiet;
  }
});

test('the incremental cache never changes the result (random edit sequences)', () => {
  const { clearCache } = require('../js/compile.js');
  const summary = (out) => JSON.stringify({
    diags: out.diagnostics.map((d) => [d.severity, d.s, d.e, d.message, (d.related || []).map((r) => [r.s, r.e, r.message])]),
    fps: out.footprints.map((f) => [f.name, f.s, f.e, f.result && {
      pads: f.result.pads.map((p) => [p.name, +p.x.toFixed(6), +p.y.toFixed(6), p.shape.kind, p.src]),
      silk: f.result.silk.length, crt: f.result.courtyardBox, desc: f.result.meta.description, dims: f.result.dims.map((d) => [d.s, d.e]),
    }]),
  });
  let seed = 99;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const f of ['qfn_library.stomp', 'soic_family.stomp', 'syntax_zoo.stomp']) {
      clearCache();
      let src = example(f);
      for (let step = 0; step < 40; step++) {
        const lines = src.split('\n');
        const i = rnd(lines.length);
        switch (rnd(6)) {
          case 0: lines[i] = lines[i].replace(/\d+(\.\d+)?/, (m) => String(+m + 0.05)); break;      // nudge a number
          case 1: lines.splice(i, 0, lines[rnd(lines.length)]); break;                              // duplicate a line
          case 2: lines.splice(i, 1); break;                                                        // delete a line
          case 3: lines.splice(i, 0, ''); break;                                                    // shift everything below
          case 4: lines[i] = lines[i] + ' x'; break;                                                // break a line
          default: lines[i] = lines[i].replace(/ x$/, ''); break;
        }
        src = lines.join('\n');
        const warm = summary(compile(src));
        const cold = summary(compile(src, { cache: false }));
        assert.equal(warm, cold, `${f}, edit ${step}`);
      }
    }
  } finally {
    console.error = quiet;
  }
});

test('templates as functions: names, interpolation, tables', () => {
  const { out } = fp(example('qfn_library.stomp'));
  assert.equal(errors(out).length + out.diagnostics.length, 0, out.diagnostics.map((d) => d.message).join('; '));
  assert.equal(out.footprints.length, 18);
  const byName = new Map(out.footprints.map((f) => [f.name, f]));
  const q32 = byName.get('QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm').result;
  assert.equal(q32.meta.description, 'QFN, 32 pins, 5 x 5 mm body, 0.50 mm pitch, 3.45 x 3.45 mm exposed pad');
  assert.equal(q32.pads.length, 33);
  near(pad(q32, 33).bbox.x1 - pad(q32, 33).bbox.x0, 3.45, 'thermal pad "{n + 1}" sized D2');
  assert.ok(byName.get('QFN-68-1EP_8x8mm_P0.4mm_EP6.4x6.4mm'), 'second table, e as a column');
  assert.ok(byName.get('QFN-24-1EP_4x4mm_P0.5mm_EP2.45x2.65mm'), 'unnamed call named by the template');
  const hs = byName.get('QFN-32-1EP_5x5mm_P0.5mm_EP3.45x3.45mm_HandSolder').result;
  near(pad(hs, 1).bbox.x1 - pad(hs, 1).bbox.x0, 1.0, 'extends a generated footprint by name');
  assert.equal(byName.get('QFN-12-1EP_3x3mm_P0.5mm_EP1.65x1.65mm').origin.kind, 'row');
});

test('interpolation: formatting, units, escapes, text values', () => {
  const out = compile('units mil\nlet w = 20\nlet part = "ACME-{w}"\nfootprint "X-{w}-{w * 0.0254mm}-{part}" {\n  description "{w:.2} {25.4mm} \\{x\\} {1/3}"\n  pad 1 rect w x w\n  pad 1 at (0, 0)\n}');
  assert.deepEqual(errors(out), []);
  assert.equal(out.footprints[0].name, 'X-20-20-ACME-20', 'lengths print in the file units');
  assert.equal(out.footprints[0].result.meta.description, '20.00 1000 {x} 0.333333');
  const bad = compile('footprint "A{nope}" { pad 1 rect 1 x 1; pad 1 at (0,0) }\nlet t = "s"\nfootprint "B" { pad 1 rect t x 1; pad 1 at (0,0) }');
  assert.match(errors(bad)[0].message, /unknown name `nope`/);
  assert.match(errors(bad)[1].message, /text \("s"\), but a length is needed/);
});

test('tables: shape errors, unknown columns, duplicates, row-level diagnostics', () => {
  const tmpl = 'template t(n, w = 1) {\n  name "T-{n}"\n  pins n dual pitch 1.27\n  default pad rect 0.6 x w\n  span 5\n}\n';
  const out = compile(tmpl + 'footprints from t {\n  n   q\n  8   1\n  9   1\n  8   1\n  14  1  2\n}');
  const msgs = out.diagnostics.map((d) => `${d.line}: ${d.message}`);
  assert.ok(msgs.some((m) => /^8: template `t` has no parameter `q`/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^10: `pins 9 dual` needs an even count/.test(m)), 'row-specific error on the row');
  assert.ok(msgs.some((m) => /^11: footprint name "T-8" is already used by row 1/.test(m)), 'duplicate names');
  assert.ok(msgs.some((m) => /^12: this row has 3 values but the header names 2 columns/.test(m)), 'row shape');
  const once = compile(tmpl.replace('span 5', 'span zz') + 'footprints from t {\n  n\n  8\n  14\n}');
  assert.equal(once.diagnostics.filter((d) => /unknown name `zz`/.test(d.message)).length, 1, 'a template bug is reported once');
  assert.equal(once.diagnostics.find((d) => /zz/.test(d.message)).line, 5, '…at the template');
  assert.match(errors(compile('template t(n) { pad 1 rect n x n; pad 1 at (0,0) }\nfootprints from t {\n  n\n  1\n}'))[0].message, /doesn't name its footprints/);
});
