// Figures for the docs: footprints stomp builds, drawn with the dimensions their numbers
// stand for. The geometry comes from the engine, and each label is measured from it, so
// a figure can't drift from what the code makes.
//
// Each figure is an SVG: a file in docs/img/ for GitHub, with its own colors, and the
// same drawing inline in the editor's docs, where it takes the page's colors.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine as loadEngine } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const js = resolve(here, '..', 'js');
const require = createRequire(import.meta.url);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** A measured length as the code would write it: 6.0, 1.27, 0.5. */
const num = (v) => { const r = +v.toFixed(2); return Number.isInteger(r) ? r.toFixed(1) : String(r); };
const px = (v) => +v.toFixed(2);

/** The engine, with the library as stdlib/ has it (the build may have just rewritten it), and the viewer's paths. */
function engine() {
  const E = loadEngine();
  return { compile: E.compile, M: E.model3d, paths: require(join(js, 'view.js')).Stomp.svgPaths };
}

/**
 * A drawing in mm, y up: shapes, then dimensions. `dimH(x0, x1, y, label, o)` is a
 * horizontal dimension drawn at height y, with extension lines down (or up) from
 * o.from0 and o.from1, the heights of the features measured; `dimV` is the same on
 * its side. o.side puts the label above or below (left or right) the line.
 */
function scene() {
  const items = [];
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x, y) => { bb.x0 = Math.min(bb.x0, x); bb.x1 = Math.max(bb.x1, x); bb.y0 = Math.min(bb.y0, y); bb.y1 = Math.max(bb.y1, y); };
  return {
    items, bb,
    path(d, box, cls) { items.push({ t: 'path', d, cls }); grow(box.x0, box.y0); grow(box.x1, box.y1); },
    rect(x0, y0, x1, y1, cls) { items.push({ t: 'poly', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], cls }); grow(x0, y0); grow(x1, y1); },
    poly(pts, cls) { items.push({ t: 'poly', pts, cls }); for (const [x, y] of pts) grow(x, y); },
    line(pts, cls, w) { items.push({ t: 'line', pts, cls, w }); for (const [x, y] of pts) grow(x, y); },
    text(x, y, str, cls) { items.push({ t: 'text', x, y, str, cls }); },
    dimH(x0, x1, y, label, o = {}) { items.push({ t: 'dimH', x0, x1, y, label, from0: o.from0 ?? y, from1: o.from1 ?? y, side: o.side || 'up' }); grow(x0, y); grow(x1, y); },
    dimV(y0, y1, x, label, o = {}) { items.push({ t: 'dimV', y0, y1, x, label, from0: o.from0 ?? x, from1: o.from1 ?? x, side: o.side || 'right' }); grow(x, y0); grow(x, y1); },
    /** A label at (x1, y1) with a line to the feature at (x0, y0). */
    leader(x0, y0, x1, y1, label) { items.push({ t: 'leader', x0, y0, x1, y1, label }); grow(x0, y0); grow(x1, y1); },
  };
}

// Label sizes, for laying out: 12.5px monospace
const CH = 7.6, LH = 15;

