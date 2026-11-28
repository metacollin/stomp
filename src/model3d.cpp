// demo/js/model3d.js, function for function: the mesh kernel, the descriptors' meshes, the
// engine that binds the body and lead features, the board, and the VRML and STL writers.
#include "model3d.hpp"

#include <stomp/stomp.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <unordered_map>

#include "compile/keys.hpp"
#include "geom.hpp"
#include "jsrt.hpp"

namespace stomp::model3d {

namespace {

using compiler::Builder;
using compiler::Color;
using compiler::EV;
using compiler::HookBindingP;
using compiler::HookError;
using geom::Poly;
using geom::Pt;
using P3 = std::array<double, 3>;
using V = std::u16string_view;

constexpr double PI = geom::PI;
constexpr double D2R = PI / 180;
constexpr double INF = std::numeric_limits<double>::infinity();
double clamp(double v, double lo, double hi) { return js::max(lo, js::min(hi, v)); }

// Reading records
const Val& F(const Val& o, Key k) {
  static const Val undef;
  return o.is_obj() ? o.obj()->get(k) : undef;
}
double N(const Val& v) { return v.is_num() ? v.num() : NAN; }
const std::vector<Val>& A(const Val& v) {
  static const std::vector<Val> none;
  return v.is_arr() ? v.arr()->a : none;
}
U S(const Val& v) { return v.is_str() ? v.str() : U(); }
bool is(const Val& v, V s) { return v.is_str() && v.str() == s; }
/** JavaScript's `a || b`. */
const Val& orv(const Val& a, const Val& b) { return a.truthy() ? a : b; }
Pt pt(const Val& v) { return {N(A(v).size() > 0 ? A(v)[0] : Val()), N(A(v).size() > 1 ? A(v)[1] : Val())}; }
Poly pts_of(const Val& v) {
  Poly out;
  for (const Val& p : A(v)) out.push_back(pt(p));
  return out;
}

// Colors
struct Mat {
  std::array<double, 3> color{};
  double metal = 0;
};
std::array<double, 3> hex(const char* h) {
  const int n = static_cast<int>(std::strtol(h + 1, nullptr, 16));
  return {((n >> 16) & 255) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0};
}
// colors the engine falls back on when a hook names none
const Mat TIN{hex("#c6cad0"), 1};
const Mat EPOXY{hex("#26272b"), 0};
Mat mat_of(const Color& c) { return {c.rgb, js::truthy(c.metal) ? 1.0 : 0.0}; }
Mat mat_of(const Val& c) {
  Mat m;
  const auto& rgb = A(F(c, K_rgb));
  for (std::size_t i = 0; i < 3 && i < rgb.size(); ++i) m.color[i] = N(rgb[i]);
  m.metal = F(c, K_metal).truthy() ? 1 : 0;
  return m;
}
Color color_of(const Val& c) {
  Color out;
  const auto& rgb = A(F(c, K_rgb));
  for (std::size_t i = 0; i < 3 && i < rgb.size(); ++i) out.rgb[i] = N(rgb[i]);
  out.metal = N(F(c, K_metal));
  if (F(c, K_name).is_str()) out.name = F(c, K_name).str();
  return out;
}

// Meshes
P3 normal3(const P3& a, const P3& b, const P3& c) {
  const double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const double vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const double x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  double L = js::hypot({x, y, z});
  if (!js::truthy(L)) L = 1;
  return {x / L, y / L, z / L};
}

struct MB {
  std::optional<U> name;
  U kind;
  Mat mat;
  Val src;
  std::vector<double> p, n;
  std::vector<std::uint32_t> i;

