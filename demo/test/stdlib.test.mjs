// The standard library, and the language it's written in: sections, flags,
// functions, colors, the 3D solids, and features that replace the library's.
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
const C = require('../js/compile.js');
const { compile } = C;
const M = require('../js/model3d.js');
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
  const L = require('../js/lexer.js'), P = require('../js/parser.js');
  const feats = new Map();
  for (const f of STDLIB) for (const it of P.parse(L.lex(f.source, []).tokens, []).items) if (it.type === 'Feature') feats.set(it.name, it);
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
      if (!f.result || !f.result.model || !f.result.model.hooks) continue;
      const H = f.result.model.hooks;
      const bind = H.bind;
      H.bind = (name, values, flags, trigger, written) => {
        if (!written) for (const k of Object.keys(values || {})) { if (!seen.has(name)) seen.set(name, new Set()); seen.get(name).add(k); }
        return bind(name, values, flags, trigger, written);
      };
      M.build(f.result, { strict: true });
      H.bind = bind;
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
feature tick(n = 1) {
  section a, b { n = 2 }
  section c {
    section d { n = 3 }
  }
  silk { line (0, 0) (n, 0) }
}
footprint "A" {
  ${pad}  feature tick at (0, 10)
  feature tick(a) at (0, 20)
  feature tick(b) at (0, 30)
  feature tick(c) at (0, 40)
  feature tick(c, d) at (0, 50)
  feature tick(d) at (0, 60)
}`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual(placed(r).map((l) => l[1][0]), [1, 2, 2, 1, 3, 1]);
});

test('sections: precedence, conflicts and what a section may set', () => {
  const base = (sets, calls) => `
feature tick(n = 1) {
  let m = n
${sets}
  silk { line (0, 0) (m, 0) }
}
footprint "A" {
  ${pad}${calls}
}`;
  // the caller's value, then the innermost section, then the default
  let r = fp(base('  section p {\n    n = 2\n    section q { n = 3 }\n  }', '  feature tick(p, q) at (0, 0)\n  feature tick(p) at (0, 5)\n  feature tick(9, p, q) at (0, 10)')).r;
  assert.deepEqual(placed(r).map((l) => l[1][0]), [3, 2, 9]);
  // a let can be set too
  r = fp(base('  section p { m = 7 }', '  feature tick(p) at (0, 0)')).r;
  assert.deepEqual(placed(r).map((l) => l[1][0]), [7]);
  // two sections side by side that set one name: an error at the second
  let out = fp(base('  section p { n = 2 }\n  section q { n = 3 }', '  feature tick(p, q) at (0, 0)')).out;
  assert.match(errors(out)[0].message, /sections `p` and `q` are both on and both set `n`/);
  // a name the feature doesn't have
  out = fp(base('  section p { k = 2 }', '  feature tick(p) at (0, 0)')).out;
  assert.match(errors(out)[0].message, /section `p` sets `k`, which isn't a parameter or a `let` of `tick`/);
  // no lets in a section
  out = fresh('feature f(n = 1) {\n  section p {\n    let k = 1\n  }\n}');
  assert.match(errors(out)[0].message, /a `let` goes at the top level/);
});

test('flags: where they go, typos, keywords, values in parentheses, templates', () => {
  const src = (call) => `
let p = 5
feature tick(n = 1, w2 = 0.1) {
  section p { n = 2 }
  section dot { w2 = 0.2 }
  silk { line (0, 0) (n, 0) width w2 }
}
footprint "A" {
  ${pad}  feature ${call} at (0, 0)
}`;
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
  const t = fresh('template t(n = 1) {\n  name "T{n}"\n  pad 1 rect n x 1\n}\nfootprint from t(dot)');
  assert.match(errors(t)[0].message, /`dot` is a keyword: a template takes values, not flags/);
});

test('flags flow down to the features a feature places', () => {
  const src = `
