// KiCad export tests. Run: node --test demo/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { compile, model3d as M, kicad as K } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

const example = (f) => readFileSync(join(repo, 'examples', f), 'utf8');
const results = (src) => compile(src).footprints.filter((f) => f.result);
const exportOf = (src, name) => {
  const f = name ? results(src).find((x) => x.name === name) : results(src)[0];
  assert.ok(f, `footprint ${name || '(first)'} should build`);
  return { r: f.result, out: K.footprint(f.result, { name: f.name, model: M.build(f.result) }) };
};

// A small S-expression reader
// Reads like KiCad's lexer: lists, bare symbols, "quoted strings" with \ escapes,
// and the |...| runs inside (data ...), each read as one base64 string.
function parse(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  function node() {
    ws();
    if (text[i] === '(') {
      i++;
      const list = [];
      for (;;) {
        ws();
        if (i >= text.length) throw new Error('unbalanced: missing )');
        if (text[i] === ')') { i++; return list; }
        if (text[i] === '|') {
          const j = text.indexOf('|', i + 1);
          if (j < 0) throw new Error('unterminated |');
          list.push({ bar: text.slice(i + 1, j).replace(/\s+/g, '') });
          i = j + 1;
          continue;
        }
        list.push(node());
      }
    }
    if (text[i] === '"') {
      let s = '';
      i++;
      while (text[i] !== '"') {
        if (i >= text.length) throw new Error('unterminated string');
        if (text[i] === '\\') { i++; s += text[i] === 'n' ? '\n' : text[i]; i++; } else s += text[i++];
      }
      i++;
      return { q: s };
    }
    const m = /^[^\s()"|]+/.exec(text.slice(i));
    if (!m) throw new Error(`unexpected ${JSON.stringify(text[i])} at ${i}`);
    i += m[0].length;
    return /^-?\d+(\.\d+)?$/.test(m[0]) ? Number(m[0]) : m[0];
  }
  const root = node();
  ws();
  assert.equal(i, text.length, 'nothing after the footprint');
  return root;
}
const kids = (n, head) => n.filter((c) => Array.isArray(c) && c[0] === head);
const kid = (n, head) => kids(n, head)[0];
const str = (a) => (a && a.q != null ? a.q : a);

// every bare word the exporter writes, each checked against KiCad 9's pcb.keywords
// and embedded_files.keywords. Check any new word the same way.
const KNOWN = new Set(('anchor at attr center checksum circle clearance custom data descr drill effects embedded_files embedded_fonts ' +
  'end file fill font footprint fp_circle fp_line fp_poly fp_rect fp_text generator generator_version gr_poly hide layer layers model ' +
  'name no np_thru_hole offset options outline oval pad pad_prop_bga pad_prop_castellated pad_prop_heatsink primitives ' +
  'property pts rect remove_unused_layers rotate roundrect roundrect_rratio scale size smd solder_mask_margin solder_paste_margin ' +
  'solid start stroke tags thickness through_hole thru_hole type unlocked user uuid version width xy xyz yes').split(' '));
function bareWords(n, out) {
  for (const c of n) {
    if (Array.isArray(c)) bareWords(c, out);
    else if (typeof c === 'string') out.add(c);
  }
  return out;
}

/** Decode an embedded file the way KiCad does: base64, then zstd, then the checksum. */
function decodeEmbedded(file) {
  const data = kid(file, 'data');
  const b64 = data.find((c) => c && c.bar != null).bar;
  const frame = Buffer.from(b64, 'base64');
  assert.equal(frame.readUInt32LE(0), 0xFD2FB528, 'a zstd frame');
  const fhd = frame[4];
  assert.ok((fhd >> 6) !== 0 || (fhd & 0x20), 'the frame declares its size (ZSTD_getFrameContentSize)');
  const plain = zlib.zstdDecompressSync ? zlib.zstdDecompressSync(frame) : null;
  return { frame, plain };
}

// Checksum, zstd, base64
test('checksum: MurmurHash3 core and KiCad\'s padded tail', () => {
  // SMHasher's verification value for MurmurHash3_x64_128
  const key = new Uint8Array(256), hashes = new Uint8Array(16 * 256);
  for (let i = 0; i < 256; i++) { key[i] = i; hashes.set(K.murmur3x64(key.subarray(0, i), 256 - i), i * 16); }
  const fin = K.murmur3x64(hashes, 0);
  assert.equal((fin[0] | (fin[1] << 8) | (fin[2] << 16) | (fin[3] << 24)) >>> 0, 0x6384BA69);
  // KiCad's MMH3_HASH, seed 0xABBA2345. These values were checked against 45 embedded
  // files written by KiCad 9 (its vme-wren demo library), covering every tail length.
  const vectors = ['0A8AD5D826E19AE9B0771881583631B3', '647E43A2CB448B8785C80B7E9789D0A8', '17537A7D63E6D139D08DA7E9FD174131',
    '779A2E17413DCE4CC8B4532923E2FE69', '0CFD442EE782ED4AA873ADA74759A4F7', 'BAE1BA5AE62CEFD9D1E4ECC0C592FF19',
    '2A85703D994B10933F2C2F0BDB573659', 'C0ED0A81919637552F654518D8C3D334', '1F07F8E909D3691F13B566A5F2517868',
    '457BE7309DE4099323E860D0CD634150', 'A0752CB6C23BDD08203E7F7BEE32A6B9', 'C466542B2070F0C9144F039D23D4FC2D',
    '0FC02384A29118F69FFB8F37551022E3', '0FC02384A29118F69FFB8F37551022E3', '0FC02384A29118F69FFB8F37551022E3',
    '0FC02384A29118F69FFB8F37551022E3', 'AD4B4231B04A481B60FECAAD2430E23F', '67DFC5FEC6F8B1A88BA3A2115CC49047'];
  vectors.forEach((want, n) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 7 + 3) & 255;
    assert.equal(K.checksum(a), want, `length ${n}`);
  });
  // KiCad pads a 12-15 byte tail to 16 bytes and doesn't mix it in. We match that.
  assert.equal(K.checksum(new TextEncoder().encode('Hello, World!')), vectors[12]);
});