  std::uint32_t v(double x, double y, double z, double nx, double ny, double nz) {
    p.insert(p.end(), {x, y, z});
    n.insert(n.end(), {nx, ny, nz});
    return static_cast<std::uint32_t>(p.size() / 3 - 1);
  }
  std::uint32_t v(const P3& q, const P3& m) { return v(q[0], q[1], q[2], m[0], m[1], m[2]); }
  void tri(std::uint32_t a, std::uint32_t b, std::uint32_t c) { i.insert(i.end(), {a, b, c}); }
  void quad(std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d) { i.insert(i.end(), {a, b, c, a, c, d}); }
  std::uint32_t base() const { return static_cast<std::uint32_t>(p.size() / 3); }
  /** Flat quad from four points (any winding is fixed later). */
  void face4(const P3& P0, const P3& P1, const P3& P2, const P3& P3_) {
    const P3 nn = normal3(P0, P1, P2);
    const auto a = v(P0, nn), b = v(P1, nn), c = v(P2, nn), d = v(P3_, nn);
    quad(a, b, c, d);
  }
  /** Flat polygon at height z (pts CCW in xy), facing up or down. */
  void cap(const Poly& pts, double z, bool up) {
    const auto tris = geom::triangulate(pts);
    const std::uint32_t b0 = base();
    for (const Pt& q : pts) v(q.x, q.y, z, 0, 0, up ? 1 : -1);
    for (const auto& t : tris) tri(b0 + t[0], b0 + t[1], b0 + t[2]);
  }
  template <typename Fp, typename Fn>
  MB& transform(Fp fn, Fn fnN) {
    for (std::size_t k = 0; k < p.size(); k += 3) {
      const P3 q = fn(p[k], p[k + 1], p[k + 2]);
      p[k] = q[0];
      p[k + 1] = q[1];
      p[k + 2] = q[2];
      const P3 m = fnN(n[k], n[k + 1], n[k + 2]);
      n[k] = m[0];
      n[k + 1] = m[1];
      n[k + 2] = m[2];
    }
    return *this;
  }
  MB& append(const MB& o) {
    const std::uint32_t b0 = base();
    p.insert(p.end(), o.p.begin(), o.p.end());
    n.insert(n.end(), o.n.begin(), o.n.end());
    for (std::uint32_t k : o.i) i.push_back(b0 + k);
    return *this;
  }
  /** Make every triangle counter-clockwise seen from the side its normals face. */
  Mesh finish() {
    for (std::size_t t = 0; t < i.size(); t += 3) {
      const std::size_t a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3;
      const double ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const double vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const double fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const double sx = n[a] + n[b] + n[c], sy = n[a + 1] + n[b + 1] + n[c + 1], sz = n[a + 2] + n[b + 2] + n[c + 2];
      if (fx * sx + fy * sy + fz * sz < 0) std::swap(i[t + 1], i[t + 2]);
    }
    Mesh out;
    out.name = name ? *name : U(u"null");
    out.kind = kind;
    out.color = mat.color;
    out.metal = mat.metal;
    out.src = src;
    out.pos.assign(p.begin(), p.end());
    out.nrm.assign(n.begin(), n.end());
    out.idx = i;
    return out;
  }
};

// Primitives

/** Axis-aligned box. */
void box(MB& m, double x0, double y0, double z0, double x1, double y1, double z1) {
  if (!(x1 > x0 && y1 > y0 && z1 > z0)) return;
  m.face4({x0, y0, z0}, {x0, y1, z0}, {x1, y1, z0}, {x1, y0, z0});   // bottom
  m.face4({x0, y0, z1}, {x1, y0, z1}, {x1, y1, z1}, {x0, y1, z1});   // top
  m.face4({x0, y0, z0}, {x1, y0, z0}, {x1, y0, z1}, {x0, y0, z1});   // front (-y)
  m.face4({x1, y1, z0}, {x0, y1, z0}, {x0, y1, z1}, {x1, y1, z1});   // back (+y)
  m.face4({x0, y1, z0}, {x0, y0, z0}, {x0, y0, z1}, {x0, y1, z1});   // left
  m.face4({x1, y0, z0}, {x1, y1, z0}, {x1, y1, z1}, {x1, y0, z1});   // right
}
void boxC(MB& m, double cx, double cy, double z0, double w, double l, double h) { box(m, cx - w / 2, cy - l / 2, z0, cx + w / 2, cy + l / 2, z0 + h); }

struct Ring {
  double z;
  Poly pts;
};
/** Lofted solid through rings of equal point count (CCW polygons at increasing z). */
void loft(MB& m, const std::vector<Ring>& rings, bool caps = true) {
  const std::size_t n = rings[0].pts.size();
  for (std::size_t r = 0; r + 1 < rings.size(); ++r) {
    const Ring &A0 = rings[r], &B0 = rings[r + 1];
    if (B0.z - A0.z < 1e-9) continue;
    for (std::size_t i = 0; i < n; ++i) {
      const std::size_t j = (i + 1) % n;
      m.face4({A0.pts[i].x, A0.pts[i].y, A0.z}, {A0.pts[j].x, A0.pts[j].y, A0.z}, {B0.pts[j].x, B0.pts[j].y, B0.z}, {B0.pts[i].x, B0.pts[i].y, B0.z});
    }
  }
  if (caps) {
    m.cap(rings.front().pts, rings.front().z, false);
    m.cap(rings.back().pts, rings.back().z, true);
  }
}
Poly rect_pts(double cx, double cy, double w, double l) {
  return {{cx - w / 2, cy - l / 2}, {cx + w / 2, cy - l / 2}, {cx + w / 2, cy + l / 2}, {cx - w / 2, cy + l / 2}};
}
Poly circle_pts(double cx, double cy, double r, double seg) {
  Poly out;
  for (double k = 0; k < seg; k++) out.push_back({cx + r * js::cos((2 * PI * k) / seg), cy + r * js::sin((2 * PI * k) / seg)});
  return out;
}

enum class Caps { Both, None, Top, Bottom };   // Top: the top cap only ('top'), Bottom: the bottom only
/** Upright frustum or cylinder with smooth sides. */
void frustum(MB& m, double cx, double cy, double z0, double z1, double r0, double r1, double seg, Caps caps) {
  if (!js::truthy(seg)) seg = 24;
  const double slope = (r0 - r1) / js::max(z1 - z0, 1e-9);
  const double nz = slope / js::hypot({1, slope}), nr = 1 / js::hypot({1, slope});
  const std::uint32_t b0 = m.base();
  for (double k = 0; k <= seg; k++) {
    const double a = (2 * PI * k) / seg, c = js::cos(a), s = js::sin(a);
    m.v(cx + r0 * c, cy + r0 * s, z0, c * nr, s * nr, nz);
    m.v(cx + r1 * c, cy + r1 * s, z1, c * nr, s * nr, nz);
  }
  for (double k = 0; k < seg; k++) {
    const std::uint32_t a = b0 + 2 * static_cast<std::uint32_t>(k);
    m.quad(a, a + 2, a + 3, a + 1);
  }
  if (caps != Caps::None) {
    if (r0 > 1e-9 && caps != Caps::Top) m.cap(circle_pts(cx, cy, r0, seg), z0, false);
    if (r1 > 1e-9 && caps != Caps::Bottom) m.cap(circle_pts(cx, cy, r1, seg), z1, true);
  }
}

/** Flat ring (annulus) at height z, facing up or down. */
void ring(MB& m, double cx, double cy, double z, double r0, double r1, double seg, bool up) {
  const std::uint32_t b0 = m.base();
  const double nz = up ? 1 : -1;
  for (double k = 0; k <= seg; k++) {
    const double a = (2 * PI * k) / seg;
    m.v(cx + r0 * js::cos(a), cy + r0 * js::sin(a), z, 0, 0, nz);
    m.v(cx + r1 * js::cos(a), cy + r1 * js::sin(a), z, 0, 0, nz);
  }
  for (double k = 0; k < seg; k++) {
    const std::uint32_t a = b0 + 2 * static_cast<std::uint32_t>(k);
    m.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Part of a cylinder or cone wall, from angle a0 to a1 (radians): a stripe on a can. */
void shell(MB& m, double cx, double cy, double z0, double z1, double r0, double r1, double a0, double a1, double seg) {
  const double slope = (r0 - r1) / js::max(z1 - z0, 1e-9);
  const double nz = slope / js::hypot({1, slope}), nr = 1 / js::hypot({1, slope});
  const std::uint32_t b0 = m.base();
  for (double k = 0; k <= seg; k++) {
    const double a = a0 + ((a1 - a0) * k) / seg, c = js::cos(a), s = js::sin(a);
    m.v(cx + r0 * c, cy + r0 * s, z0, c * nr, s * nr, nz);
    m.v(cx + r1 * c, cy + r1 * s, z1, c * nr, s * nr, nz);
  }
  for (double k = 0; k < seg; k++) {
    const std::uint32_t a = b0 + 2 * static_cast<std::uint32_t>(k);
    m.quad(a, a + 2, a + 3, a + 1);
  }
}

/** Part of a flat ring, from angle a0 to a1 (radians). */
void ring_sector(MB& m, double cx, double cy, double z, double r0, double r1, double a0, double a1, double seg, bool up) {
  const std::uint32_t b0 = m.base();
  const double nz = up ? 1 : -1;
  for (double k = 0; k <= seg; k++) {
    const double a = a0 + ((a1 - a0) * k) / seg;
    m.v(cx + r0 * js::cos(a), cy + r0 * js::sin(a), z, 0, 0, nz);
    m.v(cx + r1 * js::cos(a), cy + r1 * js::sin(a), z, 0, 0, nz);
  }
  for (double k = 0; k < seg; k++) {
    const std::uint32_t a = b0 + 2 * static_cast<std::uint32_t>(k);
    m.quad(a, a + 1, a + 3, a + 2);
  }
}

void ellipsoid(MB& m, double cx, double cy, double cz, double rx, double ry, double rz, double slices, double stacks) {
  if (!js::truthy(slices)) slices = 16;
  if (!js::truthy(stacks)) stacks = 10;
  const std::uint32_t b0 = m.base();
  for (double i = 0; i <= stacks; i++) {
    const double th = (PI * i) / stacks, st = js::sin(th), ct = js::cos(th);
    for (double j = 0; j <= slices; j++) {
      const double ph = (2 * PI * j) / slices, sp = js::sin(ph), cp = js::cos(ph);
      const double x = st * cp, y = st * sp, z = ct;
      const double nx = x / rx, ny = y / ry, nz = z / rz;
      double L = js::hypot({nx, ny, nz});
      if (!js::truthy(L)) L = 1;
      m.v(cx + rx * x, cy + ry * y, cz + rz * z, nx / L, ny / L, nz / L);
    }
  }
  const auto S1 = static_cast<std::uint32_t>(slices);
  for (double i = 0; i < stacks; i++) {
    for (double j = 0; j < slices; j++) {
      const std::uint32_t a = b0 + static_cast<std::uint32_t>(i) * (S1 + 1) + static_cast<std::uint32_t>(j), b = a + S1 + 1;
      if (i > 0) m.tri(a, b, a + 1);
      if (i < stacks - 1) m.tri(a + 1, b, b + 1);
    }
  }
}

/** Round a polyline's corners with arcs of radius r (limited by the segments). keep[i] true
 *  leaves point i as it is: an arc's own points. */
Poly fillet(const Poly& pts, double r, const Val& stepDeg, const std::vector<bool>* keep) {
  const double step = (stepDeg.truthy() ? stepDeg.num() : 10) * D2R;
  Poly out{pts[0]};
  for (std::size_t i = 1; i + 1 < pts.size(); ++i) {
    const Pt p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    if (keep && i < keep->size() && (*keep)[i]) {
      out.push_back(p1);
      continue;
    }
    const double L1 = js::hypot({p1.x - p0.x, p1.y - p0.y}), L2 = js::hypot({p2.x - p1.x, p2.y - p1.y});
    if (L1 < 1e-9 || L2 < 1e-9) {
      out.push_back(p1);
      continue;
    }
    const Pt d1{(p1.x - p0.x) / L1, (p1.y - p0.y) / L1}, d2{(p2.x - p1.x) / L2, (p2.y - p1.y) / L2};
    const double th = js::acos(clamp(d1.x * d2.x + d1.y * d2.y, -1, 1));
    if (th < 1e-3) {
      out.push_back(p1);
      continue;
    }
    double tl = r * js::tan(th / 2), rr = r;
    const double maxT = 0.45 * js::min(L1, L2);
    if (tl > maxT) {
      tl = maxT;
      rr = tl / js::tan(th / 2);
    }
    const Pt a{p1.x - d1.x * tl, p1.y - d1.y * tl};
    const double turn = d1.x * d2.y - d1.y * d2.x > 0 ? 1 : -1;
    const Pt nrm = turn > 0 ? Pt{-d1.y, d1.x} : Pt{d1.y, -d1.x};
    const Pt c{a.x + nrm.x * rr, a.y + nrm.y * rr};
    const double a0 = js::atan2(a.y - c.y, a.x - c.x);
    const double k = js::max(2, std::ceil(th / step));
    for (double j = 0; j <= k; j++) {
      const double ang = a0 + turn * th * (j / k);
      out.push_back({c.x + rr * js::cos(ang), c.y + rr * js::sin(ang)});
    }
  }
  out.push_back(pts.back());
  return out;
}

/** Sweep a rectangle (width w across the path's plane, thickness t in it) along a path of
 *  (u, z) points, at o. */
void sweep_rect(MB& m, const Poly& path, double w, double t, const P3& o) {
  const std::size_t n = path.size();
  if (n < 2) return;
  std::vector<Pt> Nn;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt a = path[i > 0 ? i - 1 : 0], b = path[std::min(n - 1, i + 1)];
    double tu = b.x - a.x, tz = b.y - a.y;
    double L = js::hypot({tu, tz});
    if (!js::truthy(L)) L = 1;
    tu /= L;
    tz /= L;
    Nn.push_back({-tz, tu});
  }
  const auto P = [&](std::size_t i, double sn, double sv) -> P3 {
    return {o[0] + (path[i].x + sn * Nn[i].x * t / 2), o[1] + sv * w / 2, o[2] + (path[i].y + sn * Nn[i].y * t / 2)};
  };
  // sn 0 means the side faces: -1 for the first vertex, +1 for the second
  const auto strip = [&](double sn, double sv0, double sv1, const std::function<P3(std::size_t)>& normal) {
    const std::uint32_t b0 = m.base();
    for (std::size_t i = 0; i < n; ++i) {
      const P3 nn = normal(i);
      m.v(P(i, sn == 0 ? -1 : sn, sv0), nn);
      m.v(P(i, sn == 0 ? 1 : sn, sv1), nn);
    }
    for (std::size_t i = 0; i + 1 < n; ++i) {
      const std::uint32_t a = b0 + 2 * static_cast<std::uint32_t>(i);
      m.quad(a, a + 2, a + 3, a + 1);
    }
  };
  strip(1, -1, 1, [&](std::size_t i) { return P3{Nn[i].x, 0, Nn[i].y}; });     // outer face (+n)
  strip(-1, -1, 1, [&](std::size_t i) { return P3{-Nn[i].x, 0, -Nn[i].y}; });  // inner face (-n)
  strip(0, 1, 1, [](std::size_t) { return P3{0, 1, 0}; });                     // +v side
  strip(0, -1, -1, [](std::size_t) { return P3{0, -1, 0}; });                  // -v side
  const auto end = [&](std::size_t i, int s) {
    const Pt a = path[i], b = path[static_cast<std::size_t>(static_cast<long>(i) + s)];
    const Pt tn{a.x - b.x, a.y - b.y};
    double L = js::hypot({tn.x, tn.y});
    if (!js::truthy(L)) L = 1;
    const P3 nn{tn.x / L, 0, tn.y / L};
    const P3 q[4] = {P(i, 1, 1), P(i, 1, -1), P(i, -1, -1), P(i, -1, 1)};
    const std::uint32_t b0 = m.base();
    for (const P3& x : q) m.v(x, nn);
    m.quad(b0, b0 + 1, b0 + 2, b0 + 3);
  };
  end(0, 1);
  end(n - 1, -1);
}

/** A round tube along a 3D polyline (wires). */
void tube(MB& m, const std::vector<P3>& path, double r, double seg) {
  if (!js::truthy(seg)) seg = 12;
  const std::size_t n = path.size();
  if (n < 2) return;
  const auto nz = [](const P3& v) -> P3 {
    double L = js::hypot({v[0], v[1], v[2]});
    if (!js::truthy(L)) L = 1;
    return {v[0] / L, v[1] / L, v[2] / L};
  };
  std::vector<P3> T;
  for (std::size_t i = 0; i < n; ++i) {
    const P3 a = path[i > 0 ? i - 1 : 0], b = path[std::min(n - 1, i + 1)];
    const P3 d{b[0] - a[0], b[1] - a[1], b[2] - a[2]};
    double L = js::hypot({d[0], d[1], d[2]});
    if (!js::truthy(L)) L = 1;
    T.push_back({d[0] / L, d[1] / L, d[2] / L});
  }
  // parallel-transported frame
  const P3 ref = std::fabs(T[0][2]) < 0.9 ? P3{0, 0, 1} : P3{1, 0, 0};
  const auto cross = [](const P3& a, const P3& b) -> P3 {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
  };
  P3 Nv = nz(cross(cross(T[0], ref), T[0]));
  const std::uint32_t b0 = m.base();
  const auto S1 = static_cast<std::uint32_t>(seg);
  for (std::size_t i = 0; i < n; ++i) {
    if (i > 0) {
      const double dt = Nv[0] * T[i][0] + Nv[1] * T[i][1] + Nv[2] * T[i][2];
      Nv = nz({Nv[0] - dt * T[i][0], Nv[1] - dt * T[i][1], Nv[2] - dt * T[i][2]});
    }
    const P3 B = cross(T[i], Nv);
    for (double k = 0; k <= seg; k++) {
      const double a = (2 * PI * k) / seg, c = js::cos(a), s = js::sin(a);
      const P3 d{c * Nv[0] + s * B[0], c * Nv[1] + s * B[1], c * Nv[2] + s * B[2]};
      m.v(path[i][0] + r * d[0], path[i][1] + r * d[1], path[i][2] + r * d[2], d[0], d[1], d[2]);
    }
  }
  for (std::size_t i = 0; i + 1 < n; ++i) {
    for (std::uint32_t k = 0; k < S1; ++k) {
      const std::uint32_t a = b0 + static_cast<std::uint32_t>(i) * (S1 + 1) + k, b = a + S1 + 1;
      m.quad(a, b, b + 1, a + 1);
    }
  }
  // end caps
  for (const auto& [i, s] : {std::pair<std::size_t, double>{0, -1}, {n - 1, 1}}) {
    const P3 nn{T[i][0] * s, T[i][1] * s, T[i][2] * s};
    const std::uint32_t cb = m.base();
    m.v(path[i], nn);
    for (std::uint32_t k = 0; k <= S1; ++k) {
      const std::size_t q = b0 + static_cast<std::uint32_t>(i) * (S1 + 1) + k;
      m.v(m.p[q * 3], m.p[q * 3 + 1], m.p[q * 3 + 2], nn[0], nn[1], nn[2]);
    }
    for (std::uint32_t k = 0; k < S1; ++k) m.tri(cb, cb + 1 + k, cb + 2 + k);
  }
}

using Frame = geom::Frame;
Frame frame_of(const Val& M) {
  Frame f{};
  const auto& a = A(M);
  for (std::size_t i = 0; i < 12 && i < a.size(); ++i) f[i] = N(a[i]);
  return f;
}
/** Put a mesh's points and normals through a frame (geom::frame3's layout). */
MB& apply_frame(MB& m, const Frame& M) {
  if (geom::is_identity3(M)) return m;
  return m.transform(
      [&](double x, double y, double z) -> P3 {
        return {M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]};
      },
      [&](double x, double y, double z) -> P3 { return {M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z}; });
}

struct Notch {
  U side;
  double at, r;
};

/** A board W x L x T from o.z up, with a half-hole cut into its edge at each notch. */
void slab(MB& m, const P3& o, double w, double l, double t, const std::vector<Notch>& notches) {
  const double cx = o[0], cy = o[1], hw = w / 2, hl = l / 2, z0 = o[2], zt = o[2] + t;
  Poly pts;
  std::vector<bool> notchEdge;
  const char16_t* sides[] = {u"bottom", u"right", u"top", u"left"};
  const Pt corner[] = {{cx - hw, cy - hl}, {cx + hw, cy - hl}, {cx + hw, cy + hl}, {cx - hw, cy + hl}};
  const Pt dirs[] = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
  for (int si = 0; si < 4; si++) {
    const Pt c = corner[si], dv = dirs[si];
    pts.push_back(c);
    notchEdge.push_back(false);
    const auto along = [&](double q) { return dv.x != 0 ? (q - c.x) * dv.x : (q - c.y) * dv.y; };
    std::vector<Notch> list;
    for (const Notch& n : notches)
      if (n.side == sides[si]) list.push_back(n);
    std::stable_sort(list.begin(), list.end(), [&](const Notch& a, const Notch& b2) { return along(a.at) < along(b2.at); });
    const Pt inward{-dv.y, dv.x};
    for (const Notch& n : list) {
      const double t0 = along(n.at);
      const Pt P0{c.x + dv.x * t0, c.y + dv.y * t0};
      const int segs = 12;
      for (int k = 0; k <= segs; k++) {
        const double a = PI - (PI * k) / segs;
        pts.push_back({P0.x + n.r * (js::cos(a) * dv.x + js::sin(a) * inward.x), P0.y + n.r * (js::cos(a) * dv.y + js::sin(a) * inward.y)});
        notchEdge.push_back(k < segs);
      }
    }
  }
  // the plain edges: a castellation's own hole is drawn by its lead
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (notchEdge[i]) continue;
    const Pt a = pts[i], c = pts[(i + 1) % pts.size()];
    m.face4({a.x, a.y, z0}, {c.x, c.y, z0}, {c.x, c.y, zt}, {a.x, a.y, zt});
  }
  m.cap(pts, z0, false);
  m.cap(pts, zt, true);
}

/**
 * One descriptor as a mesh: built around its `at` point, turned by `rot` about it, then put
 * through its frame M. `notches` are the notches a castellated slab cuts, in the frame the
 * body is drawn in.
 */
MB desc_mesh(const Val& d, const std::vector<Notch>* notches, bool dropFrame = false) {
  MB m;
  m.name = U();
  if (F(d, K_empty).truthy()) return m;
  const auto& rot = A(F(d, K_rot));
  const bool turned = F(d, K_rot).truthy() && rot.size() >= 3 && (rot[0].truthy() || rot[1].truthy() || rot[2].truthy());
  const Val& atv = F(d, K_at);
  const P3 at = atv.truthy() ? P3{N(A(atv)[0]), N(A(atv)[1]), A(atv).size() > 2 ? N(A(atv)[2]) : NAN} : P3{0, 0, 0};
  const auto or0 = [](double v) { return js::truthy(v) ? v : 0.0; };
  const bool atZ = atv.truthy() && A(atv).size() > 2 && A(atv)[2].truthy();
  const P3 o = turned ? P3{0, 0, 0} : P3{at[0], at[1], atZ ? at[2] : 0};
  const auto seg = [&](double n) { return F(d, K_segments).truthy() ? F(d, K_segments).num() : n; };
  const auto rad = [](double a) { return a * D2R; };
  const U op = S(F(d, K_op));
  if (op == u"box") boxC(m, o[0], o[1], o[2], N(F(d, K_w)), N(F(d, K_l)), N(F(d, K_h)));
  else if (op == u"slab") {
    static const std::vector<Notch> none;
    slab(m, o, N(F(d, K_w)), N(F(d, K_l)), N(F(d, K_h)), F(d, K_castellated).truthy() && notches ? *notches : none);
  } else if (op == u"cylinder") {
    const double z1 = o[2] + N(F(d, K_h));
    if (!F(d, K_from).nullish())
      shell(m, o[0], o[1], o[2], z1, N(F(d, K_d)) / 2, N(F(d, K_d2)) / 2, rad(N(F(d, K_from))), rad(N(F(d, K_to))), seg(32));
    else {
      const Val& open = F(d, K_open);
      const Caps caps = is(open, u"both") ? Caps::None : is(open, u"top") ? Caps::Bottom : is(open, u"bottom") ? Caps::Top : Caps::Both;
      frustum(m, o[0], o[1], o[2], z1, N(F(d, K_d)) / 2, N(F(d, K_d2)) / 2, seg(32), caps);
    }
  } else if (op == u"sphere") {
    const double n = seg(16);
    ellipsoid(m, o[0], o[1], o[2] + N(F(d, K_h)) / 2, N(F(d, K_d)) / 2, N(F(d, K_d)) / 2, N(F(d, K_h)) / 2, n, js::max(2, js::round(n / 2)));
  } else if (op == u"disc") {
    const bool up = !F(d, K_down).truthy();
    if (!F(d, K_from).nullish())
      ring_sector(m, o[0], o[1], o[2], N(F(d, K_r0)), N(F(d, K_r1)), rad(N(F(d, K_from))), rad(N(F(d, K_to))), seg(32), up);
    else if (N(F(d, K_r0)) > 0) ring(m, o[0], o[1], o[2], N(F(d, K_r0)), N(F(d, K_r1)), seg(32), up);
    else m.cap(circle_pts(o[0], o[1], N(F(d, K_r1)), seg(32)), o[2], up);
  } else if (op == u"prism") {
    Poly pts;
    for (const Pt& q : pts_of(F(d, K_path))) pts.push_back({o[0] + q.x, o[1] + q.y});
    pts = geom::ensure_ccw(pts);
    loft(m, {{o[2], pts}, {o[2] + N(F(d, K_h)), pts}});
  } else if (op == u"face") {
    Poly pts;
    for (const Pt& q : pts_of(F(d, K_path))) pts.push_back({o[0] + q.x, o[1] + q.y});
    m.cap(pts, o[2], !F(d, K_down).truthy());
  } else if (op == u"loft") {
    std::vector<Ring> rings;
    for (const Val& r : A(F(d, K_rings))) rings.push_back({o[2] + N(F(r, K_z)), rect_pts(o[0], o[1], N(F(r, K_w)), N(F(r, K_l)))});
    loft(m, rings);
  } else if (op == u"sweep" || op == u"wire") {
    Poly path = pts_of(F(d, K_path));
    if (F(d, K_fillet).truthy()) {
      std::vector<bool> keep;
      const bool hasKeep = F(d, K_keep).truthy();
      for (const Val& k : A(F(d, K_keep))) keep.push_back(k.truthy());
      path = fillet(path, N(F(d, K_fillet)), F(d, K_step), hasKeep ? &keep : nullptr);
    }
    if (op == u"sweep") sweep_rect(m, path, N(F(d, K_w)), N(F(d, K_t)), o);
    else {
      std::vector<P3> p3;
      for (const Pt& q : path) p3.push_back({o[0] + q.x, o[1], o[2] + q.y});
      tube(m, p3, N(F(d, K_d)) / 2, seg(12));
    }
  }
  if (turned) apply_frame(m, geom::frame3({or0(at[0]), or0(at[1]), or0(at[2])}, {N(rot[0]), N(rot[1]), N(rot[2])}));
  if (!dropFrame && F(d, K_M).truthy()) apply_frame(m, frame_of(F(d, K_M)));
  return m;
}

/** Meshes by name, kind and color, in the order each first appears. */
struct Parts {
  std::vector<std::shared_ptr<MB>> list;
  std::unordered_map<U, std::shared_ptr<MB>> map;
  void add(const std::optional<U>& name, const U& kind, const Mat& mat, const Val& src, const MB& m) {
    if (m.i.empty()) return;
    const U key = (name ? *name : U(u"null")) + U(1, u'\0') + kind + U(1, u'\0') + js::to_u16string(mat.color[0]) + u"," + js::to_u16string(mat.color[1]) +
                  u"," + js::to_u16string(mat.color[2]) + U(1, u'\0') + js::to_u16string(mat.metal);
    auto& t = map[key];
    if (!t) {
      t = std::make_shared<MB>();
      t->name = name;
      t->kind = kind;
      t->mat = mat;
      t->src = src;
      list.push_back(t);
    }
    t->append(m);
  }
};

/** A copy of a mesh through a frame. */
MB clone_through(const MB& from, const Frame& M, const U& name, const U& kind, const Mat& mat, const Val& src) {
  MB m;
  m.name = name;
  m.kind = kind;
  m.mat = mat;
  m.src = src.truthy() ? src : Val(list());
  m.p = from.p;
  m.n = from.n;
  m.i = from.i;
  apply_frame(m, M);
  return m;
}

const char16_t* style_name(const U& s) {
  static const std::pair<const char16_t*, const char16_t*> T[] = {
      {u"molded", u"molded body"}, {u"sawn", u"sawn (leadless) body"}, {u"chip", u"chip body"}, {u"melf", u"MELF body"},
      {u"bga", u"BGA substrate and mold cap"}, {u"cga", u"ceramic body on solder columns"}, {u"dip", u"molded DIP body"},
      {u"header", u"housing"}, {u"can", u"can"}, {u"led", u"LED"}, {u"radial", u"radial body"}, {u"axial", u"axial body"},
      {u"module", u"module board"}, {u"block", u"plain block"}};
  for (const auto& [k, v] : T)
    if (s == k) return v;
  return nullptr;
}
const char16_t* style_short(const U& s) {
  static const std::pair<const char16_t*, const char16_t*> T[] = {
      {u"molded", u"molded"}, {u"sawn", u"leadless"}, {u"chip", u"chip"}, {u"melf", u"MELF"}, {u"bga", u"BGA"}, {u"cga", u"CGA"},
      {u"dip", u"DIP"}, {u"header", u"header"}, {u"can", u"can"}, {u"led", u"LED"}, {u"radial", u"radial"}, {u"axial", u"axial"},
      {u"module", u"module"}, {u"block", u"block"}};
  for (const auto& [k, v] : T)
    if (s == k) return v;
  return nullptr;
}
const char16_t* form_name(const U& f) {
  static const std::pair<const char16_t*, const char16_t*> T[] = {
      {u"gullwing", u"gull-wing"}, {u"jlead", u"J-lead"}, {u"lbend", u"L-bend lead"}, {u"straight", u"straight lead"}, {u"column", u"column"},
      {u"flat", u"flat terminal"}, {u"endcap", u"end cap"}, {u"ball", u"ball"}, {u"pin", u"pin"}, {u"wire", u"wire"}, {u"tab", u"tab"},
      {u"castellated", u"castellation"}};
  for (const auto& [k, v] : T)
    if (f == k) return v;
  return nullptr;
}
const char16_t* noun(const U& f) {
  static const std::pair<const char16_t*, const char16_t*> T[] = {
      {u"gullwing", u"gull-wings"}, {u"jlead", u"J-leads"}, {u"lbend", u"L-bend leads"}, {u"straight", u"straight leads"}, {u"column", u"columns"},
      {u"flat", u"terminals"}, {u"endcap", u"caps"}, {u"ball", u"balls"}, {u"pin", u"pins"}, {u"wire", u"wires"},
      {u"castellated", u"castellations"}, {u"tab", u"tabs"}};
  for (const auto& [k, v] : T)
    if (f == k) return v;
  return nullptr;
}

double sign_of(const U& side) { return side == u"left" || side == u"bottom" ? -1 : side == u"right" || side == u"top" ? 1 : NAN; }

/** The hook that draws a lead, or none when the body draws it. */
std::optional<U> lead_hook_of(const Val& style, const Val& l) {
  const U f = S(F(l, K_form));
  const bool side = F(l, K_side).truthy();
  if (f == u"endcap" && (is(style, u"chip") || is(style, u"melf"))) return std::nullopt;   // the body draws its caps
  if (f == u"castellated") return side ? std::optional<U>(u"lead_castellated") : std::nullopt;
  if (f == u"pin" || f == u"wire") {
    if (is(style, u"dip") && side) return U(u"lead_dip");
    if (is(style, u"axial")) return U(u"lead_axial");
    if (is(style, u"header")) return U(u"lead_header");
    return U(u"lead_tht");
  }
  if (f == u"ball" || f == u"column" || f == u"tab") return u"lead_" + f;
  if (!side) return U(u"lead_contact");
  return u"lead_" + f;
}
bool sided_hook(const U& h) {
  return h == u"lead_gullwing" || h == u"lead_jlead" || h == u"lead_lbend" || h == u"lead_straight" || h == u"lead_flat" || h == u"lead_endcap" ||
         h == u"lead_tab" || h == u"lead_castellated" || h == u"lead_dip" || h == u"lead_axial";
}

/** The axis a chip lies along: its pins' sides, or its longer side. */
U chip_axis(const Val& res, const Val& b) {
  bool lr = false, tb = false;
  for (const Val& l : A(F(res, K_leads))) {
    lr = lr || is(F(l, K_side), u"left") || is(F(l, K_side), u"right");
    tb = tb || is(F(l, K_side), u"top") || is(F(l, K_side), u"bottom");
  }
  if (lr) return u"x";
  if (tb) return u"y";
  return N(F(b, K_w)) >= N(F(b, K_l)) ? u"x" : u"y";
}

/** A number as JSON.stringify writes it (for memo keys). */
U json_num(double v) { return std::isfinite(v) ? (v == 0 ? U(u"0") : js::to_u16string(v)) : U(u"null"); }
U json_str(const U& s) {
  std::string out;
  json::quote(s, out);
  return from_utf8(out);
}
U json_ev(const EV& v) {
  static const char16_t* kinds[] = {u"num", u"ratio", u"len", u"str", u"color"};
  U out = U(u"{\"k\":\"") + kinds[static_cast<int>(v.k)] + u"\",\"v\":";
  if (v.k == compiler::VK::Str) out += json_str(v.s);
  else if (v.k == compiler::VK::Color)
    out += u"{\"rgb\":[" + json_num(v.c->rgb[0]) + u"," + json_num(v.c->rgb[1]) + u"," + json_num(v.c->rgb[2]) + u"],\"metal\":" + json_num(v.c->metal) +
           u",\"name\":" + (v.c->name ? json_str(*v.c->name) : U(u"null")) + u"}";
  else out += json_num(v.v);
  return out + u"}";
}

using Values = std::vector<std::pair<U, EV>>;
void put(Values& vs, const U& k, EV v) {
  for (auto& e : vs)
    if (e.first == k) {
      e.second = std::move(v);
      return;
    }
  vs.push_back({k, std::move(v)});
}

// The engine: measures the part, asks the standard library (or the user's features) to draw
// it, and builds the meshes.
class Engine {
 public:
  Engine(const compiler::Result& r, bool strict, Model& out, std::vector<MB>& meshes)
      : res_(r.rec), b_(*r.builder), strict_(strict), out_(out), meshes_(meshes), md_(F(res_, K_model)), P_(F(md_, K_props)) {}