feature leaf(n = 1) {
  section big { n = 4 }
  silk { line (0, 0) (n, 0) }
}
feature tree() {
  silk { feature leaf at (0, 0) }
}
footprint "A" {
  ${pad}  feature tree(big) at (0, 0)
  feature tree at (0, 5)
}`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual(placed(r).map((l) => l[1][0]), [4, 1]);
  // a feature takes the flags of what it places
  assert.match(errors(fp(src.replace('tree(big)', 'tree(bigg)')).out)[0].message, /did you mean `big`/);
});

test('functions: kinds, angles in degrees, colors', () => {
  const val = (x) => {
    const { out, r } = fp(`let v = ${x}\nfootprint "A" {\n  pad 1 rect v x 1\n  pad 1 at (0, 0)\n}`);
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
let shade = mix(can_blue, "#ffffff", 0.5)
footprint "A" {
  body 2 x 2 x 1
  ${pad}  model {
    body color shade
    leads color metal("#808080")
    box 1 x 1 x 1 color can_blue
    box 1 x 1 x 1 at (0, 0, 2) color red
  }
}`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const P = r.model.props;
  assert.equal(P.leadsColor.metal, 1);
  const cb = [0x2b / 255, 0x3a / 255, 0x52 / 255];
  P.bodyColor.rgb.forEach((c, i) => assert.ok(Math.abs(c - (cb[i] + (1 - cb[i]) * 0.5)) < 1e-12));
  const m = M.build(r, { strict: true });
  assert.deepEqual(m.meshes.filter((x) => x.kind === 'solid').map((x) => x.color.map((c) => Math.round(c * 255))), [[0x2b, 0x3a, 0x52], [0xb3, 0x35, 0x2c]]);
  const bad = fp(src.replace('color red', 'color redd')).out;
  assert.match(errors(bad)[0].message, /unknown color `redd` — did you mean `red`\?/);
});

test('angles can be computed, and features can\'t place themselves forever', () => {
  const { out, r } = fp(`
let turn = 45
feature arm() {
  silk { line (0, 0) (1, 0) }
}
footprint "A" {
  ${pad}  feature arm at (0, 0) rotate turn + 45
}`);
  assert.deepEqual(errors(out), []);
  const l = placed(r)[0];
  assert.deepEqual(l[1], [0, 1]);
  const loop = fresh(`feature a() {\n  silk { feature b at (0, 0) }\n}\nfeature b() {\n  silk { feature a at (0, 0) }\n}\nfootprint "A" {\n  ${pad}  feature a at (0, 0)\n}`);
  assert.match(errors(loop)[0].message, /features place each other more than 32 deep/);
});

test('every solid builds a consistent mesh; a feature\'s zero-size solid draws nothing', () => {
  const src = `
feature everything() {
  model {
    box 1 x 2 x 0.5
    cylinder d 1 to 0.5 h 1 at (2, 0, 0) segments 16
    cylinder d 1 h 1 at (4, 0, 0) from 0 to 90 segments 8
    sphere d 1 h 0.6 at (6, 0, 0)
    disc d 1 at (8, 0, 0)
    disc d 0.5 to 1 at (10, 0, 0) down
    disc d 0.5 to 1 at (12, 0, 0) from 0 to 180 segments 6
    prism (0, 0), (1, 0), (0, 1) h 0.3 at (14, 0, 0)
    face arc (0, 0) r 0.5 from 0 to 180 segments 8 at (16, 0, 0)
    loft 1 x 1 at 0, 0.5 x 0.5 at 1 at (18, 0, 0)
    sweep 0.3 x 0.1 fillet 0.2 along (0, 1), (1, 1), (1, 0) at (20, 0, 0)
    wire d 0.2 fillet 0.3 along (0, 1), (1, 1), (1, 0) at (22, 0, 0)
    box 0 x 1 x 1 at (24, 0, 0)
  }
}
footprint "A" {
  ${pad}  model { feature everything at (0, 0, 0) }
}`;
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
  const w = fresh(`footprint "A" {\n  ${pad}  model { box 0 x 1 x 1 }\n}`);
  assert.match(warnings(w)[0].message, /the box width is zero/);
});

test('your feature replaces the library\'s everywhere in the file, the library\'s own calls included', () => {
  const can = 'footprint "C" {\n  refdes "C"\n  body cylinder d 6 h 7\n  pins 2 horizontal pitch 2.5\n  lead wire d 0.5\n  polarized\n}';
  const before = M.build(fp(can).r, { strict: true });
  const after = M.build(fp(`feature can_vent(D) {\n  model { cylinder d D / 4 h 0.01 segments 6 color red name "vent" }\n}\n${can}`).r, { strict: true });
  assert.equal(tris({ meshes: [mesh(before, 'vent')] }), 24);
  assert.equal(tris({ meshes: [mesh(after, 'vent')] }), 24 - 24 + 6 * 2 + 4 + 4);
  // the silk's pin-1 dot, through pin1_dot
  const soic = 'footprint "S" {\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch 1.27\n  lead gullwing 0.41 x 1.04 span 6\n  pin1 dot\n}';
  const dot = fp(soic).r.silk.filter((i) => i.type === 'circle');
  const tri = fp(`feature pin1_dot(dia = 0.3) {\n  silk { polygon (0, 0) (dia, 0) (0, dia) fill }\n}\n${soic}`).r.silk;
  assert.equal(dot.length, 1);
  assert.equal(tri.filter((i) => i.type === 'circle').length, 0);
  assert.equal(tri.filter((i) => i.type === 'poly').length, 1);
  // a replacement the library can't call gets a warning
  const out = fresh('feature can_vent(D, depth) {\n  model { box D x D x depth }\n}\nfeature body_sawn(W, L, H, flavor) {\n  model { box W x L x H }\n}');
  assert.deepEqual(warnings(out).map((d) => d.message), [
    'the standard library places `can_vent` without a value for `depth`: give it a default',
    '`body_sawn` replaces the standard library\'s, and the 3D model never gives `flavor` a value: give it a default',
  ]);
});

