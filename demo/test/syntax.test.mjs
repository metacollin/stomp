// The syntax: blocks that close with `end`, names given values with `=`, colons
// for named values, flat features and footprint graphics, and keywords that are
// special only where the grammar expects them. Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, model3d as M } from './engine.mjs';

const errors = (out) => out.diagnostics.filter((d) => d.severity === 'error');
const msgs = (src) => errors(compile(src, { cache: false })).map((d) => `${d.line}: ${d.message}`);
const build = (src, name) => {
  const out = compile(src, { cache: false });
  const f = name ? out.footprints.find((x) => x.name === name) : out.footprints[0];
  return { out, r: f && f.result };
};
const round = (v) => +v.toFixed(6);
const lines = (items) => items.filter((i) => !i.auto && i.type === 'line').map((i) => i.pts.map((q) => q.map(round)));
const pad = 'pad 1 rect 1 x 1\n  pad 1 at (0, 0)';

test('blocks: a header line, its statements, then `end`; `;` puts a short one on one line', () => {
  const a = build(`footprint "A"\n  ${pad}\nend`);
  assert.deepEqual(errors(a.out), []);
  const b = build('footprint "B"; pad 1 rect 1 x 1; pad 1 at (2, 0); end');
  assert.deepEqual(errors(b.out), []);
  assert.deepEqual(b.r.pads.map((p) => [p.x, p.y]), [[2, 0]], 'one pad, where it was placed');
  const c = build(`feature f(n = 1)\n  section wide; n = 2; end\n  line (0, 0) (n, 0)\nend\nfootprint "C"\n  ${pad}\n  feature f(wide) at (0, 3)\nend`);
  assert.deepEqual(errors(c.out), []);
  assert.deepEqual(lines(c.r.silk), [[[0, 3], [2, 3]]]);
});

test('a missing `end` is reported at its block, and the rest of the file still reads', () => {
  assert.deepEqual(msgs(`footprint "A"\n  ${pad}\n`), ['1: missing `end` for this `footprint`']);
  const two = compile(`footprint "A"\n  ${pad}\nfootprint "B"\n  ${pad}\nend`, { cache: false });
  assert.deepEqual(errors(two).map((d) => `${d.line}: ${d.message}`), ['1: missing `end` for this `footprint` before line 4']);
  assert.deepEqual(two.footprints.map((f) => [f.name, !!f.result]), [['A', true], ['B', true]], 'both footprints build');
  // an inner block closed by an `end` that lines up with the outer header: the inner one lacks its own
  assert.deepEqual(msgs(`feature f(n = 1)\n  section s\n    n = 2\n  line (0, 0) (n, 0)\nend\nfootprint "A"\n  ${pad}\n  feature f(s) at (0, 0)\nend`),
    ['2: missing `end` for this `section` (the `end` on line 5 lines up with the `feature` on line 1)']);
  // a feature declaration at the left margin ends an open block; indented, it's a placement without a place
  assert.deepEqual(msgs('feature f\n  line (0, 0) (1, 0)\nfeature g\n  line (0, 0) (2, 0)\nend'), ['1: missing `end` for this `feature` before line 3']);
  assert.deepEqual(msgs('feature f\n  line (0, 0) (1, 0)\nend\nfeature g\n  feature f\nend'), ['5: give `f` a place: `feature f at (0, 0)`']);
  // a footprint statement ends a model block
  assert.deepEqual(msgs(`footprint "A"\n  body 2 x 2 x 1\n  model\n    height: 1\n  ${pad}\nend`), ['3: missing `end` for this `model` before line 5']);
  assert.deepEqual(msgs('end'), ['1: this `end` has no block to close']);
});

test('braces are reported, and a `}` still closes its block', () => {
  const out = compile(`footprint "A" {\n  ${pad}\n}\nfootprint "B"\n  ${pad}\nend`, { cache: false });
  assert.deepEqual(errors(out).map((d) => `${d.line}: ${d.message}`), [
    '1: stomp has no braces: a block starts on the line after its header, and closes with `end`',
    '4: close a block with `end`, not `}`',
  ]);
  assert.deepEqual(out.footprints.map((f) => [f.name, !!f.result]), [['A', true], ['B', true]]);
});