  void run();

 private:
  Val res_;
  Builder& b_;
  bool strict_;
  Model& out_;
  std::vector<MB>& meshes_;
  Val md_, P_;
  std::unordered_map<U, std::vector<std::shared_ptr<MB>>> memo_;
  Mat solidColor_, bodyColor_;

  HookBindingP bindHook(bool body, const U& name, const Values& values, std::vector<U> flags, const ObjP& trigger, const Val& written);
  std::vector<std::shared_ptr<MB>> meshesOf(const HookBindingP& B, const U& kind, const Mat& mat, const std::function<std::optional<U>(const U&)>& name,
                                            const std::vector<Notch>* notches);
  std::optional<Pt> stripeEnd();
  void extraSolids(const Mat* bodyMat, double bodyTop);
};

/** Bind a hook, working out the derived flags it asks for: a hook that declares `NAME_if`
 *  gets flag NAME when it's above zero, else the second flag. */
HookBindingP Engine::bindHook(bool body, const U& name, const Values& values, std::vector<U> fl, const ObjP& trigger, const Val& written) {
  static const std::vector<std::pair<U, U>> BODY{{u"drafted", u"plain"}, {u"tall", U()}, {u"shield", u"unshielded"}, {u"vented", U()}};
  static const std::vector<std::pair<U, U>> LEAD{{u"fine", U()}, {u"wide", U()}, {u"coarse", U()}, {u"straddle", U()}, {u"flush", U()},
                                                 {u"bent", u"cramped"}, {u"under", u"beyond"}, {u"socket", U()}};
  fl.erase(std::remove(fl.begin(), fl.end(), U()), fl.end());
  HookBindingP B = b_.hookBind(name, values, fl, trigger, written);
  for (const auto& [flag, alt] : body ? BODY : LEAD) {
    if (!B->has(flag + u"_if")) continue;
    const auto v = B->test(flag + u"_if");
    if (v && *v > 0) fl.push_back(flag);
    else if (!alt.empty()) fl.push_back(alt);
    else continue;
    B = b_.hookBind(name, values, fl, trigger, written);
  }
  return B;
}

/** A hook's solids as meshes in its own frame. */
std::vector<std::shared_ptr<MB>> Engine::meshesOf(const HookBindingP& B, const U& kind0, const Mat& mat0,
                                                  const std::function<std::optional<U>(const U&)>& nameOf, const std::vector<Notch>* notches) {
  Parts parts;
  for (const ObjP& dp : B->solids(std::nullopt)) {
    const Val d = dp;
    const U kind = F(d, K_kind).truthy() ? S(F(d, K_kind)) : kind0;
    const std::optional<U> name = F(d, K_name).truthy() ? std::optional<U>(S(F(d, K_name))) : nameOf(kind);
    const Mat mat = F(d, K_color).truthy() ? mat_of(F(d, K_color)) : mat0;
    parts.add(name, kind, mat, list(), desc_mesh(d, notches));
  }
  return parts.list;
}

void Engine::run() {
  const Val b = F(res_, K_body);
  auto& notes = out_.notes;
  std::vector<Val> leads;
  for (const Val& l : A(F(res_, K_leads)))
    if (!is(F(l, K_form), u"none")) leads.push_back(l);
  if (F(md_, K_step).truthy())
    notes.push_back(u"Uses the STEP file " + S(F(F(md_, K_step), K_file)) + u", which the demo can't load, so this is the generated model.");
  try {
    solidColor_ = mat_of(b_.hookLibColor(u"solid_color"));
  } catch (...) {
    solidColor_ = EPOXY;
  }
  const auto extras = [&]() { return !F(md_, K_extras).nullish() ? N(F(md_, K_extras)) : static_cast<double>(A(F(md_, K_solids)).size()); };
  if (!b.truthy()) {
    if (!A(F(md_, K_solids)).empty()) notes.push_back(u"No body, so only the extra solids are shown.");
    else notes.push_back(u"No body. Add `body W x L x H` to generate a model.");
    extraSolids(nullptr, 0);
    const double nx = extras();
    out_.summary = js::truthy(nx) ? Val(js::to_u16string(nx) + u" part" + (nx > 1 ? u"s" : u"")) : Val(nullptr);
    return;
  }
  const Val style = F(res_, K_style);
  out_.style = style;
  const Val fam = F(res_, K_family);
  Val pitch = F(F(res_, K_generator), K_pitch);
  if (!pitch.truthy()) {
    pitch = nullptr;
    for (const Val& l : leads)
      if (F(l, K_pitch).truthy()) {
        pitch = F(l, K_pitch);
        break;
      }
  }
  double ballD = 0.5;
  for (const Val& l : leads)
    if (is(F(l, K_form), u"ball")) {
      ballD = !F(l, K_v).nullish() ? N(F(l, K_v)) : !F(l, K_d).nullish() ? N(F(l, K_d)) : (F(l, K_padAcross).truthy() ? N(F(l, K_padAcross)) : 0.5) / 0.8;
      break;
    }
  const Val bodySrc = F(b, K_src).truthy() ? F(b, K_src) : Val(list());
  const ObjP bodyTrigger = !A(bodySrc).empty() && A(bodySrc)[0].is_obj() ? A(bodySrc)[0].obj() : nullptr;
  const Val shape = F(P_, K_bodyShape).truthy() ? F(P_, K_bodyShape) : Val(nullptr);
  const U bodyHook = shape.truthy() ? S(F(F(shape, K_call), K_name)) : u"body_" + (style.is_str() ? style.str() : U(u"null"));

  // what the body is drawn from
  Values BV{{u"W", EV::len(N(F(b, K_w)))}, {u"L", EV::len(N(F(b, K_l)))}, {u"ball_d", EV::len(ballD)}};
  if (!F(P_, K_draft).nullish()) put(BV, u"draft", EV::num(N(F(P_, K_draft))));
  if (F(P_, K_bodyColor).truthy()) put(BV, u"body_color", EV::color(color_of(F(P_, K_bodyColor))));
  if (F(P_, K_leadsColor).truthy()) put(BV, u"lead_color", EV::color(color_of(F(P_, K_leadsColor))));
  if (!pitch.nullish()) put(BV, u"e", EV::len(N(pitch)));
  if (!F(P_, K_above).nullish()) put(BV, u"above", EV::len(N(F(P_, K_above))));
  double castD = 0;
  for (const Val& l : leads)
    if (is(F(l, K_form), u"castellated") && F(l, K_side).truthy())
      castD = js::max(castD, N(orv(F(l, K_castellated), orv(F(l, K_d), orv(F(l, K_v), Val(0.6))))));
  put(BV, u"cast_d", EV::len(castD));
  const auto turnOf = [](const U& ax) { return ax == u"y" ? 90.0 : 0.0; };
  if (is(style, u"chip")) {
    put(BV, u"turn", EV::num(turnOf(chip_axis(res_, b))));
    Val L0 = F(res_, K_lead);
    if (!L0.truthy()) {
      L0 = Val();
      for (const Val& l : leads)
        if (is(F(l, K_form), u"endcap")) {
          L0 = l;
          break;
        }
    }
    if (L0.truthy()) {
      const Val& T = !F(L0, K_l).nullish() ? F(L0, K_l) : !F(L0, K_v).nullish() ? F(L0, K_v) : F(L0, K_d);
      if (!T.nullish()) put(BV, u"T", EV::len(N(T)));
    }
  } else if (is(style, u"melf") || is(style, u"axial")) {
    put(BV, u"turn", EV::num(turnOf(F(b, K_axial).truthy() ? S(F(b, K_axial)) : U(u"x"))));
    if (is(style, u"melf") && F(res_, K_lead).truthy() && !F(F(res_, K_lead), K_v).nullish()) put(BV, u"T", EV::len(N(F(F(res_, K_lead), K_v))));
  }
  std::vector<U> baseFlags{S(style), S(F(res_, K_mainForm)), S(fam)};
  const Val p1 = F(res_, K_pin1);
  if (p1.truthy() && (is(F(p1, K_style), u"dot") || is(F(p1, K_style), u"chamfer"))) baseFlags.push_back(u"silk_mark");

  // the standoff and height
  HookBindingP B0 = b_.hookBind(bodyHook, BV, baseFlags, bodyTrigger, shape);
  double H = !F(P_, K_height).nullish() ? N(F(P_, K_height)) : N(F(b, K_h));
  const bool hNull = F(P_, K_height).nullish() && F(b, K_h).nullish();
  double z0 = !F(P_, K_standoff).nullish() ? N(F(P_, K_standoff)) : (B0->has(u"z0") ? B0->len(u"z0") : 0);
  if (hNull) {
    notes.push_back(u"The body has no height, so it's drawn as a thin plate. Add one: `body W x L x H`.");
    H = z0 + 0.1;
  }
  const auto fmt = [](double v) { return js::to_u16string(js::round(v * 1000) / 1000); };
  if (z0 >= H - 0.02) {
    if (!F(P_, K_standoff).nullish()) notes.push_back(u"The standoff (" + fmt(z0) + u") reaches the body top (" + fmt(H) + u"), so it was lowered.");
    z0 = js::max(0, js::min(z0, H * 0.5));
  }
  out_.H = H;
  out_.standoff = z0;
  put(BV, u"H", EV::len(H));
  put(BV, u"z0", EV::len(z0));
  B0 = b_.hookBind(bodyHook, BV, baseFlags, bodyTrigger, shape);

  // the mark: from the model block, the polarity, or pin 1's silk
  U mark = F(P_, K_pin1).truthy() ? S(F(P_, K_pin1)) : U();
  if (mark.empty()) {
    if (F(res_, K_polarized).truthy()) mark = u"stripe";
    else if (!p1.truthy() || (F(p1, K_explicit).truthy() && is(F(p1, K_style), u"none"))) mark = u"none";
    else if (is(F(p1, K_style), u"notch")) mark = u"notch";
    else if (is(F(p1, K_style), u"bar")) mark = u"stripe";
    else mark = B0->has(u"pin1_mark") ? B0->str(u"pin1_mark") : U(u"none");
  }
  std::vector<U> flags = baseFlags;
  std::optional<Color> bodyColor;
  if (F(P_, K_bodyColor).truthy()) bodyColor = color_of(F(P_, K_bodyColor));
  else if (B0->has(u"body_color")) bodyColor = B0->color(u"body_color");
  flags.push_back(bodyColor && js::truthy(bodyColor->metal) ? u"bare" : u"sleeved");
  // where the marks point
  const double bx = N(F(b, K_x)), by = N(F(b, K_y));
  if (p1.truthy()) {
    const double sx = js::sign(js::round((N(F(p1, K_x)) - bx) * 1e6));
    const double sy = js::sign(js::round((N(F(p1, K_y)) - by) * 1e6));
    put(BV, u"sx", EV::num(sx));
    put(BV, u"sy", EV::num(sy));
    const Val g = F(res_, K_generator);
    bool rowsLR = false;
    if (g.truthy()) {
      rowsLR = is(F(g, K_kind), u"dual");
      for (const Val& l : leads) rowsLR = rowsLR || is(F(l, K_side), u"left") || is(F(l, K_side), u"right");
    }
    if (rowsLR) {
      put(BV, u"nx", EV::num(0));
      put(BV, u"ny", EV::num(js::truthy(sy) ? sy : 1));
    } else {
      put(BV, u"nx", EV::num(js::truthy(sx) ? sx : -1));
      put(BV, u"ny", EV::num(0));
    }
  }
  if (mark == u"stripe") {
    if (const auto to = stripeEnd()) {
      const double dx = to->x - bx, dy = to->y - by;
      const U ax = is(style, u"chip") ? chip_axis(res_, b)
                   : (is(style, u"melf") || is(style, u"axial")) ? (F(b, K_axial).truthy() ? S(F(b, K_axial)) : U(u"x"))
                                                                  : (std::fabs(dx) >= std::fabs(dy) ? U(u"x") : U(u"y"));
      const double sgn = (ax == u"x" ? dx : dy) < 0 ? -1 : 1;
      put(BV, u"ex", EV::num(ax == u"x" ? sgn : 0));
      put(BV, u"ey", EV::num(ax == u"y" ? sgn : 0));
      put(BV, u"ma", EV::num(js::atan2(dy, dx) / D2R));
    } else mark = u"none";
  }
  if (mark != u"none") flags.push_back(mark);
  const HookBindingP B = bindHook(true, bodyHook, BV, flags, bodyTrigger, shape);
  if (mark != u"none" && !B->flags().has(mark)) mark = u"none";
  Values exp;
  for (const char16_t* k : {u"zp", u"housing", u"zc", u"len", u"ts"})
    if (B->has(k)) exp.push_back({k, EV::len(B->len(k))});
  const double bodyTop = B->has(u"top") ? B->len(u"top") : H;
  bodyColor_ = B->has(u"body_color") ? mat_of(B->color(u"body_color")) : (bodyColor ? mat_of(*bodyColor) : solidColor_);
  const Mat leadColor = F(P_, K_leadsColor).truthy() ? mat_of(F(P_, K_leadsColor)) : (B->has(u"lead_color") ? mat_of(B->color(u"lead_color")) : TIN);
  ArrP markSrc = list(A(F(md_, K_src)));
  for (const Val& n : A(F(res_, K_markSrc))) markSrc->a.push_back(n);

  // the body's meshes; its marks go after the leads
  std::vector<Notch> castellations;
  for (const Val& l : leads) {
    if (!is(F(l, K_form), u"castellated") || !F(l, K_side).truthy()) continue;
    const bool lr = is(F(l, K_side), u"left") || is(F(l, K_side), u"right");
    castellations.push_back({S(F(l, K_side)), lr ? N(F(l, K_y)) - by : N(F(l, K_x)) - bx, N(orv(F(l, K_castellated), orv(F(l, K_d), orv(F(l, K_v), Val(0.6))))) / 2});
  }
  const Val leadSrc = F(res_, K_lead).truthy() ? F(F(res_, K_lead), K_src) : Val(list());
  std::vector<MB> marks;
  const auto bodyParts = meshesOf(B, u"body", bodyColor_, [](const U& k) -> std::optional<U> { return k == u"lead" ? u"lead" : k == u"mark" ? u"mark" : u"body"; },
                                  &castellations);
  const Frame atBody{1, 0, 0, bx, 0, 1, 0, by, 0, 0, 1, 0};
  for (const auto& p : bodyParts) {
    MB m = clone_through(*p, atBody, p->name ? *p->name : U(u"null"), p->kind, p->mat,
                         p->kind == u"body" ? bodySrc : p->kind == u"lead" ? leadSrc : Val(markSrc));
    if (p->kind == u"mark") marks.push_back(std::move(m));
    else meshes_.push_back(std::move(m));
  }

  // leads
  double nLeads = 0;
  const Val leadShape = F(P_, K_leadsShape).truthy() ? F(P_, K_leadsShape) : Val(nullptr);
  for (const Val& l : leads) {
    const std::optional<U> hook = leadShape.truthy() ? std::optional<U>(S(F(F(leadShape, K_call), K_name))) : lead_hook_of(style, l);
    if (!hook) continue;
    const bool hasSide = F(l, K_side).truthy();
    const bool sided = (hasSide && sided_hook(*hook)) || (leadShape.truthy() && hasSide);
    const U side = S(F(l, K_side));
    const bool lr = side == u"left" || side == u"right";
    Values lv{{u"z0", EV::len(z0)}, {u"H", EV::len(H)}};
    if (F(l, K_padAcross).truthy()) put(lv, u"pad_across", EV::len(N(F(l, K_padAcross))));
    if (F(l, K_padAlong).truthy()) put(lv, u"pad_along", EV::len(N(F(l, K_padAlong))));
    for (const auto& [k, v] : exp) put(lv, k, v);
    if (hasSide) {
      // a frame on the lead's side: u outward from the body center, v along the side
      const double s = sign_of(side);
      const double uEdge = lr ? N(F(b, K_w)) / 2 : N(F(b, K_l)) / 2;
      const double uPad = lr ? (N(F(l, K_x)) - bx) * s : (N(F(l, K_y)) - by) * s;
      put(lv, u"edge", EV::len(uEdge));
      put(lv, u"pad_u", EV::len(uPad));
      if (!F(l, K_toe).nullish()) put(lv, u"toe", EV::len(lr ? (N(F(l, K_toe)) - bx) * s : (N(F(l, K_toe)) - by) * s));
      put(lv, u"across", EV::len(lr ? N(F(b, K_l)) : N(F(b, K_w))));
    }
    const bool wl = *hook == u"lead_tab" || *hook == u"lead_contact";
    if (!F(l, K_w).nullish()) put(lv, u"b", EV::len(N(F(l, K_w))));
    const Val& T = wl ? F(l, K_l) : (!F(l, K_l).nullish() ? F(l, K_l) : F(l, K_v));
    if (!T.nullish()) put(lv, u"T", EV::len(N(T)));
    const U form = S(F(l, K_form));
    const Val& Dm = form == u"castellated" ? orv(F(l, K_castellated), orv(F(l, K_d), F(l, K_v)))
                    : (form == u"ball" || form == u"column") ? (!F(l, K_v).nullish() ? F(l, K_v) : F(l, K_d))
                                                              : (!F(l, K_d).nullish() ? F(l, K_d) : F(l, K_v));
    if (!Dm.nullish()) put(lv, u"d", EV::len(N(Dm)));
    if (F(l, K_drill).truthy()) put(lv, u"drill", EV::len(N(F(l, K_drill))));
    const Val& e = orv(F(l, K_pitch), pitch);
    if (!e.nullish()) put(lv, u"e", EV::len(N(e)));
    if (!F(P_, K_thickness).nullish()) put(lv, u"c", EV::len(N(F(P_, K_thickness))));
    if (!F(P_, K_below).nullish()) put(lv, u"below", EV::len(N(F(P_, K_below))));
    if (F(P_, K_leadsColor).truthy()) put(lv, u"lead_color", EV::color(color_of(F(P_, K_leadsColor))));
    std::vector<U> lf{form, S(style), S(fam)};
    if (form == u"pin" || form == u"wire")
      lf.push_back(!F(l, K_d).nullish() || (F(l, K_w).nullish() && !F(l, K_v).nullish()) ? u"round" : u"square");
    const ObjP trigger = !A(F(l, K_src)).empty() && A(F(l, K_src))[0].truthy() ? A(F(l, K_src))[0].obj() : bodyTrigger;
    U key = *hook + u"|{";
    for (std::size_t i = 0; i < lv.size(); ++i) key += (i ? U(u",") : U()) + json_str(lv[i].first) + u":" + json_ev(lv[i].second);
    key += u"}|";
    for (std::size_t i = 0; i < lf.size(); ++i) key += (i ? U(u",") : U()) + lf[i];
    auto mit = memo_.find(key);
    if (mit == memo_.end()) {
      std::vector<std::shared_ptr<MB>> parts;
      try {
        const HookBindingP LB = bindHook(false, *hook, lv, lf, trigger, leadShape);
        const Mat mat = LB->has(u"lead_color") ? mat_of(LB->color(u"lead_color")) : leadColor;
        parts = meshesOf(LB, u"lead", mat, [](const U&) -> std::optional<U> { return std::nullopt; }, nullptr);
      } catch (const HookError&) {
        if (strict_) throw;
        parts.clear();
      }
      mit = memo_.emplace(key, std::move(parts)).first;
    }
    const Frame M = sided ? (lr ? Frame{sign_of(side), 0, 0, bx, 0, 1, 0, N(F(l, K_y)), 0, 0, 1, 0}
                                : Frame{0, 1, 0, N(F(l, K_x)), sign_of(side), 0, 0, by, 0, 0, 1, 0})
                          : Frame{1, 0, 0, N(F(l, K_x)), 0, 1, 0, N(F(l, K_y)), 0, 0, 1, 0};
    ArrP src = list(A(F(l, K_src)));
    if (F(l, K_generated).truthy() && F(res_, K_generator).truthy())
      for (const Val& n : A(F(F(res_, K_generator), K_src))) src->a.push_back(n);
    const U pad = S(F(l, K_pad));
    bool drew = false;
    for (const auto& p : mit->second) {
      // a mark a lead draws (a socket's opening) belongs to the lead's statement
      MB m = clone_through(*p, M, p->name && !p->name->empty() ? *p->name + u" " + pad : u"lead " + pad, p->kind, p->mat, src);
      if (!m.i.empty()) drew = true;
      if (p->kind == u"mark") marks.push_back(std::move(m));
      else meshes_.push_back(std::move(m));
    }
    if (drew) nLeads++;
  }

  // exposed pads under the body
  for (const Val& p : A(F(res_, K_pads))) {
    if (!F(p, K_thermal).truthy() || !b_.hookHas(u"exposed_pad")) continue;
    const Val& bb = F(p, K_bbox);
    const double x0 = N(F(bb, K_x0)), x1 = N(F(bb, K_x1)), y0 = N(F(bb, K_y0)), y1 = N(F(bb, K_y1));
    Values pv{{u"w", EV::len(x1 - x0)}, {u"l", EV::len(y1 - y0)}, {u"z0", EV::len(z0)}, {u"H", EV::len(H)}};
    if (!F(P_, K_thickness).nullish()) put(pv, u"c", EV::len(N(F(P_, K_thickness))));
    if (F(P_, K_leadsColor).truthy()) put(pv, u"lead_color", EV::color(color_of(F(P_, K_leadsColor))));
    const ObjP trigger = !A(F(p, K_src)).empty() && A(F(p, K_src))[0].truthy() ? A(F(p, K_src))[0].obj() : bodyTrigger;
    const HookBindingP EB = b_.hookBind(u"exposed_pad", pv, {S(style)}, trigger, Val(nullptr));
    const Mat mat = EB->has(u"lead_color") ? mat_of(EB->color(u"lead_color")) : leadColor;
    const U pn = S(F(p, K_name));
    const auto parts = meshesOf(EB, u"lead", mat, [&](const U&) -> std::optional<U> { return u"exposed pad " + pn; }, nullptr);
    for (const auto& q : parts)
      meshes_.push_back(clone_through(*q, {1, 0, 0, (x0 + x1) / 2, 0, 1, 0, (y0 + y1) / 2, 0, 0, 1, 0}, q->name ? *q->name : U(u"null"), q->kind, q->mat,
                                      F(p, K_src)));
  }
  for (auto& m : marks) meshes_.push_back(std::move(m));

  // extra solids
  extraSolids(&bodyColor_, bodyTop);

  // what was built
  OrderedMap<U, double> formCount;
  for (const Val& l : leads) {
    const U f = S(F(l, K_form));
    const double* c = formCount.get(f);
    formCount.set(f, (c ? *c : 0) + 1);
  }
  std::vector<U> parts2;
  if (shape.truthy()) parts2.push_back(u"body shape " + S(F(F(shape, K_call), K_name)));
  else {
    const char16_t* sn = style_name(S(style));
    parts2.push_back(sn ? U(sn) : U());
  }
  U fl;
  formCount.each([&](const U& f, double k) {
    const char16_t* fn = form_name(f);
    fl += (fl.empty() ? U() : U(u", ")) + js::to_u16string(k) + u" " + (fn ? U(fn) : f) + (k > 1 ? u"s" : u"");
  });
  if (!fl.empty()) parts2.push_back(fl);
  if (mark != u"none") parts2.push_back(mark == u"stripe" ? U(u"polarity stripe") : u"pin-1 " + mark);
  const double nx = extras();
  if (js::truthy(nx)) parts2.push_back(js::to_u16string(nx) + u" extra part" + (nx > 1 ? u"s" : u""));
  U summary;
  for (std::size_t i = 0; i < parts2.size(); ++i) summary += (i ? U(u" · ") : U()) + parts2[i];
  out_.summary = summary;
  const std::vector<U> forms = formCount.keys();
  const double nAll = static_cast<double>(leads.size());
  std::vector<U> shortParts;
  if (const char16_t* ss = style_short(S(style))) shortParts.push_back(ss);
  if (js::truthy(nAll)) {
    U what;
    if (forms.size() == 1) {
      const char16_t* nn = noun(forms[0]);
      if (!nn && nAll == 1) throw std::runtime_error("Cannot read properties of undefined (reading 'replace')");
      what = nn ? U(nn) : U(u"undefined");
      if (nAll == 1 && !what.empty() && what.back() == u's') what.pop_back();
    } else what = u"leads";
    shortParts.push_back(js::to_u16string(nAll) + u" " + what);
  }
  U shortText;
  for (std::size_t i = 0; i < shortParts.size(); ++i) shortText += (i ? U(u" · ") : U()) + shortParts[i];
  out_.short_ = shortText;
  out_.mark = mark;
  out_.leadCount = nLeads;
}

/** Where a stripe goes: the pin the polarity hook names, or pin 1. */
std::optional<Pt> Engine::stripeEnd() {
  const Val pinOne = F(res_, K_pin1);
  const auto p1pt = [&]() -> std::optional<Pt> {
    if (!pinOne.truthy()) return std::nullopt;
    return Pt{N(F(pinOne, K_x)), N(F(pinOne, K_y))};
  };
  if (F(res_, K_polarized).truthy()) {
    U pin = u"2";
    if (b_.hookHas(u"polarity")) {
      std::vector<U> fl;
      if (F(res_, K_style).truthy()) fl.push_back(S(F(res_, K_style)));
      if (F(res_, K_family).truthy()) fl.push_back(S(F(res_, K_family)));
      const HookBindingP PB = b_.hookBind(u"polarity", {}, fl, nullptr, Val(nullptr));
      if (PB->has(u"stripe_at")) pin = PB->str(u"stripe_at");
    }
    if (pin == u"1" || (pinOne.truthy() && is(F(pinOne, K_pad), pin))) return p1pt();
    const Val* found = nullptr;
    for (const Val& q : A(F(res_, K_pads)))
      if (is(F(q, K_name), pin)) {
        found = &q;
        break;
      }
    if (!found)
      for (const Val& q : A(F(res_, K_pads)))
        if (pinOne.truthy() && !(F(q, K_name).is_str() && F(pinOne, K_pad).is_str() && F(q, K_name).str() == F(pinOne, K_pad).str()) &&
            !F(q, K_thermal).truthy()) {
          found = &q;
          break;
        }
    if (!found) return std::nullopt;
    return Pt{N(F(*found, K_x)), N(F(*found, K_y))};
  }
  return p1pt();
}

/** The extra solids: a model block's own, and those of the features the footprint places. */
void Engine::extraSolids(const Mat* bodyMat, double bodyTop) {
  for (const Val& d : A(F(md_, K_solids))) {
    const Mat mat = F(d, K_color).truthy() ? mat_of(F(d, K_color)) : (bodyMat ? *bodyMat : solidColor_);
    const bool place = F(d, K_place).truthy();
    MB m = desc_mesh(d, nullptr, place);
    m.name = F(d, K_name).truthy() ? S(F(d, K_name)) : S(F(d, K_op));
    m.kind = F(d, K_kind).truthy() ? S(F(d, K_kind)) : U(u"solid");
    m.mat = mat;
    m.src = F(d, K_src).truthy() ? F(d, K_src) : Val(list());
    if (place) {
      double x0 = INF, y0 = INF, zmin = INF, x1 = -INF, y1 = -INF;
      for (std::size_t k = 0; k < m.p.size(); k += 3) {
        x0 = js::min(x0, m.p[k]);
        x1 = js::max(x1, m.p[k]);
        y0 = js::min(y0, m.p[k + 1]);
        y1 = js::max(y1, m.p[k + 1]);
        zmin = js::min(zmin, m.p[k + 2]);
      }
      const Val& pl = F(d, K_place);
      const double zBase = !F(pl, K_z).nullish() ? N(F(pl, K_z)) : (F(d, K_onBody).truthy() ? bodyTop : 0);
      const double dx = N(F(pl, K_x)) - (x0 + x1) / 2, dy = N(F(pl, K_y)) - (y0 + y1) / 2, dz = zBase - zmin;
      m.transform([&](double x, double y, double z) -> P3 { return {x + dx, y + dy, z + dz}; }, [](double x, double y, double z) -> P3 { return {x, y, z}; });
    } else if (F(d, K_lift).truthy()) {
      m.transform([&](double x, double y, double z) -> P3 { return {x, y, z + bodyTop}; }, [](double x, double y, double z) -> P3 { return {x, y, z}; });
    }
    meshes_.push_back(std::move(m));
  }
}

void finalize(Model& out, std::vector<MB>& meshes) {
  Box3 bb{INF, INF, INF, -INF, -INF, -INF};
  double tris = 0, top = -INF;
  out.meshes.clear();
  for (MB& m : meshes) {
    if (m.i.empty()) continue;
    Mesh f = m.finish();
    for (std::size_t k = 0; k < f.pos.size(); k += 3) {
      const double x = f.pos[k], y = f.pos[k + 1], z = f.pos[k + 2];
      if (x < bb.x0) bb.x0 = x;
      if (x > bb.x1) bb.x1 = x;
      if (y < bb.y0) bb.y0 = y;
      if (y > bb.y1) bb.y1 = y;
      if (z < bb.z0) bb.z0 = z;
      if (z > bb.z1) bb.z1 = z;
      if (f.kind != u"mark" && z > top) top = z;
    }
    tris += static_cast<double>(f.idx.size() / 3);
    out.meshes.push_back(std::move(f));
  }
  if (std::isfinite(bb.x0)) out.bbox = bb;
  else out.bbox.reset();
  if (std::isfinite(top)) out.top = js::round(top * 1e6) / 1e6;   // the part's highest point (marks aside)
  else out.top.reset();
  out.triangles = tris;
}

}  // namespace

