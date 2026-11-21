// 3D model tests. Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const { compile } = require('../js/compile.js');
const M = require('../js/model3d.js');

const example = (f) => readFileSync(join(repo, 'examples', f), 'utf8');
const build = (src, name) => {
  const out = compile(src);
  const f = name ? out.footprints.find((x) => x.name === name) : out.footprints[0];
  assert.ok(f && f.result, `footprint ${name || '(first)'} should build`);
  return { out, r: f.result, m: M.build(f.result, { strict: true }) };
};
const errors = (out) => out.diagnostics.filter((d) => d.severity === 'error');
const warnings = (out) => out.diagnostics.filter((d) => d.severity === 'warning');
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: expected ${b}, got ${a}`);
const box = (meshes) => {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const m of meshes) {
    for (let k = 0; k < m.pos.length; k += 3) {
      b.x0 = Math.min(b.x0, m.pos[k]); b.x1 = Math.max(b.x1, m.pos[k]);
      b.y0 = Math.min(b.y0, m.pos[k + 1]); b.y1 = Math.max(b.y1, m.pos[k + 1]);
      b.z0 = Math.min(b.z0, m.pos[k + 2]); b.z1 = Math.max(b.z1, m.pos[k + 2]);
    }
  }
  return b;
};
const leads = (m) => m.meshes.filter((x) => x.name.startsWith('lead '));
const mesh = (m, name) => m.meshes.find((x) => x.name === name);

/** Every triangle is counter-clockwise seen from where its vertex normals point. */
function assertWinding(m, label) {
  for (const x of m.meshes) {
    const P = x.pos, N = x.nrm, I = x.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const s = [N[a] + N[b] + N[c], N[a + 1] + N[b + 1] + N[c + 1], N[a + 2] + N[b + 2] + N[c + 2]];
      assert.ok(f[0] * s[0] + f[1] * s[1] + f[2] * s[2] >= -1e-12, `${label}: ${x.name} triangle ${t / 3} faces against its normals`);
    }
  }
}

test('every example builds a finite, consistently wound model and board', () => {
  for (const f of readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp'))) {
    const out = compile(example(f));
    for (const fp of out.footprints) {
      if (!fp.result) continue;
      const m = M.build(fp.result, { strict: true });
      const b = M.board(fp.result, m);
      for (const x of m.meshes.concat(b.meshes)) {
        assert.ok(x.idx.length % 3 === 0 && x.idx.length > 0, `${fp.name}: ${x.name} has triangles`);
        for (const v of x.pos) assert.ok(Number.isFinite(v), `${fp.name}: ${x.name} positions are finite`);
        for (const v of x.nrm) assert.ok(Number.isFinite(v), `${fp.name}: ${x.name} normals are finite`);
        for (const i of x.idx) assert.ok(i < x.pos.length / 3, `${fp.name}: ${x.name} indices are in range`);
      }
      assertWinding(m, fp.name);
      if (fp.result.body && !fp.result.model.none) assert.ok(m.meshes.length > 0, `${fp.name} has a model`);
    }
  }
});

test('SOIC-8: molded body on its standoff, gull-wing toes at the span, feet on the board', () => {
  const { m } = build(example('soic8.stomp'));
  assert.equal(m.style, 'molded');
  const body = box([mesh(m, 'body')]);
  near(body.z0, 0.1, 'body bottom = default gull-wing standoff');
  near(body.z1, 1.5, 'body top = the seated height');
  near(body.x1 - body.x0, 3.9, 'body width at the parting line');
  const L = leads(m);
  assert.equal(L.length, 8);
  const all = box(L);
  near(all.x0, -3.0, 'left toes at -span/2');
  near(all.x1, 3.0, 'right toes at +span/2');
  near(all.z0, 0, 'feet rest on the board');
  near(box([L[0]]).y1 - box([L[0]]).y0, 0.41, 'lead width');
  assert.equal(m.mark, 'dimple');
});

test('QFN-32: sawn block, flush terminals, exposed pad, pin-1 dot', () => {
  const { m } = build(example('qfn32.stomp'));
  assert.equal(m.style, 'sawn');
  const L = leads(m);
  assert.equal(L.length, 32);
  const t = box(L);
  near(t.z0, 0, 'terminals flush with the bottom');
  near(t.z1, 0.2, 'terminal thickness');
  near(t.x1, 2.5 + 0.015, 'terminals reach the body edge (just proud of it)');
  const ep = mesh(m, 'exposed pad 33');
  assert.ok(ep, 'the exposed pad is modelled');
  const e = box([ep]);
  near(e.x1 - e.x0, 3.7, 'exposed pad size');
  assert.equal(m.mark, 'dot');
});

test('BGA-64: balls collapsed to the standoff, omitted balls absent', () => {
  const { m, r } = build(example('bga64.stomp'));
  assert.equal(m.style, 'bga');
  const balls = leads(m);
  assert.equal(balls.length, r.pads.length);
  assert.ok(!balls.some((b) => b.name === 'lead A1'), 'A1 is omitted');
  near(m.standoff, 0.3, 'standoff = 0.75 x ball diameter');
  const bb = box([balls[0]]);
  near(bb.x1 - bb.x0, 0.4, 'ball diameter', 1e-3);
  assert.ok(bb.z1 > 0.3 - 1e-9 && bb.z0 < 0.001, 'each ball spans from the board to the substrate');
});

test('through-hole: DIP shoulders and tails, header pins and housing', () => {
  const dip = build(example('dip8.stomp')).m;
  assert.equal(dip.style, 'dip');
  near(box(leads(dip)).z0, -3, 'leads reach 3 mm below the board');
  assert.equal(dip.mark, 'notch');
  const hdr = build(example('hdr2x5.stomp')).m;
  assert.equal(hdr.style, 'header');
  near(box(leads(hdr)).z1, 8.5, 'pins rise to the body height');
  near(box([mesh(hdr, 'body')]).z1, 2.54, 'the housing is one pitch tall');
  const sock = build(example('hdr2x5.stomp').replace('pin1 dot', 'pin1 dot\n  model { leads above 0 }')).m;
  near(box([mesh(sock, 'body')]).z1, 8.5, '`leads above 0` makes a socket: the housing is the whole height');
});

test('cans, axial parts and MELFs lie the way their pins say', () => {
  const cp = build(example('cp_radial.stomp')).m;
  assert.equal(cp.style, 'can');
  assert.ok(mesh(cp, 'polarity stripe'), 'polarized can has its stripe');
  const { r, m } = build(example('do41.stomp'));
  assert.equal(r.body.axial, 'x');
  near(r.body.w, 5.2, '2D body: length along the pins');
  near(r.body.l, 2.7, '2D body: diameter across');
  assert.equal(m.style, 'axial');
  near(box([mesh(m, 'body')]).z1, 2.7, 'lying on the board: top at d');
  const band = box([mesh(m, 'cathode band')]);
  assert.ok(band.x0 > 0, 'the band is at the cathode, pin 2 (right)');
  near(box(leads(m)).z0, -3, 'wires bend down through the board');
  const melf = build('footprint "MELF" {\n  refdes "R"\n  body cylinder d 1.4 h 3.5\n  pins 2 horizontal\n  lead endcap 0.45\n}\n');
  assert.equal(errors(melf.out).length, 0);
  assert.equal(melf.r.body.axial, 'x');
  assert.equal(melf.m.style, 'melf');
  const pads = melf.r.pads;
  assert.ok(pads[1].x - pads[0].x > 2.5, 'endcap lands sit at the ends of the 3.5 mm body');
});

test('per-pin leads: land re-derived in part mode, model-only in land mode', () => {
  const sot = build(example('sot223.stomp'));
  assert.deepEqual(errors(sot.out), []);
  const p4 = sot.r.pads.find((p) => p.name === '4'), p1 = sot.r.pads.find((p) => p.name === '1');
  near(p4.shape.w, 3.12, 'pin 4 land width from its 3.0 mm lead');
  near(p1.shape.w, 0.82, 'pins 1-3 keep the general lead\'s land');
  near(p4.shape.l, p1.shape.l, 'same foot, same land length');
  const l4 = box([mesh(sot.m, 'lead 4')]);
  near(l4.x1 - l4.x0, 3.0, 'pin 4 lead width');
  const to = build(example('to252.stomp'));
  assert.deepEqual(errors(to.out), []);
  assert.equal(to.r.pads.find((p) => p.name === '1').shape.w, 1.1, 'explicit pads keep their size');
  assert.deepEqual(leads(to.m).map((x) => x.name).sort(), ['lead 1', 'lead 2', 'lead 3']);
  near(box([mesh(to.m, 'lead 2')]).z1, 0.5, 'the tab takes `leads thickness`');
  const cut = build(example('soic8.stomp').replace('pin1 dot', 'pin1 dot\n  lead 5 none')).m;
  assert.equal(leads(cut).length, 7, '`lead 5 none` removes a lead');
  const bad = compile(example('bga64.stomp').replace('lead ball 0.4', 'lead ball 0.4\n  lead A1 ball 0.5\n  lead Z9 ball 0.5'));
  assert.ok(errors(bad).some((d) => /pin A1 is omitted/.test(d.message)), 'an omitted pin has no lead');
  assert.ok(errors(bad).some((d) => /unknown object: pad Z9/.test(d.message)), 'unknown pins are reported');
});

test('model block: knobs, colors, solids, merging down extends', () => {
  const src = `footprint "P" {
  body 4 x 4 x 1
  pins 8 dual pitch 1.27
  lead gullwing 0.4 x 0.6 span 6
  model {
    standoff 0.05
    draft 0
    body color "#336699"
    leads color gold
    leads thickness 0.12
    pin1 dot
    box 2 x 2 x 0.3 on body color tin
    cylinder d 1 h 2 at (5, 0, 1) rotate (0, 90, 0)
  }
}
footprint "Q" extends "P" {
  model { standoff 0.2 }
}
footprint "R" extends "P" {
  no model
}
`;
  const out = compile(src);
  assert.deepEqual(errors(out), []);
  const P = M.build(out.footprints[0].result, { strict: true });
  near(P.top, 2, 'the model\'s top is its highest solid: the turned cylinder, bottom at 1, 1 mm thick');
  near(box([mesh(P, 'body')]).z0, 0.05, 'standoff');
  near(box([mesh(P, 'body')]).x1 - box([mesh(P, 'body')]).x0, 4, 'no draft: straight sides');
  assert.deepEqual(mesh(P, 'body').color.map((v) => Math.round(v * 255)), [0x33, 0x66, 0x99]);
  assert.equal(leads(P)[0].metal, 1);
  near(box(leads(P)).z1, 0.05 + (1 - 0.05) / 2 + 0.06, 'leads leave mid-way between standoff and top, 0.12 thick', 1e-6);
  near(box(leads(P)).z0, 0, 'feet on the board');
  const solids = P.meshes.filter((x) => x.kind === 'solid');
  assert.equal(solids.length, 2);
  near(box([solids[0]]).z0, 1, 'a box `on body` rests on the top');
  const cyl = box([solids[1]]);
  near(cyl.z0, 1, 'z sets the bottom of the turned cylinder');
  near(cyl.x1 - cyl.x0, 2, 'rotate (0, 90, 0) lays it along x');
  near((cyl.x0 + cyl.x1) / 2, 5, 'at (x, y) is the center');
  const Q = M.build(out.footprints[1].result, { strict: true });
  near(box([mesh(Q, 'body')]).z0, 0.2, 'a child model block overrides one setting');
  assert.equal(Q.meshes.filter((x) => x.kind === 'solid').length, 2, '…and keeps the parent\'s solids');
  assert.equal(M.build(out.footprints[2].result).none, true, '`no model` ends the model');
});

test('model block diagnostics', () => {
  const base = (m) => compile(`footprint "P" {\n  body 4 x 4 x 1\n  pins 8 dual pitch 1.27\n  lead gullwing 0.4 x 0.6 span 6\n  model {\n${m}\n  }\n}\n`);
  assert.ok(errors(base('    body color golf')).some((d) => /unknown color `golf` — did you mean `gold`\?/.test(d.message)));
  assert.ok(errors(base('    body color "#12345"')).some((d) => /isn't a color/.test(d.message)));
  assert.ok(errors(base('    draft 50')).some((d) => /between 0 and 45/.test(d.message)));
  assert.ok(warnings(base('    standoff 0.1\n    standoff 0.2')).some((d) => /given twice in this model block/.test(d.message)));
  assert.ok(warnings(base('    leads below 3')).some((d) => /surface-mount/.test(d.message)));
  assert.ok(errors(base('    box 1 x 1 on body')).length > 0, 'a box needs W x L x H');
  assert.ok(errors(compile('footprint "P" {\n  model { box 1 x 1 x 1 on body }\n  pad 1 rect 1 x 1 at (0, 0)\n}\n')).some((d) => /needs a `body`/.test(d.message)));
  assert.ok(errors(compile('footprint "P" {\n  body 1 x 1 x 1\n  model { standoff 1 }\n  model { standoff 2 }\n}\n')).some((d) => /given twice in this footprint/.test(d.message)));
});

test('exports: VRML in 0.1-inch units, binary STL', () => {
  const { m } = build(example('soic8.stomp'));
  const wrl = M.toVRML(m, 'SOIC-8');
  assert.ok(wrl.startsWith('#VRML V2.0 utf8'));
  assert.equal((wrl.match(/Transform \{/g) || []).length, m.meshes.length, 'one placement per part');
  const shapes = (wrl.match(/DEF S\d+ Shape/g) || []).length;
  assert.ok(shapes < m.meshes.length, 'identical leads are written once and reused');
  // KiCad reads VRML in 0.1-inch units: the right-hand toes at x = 3.0 mm are at 1.1811
  const pts = new Map();
  let maxX = -Infinity;
  for (const t of wrl.matchAll(/Transform \{ translation (\S+) (\S+) (\S+) children \[ (?:DEF (S\d+) Shape[\s\S]*?point \[ ([^\]]*) \]|USE (S\d+))/g)) {
    const tx = +t[1];
    let xs;
    if (t[4]) { xs = t[5].split(',').map((q) => +q.trim().split(/\s+/)[0]); pts.set(t[4], xs); } else xs = pts.get(t[6]);
    for (const x of xs) maxX = Math.max(maxX, tx + x);
  }
  near(maxX, 3.0 / 2.54, 'the toes, in 0.1-inch units', 1e-4);
  const stl = M.toSTL(m, 'SOIC-8');
  assert.equal(stl.length, 84 + 50 * m.triangles);
  assert.equal(new DataView(stl.buffer).getUint32(80, true), m.triangles);
  // both in an uncompressed zip, for hosts that only save .zip
  const wrlBytes = new TextEncoder().encode(wrl);
  const zip = M.toZip([{ name: 'SOIC-8.wrl', data: wrlBytes }, { name: 'SOIC-8.stl', data: stl }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'starts with a local file header');
  const end = zip.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50, 'ends with the end-of-central-directory record');
  assert.equal(dv.getUint16(end + 10, true), 2, 'two entries');
  const cd = dv.getUint32(end + 16, true);
  assert.equal(dv.getUint32(cd, true), 0x02014b50, 'the central directory is where the end record says');
  assert.equal(dv.getUint32(cd + 24, true), wrlBytes.length, 'first entry is stored at full size');
  // each name is stored twice: in its local header and in the central directory
  assert.equal(zip.length, 2 * (30 + 46) + 2 * 2 * 'SOIC-8.wrl'.length + wrlBytes.length + stl.length + 22);
});

test('the model builder never throws on mangled sources', () => {
  let seed = 777;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const bits = ['model {', '}', 'box 1 x 1 x 1', 'cylinder d 1 h 1', 'on body', 'at (1, 2, 3)', 'rotate (0, 90, 0)', 'lead 1 gullwing 1 x 1',
    'lead 2 none', 'standoff', 'height 0', 'draft', 'leads thickness 0', 'pin1 notch', 'polarized', 'body cylinder d 2 h 1', '0', '-1', '\n'];
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const f of readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp'))) {
      const src = example(f);
      for (let i = 0; i < 40; i++) {
        let s = src;
        for (let k = 0, n = 1 + rnd(4); k < n; k++) {
          const a = rnd(s.length + 1);
          s = rnd(3) ? s.slice(0, a) + bits[rnd(bits.length)] + s.slice(a) : s.slice(0, a) + s.slice(a + rnd(6));
        }
        const out = compile(s);
        // a library's rows share a template, so a sample of them is enough
        const built = out.footprints.filter((x) => x.result);
        const sample = built.length <= 6 ? built : [built[rnd(built.length)], built[rnd(built.length)]];
        for (const x of sample) {
          const m = M.build(x.result);
          const b = M.board(x.result, m);
          for (const y of m.meshes.concat(b.meshes)) for (const v of y.pos) assert.ok(Number.isFinite(v), `${f} mutation ${i}: ${x.name} ${y.name} is finite`);
        }
      }
    }
  } finally {
    console.error = quiet;
  }
});
