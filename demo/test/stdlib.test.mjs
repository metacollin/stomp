// The standard library, and the language it's written in: sections, flags,
// functions, colors, the 3D solids, and features that replace the library's.
// Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, compiler as C, model3d as M, outline } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const STDLIB = require('../js/stdlib.js');

const errors = (out) => out.diagnostics.filter((d) => d.severity === 'error');
const warnings = (out) => out.diagnostics.filter((d) => d.severity === 'warning');
const fresh = (src, opts) => compile(src, Object.assign({ cache: false }, opts));
const fp = (src, name) => {
  const out = fresh(src);
  const f = name ? out.footprints.find((x) => x.name === name) : out.footprints[0];
  return { out, r: f && f.result };
};
/** The silk lines a footprint's own `feature … at` placements draw (not the automatic ones). */
const placed = (r) => r.silk.filter((i) => !i.auto && i.type === 'line').map((i) => i.pts.map((q) => q.map((v) => +v.toFixed(4))));
const pad = 'pad 1 rect 1 x 1\n  pad 1 at (0, 0)\n';
const mesh = (m, name) => m.meshes.find((x) => x.name === name);
const tris = (m) => m.meshes.reduce((n, x) => n + x.idx.length / 3, 0);

test('the standard library parses cleanly, and stdlib.js matches stdlib/', () => {
  const out = fresh('');
  assert.deepEqual(out.library.diagnostics, []);
  const files = readdirSync(join(repo, 'stdlib')).filter((f) => f.endsWith('.stomp')).sort();
  assert.deepEqual(STDLIB.map((f) => f.file).sort(), files);
  for (const f of STDLIB) assert.equal(f.source, readFileSync(join(repo, 'stdlib', f.file), 'utf8'), `${f.file} is out of date in demo/js/stdlib.js`);
});

test('every hook the engine calls is in the library, and needs only what the engine passes', () => {
  const feats = new Map();
  for (const f of STDLIB) for (const it of outline(f.source)) if (it.type === 'Feature') feats.set(it.name, it);
  for (const [name, h] of Object.entries(C.HOOKS)) {
    const f = feats.get(name);
    assert.ok(f, `the standard library defines ${name}`);
    for (const q of f.params) assert.ok(q.def || h.args.includes(q.name) || q.name === 'e', `${name}(${q.name}): no default, and the engine doesn't pass it`);
  }
});

test('the engine passes each hook only the values the hooks table lists', () => {
  const seen = new Map();
  const files = readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp')).map((f) => readFileSync(join(repo, 'examples', f), 'utf8'));
  files.push(readFileSync(join(here, 'fixtures', 'corpus.stomp'), 'utf8'));
  for (const src of files) {
    for (const f of fresh(src).footprints) {
      if (!f.result) continue;
      // the features the engine bound without a written call, and the values it passed
      for (const c of M.build(f.result, { strict: true, recordHooks: true }).hookCalls) {
        if (!seen.has(c.name)) seen.set(c.name, new Set());
        for (const k of c.values) seen.get(c.name).add(k);
      }
    }
  }
  assert.ok(seen.size > 20, 'most hooks were called');
  for (const [name, keys] of seen) {
    const h = C.HOOKS[name];
    assert.ok(h, `${name} is in the hooks table`);
    for (const k of keys) assert.ok(h.args.includes(k), `the engine passes ${name} \`${k}\`, which the hooks table doesn't list`);
  }
});