test('body shape and leads shape: your features, with the engine\'s values, your values and flags', () => {
  const src = `
feature pillbox(W, L, H, z0 = 0, height_k = 1) {
  section tall2 { height_k = 2 }
  model { box W x L x height_k * H at (0, 0, z0) color green }
}
feature stub(edge, pad_u, b = 0.3) {
  model { box pad_u - edge x b x 0.1 at ((edge + pad_u) / 2, 0, 0) color gold }
}
footprint "P" {
  body 2 x 2 x 1
  pins 4 dual pitch 1
  lead gullwing 0.3 x 0.5 span 3
  model {
    body shape pillbox(tall2)
    leads shape stub(b = 0.2)
  }
}`;
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

test('a feature in a model block: placed, turned, lifted onto the body', () => {
  const src = `
feature fin(h2 = 1) {
  model { box 0.2 x 1 x h2 }
}
footprint "F" {
  body 2 x 2 x 1
  ${pad}  model {
    feature fin at (0.5, 0) on body
    feature fin(2) at (-0.5, 0, 3) rotate (0, 0, 90)
  }
}`;
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r, { strict: true });
  const [a, b] = m.meshes.filter((x) => x.name === 'fin');
  const bb = (x) => { const q = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let k = 0; k < x.pos.length; k += 3) for (let j = 0; j < 3; j++) { q[j] = Math.min(q[j], x.pos[k + j]); q[j + 3] = Math.max(q[j + 3], x.pos[k + j]); } return q.map((v) => +v.toFixed(6)); };
  assert.deepEqual(bb(a), [0.4, -0.5, 1, 0.6, 0.5, 2]);
  assert.deepEqual(bb(b), [-1, -0.1, 3, 0, 0.1, 5]);
  assert.equal(m.summary.split(' · ').pop(), '2 extra parts');
});

test('a problem inside the library is reported where the footprint uses it', () => {
  const src = 'footprint "S" {\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch 1.27\n  lead gullwing 0.41 x 1.04 span 6\n  model { body shape body_molded(taper = "steep") }\n}';
  const { out, r } = fp(src);
  assert.deepEqual(errors(out), []);
  const m = M.build(r);
  const d = m.diagnostics.find((x) => x.severity === 'error');
  assert.ok(d, 'the model reports it');
  assert.match(d.message, /in the standard library's `body_molded` → `molded_block`/);
  assert.equal(src.slice(d.s, d.e), 'body shape body_molded(taper = "steep")');
  assert.throws(() => M.build(r, { strict: true }), /molded_block/);
});

test('silk: lines marked clear are cut back from the copper; hatch draws chords', () => {
  const src = `
footprint "H" {
  pad 1 rect 1 x 1
  pad 1 at (0, 0)
  silk {
    line (-2, 0) (2, 0) clear
    line (-2, 2) (2, 2)
    hatch (0, 4) d 2 from 0 to 1 pitch 0.25
  }
}`;
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
  const lib = STDLIB.map((f) => (f.file === 'cans.stomp' ? { file: f.file, source: f.source.replace('let lip = min(0.12, 0.02 * (H - z0) + 0.04)', 'let lip = 0.5') } : f));
  const can = 'footprint "C" {\n  refdes "C"\n  body cylinder d 6 h 7\n  pins 2 horizontal pitch 2.5\n  lead wire d 0.5\n}';
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
  const bits = ['{', '}', '(', ')', ',', 'section', 'model', 'feature', 'at', 'x', '=', '-', '*', 'min(', 'rotate', 'along', 'fillet', '1e-', '"', '\n', 'arc', 'segments', 'kind', 'open'];
  const parts = [
    'footprint "S" {\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch 1.27\n  lead gullwing 0.41 x 1.04 span 6\n  pin1 dot\n}',
    'footprint "C" {\n  refdes "C"\n  body cylinder d 6 h 7\n  pins 2 horizontal pitch 2.5\n  lead wire d 0.5\n  polarized\n}',
    'footprint "Q" {\n  body 4 x 4 x 0.9\n  pins 16 quad pitch 0.65\n  lead flat 0.3 x 0.4\n  thermal pad "17" 2 x 2\n}',
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
