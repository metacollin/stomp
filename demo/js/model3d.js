/* stomp live demo: 3D models (SPEC 13).
 *
 * build(res) turns a compiled footprint into meshes: a body chosen by the lead
 * form, a lead per pin, the pin-1 mark, exposed pads and any extra solids.
 * board(res) builds the board under it for the viewer. toVRML and toSTL export
 * the part, not the board.
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
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const MAT = {
    molded: { color: hex('#26272b'), metal: 0 },
    tin: { color: hex('#c6cad0'), metal: 1 },
    gold: { color: hex('#d6af57'), metal: 1 },
    solder: { color: hex('#c9ccd1'), metal: 1 },
    aluminum: { color: hex('#cdd0d4'), metal: 1 },
    ceramic: { color: hex('#ece9df'), metal: 0 },
    resistorTop: { color: hex('#18191b'), metal: 0 },
    mlcc: { color: hex('#bf9a6c'), metal: 0 },
    inductor: { color: hex('#4d5055'), metal: 0 },
    ledBody: { color: hex('#f1efe7'), metal: 0 },
    ledLens: { color: hex('#f1e4a2'), metal: 0 },
    ledMark: { color: hex('#2f8a52'), metal: 0 },
    substrate: { color: hex('#46512f'), metal: 0 },
    module: { color: hex('#23436a'), metal: 0 },
    can: { color: hex('#2b3a52'), metal: 0 },
    rubber: { color: hex('#2a2b2d'), metal: 0 },
    stripe: { color: hex('#d9dcdf'), metal: 0 },
    band: { color: hex('#c8ccd1'), metal: 0 },
    dot: { color: hex('#8e9197'), metal: 0 },
    vent: { color: hex('#7d8186'), metal: 1 },
    axialR: { color: hex('#d8c29c'), metal: 0 },
    axialD: { color: hex('#232427'), metal: 0 },
    axialC: { color: hex('#2f63a8'), metal: 0 },
    axialL: { color: hex('#3d6e43'), metal: 0 },
    melfR: { color: hex('#5f8fb5'), metal: 0 },
    melfD: { color: hex('#c4552f'), metal: 0 },
    glassBand: { color: hex('#141517'), metal: 0 },
  };
  const matOf = (c) => ({ color: hex(c.hex), metal: c.metal ? 1 : 0 });

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
      this.p.push(...o.p); this.n.push(...o.n);
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

  /** Part of a cylinder wall, from angle a0 to a1 (radians): a stripe on a can. */
  function shell(m, cx, cy, z0, z1, r, a0, a1, seg) {
    const base = m.p.length / 3;
    for (let k = 0; k <= seg; k++) {
      const a = a0 + ((a1 - a0) * k) / seg, c = Math.cos(a), s = Math.sin(a);
      m.v(cx + r * c, cy + r * s, z0, c, s, 0);
      m.v(cx + r * c, cy + r * s, z1, c, s, 0);
    }
    for (let k = 0; k < seg; k++) { const a = base + 2 * k; m.quad(a, a + 2, a + 3, a + 1); }
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

  /** Round a polyline's corners with arcs of radius r (limited by the segments). */
  function fillet(pts, r, stepDeg) {
    const step = (stepDeg || 10) * D2R;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
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

  /** A solid lying along x or y: build it along z and turn it over. */
  function lay(m, axis, cx, cy, cz) {
    // local: built around (0, 0) with its axis along z, from z = -len/2 to len/2
    if (axis === 'x') m.transform((x, y, z) => [cx + z, cy + y, cz - x], (x, y, z) => [z, y, -x]);
    else m.transform((x, y, z) => [cx + x, cy + z, cz - y], (x, y, z) => [x, z, -y]);
    return m;
  }

  // The part
  const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

  function familyOf(res) {
    const r = ((res.meta && res.meta.refdes) || '').toUpperCase();
    if (/^LED/.test(r)) return 'D';
    if (/^FB/.test(r)) return 'L';
    return r.charAt(0);
  }

  function styleOf(res, form) {
    const b = res.body;
    switch (form) {
      case 'gullwing': case 'jlead': return 'molded';
      case 'flat': case 'tab': return b.kind === 'cyl' ? 'can' : 'sawn';
      case 'endcap': return b.axial ? 'melf' : 'chip';
      case 'ball': return 'bga';
      case 'pin': return res.generator && res.generator.kind === 'dual' ? 'dip' : 'header';
      case 'wire': return b.axial ? 'axial' : (b.kind === 'cyl' ? 'can' : 'radial');
      case 'castellated': return 'module';
      default: return b.kind === 'cyl' ? 'can' : 'block';
    }
  }

  const STYLE_NAME = {
    molded: 'molded body', sawn: 'sawn (leadless) body', chip: 'chip body', melf: 'MELF body', bga: 'BGA substrate and mold cap',
    dip: 'molded DIP body', header: 'housing', can: 'can', radial: 'radial body', axial: 'axial body', module: 'module board', block: 'plain block',
  };
  const STYLE_SHORT = {
    molded: 'molded', sawn: 'leadless', chip: 'chip', melf: 'MELF', bga: 'BGA', dip: 'DIP', header: 'header',
    can: 'can', radial: 'radial', axial: 'axial', module: 'module', block: 'block',
  };
  const FORM_NAME = {
    gullwing: 'gull-wing', jlead: 'J-lead', flat: 'flat terminal', endcap: 'end cap', ball: 'ball', pin: 'pin',
    wire: 'wire', tab: 'tab', castellated: 'castellation',
  };

  function build(res, opts) {
    opts = opts || {};
    const md = res.model || { props: {}, solids: [] };
    const meshes = [];
    const notes = [];
    const out = { none: !!md.none, meshes, notes, style: null, summary: null, H: 0, standoff: 0 };
    if (md.none) return finalize(out);
    const P = md.props || {};
    const b = res.body;
    const leads = (res.leads || []).filter((l) => l.form !== 'none');
    const mainForm = res.lead ? res.lead.form : ((leads.find((l) => l.form !== 'tab') || leads[0] || {}).form || null);
    const fam = familyOf(res);

    if (md.step) notes.push(`Uses the STEP file ${md.step.file}, which the demo can't load, so this is the generated model.`);
    if (!b) {
      if (md.solids && md.solids.length) notes.push('No body, so only the model block\'s solids are shown.');
      else notes.push('No body. Add `body W x L x H` to generate a model.');
      const bodyTop = 0;
      for (const s of md.solids || []) meshes.push(solidMesh(s, null, bodyTop));
      out.summary = md.solids && md.solids.length ? `${md.solids.length} solid${md.solids.length > 1 ? 's' : ''}` : null;
      return finalize(out);
    }

    const style = styleOf(res, mainForm);
    out.style = style;
    const pitch = (res.generator && res.generator.pitch) || (leads.find((l) => l.pitch) || {}).pitch || null;
    const ballD = (() => { const l = leads.find((x) => x.form === 'ball'); return l ? (l.v != null ? l.v : l.d != null ? l.d : (l.padAcross || 0.5) / 0.8) : 0.5; })();
    const STANDOFF = { molded: mainForm === 'jlead' ? 0.5 : 0.1, sawn: 0.02, chip: 0, melf: 0, bga: 0.75 * ballD, dip: 0.5, header: 0, can: 0.5, radial: 0.5, axial: 0, module: 0, block: 0 };
    let H = P.height != null ? P.height : b.h;
    let z0 = P.standoff != null ? P.standoff : STANDOFF[style];
    if (H == null) {
      notes.push('The body has no height, so it\'s drawn as a thin plate. Add one: `body W x L x H`.');
      H = z0 + 0.1;
    }
    if (z0 >= H - 0.02) {
      if (P.standoff != null) notes.push(`The standoff (${fmt(z0)}) reaches the body top (${fmt(H)}), so it was lowered.`);
      z0 = Math.max(0, Math.min(z0, H * 0.5));
    }
    out.H = H; out.standoff = z0;
    const draft = P.draft != null ? P.draft : (style === 'molded' || style === 'dip' ? 8 : 0);
    const bodySrc = b.src || [];
    const bodyMat = P.bodyColor ? matOf(P.bodyColor) : defaultBodyMat(style, fam);
    const leadMat = P.leadsColor ? matOf(P.leadsColor) : (style === 'header' ? MAT.gold : MAT.tin);
    const thick = (form, l) => {
      if (P.thickness != null) return P.thickness;
      const p = (l && l.pitch) || pitch;
      if (form === 'flat') return Math.min(0.2, 0.3 * (H - 0) || 0.2);
      if (form === 'tab') return Math.min(0.5, 0.25 * H);
      if (form === 'jlead') return p != null && p >= 1.27 - 1e-9 ? 0.25 : 0.2;
      return p == null ? 0.2 : p < 1 - 1e-9 ? 0.15 : p < 2 - 1e-9 ? 0.2 : 0.3;
    };
    const below = P.below != null ? P.below : 3;
    const zp = style === 'dip' ? z0 + 0.4 * (H - z0) : z0 + 0.5 * (H - z0);   // parting line / lead exit
    const ctx = { res, b, H, z0, zp, draft, bodyMat, leadMat, style, fam, thick, below, pitch, notes };

    // body
    const bodyInfo = buildBody(ctx, meshes, bodySrc);
    ctx.top = bodyInfo.top;           // the top face for marks: { cx, cy, w, l, z }
    ctx.bodyTop = bodyInfo.z1 != null ? bodyInfo.z1 : H;

    // leads
    let nLeads = 0;
    const leadMeshes = new Map();
    for (const l of leads) {
      const m = new Mesh(`lead ${l.pad}`, 'lead', leadMat, (l.src || []).concat(l.generated && res.generator ? res.generator.src || [] : []));
      try { if (buildLead(ctx, l, m)) { meshes.push(m); leadMeshes.set(l.pad, m); nLeads++; } } catch (e) { if (opts.strict) throw e; }
    }
    // exposed pads under the body
    if (style === 'sawn' || style === 'molded' || style === 'block') {
      for (const p of res.pads) {
        if (!p.thermal) continue;
        const bb = p.bbox;
        const m = new Mesh(`exposed pad ${p.name}`, 'lead', leadMat, p.src);
        const t = style === 'sawn' ? thick('flat') : Math.max(0.05, z0 + 0.04);
        box(m, bb.x0, bb.y0, 0, bb.x1, bb.y1, t);
        meshes.push(m);
      }
    }
    // pin-1 mark or polarity stripe
    const mark = markOf(ctx, P);
    if (mark !== 'none') buildMark(ctx, mark, meshes, leadMeshes);

    // extra solids
    for (const s of md.solids || []) meshes.push(solidMesh(s, bodyMat, ctx.bodyTop));

    const formCount = {};
    for (const l of leads) formCount[l.form] = (formCount[l.form] || 0) + 1;
    const parts = [STYLE_NAME[style]];
    const fl = Object.entries(formCount).map(([f, k]) => `${k} ${FORM_NAME[f] || f}${k > 1 ? (f === 'ball' ? 's' : f === 'flat' ? 's' : 's') : ''}`);
    if (fl.length) parts.push(fl.join(', '));
    if (mark !== 'none') parts.push(mark === 'stripe' ? 'polarity stripe' : `pin-1 ${mark}`);
    if (md.solids && md.solids.length) parts.push(`${md.solids.length} extra solid${md.solids.length > 1 ? 's' : ''}`);
    out.summary = parts.join(' · ');
    const forms = Object.keys(formCount);
    const NOUN = { gullwing: 'gull-wings', jlead: 'J-leads', flat: 'terminals', endcap: 'caps', ball: 'balls', pin: 'pins', wire: 'wires', castellated: 'castellations', tab: 'tabs' };
    const nAll = leads.length;
    out.short = [STYLE_SHORT[style], nAll ? `${nAll} ${forms.length === 1 ? (nAll === 1 ? NOUN[forms[0]].replace(/s$/, '') : NOUN[forms[0]]) : 'leads'}` : null].filter(Boolean).join(' · ');
    out.mark = mark;
    out.leadCount = nLeads;
    return finalize(out);
  }

  function defaultBodyMat(style, fam) {
    switch (style) {
      case 'chip': return fam === 'C' ? MAT.mlcc : fam === 'L' ? MAT.inductor : fam === 'D' ? MAT.ledBody : MAT.ceramic;
      case 'melf': return fam === 'R' ? MAT.melfR : fam === 'D' ? MAT.melfD : fam === 'C' ? MAT.mlcc : MAT.inductor;
      case 'axial': return fam === 'R' ? MAT.axialR : fam === 'D' ? MAT.axialD : fam === 'C' ? MAT.axialC : fam === 'L' ? MAT.axialL : MAT.axialR;
      case 'can': return MAT.can;
      case 'module': return MAT.module;
      case 'bga': return MAT.molded;
      default: return MAT.molded;
    }
  }

  // Bodies
  function buildBody(ctx, meshes, src) {
    const { b, H, z0, zp, draft, bodyMat, style, fam } = ctx;
    const m = new Mesh('body', 'body', bodyMat, src);
    meshes.push(m);
    const cx = b.x, cy = b.y, w = b.w, l = b.l;
    const tanD = Math.tan(draft * D2R);
    const top = { cx, cy, w, l, z: H };
    if (style === 'molded' || style === 'dip' || (style === 'block' && draft > 0) || (style === 'radial' && draft > 0)) {
      const band = Math.min(0.05, (H - z0) * 0.08);
      const zA = Math.max(z0, zp - band), zB = Math.min(H, zp + band);
      const inB = Math.min(tanD * (zA - z0), 0.3 * Math.min(w, l));
      const inT = Math.min(tanD * (H - zB), 0.3 * Math.min(w, l));
      loft(m, [
        { z: z0, pts: rectPts(cx, cy, w - 2 * inB, l - 2 * inB) },
        { z: zA, pts: rectPts(cx, cy, w, l) },
        { z: zB, pts: rectPts(cx, cy, w, l) },
        { z: H, pts: rectPts(cx, cy, w - 2 * inT, l - 2 * inT) },
      ]);
      top.w = w - 2 * inT; top.l = l - 2 * inT;
      return { top, z1: H };
    }
    if (style === 'sawn' || style === 'block' || style === 'header' || style === 'radial') {
      let zTop = H;
      if (style === 'header') zTop = ctx.housing = headerHousing(ctx);
      boxC(m, cx, cy, z0, w, l, zTop - z0);
      top.z = zTop;
      return { top, z1: zTop };
    }
    if (style === 'chip') {
      const ax = chipAxis(ctx);
      const len = ax === 'x' ? w : l, across = ax === 'x' ? l : w;
      const T = chipCap(ctx, len);
      const e = 0.012;
      const inner = len - 2 * e;
      const crossW = across - 2 * e;
      if (ax === 'x') box(m, cx - inner / 2, cy - crossW / 2, e, cx + inner / 2, cy + crossW / 2, H - e);
      else box(m, cx - crossW / 2, cy - inner / 2, e, cx + crossW / 2, cy + inner / 2, H - e);
      // caps
      const cm = new Mesh('end caps', 'lead', ctx.leadMat, ctx.res.lead ? ctx.res.lead.src : []);
      for (const s of [-1, 1]) {
        const c0 = s * (len / 2 - T / 2);
        if (ax === 'x') boxC(cm, cx + c0, cy, 0, T, across, H);
        else boxC(cm, cx, cy + c0, 0, across, T, H);
      }
      meshes.push(cm);
      ctx.capsDone = true;
      ctx.chip = { ax, len, across, T };
      const midLen = len - 2 * T - 0.02;
      if (midLen > 0) {
        if (fam === 'R') {
          const tm = new Mesh('resistive layer', 'body', MAT.resistorTop, src);
          if (ax === 'x') box(tm, cx - midLen / 2, cy - crossW / 2 + 0.02, H - 0.035, cx + midLen / 2, cy + crossW / 2 - 0.02, H - 0.004);
          else box(tm, cx - crossW / 2 + 0.02, cy - midLen / 2, H - 0.035, cx + crossW / 2 - 0.02, cy + midLen / 2, H - 0.004);
          meshes.push(tm);
        } else if (fam === 'D') {
          const lm = new Mesh('lens', 'body', MAT.ledLens, src);
          const lh = Math.min(0.45 * H, H - 0.02);
          if (ax === 'x') box(lm, cx - midLen / 2, cy - crossW / 2 + 0.04, H - lh, cx + midLen / 2, cy + crossW / 2 - 0.04, H - 0.004);
          else box(lm, cx - crossW / 2 + 0.04, cy - midLen / 2, H - lh, cx + crossW / 2 - 0.04, cy + midLen / 2, H - 0.004);
          meshes.push(lm);
        }
      }
      top.w = ax === 'x' ? midLen : crossW; top.l = ax === 'x' ? crossW : midLen;
      return { top, z1: H };
    }
    if (style === 'melf' || style === 'axial') {
      const ax = b.axial || 'x';
      const d = b.d != null ? b.d : Math.min(w, l);
      const len = ax === 'x' ? w : l;
      const r = d / 2, zc = z0 + r;
      ctx.axial = { ax, len, r, zc };
      if (style === 'melf') {
        const T = Math.min(len * 0.4, ctx.res.lead && ctx.res.lead.v != null ? ctx.res.lead.v : len * 0.2);
        const body = new Mesh('body', 'body', bodyMat, src);
        cylinder(body, 0, 0, -(len / 2 - 0.01), len / 2 - 0.01, r - 0.012, 32);
        meshes[meshes.indexOf(m)] = lay(body, ax, cx, cy, zc);
        const cm = new Mesh('end caps', 'lead', ctx.leadMat, ctx.res.lead ? ctx.res.lead.src : []);
        cylinder(cm, 0, 0, -len / 2, -len / 2 + T, r, 32);
        cylinder(cm, 0, 0, len / 2 - T, len / 2, r, 32);
        meshes.push(lay(cm, ax, cx, cy, zc));
        ctx.capsDone = true;
        ctx.axial.T = T;
      } else {
        const body = new Mesh('body', 'body', bodyMat, src);
        // a slightly waisted body with rounded shoulders
        const k = Math.min(0.12 * len, 0.6 * r);
        frustum(body, 0, 0, -len / 2, -len / 2 + k, r * 0.78, r, 32, 'bottom');
        cylinder(body, 0, 0, -len / 2 + k, len / 2 - k, r, 32, false);
        frustum(body, 0, 0, len / 2 - k, len / 2, r, r * 0.78, 32, 'top');
        meshes[meshes.indexOf(m)] = lay(body, ax, cx, cy, zc);
      }
      return { top: null, z1: z0 + d };
    }
    if (style === 'can') {
      const r = Math.min(w, l) / 2;
      const z1 = H;
      const lip = Math.min(0.12, 0.02 * (z1 - z0) + 0.04);
      cylinder(m, cx, cy, z0 + 0.15, z1, r, 48, false);
      frustum(m, cx, cy, z0, z0 + 0.15, r * 0.94, r, 48, false);
      ring(m, cx, cy, z1, r * 0.82, r, 48, true);
      cylinder(m, cx, cy, z1 - lip, z1, r * 0.82, 48, false);    // inner wall of the rolled edge
      const bot = new Mesh('seal', 'body', MAT.rubber, src);
      frustum(bot, cx, cy, z0, z0 + 0.001, r * 0.94, r * 0.94, 48, 'bottom');
      meshes.push(bot);
      const lid = new Mesh('can top', 'body', MAT.aluminum, src);
      cylinder(lid, cx, cy, z1 - lip - 0.002, z1 - lip, r * 0.82, 48, 'top');
      meshes.push(lid);
      if (r > 1.2) {
        const vent = new Mesh('vent', 'body', MAT.vent, src);
        const vl = r * 0.9, vw = Math.max(0.06, r * 0.04);
        boxC(vent, cx, cy, z1 - lip - 0.001, vl, vw, 0.006);
        boxC(vent, cx, cy, z1 - lip - 0.001, vw, vl, 0.006);
        meshes.push(vent);
      }
      ctx.can = { r, z1 };
      return { top: null, z1 };
    }
    if (style === 'bga') {
      const ts = Math.min(0.36, 0.35 * (H - z0));
      const sub = new Mesh('substrate', 'body', MAT.substrate, src);
      boxC(sub, cx, cy, z0, w, l, ts);
      meshes.push(sub);
      boxC(m, cx, cy, z0 + ts, w - 0.002, l - 0.002, H - z0 - ts);
      return { top, z1: H };
    }
    if (style === 'module') {
      return buildModule(ctx, m, meshes, src);
    }
    boxC(m, cx, cy, z0, w, l, H - z0);
    return { top, z1: H };
  }

  function headerHousing(ctx) {
    const { H, z0, pitch, res } = ctx;
    const P = (res.model && res.model.props) || {};
    if (P.above != null) return Math.max(z0 + 0.2, H - P.above);
    if (pitch && H > 2 * pitch) return z0 + pitch;
    return H;
  }

  function chipAxis(ctx) {
    const ls = ctx.res.leads || [];
    const sides = new Set(ls.map((l) => l.side));
    if (sides.has('left') || sides.has('right')) return 'x';
    if (sides.has('top') || sides.has('bottom')) return 'y';
    return ctx.b.w >= ctx.b.l ? 'x' : 'y';
  }
  function chipCap(ctx, len) {
    const L = ctx.res.lead || (ctx.res.leads || []).find((l) => l.form === 'endcap');
    let T = L ? (L.l != null ? L.l : L.v != null ? L.v : L.d) : null;
    if (T == null) T = 0.2 * len;
    return clamp(T, 0.02, 0.45 * len);
  }

  function buildModule(ctx, m, meshes, src) {
    const { b, H, z0, res } = ctx;
    const ts = H > 1.2 ? Math.min(1.0, 0.35 * H) : H - z0;
    const cx = b.x, cy = b.y, hw = b.w / 2, hl = b.l / 2;
    // board outline with a half-hole notch per castellation, walked CCW
    const notches = { bottom: [], right: [], top: [], left: [] };
    for (const l of res.leads || []) {
      if (l.form !== 'castellated' || !l.side) continue;
      const d = l.castellated || l.d || l.v || 0.6;
      notches[l.side].push({ at: l.side === 'left' || l.side === 'right' ? l.y : l.x, r: d / 2 });
    }
    const pts = [], notchEdge = [];
    const corner = { bottom: [cx - hw, cy - hl], right: [cx + hw, cy - hl], top: [cx + hw, cy + hl], left: [cx - hw, cy + hl] };
    const dirs = { bottom: [1, 0], right: [0, 1], top: [-1, 0], left: [0, -1] };
    const walls = [];
    for (const side of ['bottom', 'right', 'top', 'left']) {
      const c = corner[side], dv = dirs[side];
      pts.push(c); notchEdge.push(false);
      const along = (q) => (dv[0] !== 0 ? (q - c[0]) * dv[0] : (q - c[1]) * dv[1]);
      const list = notches[side].slice().sort((a, b2) => along(a.at) - along(b2.at));
      const inward = [-dv[1], dv[0]];
      for (const n of list) {
        const t0 = along(n.at);
        const P0 = [c[0] + dv[0] * t0, c[1] + dv[1] * t0];
        const seg = 12, arc = [];
        for (let k = 0; k <= seg; k++) {
          const a = Math.PI - (Math.PI * k) / seg;   // from the -dv side, around through the inside, to the +dv side
          arc.push([P0[0] + n.r * (Math.cos(a) * dv[0] + Math.sin(a) * inward[0]), P0[1] + n.r * (Math.cos(a) * dv[1] + Math.sin(a) * inward[1])]);
        }
        walls.push(arc);
        arc.forEach((q, j) => { pts.push(q); notchEdge.push(j < seg); });
      }
    }
    const zt = z0 + ts;
    // side walls: plain edges board-colored, notch walls gold
    const gold = new Mesh('castellations', 'lead', MAT.gold, (res.leads || []).flatMap((l) => l.src || []));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const tgt = notchEdge[i] ? gold : m;
      tgt.face4([a[0], a[1], z0], [c[0], c[1], z0], [c[0], c[1], zt], [a[0], a[1], zt]);
    }
    m.cap(pts, z0, false);
    m.cap(pts, zt, true);
    // plating rings around each half-hole, top and bottom
    for (const arc of walls) {
      for (const z of [z0 - 0.004, zt + 0.004]) {
        const outer = arc.map((q, j) => q);
        const mid = arc[Math.floor(arc.length / 2)], P0 = [(arc[0][0] + arc[arc.length - 1][0]) / 2, (arc[0][1] + arc[arc.length - 1][1]) / 2];
        const r = Math.hypot(mid[0] - P0[0], mid[1] - P0[1]);
        const grow = (q) => { const dx = q[0] - P0[0], dy = q[1] - P0[1], L = Math.hypot(dx, dy) || 1; return [P0[0] + dx / L * (r + 0.22), P0[1] + dy / L * (r + 0.22)]; };
        const poly = outer.concat(outer.slice().reverse().map(grow));
        const tris = G.triangulate(poly);
        const base = gold.p.length / 3;
        for (const q of poly) gold.v(q[0], q[1], z, 0, 0, z > z0 ? 1 : -1);
        for (const [a, b2, c] of tris) gold.tri(base + a, base + b2, base + c);
      }
    }
    meshes.push(gold);
    ctx.capsDone = true;
    let z1 = zt;
    const top = { cx, cy, w: b.w, l: b.l, z: zt };
    if (H > 1.2 && H - zt > 0.2) {
      let maxR = 0;
      for (const s of Object.values(notches)) for (const n of s) maxR = Math.max(maxR, n.r);
      const inset = Math.max(0.3, 2 * maxR + 0.35);
      if (b.w - 2 * inset > 0.5 && b.l - 2 * inset > 0.5) {
        const can = new Mesh('shield can', 'body', MAT.tin, src);
        boxC(can, cx, cy, zt, b.w - 2 * inset, b.l - 2 * inset, H - zt);
        meshes.push(can);
        z1 = H;
        Object.assign(top, { w: b.w - 2 * inset, l: b.l - 2 * inset, z: H });
      }
    }
    return { top, z1 };
  }

  // Leads
  const SIGN = { left: -1, right: 1, bottom: -1, top: 1 };
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

  function buildLead(ctx, l, m) {
    const { b, z0, zp, H, style } = ctx;
    const f = l.form;
    if (f === 'endcap' && ctx.capsDone) return false;
    if (f === 'castellated') return false;
    if (f === 'ball') {
      const d = l.v != null ? l.v : l.d != null ? l.d : (l.padAcross || 0.4) / 0.8;
      const h = Math.max(z0, 0.05);
      ellipsoid(m, l.x, l.y, h / 2, d / 2, d / 2, h / 2 + 0.02, 16, 8);
      m.color = MAT.solder.color;
      return true;
    }
    if (f === 'tab') {
      const t = ctx.thick('tab', l);
      let w, ln;
      if (l.w != null && l.l != null) { w = l.w; ln = l.l; } else {
        w = Math.max((l.padAcross || 1) - 0.3, 0.5 * (l.padAcross || 1));
        ln = Math.max((l.padAlong || 1) - 0.3, 0.5 * (l.padAlong || 1));
      }
      const horiz = l.side === 'left' || l.side === 'right';
      boxC(m, l.x, l.y, 0, horiz ? ln : w, horiz ? w : ln, t);
      return true;
    }
    if (f === 'pin' || f === 'wire') return buildTHT(ctx, l, m);
    if (!l.side) {
      // flat contacts on a grid (LGA, crystals) or a surface lead with no side
      const w = l.w != null ? l.w : 0.8 * (l.padAcross || 0.5), ln = l.l != null ? l.l : 0.8 * (l.padAlong || 0.5);
      boxC(m, l.x, l.y, 0, w, ln, Math.max(0.03, Math.min(0.06, z0 + 0.03)));
      return true;
    }
    const F = frame(b, l);
    const c = ctx.thick(f, l);
    const W = l.w != null ? l.w : (f === 'endcap' ? (l.side === 'left' || l.side === 'right' ? b.l : b.w) : 0.8 * (l.padAcross || 0.5));
    const T = l.l != null ? l.l : l.v != null ? l.v : 0.55 * (l.padAlong || 1);
    if (f === 'flat' || f === 'endcap') {
      let uToe = F.uToe;
      if (uToe == null) {
        const half = (l.padAlong || T) / 2;
        uToe = (F.uPad - half < F.uEdge && F.uPad + half > F.uEdge) ? F.uEdge : F.uPad + T / 2;
      }
      const flush = Math.abs(uToe - F.uEdge) < 0.02;
      const u1 = uToe + (flush ? 0.015 : 0), u0 = uToe - T;
      const ht = f === 'endcap' ? H : c;
      sweepRect(m, [[u0, ht / 2], [u1, ht / 2]], W, ht, F.map, F.mapN);
      return true;
    }
    if (f === 'gullwing') {
      const uToe = F.uToe != null ? F.uToe : F.uPad + T / 2;
      const Dd = uToe - F.uEdge;
      const foot = Math.min(T, Dd - Math.max(1.2 * c, 0.25 * Dd));
      if (!(Dd > 2.5 * c) || !(foot > c)) {
        sweepRect(m, [[Math.max(F.uEdge - 0.2, uToe - T), c / 2], [uToe, c / 2]], W, c, F.map, F.mapN);
        return true;
      }
      const g = Dd - foot;
      const sh = Math.max(0.5 * c, 0.35 * g);
      const inside = Math.min(0.3, 0.4 * F.uEdge);
      const zl = Math.max(zp, c * 1.5);
      const path = fillet([[F.uEdge - inside, zl], [F.uEdge + sh, zl], [uToe - foot, c / 2], [uToe, c / 2]], 1.5 * c);
      sweepRect(m, path, W, c, F.map, F.mapN);
      return true;
    }
    if (f === 'jlead') {
      const uOut = (F.uToe != null ? F.uToe : F.uPad + T / 2) - c / 2;
      // the J curls under the body: it has to fit below the lead's exit
      const rj = Math.max(0.6 * c, Math.min(clamp(T / 2, c, 0.45), (zp - c / 2) / 2.6));
      const zl = Math.max(zp, rj * 2 + c);
      const inside = Math.min(0.3, 0.4 * F.uEdge);
      if (uOut - 2 * rj < 0) return false;
      const start = fillet([[F.uEdge - inside, zl], [uOut, zl], [uOut, rj + c / 2]], 1.5 * c);
      const cz = rj + c / 2, cxu = uOut - rj;
      const K = 14;
      for (let j = 1; j <= K; j++) { const a = -Math.PI * j / K; start.push([cxu + rj * Math.cos(a), cz + rj * Math.sin(a)]); }
      start.push([uOut - 2 * rj, cz + 0.8 * rj]);
      sweepRect(m, start, W, c, F.map, F.mapN);
      return true;
    }
    return false;
  }

  function buildTHT(ctx, l, m) {
    const { b, z0, H, style, below } = ctx;
    const round = l.d != null || (l.w == null && l.v != null);
    const dia = l.d != null ? l.d : l.v != null ? l.v : null;
    const W = l.w != null ? l.w : dia != null ? dia : (l.drill ? l.drill - 0.2 : 0.6);
    const Tk = l.l != null ? l.l : W;
    const bottom = -below;
    if (style === 'dip' && l.side && (l.side === 'left' || l.side === 'right' || l.side === 'top' || l.side === 'bottom')) {
      const F = frame(b, l);
      const c = Tk;
      const zl = Math.max(ctx.zp, 2 * c);
      const sw = Math.min(0.6 * (l.pitch || ctx.pitch || 2.54), Math.max(3.3 * W, W + 0.4));
      const inside = Math.min(0.3, 0.4 * F.uEdge);
      const path = fillet([[F.uEdge - inside, zl], [F.uPad, zl], [F.uPad, 0]], 1.5 * c);
      sweepRect(m, path, sw, c, F.map, F.mapN);
      // tail through the board
      const t = new Mesh('', 'lead', ctx.leadMat);
      if (round) cylinder(t, 0, 0, bottom, 0.05, W / 2, 12);
      else boxC(t, 0, 0, bottom, c, W, 0.05 - bottom);
      t.transform((x, y, z) => { const q = F.map(F.uPad + x, y, z); return q; }, (x, y, z) => F.mapN(x, y, z));
      m.append(t);
      return true;
    }
    if (style === 'axial' && ctx.axial) {
      const { ax, len, zc } = ctx.axial;
      const r = (dia != null ? dia : W) / 2;
      const along = ax === 'x' ? l.x - b.x : l.y - b.y;
      const s = along < 0 ? -1 : 1;
      const start = s * Math.max(len / 2 - Math.min(0.6, len / 4), 0);
      const rb = Math.max(2.5 * r, 0.8);
      // local: a = position along the axis, z height
      let pts2 = fillet([[start, zc], [along, zc], [along, bottom]], rb, 8);
      if (Math.abs(along) < len / 2) pts2 = [[along, zc], [along, bottom]];
      const path = pts2.map(([a, z]) => (ax === 'x' ? [b.x + a, b.y, z] : [b.x, b.y + a, z]));
      tube(m, path, r, 12);
      return true;
    }
    if (style === 'header') {
      // pins rise to H, unless the housing fills the height (a socket); then they stop inside it
      const housing = ctx.housing != null ? ctx.housing : H;
      const top = housing >= H - 1e-6 ? H - Math.min(1, 0.3 * (H - z0)) : H;
      const sz = W;
      const bev = Math.min(0.25 * sz, 0.2);
      if (round) {
        frustum(m, l.x, l.y, bottom, bottom + bev, (sz / 2) * 0.55, sz / 2, 14, 'bottom');
        cylinder(m, l.x, l.y, bottom + bev, top - bev, sz / 2, 14, false);
        frustum(m, l.x, l.y, top - bev, top, sz / 2, (sz / 2) * 0.55, 14, 'top');
      } else {
        const sq = (k) => rectPts(l.x, l.y, W * k, Tk * k);
        loft(m, [{ z: bottom, pts: sq(0.55) }, { z: bottom + bev, pts: sq(1) }, { z: top - bev, pts: sq(1) }, { z: top, pts: sq(0.55) }]);
      }
      return true;
    }
    // straight wire or pin from below the board up into the body
    const zTop = style === 'can' || style === 'radial' ? z0 + 0.3 : Math.min(H, z0 + 0.3);
    if (round || style === 'can') cylinder(m, l.x, l.y, bottom, zTop, (dia != null ? dia : W) / 2, 12);
    else boxC(m, l.x, l.y, bottom, W, Tk, zTop - bottom);
    return true;
  }

  // Marks
  function markOf(ctx, P) {
    const { res, style } = ctx;
    if (P.pin1) return P.pin1;
    if (res.polarized) return 'stripe';
    const p1 = res.pin1;
    if (!p1) return 'none';
    const st = p1.style;
    if (p1.explicit && st === 'none') return 'none';
    if (st === 'notch') return style === 'molded' || style === 'dip' || style === 'block' || style === 'sawn' ? 'notch' : 'none';
    if (st === 'bar') return 'stripe';
    const dflt = { molded: 'dimple', dip: 'dimple', sawn: 'dot', bga: 'dot', module: 'dot' }[style];
    if (dflt) return dflt;
    if (style === 'block' && (st === 'dot' || st === 'chamfer')) return 'dot';
    return 'none';
  }

  function buildMark(ctx, mark, meshes, leadMeshes) {
    const { res, b, style, bodyMat, fam } = ctx;
    const src = (res.model && res.model.src) || [];
    const pinOne = res.pin1;
    // the end a stripe marks: the cathode or negative lead, but the positive end of a chip capacitor
    let stripeTo = null;
    if (mark === 'stripe') {
      const p2 = res.pads.find((p) => p.name === '2') || res.pads.find((p) => pinOne && p.name !== pinOne.pad && !p.thermal);
      const tantalum = fam === 'C' && (style === 'chip' || style === 'molded' || style === 'sawn' || style === 'block');
      const toPin1 = !res.polarized || tantalum;
      stripeTo = toPin1 ? (pinOne ? [pinOne.x, pinOne.y] : null) : (p2 ? [p2.x, p2.y] : null);
      if (!stripeTo) return;
    }
    if (mark === 'stripe' && ctx.can) {
      const { r, z1 } = ctx.can;
      const a = Math.atan2(stripeTo[1] - b.y, stripeTo[0] - b.x);
      const m = new Mesh('polarity stripe', 'mark', MAT.stripe, src);
      shell(m, b.x, b.y, ctx.z0 + 0.25, z1 - 0.12, r + 0.015, a - 0.5, a + 0.5, 16);
      meshes.push(m);
      return;
    }
    if (mark === 'stripe' && ctx.axial) {
      const { ax, len, r, zc } = ctx.axial;
      const along = ax === 'x' ? stripeTo[0] - b.x : stripeTo[1] - b.y;
      const s = along < 0 ? -1 : 1;
      const T = ctx.axial.T || 0;
      const bw = Math.max(0.12 * len, 0.25);
      const c0 = s * (len / 2 - T - bw / 2 - 0.08 * len);
      const m = new Mesh('cathode band', 'mark', style === 'melf' && fam === 'D' ? MAT.glassBand : MAT.band, src);
      cylinder(m, 0, 0, c0 - bw / 2, c0 + bw / 2, r + 0.012, 32);
      meshes.push(lay(m, ax, b.x, b.y, zc));
      return;
    }
    const top = ctx.top;
    if (!top || !(top.w > 0) || !(top.l > 0)) return;
    const zt = top.z + 0.006;
    if (mark === 'stripe') {
      // a band across the top at the marked end
      const ax = ctx.chip ? ctx.chip.ax : (Math.abs(stripeTo[0] - b.x) >= Math.abs(stripeTo[1] - b.y) ? 'x' : 'y');
      const len = ax === 'x' ? top.w : top.l, across = ax === 'x' ? top.l : top.w;
      const s = (ax === 'x' ? stripeTo[0] - top.cx : stripeTo[1] - top.cy) < 0 ? -1 : 1;
      const bw = Math.max(Math.min(0.18 * len, 0.6), 0.06);
      const c0 = s * (len / 2 - bw / 2 - Math.min(0.06, 0.05 * len));
      const m = new Mesh('polarity stripe', 'mark', fam === 'D' && style === 'chip' ? MAT.ledMark : MAT.stripe, src);
      const ac = across - Math.min(0.1, 0.1 * across);
      if (ax === 'x') boxC(m, top.cx + c0, top.cy, zt - 0.002, bw, ac, 0.006);
      else boxC(m, top.cx, top.cy + c0, zt - 0.002, ac, bw, 0.006);
      meshes.push(m);
      return;
    }
    if (!pinOne) return;
    const sx = Math.sign(Math.round((pinOne.x - top.cx) * 1e6)), sy = Math.sign(Math.round((pinOne.y - top.cy) * 1e6));
    const small = Math.min(top.w, top.l);
    if (mark === 'notch') {
      // a half-disc at the middle of the end nearest pin 1
      const g = res.generator;
      const rowsLR = g && (g.kind === 'dual' || (res.leads || []).some((l) => l.side === 'left' || l.side === 'right'));
      const rn = clamp(0.16 * small, 0.25, 0.8);
      const m = new Mesh('pin-1 notch', 'mark', { color: mix(bodyMat.color, [0, 0, 0], 0.55), metal: 0 }, src);
      const seg = 16, pts = [];
      let c, a0;
      if (rowsLR) { c = [top.cx, top.cy + (sy || 1) * top.l / 2]; a0 = sy < 0 ? 0 : Math.PI; }
      else { c = [top.cx + (sx || -1) * top.w / 2, top.cy]; a0 = sx < 0 ? -Math.PI / 2 : Math.PI / 2; }
      for (let k = 0; k <= seg; k++) { const a = a0 + (Math.PI * k) / seg; pts.push([c[0] + rn * Math.cos(a), c[1] + rn * Math.sin(a)]); }
      loft(m, [{ z: zt - 0.003, pts }, { z: zt + 0.003, pts }]);
      meshes.push(m);
      return;
    }
    const rm = clamp((mark === 'dot' ? 0.055 : 0.08) * small, mark === 'dot' ? 0.1 : 0.15, mark === 'dot' ? 0.3 : 0.5);
    const inset = rm + Math.max(0.12, 0.06 * small);
    const x = top.cx + sx * Math.max(0, top.w / 2 - inset), y = top.cy + sy * Math.max(0, top.l / 2 - inset);
    const mat = mark === 'dot' ? (style === 'module' ? MAT.dot : MAT.dot) : { color: mix(bodyMat.color, [1, 1, 1], 0.1), metal: 0 };
    const m = new Mesh(mark === 'dot' ? 'pin-1 dot' : 'pin-1 dimple', 'mark', mat, src);
    cylinder(m, x, y, zt - 0.003, zt + 0.003, rm, 24);
    meshes.push(m);
  }

  // Extra solids
  function solidMesh(s, bodyMat, bodyTop) {
    const mat = s.color ? matOf(s.color) : (bodyMat || MAT.molded);
    const m = new Mesh(s.kind === 'box' ? 'box' : 'cylinder', 'solid', mat, s.src);
    if (s.kind === 'box') box(m, -s.w / 2, -s.l / 2, -s.h / 2, s.w / 2, s.l / 2, s.h / 2);
    else cylinder(m, 0, 0, -s.h / 2, s.h / 2, s.d / 2, 32);
    if (s.rotate) {
      const [ax, ay, az] = s.rotate.map((a) => a * D2R);
      const R = (v) => {
        let [x, y, z] = v;
        [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
        [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
        [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
        return [x, y, z];
      };
      m.transform((x, y, z) => R([x, y, z]), (x, y, z) => R([x, y, z]));
    }
    let x0 = Infinity, y0 = Infinity, zmin = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < m.p.length; k += 3) {
      x0 = Math.min(x0, m.p[k]); x1 = Math.max(x1, m.p[k]);
      y0 = Math.min(y0, m.p[k + 1]); y1 = Math.max(y1, m.p[k + 1]);
      zmin = Math.min(zmin, m.p[k + 2]);
    }
    const zBase = s.z != null ? s.z : (s.onBody ? bodyTop : 0);
    const dx = s.x - (x0 + x1) / 2, dy = s.y - (y0 + y1) / 2, dz = zBase - zmin;
    m.transform((x, y, z) => [x + dx, y + dy, z + dz], (x, y, z) => [x, y, z]);
    return m;
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

  return { build, board, toVRML, toSTL, toZip, BOARD_T, _prims: { fillet, triangulate: G.triangulate } };
});