test('sections: one name of several turns a section on, nesting needs all', () => {
  const src = `
feature tick(n = 1)
  section a, b; n = 2; end
  section c
    section d; n = 3; end
  end
  line (0, 0) (n, 0)
end
footprint "A"
  ${pad}  feature tick at (0, 10)
  feature tick(a) at (0, 20)
  feature tick(b) at (0, 30)
  feature tick(c) at (0, 40)
  feature tick(c, d) at (0, 50)
  feature tick(d) at (0, 60)
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual(placed(r).map((l) => l[1][0]), [1, 2, 2, 1, 3, 1]);
});

test('sections: precedence, conflicts and what a section may set', () => {
  const base = (sets, calls) => `
feature tick(n = 1)
  m = n
${sets}
  line (0, 0) (m, 0)
end
footprint "A"
  ${pad}${calls}
end`;
  // the caller's value, then the innermost section, then the default
  let r = fp(base('  section p\n    n = 2\n    section q; n = 3; end\n  end', '  feature tick(p, q) at (0, 0)\n  feature tick(p) at (0, 5)\n  feature tick(9, p, q) at (0, 10)')).r;
  assert.deepEqual(placed(r).map((l) => l[1][0]), [3, 2, 9]);
  // a name the feature gives a value can be set too
  r = fp(base('  section p; m = 7; end', '  feature tick(p) at (0, 0)')).r;
  assert.deepEqual(placed(r).map((l) => l[1][0]), [7]);
  // two sections side by side that set one name: an error at the second
  let out = fp(base('  section p; n = 2; end\n  section q; n = 3; end', '  feature tick(p, q) at (0, 0)')).out;
  assert.match(errors(out)[0].message, /sections `p` and `q` are both on and both set `n`/);
  // a name the feature doesn't have: a section gives names new values, it doesn't define them
  out = fp(base('  section p; k = 2; end', '  feature tick(p) at (0, 0)')).out;
  assert.match(errors(out)[0].message, /section `p` sets `k`, which isn't a parameter of `tick` or a name defined in it/);
});

test('flags: where they go, typos, keywords, values in parentheses, templates', () => {
  const src = (call) => `
p = 5
feature tick(n = 1, w2 = 0.1)
  section p; n = 2; end
  section dot; w2 = 0.2; end
  line (0, 0) (n, 0) width: w2
end
footprint "A"
  ${pad}  feature ${call} at (0, 0)
end`;
  const one = (call) => fp(src(call));
  assert.equal(one('tick(p)').r.silk.find((i) => !i.auto).pts[1][0], 2, 'a lone name a section has is a flag');
  assert.equal(one('tick((p))').r.silk.find((i) => !i.auto).pts[1][0], 5, 'in parentheses it is a value');
  assert.equal(one('tick(dot)').r.silk.find((i) => !i.auto).w, 0.2, 'keywords can be flags');
  assert.equal(one('tick(3, dot)').r.silk.find((i) => !i.auto).pts[1][0], 3, 'flags after the values');
  assert.equal(one('tick(dot, 3)').r.silk.find((i) => !i.auto).pts[1][0], 3, 'flags before the values');
  assert.match(errors(one('tick(3, dot, 0.5)').out)[0].message, /a flag goes before or after the values, not between them/);
  assert.match(errors(one('tick(p, p)').out)[0].message, /flag `p` is given twice/);
  assert.match(errors(one('tick(dott)').out)[0].message, /feature `tick` has no flag `dott` — did you mean `dot`\?/);
  assert.match(errors(one('tick(notch)').out)[0].message, /feature `tick` has no flag `notch`/);
  // a template takes values, not flags
  const t = fresh('template t(n = 1)\n  name: "T{n}"\n  pad 1 rect n x 1\nend\nfootprint from t(dot)');
  assert.match(errors(t)[0].message, /unknown name `dot`/);
});

test('flags flow down to the features a feature places', () => {
  const src = `
feature leaf(n = 1)
  section big; n = 4; end
  line (0, 0) (n, 0)
end
feature tree()
  feature leaf at (0, 0)
end
footprint "A"
  ${pad}  feature tree(big) at (0, 0)
  feature tree at (0, 5)
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual(placed(r).map((l) => l[1][0]), [4, 1]);
  // a feature takes the flags of what it places
  assert.match(errors(fp(src.replace('tree(big)', 'tree(bigg)')).out)[0].message, /did you mean `big`/);
});