test('zstd frames round-trip and base64 matches Node', () => {
  for (const n of [0, 1, 100, 131072, 131073, 300001]) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 255;
    const f = K.zstdFrame(a);
    assert.equal(new DataView(f.buffer).getBigUint64(5, true), BigInt(n), 'content size in the header');
    if (zlib.zstdDecompressSync) assert.equal(Buffer.compare(zlib.zstdDecompressSync(Buffer.from(f)), Buffer.from(a)), 0, `${n} bytes round-trip`);
    assert.equal(K.base64(f), Buffer.from(f).toString('base64'));
  }
});

// Footprints
test('every example exports a well-formed KiCad 9 footprint', () => {
  for (const f of readdirSync(join(repo, 'examples')).filter((x) => x.endsWith('.stomp'))) {
    for (const fp of results(example(f))) {
      const out = K.footprint(fp.result, { name: fp.name, model: M.build(fp.result) });
      const t = parse(out.text);
      assert.equal(t[0], 'footprint');
      assert.equal(str(t[1]), out.name);
      assert.equal(kid(t, 'version')[1], 20241229);
      assert.equal(str(kid(t, 'layer')[1]), 'F.Cu');
      assert.deepEqual(kids(t, 'property').slice(0, 2).map((p) => str(p[1])), ['Reference', 'Value']);
      const unknown = [...bareWords(t, new Set())].filter((w) => !KNOWN.has(w));
      assert.deepEqual(unknown, [], `${fp.name}: words KiCad wouldn't know`);
      const ids = [];
      JSON.stringify(t, (k, v) => { if (Array.isArray(v) && v[0] === 'uuid') ids.push(str(v[1])); return v; });
      assert.equal(new Set(ids).size, ids.length, `${fp.name}: uuids are unique`);
      // embedded model: decodes as KiCad would, and the model points at it
      const files = kids(kid(t, 'embedded_files') || [], 'file');
      const models = kids(t, 'model');
      if (fp.result.model.step) {
        assert.equal(files.length, 0);
        assert.equal(str(models[0][1]), fp.result.model.step.file);
        continue;
      }
      for (const file of files) {
        const { plain } = decodeEmbedded(file);
        if (plain) {
          assert.equal(K.checksum(new Uint8Array(plain)), str(kid(file, 'checksum')[1]), `${fp.name}: checksum`);
          const wrl = plain.toString('utf8');
          assert.ok(wrl.startsWith('#VRML V2.0 utf8'));
          const defs = new Set();
          for (const m of wrl.matchAll(/\b(DEF|USE) (\w+)/g)) {
            if (m[1] === 'DEF') defs.add(m[2]);
            else assert.ok(defs.has(m[2]), `${fp.name}: USE ${m[2]} follows its DEF`);
          }
        }
        assert.equal(str(models[0][1]), `kicad-embed://${str(kid(file, 'name')[1])}`);
      }
      if (fp.result.body && !fp.result.model.none) assert.equal(files.length, 1, `${fp.name} embeds its model`);
    }
  }
});

