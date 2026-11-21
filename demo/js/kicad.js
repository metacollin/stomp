/* stomp live demo: KiCad export.
 *
 * footprint(res, opts) writes a KiCad 9 footprint (.kicad_mod) with its 3D model
 * embedded. library(fps, opts) writes a whole .pretty folder as zip entries.
 *
 * Embedded files work as in KiCad 9 (file version 20241229): the bytes go in a
 * zstd frame, base64-encoded in 76-character lines between "|" marks, with
 * KiCad's MurmurHash3 checksum (seed 0xABBA2345). The model is referenced as
 * kicad-embed://NAME.
 *
 * stomp's y axis points up and KiCad's points down, so y is negated. Angles look
 * the same on screen. 3D models point y up in both.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geom.js'), require('./model3d.js'));
  else (root.Stomp = root.Stomp || {}).kicad = factory(root.Stomp.geom, root.Stomp.model3d);
})(typeof self !== 'undefined' ? self : this, function (G, M3) {
  'use strict';

  // Checksum
  // KiCad's MMH3_HASH (libs/kimath/include/mmh3_hash.h): MurmurHash3_x64_128, except
  // that the tail is zero-padded to a multiple of 4 and the padding counts in the
  // length (a tail of 12-15 bytes pads to 16 and isn't mixed in at all).
  const MASK = (1n << 64n) - 1n;
  const C1 = 0x87c37b91114253d5n, C2 = 0x4cf5ad432745937fn;
  const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK;
  const fmix = (k) => {
    k ^= k >> 33n; k = (k * 0xff51afd7ed558ccdn) & MASK;
    k ^= k >> 33n; k = (k * 0xc4ceb9fe1a85ec53n) & MASK;
    return k ^ (k >> 33n);
  };
  const SEED = 0xABBA2345;

  /** KiCad's embedded-file checksum of `bytes`: 32 uppercase hex digits. */
  function checksum(bytes, seed) {
    let h1 = BigInt((seed == null ? SEED : seed) >>> 0), h2 = h1;
    let len = 0;
    const n = bytes.length;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    for (; n - i >= 16; i += 16) {
      let k1 = dv.getBigUint64(i, true), k2 = dv.getBigUint64(i + 8, true);
      k1 = (k1 * C1) & MASK; k1 = rotl(k1, 31); k1 = (k1 * C2) & MASK; h1 ^= k1;
      h1 = rotl(h1, 27); h1 = (h1 + h2) & MASK; h1 = (h1 * 5n + 0x52dce729n) & MASK;
      k2 = (k2 * C2) & MASK; k2 = rotl(k2, 33); k2 = (k2 * C1) & MASK; h2 ^= k2;
      h2 = rotl(h2, 31); h2 = (h2 + h1) & MASK; h2 = (h2 * 5n + 0x38495ab5n) & MASK;
      len = (len + 16) >>> 0;
    }
    const tail = new Uint8Array(16);
    const rem = n - i;
    if (rem > 0) {
      tail.set(bytes.subarray(i, n));
      len = (len + rem + (4 - ((rem + 4) % 4))) >>> 0;
    }
    const t = len & 15;
    if (t > 8) {
      let k2 = 0n;
      for (let j = t - 1; j >= 8; j--) k2 ^= BigInt(tail[j]) << BigInt((j - 8) * 8);
      k2 = (k2 * C2) & MASK; k2 = rotl(k2, 33); k2 = (k2 * C1) & MASK; h2 ^= k2;
    }
    if (t > 0) {
      let k1 = 0n;
      for (let j = Math.min(t, 8) - 1; j >= 0; j--) k1 ^= BigInt(tail[j]) << BigInt(j * 8);
      k1 = (k1 * C1) & MASK; k1 = rotl(k1, 31); k1 = (k1 * C2) & MASK; h1 ^= k1;
    }
    h1 ^= BigInt(len); h2 ^= BigInt(len);
    h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
    h1 = fmix(h1); h2 = fmix(h2);
    h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
    const hex = (h) => h.toString(16).toUpperCase().padStart(16, '0');
    return hex(h1) + hex(h2);
  }

  /** Plain MurmurHash3_x64_128 (for checking the core against its published test value). */
  function murmur3x64(bytes, seed) {
    let h1 = BigInt(seed >>> 0), h2 = h1;
    const n = bytes.length;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    for (; n - i >= 16; i += 16) {
      let k1 = dv.getBigUint64(i, true), k2 = dv.getBigUint64(i + 8, true);
      k1 = (k1 * C1) & MASK; k1 = rotl(k1, 31); k1 = (k1 * C2) & MASK; h1 ^= k1;
      h1 = rotl(h1, 27); h1 = (h1 + h2) & MASK; h1 = (h1 * 5n + 0x52dce729n) & MASK;
      k2 = (k2 * C2) & MASK; k2 = rotl(k2, 33); k2 = (k2 * C1) & MASK; h2 ^= k2;
      h2 = rotl(h2, 31); h2 = (h2 + h1) & MASK; h2 = (h2 * 5n + 0x38495ab5n) & MASK;
    }
    const t = n - i;
    if (t > 8) {
      let k2 = 0n;
      for (let j = t - 1; j >= 8; j--) k2 ^= BigInt(bytes[i + j]) << BigInt((j - 8) * 8);
      k2 = (k2 * C2) & MASK; k2 = rotl(k2, 33); k2 = (k2 * C1) & MASK; h2 ^= k2;
    }
    if (t > 0) {
      let k1 = 0n;
      for (let j = Math.min(t, 8) - 1; j >= 0; j--) k1 ^= BigInt(bytes[i + j]) << BigInt(j * 8);
      k1 = (k1 * C1) & MASK; k1 = rotl(k1, 31); k1 = (k1 * C2) & MASK; h1 ^= k1;
    }
    h1 ^= BigInt(n); h2 ^= BigInt(n);
    h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
    h1 = fmix(h1); h2 = fmix(h2);
    h1 = (h1 + h2) & MASK; h2 = (h2 + h1) & MASK;
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setBigUint64(0, h1, true); ov.setBigUint64(8, h2, true);
    return out;
  }

  // zstd and base64
  /**
   * A zstd frame of raw (stored) blocks. KiCad needs the frame to declare its content
   * size (ZSTD_getFrameContentSize), so the header is single-segment with an 8-byte
   * size; blocks are at most 128 KiB. No checksum.
   */
  function zstdFrame(bytes) {
    const n = bytes.length;
    const BLOCK = 128 * 1024;
    const nBlocks = Math.max(1, Math.ceil(n / BLOCK));
    const out = new Uint8Array(4 + 1 + 8 + nBlocks * 3 + n);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0xFD2FB528, true);          // magic
    out[4] = 0b11100000;                          // FCS 8 bytes, single segment, no checksum, no dictionary
    dv.setBigUint64(5, BigInt(n), true);
    let o = 13;
    for (let b = 0; b < nBlocks; b++) {
      const s = b * BLOCK, size = Math.min(BLOCK, n - s);
      const last = b === nBlocks - 1 ? 1 : 0;
      const h = last | (0 << 1) | (size << 3);     // Raw_Block
      out[o] = h & 255; out[o + 1] = (h >> 8) & 255; out[o + 2] = (h >> 16) & 255;
      o += 3;
      out.set(bytes.subarray(s, s + size), o);
      o += size;
    }
    return out;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    let s = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    const r = bytes.length - i;
    if (r === 1) { const v = bytes[i] << 16; s += B64[v >> 18] + B64[(v >> 12) & 63] + '=='; }
    else if (r === 2) { const v = (bytes[i] << 16) | (bytes[i + 1] << 8); s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='; }
    return s;
  }

  const utf8 = (s) => new TextEncoder().encode(s);

  // S-expressions
  // A node is [head, ...children]. A child is a node, a number, a bare symbol (a
  // JS string) or a quoted string ({ q }). KiCad's layout: atoms stay on the
  // head's line, and each child list goes on its own line, one tab deeper.
  const Q = (s) => ({ q: s == null ? '' : String(s) });
  const quote = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const num = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) || r === 0 ? '0' : String(r); };
  const atom = (a) => (typeof a === 'number' ? num(a) : typeof a === 'string' ? a : quote(a.q));
  function print(node, depth) {
    const pad = '\t'.repeat(depth);
    if (node.data != null) {
      // (data |...|): 76-character lines; the first starts after "|", the last ends with "|"
      const d = node.data, lines = [];
      for (let i = 0; i < d.length; i += 76) lines.push(d.slice(i, i + 76));
      if (!lines.length) lines.push('');
      lines[0] = '|' + lines[0];
      lines[lines.length - 1] += '|';
      return `${pad}(data ${lines[0]}${lines.slice(1).map((l) => `\n${pad}\t${l}`).join('')}\n${pad})`;
    }
    const [head, ...rest] = node;
    const atoms = rest.filter((c) => !Array.isArray(c) && !(c && c.data != null));
    const lists = rest.filter((c) => Array.isArray(c) || (c && c.data != null));
    let s = `${pad}(${[head, ...atoms.map(atom)].join(' ')}`;
    if (!lists.length) return s + ')';
    if (head === 'pts') {
      // points, several to a line
      const xy = lists.map((c) => `(${c[0]} ${c.slice(1).map(atom).join(' ')})`);
      const rows = [];
      for (let i = 0; i < xy.length; i += 6) rows.push(`${pad}\t${xy.slice(i, i + 6).join(' ')}`);
      return `${s}\n${rows.join('\n')}\n${pad})`;
    }
    for (const c of lists) s += '\n' + print(c, depth + 1);
    return `${s}\n${pad})`;
  }

  // Footprints
  const KICAD_VERSION = 20241229;      // pcbnew file format of KiCad 9.0
  const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/g;
  const safeName = (n) => String(n).replace(BAD_NAME, '_').trim() || 'footprint';
  const LAYER = { silk: 'F.SilkS', assembly: 'F.Fab', courtyard: 'F.CrtYd', copper: 'F.Cu', mask: 'F.Mask' };
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  /** Deterministic UUIDs, so exporting twice gives the same files. (Plain MurmurHash3:
   *  KiCad's variant ignores some tails, and `name#k` would land on one.) */
  function uuids(seed) {
    let k = 0;
    return () => {
      const h = Array.from(murmur3x64(utf8(`${seed}#${k++}`), 0x5704), (b) => b.toString(16).padStart(2, '0')).join('');
      const v = h.slice(0, 12) + '4' + h.slice(13, 16) + ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 32);
      return Q(`${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`);
    };
  }

  const stroke = (w) => ['stroke', ['width', w], ['type', 'solid']];
  const font = (size) => ['effects', ['font', ['size', size, size], ['thickness', Math.max(0.05, Math.round(size * 0.15 * 1000) / 1000)]]];
  const XY = (p) => [p[0], -p[1]];

  /** Graphic items of one stomp layer as fp_* nodes. */
  function graphics(items, layer, uid, out, texts) {
    for (const it of items || []) {
      if (it.type === 'line' && it.pts && it.pts.length >= 2) {
        const pts = it.pts;
        const closed = pts.length >= 4 && near(pts[0][0], pts[pts.length - 1][0]) && near(pts[0][1], pts[pts.length - 1][1]);
        if (closed) {
          out.push(['fp_poly', ['pts', ...pts.slice(0, -1).map((p) => ['xy', ...XY(p)])], stroke(it.w || 0.1), ['fill', 'no'], ['layer', Q(layer)], ['uuid', uid()]]);
        } else {
          for (let i = 0; i + 1 < pts.length; i++) {
            if (near(pts[i][0], pts[i + 1][0]) && near(pts[i][1], pts[i + 1][1])) continue;
            out.push(['fp_line', ['start', ...XY(pts[i])], ['end', ...XY(pts[i + 1])], stroke(it.w || 0.1), ['layer', Q(layer)], ['uuid', uid()]]);
          }
        }
      } else if (it.type === 'circle') {
        out.push(['fp_circle', ['center', ...XY(it.c)], ['end', ...XY([it.c[0] + it.r, it.c[1]])], stroke(it.fill ? 0 : (it.w || 0.1)), ['fill', it.fill ? 'yes' : 'no'], ['layer', Q(layer)], ['uuid', uid()]]);
      } else if (it.type === 'poly' && it.pts && it.pts.length >= 3) {
        out.push(['fp_poly', ['pts', ...it.pts.map((p) => ['xy', ...XY(p)])], stroke(0), ['fill', 'yes'], ['layer', Q(layer)], ['uuid', uid()]]);
      } else if (it.type === 'text') {
        texts.push({ it, layer });
      }
    }
  }

  /** The pad's KiCad shape: { kind, w, h, rratio, poly (pad-local, KiCad axes) }. */
  function padShape(sh) {
    switch (sh.kind) {
      case 'rect': return { kind: 'rect', w: sh.w, h: sh.l };
      case 'roundrect': {
        const m = Math.min(sh.w, sh.l);
        const r = Math.min(sh.r || 0, m / 2);
        return r > 1e-9 ? { kind: 'roundrect', w: sh.w, h: sh.l, rratio: Math.min(0.5, r / m) } : { kind: 'rect', w: sh.w, h: sh.l };
      }
      case 'circle': return { kind: 'circle', w: sh.d, h: sh.d };
      case 'oval': return near(sh.w, sh.l) ? { kind: 'circle', w: sh.w, h: sh.w } : { kind: 'oval', w: sh.w, h: sh.l };
      default: {
        const poly = G.dedupe(G.contourToPoly(G.shapeContour(sh, 0), G.deg(10)), true).map(XY);
        const bb = G.contourBBox(G.shapeContour(sh, 0));
        return { kind: 'custom', poly, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0 };
      }
    }
  }

  /** One stomp pad as KiCad pads: the pad, plus paste-only windows and via pads. */
  function pads(p, ctx, uid) {
    const out = [];
    const s = p.spec || {};
    const shape = padShape(p.shape);
    let rot = ((p.rot % 360) + 360) % 360;
    let { w, h } = shape;
    let drill = s.drill || p.drill || null;
    if (drill && drill.slot) drill = { slot: { w: drill.slot.w, l: drill.slot.l } };
    // a symmetric pad turned by a quarter is the same pad with its sides swapped
    const quarter = Math.abs(rot / 90 - Math.round(rot / 90)) < 1e-9;
    if (shape.kind !== 'custom' && quarter) {
      if (Math.round(rot / 90) % 2 === 1) {
        [w, h] = [h, w];
        if (drill && drill.slot) drill = { slot: { w: drill.slot.l, l: drill.slot.w } };
      }
      rot = 0;
    }
    const maskMode = s.mask ? s.mask.mode : 'default';
    if (maskMode === 'defined') { w += 2 * ctx.maskOverlap; h += 2 * ctx.maskOverlap; }
    const pasteMode = s.paste ? s.paste.mode : (p.tht ? 'none' : 'default');
    const at = ['at', p.x, -p.y];
    if (rot) at.push(rot);
    const node = ['pad', Q(p.name), p.tht ? 'thru_hole' : 'smd', shape.kind, at, ['size', w, h]];
    if (p.tht && drill) node.push(drill.slot ? ['drill', 'oval', drill.slot.w, drill.slot.l] : ['drill', drill.d]);
    if (s.castellated != null) node.push(['property', 'pad_prop_castellated']);
    else if (ctx.balls && !p.thermal) node.push(['property', 'pad_prop_bga']);
    else if (p.thermal) node.push(['property', 'pad_prop_heatsink']);
    const layers = p.tht ? ['*.Cu'] : ['F.Cu'];
    if (maskMode !== 'none') layers.push(p.tht ? '*.Mask' : 'F.Mask');
    if (!p.tht && (pasteMode === 'default' || pasteMode === 'expand')) layers.push('F.Paste');
    node.push(['layers', ...layers.map(Q)]);
    if (p.tht) node.push(['remove_unused_layers', 'no']);
    if (shape.kind === 'roundrect') node.push(['roundrect_rratio', Math.round(shape.rratio * 1e4) / 1e4]);
    if (maskMode === 'expand') node.push(['solder_mask_margin', s.mask.v]);
    if (maskMode === 'defined') node.push(['solder_mask_margin', -ctx.maskOverlap]);
    if (pasteMode === 'expand') node.push(['solder_paste_margin', s.paste.v]);
    if (shape.kind === 'custom') {
      const inside = G.pointInPoly([0, 0], shape.poly);
      node[5] = ['size', inside ? Math.min(0.1, w / 4, h / 4) : 0.01, inside ? Math.min(0.1, w / 4, h / 4) : 0.01];
      node.push(['options', ['clearance', 'outline'], ['anchor', 'rect']]);
      node.push(['primitives', ['gr_poly', ['pts', ...shape.poly.map((q) => ['xy', q[0], q[1]])], ['width', 0], ['fill', 'yes']]]);
    }
    node.push(['uuid', uid()]);
    out.push(node);
    // divided paste: one paste-only pad per window
    if (pasteMode === 'divide') {
      for (const win of p.paste || []) {
        const c = G.contourToPoly(win, G.deg(30));
        if (c.length < 4) continue;
        const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
        let ww = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), wh = Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]);
        let a = ((Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI + 360) % 360;
        if (Math.abs(a / 90 - Math.round(a / 90)) < 1e-6) { if (Math.round(a / 90) % 2 === 1) [ww, wh] = [wh, ww]; a = 0; }
        const wat = ['at', cx, -cy];
        if (a) wat.push(Math.round(a * 1e4) / 1e4);
        out.push(['pad', Q(''), 'smd', 'rect', wat, ['size', ww, wh], ['layers', Q('F.Paste')], ['uuid', uid()]]);
      }
    }
    // thermal vias: plated holes with the pad's number, tented
    for (const v of p.vias || []) {
      out.push(['pad', Q(p.name), 'thru_hole', 'circle', ['at', v.x, -v.y], ['size', v.d + 0.2, v.d + 0.2], ['drill', v.d], ['layers', Q('*.Cu')], ['remove_unused_layers', 'no'], ['uuid', uid()]]);
    }
    return out;
  }

  /**
   * One footprint as a KiCad 9 .kicad_mod.
   *   opts.model: the built 3D model (Stomp.model3d.build) to embed, or null
   *   opts.name:  the footprint name to write (defaults to res.name)
   * Returns { name, file, text, embedded: bytes of the embedded model or 0, notes }.
   */
  function footprint(res, opts) {
    opts = opts || {};
    const name = safeName(opts.name || res.name || 'footprint');
    const uid = uuids(name);
    const meta = res.meta || {};
    const notes = [];
    const fp = ['footprint', Q(name), ['version', KICAD_VERSION], ['generator', Q('stomp')], ['generator_version', Q('0.1')], ['layer', Q('F.Cu')]];
    if (meta.description) fp.push(['descr', Q(meta.description)]);
    const tags = Array.isArray(meta.tags) ? meta.tags.join(' ') : meta.tags;
    if (tags) fp.push(['tags', Q(tags)]);
    // graphics first, so ref/value text placements are known
    const gfx = [], texts = [];
    graphics(res.silk, LAYER.silk, uid, gfx, texts);
    graphics(res.assembly, LAYER.assembly, uid, gfx, texts);
    graphics(res.courtyard, LAYER.courtyard, uid, gfx, texts);
    for (const t of res.extraTexts || []) texts.push({ it: t, layer: LAYER[t.layer] || LAYER.silk });
    // Reference above the part, Value below it, unless the source placed them
    const box = res.courtyardBox || res.bbox || res.coreBox || { x0: -1, y0: -1, x1: 1, y1: 1 };
    let ref = { at: [0, box.y1 + 1.0], layer: LAYER.silk, size: 1 };
    let val = { at: [0, box.y0 - 1.0], layer: LAYER.assembly, size: 1 };
    const userTexts = [];
    for (const { it, layer } of texts) {
      if (it.field === 'ref') ref = { at: it.at, layer, size: it.size };
      else if (it.field === 'value') val = { at: it.at, layer, size: it.size };
      else userTexts.push({ it, layer });
    }
    const field = (key, value, f, hidden) => {
      const n = ['property', Q(key), Q(value), ['at', f.at[0], -f.at[1], 0]];
      if (hidden) n.push(['unlocked', 'yes']);
      n.push(['layer', Q(f.layer)]);
      if (hidden) n.push(['hide', 'yes']);
      n.push(['uuid', uid()], font(f.size));
      return n;
    };
    fp.push(field('Reference', 'REF**', ref, false));
    fp.push(field('Value', name, val, false));
    fp.push(field('Datasheet', meta.datasheet || '', { at: [0, 0], layer: LAYER.assembly, size: 1.27 }, true));
    fp.push(field('Description', meta.description || '', { at: [0, 0], layer: LAYER.assembly, size: 1.27 }, true));
    const tht = res.pads.some((p) => p.tht);
    if (tht) fp.push(['attr', 'through_hole']);
    else if (res.pads.length) fp.push(['attr', 'smd']);
    fp.push(...gfx);
    for (const { it, layer } of userTexts) {
      // the fab reference label is KiCad's ${REFERENCE}
      const str = it.auto && layer === LAYER.assembly ? '${REFERENCE}' : it.str;
      fp.push(['fp_text', 'user', Q(str), ['at', it.at[0], -it.at[1], 0], ['layer', Q(layer)], ['uuid', uid()], font(it.size || 1)]);
    }
    // pads, holes
    const ctx = { balls: !!(res.generator && res.generator.kind === 'balls'), maskOverlap: 0.05 };
    for (const p of res.pads) fp.push(...pads(p, ctx, uid));
    for (const h of res.holes || []) {
      const sh = h.shape || {};
      const round = sh.kind === 'circle' || (sh.kind === 'oval' && near(sh.w, sh.l));
      const d = sh.kind === 'circle' ? sh.d : sh.w;
      const node = round
        ? ['pad', Q(''), 'np_thru_hole', 'circle', ['at', h.x, -h.y], ['size', d, d], ['drill', d]]
        : ['pad', Q(''), 'np_thru_hole', 'oval', ['at', h.x, -h.y], ['size', sh.w, sh.l], ['drill', 'oval', sh.w, sh.l]];
      node.push(['layers', Q('*.Cu'), Q('*.Mask')], ['uuid', uid()]);
      fp.push(node);
    }
    // the 3D model: embedded, or a reference to the source's STEP file
    let embedded = 0;
    const md = res.model || {};
    const model = opts.model;
    if (md.step) {
      const st = md.step;
      const o = st.offset || [0, 0, 0], r = st.rotate || [0, 0, 0], k = st.scale != null ? st.scale : 1;
      fp.push(['model', Q(st.file), ['offset', ['xyz', ...o]], ['scale', ['xyz', k, k, k]], ['rotate', ['xyz', ...r]]]);
      notes.push(`references ${st.file} (not embedded)`);
    } else if (model && !model.none && model.meshes && model.meshes.length) {
      const fname = `${name.replace(/[^\w.+-]+/g, '_')}.wrl`;
      const bytes = utf8(M3.toVRML(model, name));
      fp.push(['embedded_fonts', 'no']);
      fp.push(['embedded_files', ['file', ['name', Q(fname)], ['type', 'model'], { data: base64(zstdFrame(bytes)) }, ['checksum', Q(checksum(bytes))]]]);
      fp.push(['model', Q(`kicad-embed://${fname}`), ['offset', ['xyz', 0, 0, 0]], ['scale', ['xyz', 1, 1, 1]], ['rotate', ['xyz', 0, 0, 0]]]);
      embedded = bytes.length;
    }
    return { name, file: `${name}.kicad_mod`, text: print(fp, 0) + '\n', embedded, notes };
  }

  /**
   * A .pretty library as zip entries [{ name, data }].
   *   fps:  [{ name, result, model, skip }] in file order; skip says why it isn't exported
   *   opts: { lib (library name), source (file the footprints came from) }
   */
  function library(fps, opts) {
    opts = opts || {};
    const lib = safeName(opts.lib || 'stomp').replace(/\.pretty$/, '');
    const files = [], done = [], skipped = [];
    const used = new Set();
    let models = 0;
    for (const f of fps) {
      if (f.skip || !f.result) { skipped.push({ name: f.name, why: f.skip || 'it has errors' }); continue; }
      const out = footprint(f.result, { name: f.name, model: f.model });
      let file = out.file;
      for (let k = 2; used.has(file.toLowerCase()); k++) file = `${out.name}_${k}.kicad_mod`;
      used.add(file.toLowerCase());
      files.push({ name: `${lib}.pretty/${file}`, data: utf8(out.text) });
      done.push(out);
      if (out.embedded) models++;
    }
    const lines = [
      `${lib}.pretty: ${done.length} footprint${done.length === 1 ? '' : 's'}${opts.source ? ` from ${opts.source}` : ''}, exported by stomp live.`,
      '',
      models ? `${models} of them embed their generated 3D model (VRML), so the library needs no 3D model folder.` : 'None of them has a 3D model.',
      'These are KiCad 9 footprints. They open in KiCad 9 or later.',
      '',
      'To use the library in KiCad: unzip it, then Preferences > Manage Footprint Libraries,',
      '"Add existing library" (the folder button), and choose the .pretty folder.',
    ];
    if (skipped.length) lines.push('', 'Not exported:', ...skipped.map((s) => `  ${s.name}: ${s.why}`));
    files.push({ name: 'README.txt', data: utf8(lines.join('\n') + '\n') });
    return { lib, files, count: done.length, models, skipped };
  }

  return { checksum, murmur3x64, zstdFrame, base64, utf8, footprint, library, print, KICAD_VERSION, SEED };
});