test('names: `NAME = value` gives a name its value, once in a file, footprint or feature', () => {
  const ok = build(`w = 1.2\nfootprint "A"\n  h = w * 2\n  pad 1 rect w x h\n  pad 1 at (0, 0)\nend`);
  assert.deepEqual(errors(ok.out), []);
  assert.deepEqual([ok.r.pads[0].shape.w, ok.r.pads[0].shape.l], [1.2, 2.4]);
  assert.deepEqual(msgs(`w = 1\nw = 2\nfootprint "A"\n  k = 1\n  k = 2\n  ${pad}\nend`), [
    '2: `w` already has a value in this file (a name gets one value)',
    '5: `k` already has a value in this footprint (a name gets one value)',
  ]);
  // a child footprint's value replaces its parent's
  const kid = build('footprint "P"\n  w = 1\n  pad 1 rect w x 1\n  pad 1 at (0, 0)\nend\nfootprint "K" extends "P"\n  w = 2\nend', 'K');
  assert.deepEqual(errors(kid.out), []);
  assert.equal(kid.r.pads[0].shape.w, 2);
  // a feature's own name can't be a parameter's too
  assert.match(msgs(`feature f(n = 1)\n  n = 2\n  line (0, 0) (n, 0)\nend\nfootprint "A"\n  ${pad}\n  feature f at (0, 0)\nend`).join(), /`n` is a parameter of `f`/);
  // `let` is gone; the size separator and the block's end can't be names
  assert.deepEqual(msgs('let w = 1\nfootprint "A"\n  pad 1 rect w x 1\n  pad 1 at (0, 0)\nend'), ['1: there\'s no `let`: write `w = …`']);
  assert.deepEqual(msgs('x = 1'), ['1: `x` separates the sides of a size, so it can\'t be a name']);
  assert.match(msgs('feature f(end = 1)\n  line (0, 0) (1, 0)\nend').join(), /`end` closes a block, so it can't be a name/);
});

test('colons: a named value takes one, a word of the sentence takes none', () => {
  const m = (src) => msgs(src).join(' | ');
  assert.match(m('footprint "A"\n  body 3 x 3\n  pins 8 dual pitch 1.27\nend'), /`pitch` needs a colon: `pitch: 1.27`/);
  assert.match(m('units mil'), /`units` needs a colon: `units: mil`/);
  assert.match(m(`footprint "A"\n  description "x"\n  ${pad}\nend`), /`description` needs a colon: `description: "…"`/);
  assert.match(m('footprint "A"\n  pad 1 rect 1 x 1 mask +0.1\n  pad 1 at (0, 0)\nend'), /`mask` needs a colon: `mask: \+0.1`/);
  assert.match(m('footprint "A"\n  pad 1 rect 1 x 1\n  pad 1 at: (0, 0)\nend'), /`at` takes no colon/);
  assert.match(m('footprint "A"\n  pad 1 rect 1 x 1 rotation: 90\n  pad 1 at (0, 0)\nend'), /`rotation:` isn't an option here/);
  // the space after a colon is optional
  const tight = build('footprint "A"\n  pad 1 rect 1 x 1 rotate:90\n  pad 1 at (0, 0)\nend');
  assert.deepEqual(errors(tight.out), []);
  assert.equal(tight.r.pads[0].rot, 90);
});

test('named arguments take a colon, and a parameter\'s default takes `=`', () => {
  const src = 'template t(n, w = 1)\n  name: "T{n}"\n  pad 1 rect w x 1\n  pad 1 at (0, 0)\nend\nfootprint from t(2, w: 3)';
  const { out, r } = build(src);
  assert.deepEqual(errors(out), []);
  assert.equal(r.pads[0].shape.w, 3);
  assert.match(msgs(src.replace('w: 3', 'w = 3')).join(), /a named value takes a colon: `w: …`/);
  assert.match(msgs(src.replace('w = 1', 'w: 1')).join(), /a parameter's default takes `=`: `w = …`/);
});

test('`from … with` adds statements to a footprint made from a template', () => {
  const t = 'template t(n)\n  name: "T{n}"\n  pad 1 rect 1 x 1\n  pad 1 at (0, 0)\nend\n';
  const { out, r } = build(t + 'footprint from t(2) with\n  description: "two"\nend');
  assert.deepEqual(errors(out), []);
  assert.equal(r.meta.description, 'two');
  assert.match(msgs(t + 'footprint from t(2)\n  description: "two"\n')[0], /to add statements to the `footprint … from …` above, end its line with `with`/);
});

test('keywords mean something only where the grammar expects them, so a name can be any word', () => {
  const src = `draft = 1
below = 2
top = 0.5
feature f(d = 1, h = 2, pitch = 3, span = 4)
  box d x h x pitch
  line (0, 0) (span, top)
end
footprint "A"
  pad 1 rect draft x below
  pad 1 at (0, 0)
  feature f(d: 2, h: 3) at (0, 0)
end`;
  const { out, r } = build(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual([r.pads[0].shape.w, r.pads[0].shape.l], [1, 2]);
  assert.deepEqual(lines(r.silk), [[[0, 0], [4, 0.5]]]);
  // a template parameter, and so a table column, too
  const tb = build('template t(n, pitch)\n  name: "T{n}"\n  pins n dual pitch: pitch\n  default pad rect 0.5 x 1\n  span: 3\nend\nfootprints from t\n  n   pitch\n  8   0.65\nend');
  assert.deepEqual(errors(tb.out), []);
  assert.equal(round(tb.r.pads[0].y - tb.r.pads[1].y), 0.65);
  // objects are the exception: a pad named after a keyword needs quotes
  assert.match(msgs('footprint "A"\n  pad at rect 1 x 1\nend').join(), /`at` is a keyword — quote it to use it as a name: "at"/);
  assert.deepEqual(errors(build('footprint "A"\n  pad "at" rect 1 x 1\n  pad "at" at (0, 0)\nend').out), []);
});

test('features are flat: graphics on the silk unless `layer: assembly`, solids, and the features they place', () => {
  const src = `
feature mark(s = 1)
  line (0, 0) (s, 0)
  circle (0, 0) d: s layer: assembly
  box s x s x 0.1
end
feature pair
  feature mark at (-2, 0)
  feature mark(2) at (2, 0, 1) rotate: 90
end
footprint "A"
  body 2 x 2 x 1
  ${pad}
  feature pair at (10, 0)
end`;
  const { out, r } = build(src);
  assert.deepEqual(errors(out), []);
  assert.deepEqual(lines(r.silk), [[[8, 0], [9, 0]], [[12, 0], [12, 2]]], 'placed, and the second turned a quarter');
  const rings = r.assembly.filter((i) => i.type === 'circle' && !i.auto).map((i) => [round(i.c[0]), round(i.c[1]), i.r]);
  assert.deepEqual(rings, [[8, 0, 0.5], [12, 0, 1]], 'on the assembly layer');
  // the same placement puts the solids in the 3D model, the second one 1 up
  const m = M.build(r, { strict: true });
  const z = m.meshes.filter((x) => x.name === 'pair').map((x) => {
    let lo = Infinity, hi = -Infinity;
    for (let k = 2; k < x.pos.length; k += 3) { lo = Math.min(lo, x.pos[k]); hi = Math.max(hi, x.pos[k]); }
    return [round(lo), round(hi)];
  });
  assert.deepEqual(z, [[0, 0.1], [1, 1.1]]);
  assert.equal(m.summary.split(' · ').pop(), '1 extra part');
});

test('footprint graphics go on the silk unless `layer: assembly`; pad properties go on the pad\'s line', () => {
  const { out, r } = build(`footprint "A"
  pad 1 rect 1 x 1
  pad 2 rect 1 x 1
  pad 1 at (0, 0)
  pad 2 is 2 right of pad 1
  pad 2 size: 1.2 x 1.5 rotate: 90
  pads 1..2 mask: +0.1
  line (0, 2) (2, 2) width: 0.2
  circle (1, -2) d: 0.5 fill layer: assembly
  text "hi" at (1, 3) size: 0.8
end`);
  assert.deepEqual(errors(out), []);
  const p2 = r.pads.find((p) => p.name === '2');
  assert.deepEqual([p2.shape.w, p2.shape.l, p2.rot], [1.2, 1.5, 90]);
  assert.ok(r.pads.every((p) => p.spec.mask && p.spec.mask.mode === 'expand' && round(p.spec.mask.v) === 0.1), 'both pads take the mask margin');
  const line = r.silk.find((i) => !i.auto && i.type === 'line');
  assert.equal(line.w, 0.2);
  assert.ok(r.assembly.some((i) => i.type === 'circle' && i.fill), 'the dot is on the assembly layer');
  assert.ok(r.silk.some((i) => i.type === 'text' && i.str === 'hi'), 'text goes on the silk');
  // a filled shape has no line width
  assert.match(msgs(`footprint "A"\n  ${pad}\n  rect (0, 0) 2 x 2 fill width: 0.1\nend`).join(), /a filled shape has no line width/);
});