Model build(const compiler::Result& r, bool strict) {
  Model out;
  const Val res = r.rec;
  const Val md = F(res, K_model);
  out.none = F(md, K_none).truthy();
  std::vector<MB> meshes;
  if (out.none) {
    finalize(out, meshes);
    return out;
  }
  try {
    Engine(r, strict, out, meshes).run();
  } catch (const HookError&) {
    if (strict) throw;
  } catch (const std::exception& err) {
    if (strict) throw;
    out.diagnostics.push_back(rec({{K_severity, u"error"}, {K_message, u"internal error while building the 3D model: " + js::u16(err.what())}, {K_s, 0}, {K_e, 0}}));
  }
  for (const auto& d : r.builder->hookTake()) out.diagnostics.push_back(compiler::diag_val(d));
  if (strict) {
    U msg;
    for (const Val& d : out.diagnostics)
      if (is(F(d, K_severity), u"error")) msg += (msg.empty() ? U() : U(u"; ")) + S(F(d, K_message));
    if (!msg.empty()) throw std::runtime_error("3D model: " + to_utf8(msg));
  }
  finalize(out, meshes);
  return out;
}

// The board (viewer only)
namespace {
constexpr double BOARD_T = 1.6, CU = 0.035;
}

Model board(const ObjP& resp, const Model* model) {
  const Val res = resp;
  std::vector<MB> meshes;
  geom::Box bb;
  const auto box_of = [](const Val& v) { return geom::Box{N(F(v, K_x0)), N(F(v, K_y0)), N(F(v, K_x1)), N(F(v, K_y1))}; };
  for (const Val& p : A(F(res, K_pads))) bb = geom::union_box(bb, box_of(F(p, K_bbox)));
  for (const Val& h : A(F(res, K_holes))) bb = geom::union_box(bb, box_of(F(h, K_bbox)));
  if (F(res, K_courtyardBox).truthy()) bb = geom::union_box(bb, box_of(F(res, K_courtyardBox)));
  if (F(res, K_body).truthy()) {
    const Val& b = F(res, K_body);
    const double x = N(F(b, K_x)), y = N(F(b, K_y)), w = N(F(b, K_w)), l = N(F(b, K_l));
    bb = geom::union_box(bb, {x - w / 2, y - l / 2, x + w / 2, y + l / 2});
  }
  if (model && model->bbox) bb = geom::union_box(bb, {model->bbox->x0, model->bbox->y0, model->bbox->x1, model->bbox->y1});
  if (!geom::box_valid(bb)) bb = {-2, -2, 2, 2};
  const double span = js::max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const double mg = clamp(0.25 * span, 1, 6);
  const double X0 = bb.x0 - mg, X1 = bb.x1 + mg, Y0 = bb.y0 - mg, Y1 = bb.y1 + mg;
  const auto mesh = [](const char16_t* name, const char16_t* kind, const char* color, double metal) {
    MB m;
    m.name = U(name);
    m.kind = kind;
    m.mat = {hex(color), metal};
    m.src = list();
    return m;
  };
  MB slab0 = mesh(u"board", u"board", "#1d5a39", 0);
  slab0.face4({X0, Y0, 0}, {X1, Y0, 0}, {X1, Y1, 0}, {X0, Y1, 0});
  slab0.face4({X0, Y0, -BOARD_T}, {X0, Y1, -BOARD_T}, {X1, Y1, -BOARD_T}, {X1, Y0, -BOARD_T});
  MB edge = mesh(u"board edge", u"board", "#bfae78", 0);
  const auto E = [&](Pt a, Pt b) { edge.face4({a.x, a.y, -BOARD_T}, {b.x, b.y, -BOARD_T}, {b.x, b.y, 0}, {a.x, a.y, 0}); };
  E({X0, Y0}, {X1, Y0});
  E({X1, Y0}, {X1, Y1});
  E({X1, Y1}, {X0, Y1});
  E({X0, Y1}, {X0, Y0});
  MB cu = mesh(u"copper", u"copper", "#d3a64c", 1);
  MB hole = mesh(u"holes", u"hole", "#0c0d0d", 0);
  MB barrel = mesh(u"plating", u"copper", "#b97a46", 1);
  const auto prism = [](MB& m, const Poly& pts, double za, double zb) {
    const Poly P = geom::ensure_ccw(pts);
    m.cap(P, za, false);
    m.cap(P, zb, true);
    for (std::size_t i = 0; i < P.size(); ++i) {
      const Pt a = P[i], c = P[(i + 1) % P.size()];
      m.face4({a.x, a.y, za}, {c.x, c.y, za}, {c.x, c.y, zb}, {a.x, a.y, zb});
    }
  };
  const auto poly = [](const Val& contour) {
    geom::Contour c;
    for (const Val& e : A(contour)) {
      geom::Edge ed;
      ed.arc = is(F(e, K_t), u"A");
      ed.a = pt(F(e, K_a));
      ed.b = pt(F(e, K_b));
      if (ed.arc) {
        ed.c = pt(F(e, K_c));
        ed.r = N(F(e, K_r));
        ed.a0 = N(F(e, K_a0));
        ed.a1 = N(F(e, K_a1));
      }
      c.push_back(ed);
    }
    return geom::dedupe(geom::contour_to_poly(c, 12 * D2R), true);
  };
  for (const Val& p : A(F(res, K_pads))) {
    if (!F(p, K_copper).truthy()) continue;
    const Poly pts = poly(F(p, K_copper));
    if (pts.size() < 3) continue;
    prism(cu, pts, 0, CU);
    if (F(p, K_tht).truthy()) prism(cu, pts, -BOARD_T - CU, -BOARD_T);
    if (F(p, K_drillShape).truthy()) {
      const Poly dp = geom::ensure_ccw(poly(F(p, K_drillShape)));
      if (dp.size() >= 3) {
        hole.cap(dp, CU + 0.001, true);
        hole.cap(dp, -BOARD_T - CU - 0.001, false);
        for (std::size_t i = 0; i < dp.size(); ++i) {
          const Pt a = dp[i], c = dp[(i + 1) % dp.size()];
          barrel.face4({c.x, c.y, -BOARD_T - CU}, {a.x, a.y, -BOARD_T - CU}, {a.x, a.y, CU}, {c.x, c.y, CU});
        }
      }
    }
    for (const Val& v : A(F(p, K_vias))) ring(hole, N(F(v, K_x)), N(F(v, K_y)), CU + 0.001, 0, N(F(v, K_d)) / 2, 16, true);
  }
  for (const Val& h : A(F(res, K_holes))) {
    const Poly dp = geom::ensure_ccw(poly(F(h, K_land)));
    if (dp.size() < 3) continue;
    hole.cap(dp, 0.001, true);
    hole.cap(dp, -BOARD_T - 0.001, false);
    for (std::size_t i = 0; i < dp.size(); ++i) {
      const Pt a = dp[i], c = dp[(i + 1) % dp.size()];
      edge.face4({c.x, c.y, -BOARD_T}, {a.x, a.y, -BOARD_T}, {a.x, a.y, 0}, {c.x, c.y, 0});
    }
  }
  // silk
  MB silk = mesh(u"silk", u"silk", "#eeeee8", 0);
  const double zs = 0.012;
  const auto seg = [&](Pt a, Pt c, double w) {
    const double dx = c.x - a.x, dy = c.y - a.y, L = js::hypot({dx, dy});
    if (L < 1e-9) return;
    const double nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2;
    silk.face4({a.x + nx, a.y + ny, zs}, {a.x - nx, a.y - ny, zs}, {c.x - nx, c.y - ny, zs}, {c.x + nx, c.y + ny, zs});
  };
  const auto dot = [&](Pt c, double r) { ring(silk, c.x, c.y, zs, 0, r, 12, true); };
  for (const Val& it : A(F(res, K_silk))) {
    const Val& type = F(it, K_type);
    if (is(type, u"line")) {
      const Poly pts = pts_of(F(it, K_pts));
      const double w = N(F(it, K_w));
      for (std::size_t i = 0; i + 1 < pts.size(); ++i) seg(pts[i], pts[i + 1], w);
      for (const Pt& q : pts) dot(q, w / 2);
    } else if (is(type, u"circle")) {
      const Pt c = pt(F(it, K_c));
      const double r = N(F(it, K_r));
      if (F(it, K_fill).truthy()) dot(c, r);
      else {
        const double w = N(F(it, K_w));
        ring(silk, c.x, c.y, zs, r - w / 2, r + w / 2, 32, true);
      }
    } else if (is(type, u"poly")) {
      silk.cap(geom::ensure_ccw(pts_of(F(it, K_pts))), zs, true);
    }
  }
  Model out;
  out.board = true;
  for (const Val& it : A(F(res, K_courtyard))) {
    const Val& type = F(it, K_type);
    if (is(type, u"line")) {
      const Poly pts = pts_of(F(it, K_pts));
      for (std::size_t i = 0; i + 1 < pts.size(); ++i) out.lines.push_back({pts[i].x, pts[i].y, 0.02, pts[i + 1].x, pts[i + 1].y, 0.02});
    } else if (is(type, u"circle")) {
      const Pt c = pt(F(it, K_c));
      const double r = N(F(it, K_r));
      const double n = 48;
      for (double k = 0; k < n; k++) {
        const double a0 = (2 * PI * k) / n, a1 = (2 * PI * (k + 1)) / n;
        out.lines.push_back({c.x + r * js::cos(a0), c.y + r * js::sin(a0), 0.02, c.x + r * js::cos(a1), c.y + r * js::sin(a1), 0.02});
      }
    }
  }
  meshes.push_back(std::move(slab0));
  meshes.push_back(std::move(edge));
  meshes.push_back(std::move(cu));
  meshes.push_back(std::move(barrel));
  meshes.push_back(std::move(hole));
  meshes.push_back(std::move(silk));
  finalize(out, meshes);
  out.extent = {X0, Y0, -BOARD_T - CU, X1, Y1, CU};
  out.core = {bb.x0, bb.y0, 0, bb.x1, bb.y1, CU};   // what a view frames
  return out;
}