test('functions: kinds, angles in degrees, colors', () => {
  const val = (x) => {
    const { out, r } = fp(`v = ${x}\nfootprint "A"\n  pad 1 rect v x 1\n  pad 1 at (0, 0)\nend`);
    return errors(out).length ? errors(out)[0].message : r.pads[0].shape.w;
  };
  assert.equal(val('min(2, 1mm, 3)'), 1);
  assert.equal(val('max(0.5, 2mm)'), 2);
  assert.equal(val('clamp(5, 1, 3)'), 3);
  assert.equal(val('clamp(-5, 1, 3)'), 1);
  assert.equal(val('abs(-1.5)'), 1.5);
  assert.equal(val('hypot(3, 4)'), 5);
  assert.equal(val('sqrt(16)'), 4);
  assert.equal(val('2 * cos(90) + 1'), 1, 'right angles are exact');
  assert.equal(+val('1 + sin(30)').toFixed(12), 1.5);
  assert.equal(+val('atan2(1, 1)').toFixed(12), 45);
  assert.equal(+val('acos(0) / 90').toFixed(12), 1);
  assert.equal(val('2.5E1 * 1e-1'), 2.5);
  assert.match(val('sqrt(4mm)'), /`sqrt` of a length/);
  assert.match(val('asin(2)'), /takes a number from -1 to 1/);
  assert.match(val('maxx(1, 2)'), /unknown function `maxx` — did you mean `max`\?/);
  assert.match(val('min()'), /`min` takes 1 or more arguments/);
  assert.match(val('mix(red, 1, 2)'), /a color is needed here/);
  assert.match(val('red + 1'), /a color can't take part in arithmetic/);
});

test('colors: names, palette, mixes and metals, wherever a color goes', () => {
  const src = `
shade = mix(can_blue, "#ffffff", 0.5)
footprint "A"
  body 2 x 2 x 1
  ${pad}  model
    body color: shade
    leads color: metal("#808080")
    box 1 x 1 x 1 color: can_blue
    box 1 x 1 x 1 at (0, 0, 2) color: red
  end
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const P = r.model.props;
  assert.equal(P.leadsColor.metal, 1);
  const cb = [0x2b / 255, 0x3a / 255, 0x52 / 255];
  P.bodyColor.rgb.forEach((c, i) => assert.ok(Math.abs(c - (cb[i] + (1 - cb[i]) * 0.5)) < 1e-12));
  const m = M.build(r, { strict: true });
  assert.deepEqual(m.meshes.filter((x) => x.kind === 'solid').map((x) => x.color.map((c) => Math.round(c * 255))), [[0x2b, 0x3a, 0x52], [0xb3, 0x35, 0x2c]]);
  const bad = fp(src.replace('color: red', 'color: redd')).out;
  assert.match(errors(bad)[0].message, /unknown color `redd` — did you mean `red`\?/);
});

test('angles can be computed, and features can\'t place themselves forever', () => {
  const { out, r } = fp(`
turn = 45
feature arm()
  line (0, 0) (1, 0)
end
footprint "A"
  ${pad}  feature arm at (0, 0) rotate: turn + 45
end`);
  assert.deepEqual(errors(out), []);
  const l = placed(r)[0];
  assert.deepEqual(l[1], [0, 1]);
  const loop = fresh(`feature a()\n  feature b at (0, 0)\nend\nfeature b()\n  feature a at (0, 0)\nend\nfootprint "A"\n  ${pad}  feature a at (0, 0)\nend`);
  assert.match(errors(loop)[0].message, /features place each other more than 32 deep/);
});

test('every solid builds a consistent mesh; a feature\'s zero-size solid draws nothing', () => {
  const src = `
feature everything()
  box 1 x 2 x 0.5
  cylinder d: 1 to 0.5 h: 1 at (2, 0, 0) segments: 16
  cylinder d: 1 h: 1 at (4, 0, 0) from 0 to 90 segments: 8
  sphere d: 1 h: 0.6 at (6, 0, 0)
  disc d: 1 at (8, 0, 0)
  disc d: 0.5 to 1 at (10, 0, 0) down
  disc d: 0.5 to 1 at (12, 0, 0) from 0 to 180 segments: 6
  prism (0, 0), (1, 0), (0, 1) h: 0.3 at (14, 0, 0)
  face arc (0, 0) r: 0.5 from 0 to 180 segments: 8 at (16, 0, 0)
  loft 1 x 1 at 0, 0.5 x 0.5 at 1 at (18, 0, 0)
  sweep 0.3 x 0.1 fillet: 0.2 along (0, 1), (1, 1), (1, 0) at (20, 0, 0)
  wire d: 0.2 fillet: 0.3 along (0, 1), (1, 1), (1, 0) at (22, 0, 0)
  box 0 x 1 x 1 at (24, 0, 0)
end
footprint "A"
  ${pad}  feature everything at (0, 0, 0)
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r, { strict: true });
  const s = m.meshes[0];
  assert.equal(s.name, 'everything');
  // every triangle counter-clockwise seen from where its normals point
  const P = s.pos, N = s.nrm, I = s.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(f[0] * (N[a] + N[b] + N[c]) + f[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + f[2] * (N[a + 2] + N[b + 2] + N[c + 2]) >= -1e-12);
  }
  assert.ok(m.bbox.x1 < 23.2, 'the zero-width box drew nothing');
  // the same box in a footprint's model block is a warning
  const w = fresh(`footprint "A"\n  ${pad}  model; box 0 x 1 x 1; end\nend`);
  assert.match(warnings(w)[0].message, /the box width is zero/);
});

