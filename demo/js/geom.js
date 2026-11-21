/* stomp live demo — 2D geometry helpers.
 *
 * Coordinates are millimetres, +x right, +y up (SPEC §6). Closed outlines are
 * "contours": arrays of edges, either straight lines or counter-clockwise
 * circular arcs, so bounding boxes and SVG paths stay exact while clipping and
 * hull work on tessellated polygons.
 *
 *   line: { t: 'L', a: [x, y], b: [x, y] }
 *   arc:  { t: 'A', c: [x, y], r, a0, a1, a: [x, y], b: [x, y] }   (a1 > a0, radians)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Stomp = root.Stomp || {}).geom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  const TAU = Math.PI * 2;
  const HALF_PI = Math.PI / 2;
  const deg = (d) => (d * Math.PI) / 180;

  // ---------------------------------------------------------------- contours

  function line(a, b) { return { t: 'L', a, b }; }
  function arc(c, r, a0, a1) {
    return {
      t: 'A', c, r, a0, a1,
      a: [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)],
      b: [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)],
    };
  }

  /** Rectangle w×l centred on the origin with per-corner radii (CCW from bottom edge). */
  function rrectContour(w, l, rad) {
    if (!(w > EPS && l > EPS)) return [];
    const hw = w / 2, hl = l / 2;
    const lim = Math.min(hw, hl);
    const r = {
      br: clamp(rad.br || 0, 0, lim), tr: clamp(rad.tr || 0, 0, lim),
      tl: clamp(rad.tl || 0, 0, lim), bl: clamp(rad.bl || 0, 0, lim),
    };
    const e = [];
    const push = (edge) => {
      if (edge.t === 'L' && dist(edge.a, edge.b) < EPS) return;
      if (edge.t === 'A' && edge.r < EPS) return;
      e.push(edge);
    };
    push(line([-hw + r.bl, -hl], [hw - r.br, -hl]));
    push(arc([hw - r.br, -hl + r.br], r.br, -HALF_PI, 0));
    push(line([hw, -hl + r.br], [hw, hl - r.tr]));
    push(arc([hw - r.tr, hl - r.tr], r.tr, 0, HALF_PI));
    push(line([hw - r.tr, hl], [-hw + r.tl, hl]));
    push(arc([-hw + r.tl, hl - r.tl], r.tl, HALF_PI, Math.PI));
    push(line([-hw, hl - r.tl], [-hw, -hl + r.bl]));
    push(arc([-hw + r.bl, -hl + r.bl], r.bl, Math.PI, Math.PI * 1.5));
    return e;
  }

  function circleContour(r, c) {
    if (!(r > EPS)) return [];
    return [arc(c || [0, 0], r, 0, TAU)];
  }

  function polyContour(pts) {
    const e = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (dist(a, b) > EPS) e.push(line(a, b));
    }
    return e;
  }

  /** Rotate a contour by `rot` radians about the origin, then translate. */
  function transformContour(edges, rot, tx, ty) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const tp = (p) => [p[0] * c - p[1] * s + tx, p[0] * s + p[1] * c + ty];
    return edges.map((ed) => (ed.t === 'L'
      ? line(tp(ed.a), tp(ed.b))
      : arc(tp(ed.c), ed.r, ed.a0 + rot, ed.a1 + rot)));
  }

  function contourBBox(edges) {
    const bb = emptyBox();
    for (const ed of edges) {
      if (ed.t === 'L') { addPt(bb, ed.a); addPt(bb, ed.b); continue; }
      addPt(bb, ed.a); addPt(bb, ed.b);
      // axis extremes that fall inside the arc's sweep
      const k0 = Math.ceil(ed.a0 / HALF_PI - 1e-12), k1 = Math.floor(ed.a1 / HALF_PI + 1e-12);
      for (let k = k0; k <= k1; k++) {
        const a = k * HALF_PI;
        addPt(bb, [ed.c[0] + ed.r * Math.cos(a), ed.c[1] + ed.r * Math.sin(a)]);
      }
    }
    return bb;
  }

  /** Tessellate a contour into a closed polygon (no repeated last point). */
  function contourToPoly(edges, maxStep) {
    const step = maxStep || deg(6);
    const pts = [];
    for (const ed of edges) {
      if (ed.t === 'L') { pts.push(ed.a); continue; }
      const sweep = ed.a1 - ed.a0;
      const n = Math.max(2, Math.ceil(sweep / step));
      for (let i = 0; i < n; i++) {
        const a = ed.a0 + (sweep * i) / n;
        pts.push([ed.c[0] + ed.r * Math.cos(a), ed.c[1] + ed.r * Math.sin(a)]);
      }
    }
    return dedupe(pts, true);
  }

  /** SVG path data in y-up coordinates (draw inside a scale(1,-1) group). */
  function contourToPath(edges, prec) {
    if (!edges.length) return '';
    const f = (v) => fmt(v, prec);
    let d = `M${f(edges[0].a[0])} ${f(edges[0].a[1])}`;
    for (const ed of edges) {
      if (ed.t === 'L') { d += `L${f(ed.b[0])} ${f(ed.b[1])}`; continue; }
      const sweep = ed.a1 - ed.a0;
      if (sweep >= TAU - 1e-9) {           // full circle: two half arcs
        const mid = [ed.c[0] + ed.r * Math.cos(ed.a0 + Math.PI), ed.c[1] + ed.r * Math.sin(ed.a0 + Math.PI)];
        d += `A${f(ed.r)} ${f(ed.r)} 0 0 1 ${f(mid[0])} ${f(mid[1])}`;
        d += `A${f(ed.r)} ${f(ed.r)} 0 0 1 ${f(ed.b[0])} ${f(ed.b[1])}`;
      } else {
        d += `A${f(ed.r)} ${f(ed.r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(ed.b[0])} ${f(ed.b[1])}`;
      }
    }
    return d + 'Z';
  }

  function polyToPath(pts, closed, prec) {
    if (!pts.length) return '';
    const f = (v) => fmt(v, prec);
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])} ${f(pts[i][1])}`;
    return closed ? d + 'Z' : d;
  }

  // ----------------------------------------------------------------- shapes
  // Pad / hole shapes, canonical: centred on the reference point, unrotated.
  //   { kind: 'rect' | 'oval' | 'roundrect' | 'dshape' | 'circle' | 'polygon', … }

  function dshapeRadii(w, l, flat, r) {
    const z = { tl: 0, tr: 0, bl: 0, br: 0 };
    switch (flat) {
      case 'right': return { ...z, tl: r, bl: r };
      case 'top': return { ...z, bl: r, br: r };
      case 'bottom': return { ...z, tl: r, tr: r };
      default: return { ...z, tr: r, br: r };          // flat left: round end on the right
    }
  }
  function dshapeRadius(w, l, flat) {
    return (flat === 'top' || flat === 'bottom') ? Math.min(w / 2, l) : Math.min(l / 2, w);
  }

  /** Contour of a shape grown (offset > 0) or shrunk (offset < 0) on every side. */
  function shapeContour(sh, offset) {
    const o = offset || 0;
    switch (sh.kind) {
      case 'rect':
        return rrectContour(sh.w + 2 * o, sh.l + 2 * o, {});
      case 'roundrect': {
        const r = Math.max(0, Math.min(sh.r, Math.min(sh.w, sh.l) / 2) + o);
        return rrectContour(sh.w + 2 * o, sh.l + 2 * o, { tl: r, tr: r, bl: r, br: r });
      }
      case 'oval': {
        const w = sh.w + 2 * o, l = sh.l + 2 * o, r = Math.min(w, l) / 2;
        return rrectContour(w, l, { tl: r, tr: r, bl: r, br: r });
      }
      case 'dshape': {
        const r0 = dshapeRadius(sh.w, sh.l, sh.flat);
        const w = sh.w + 2 * o, l = sh.l + 2 * o, r = Math.max(0, r0 + o);
        return rrectContour(w, l, dshapeRadii(w, l, sh.flat, r));
      }
      case 'circle':
        return circleContour(sh.d / 2 + o);
      case 'polygon':
        return polyContour(o ? offsetPolygon(sh.pts, o) : sh.pts);
      default:
        return [];
    }
  }

  /** Mirror a canonical shape across the y axis ('y': x → −x) or x axis ('x': y → −y). */
  function mirrorShape(sh, axis) {
    if (sh.kind === 'dshape') {
      const swap = axis === 'y' ? { left: 'right', right: 'left' } : { top: 'bottom', bottom: 'top' };
      return { ...sh, flat: swap[sh.flat] || sh.flat };
    }
    if (sh.kind === 'polygon') {
      const pts = sh.pts.map(([x, y]) => (axis === 'y' ? [-x, y] : [x, -y])).reverse();
      return { ...sh, pts };
    }
    return { ...sh };
  }

  // --------------------------------------------------------------- polygons

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function polyCentroid(pts) {
    const A = polyArea(pts);
    if (Math.abs(A) < EPS) {
      const bb = emptyBox(); pts.forEach((p) => addPt(bb, p));
      return [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2];
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const k = p[0] * q[1] - q[0] * p[1];
      cx += (p[0] + q[0]) * k; cy += (p[1] + q[1]) * k;
    }
    return [cx / (6 * A), cy / (6 * A)];
  }

  function ensureCCW(pts) { return polyArea(pts) < 0 ? pts.slice().reverse() : pts; }

  /** Miter offset of a simple polygon; outward for d > 0. */
  function offsetPolygon(pts, d) {
    const P = ensureCCW(dedupe(pts, true));
    const n = P.length;
    if (n < 3) return P;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n];
      const n1 = outwardNormal(p0, p1), n2 = outwardNormal(p1, p2);
      const bis = [n1[0] + n2[0], n1[1] + n2[1]];
      const bl = Math.hypot(bis[0], bis[1]);
      if (bl < 1e-12) { out.push([p1[0] + n1[0] * d, p1[1] + n1[1] * d]); continue; }
      const cosHalf = (bis[0] * n1[0] + bis[1] * n1[1]) / bl;   // (0, 1]
      const len = d / Math.max(cosHalf, 0.25);                  // miter limit 4×
      out.push([p1[0] + (bis[0] / bl) * len, p1[1] + (bis[1] / bl) * len]);
    }
    return out;
  }

  function outwardNormal(a, b) {
    // for a CCW polygon the outward normal of edge a→b points to the right
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    return [dy / L, -dx / L];
  }

  /** Andrew's monotone chain; returns CCW hull without collinear points. */
  function convexHull(points) {
    const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1])
        && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  /** Parameter t ∈ [0,1] along a→b where it crosses c→d, or null. */
  function segCross(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-15) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) return null;
    return t;
  }

  /**
   * Remove the parts of a polyline that lie inside any of the keep-out polygons.
   * Returns the surviving pieces as polylines.
   */
  function clipPolylineOutside(pts, keepouts, closed) {
    const path = closed ? pts.concat([pts[0]]) : pts;
    const pieces = [];
    let cur = null;
    const boxes = keepouts.map((k) => { const bb = emptyBox(); k.forEach((p) => addPt(bb, p)); return bb; });
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const ts = [0, 1];
      const segBox = emptyBox(); addPt(segBox, a); addPt(segBox, b);
      const near = [];
      keepouts.forEach((k, ki) => {
        if (!boxOverlap(segBox, boxes[ki])) return;
        near.push(k);
        for (let j = 0; j < k.length; j++) {
          const t = segCross(a, b, k[j], k[(j + 1) % k.length]);
          if (t !== null) ts.push(Math.min(1, Math.max(0, t)));
        }
      });
      ts.sort((x, y) => x - y);
      for (let j = 0; j + 1 < ts.length; j++) {
        const t0 = ts[j], t1 = ts[j + 1];
        if (t1 - t0 < 1e-9) continue;
        const tm = (t0 + t1) / 2;
        const m = lerp(a, b, tm);
        const inside = near.some((k) => pointInPoly(m, k));
        const p0 = lerp(a, b, t0), p1 = lerp(a, b, t1);
        if (inside) { if (cur) { pieces.push(cur); cur = null; } continue; }
        if (cur && dist(cur[cur.length - 1], p0) < 1e-7) cur.push(p1);
        else { if (cur) pieces.push(cur); cur = [p0, p1]; }
      }
    }
    if (cur) pieces.push(cur);
    // a closed outline that survived around its start point: join first & last
    if (closed && pieces.length > 1) {
      const first = pieces[0], last = pieces[pieces.length - 1];
      if (dist(last[last.length - 1], first[0]) < 1e-7) {
        pieces[0] = last.concat(first.slice(1));
        pieces.pop();
      }
    }
    return pieces.map((p) => dedupe(p, false)).filter((p) => p.length >= 2 && pathLength(p) > 1e-6);
  }

  /** True if two simple polygons overlap with positive area (touching is not overlap). */
  function polysOverlap(P, Q) {
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      for (let j = 0; j < Q.length; j++) {
        if (properCross(a, b, Q[j], Q[(j + 1) % Q.length])) return true;
      }
    }
    // containment: test a point slightly inside each
    return pointInPoly(interiorPoint(P), Q) || pointInPoly(interiorPoint(Q), P);
  }

  function properCross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    const tol = 1e-12;
    return ((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol))
      && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol));
  }

  function interiorPoint(P) {
    const c = polyCentroid(P);
    if (pointInPoly(c, P)) return c;
    // fall back: midpoint of first edge nudged inward
    const Q = ensureCCW(P);
    const a = Q[0], b = Q[1], n = outwardNormal(a, b);
    return [(a[0] + b[0]) / 2 - n[0] * 1e-4, (a[1] + b[1]) / 2 - n[1] * 1e-4];
  }

  // -------------------------------------------------------------- utilities

  function emptyBox() { return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; }
  function addPt(bb, p) {
    if (p[0] < bb.x0) bb.x0 = p[0]; if (p[0] > bb.x1) bb.x1 = p[0];
    if (p[1] < bb.y0) bb.y0 = p[1]; if (p[1] > bb.y1) bb.y1 = p[1];
    return bb;
  }
  function unionBox(a, b) {
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  }
  function boxValid(bb) { return bb && bb.x0 <= bb.x1 && bb.y0 <= bb.y1; }
  function boxOverlap(a, b) { return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pathLength(p) { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]); return s; }
  function dedupe(pts, closed) {
    const out = [];
    for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-9) out.push(p);
    if (closed && out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-9) out.pop();
    return out;
  }
  function fmt(v, prec) {
    const p = prec === undefined ? 5 : prec;
    const s = (Math.abs(v) < 1e-12 ? 0 : v).toFixed(p);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  /** Arc as a polyline (angles in radians, CCW from a0 to a1). */
  function arcPoints(c, r, a0, a1, maxStep) {
    const step = maxStep || deg(5);
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return pts;
  }

  /**
   * Ear-clipping triangulation of a simple polygon (either winding). Returns index
   * triples into pts, counter-clockwise. Collinear and duplicate points are skipped.
   */
  function triangulate(pts) {
    const n = pts.length;
    if (n < 3) return [];
    const ccw = polyArea(pts) >= 0;
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
    const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const scale = Math.max(1e-9, ...pts.map((p) => Math.abs(p[0]) + Math.abs(p[1])));
    const eps = 1e-12 * scale * scale;
    // inclusive: a reflex vertex on the candidate diagonal blocks the ear too
    const same = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) <= 1e-12 * scale;
    const inside = (p, a, b, c) => !same(p, a) && !same(p, b) && !same(p, c)
      && area2(a, b, p) >= -eps && area2(b, c, p) >= -eps && area2(c, a, p) >= -eps;
    const tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 20000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const m = idx.length;
        const i0 = idx[(i + m - 1) % m], i1 = idx[i], i2 = idx[(i + 1) % m];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        const ar = area2(a, b, c);
        if (Math.abs(ar) <= eps) { idx.splice(i, 1); cut = true; break; }   // collinear / duplicate
        if (ar < 0) continue;                                              // reflex
        let ear = true;
        for (const j of idx) {
          if (j === i0 || j === i1 || j === i2) continue;
          if (inside(pts[j], a, b, c)) { ear = false; break; }
        }
        if (!ear) continue;
        tris.push([i0, i1, i2]);
        idx.splice(i, 1);
        cut = true;
        break;
      }
      if (!cut) break;   // not a simple polygon; keep what we have
    }
    if (idx.length === 3 && Math.abs(area2(pts[idx[0]], pts[idx[1]], pts[idx[2]])) > eps) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }

  return {
    EPS, TAU, deg, triangulate,
    line, arc, rrectContour, circleContour, polyContour, transformContour, contourBBox,
    contourToPoly, contourToPath, polyToPath, shapeContour, mirrorShape, dshapeRadius,
    polyArea, polyCentroid, ensureCCW, offsetPolygon, convexHull, pointInPoly, segCross,
    clipPolylineOutside, polysOverlap, arcPoints,
    emptyBox, addPt, unionBox, boxValid, boxOverlap, dist, lerp, clamp, dedupe, fmt, pathLength,
  };
});
