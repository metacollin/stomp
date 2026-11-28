// demo/js/geom.js, function for function. Math.min/max are js::min/max (NaN wins, -0 < 0)
// and the trigonometry is V8's, so every number matches the JavaScript engine's.
#include "geom.hpp"

#include <algorithm>
#include <cmath>

#include "jsrt.hpp"

namespace stomp::geom {

namespace {
inline double or0(double v) { return js::truthy(v) ? v : 0; }   // `v || 0`
}  // namespace

// Contours

Edge line(Pt a, Pt b) {
  Edge e;
  e.a = a;
  e.b = b;
  return e;
}

Edge arc(Pt c, double r, double a0, double a1) {
  Edge e;
  e.arc = true;
  e.c = c;
  e.r = r;
  e.a0 = a0;
  e.a1 = a1;
  e.a = {c.x + r * js::cos(a0), c.y + r * js::sin(a0)};
  e.b = {c.x + r * js::cos(a1), c.y + r * js::sin(a1)};
  return e;
}

Contour rrect_contour(double w, double l, const Radii& rad) {
  if (!(w > EPS && l > EPS)) return {};
  const double hw = w / 2, hl = l / 2;
  const double lim = js::min(hw, hl);
  const double br = clamp(or0(rad.br), 0, lim), tr = clamp(or0(rad.tr), 0, lim);
  const double tl = clamp(or0(rad.tl), 0, lim), bl = clamp(or0(rad.bl), 0, lim);
  Contour e;
  const auto push = [&](const Edge& edge) {
    if (!edge.arc && dist(edge.a, edge.b) < EPS) return;
    if (edge.arc && edge.r < EPS) return;
    e.push_back(edge);
  };
  push(line({-hw + bl, -hl}, {hw - br, -hl}));
  push(arc({hw - br, -hl + br}, br, -HALF_PI, 0));
  push(line({hw, -hl + br}, {hw, hl - tr}));
  push(arc({hw - tr, hl - tr}, tr, 0, HALF_PI));
  push(line({hw - tr, hl}, {-hw + tl, hl}));
  push(arc({-hw + tl, hl - tl}, tl, HALF_PI, PI));
  push(line({-hw, hl - tl}, {-hw, -hl + bl}));
  push(arc({-hw + bl, -hl + bl}, bl, PI, PI * 1.5));
  return e;
}

Contour circle_contour(double r, Pt c) {
  if (!(r > EPS)) return {};
  return {arc(c, r, 0, TAU)};
}

Contour poly_contour(const Poly& pts) {
  Contour e;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    const Pt a = pts[i], b = pts[(i + 1) % pts.size()];
    if (dist(a, b) > EPS) e.push_back(line(a, b));
  }
  return e;
}

Contour transform_contour(const Contour& edges, double rot, double tx, double ty) {
  const double c = js::cos(rot), s = js::sin(rot);
  const auto tp = [&](Pt p) { return Pt{p.x * c - p.y * s + tx, p.x * s + p.y * c + ty}; };
  Contour out;
  out.reserve(edges.size());
  for (const auto& ed : edges) out.push_back(ed.arc ? arc(tp(ed.c), ed.r, ed.a0 + rot, ed.a1 + rot) : line(tp(ed.a), tp(ed.b)));
  return out;
}

Box contour_bbox(const Contour& edges) {
  Box bb;
  for (const auto& ed : edges) {
    add_pt(bb, ed.a);
    add_pt(bb, ed.b);
    if (!ed.arc) continue;
    // axis extremes that fall inside the arc's sweep
    const double k0 = std::ceil(ed.a0 / HALF_PI - 1e-12), k1 = std::floor(ed.a1 / HALF_PI + 1e-12);
    for (double k = k0; k <= k1; k++) {
      const double a = k * HALF_PI;
      add_pt(bb, {ed.c.x + ed.r * js::cos(a), ed.c.y + ed.r * js::sin(a)});
    }
  }
  return bb;
}