test('your feature replaces the library\'s everywhere in the file, the library\'s own calls included', () => {
  const can = 'footprint "C"\n  refdes: "C"\n  body cylinder d: 6 h: 7\n  pins 2 horizontal pitch: 2.5\n  lead wire d: 0.5\n  polarized\nend';
  const before = M.build(fp(can).r, { strict: true });
  const after = M.build(fp(`feature can_vent(D)\n  cylinder d: D / 4 h: 0.01 segments: 6 color: red name: "vent"\nend\n${can}`).r, { strict: true });
  assert.equal(tris({ meshes: [mesh(before, 'vent')] }), 24);
  assert.equal(tris({ meshes: [mesh(after, 'vent')] }), 24 - 24 + 6 * 2 + 4 + 4);
  // the silk's pin-1 dot, through pin1_dot
  const soic = 'footprint "S"\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch: 1.27\n  lead gullwing 0.41 x 1.04 span: 6\n  pin1: dot\nend';
  const dot = fp(soic).r.silk.filter((i) => i.type === 'circle');
  const tri = fp(`feature pin1_dot(d = 0.3)\n  polygon (0, 0) (d, 0) (0, d) fill\nend\n${soic}`).r.silk;
  assert.equal(dot.length, 1);
  assert.equal(tri.filter((i) => i.type === 'circle').length, 0);
  assert.equal(tri.filter((i) => i.type === 'poly').length, 1);
  // a replacement the library can't call gets a warning
  const out = fresh('feature can_vent(D, depth)\n  box D x D x depth\nend\nfeature body_sawn(W, L, H, flavor)\n  box W x L x H\nend');
  assert.deepEqual(warnings(out).map((d) => d.message), [
    'the standard library places `can_vent` without a value for `depth`: give it a default',
    '`body_sawn` replaces the standard library\'s, and the 3D model never gives `flavor` a value: give it a default',
  ]);
});

test('body shape and leads shape: your features, with the engine\'s values, your values and flags', () => {
  const src = `
feature pillbox(W, L, H, z0 = 0, height_k = 1)
  section tall2; height_k = 2; end
  box W x L x height_k * H at (0, 0, z0) color: green
end
feature stub(edge, pad_u, b = 0.3)
  box pad_u - edge x b x 0.1 at ((edge + pad_u) / 2, 0, 0) color: gold
end
footprint "P"
  body 2 x 2 x 1
  pins 4 dual pitch: 1
  lead gullwing 0.3 x 0.5 span: 3
  model
    body shape: pillbox(tall2)
    leads shape: stub(b: 0.2)
  end
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r, { strict: true });
  assert.equal(m.summary.split(' · ')[0], 'body shape pillbox');
  assert.equal(m.bbox.z1, 2, 'the flag doubled the height');
  const l1 = mesh(m, 'lead 1');
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < l1.pos.length; k += 3) { x0 = Math.min(x0, l1.pos[k]); x1 = Math.max(x1, l1.pos[k]); y0 = Math.min(y0, l1.pos[k + 1]); y1 = Math.max(y1, l1.pos[k + 1]); }
  assert.ok(Math.abs((x1 - x0) - 0.25) < 1e-6 && Math.abs((y1 - y0) - 0.2) < 1e-6, 'lead 1 runs from the body edge to the pad center, b wide');
  assert.ok(x1 <= -1 + 1e-6, 'pin 1 is on the left: the frame mirrors it');
});

test('a feature placed in a footprint: its solids placed, turned, lifted onto the body', () => {
  const src = `
feature fin(h2 = 1)
  box 0.2 x 1 x h2
end
footprint "F"
  body 2 x 2 x 1
  ${pad}  feature fin at (0.5, 0) on body
  feature fin(2) at (-0.5, 0, 3) rotate: (0, 0, 90)
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r, { strict: true });
  const [a, b] = m.meshes.filter((x) => x.name === 'fin');
  const bb = (x) => { const q = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let k = 0; k < x.pos.length; k += 3) for (let j = 0; j < 3; j++) { q[j] = Math.min(q[j], x.pos[k + j]); q[j + 3] = Math.max(q[j + 3], x.pos[k + j]); } return q.map((v) => +v.toFixed(6)); };
  assert.deepEqual(bb(a), [0.4, -0.5, 1, 0.6, 0.5, 2]);
  assert.deepEqual(bb(b), [-1, -0.1, 3, 0, 0.1, 5]);
  assert.equal(m.summary.split(' · ').pop(), '2 extra parts');
  // one placement draws both a feature's silk and its solids, at a pad too
  const both = fp(`
feature tagged()
  line (0, 0) (1, 0)
  box 0.2 x 0.2 x 0.2
end
footprint "G"
  body 2 x 2 x 1
  pad 1 rect 1 x 1
  pad 1 at (3, 0)
  feature tagged at pad 1
end`);
  assert.deepEqual(errors(both.out), []);
  assert.deepEqual(placed(both.r), [[[3, 0], [4, 0]]]);
  assert.deepEqual(bb(M.build(both.r, { strict: true }).meshes.find((x) => x.name === 'tagged')), [2.9, -0.1, 0, 3.1, 0.1, 0.2]);
  // a model block holds settings and solids; features are placed in the footprint
  const old = fresh(`feature fin()\n  box 1 x 1 x 1\nend\nfootprint "H"\n  body 2 x 2 x 1\n  ${pad}  model\n    feature fin at (0, 0)\n  end\nend`);
  assert.match(errors(old)[0].message, /place a feature in the footprint, after the `model` block/);
});