// Export

std::string to_vrml(const Model& model, const U& name) {
  const double S1 = 1 / 2.54;
  const auto num = [&](double v) {
    const double r = js::round(v * S1 * 1e5) / 1e5;
    return r == 0 && std::signbit(r) ? std::string("0") : js::to_string(r);
  };
  std::vector<std::string> out{"#VRML V2.0 utf8", "# " + (name.empty() ? std::string("stomp model") : to_utf8(name)) + ", generated by stomp. Units: 0.1 inch."};
  std::unordered_map<std::string, std::string> mats, shapes;
  int nMat = 0, nShape = 0;
  for (const Mesh& m : model.meshes) {
    // merge coincident vertices, drop triangles that collapse
    std::unordered_map<std::string, int> keys;
    std::vector<P3> pts;
    std::vector<int> remap(m.pos.size() / 3);
    for (std::size_t v = 0; v < m.pos.size() / 3; ++v) {
      const std::string k = js::to_string(js::round(static_cast<double>(m.pos[v * 3]) * 1e5)) + "," + js::to_string(js::round(static_cast<double>(m.pos[v * 3 + 1]) * 1e5)) +
                            "," + js::to_string(js::round(static_cast<double>(m.pos[v * 3 + 2]) * 1e5));
      auto it = keys.find(k);
      int j;
      if (it == keys.end()) {
        j = static_cast<int>(pts.size());
        keys.emplace(k, j);
        pts.push_back({m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]});
      } else j = it->second;
      remap[v] = j;
    }
    std::vector<int> tris;
    for (std::size_t t = 0; t < m.idx.size(); t += 3) {
      const int a = remap[m.idx[t]], b = remap[m.idx[t + 1]], c = remap[m.idx[t + 2]];
      if (a != b && b != c && a != c) tris.insert(tris.end(), {a, b, c});
    }
    if (tris.empty()) continue;
    // the shape relative to its first vertex, so a translated copy is the same shape
    const P3 o = pts[0];
    std::vector<P3> local;
    for (const P3& q : pts) local.push_back({q[0] - o[0], q[1] - o[1], q[2] - o[2]});
    const std::string mk = js::to_fixed(m.color[0], 4) + " " + js::to_fixed(m.color[1], 4) + " " + js::to_fixed(m.color[2], 4) + "|" + js::to_string(m.metal);
    std::string sk = mk + "|";
    for (std::size_t i = 0; i < local.size(); ++i) {
      if (i) sk += ' ';
      sk += js::to_string(js::round(local[i][0] * 1e5)) + "," + js::to_string(js::round(local[i][1] * 1e5)) + "," + js::to_string(js::round(local[i][2] * 1e5));
    }
    sk += '|';
    for (std::size_t i = 0; i < tris.size(); ++i) {
      if (i) sk += ',';
      sk += std::to_string(tris[i]);
    }
    const std::string at = "translation " + num(o[0]) + " " + num(o[1]) + " " + num(o[2]);
    if (auto it = shapes.find(sk); it != shapes.end()) {
      out.push_back("Transform { " + at + " children [ USE " + it->second + " ] }");
      continue;
    }
    const std::string sid = "S" + std::to_string(nShape++);
    shapes.emplace(sk, sid);
    std::string mat;
    if (auto it = mats.find(mk); it != mats.end()) mat = "material USE " + it->second;
    else {
      const std::string mid = "M" + std::to_string(nMat++);
      mats.emplace(mk, mid);
      const auto c4 = [](double c) { return js::to_string(js::round(c * 1e4) / 1e4); };
      mat = "material DEF " + mid + " Material { diffuseColor " + c4(m.color[0]) + " " + c4(m.color[1]) + " " + c4(m.color[2]) + " specularColor " +
            (js::truthy(m.metal) ? "0.6 0.6 0.6" : "0.12 0.12 0.12") + " shininess " + (js::truthy(m.metal) ? "0.6" : "0.15") + " }";
    }
    std::string P;
    for (std::size_t i = 0; i < local.size(); ++i) {
      if (i) P += ',';
      P += num(local[i][0]) + " " + num(local[i][1]) + " " + num(local[i][2]);
    }
    std::string I;
    for (std::size_t t = 0; t < tris.size(); t += 3) {
      if (t) I += ' ';
      I += std::to_string(tris[t]) + "," + std::to_string(tris[t + 1]) + "," + std::to_string(tris[t + 2]) + ",-1";
    }
    out.push_back("Transform { " + at + " children [ DEF " + sid + " Shape { # " + to_utf8(m.name));
    out.push_back("  appearance Appearance { " + mat + " }");
    out.push_back("  geometry IndexedFaceSet { solid FALSE creaseAngle 0.5 coord Coordinate { point [ " + P + " ] }");
    out.push_back("    coordIndex [ " + I + " ] } } ] }");
  }
  out.push_back("");
  std::string text;
  for (std::size_t i = 0; i < out.size(); ++i) {
    if (i) text += '\n';
    text += out[i];
  }
  return text;
}

