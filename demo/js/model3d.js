/* stomp live demo: 3D models (SPEC 13).
 *
 * build(res) turns a compiled footprint into meshes. The shapes come from stomp
 * features, the standard library's (stdlib/*.stomp) or the user's: the engine
 * here measures the part, picks the body and lead features to call (SPEC 13.5),
 * and its kernel turns the solids they draw into meshes. board(res) builds the
 * board under it for the viewer. toVRML and toSTL export the part, not the board.
 *
 * Units are mm: x and y as in the footprint, z up from the board (z = 0).
 * A mesh is { name, kind, color: [r, g, b], metal: 0 | 1, pos, nrm, idx, src }:
 * pos and nrm are Float32Arrays (xyz per vertex), idx a Uint32Array of
 * triangles, counterclockwise seen from outside.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geom.js'));
  else (root.Stomp = root.Stomp || {}).model3d = factory(root.Stomp.geom);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const D2R = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Colors
  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  // colors the engine falls back on when a hook names none
  const TIN = { color: hex('#c6cad0'), metal: 1 };
  const EPOXY = { color: hex('#26272b'), metal: 0 };

  // Meshes
  class Mesh {
    constructor(name, kind, mat, src) {
      this.name = name; this.kind = kind; this.color = mat.color; this.metal = mat.metal;
      this.src = src || []; this.p = []; this.n = []; this.i = [];
    }
    v(x, y, z, nx, ny, nz) { this.p.push(x, y, z); this.n.push(nx, ny, nz); return this.p.length / 3 - 1; }
    tri(a, b, c) { this.i.push(a, b, c); }
    quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    /** Flat quad from four points (any winding is fixed later). */
    face4(P0, P1, P2, P3) {
      const n = normal3(P0, P1, P2);
      const a = this.v(...P0, ...n), b = this.v(...P1, ...n), c = this.v(...P2, ...n), d = this.v(...P3, ...n);
      this.quad(a, b, c, d);
    }
    /** Flat polygon at height z (pts CCW in xy), facing up or down. */
    cap(pts, z, up) {
      const tris = G.triangulate(pts);
      const base = this.p.length / 3;
      for (const q of pts) this.v(q[0], q[1], z, 0, 0, up ? 1 : -1);
      for (const [a, b, c] of tris) this.tri(base + a, base + b, base + c);
    }
    transform(fn, fnN) {
      for (let k = 0; k < this.p.length; k += 3) {
        const q = fn(this.p[k], this.p[k + 1], this.p[k + 2]);
        this.p[k] = q[0]; this.p[k + 1] = q[1]; this.p[k + 2] = q[2];
        const m = fnN(this.n[k], this.n[k + 1], this.n[k + 2]);
        this.n[k] = m[0]; this.n[k + 1] = m[1]; this.n[k + 2] = m[2];
      }
      return this;
    }
    append(o) {
      const base = this.p.length / 3;
      for (let k = 0; k < o.p.length; k++) { this.p.push(o.p[k]); this.n.push(o.n[k]); }
      for (const k of o.i) this.i.push(base + k);
      return this;
    }
    /** Make every triangle counter-clockwise seen from the side its normals face. */
    finish() {
      const P = this.p, N = this.n, I = this.i;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
        const sx = N[a] + N[b] + N[c], sy = N[a + 1] + N[b + 1] + N[c + 1], sz = N[a + 2] + N[b + 2] + N[c + 2];
        if (fx * sx + fy * sy + fz * sz < 0) { const k = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = k; }
      }
      const out = { name: this.name, kind: this.kind, color: this.color, metal: this.metal, src: this.src };
      out.pos = new Float32Array(P);
      out.nrm = new Float32Array(N);
      out.idx = new Uint32Array(I);
      return out;
    }
  }

  function normal3(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const L = Math.hypot(x, y, z) || 1;
    return [x / L, y / L, z / L];
  }

  // Primitives
  /** Axis-aligned box. */
  function box(m, x0, y0, z0, x1, y1, z1) {
    if (!(x1 > x0 && y1 > y0 && z1 > z0)) return m;
    const F = (a, b, c, d) => m.face4(a, b, c, d);
    F([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);   // bottom
    F([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);   // top
    F([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);   // front (-y)
    F([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);   // back (+y)
    F([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);   // left
    F([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);   // right
    return m;
  }
  const boxC = (m, cx, cy, z0, w, l, h) => box(m, cx - w / 2, cy - l / 2, z0, cx + w / 2, cy + l / 2, z0 + h);

  /** Lofted solid through rings of equal point count (CCW polygons at increasing z). */
  function loft(m, rings, caps) {
    const n = rings[0].pts.length;
    for (let r = 0; r + 1 < rings.length; r++) {
      const A = rings[r], B = rings[r + 1];
      if (B.z - A.z < 1e-9) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        m.face4([A.pts[i][0], A.pts[i][1], A.z], [A.pts[j][0], A.pts[j][1], A.z], [B.pts[j][0], B.pts[j][1], B.z], [B.pts[i][0], B.pts[i][1], B.z]);
      }
    }
    if (caps !== false) {
      m.cap(rings[0].pts, rings[0].z, false);
      m.cap(rings[rings.length - 1].pts, rings[rings.length - 1].z, true);
    }
    return m;
  }
  const rectPts = (cx, cy, w, l) => [[cx - w / 2, cy - l / 2], [cx + w / 2, cy - l / 2], [cx + w / 2, cy + l / 2], [cx - w / 2, cy + l / 2]];

  /** Upright frustum or cylinder with smooth sides. */
  function frustum(m, cx, cy, z0, z1, r0, r1, seg, caps) {
    seg = seg || 24;
    const slope = (r0 - r1) / Math.max(z1 - z0, 1e-9);
    const nz = slope / Math.hypot(1, slope), nr = 1 / Math.hypot(1, slope);
    const base = m.p.length / 3;
    for (let k = 0; k <= seg; k++) {
      const a = (2 * Math.PI * k) / seg, c = Math.cos(a), s = Math.sin(a);
      m.v(cx + r0 * c, cy + r0 * s, z0, c * nr, s * nr, nz);
      m.v(cx + r1 * c, cy + r1 * s, z1, c * nr, s * nr, nz);
    }
    for (let k = 0; k < seg; k++) {
      const a = base + 2 * k;
      m.quad(a, a + 2, a + 3, a + 1);
    }
    const circ = (r) => Array.from({ length: seg }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / seg), cy + r * Math.sin((2 * Math.PI * k) / seg)]);
    if (caps !== false) {
      if (r0 > 1e-9 && caps !== 'top') m.cap(circ(r0), z0, false);
      if (r1 > 1e-9 && caps !== 'bottom') m.cap(circ(r1), z1, true);
    }
    return m;
  }
  const cylinder = (m, cx, cy, z0, z1, r, seg, caps) => frustum(m, cx, cy, z0, z1, r, r, seg, caps);

  /** Flat ring (annulus) at height z, facing up or down. */
  function ring(m, cx, cy, z, r0, r1, seg, up) {
    const base = m.p.length / 3;
    const nz = up ? 1 : -1;
    for (let k = 0; k <= seg; k++) {
      const a = (2 * Math.PI * k) / seg;
      m.v(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a), z, 0, 0, nz);
      m.v(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a), z, 0, 0, nz);
    }
    for (let k = 0; k < seg; k++) { const a = base + 2 * k; m.quad(a, a + 1, a + 3, a + 2); }
    return m;
  }

  /** Part of a cylinder or cone wall, from angle a0 to a1 (radians): a stripe on a can. */
  function shell(m, cx, cy, z0, z1, r0, r1, a0, a1, seg) {
    const slope = (r0 - r1) / Math.max(z1 - z0, 1e-9);
    const nz = slope / Math.hypot(1, slope), nr = 1 / Math.hypot(1, slope);
    const base = m.p.length / 3;
    for (let k = 0; k <= seg; k++) {
      const a = a0 + ((a1 - a0) * k) / seg, c = Math.cos(a), s = Math.sin(a);
      m.v(cx + r0 * c, cy + r0 * s, z0, c * nr, s * nr, nz);
      m.v(cx + r1 * c, cy + r1 * s, z1, c * nr, s * nr, nz);
    }
    for (let k = 0; k < seg; k++) { const a = base + 2 * k; m.quad(a, a + 2, a + 3, a + 1); }
    return m;
  }

  /** Part of a flat ring, from angle a0 to a1 (radians). */
  function ringSector(m, cx, cy, z, r0, r1, a0, a1, seg, up) {
    const base = m.p.length / 3;
    const nz = up ? 1 : -1;
    for (let k = 0; k <= seg; k++) {
      const a = a0 + ((a1 - a0) * k) / seg;
      m.v(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a), z, 0, 0, nz);
      m.v(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a), z, 0, 0, nz);
    }
    for (let k = 0; k < seg; k++) { const a = base + 2 * k; m.quad(a, a + 1, a + 3, a + 2); }
    return m;
  }

  function ellipsoid(m, cx, cy, cz, rx, ry, rz, slices, stacks) {
    slices = slices || 16; stacks = stacks || 10;
    const base = m.p.length / 3;
    for (let i = 0; i <= stacks; i++) {
      const th = (Math.PI * i) / stacks, st = Math.sin(th), ct = Math.cos(th);
      for (let j = 0; j <= slices; j++) {
        const ph = (2 * Math.PI * j) / slices, sp = Math.sin(ph), cp = Math.cos(ph);
        const x = st * cp, y = st * sp, z = ct;
        let nx = x / rx, ny = y / ry, nz = z / rz;
        const L = Math.hypot(nx, ny, nz) || 1;
        m.v(cx + rx * x, cy + ry * y, cz + rz * z, nx / L, ny / L, nz / L);
      }
    }
    for (let i = 0; i < stacks; i++) {
      for (let j = 0; j < slices; j++) {
        const a = base + i * (slices + 1) + j, b = a + slices + 1;
        if (i > 0) m.tri(a, b, a + 1);
        if (i < stacks - 1) m.tri(a + 1, b, b + 1);
      }
    }
    return m;
  }

  /** Round a polyline's corners with arcs of radius r (limited by the segments).
   *  `keep[i]` true leaves point i as it is: an arc's own points. */
  function fillet(pts, r, stepDeg, keep) {
    const step = (stepDeg || 10) * D2R;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      if (keep && keep[i]) { out.push(p1); continue; }
      const L1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), L2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (L1 < 1e-9 || L2 < 1e-9) { out.push(p1); continue; }
      const d1 = [(p1[0] - p0[0]) / L1, (p1[1] - p0[1]) / L1], d2 = [(p2[0] - p1[0]) / L2, (p2[1] - p1[1]) / L2];
      const th = Math.acos(clamp(d1[0] * d2[0] + d1[1] * d2[1], -1, 1));
      if (th < 1e-3) { out.push(p1); continue; }
      let tl = r * Math.tan(th / 2), rr = r;
      const maxT = 0.45 * Math.min(L1, L2);
      if (tl > maxT) { tl = maxT; rr = tl / Math.tan(th / 2); }
      const a = [p1[0] - d1[0] * tl, p1[1] - d1[1] * tl];
      const turn = d1[0] * d2[1] - d1[1] * d2[0] > 0 ? 1 : -1;
      const nrm = turn > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
      const c = [a[0] + nrm[0] * rr, a[1] + nrm[1] * rr];
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      const k = Math.max(2, Math.ceil(th / step));
      for (let j = 0; j <= k; j++) {
        const ang = a0 + turn * th * (j / k);
        out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * Sweep a rectangle (width w across the path's plane, thickness t in it) along a
   * path of (u, z) points. map(u, v, z) gives the world point; mapN the world normal.
   */
  function sweepRect(m, path, w, t, map, mapN) {
    const n = path.length;
    if (n < 2) return m;
    const N = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      let tu = b[0] - a[0], tz = b[1] - a[1];
      const L = Math.hypot(tu, tz) || 1; tu /= L; tz /= L;
      N.push([-tz, tu]);
    }
    const P = (i, sn, sv) => map(path[i][0] + sn * N[i][0] * t / 2, sv * w / 2, path[i][1] + sn * N[i][1] * t / 2);
    const strip = (sn, sv0, sv1, normal) => {
      const base = m.p.length / 3;
      for (let i = 0; i < n; i++) {
        const nn = normal(i);
        m.v(...P(i, sn === null ? -1 : sn, sv0), ...nn);
        m.v(...P(i, sn === null ? 1 : sn, sv1), ...nn);
      }
      for (let i = 0; i + 1 < n; i++) { const a = base + 2 * i; m.quad(a, a + 2, a + 3, a + 1); }
    };
    strip(1, -1, 1, (i) => mapN(N[i][0], 0, N[i][1]));         // outer face (+n)
    strip(-1, -1, 1, (i) => mapN(-N[i][0], 0, -N[i][1]));      // inner face (-n)
    strip(null, 1, 1, () => mapN(0, 1, 0));                     // +v side
    strip(null, -1, -1, () => mapN(0, -1, 0));                  // -v side
    const end = (i, s) => {
      const a = path[i], b = path[i + s];
      const tn = [(a[0] - b[0]), (a[1] - b[1])], L = Math.hypot(tn[0], tn[1]) || 1;
      const nn = mapN(tn[0] / L, 0, tn[1] / L);
      const q = [P(i, 1, 1), P(i, 1, -1), P(i, -1, -1), P(i, -1, 1)];
      const base = m.p.length / 3;
      for (const x of q) m.v(...x, ...nn);
      m.quad(base, base + 1, base + 2, base + 3);
    };
    end(0, 1);
    end(n - 1, -1);
    return m;
  }

  /** A round tube along a 3D polyline (wires). */
  function tube(m, path, r, seg) {
    seg = seg || 12;
    const n = path.length;
    if (n < 2) return m;
    const T = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d) || 1;
      T.push([d[0] / L, d[1] / L, d[2] / L]);
    }
    // parallel-transported frame
    let ref = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nz = (v) => { const L = Math.hypot(...v) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
    let Nv = nz(cross(cross(T[0], ref), T[0]));
    const base = m.p.length / 3;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const dt = Nv[0] * T[i][0] + Nv[1] * T[i][1] + Nv[2] * T[i][2];
        Nv = nz([Nv[0] - dt * T[i][0], Nv[1] - dt * T[i][1], Nv[2] - dt * T[i][2]]);
      }
      const B = cross(T[i], Nv);
      for (let k = 0; k <= seg; k++) {
        const a = (2 * Math.PI * k) / seg, c = Math.cos(a), s = Math.sin(a);
        const d = [c * Nv[0] + s * B[0], c * Nv[1] + s * B[1], c * Nv[2] + s * B[2]];
        m.v(path[i][0] + r * d[0], path[i][1] + r * d[1], path[i][2] + r * d[2], ...d);
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      for (let k = 0; k < seg; k++) {
        const a = base + i * (seg + 1) + k, b = a + seg + 1;
        m.quad(a, b, b + 1, a + 1);
      }
    }
    // end caps
    for (const [i, s] of [[0, -1], [n - 1, 1]]) {
      const nn = [T[i][0] * s, T[i][1] * s, T[i][2] * s];
      const cb = m.p.length / 3;
      m.v(...path[i], ...nn);
      for (let k = 0; k <= seg; k++) {
        const q = base + i * (seg + 1) + k;
        m.v(m.p[q * 3], m.p[q * 3 + 1], m.p[q * 3 + 2], ...nn);
      }
      for (let k = 0; k < seg; k++) m.tri(cb, cb + 1 + k, cb + 2 + k);
    }
    return m;
  }

  // The part
  const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

  // The kernel: solid descriptors (compile.js solidDesc) to meshes

  /** Put a mesh's points and normals through a frame (G.frame3's layout). */
  function applyFrame(m, M) {
    if (G.isIdentity3(M)) return m;
    return m.transform(
      (x, y, z) => [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]],
      (x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z]);
  }
  const circlePts = (cx, cy, r, seg) => Array.from({ length: seg }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / seg), cy + r * Math.sin((2 * Math.PI * k) / seg)]);

  /**
   * One descriptor as a mesh: built around its `at` point, turned by `rot` about
   * it, then put through its frame M. `kx.castellations` are the notches a
   * castellated slab cuts: [{ side, at, r }] in the frame the body is drawn in.
   */
  function descMesh(d, kx) {
    const m = new Mesh('', '', { color: [0, 0, 0], metal: 0 });
    if (d.empty) return m;
    const turned = !!(d.rot && (d.rot[0] || d.rot[1] || d.rot[2]));
    const at = d.at || [0, 0, 0];
    const o = turned ? [0, 0, 0] : [at[0], at[1], at[2] || 0];
    const seg = (n) => d.segments || n;
    const rad = (a) => a * D2R;
    switch (d.op) {
      case 'box': boxC(m, o[0], o[1], o[2], d.w, d.l, d.h); break;
      case 'slab': slab(m, o, d.w, d.l, d.h, d.castellated ? (kx && kx.castellations) || [] : []); break;
      case 'cylinder': {
        const z1 = o[2] + d.h;
        if (d.from != null) shell(m, o[0], o[1], o[2], z1, d.d / 2, d.d2 / 2, rad(d.from), rad(d.to), seg(32));
        else frustum(m, o[0], o[1], o[2], z1, d.d / 2, d.d2 / 2, seg(32), d.open === 'both' ? false : d.open === 'top' ? 'bottom' : d.open === 'bottom' ? 'top' : true);
        break;
      }
      case 'sphere': {
        const n = seg(16);
        ellipsoid(m, o[0], o[1], o[2] + d.h / 2, d.d / 2, d.d / 2, d.h / 2, n, Math.max(2, Math.round(n / 2)));
        break;
      }
      case 'disc':
        if (d.from != null) ringSector(m, o[0], o[1], o[2], d.r0, d.r1, rad(d.from), rad(d.to), seg(32), !d.down);
        else if (d.r0 > 0) ring(m, o[0], o[1], o[2], d.r0, d.r1, seg(32), !d.down);
        else m.cap(circlePts(o[0], o[1], d.r1, seg(32)), o[2], !d.down);
        break;
      case 'prism': {
        const pts = G.ensureCCW(d.path.map((q) => [o[0] + q[0], o[1] + q[1]]));
        loft(m, [{ z: o[2], pts }, { z: o[2] + d.h, pts }]);
        break;
      }
      case 'face': m.cap(d.path.map((q) => [o[0] + q[0], o[1] + q[1]]), o[2], !d.down); break;
      case 'loft': loft(m, d.rings.map((r) => ({ z: o[2] + r.z, pts: rectPts(o[0], o[1], r.w, r.l) }))); break;
      case 'sweep': {
        const path = d.fillet ? fillet(d.path, d.fillet, d.step, d.keep) : d.path;
        sweepRect(m, path, d.w, d.t, (u, v, z) => [o[0] + u, o[1] + v, o[2] + z], (x, y, z) => [x, y, z]);
        break;
      }
      case 'wire': {
        const path = d.fillet ? fillet(d.path, d.fillet, d.step, d.keep) : d.path;
        tube(m, path.map((q) => [o[0] + q[0], o[1], o[2] + q[1]]), d.d / 2, seg(12));
        break;
      }
      default: break;
    }
    if (turned) applyFrame(m, G.frame3(at.map((v) => v || 0), d.rot));
    if (d.M) applyFrame(m, d.M);
    return m;
  }

  /** A board W x L x T from o.z up, with a half-hole cut into its edge at each notch. */
  function slab(m, o, w, l, t, notches) {
    const cx = o[0], cy = o[1], hw = w / 2, hl = l / 2, z0 = o[2], zt = o[2] + t;
    const bySide = { bottom: [], right: [], top: [], left: [] };
    for (const n of notches) bySide[n.side].push(n);
    const pts = [], notchEdge = [];
    const corner = { bottom: [cx - hw, cy - hl], right: [cx + hw, cy - hl], top: [cx + hw, cy + hl], left: [cx - hw, cy + hl] };
    const dirs = { bottom: [1, 0], right: [0, 1], top: [-1, 0], left: [0, -1] };
    for (const side of ['bottom', 'right', 'top', 'left']) {
      const c = corner[side], dv = dirs[side];
      pts.push(c); notchEdge.push(false);
      const along = (q) => (dv[0] !== 0 ? (q - c[0]) * dv[0] : (q - c[1]) * dv[1]);
      const list = bySide[side].slice().sort((a, b2) => along(a.at) - along(b2.at));
      const inward = [-dv[1], dv[0]];
      for (const n of list) {
        const t0 = along(n.at);
        const P0 = [c[0] + dv[0] * t0, c[1] + dv[1] * t0];
        const segs = 12;
        for (let k = 0; k <= segs; k++) {
          const a = Math.PI - (Math.PI * k) / segs;
          pts.push([P0[0] + n.r * (Math.cos(a) * dv[0] + Math.sin(a) * inward[0]), P0[1] + n.r * (Math.cos(a) * dv[1] + Math.sin(a) * inward[1])]);
          notchEdge.push(k < segs);
        }
      }
    }
    // the plain edges: a castellation's own hole is drawn by its lead
    for (let i = 0; i < pts.length; i++) {
      if (notchEdge[i]) continue;
      const a = pts[i], c = pts[(i + 1) % pts.length];
      m.face4([a[0], a[1], z0], [c[0], c[1], z0], [c[0], c[1], zt], [a[0], a[1], zt]);
    }
    m.cap(pts, z0, false);
    m.cap(pts, zt, true);
    return m;
  }

  /** Meshes by name, kind and color, in the order each first appears. */
  class Parts {
    constructor() { this.list = []; this.map = new Map(); }
    add(name, kind, mat, src, m) {
      if (!m.i.length) return null;
      const key = `${name}\u0000${kind}\u0000${mat.color.join(',')}\u0000${mat.metal}`;
      let t = this.map.get(key);
      if (!t) { t = new Mesh(name, kind, mat, src); this.map.set(key, t); this.list.push(t); }
      t.append(m);
      return t;
    }
  }
  const matOfValue = (c) => ({ color: c.rgb.slice(), metal: c.metal ? 1 : 0 });
  /** A frame as a matrix: map(u, v, z) of frame() below. */
  function frameMatrix(b, l) {
    const s = SIGN[l.side];
    if (l.side === 'left' || l.side === 'right') return [s, 0, 0, b.x, 0, 1, 0, l.y, 0, 0, 1, 0];
    return [0, 1, 0, l.x, s, 0, 0, b.y, 0, 0, 1, 0];
  }
  /** A copy of a mesh through a frame. */
  function cloneThrough(src, M, name, kind, mat, srcRanges) {
    const m = new Mesh(name, kind, mat, srcRanges);
    m.p = src.p.slice(); m.n = src.n.slice(); m.i = src.i.slice();
    return applyFrame(m, M);
  }

  // The engine: measures the part, asks the standard library (or the user's
  // features) to draw it, and builds the meshes.

  // Flags the engine works out by asking a hook, in this order: a hook that
  // declares `NAME_if` gets flag NAME when it's above zero, else the second flag.
  const DERIVED = {
    body: [['drafted', 'plain'], ['tall'], ['shield', 'unshielded'], ['vented']],
    lead: [['fine'], ['wide'], ['coarse'], ['straddle'], ['flush'], ['bent', 'cramped'], ['under', 'beyond'], ['socket']],
  };
  // what a body hook exports to the leads
  const EXPORTS = ['zp', 'housing', 'zc', 'len', 'ts'];
  const len = (v) => ({ k: 'len', v });
  const num = (v) => ({ k: 'num', v });
  const colorVal = (c) => ({ k: 'color', v: c });

  function build(res, opts) {
    opts = opts || {};
    const md = res.model || { props: {}, solids: [] };
    const out = { none: !!md.none, meshes: [], notes: [], style: null, summary: null, H: 0, standoff: 0, diagnostics: [] };
    if (md.none) return finalize(out);
    try { new Engine(res, opts, out).run(); } catch (err) {
      if (opts.strict) throw err;
      if (!err.hook) {
        out.diagnostics.push({ severity: 'error', message: `internal error while building the 3D model: ${err && err.message}`, s: 0, e: 0 });
        if (typeof console !== 'undefined') console.error(err);
      }
    }
    out.diagnostics.push(...md.hooks.take());
    if (opts.strict && out.diagnostics.some((d) => d.severity === 'error')) {
      throw new Error(`3D model: ${out.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
    }
    return finalize(out);
  }

  class Engine {
    constructor(res, opts, out) {
      this.res = res; this.opts = opts; this.out = out;
      this.md = res.model; this.hooks = res.model.hooks; this.P = res.model.props || {};
      this.memo = new Map();
    }

    /** Bind a hook, working out the derived flags it asks for. */
    bind(kind, name, values, flags, trigger, written) {
      const fl = flags.filter(Boolean);
      let B = this.hooks.bind(name, values, fl, trigger, written);
      for (const [flag, other] of DERIVED[kind]) {
        if (!B.has(`${flag}_if`)) continue;
        const v = B.test(`${flag}_if`);
        if (v != null && v > 0) fl.push(flag); else if (other) fl.push(other); else continue;
        B = this.hooks.bind(name, values, fl, trigger, written);
      }
      return B;
    }

    /** A hook's solids as meshes in its own frame: [{ name, kind, mat, mesh }]. */
    meshesOf(B, defaults, kx) {
      const parts = new Parts();
      for (const d of B.solids(null)) {
        const kind = d.kind || defaults.kind;
        const name = d.name || defaults.name(kind);
        const mat = d.color ? matOfValue(d.color) : defaults.mat;
        parts.add(name, kind, mat, [], descMesh(d, kx));
      }
      return parts.list;
    }

    run() {
      const { res, P, out, md } = this;
      const b = res.body;
      const notes = out.notes;
      const leads = (res.leads || []).filter((l) => l.form !== 'none');
      if (md.step) notes.push(`Uses the STEP file ${md.step.file}, which the demo can't load, so this is the generated model.`);
      this.solidColor = (() => { try { return matOfValue(this.hooks.libColor('solid_color')); } catch (e) { return EPOXY; } })();
      if (!b) {
        if (md.solids && md.solids.length) notes.push('No body, so only the model block\'s solids are shown.');
        else notes.push('No body. Add `body W x L x H` to generate a model.');
        this.extraSolids(null, 0);
        out.summary = md.solids && md.solids.length ? `${md.solids.length} solid${md.solids.length > 1 ? 's' : ''}` : null;
        return;
      }
      const style = res.style;
      out.style = style;
      const fam = res.family;
      const pitch = (res.generator && res.generator.pitch) || (leads.find((l) => l.pitch) || {}).pitch || null;
      const ballD = (() => { const l = leads.find((x) => x.form === 'ball'); return l ? (l.v != null ? l.v : l.d != null ? l.d : (l.padAcross || 0.5) / 0.8) : 0.5; })();
      const bodySrc = b.src || [];
      const bodyTrigger = bodySrc[0] || null;
      const shape = P.bodyShape || null;
      const bodyHook = shape ? shape.call.name : `body_${style}`;

      // what the body is drawn from
      const V = { W: len(b.w), L: len(b.l), ball_d: len(ballD) };
      if (P.draft != null) V.taper = num(P.draft);
      if (P.bodyColor) V.body_color = colorVal(P.bodyColor);
      if (P.leadsColor) V.lead_color = colorVal(P.leadsColor);
      if (pitch != null) V.e = len(pitch);
      if (P.above != null) V.rise = len(P.above);
      let castD = 0;
      for (const l of leads) if (l.form === 'castellated' && l.side) castD = Math.max(castD, l.castellated || l.d || l.v || 0.6);
      V.cast_d = len(castD);
      const turnOf = (ax) => (ax === 'y' ? 90 : 0);
      if (style === 'chip') {
        V.turn = num(turnOf(chipAxis({ res, b })));
        const L0 = res.lead || leads.find((l) => l.form === 'endcap');
        const T = L0 ? (L0.l != null ? L0.l : L0.v != null ? L0.v : L0.d) : null;
        if (T != null) V.T = len(T);
      } else if (style === 'melf' || style === 'axial') {
        V.turn = num(turnOf(b.axial || 'x'));
        if (style === 'melf' && res.lead && res.lead.v != null) V.T = len(res.lead.v);
      }
      const baseFlags = [style, res.mainForm, fam];
      const p1 = res.pin1;
      if (p1 && (p1.style === 'dot' || p1.style === 'chamfer')) baseFlags.push('silk_mark');

      // the standoff and height
      let B0 = this.hooks.bind(bodyHook, V, baseFlags, bodyTrigger, shape);
      let H = P.height != null ? P.height : b.h;
      let z0 = P.standoff != null ? P.standoff : (B0.has('z0') ? B0.len('z0') : 0);
      if (H == null) {
        notes.push('The body has no height, so it\'s drawn as a thin plate. Add one: `body W x L x H`.');
        H = z0 + 0.1;
      }
      if (z0 >= H - 0.02) {
        if (P.standoff != null) notes.push(`The standoff (${fmt(z0)}) reaches the body top (${fmt(H)}), so it was lowered.`);
        z0 = Math.max(0, Math.min(z0, H * 0.5));
      }
      out.H = H; out.standoff = z0;
      V.H = len(H); V.z0 = len(z0);
      B0 = this.hooks.bind(bodyHook, V, baseFlags, bodyTrigger, shape);

      // the mark: from the model block, the polarity, or pin 1's silk
      let mark = P.pin1 || null;
      if (!mark) {
        if (res.polarized) mark = 'stripe';
        else if (!p1 || (p1.explicit && p1.style === 'none')) mark = 'none';
        else if (p1.style === 'notch') mark = 'notch';
        else if (p1.style === 'bar') mark = 'stripe';
        else mark = B0.has('pin1_mark') ? B0.str('pin1_mark') : 'none';
      }
      const flags = baseFlags.slice();
      const bodyColor = P.bodyColor || (B0.has('body_color') ? B0.color('body_color') : null);
      flags.push(bodyColor && bodyColor.metal ? 'bare' : 'sleeved');
      // where the marks point
      const top = { cx: b.x, cy: b.y };
      if (p1) {
        V.sx = num(Math.sign(Math.round((p1.x - top.cx) * 1e6)));
        V.sy = num(Math.sign(Math.round((p1.y - top.cy) * 1e6)));
        const g = res.generator;
        const rowsLR = g && (g.kind === 'dual' || leads.some((l) => l.side === 'left' || l.side === 'right'));
        if (rowsLR) { V.nx = num(0); V.ny = num(V.sy.v || 1); } else { V.nx = num(V.sx.v || -1); V.ny = num(0); }
      }
      if (mark === 'stripe') {
        const to = this.stripeEnd();
        if (to) {
          const dx = to[0] - b.x, dy = to[1] - b.y;
          const ax = style === 'chip' ? chipAxis({ res, b }) : (style === 'melf' || style === 'axial') ? (b.axial || 'x') : (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y');
          const sgn = (ax === 'x' ? dx : dy) < 0 ? -1 : 1;
          V.ex = num(ax === 'x' ? sgn : 0); V.ey = num(ax === 'y' ? sgn : 0);
          V.ma = num(Math.atan2(dy, dx) / D2R);
        } else mark = 'none';
      }
      if (mark !== 'none') flags.push(mark);
      const B = this.bind('body', bodyHook, V, flags, bodyTrigger, shape);
      if (mark !== 'none' && !B.flags.has(mark)) mark = 'none';
      const exp = {};
      for (const k of EXPORTS) if (B.has(k)) exp[k] = B.len(k);
      const bodyTop = B.has('top_z') ? B.len('top_z') : H;
      this.bodyColor = B.has('body_color') ? matOfValue(B.color('body_color')) : (bodyColor ? matOfValue(bodyColor) : this.solidColor);
      const leadColor = P.leadsColor ? matOfValue(P.leadsColor) : (B.has('lead_color') ? matOfValue(B.color('lead_color')) : TIN);
      const markSrc = (md.src || []).concat(this.markNodes());

      // the body's meshes; its marks go after the leads
      const castellations = [];
      for (const l of leads) {
        if (l.form !== 'castellated' || !l.side) continue;
        const lr = l.side === 'left' || l.side === 'right';
        castellations.push({ side: l.side, at: (lr ? l.y - b.y : l.x - b.x), r: (l.castellated || l.d || l.v || 0.6) / 2 });
      }
      const leadSrc = res.lead ? res.lead.src : [];
      const marks = [];
      const bodyParts = this.meshesOf(B, {
        kind: 'body', mat: this.bodyColor,
        name: (k) => (k === 'lead' ? 'lead' : k === 'mark' ? 'mark' : 'body'),
      }, { castellations });
      for (const p of bodyParts) {
        const m = cloneThrough(p, [1, 0, 0, b.x, 0, 1, 0, b.y, 0, 0, 1, 0], p.name, p.kind, { color: p.color, metal: p.metal },
          p.kind === 'body' ? bodySrc : p.kind === 'lead' ? leadSrc : markSrc);
        if (p.kind === 'mark') marks.push(m); else out.meshes.push(m);
      }

      // leads
      let nLeads = 0;
      const leadShape = P.leadsShape || null;
      for (const l of leads) {
        const hook = leadShape ? leadShape.call.name : leadHookOf(style, l);
        if (!hook) continue;
        const sided = !!l.side && SIDED.has(hook) || (leadShape && !!l.side);
        const F = l.side ? frame(b, l) : null;
        const lv = {
          z0: len(z0), H: len(H),
          pad_across: l.padAcross ? len(l.padAcross) : undefined, pad_along: l.padAlong ? len(l.padAlong) : undefined,
        };
        for (const k of Object.keys(exp)) lv[k] = len(exp[k]);
        if (F) { lv.edge = len(F.uEdge); lv.pad_u = len(F.uPad); if (F.uToe != null) lv.toe = len(F.uToe); lv.side_len = len(l.side === 'left' || l.side === 'right' ? b.l : b.w); }
        const wl = hook === 'lead_tab' || hook === 'lead_contact';
        if (l.w != null) lv.b = len(l.w);
        const T = wl ? l.l : (l.l != null ? l.l : l.v);
        if (T != null) lv.T = len(T);
        const Dm = l.form === 'castellated' ? (l.castellated || l.d || l.v) : (l.form === 'ball' || l.form === 'column') ? (l.v != null ? l.v : l.d) : (l.d != null ? l.d : l.v);
        if (Dm != null) lv.D = len(Dm);
        if (l.drill) lv.drill_d = len(l.drill);
        const e = l.pitch || pitch;
        if (e != null) lv.e = len(e);
        if (P.thickness != null) lv.c = len(P.thickness);
        if (P.below != null) lv.tail = len(P.below);
        if (P.leadsColor) lv.lead_color = colorVal(P.leadsColor);
        for (const k of Object.keys(lv)) if (lv[k] === undefined) delete lv[k];
        const lf = [l.form, style];
        if (l.form === 'pin' || l.form === 'wire') lf.push(l.d != null || (l.w == null && l.v != null) ? 'round' : 'square');
        const trigger = (l.src && l.src[0]) || bodyTrigger;
        const key = `${hook}|${JSON.stringify(lv)}|${lf.join(',')}`;
        let parts = this.memo.get(key);
        if (!parts) {
          try {
            const LB = this.bind('lead', hook, lv, lf, trigger, leadShape);
            parts = this.meshesOf(LB, { kind: 'lead', mat: LB.has('lead_color') ? matOfValue(LB.color('lead_color')) : leadColor, name: () => null }, null);
          } catch (err) { if (!err.hook || this.opts.strict) throw err; parts = []; }
          this.memo.set(key, parts);
        }
        const M = sided && F ? frameMatrix(b, l) : [1, 0, 0, l.x, 0, 1, 0, l.y, 0, 0, 1, 0];
        const src = (l.src || []).concat(l.generated && res.generator ? res.generator.src || [] : []);
        let drew = false;
        for (const p of parts) {
          const m = cloneThrough(p, M, p.name ? `${p.name} ${l.pad}` : `lead ${l.pad}`, p.kind, { color: p.color, metal: p.metal }, p.kind === 'mark' ? markSrc : src);
          if (m.i.length) drew = true;
          if (p.kind === 'mark') marks.push(m); else out.meshes.push(m);
        }
        if (drew) nLeads++;
      }

      // exposed pads under the body
      for (const p of res.pads) {
        if (!p.thermal || !this.hooks.has('exposed_pad')) continue;
        const bb = p.bbox;
        const pv = { w: len(bb.x1 - bb.x0), l: len(bb.y1 - bb.y0), z0: len(z0), H: len(H) };
        if (P.thickness != null) pv.c = len(P.thickness);
        if (P.leadsColor) pv.lead_color = colorVal(P.leadsColor);
        const EB = this.hooks.bind('exposed_pad', pv, [style], (p.src && p.src[0]) || bodyTrigger);
        const parts = this.meshesOf(EB, { kind: 'lead', mat: EB.has('lead_color') ? matOfValue(EB.color('lead_color')) : leadColor, name: () => `exposed pad ${p.name}` }, null);
        for (const q of parts) out.meshes.push(cloneThrough(q, [1, 0, 0, (bb.x0 + bb.x1) / 2, 0, 1, 0, (bb.y0 + bb.y1) / 2, 0, 0, 1, 0], q.name, q.kind, { color: q.color, metal: q.metal }, p.src));
      }
      out.meshes.push(...marks);

      // extra solids
      this.extraSolids(this.bodyColor, bodyTop);

      // what was built
      const formCount = {};
      for (const l of leads) formCount[l.form] = (formCount[l.form] || 0) + 1;
      const parts2 = [shape ? `body shape ${shape.call.name}` : STYLE_NAME[style]];
      const fl = Object.entries(formCount).map(([f, k]) => `${k} ${FORM_NAME[f] || f}${k > 1 ? 's' : ''}`);
      if (fl.length) parts2.push(fl.join(', '));
      if (mark !== 'none') parts2.push(mark === 'stripe' ? 'polarity stripe' : `pin-1 ${mark}`);
      if (md.solids && md.solids.length) parts2.push(`${md.solids.length} extra solid${md.solids.length > 1 ? 's' : ''}`);
      out.summary = parts2.join(' · ');
      const forms = Object.keys(formCount);
      const NOUN = { gullwing: 'gull-wings', jlead: 'J-leads', lbend: 'L-bend leads', straight: 'straight leads', column: 'columns', flat: 'terminals', endcap: 'caps', ball: 'balls', pin: 'pins', wire: 'wires', castellated: 'castellations', tab: 'tabs' };
      const nAll = leads.length;
      out.short = [STYLE_SHORT[style], nAll ? `${nAll} ${forms.length === 1 ? (nAll === 1 ? NOUN[forms[0]].replace(/s$/, '') : NOUN[forms[0]]) : 'leads'}` : null].filter(Boolean).join(' · ');
      out.mark = mark;
      out.leadCount = nLeads;
    }

    /** Where a stripe goes: the pin the polarity hook names, or pin 1. */
    stripeEnd() {
      const res = this.res;
      const pinOne = res.pin1;
      let at = null;
      if (res.polarized) {
        let pin = '2';
        if (this.hooks.has('polarity')) {
          const PB = this.hooks.bind('polarity', {}, [res.style, res.family].filter(Boolean), null);
          if (PB.has('stripe_at')) pin = PB.str('stripe_at');
        }
        if (pin === '1' || (pinOne && pinOne.pad === pin)) return pinOne ? [pinOne.x, pinOne.y] : null;
        const p = res.pads.find((q) => q.name === pin) || res.pads.find((q) => pinOne && q.name !== pinOne.pad && !q.thermal);
        at = p ? [p.x, p.y] : null;
        return at;
      }
      return pinOne ? [pinOne.x, pinOne.y] : null;
    }

    /** The statements a mark comes from: pin1 and polarized. */
    markNodes() {
      const r = this.res;
      return (r.markSrc || []);
    }

    /** The model block's own solids and placed features. */
    extraSolids(bodyMat, bodyTop) {
      const md = this.md;
      for (const d of md.solids || []) {
        const mat = d.color ? matOfValue(d.color) : (bodyMat || this.solidColor);
        const m0 = descMesh(Object.assign({}, d, { M: d.place ? null : d.M }), null);
        const m = new Mesh(d.name || d.op, d.kind || 'solid', mat, d.src || []);
        m.p = m0.p; m.n = m0.n; m.i = m0.i;
        if (d.place) {
          let x0 = Infinity, y0 = Infinity, zmin = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let k = 0; k < m.p.length; k += 3) {
            x0 = Math.min(x0, m.p[k]); x1 = Math.max(x1, m.p[k]);
            y0 = Math.min(y0, m.p[k + 1]); y1 = Math.max(y1, m.p[k + 1]);
            zmin = Math.min(zmin, m.p[k + 2]);
          }
          const zBase = d.place.z != null ? d.place.z : (d.onBody ? bodyTop : 0);
          const dx = d.place.x - (x0 + x1) / 2, dy = d.place.y - (y0 + y1) / 2, dz = zBase - zmin;
          m.transform((x, y, z) => [x + dx, y + dy, z + dz], (x, y, z) => [x, y, z]);
        } else if (d.lift) m.transform((x, y, z) => [x, y, z + bodyTop], (x, y, z) => [x, y, z]);
        this.out.meshes.push(m);
      }
    }
  }

  // leads drawn in their side's frame; the others around their pad's center
  const SIDED = new Set(['lead_gullwing', 'lead_jlead', 'lead_lbend', 'lead_straight', 'lead_flat', 'lead_endcap', 'lead_tab', 'lead_castellated', 'lead_dip', 'lead_axial']);
  /** The hook that draws a lead, or null when the body draws it. */
  function leadHookOf(style, l) {
    const f = l.form;
    if (f === 'endcap' && (style === 'chip' || style === 'melf')) return null;   // the body draws its caps
    if (f === 'castellated') return l.side ? 'lead_castellated' : null;
    if (f === 'pin' || f === 'wire') {
      if (style === 'dip' && l.side) return 'lead_dip';
      if (style === 'axial') return 'lead_axial';
      if (style === 'header') return 'lead_header';
      return 'lead_tht';
    }
    if (f === 'ball' || f === 'column' || f === 'tab') return `lead_${f}`;
    if (!l.side) return 'lead_contact';
    return `lead_${f}`;
  }


  const STYLE_NAME = {
    molded: 'molded body', sawn: 'sawn (leadless) body', chip: 'chip body', melf: 'MELF body', bga: 'BGA substrate and mold cap', cga: 'ceramic body on solder columns',
    dip: 'molded DIP body', header: 'housing', can: 'can', radial: 'radial body', axial: 'axial body', module: 'module board', block: 'plain block',
  };
  const STYLE_SHORT = {
    molded: 'molded', sawn: 'leadless', chip: 'chip', melf: 'MELF', bga: 'BGA', cga: 'CGA', dip: 'DIP', header: 'header',
    can: 'can', radial: 'radial', axial: 'axial', module: 'module', block: 'block',
  };
  const FORM_NAME = {
    gullwing: 'gull-wing', jlead: 'J-lead', lbend: 'L-bend lead', straight: 'straight lead', column: 'column', flat: 'flat terminal', endcap: 'end cap', ball: 'ball', pin: 'pin',
    wire: 'wire', tab: 'tab', castellated: 'castellation',
  };

  // Leads
  const SIGN = { left: -1, right: 1, bottom: -1, top: 1 };
  /** The axis a chip lies along: its pins' sides, or its longer side. */
  function chipAxis(ctx) {
    const ls = ctx.res.leads || [];
    const sides = new Set(ls.map((l) => l.side));
    if (sides.has('left') || sides.has('right')) return 'x';
    if (sides.has('top') || sides.has('bottom')) return 'y';
    return ctx.b.w >= ctx.b.l ? 'x' : 'y';
  }
  /** A frame on the lead's side: u outward from the body center, v along the side. */
  function frame(b, l) {
    const s = SIGN[l.side];
    if (l.side === 'left' || l.side === 'right') {
      const ox = b.x, oy = l.y;
      return {
        uEdge: b.w / 2, uPad: (l.x - b.x) * s, uToe: l.toe != null ? (l.toe - b.x) * s : null,
        map: (u, v, z) => [ox + s * u, oy + v, z], mapN: (nu, nv, nz) => [s * nu, nv, nz],
      };
    }
    const ox = l.x, oy = b.y;
    return {
      uEdge: b.l / 2, uPad: (l.y - b.y) * s, uToe: l.toe != null ? (l.toe - b.y) * s : null,
      map: (u, v, z) => [ox + v, oy + s * u, z], mapN: (nu, nv, nz) => [nv, s * nu, nz],
    };
  }

  // Finishing
  function finalize(out) {
    const bb = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    let tris = 0, top = -Infinity;
    out.meshes = out.meshes.filter((m) => m.i.length).map((m) => {
      const f = m.finish();
      for (let k = 0; k < f.pos.length; k += 3) {
        const x = f.pos[k], y = f.pos[k + 1], z = f.pos[k + 2];
        if (x < bb.x0) bb.x0 = x; if (x > bb.x1) bb.x1 = x;
        if (y < bb.y0) bb.y0 = y; if (y > bb.y1) bb.y1 = y;
        if (z < bb.z0) bb.z0 = z; if (z > bb.z1) bb.z1 = z;
        if (f.kind !== 'mark' && z > top) top = z;
      }
      tris += f.idx.length / 3;
      return f;
    });
    out.bbox = Number.isFinite(bb.x0) ? bb : null;
    out.top = Number.isFinite(top) ? Math.round(top * 1e6) / 1e6 : null;   // the part's highest point (marks aside)
    out.triangles = tris;
    return out;
  }

  // The board (viewer only)
  const BOARD_T = 1.6, CU = 0.035;
  function board(res, model) {
    const meshes = [], lines = [];
    let bb = G.emptyBox();
    for (const p of res.pads) bb = G.unionBox(bb, p.bbox);
    for (const h of res.holes) bb = G.unionBox(bb, h.bbox);
    if (res.courtyardBox) bb = G.unionBox(bb, res.courtyardBox);
    if (res.body) bb = G.unionBox(bb, { x0: res.body.x - res.body.w / 2, x1: res.body.x + res.body.w / 2, y0: res.body.y - res.body.l / 2, y1: res.body.y + res.body.l / 2 });
    if (model && model.bbox) bb = G.unionBox(bb, { x0: model.bbox.x0, y0: model.bbox.y0, x1: model.bbox.x1, y1: model.bbox.y1 });
    if (!G.boxValid(bb)) bb = { x0: -2, y0: -2, x1: 2, y1: 2 };
    const span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
    const mg = clamp(0.25 * span, 1, 6);
    const X0 = bb.x0 - mg, X1 = bb.x1 + mg, Y0 = bb.y0 - mg, Y1 = bb.y1 + mg;
    const slab = new Mesh('board', 'board', { color: hex('#1d5a39'), metal: 0 }, []);
    slab.face4([X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0]);
    slab.face4([X0, Y0, -BOARD_T], [X0, Y1, -BOARD_T], [X1, Y1, -BOARD_T], [X1, Y0, -BOARD_T]);
    meshes.push(slab);
    const edge = new Mesh('board edge', 'board', { color: hex('#bfae78'), metal: 0 }, []);
    const E = (a, b) => edge.face4([a[0], a[1], -BOARD_T], [b[0], b[1], -BOARD_T], [b[0], b[1], 0], [a[0], a[1], 0]);
    E([X0, Y0], [X1, Y0]); E([X1, Y0], [X1, Y1]); E([X1, Y1], [X0, Y1]); E([X0, Y1], [X0, Y0]);
    meshes.push(edge);
    const cu = new Mesh('copper', 'copper', { color: hex('#d3a64c'), metal: 1 }, []);
    const hole = new Mesh('holes', 'hole', { color: hex('#0c0d0d'), metal: 0 }, []);
    const barrel = new Mesh('plating', 'copper', { color: hex('#b97a46'), metal: 1 }, []);
    const prism = (m, pts, za, zb) => {
      const P = G.ensureCCW(pts);
      m.cap(P, za, false); m.cap(P, zb, true);
      for (let i = 0; i < P.length; i++) {
        const a = P[i], c = P[(i + 1) % P.length];
        m.face4([a[0], a[1], za], [c[0], c[1], za], [c[0], c[1], zb], [a[0], a[1], zb]);
      }
    };
    const poly = (contour) => G.dedupe(G.contourToPoly(contour, 12 * D2R), true);
    for (const p of res.pads) {
      if (!p.copper) continue;
      const pts = poly(p.copper);
      if (pts.length < 3) continue;
      prism(cu, pts, 0, CU);
      if (p.tht) prism(cu, pts, -BOARD_T - CU, -BOARD_T);
      if (p.drillShape) {
        const dp = G.ensureCCW(poly(p.drillShape));
        if (dp.length >= 3) {
          hole.cap(dp, CU + 0.001, true);
          hole.cap(dp, -BOARD_T - CU - 0.001, false);
          for (let i = 0; i < dp.length; i++) {
            const a = dp[i], c = dp[(i + 1) % dp.length];
            barrel.face4([c[0], c[1], -BOARD_T - CU], [a[0], a[1], -BOARD_T - CU], [a[0], a[1], CU], [c[0], c[1], CU]);
          }
        }
      }
      for (const v of p.vias || []) {
        ring(hole, v.x, v.y, CU + 0.001, 0, v.d / 2, 16, true);
      }
    }
    for (const h of res.holes) {
      const dp = G.ensureCCW(poly(h.land));
      if (dp.length < 3) continue;
      hole.cap(dp, 0.001, true);
      hole.cap(dp, -BOARD_T - 0.001, false);
      for (let i = 0; i < dp.length; i++) {
        const a = dp[i], c = dp[(i + 1) % dp.length];
        edge.face4([c[0], c[1], -BOARD_T], [a[0], a[1], -BOARD_T], [a[0], a[1], 0], [c[0], c[1], 0]);
      }
    }
    meshes.push(cu, barrel, hole);
    // silk
    const silk = new Mesh('silk', 'silk', { color: hex('#eeeee8'), metal: 0 }, []);
    const zs = 0.012;
    const seg = (a, c, w) => {
      const dx = c[0] - a[0], dy = c[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-9) return;
      const nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2;
      silk.face4([a[0] + nx, a[1] + ny, zs], [a[0] - nx, a[1] - ny, zs], [c[0] - nx, c[1] - ny, zs], [c[0] + nx, c[1] + ny, zs]);
    };
    const dot = (c, r) => ring(silk, c[0], c[1], zs, 0, r, 12, true);
    for (const it of res.silk || []) {
      if (it.type === 'line') {
        for (let i = 0; i + 1 < it.pts.length; i++) seg(it.pts[i], it.pts[i + 1], it.w);
        for (const q of it.pts) dot(q, it.w / 2);
      } else if (it.type === 'circle') {
        if (it.fill) dot(it.c, it.r);
        else ring(silk, it.c[0], it.c[1], zs, it.r - it.w / 2, it.r + it.w / 2, 32, true);
      } else if (it.type === 'poly') {
        silk.cap(G.ensureCCW(it.pts), zs, true);
      }
    }
    meshes.push(silk);
    for (const it of res.courtyard || []) {
      if (it.type === 'line') for (let i = 0; i + 1 < it.pts.length; i++) lines.push([it.pts[i][0], it.pts[i][1], 0.02, it.pts[i + 1][0], it.pts[i + 1][1], 0.02]);
      else if (it.type === 'circle') {
        const n = 48;
        for (let k = 0; k < n; k++) {
          const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n;
          lines.push([it.c[0] + it.r * Math.cos(a0), it.c[1] + it.r * Math.sin(a0), 0.02, it.c[0] + it.r * Math.cos(a1), it.c[1] + it.r * Math.sin(a1), 0.02]);
        }
      }
    }
    const out = finalize({ meshes, notes: [] });
    out.lines = lines;
    out.extent = { x0: X0, y0: Y0, x1: X1, y1: Y1, z0: -BOARD_T - CU, z1: CU };
    out.core = { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, z0: 0, z1: CU };   // what a view frames
    return out;
  }

  // Export
  /**
   * VRML 2.0 for KiCad, where 1 unit is 0.1 inch (2.54 mm). Vertices are merged and
   * KiCad works out normals from creaseAngle. A part that repeats (balls, terminals,
   * identical leads) is written once and placed again with USE, each copy in its own
   * Transform. Materials are shared the same way.
   */
  function toVRML(model, name) {
    const S = 1 / 2.54;
    const num = (v) => { const r = Math.round(v * S * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };
    const out = ['#VRML V2.0 utf8', `# ${name || 'stomp model'}, generated by stomp live. Units: 0.1 inch.`];
    const mats = new Map(), shapes = new Map();
    let nMat = 0, nShape = 0;
    for (const m of model.meshes) {
      // merge coincident vertices, drop triangles that collapse
      const key = new Map(), pts = [], remap = new Int32Array(m.pos.length / 3);
      for (let v = 0; v < m.pos.length / 3; v++) {
        const k = `${Math.round(m.pos[v * 3] * 1e5)},${Math.round(m.pos[v * 3 + 1] * 1e5)},${Math.round(m.pos[v * 3 + 2] * 1e5)}`;
        let j = key.get(k);
        if (j == null) { j = pts.length; key.set(k, j); pts.push([m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]); }
        remap[v] = j;
      }
      const tris = [];
      for (let t = 0; t < m.idx.length; t += 3) {
        const a = remap[m.idx[t]], b = remap[m.idx[t + 1]], c = remap[m.idx[t + 2]];
        if (a !== b && b !== c && a !== c) tris.push(a, b, c);
      }
      if (!tris.length) continue;
      // the shape relative to its first vertex, so a translated copy is the same shape
      const o = pts[0];
      const local = pts.map((q) => [q[0] - o[0], q[1] - o[1], q[2] - o[2]]);
      const mk = `${m.color.map((c) => c.toFixed(4)).join(' ')}|${m.metal}`;
      const sk = `${mk}|${local.map((q) => q.map((v) => Math.round(v * 1e5)).join(',')).join(' ')}|${tris.join(',')}`;
      const at = `translation ${num(o[0])} ${num(o[1])} ${num(o[2])}`;
      if (shapes.has(sk)) { out.push(`Transform { ${at} children [ USE ${shapes.get(sk)} ] }`); continue; }
      const sid = `S${nShape++}`;
      shapes.set(sk, sid);
      let mat;
      if (mats.has(mk)) mat = `material USE ${mats.get(mk)}`;
      else {
        const mid = `M${nMat++}`;
        mats.set(mk, mid);
        const [r, g, b] = m.color.map((c) => (Math.round(c * 1e4) / 1e4).toString());
        mat = `material DEF ${mid} Material { diffuseColor ${r} ${g} ${b} specularColor ${m.metal ? '0.6 0.6 0.6' : '0.12 0.12 0.12'} shininess ${m.metal ? 0.6 : 0.15} }`;
      }
      const P = local.map((q) => `${num(q[0])} ${num(q[1])} ${num(q[2])}`).join(',');
      const I = [];
      for (let t = 0; t < tris.length; t += 3) I.push(`${tris[t]},${tris[t + 1]},${tris[t + 2]},-1`);
      out.push(`Transform { ${at} children [ DEF ${sid} Shape { # ${m.name}`,
        `  appearance Appearance { ${mat} }`,
        `  geometry IndexedFaceSet { solid FALSE creaseAngle 0.5 coord Coordinate { point [ ${P} ] }`,
        `    coordIndex [ ${I.join(' ')} ] } } ] }`);
    }
    out.push('');
    return out.join('\n');
  }

  /** Binary STL, millimetres. */
  function toSTL(model, name) {
    let n = 0;
    for (const m of model.meshes) n += m.idx.length / 3;
    const buf = new ArrayBuffer(84 + 50 * n);
    const dv = new DataView(buf);
    const head = `stomp live: ${name || 'model'}`.slice(0, 79);
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 127);
    dv.setUint32(80, n, true);
    let o = 84;
    for (const m of model.meshes) {
      const P = m.pos, I = m.idx;
      for (let k = 0; k < I.length; k += 3) {
        const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
        const nn = normal3([P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]]);
        for (const v of nn) { dv.setFloat32(o, v, true); o += 4; }
        for (const q of [a, b, c]) for (let j = 0; j < 3; j++) { dv.setFloat32(o, P[q + j], true); o += 4; }
        dv.setUint16(o, 0, true); o += 2;
      }
    }
    return new Uint8Array(buf);
  }

  /** A .zip of stored (uncompressed) files. Takes [{ name, data: Uint8Array }], returns a Uint8Array. */
  let CRC = null;
  function crc32(u8) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function toZip(files, when) {
    const d = when || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const enc = (t) => new TextEncoder().encode(t);
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc(f.name), data = f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    let cdSize = 0;
    for (const x of central) cdSize += x.length;
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(off + cdSize + 22);
    let k = 0;
    for (const x of all) { out.set(x, k); k += x.length; }
    return out;
  }

  return {
    build, board, toVRML, toSTL, toZip, BOARD_T, _prims: { fillet, triangulate: G.triangulate },
  };
});