test('a problem inside the library is reported where the footprint uses it', () => {
  const src = 'footprint "S"\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch: 1.27\n  lead gullwing 0.41 x 1.04 span: 6\n  model; body shape: body_molded(draft: "steep"); end\nend';
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r);
  const d = m.diagnostics.find((x) => x.severity === 'error');
  assert.ok(d, 'the model reports it');
  assert.match(d.message, /in the standard library's `body_molded` → `molded_block`/);
  assert.equal(src.slice(d.s, d.e), 'body shape: body_molded(draft: "steep")');
  assert.throws(() => M.build(r, { strict: true }), /molded_block/);
});

test('silk: lines marked clear are cut back from the copper; hatch draws chords', () => {
  const src = `
footprint "H"
  pad 1 rect 1 x 1
  pad 1 at (0, 0)
  line (-2, 0) (2, 0) clear
  line (-2, 2) (2, 2)
  hatch (0, 4) d: 2 from 0 to 1 pitch: 0.25
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const lines = r.silk.filter((i) => i.type === 'line');
  const across = lines.filter((i) => i.pts[0][1] === 0);
  assert.equal(across.length, 2, 'the clear line is cut in two around the pad');
  assert.ok(across.every((i) => Math.min(...i.pts.map((q) => Math.abs(q[0]))) > 0.5));
  assert.equal(lines.filter((i) => i.pts[0][1] === 2).length, 1);
  const chords = lines.filter((i) => i.pts[0][0] === i.pts[1][0]);
  assert.deepEqual(chords.map((i) => i.pts[0][0]), [0, 0.25, 0.5, 0.75]);
  assert.ok(Math.abs(chords[1].pts[1][1] - 4 - Math.sqrt(1 - 0.0625)) < 1e-12);
});

test('edited library sources: compile with them, and their problems are kept apart', () => {
  const lib = STDLIB.map((f) => (f.file === 'cans.stomp' ? { file: f.file, source: f.source.replace('lip = min(0.12, 0.02 * (H - z0) + 0.04)', 'lip = 0.5') } : f));
  const can = 'footprint "C"\n  refdes: "C"\n  body cylinder d: 6 h: 7\n  pins 2 horizontal pitch: 2.5\n  lead wire d: 0.5\nend';
  const a = M.build(fresh(can).footprints[0].result, { strict: true });
  const b = M.build(fresh(can, { stdlib: lib }).footprints[0].result, { strict: true });
  const top = (m) => { const t = mesh(m, 'can top'); let z = -Infinity; for (let k = 2; k < t.pos.length; k += 3) z = Math.max(z, t.pos[k]); return +z.toFixed(4); };
  assert.equal(top(a), 6.88);
  assert.equal(top(b), 6.5);
  const broken = STDLIB.map((f) => (f.file === 'cans.stomp' ? { file: f.file, source: f.source + '\nfeature oops( {\n' } : f));
  const out = fresh(can, { stdlib: broken });
  assert.deepEqual(errors(out), []);
  assert.ok(out.library.diagnostics.length && out.library.diagnostics.every((d) => d.file === 'cans.stomp'));
});

test('mangled library sources never throw (fuzz)', () => {
  let seed = 777;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const bits = ['{', '}', '(', ')', ',', 'section', 'model', 'feature', 'at', 'x', '=', '-', '*', 'min(', 'rotate:', 'along', 'fillet:', '1e-', '"', '\n', 'arc', 'segments:', 'kind:', 'open',
    'end', '\nend\n', ':', ';', 'let', '\nfeature f\n', 'layer: assembly'];
  const parts = [
    'footprint "S"\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch: 1.27\n  lead gullwing 0.41 x 1.04 span: 6\n  pin1: dot\nend',
    'footprint "C"\n  refdes: "C"\n  body cylinder d: 6 h: 7\n  pins 2 horizontal pitch: 2.5\n  lead wire d: 0.5\n  polarized\nend',
    'footprint "Q"\n  body 4 x 4 x 0.9\n  pins 16 quad pitch: 0.65\n  lead flat 0.3 x 0.4\n  thermal pad "17" 2 x 2\nend',
  ].join('\n');
  const quiet = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 60; i++) {
      const lib = STDLIB.map((f) => {
        if (rnd(3)) return f;
        let s = f.source;
        for (let k = 0, n = 1 + rnd(3); k < n; k++) {
          const a = rnd(s.length + 1);
          s = rnd(2) ? s.slice(0, a) + bits[rnd(bits.length)] + s.slice(a) : s.slice(0, a) + s.slice(a + rnd(6));
        }
        return { file: f.file, source: s };
      });
      const out = fresh(parts, { stdlib: lib });
      assert.deepEqual(out.diagnostics.filter((d) => d.message.startsWith('internal error')).map((d) => d.message), [], `mutation ${i}`);
      for (const f of out.footprints) {
        if (!f.result) continue;
        const m = M.build(f.result);
        assert.ok(m.meshes.every((x) => x.pos.every(Number.isFinite)), `mutation ${i}: finite`);
        assert.deepEqual(m.diagnostics.filter((d) => d.message.startsWith('internal error')).map((d) => d.message), [], `mutation ${i}: model`);
        void f.result.silk;
      }
    }
  } finally {
    console.error = quiet;
  }
});

/** A footprint's 3D model, which must compile cleanly. */
const modelOf = (src) => { const { out, r } = fp(src); assert.deepEqual(errors(out), []); return M.build(r, { strict: true }); };
const meshNames = (m) => m.meshes.map((x) => x.name);
/** The size of a mesh's bounding box, and its lowest and highest z. */
const extent = (s) => {
  const P = s.pos, bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < P.length; k += 3) for (let j = 0; j < 3; j++) { bb[j] = Math.min(bb[j], P[k + j]); bb[j + 3] = Math.max(bb[j + 3], P[k + j]); }
  return [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2], bb[2], bb[5]].map((v) => +v.toFixed(4));
};
/** Every triangle counter-clockwise seen from where its normals point. */
const wound = (s) => {
  const P = s.pos, N = s.nrm, I = s.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (f[0] * (N[a] + N[b] + N[c]) + f[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + f[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < -1e-12) return false;
  }
  return true;
};

test('the refdes names the part\'s family', () => {
  const fam = (refdes) => fp(`footprint "F"\n  refdes: "${refdes}"\n  ${pad}end`).r.family;
  const want = {
    LED: 'diode', D: 'diode', FB: 'inductor', L: 'inductor', XTAL: 'crystal', Y: 'crystal', OSC: 'oscillator', XO: 'oscillator',
    X: 'oscillator', SW: 'switch', S: 'switch', BZ: 'buzzer', LS: 'buzzer', CON: 'connector', CN: 'connector', J: 'connector',
    P: 'connector', IC: 'ic', U: 'ic', R: 'resistor', C: 'capacitor', F: 'fuse', Q: 'transistor', K: null, TP: null,
  };
  for (const [refdes, family] of Object.entries(want)) assert.equal(fam(refdes), family, refdes);
});

test('the library draws what a family needs: lids, bases, LEDs, lenses, bands, socket openings', () => {
  // a crystal or an oscillator: a ceramic package under a metal lid, within the body's height
  const xtal = (ref) => `footprint "Y"\n  refdes: "${ref}"\n  body 3.2 x 2.5 x 0.8\n  pins\n    bottom: 1, 2 pitch: 2.2\n    top: 3, 4\n  end\n  lead flat 1.4 x 1.1\n  pin1: none\nend`;
  for (const ref of ['Y', 'X']) {
    const m = modelOf(xtal(ref));
    assert.ok(meshNames(m).includes('lid'), `${ref} has a lid`);
    assert.equal(m.top, 0.8);
  }
  assert.ok(!meshNames(modelOf(xtal('U'))).includes('lid'));
  // an inductor's body is ferrite
  const ind = (ref) => `footprint "L"\n  refdes: "${ref}"\n  body 4 x 4 x 2\n  pins 2 horizontal\n  lead flat 1.5 x 1\n  pin1: none\nend`;
  assert.notDeepEqual(mesh(modelOf(ind('L')), 'body').color, mesh(modelOf(ind('R')), 'body').color);
  // a can on flat leads stands on a plastic base
  assert.ok(meshNames(modelOf('footprint "C"\n  refdes: "C"\n  body cylinder d: 6.3 h: 5.4\n  pins 2 horizontal pitch: 5.4\n  lead flat 0.65 x 2.2\n  polarized\nend')).includes('base'));
  // a round body on wires is an LED for a D refdes: red, unless the model block says
  const led = (ref, extra = '') => `footprint "D"\n  refdes: "${ref}"\n  body cylinder d: 5 h: 8.6\n  pins 2 horizontal pitch: 2.54\n  lead wire 0.5 x 0.5\n  polarized\n${extra}end`;
  const red = modelOf(led('D')), green = modelOf(led('D', '  model\n    body color: led_green\n  end\n'));
  assert.equal(red.style, 'led');
  assert.equal(red.summary, 'LED · 2 wires');
  assert.equal(red.top, 8.6, 'the dome stops at the body\'s height');
  assert.notDeepEqual(mesh(red, 'body').color, mesh(green, 'body').color);
  assert.equal(modelOf(led('C')).style, 'can');
  // a J-lead diode is a PLCC LED: a lens on top, and no pin-1 dimple under it
  const plcc = (ref) => `footprint "P"\n  refdes: "${ref}"\n  body 3.5 x 2.8 x 1.9\n  pins 2 dual pitch: 1.0\n  lead jlead 2.2 x 0.8 span: 3.5\n  pin1: dot\nend`;
  assert.deepEqual(meshNames(modelOf(plcc('D'))), ['body', 'lens', 'lead 1', 'lead 2']);
  assert.deepEqual(meshNames(modelOf(plcc('U'))), ['body', 'lead 1', 'lead 2', 'pin-1 dimple']);
  // an axial resistor gets color bands, a diode its cathode band
  const ax = (ref, pol) => `footprint "A"\n  refdes: "${ref}"\n  body cylinder d: 2.5 h: 6.3\n  pins 2 horizontal pitch: 10.16\n  lead wire d: 0.6\n${pol ? '  polarized\n' : ''}end`;
  assert.equal(meshNames(modelOf(ax('R'))).filter((n) => n === 'bands').length, 4);
  assert.deepEqual(meshNames(modelOf(ax('D', true))), ['body', 'lead 1', 'lead 2', 'cathode band']);
  // a housing as tall as its pins is a socket: an opening over each pin, which leaves the height alone
  const sock = modelOf('footprint "S"\n  refdes: "J"\n  body 2.54 x 5.08 x 4\n  pins grid 1 x 2 pitch: 2.54\n  lead pin 0.64 x 0.64\n  default pad tht circle 1.7 drill: 1.0\nend');
  assert.deepEqual(meshNames(sock).filter((n) => n.startsWith('opening')), ['opening 1', 'opening 2']);
  assert.equal(sock.top, 4);
});

test('shapes: consistent meshes of the sizes they say, with a color and a name', () => {
  const src = `
footprint "S"
  ${pad}  feature rounded_box(2, 3, 1, r: 0.3) at (0, 0, 0)
  feature chamfered_box(2, 3, 1, c: 0.4) at (5, 0, 0)
  feature beveled_box(2, 3, 1) at (10, 0, 0)
  feature dome(2, 0.5) at (15, 0, 0)
  feature torus(4, 0.5) at (20, 0, 1)
  feature hex_prism(3, 1) at (25, 0, 0)
  feature post(0.64, z0: -3, z1: 6, name: "round post") at (30, 0, 0)
  feature post(0.64, z0: -3, z1: 6, square) at (35, 0, 0)
  feature rounded_box(1, 1, 1, name: "cap", color: red) at (40, 0, 0)
end`;
  const m = modelOf(src);
  for (const s of m.meshes) assert.ok(wound(s), `${s.name} is wound consistently`);
  const size = (name) => extent(mesh(m, name));
  assert.deepEqual(size('rounded_box'), [2, 3, 1, 0, 1]);
  assert.deepEqual(size('chamfered_box'), [2, 3, 1, 0, 1]);
  assert.deepEqual(size('beveled_box'), [2, 3, 1, 0, 1]);
  assert.deepEqual(size('dome'), [2, 2, 1, -0.5, 0.5], 'the top half above its origin, the rest below');
  assert.deepEqual(size('hex_prism'), [+(2 * 3 / Math.sqrt(3)).toFixed(4), 3, 1, 0, 1], 'across its flats along y');
  assert.deepEqual(size('torus').slice(1), [4, 0.5, 0.75, 1.25]);
  assert.deepEqual(size('post'), [0.64, 0.64, 9, -3, 6], 'square');
  assert.equal(m.meshes.filter((x) => x.name === 'round post').length, 3, 'round when not square: three cylinders');
  assert.deepEqual(size('cap'), [1, 1, 1, 0, 1]);
  assert.notDeepEqual(mesh(m, 'cap').color, mesh(m, 'rounded_box').color);
});

test('symbols: a pin-1 mark, or placed anywhere in the silk', () => {
  const src = `
footprint "Y"
  ${pad}  pin1: triangle
  feature corners(4, 4, len: 1) at (0, 0)
  feature arrow(1.5) at (3, 0) rotate: 90
  feature plus at (5, 0)
  feature minus at (6, 0)
  feature cross at (7, 0)
  feature ring at (8, 0)
  feature frame(2, 1) at (9, 0)
end`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const kinds = r.silk.map((i) => `${i.type}${i.fill ? ' fill' : ''} ${(i.pts || []).length}`);
  assert.deepEqual(kinds, ['poly fill 3', ...Array(8).fill('line 2'), 'poly fill 3', ...Array(6).fill('line 2'), 'circle 0', 'line 5']);
  // the arrow's tip is where it's placed, turned to point up
  const head = r.silk[9].pts.map((q) => q.map((v) => +v.toFixed(4)));
  assert.deepEqual(head[0], [3, 0]);
  assert.ok(head[1][1] < 0 && head[2][1] < 0, 'the head trails below the tip');
});

test('packages: body shape names one, drawn within the body\'s height', () => {
  const part = (shape, body, pins, extra = '') => modelOf(`footprint "P"\n  body ${body}\n  ${pins}\n  default pad tht circle 1.6 drill: 0.9\n${extra}  model\n    body shape: ${shape}\n  end\nend`);
  const want = {
    to92: ['4.8 x 3.8 x 5.8', 'pins grid 3 x 1 pitch: 1.27\n  lead wire 0.45 x 0.4', ['body']],
    to220: ['10.2 x 4.5 x 15.6', 'pins grid 3 x 1 pitch: 2.54\n  lead wire 0.8 x 0.5', ['body', 'tab', 'hole']],
    hc49: ['11.5 x 4.65 x 3.5', 'pins 2 horizontal pitch: 4.88\n  lead wire d: 0.43', ['body']],
    tact_switch: ['6 x 6 x 5', 'pins grid 2 x 2 pitch: 6.5 x 4.5\n  lead wire 0.7 x 0.3', ['body', 'cover', 'actuator']],
    buzzer: ['cylinder d: 12 h: 9.5', 'pins 2 horizontal pitch: 7.6\n  lead wire d: 0.6\n  polarized', ['body', 'sound hole', 'polarity mark']],
  };
  for (const [shape, [body, pins, names]] of Object.entries(want)) {
    const m = part(shape, body, pins);
    assert.equal(m.summary.split(' · ')[0], `body shape ${shape}`);
    assert.deepEqual(meshNames(m).filter((n) => !n.startsWith('lead ')), names, shape);
    assert.equal(m.top, +body.match(/[\d.]+$/)[0], `${shape} stops at the body's height`);
    for (const s of m.meshes) assert.ok(wound(s), `${shape}: ${s.name} is wound consistently`);
  }
});