std::vector<std::uint8_t> to_stl(const Model& model, const U& name) {
  std::size_t n = 0;
  for (const Mesh& m : model.meshes) n += m.idx.size() / 3;
  std::vector<std::uint8_t> buf(84 + 50 * n, 0);
  const U head = (u"stomp: " + (name.empty() ? U(u"model") : name)).substr(0, 79);
  for (std::size_t i = 0; i < head.size(); ++i) buf[i] = static_cast<std::uint8_t>(head[i] & 127);
  const auto u32 = [&](std::size_t o, std::uint32_t v) {
    for (int k = 0; k < 4; k++) buf[o + k] = static_cast<std::uint8_t>(v >> (8 * k));
  };
  const auto f32 = [&](std::size_t o, double v) {
    const float f = static_cast<float>(v);
    std::uint32_t bits;
    std::memcpy(&bits, &f, 4);
    u32(o, bits);
  };
  u32(80, static_cast<std::uint32_t>(n));
  std::size_t o = 84;
  for (const Mesh& m : model.meshes) {
    const auto& P = m.pos;
    for (std::size_t k = 0; k < m.idx.size(); k += 3) {
      const std::size_t a = m.idx[k] * 3, b = m.idx[k + 1] * 3, c = m.idx[k + 2] * 3;
      const P3 nn = normal3({P[a], P[a + 1], P[a + 2]}, {P[b], P[b + 1], P[b + 2]}, {P[c], P[c + 1], P[c + 2]});
      for (double v : nn) {
        f32(o, v);
        o += 4;
      }
      for (std::size_t q : {a, b, c})
        for (int j = 0; j < 3; j++) {
          f32(o, P[q + j]);
          o += 4;
        }
      o += 2;   // attribute bytes: 0
    }
  }
  return buf;
}