/** The scene as SVG. Inline, it's styled by the page; standalone, by its own <style>. */
function toSvg(sc, o) {
  const { bb } = sc;
  const s = Math.min(o.width / Math.max(bb.x1 - bb.x0, 0.1), o.height / Math.max(bb.y1 - bb.y0, 0.1));
  const X = (x) => px((x - bb.x0) * s), Y = (y) => px((bb.y1 - y) * s);
  const out = [];
  const box = { x0: 0, y0: 0, x1: (bb.x1 - bb.x0) * s, y1: (bb.y1 - bb.y0) * s };
  const take = (x0, y0, x1, y1) => { box.x0 = Math.min(box.x0, x0); box.y0 = Math.min(box.y0, y0); box.x1 = Math.max(box.x1, x1); box.y1 = Math.max(box.y1, y1); };
  const arrow = (x, y, dx, dy) => {
    // a filled head at (x, y) pointing along (dx, dy)
    const L = 7, W = 3.2, nx = -dy, ny = dx;
    return `<path class="f-arrow" d="M${px(x)} ${px(y)}L${px(x - dx * L + nx * W)} ${px(y - dy * L + ny * W)}L${px(x - dx * L - nx * W)} ${px(y - dy * L - ny * W)}Z"/>`;
  };
  const label = (x, y, str, anchor) => {
    const w = str.length * CH;
    const xa = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    take(xa - 2, y - LH + 3, xa + w + 2, y + 4);
    return `<text class="f-txt" x="${px(x)}" y="${px(y)}" text-anchor="${anchor}">${esc(str)}</text>`;
  };
  for (const it of sc.items) {
    if (it.t === 'path') out.push(`<path class="${it.cls}" transform="matrix(${px(s)} 0 0 ${px(s)} ${px(-bb.x0 * s)} ${px(bb.y1 * s)})" vector-effect="non-scaling-stroke" d="${it.d}"/>`);
    else if (it.t === 'poly') out.push(`<path class="${it.cls}" d="M${it.pts.map(([x, y]) => `${X(x)} ${Y(y)}`).join('L')}Z"/>`);
    else if (it.t === 'line') out.push(`<path class="${it.cls}" d="M${it.pts.map(([x, y]) => `${X(x)} ${Y(y)}`).join('L')}"${it.w ? ` stroke-width="${px(it.w * s)}"` : ''}/>`);
    else if (it.t === 'text') { out.push(`<text class="${it.cls}" x="${X(it.x)}" y="${px(Y(it.y) + 4.5)}" text-anchor="middle">${esc(it.str)}</text>`); }
    else if (it.t === 'leader') {
      const xa = X(it.x0), ya = Y(it.y0), xb = X(it.x1), yb = Y(it.y1);
      out.push(`<path class="f-dim" d="M${xa} ${ya}L${xb} ${px(yb - 12)}"/>`, `<circle class="f-arrow" cx="${xa}" cy="${ya}" r="2.2"/>`);
      out.push(label(xb, yb, it.label, 'middle'));
    }
    else if (it.t === 'dimH') {
      const xa = X(it.x0), xb = X(it.x1), y = Y(it.y);
      const ext = (x, from) => { const yf = Y(from); if (Math.abs(yf - y) < 1) return ''; const d = yf > y ? -1 : 1; return `<path class="f-ext" d="M${x} ${px(yf + d * 3)}L${x} ${px(y + d * -5)}"/>`; };
      out.push(ext(xa, it.from0), ext(xb, it.from1));
      const inside = xb - xa >= 30;
      if (inside) out.push(`<path class="f-dim" d="M${xa} ${y}L${xb} ${y}"/>`, arrow(xa, y, -1, 0), arrow(xb, y, 1, 0));
      else out.push(`<path class="f-dim" d="M${px(xa - 16)} ${y}L${px(xb + 16)} ${y}"/>`, arrow(xa, y, 1, 0), arrow(xb, y, -1, 0));
      out.push(label((xa + xb) / 2, it.side === 'up' ? y - 6 : y + 15, it.label, 'middle'));
      take(Math.min(xa, xb) - 18, y - 4, Math.max(xa, xb) + 18, y + 4);
    } else if (it.t === 'dimV') {
      const ya = Y(it.y0), yb = Y(it.y1), x = X(it.x);
      const ext = (y, from) => { const xf = X(from); if (Math.abs(xf - x) < 1) return ''; const d = xf > x ? -1 : 1; return `<path class="f-ext" d="M${px(xf + d * 3)} ${y}L${px(x + d * -5)} ${y}"/>`; };
      out.push(ext(ya, it.from0), ext(yb, it.from1));
      const top = Math.min(ya, yb), bot = Math.max(ya, yb);
      const inside = bot - top >= 30;
      if (inside) out.push(`<path class="f-dim" d="M${x} ${top}L${x} ${bot}"/>`, arrow(x, top, 0, -1), arrow(x, bot, 0, 1));
      else out.push(`<path class="f-dim" d="M${x} ${px(top - 16)}L${x} ${px(bot + 16)}"/>`, arrow(x, top, 0, 1), arrow(x, bot, 0, -1));
      const ym = (top + bot) / 2 + 4.5;
      out.push(it.side === 'right' ? label(x + 7, ym, it.label, 'start') : label(x - 7, ym, it.label, 'end'));
      take(x - 4, top - 18, x + 4, bot + 18);
    }
  }
  const pad = 10;
  const W = Math.ceil(box.x1 - box.x0 + 2 * pad), H = Math.ceil(box.y1 - box.y0 + 2 * pad);
  const tx = px(pad - box.x0), ty = px(pad - box.y0);
  const style = o.standalone ? `<style>${STANDALONE_CSS}</style>` : '';
  const bg = `<rect class="f-bg" x="0" y="0" width="${W}" height="${H}" rx="8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="figure" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.alt)}">${style}${bg}<g transform="translate(${tx} ${ty})">${out.join('')}</g></svg>`;
}

