// 2D geometry, ported from demo/js/geom.js in the same arithmetic order.
//
// Coordinates are mm, +x right, +y up (SPEC 6). Closed outlines are contours: lists of
// edges, each a straight line or a counterclockwise arc, so bounding boxes stay exact.
// Clipping works on polygons made from them. In the JavaScript engine these were
//   line: { t: 'L', a: [x, y], b: [x, y] }
//   arc:  { t: 'A', c: [x, y], r, a0, a1, a: [x, y], b: [x, y] }   (a1 > a0, radians)
// and that is how they are written out (compile/out.hpp).
#ifndef STOMP_GEOM_HPP
#define STOMP_GEOM_HPP

#include <array>
#include <limits>
#include <numbers>
#include <optional>
#include <string>
#include <vector>

namespace stomp::geom {

inline constexpr double EPS = 1e-9;
inline constexpr double PI = std::numbers::pi;
inline constexpr double TAU = PI * 2;
inline constexpr double HALF_PI = PI / 2;
inline double deg(double d) { return (d * PI) / 180; }

struct Pt {
  double x = 0, y = 0;
  friend bool operator==(const Pt&, const Pt&) = default;
};
using Poly = std::vector<Pt>;

struct Edge {
  bool arc = false;
  Pt a, b;              // the ends (an arc's are computed from c, r, a0, a1)
  Pt c;                 // arcs: center, radius and angles
  double r = 0, a0 = 0, a1 = 0;
};
using Contour = std::vector<Edge>;

struct Box {
  double x0 = std::numeric_limits<double>::infinity(), y0 = std::numeric_limits<double>::infinity();
  double x1 = -std::numeric_limits<double>::infinity(), y1 = -std::numeric_limits<double>::infinity();
};

/** Corner radii; a NaN or 0 means none (JavaScript's `rad.br || 0`). */
struct Radii {
  double tl = 0, tr = 0, bl = 0, br = 0;
};

// Contours
Edge line(Pt a, Pt b);
Edge arc(Pt c, double r, double a0, double a1);
Contour rrect_contour(double w, double l, const Radii& rad);
Contour circle_contour(double r, Pt c = {});
Contour poly_contour(const Poly& pts);
/** Rotate by rot radians about the origin, then translate. */
Contour transform_contour(const Contour& edges, double rot, double tx, double ty);
Box contour_bbox(const Contour& edges);
/** Tessellate into a closed polygon (no repeated last point); max_step 0 means 6 degrees. */
Poly contour_to_poly(const Contour& edges, double max_step = 0);

// Shapes: pads and holes, centered on their reference point and unrotated
enum class Kind { Rect, Oval, Roundrect, Dshape, Circle, Polygon };
const char16_t* kind_name(Kind k);
std::optional<Kind> kind_of(std::u16string_view name);

struct Shape {
  Kind kind = Kind::Rect;
  double w = 0, l = 0;                   // rect, oval, roundrect, dshape
  double r = 0;                          // roundrect
  std::optional<double> r_pct;           // roundrect given as a percentage
  double d = 0;                          // circle
  std::u16string flat;                   // dshape: left, right, top or bottom
  Poly pts;                              // polygon, relative to its centroid, CCW
};

double dshape_radius(double w, double l, std::u16string_view flat);
/** A shape's outline grown (offset > 0) or shrunk (offset < 0) on every side. */
Contour shape_contour(const Shape& sh, double offset = 0);
/** Mirrored across the y axis ('y' negates x) or the x axis ('x' negates y). */
Shape mirror_shape(const Shape& sh, char16_t axis);

// Polygons
double poly_area(const Poly& pts);
Pt poly_centroid(const Poly& pts);
Poly ensure_ccw(const Poly& pts);
/** Miter offset of a simple polygon; outward for d > 0. */
Poly offset_polygon(const Poly& pts, double d);
Pt outward_normal(Pt a, Pt b);
bool point_in_poly(Pt p, const Poly& poly);
/** Where segment a-b crosses c-d, as t in [0, 1] along a-b. */
std::optional<double> seg_cross(Pt a, Pt b, Pt c, Pt d);
/** The pieces of a polyline outside every keep-out polygon. */
std::vector<Poly> clip_polyline_outside(const Poly& pts, const std::vector<Poly>& keepouts, bool closed);
/** True if two simple polygons overlap with positive area (touching is not overlap). */
bool polys_overlap(const Poly& P, const Poly& Q);
bool proper_cross(Pt a, Pt b, Pt c, Pt d);
Pt interior_point(const Poly& P);

// Utilities
inline Box empty_box() { return Box{}; }
Box& add_pt(Box& bb, Pt p);
Box union_box(const Box& a, const Box& b);
inline bool box_valid(const Box& bb) { return bb.x0 <= bb.x1 && bb.y0 <= bb.y1; }
inline bool box_overlap(const Box& a, const Box& b) { return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1; }
double dist(Pt a, Pt b);
inline Pt lerp(Pt a, Pt b, double t) { return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t}; }
double clamp(double v, double lo, double hi);
double path_length(const Poly& p);
Poly dedupe(const Poly& pts, bool closed);
/** An arc as a polyline (radians, CCW from a0 to a1); max_step 0 means 5 degrees. */
Poly arc_points(Pt c, double r, double a0, double a1, double max_step = 0);
/** Ear-clipping triangulation (either winding): index triples, counterclockwise. */
std::vector<std::array<int, 3>> triangulate(const Poly& pts);

// 3D frames: [r00 r01 r02 tx  r10 r11 r12 ty  r20 r21 r22 tz]
using Frame = std::array<double, 12>;
/** cos and sin of d degrees, exact at quarter turns. */
std::array<double, 2> cos_sin(double d);
/** Turn about x, then y, then z (degrees), then move by t. */
Frame frame3(const std::array<double, 3>& t, const std::array<double, 3>& rot);
/** A then B: the frame that applies B first. */
Frame compose3(const Frame& A, const Frame& B);
bool is_identity3(const Frame& M);

}  // namespace stomp::geom

#endif  // STOMP_GEOM_HPP