test('SOIC-8: y flipped, quarter-turned pads written unrotated, attributes', () => {
  const { out } = exportOf(example('soic8.stomp'));
  const t = parse(out.text);
  assert.deepEqual(kid(t, 'attr'), ['attr', 'smd']);
  const pads = kids(t, 'pad');
  assert.equal(pads.length, 8);
  const p1 = pads.find((p) => str(p[1]) === '1');
  assert.deepEqual(p1.slice(2, 4), ['smd', 'roundrect']);
  assert.deepEqual(kid(p1, 'at'), ['at', -2.48, -1.905], 'pin 1 top left: y down in KiCad');
  assert.deepEqual(kid(p1, 'size'), ['size', 1.8, 0.53], 'long side along x, no rotation');
  assert.deepEqual(kid(p1, 'layers').slice(1).map(str), ['F.Cu', 'F.Mask', 'F.Paste']);
  assert.equal(kid(p1, 'roundrect_rratio')[1], 0.25);
  const texts = kids(t, 'fp_text').map((x) => str(x[2]));
  assert.ok(texts.includes('${REFERENCE}'), 'the fab label is KiCad\'s ${REFERENCE}');
  assert.equal(kids(t, 'fp_rect').filter((p) => str(kid(p, 'layer')[1]) === 'F.CrtYd').length, 1, 'the courtyard is one fp_rect');
  assert.ok(!kids(t, 'fp_poly').some((p) => str(kid(p, 'layer')[1]) === 'F.CrtYd'), 'and nothing else on F.CrtYd');
  assert.equal(K.footprint(exportOf(example('soic8.stomp')).r, { model: null }).text.includes('embedded_files'), false, 'no model, nothing embedded');
});

test('through-hole, holes, slots, custom pads and pad properties', () => {
  const dip = parse(exportOf(example('dip8.stomp')).out.text);
  assert.deepEqual(kid(dip, 'attr'), ['attr', 'through_hole']);
  const d1 = kids(dip, 'pad').find((p) => str(p[1]) === '1');
  assert.deepEqual(d1.slice(2, 4), ['thru_hole', 'rect']);
  assert.ok(kid(d1, 'drill'), 'drilled');
  assert.deepEqual(kid(d1, 'layers').slice(1).map(str), ['*.Cu', '*.Mask']);
  const usb = parse(exportOf(example('usb_microb.stomp')).out.text);
  const pads = kids(usb, 'pad');
  assert.ok(pads.some((p) => p[2] === 'np_thru_hole'), 'NPTH pegs');
  assert.ok(pads.some((p) => { const d = kid(p, 'drill'); return d && d[1] === 'oval'; }), 'slotted drills');
  assert.ok(pads.some((p) => p[3] === 'custom' && kid(kid(p, 'primitives'), 'gr_poly')), 'a polygon pad becomes a custom pad');
  const zoo = example('syntax_zoo.stomp');
  const cast = parse(exportOf(zoo, 'ZOO-CASTELLATED').out.text);
  assert.ok(kids(cast, 'pad').every((p) => kid(p, 'property')[1] === 'pad_prop_castellated'));
  const bga = parse(exportOf(example('bga64.stomp')).out.text);
  assert.ok(kids(bga, 'pad').every((p) => kid(p, 'property')[1] === 'pad_prop_bga'));
});