// For the files GitHub shows: the editor's light colors
const STANDALONE_CSS = [
  '.f-bg{fill:#fbfcf9;stroke:#d2dad1}',
  '.f-pad{fill:#cf9637;stroke:#8a5a12;stroke-width:1px}',
  '.f-land{fill:#cf9637;fill-opacity:.18;stroke:#cf9637;stroke-width:1px;stroke-dasharray:4 3}',
  '.f-body{fill:#33689e;fill-opacity:.06;stroke:#33689e;stroke-width:1.5px}',
  '.f-epoxy{fill:#2b2c31;stroke:#17181b;stroke-width:1px}',
  '.f-lead{fill:#c6cad0;stroke:#7d838b;stroke-width:1px}',
  '.f-wire{fill:none;stroke:#b8bdc4;stroke-linejoin:round}',
  '.f-board{fill:#23593f}',
  '.f-cu{fill:#cf9637}',
  '.f-dim,.f-ext{fill:none;stroke:#0a6cc0;stroke-width:1px}',
  '.f-ext{stroke-opacity:.6}',
  '.f-arrow{fill:#0a6cc0}',
  'text{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  '.f-txt{fill:#0a4f8c;paint-order:stroke;stroke:#fbfcf9;stroke-width:4px;stroke-linejoin:round}',
  '.f-num{fill:#3a2405;font-weight:600}',
].join('');

/** The pads of a result, drawn as the engine outlines them. */
function drawPads(sc, r, P, cls, numbers) {
  for (const p of r.pads) {
    sc.path(P.contour(p.copper), p.bbox, cls);
    if (numbers) sc.text(p.x, p.y, p.name, 'f-num');
  }
}

// The figures. Each compiles `src`, then `draw` lays out the scene from the result.
export const FIGURES = [
  {
    id: 'gap',
    alt: 'Two pads: gap 0.5 between their facing edges; each pad W 0.5 across the part and L 0.6 along it, outward',
    width: 380, height: 150,
    src: 'footprint "R0402"\n  pins 2 horizontal\n  default pad rect 0.5 x 0.6\n  gap: 0.5\nend\n',
    draw(sc, r, P) {
      const [a, b] = r.pads.map((p) => p.bbox);
      drawPads(sc, r, P, 'f-pad', true);
      sc.dimH(a.x1, b.x0, a.y1 + 0.32, `gap: ${num(b.x0 - a.x1)}`, { from0: a.y1, from1: b.y1 });
      sc.dimH(b.x0, b.x1, b.y0 - 0.32, `L ${num(b.x1 - b.x0)}`, { from0: b.y0, from1: b.y0, side: 'down' });
      sc.dimV(b.y0, b.y1, b.x1 + 0.3, `W ${num(b.y1 - b.y0)}`, { from0: b.x1, from1: b.x1 });
    },
  },
  {
    id: 'relations',
    alt: 'A DPAK: pads 1 and 3 4.56 apart, center to center; the tab\'s near edge 1.9 above the pin centers',
    width: 420, height: 300,
    src: 'footprint "TO-252"\n  pad 1 rect 1.1 x 1.6\n  pad 3 rect 1.1 x 1.6\n  pad 2 rect 5.5 x 6.2\n  pad 3 is 4.56 right of pad 1\n  pad 2 is centered between pad 1 and pad 3 horizontally\n  pad 2 inner is 1.9 above pad 1\nend\n',
    draw(sc, r, P) {
      const by = (n) => r.pads.find((p) => p.name === n);
      const p1 = by('1'), p2 = by('2'), p3 = by('3');
      drawPads(sc, r, P, 'f-pad', true);
      sc.dimH(p1.x, p3.x, p1.bbox.y0 - 0.7, `${num(p3.x - p1.x)} center to center`, { from0: p1.y, from1: p3.y, side: 'down' });
      const x = p2.bbox.x1 + 0.8;
      sc.dimV(p3.y, p2.bbox.y0, x, `${num(p2.bbox.y0 - p3.y)} edge to center`, { from0: p3.x, from1: p2.bbox.x1 });
    },
  },
  {
    id: 'anchors',
    alt: 'Two pads measured three ways: center to center 2.5, inner to inner 1.5, outer to outer 3.5',
    width: 360, height: 170,
    src: 'footprint "PAIR"\n  pad 1 rect 1 x 1.4\n  pad 2 rect 1 x 1.4\n  pad 1 at (0, 0)\n  pad 2 is 2.5 right of pad 1\nend\n',
    draw(sc, r, P) {
      const [a, b] = r.pads;
      drawPads(sc, r, P, 'f-pad', true);
      const top = a.bbox.y1;
      sc.dimH(a.bbox.x1, b.bbox.x0, top + 0.35, `inner to inner: ${num(b.bbox.x0 - a.bbox.x1)}`, { from0: top, from1: top });
      sc.dimH(a.bbox.x0, b.bbox.x1, top + 1.0, `outer to outer: ${num(b.bbox.x1 - a.bbox.x0)}`, { from0: top, from1: top });
      sc.dimH(a.x, b.x, a.bbox.y0 - 0.45, `center to center: ${num(b.x - a.x)}`, { from0: a.y, from1: b.y, side: 'down' });
    },
  },
  {
    id: 'package',
    alt: 'A SOIC-8 from above: body E1 3.9 by D 4.9, leads b 0.41 wide with feet L 1.04 long, pitch e 1.27, span E 6.0 tip to tip, over the lands stomp works out',
    width: 430, height: 380,
    src: 'footprint "SOIC-8"\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch: 1.27\n  lead gullwing 0.41 x 1.04 span: 6.0\n  pin1: dot\nend\n',
    draw(sc, r, P) {
      drawPads(sc, r, P, 'f-land', false);
      const b = r.body;
      const bx0 = b.x - b.w / 2, bx1 = b.x + b.w / 2, by0 = b.y - b.l / 2, by1 = b.y + b.l / 2;
      for (const l of r.leads) {
        const out = l.side === 'right' ? 1 : -1;
        const edge = out > 0 ? bx1 : bx0;
        sc.rect(Math.min(edge, l.toe), l.y - l.w / 2, Math.max(edge, l.toe), l.y + l.w / 2, 'f-lead');
      }
      sc.rect(bx0, by0, bx1, by1, 'f-body');
      sc.text(bx0 + 0.45, by1 - 0.5, '1', 'f-num');
      const lead = (n) => r.leads.find((l) => l.pad === n);
      const L1 = lead('1'), L4 = lead('4'), L5 = lead('5'), L6 = lead('6');
      const left = L1.toe, right = L5.toe;
      sc.dimH(bx0, bx1, by1 + 0.45, `E1 ${num(bx1 - bx0)}`, { from0: by1, from1: by1 });
      sc.dimH(left, right, by1 + 1.15, `E ${num(right - left)} (span)`, { from0: L1.y + L1.w / 2, from1: lead('8').y + lead('8').w / 2 });
      sc.dimV(by0, by1, left - 0.55, `D ${num(by1 - by0)}`, { from0: bx0, from1: bx0, side: 'left' });
      sc.dimV(L5.y, L6.y, right + 0.5, `e ${num(L6.y - L5.y)}`, { from0: right, from1: right });
      sc.dimV(L5.y - L5.w / 2, L5.y + L5.w / 2, right + 1.75, `b ${num(L5.w)}`, { from0: right, from1: right });
      sc.dimH(left, left + L4.l, by0 - 0.45, `L ${num(L4.l)}`, { from0: L4.y - L4.w / 2, from1: L4.y - L4.w / 2, side: 'down' });
    },
  },
  {
    id: 'side',
    alt: 'A SOIC-8 from the front: the seated height A 1.5 from the board to the top of the body, the standoff A1 0.1 under it, and the span E 6.0',
    width: 560, height: 230,
    src: 'footprint "SOIC-8"\n  body 3.9 x 4.9 x 1.5\n  pins 8 dual pitch: 1.27\n  lead gullwing 0.41 x 1.04 span: 6.0\n  pin1: dot\nend\n',
    draw(sc, r, P, E) {
      const m = E.M.build(r);
      const H = m.H, z0 = m.standoff, b = r.body;
      const hw = b.w / 2, zp = z0 + 0.5 * (H - z0), t = Math.tan(8 * Math.PI / 180);
      const left = r.leads.find((l) => l.side === 'left'), right = r.leads.find((l) => l.side === 'right');
      // as the model draws it: a foot shortened to leave the bend room (the 3D model's rule)
      const c = 0.2, room = Math.abs(left.toe) - hw;
      const foot = Math.min(left.l, room - Math.max(1.2 * c, 0.25 * room));
      const x0 = left.toe - 0.6, x1 = right.toe + 0.6;
      sc.rect(x0, -0.32, x1, 0, 'f-board');
      for (const p of r.pads) if (p.y === r.pads[0].y || p.y === r.pads[r.pads.length - 1].y) sc.rect(p.bbox.x0, 0, p.bbox.x1, 0.035, 'f-cu');
      // the leads' centerlines, gull-wing: out of the body, down to the board, the foot along it
      for (const l of [left, right]) {
        const d = l.side === 'right' ? 1 : -1;
        const out = hw + 0.1;
        sc.line([[d * (hw - 0.05), zp], [d * out, zp], [d * (Math.abs(l.toe) - foot), c / 2], [l.toe, c / 2]], 'f-wire', c);
      }
      sc.poly([[-hw + (zp - z0) * t, z0], [hw - (zp - z0) * t, z0], [hw, zp], [hw - (H - zp) * t, H], [-hw + (H - zp) * t, H], [-hw, zp]], 'f-epoxy');
      sc.dimV(0, H, left.toe - 0.35, `A ${num(H)}`, { from0: left.toe, from1: -hw + (H - zp) * t, side: 'left' });
      sc.leader(0.9, z0 / 2, 0.9, -0.62, `A1 ${num(z0)}: the standoff`);
      sc.dimH(left.toe, right.toe, -1.05, `E ${num(right.toe - left.toe)}`, { from0: 0, from1: 0, side: 'down' });
    },
  },
];

/** A figure's SVG. standalone: with its own colors, for a file. */
export function figureSvg(fig, standalone) {
  const E = engine();
  const out = E.compile(fig.src, { cache: false });
  const fp = out.footprints[0];
  if (!fp || !fp.result) throw new Error(`figure ${fig.id}: its footprint doesn't build: ${out.diagnostics.map((d) => d.message).join('; ')}`);
  const sc = scene();
  fig.draw(sc, fp.result, E.paths, E);
  return toSvg(sc, { width: fig.width, height: fig.height, standalone, alt: fig.alt });
}