test('a solid\'s name can come from a parameter, and must be text', () => {
  const src = `
feature tagged(label = "tag")
  box 1 x 1 x 1 name: label
end
footprint "N"
  ${pad}  feature tagged at (0, 0, 0)
  feature tagged(label: "other") at (2, 0, 0)
  feature tagged(label: "") at (4, 0, 0)
end`;
  assert.deepEqual(meshNames(modelOf(src)), ['tag', 'other', 'tagged']);
  const bad = fresh(`feature tagged(label = 3)\n  box 1 x 1 x 1 name: label\nend\nfootprint "N"\n  ${pad}  feature tagged at (0, 0, 0)\nend`);
  assert.deepEqual(errors(bad).map((d) => d.message), ['a solid\'s `name:` is text, such as "lid"']);
});

test('the automatic silk marks get the style and family flags', () => {
  const led = 'footprint "D"\n  refdes: "D"\n  body cylinder d: 5 h: 8.6\n  pins 2 horizontal pitch: 2.54\n  lead wire 0.5 x 0.5\n  polarized\nend';
  const mine = `feature polarity_plus(s = 0.5)\n  section led\n    circle (0, 0) d: s fill\n  end\n  section capacitor\n    line (-s / 2, 0) (s / 2, 0)\n  end\nend\n`;
  const marks = (src) => fp(src).r.silk.filter((i) => i.auto && (i.type === 'circle' && i.fill || i.type === 'line' && i.pts.length === 2 && Math.abs(i.pts[0][1] - i.pts[1][1]) < 1e-9 && Math.abs(Math.hypot(i.pts[1][0] - i.pts[0][0], 0) - 0.5) < 1e-9));
  assert.deepEqual(marks(mine + led).map((i) => i.type), ['circle']);
  assert.deepEqual(marks(mine + led.replace('"D"\n  body', '"C"\n  body')).map((i) => i.type), ['line']);
});