test('QFN-32: exposed pad with paste windows and tented via pads', () => {
  const t = parse(exportOf(example('qfn32.stomp')).out.text);
  const pads = kids(t, 'pad');
  const ep = pads.find((p) => str(p[1]) === '33' && p[2] === 'smd');
  assert.equal(kid(ep, 'property')[1], 'pad_prop_heatsink');
  assert.deepEqual(kid(ep, 'layers').slice(1).map(str), ['F.Cu', 'F.Mask'], 'paste goes in windows instead');
  const windows = pads.filter((p) => str(p[1]) === '' && str(kid(p, 'layers')[1]) === 'F.Paste');
  assert.equal(windows.length, 4);
  const area = windows.reduce((s, w) => s + kid(w, 'size')[1] * kid(w, 'size')[2], 0);
  assert.ok(Math.abs(area / (3.7 * 3.7) - 0.68) < 1e-3, 'windows cover 68%');
  const vias = pads.filter((p) => str(p[1]) === '33' && p[2] === 'thru_hole');
  assert.equal(vias.length, 9);
  assert.deepEqual(kid(vias[0], 'layers').slice(1).map(str), ['*.Cu']);
});

test('mask and paste overrides become pad margins', () => {
  const src = `footprint "M"
  pad 1 rect 1 x 2 mask: +0.1
  pad 2 rect 1 x 2 mask: none
  pad 3 rect 1 x 2 paste: -0.05
  pad 4 rect 1 x 2 mask: defined
  pad 1 at (-1, 0)
  pad 2 at (1, 0)
  pad 3 at (3, 0)
  pad 4 at (5, 0)
end
`;
  assert.deepEqual(compile(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), []);
  const pads = kids(parse(exportOf(src).out.text), 'pad');
  const p = (n) => pads.find((x) => str(x[1]) === n);
  assert.equal(kid(p('1'), 'solder_mask_margin')[1], 0.1);
  assert.deepEqual(kid(p('2'), 'layers').slice(1).map(str), ['F.Cu', 'F.Paste']);
  assert.equal(kid(p('3'), 'solder_paste_margin')[1], -0.05);
  assert.equal(kid(p('4'), 'solder_mask_margin')[1], -0.05);
  assert.deepEqual(kid(p('4'), 'size'), ['size', 1.1, 2.1], 'mask-defined: the copper is larger than the opening');
});

test('library: one file per footprint, README, skipped footprints, stable output', () => {
  const out = compile(example('qfn_library.stomp'));
  const fps = out.footprints.map((f) => ({ name: f.name, result: f.result, model: f.result ? M.build(f.result) : null }));
  fps[1].skip = 'it has errors';
  const L = K.library(fps, { lib: 'qfn_library', source: 'examples/qfn_library.stomp' });
  assert.equal(L.count, out.footprints.length - 1);
  assert.equal(L.models, L.count);
  assert.deepEqual(L.skipped.map((s) => s.name), [out.footprints[1].name]);
  const names = L.files.map((f) => f.name);
  assert.ok(names.every((n) => n === 'README.txt' || (n.startsWith('qfn_library.pretty/') && n.endsWith('.kicad_mod'))));
  const readme = new TextDecoder().decode(L.files.find((f) => f.name === 'README.txt').data);
  assert.match(readme, /KiCad 9/);
  assert.match(readme, /Not exported:/);
  const again = K.library(fps, { lib: 'qfn_library' });
  assert.equal(new TextDecoder().decode(again.files[0].data), new TextDecoder().decode(L.files[0].data), 'exporting twice gives the same file');
  // names that collide on a case-insensitive file system get a suffix
  const twin = K.library([{ name: 'A', result: fps[0].result }, { name: 'a', result: fps[0].result }], { lib: 'x' });
  assert.deepEqual(twin.files.map((f) => f.name).slice(0, 2), ['x.pretty/A.kicad_mod', 'x.pretty/a_2.kicad_mod']);
});