Poly contour_to_poly(const Contour& edges, double max_step) {
  const double step = js::truthy(max_step) ? max_step : deg(6);
  Poly pts;
  for (const auto& ed : edges) {
    if (!ed.arc) {
      pts.push_back(ed.a);
      continue;
    }
    const double sweep = ed.a1 - ed.a0;
    const double n = js::max(2, std::ceil(sweep / step));
    for (double i = 0; i < n; i++) {
      const double a = ed.a0 + (sweep * i) / n;
      pts.push_back({ed.c.x + ed.r * js::cos(a), ed.c.y + ed.r * js::sin(a)});
    }
  }
  return dedupe(pts, true);
}

// Shapes

const char16_t* kind_name(Kind k) {
  switch (k) {
    case Kind::Rect: return u"rect";
    case Kind::Oval: return u"oval";
    case Kind::Roundrect: return u"roundrect";
    case Kind::Dshape: return u"dshape";
    case Kind::Circle: return u"circle";
    case Kind::Polygon: return u"polygon";
  }
  return u"rect";
}

std::optional<Kind> kind_of(std::u16string_view n) {
  for (Kind k : {Kind::Rect, Kind::Oval, Kind::Roundrect, Kind::Dshape, Kind::Circle, Kind::Polygon})
    if (n == kind_name(k)) return k;
  return std::nullopt;
}

namespace {
Radii dshape_radii(std::u16string_view flat, double r) {
  Radii z;
  if (flat == u"right") { z.tl = r; z.bl = r; }
  else if (flat == u"top") { z.bl = r; z.br = r; }
  else if (flat == u"bottom") { z.tl = r; z.tr = r; }
  else { z.tr = r; z.br = r; }   // flat left: the round end on the right
  return z;
}
}  // namespace

double dshape_radius(double w, double l, std::u16string_view flat) {
  return (flat == u"top" || flat == u"bottom") ? js::min(w / 2, l) : js::min(l / 2, w);
}

Contour shape_contour(const Shape& sh, double offset) {
  const double o = or0(offset);
  switch (sh.kind) {
    case Kind::Rect: return rrect_contour(sh.w + 2 * o, sh.l + 2 * o, {});
    case Kind::Roundrect: {
      const double r = js::max(0, js::min(sh.r, js::min(sh.w, sh.l) / 2) + o);
      return rrect_contour(sh.w + 2 * o, sh.l + 2 * o, {r, r, r, r});
    }
    case Kind::Oval: {
      const double w = sh.w + 2 * o, l = sh.l + 2 * o, r = js::min(w, l) / 2;
      return rrect_contour(w, l, {r, r, r, r});
    }
    case Kind::Dshape: {
      const double r0 = dshape_radius(sh.w, sh.l, sh.flat);
      const double w = sh.w + 2 * o, l = sh.l + 2 * o, r = js::max(0, r0 + o);
      return rrect_contour(w, l, dshape_radii(sh.flat, r));
    }
    case Kind::Circle: return circle_contour(sh.d / 2 + o);
    case Kind::Polygon: return poly_contour(js::truthy(o) ? offset_polygon(sh.pts, o) : sh.pts);
  }
  return {};
}

Shape mirror_shape(const Shape& sh, char16_t axis) {
  Shape m = sh;
  if (sh.kind == Kind::Dshape) {
    const std::u16string& f = sh.flat;
    if (axis == u'y') {
      if (f == u"left") m.flat = u"right";
      else if (f == u"right") m.flat = u"left";
    } else {
      if (f == u"top") m.flat = u"bottom";
      else if (f == u"bottom") m.flat = u"top";
    }
  } else if (sh.kind == Kind::Polygon) {
    m.pts.clear();
    for (auto it = sh.pts.rbegin(); it != sh.pts.rend(); ++it) m.pts.push_back(axis == u'y' ? Pt{-it->x, it->y} : Pt{it->x, -it->y});
  }
  return m;
}

// Polygons