json::Value val_json(const Val& v) {
  if (v.undef()) return json::Value(json::Undefined{});
  if (v.null()) return nullptr;
  if (v.is_bool()) return v.boolean();
  if (v.is_num()) return v.num();
  if (v.is_str()) return v.str();
  if (v.is_arr()) {
    json::Value a = json::array();
    for (const Val& x : v.arr()->a) a.push(val_json(x));
    return a;
  }
  json::Value o = json::object();
  for (const auto& f : v.obj()->f) o.set(key_name(f.first), val_json(f.second));
  return o;
}

json::Value to_json(const Model& m) {
  const auto box3 = [](const Box3& b) {
    json::Value o = json::object();
    o.set(u"x0", b.x0);
    o.set(u"y0", b.y0);
    o.set(u"z0", b.z0);
    o.set(u"x1", b.x1);
    o.set(u"y1", b.y1);
    o.set(u"z1", b.z1);
    return o;
  };
  json::Value o = json::object();
  json::Value meshes = json::array();
  for (const Mesh& x : m.meshes) {
    json::Value me = json::object();
    me.set(u"name", x.name);
    me.set(u"kind", x.kind);
    me.set(u"color", json::Array{x.color[0], x.color[1], x.color[2]});
    me.set(u"metal", x.metal);
    me.set(u"src", val_json(x.src));
    json::Typed pos{"Float32Array", {}}, nrm{"Float32Array", {}}, idx{"Uint32Array", {}};
    pos.values.assign(x.pos.begin(), x.pos.end());
    nrm.values.assign(x.nrm.begin(), x.nrm.end());
    idx.values.assign(x.idx.begin(), x.idx.end());
    me.set(u"pos", std::move(pos));
    me.set(u"nrm", std::move(nrm));
    me.set(u"idx", std::move(idx));
    meshes.push(std::move(me));
  }
  if (m.board) {
    o.set(u"meshes", std::move(meshes));
    o.set(u"notes", json::array());
  } else {
    o.set(u"none", m.none);
    o.set(u"meshes", std::move(meshes));
    json::Value notes = json::array();
    for (const U& n : m.notes) notes.push(n);
    o.set(u"notes", std::move(notes));
    o.set(u"style", val_json(m.style));
    o.set(u"summary", val_json(m.summary));
    o.set(u"H", m.H);
    o.set(u"standoff", m.standoff);
    json::Value diags = json::array();
    for (const Val& d : m.diagnostics) diags.push(val_json(d));
    o.set(u"diagnostics", std::move(diags));
    if (m.short_) o.set(u"short", *m.short_);
    if (m.mark) o.set(u"mark", *m.mark);
    if (m.leadCount) o.set(u"leadCount", *m.leadCount);
  }
  o.set(u"bbox", m.bbox ? box3(*m.bbox) : json::Value(nullptr));
  o.set(u"top", m.top ? json::Value(*m.top) : json::Value(nullptr));
  o.set(u"triangles", m.triangles);
  if (m.board) {
    json::Value lines = json::array();
    for (const auto& l : m.lines) lines.push(json::Array{l[0], l[1], l[2], l[3], l[4], l[5]});
    o.set(u"lines", std::move(lines));
    o.set(u"extent", box3(m.extent));
    o.set(u"core", box3(m.core));
  }
  return o;
}

}  // namespace stomp::model3d