double poly_area(const Poly& pts) {
  double a = 0;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    const Pt p = pts[i], q = pts[(i + 1) % pts.size()];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

Pt poly_centroid(const Poly& pts) {
  const double A = poly_area(pts);
  if (std::fabs(A) < EPS) {
    Box bb;
    for (const Pt& p : pts) add_pt(bb, p);
    return {(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2};
  }
  double cx = 0, cy = 0;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    const Pt p = pts[i], q = pts[(i + 1) % pts.size()];
    const double k = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * k;
    cy += (p.y + q.y) * k;
  }
  return {cx / (6 * A), cy / (6 * A)};
}

Poly ensure_ccw(const Poly& pts) { return poly_area(pts) < 0 ? Poly(pts.rbegin(), pts.rend()) : pts; }

Poly offset_polygon(const Poly& pts, double d) {
  const Poly P = ensure_ccw(dedupe(pts, true));
  const std::size_t n = P.size();
  if (n < 3) return P;
  Poly out;
  for (std::size_t i = 0; i < n; ++i) {
    const Pt p0 = P[(i + n - 1) % n], p1 = P[i], p2 = P[(i + 1) % n];
    const Pt n1 = outward_normal(p0, p1), n2 = outward_normal(p1, p2);
    const Pt bis{n1.x + n2.x, n1.y + n2.y};
    const double bl = js::hypot({bis.x, bis.y});
    if (bl < 1e-12) {
      out.push_back({p1.x + n1.x * d, p1.y + n1.y * d});
      continue;
    }
    const double cos_half = (bis.x * n1.x + bis.y * n1.y) / bl;   // (0, 1]
    const double len = d / js::max(cos_half, 0.25);                // miter limit: 4 times d
    out.push_back({p1.x + (bis.x / bl) * len, p1.y + (bis.y / bl) * len});
  }
  return out;
}

Pt outward_normal(Pt a, Pt b) {
  // for a CCW polygon, the outward normal of edge a-b points right
  const double dx = b.x - a.x, dy = b.y - a.y;
  double L = js::hypot({dx, dy});
  if (!js::truthy(L)) L = 1;
  return {dy / L, -dx / L};
}

bool point_in_poly(Pt p, const Poly& poly) {
  bool inside = false;
  const std::size_t n = poly.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const Pt a = poly[i], b = poly[j];
    if ((a.y > p.y) != (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

std::optional<double> seg_cross(Pt a, Pt b, Pt c, Pt d) {
  const Pt r{b.x - a.x, b.y - a.y}, s{d.x - c.x, d.y - c.y};
  const double den = r.x * s.y - r.y * s.x;
  if (std::fabs(den) < 1e-15) return std::nullopt;
  const double t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const double u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) return std::nullopt;
  return t;
}

std::vector<Poly> clip_polyline_outside(const Poly& pts, const std::vector<Poly>& keepouts, bool closed) {
  Poly path = pts;
  if (closed && !pts.empty()) path.push_back(pts[0]);
  std::vector<Poly> pieces;
  std::optional<Poly> cur;
  std::vector<Box> boxes;
  boxes.reserve(keepouts.size());
  for (const auto& k : keepouts) {
    Box bb;
    for (const Pt& p : k) add_pt(bb, p);
    boxes.push_back(bb);
  }
  for (std::size_t i = 0; i + 1 < path.size(); ++i) {
    const Pt a = path[i], b = path[i + 1];
    std::vector<double> ts{0, 1};
    Box seg;
    add_pt(seg, a);
    add_pt(seg, b);
    std::vector<const Poly*> near;
    for (std::size_t ki = 0; ki < keepouts.size(); ++ki) {
      if (!box_overlap(seg, boxes[ki])) continue;
      const Poly& k = keepouts[ki];
      near.push_back(&k);
      for (std::size_t j = 0; j < k.size(); ++j) {
        const auto t = seg_cross(a, b, k[j], k[(j + 1) % k.size()]);
        if (t) ts.push_back(js::min(1, js::max(0, *t)));
      }
    }
    std::stable_sort(ts.begin(), ts.end());
    for (std::size_t j = 0; j + 1 < ts.size(); ++j) {
      const double t0 = ts[j], t1 = ts[j + 1];
      if (t1 - t0 < 1e-9) continue;
      const double tm = (t0 + t1) / 2;
      const Pt m = lerp(a, b, tm);
      bool inside = false;
      for (const Poly* k : near)
        if (point_in_poly(m, *k)) { inside = true; break; }
      const Pt p0 = lerp(a, b, t0), p1 = lerp(a, b, t1);
      if (inside) {
        if (cur) { pieces.push_back(std::move(*cur)); cur.reset(); }
        continue;
      }
      if (cur && dist(cur->back(), p0) < 1e-7) cur->push_back(p1);
      else {
        if (cur) pieces.push_back(std::move(*cur));
        cur = Poly{p0, p1};
      }
    }
  }
  if (cur) pieces.push_back(std::move(*cur));
  // a closed outline that survived around its start point: join the first and last pieces
  if (closed && pieces.size() > 1) {
    const Poly& first = pieces.front();
    Poly& last = pieces.back();
    if (dist(last.back(), first[0]) < 1e-7) {
      Poly joined = last;
      joined.insert(joined.end(), first.begin() + 1, first.end());
      pieces[0] = std::move(joined);
      pieces.pop_back();
    }
  }
  std::vector<Poly> out;
  for (const auto& p : pieces) {
    Poly q = dedupe(p, false);
    if (q.size() >= 2 && path_length(q) > 1e-6) out.push_back(std::move(q));
  }
  return out;
}

bool polys_overlap(const Poly& P, const Poly& Q) {
  for (std::size_t i = 0; i < P.size(); ++i) {
    const Pt a = P[i], b = P[(i + 1) % P.size()];
    for (std::size_t j = 0; j < Q.size(); ++j)
      if (proper_cross(a, b, Q[j], Q[(j + 1) % Q.size()])) return true;
  }
  // containment: test a point slightly inside each
  return point_in_poly(interior_point(P), Q) || point_in_poly(interior_point(Q), P);
}

bool proper_cross(Pt a, Pt b, Pt c, Pt d) {
  const auto o = [](Pt p, Pt q, Pt r) { return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); };
  const double d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  const double tol = 1e-12;
  return ((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol));
}

Pt interior_point(const Poly& P) {
  const Pt c = poly_centroid(P);
  if (point_in_poly(c, P)) return c;
  // fall back: the midpoint of the first edge, nudged inward
  const Poly Q = ensure_ccw(P);
  const Pt a = Q[0], b = Q[1], n = outward_normal(a, b);
  return {(a.x + b.x) / 2 - n.x * 1e-4, (a.y + b.y) / 2 - n.y * 1e-4};
}

// Utilities

Box& add_pt(Box& bb, Pt p) {
  if (p.x < bb.x0) bb.x0 = p.x;
  if (p.x > bb.x1) bb.x1 = p.x;
  if (p.y < bb.y0) bb.y0 = p.y;
  if (p.y > bb.y1) bb.y1 = p.y;
  return bb;
}

Box union_box(const Box& a, const Box& b) {
  return {js::min(a.x0, b.x0), js::min(a.y0, b.y0), js::max(a.x1, b.x1), js::max(a.y1, b.y1)};
}

double dist(Pt a, Pt b) { return js::hypot({a.x - b.x, a.y - b.y}); }
double clamp(double v, double lo, double hi) { return js::max(lo, js::min(hi, v)); }

double path_length(const Poly& p) {
  double s = 0;
  for (std::size_t i = 1; i < p.size(); ++i) s += dist(p[i - 1], p[i]);
  return s;
}

Poly dedupe(const Poly& pts, bool closed) {
  Poly out;
  for (const Pt& p : pts)
    if (out.empty() || dist(out.back(), p) > 1e-9) out.push_back(p);
  if (closed && out.size() > 1 && dist(out.front(), out.back()) <= 1e-9) out.pop_back();
  return out;
}

Poly arc_points(Pt c, double r, double a0, double a1, double max_step) {
  const double step = js::truthy(max_step) ? max_step : deg(5);
  const double n = js::max(2, std::ceil(std::fabs(a1 - a0) / step));
  Poly pts;
  for (double i = 0; i <= n; i++) {
    const double a = a0 + ((a1 - a0) * i) / n;
    pts.push_back({c.x + r * js::cos(a), c.y + r * js::sin(a)});
  }
  return pts;
}

std::vector<std::array<int, 3>> triangulate(const Poly& pts) {
  const int n = static_cast<int>(pts.size());
  if (n < 3) return {};
  const bool ccw = poly_area(pts) >= 0;
  std::vector<int> idx;
  idx.reserve(n);
  for (int i = 0; i < n; i++) idx.push_back(ccw ? i : n - 1 - i);
  const auto area2 = [](Pt a, Pt b, Pt c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); };
  double scale = 1e-9;
  for (const Pt& p : pts) scale = js::max(scale, std::fabs(p.x) + std::fabs(p.y));
  const double eps = 1e-12 * scale * scale;
  // inclusive: a reflex vertex on the candidate diagonal blocks the ear too
  const auto same = [&](Pt p, Pt q) { return std::fabs(p.x - q.x) + std::fabs(p.y - q.y) <= 1e-12 * scale; };
  const auto inside = [&](Pt p, Pt a, Pt b, Pt c) {
    return !same(p, a) && !same(p, b) && !same(p, c) && area2(a, b, p) >= -eps && area2(b, c, p) >= -eps && area2(c, a, p) >= -eps;
  };
  std::vector<std::array<int, 3>> tris;
  int guard = 0;
  while (idx.size() > 3 && guard++ < 20000) {
    bool cut = false;
    for (std::size_t i = 0; i < idx.size(); ++i) {
      const std::size_t m = idx.size();
      const int i0 = idx[(i + m - 1) % m], i1 = idx[i], i2 = idx[(i + 1) % m];
      const Pt a = pts[i0], b = pts[i1], c = pts[i2];
      const double ar = area2(a, b, c);
      if (std::fabs(ar) <= eps) {   // collinear or duplicate
        idx.erase(idx.begin() + static_cast<std::ptrdiff_t>(i));
        cut = true;
        break;
      }
      if (ar < 0) continue;   // reflex
      bool ear = true;
      for (int j : idx) {
        if (j == i0 || j == i1 || j == i2) continue;
        if (inside(pts[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      tris.push_back({i0, i1, i2});
      idx.erase(idx.begin() + static_cast<std::ptrdiff_t>(i));
      cut = true;
      break;
    }
    if (!cut) break;   // not a simple polygon; keep what we have
  }
  if (idx.size() == 3 && std::fabs(area2(pts[idx[0]], pts[idx[1]], pts[idx[2]])) > eps) tris.push_back({idx[0], idx[1], idx[2]});
  return tris;
}

// 3D frames

std::array<double, 2> cos_sin(double d) {
  const double q = d / 90, k = js::round(q);
  if (std::fabs(q - k) < 1e-9) {
    static constexpr double C[4][2] = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
    const int i = static_cast<int>(std::fmod(std::fmod(k, 4) + 4, 4));
    return {C[i][0], C[i][1]};
  }
  const double r = (d * PI) / 180;
  return {js::cos(r), js::sin(r)};
}

Frame frame3(const std::array<double, 3>& t, const std::array<double, 3>& rot) {
  const auto [cx, sx] = cos_sin(rot[0]);
  const auto [cy, sy] = cos_sin(rot[1]);
  const auto [cz, sz] = cos_sin(rot[2]);
  // Rz * Ry * Rx
  return {cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, t[0],
          sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, t[1],
          -sy,     cy * sx,                cy * cx,                t[2]};
}

Frame compose3(const Frame& A, const Frame& B) {
  Frame o{};
  for (int r = 0; r < 3; r++) {
    for (int c = 0; c < 4; c++) {
      double v = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c];
      if (c == 3) v += A[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}

bool is_identity3(const Frame& M) {
  return M[0] == 1 && M[1] == 0 && M[2] == 0 && M[3] == 0 && M[4] == 0 && M[5] == 1 && M[6] == 0 && M[7] == 0 && M[8] == 0 &&
         M[9] == 0 && M[10] == 1 && M[11] == 0;
}

}  // namespace stomp::geom
