// Helpers (compile.js 3910-4085) and the build's constants.
#include <algorithm>
#include <cmath>

#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

const Defaults& D() {
  static const Defaults d = [] {
    Defaults x;
    x.tol = js::hypot({0.05, 0.025});   // IPC fabrication and placement tolerances combined (no part tolerance)
    return x;
  }();
  return d;
}

namespace ipc {
const IpcTable gullwing{u"gull-wing", {0.55, 0.35, 0.15}, {0.45, 0.35, 0.25}, {0.05, 0.03, 0.01}, {0.5, 0.25, 0.1}};
const IpcTable gullwingFine{u"gull-wing ≤0.625 pitch", {0.55, 0.35, 0.15}, {0.45, 0.35, 0.25}, {0.01, -0.02, -0.04}, {0.5, 0.25, 0.1}};
const IpcTable jlead{u"J-lead", {0.55, 0.35, 0.15}, {0.10, 0.00, -0.10}, {0.05, 0.03, 0.01}, {0.5, 0.25, 0.1}};
// molded bodies whose terminals fold under the body (tantalums, SMA): the land runs on under it
const IpcTable lbend{u"inward L-bend", {0.25, 0.15, 0.07}, {0.80, 0.50, 0.20}, {0.01, -0.05, -0.10}, {0.5, 0.25, 0.1}};
const IpcTable straight{u"flat lead", {0.30, 0.20, 0.10}, {0, 0, 0}, {0.05, 0.00, -0.05}, {0.5, 0.25, 0.1}};
const IpcTable flat{u"flat no-lead", {0.40, 0.30, 0.20}, {0, 0, 0}, {-0.04, -0.04, -0.04}, {0.5, 0.25, 0.1}};
const IpcTable chip{u"chip ≥1608", {0.55, 0.35, 0.15}, {0.00, -0.05, -0.10}, {0.05, 0.00, -0.05}, {0.5, 0.25, 0.1}};
const IpcTable chipSmall{u"chip <1608", {0.20, 0.10, 0.05}, {0, 0, 0}, {0.05, 0.00, -0.05}, {0.2, 0.15, 0.1}};
}  // namespace ipc

namespace {
constexpr char16_t JEDEC_ROWS[] = u"ABCDEFGHJKLMNPRTUVWY";
constexpr double NROWS = 20;

bool is_digits(const U& s) {
  if (s.empty()) return false;
  for (char16_t c : s)
    if (c < u'0' || c > u'9') return false;
  return true;
}
bool is_word_char(char16_t c) { return (c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') || c == u'_'; }
double digits_value(const U& s) { return js::parse_float(s); }

std::vector<double> seq(double a, double b) {
  std::vector<double> out;
  const double st = a <= b ? 1 : -1;
  for (double i = a; st > 0 ? i <= b : i >= b; i += st) {
    out.push_back(i);
    if (out.size() > 10000) throw StompError(u"range too large", nullptr);
  }
  return out;
}
}  // namespace

U num_text(double v) { return js::to_u16string(v); }
U tick(V s) { return U(u"`") + U(s) + u"`"; }
U fmt_mm(double v) { return js::to_u16string(js::parse_float(js::u16(js::to_fixed(v, 4)))) + u" mm"; }

U quote_name(const U& n) {
  bool ident = !n.empty() && is_word_char(n[0]);
  for (std::size_t i = 1; ident && i < n.size(); ++i) ident = is_word_char(n[i]) || (n[i] >= u'0' && n[i] <= u'9');
  return ident || is_digits(n) ? n : u"\"" + n + u"\"";
}

double ceil_to(double v, double q) { return std::ceil(v / q - 1e-6) * q; }
double floor_to(double v, double q) { return std::floor(v / q + 1e-6) * q; }

std::vector<U> expand_range(const ObjP& a, const ObjP& b, const ObjP& node) {
  const auto text = [](const ObjP& n) {
    const Val& v = n->get(K_name);
    return v.is_str() ? v.str() : num_text(v.num());
  };
  const U A = text(a), B = text(b);
  std::vector<U> out;
  if (is_digits(A) && is_digits(B)) {
    for (double i : seq(digits_value(A), digits_value(B))) out.push_back(num_text(i));
    return out;
  }
  const auto split = [](const U& s) -> std::optional<std::pair<U, U>> {
    std::size_t i = 0;
    while (i < s.size() && is_word_char(s[i])) ++i;
    if (i == 0 || i == s.size()) return std::nullopt;
    const U digits = s.substr(i);
    if (!is_digits(digits)) return std::nullopt;
    return std::make_pair(s.substr(0, i), digits);
  };
  const auto ma = split(A), mb = split(B);
  if (ma && mb && ma->first == mb->first) {
    for (double i : seq(digits_value(ma->second), digits_value(mb->second))) out.push_back(ma->first + num_text(i));
    return out;
  }
  const auto upper = [](const U& s) { return s.size() == 1 && s[0] >= u'A' && s[0] <= u'Z'; };
  if (upper(A) && upper(B)) {
    for (double i : seq(A[0], B[0])) out.push_back(U(1, static_cast<char16_t>(i)));
    return out;
  }
  throw StompError(u"can't expand the range " + A + u".." + B + u" — ranges run between numbers (1..4) or names with the same prefix (A1..A8)", node);
}

U jedec_row(double i) {
  if (i < NROWS) return U(1, JEDEC_ROWS[static_cast<int>(i)]);
  const double k = i - NROWS;
  return U(1, JEDEC_ROWS[static_cast<int>(std::fmod(std::floor(k / NROWS), NROWS))]) + U(1, JEDEC_ROWS[static_cast<int>(std::fmod(k, NROWS))]);
}

double jedec_index(const U& s) {
  const auto idx = [](char16_t c) -> double {
    for (int i = 0; i < 20; i++)
      if (JEDEC_ROWS[i] == c) return i;
    return -1;
  };
  if (s.size() == 1) return idx(s[0]);
  return NROWS + idx(s[0]) * NROWS + idx(s[1]);
}

double GridNames::order(double c, double r) const { return sch == u"col-major" ? ci(c) * rows + ri(r) : ri(r) * cols + ci(c); }
U GridNames::name(double c, double r) const {
  return scheme == u"bga" ? jedec_row(ri(r)) + num_text(ci(c) + 1) : num_text(order(c, r) + 1);
}
U GridNames::rowKey(double r) const { return scheme == u"bga" ? jedec_row(ri(r)) : num_text(ri(r) + 1); }
U GridNames::colKey(double c) const { return num_text(ci(c) + 1); }

/** Grid numbering (zigzag / row-major / col-major / bga), reoriented by the start corner. */
GridNames number_grid(double cols, double rows, const U& scheme, const U& start, std::optional<double> px, std::optional<double> py) {
  GridNames g;
  g.cols = cols;
  g.rows = rows;
  g.scheme = scheme;
  g.leftToRight = start.size() >= 4 && start.compare(start.size() - 4, 4, u"left") == 0;
  g.topToBottom = start.rfind(u"top", 0) == 0;
  g.sch = scheme;
  if (scheme == u"zigzag") {
    // 1-2 across the short direction, then advance
    const double pyv = py && js::truthy(*py) ? *py : 0, pxv = px && js::truthy(*px) ? *px : 0;
    const bool acrossRows = rows < cols || (rows == cols && pyv <= pxv);
    g.sch = acrossRows ? u"col-major" : u"row-major";
  }
  return g;
}

/** Counterclockwise numbering around a package. Returns position indices in pin order. */
std::vector<int> walk_order(const std::vector<PosP>& pos, const U& scheme, const U& start, bool single) {
  const int n = static_cast<int>(pos.size());
  if (!n) return {};
  geom::Box bb;
  for (const auto& p : pos) geom::add_pt(bb, {p->x, p->y});
  const bool left = start.size() >= 4 && start.compare(start.size() - 4, 4, u"left") == 0;
  const bool top = start.rfind(u"top", 0) == 0;
  const Pt corner{left ? bb.x0 : bb.x1, top ? bb.y1 : bb.y0};
  double best = std::numeric_limits<double>::infinity();
  std::vector<int> cands;
  for (int i = 0; i < n; i++) {
    const double d = js::hypot({pos[i]->x - corner.x, pos[i]->y - corner.y});
    if (d < best - 1e-9) {
      best = d;
      cands = {i};
    } else if (std::fabs(d - best) <= 1e-9) cands.push_back(i);
  }
  U pref;
  if (scheme == u"cw") {
    pref = start == u"top-left" ? u"top" : start == u"top-right" ? u"right" : start == u"bottom-right" ? u"bottom" : start == u"bottom-left" ? u"left" : u"";
  } else {
    pref = start == u"top-left" ? u"left" : start == u"bottom-left" ? u"bottom" : start == u"bottom-right" ? u"right" : start == u"top-right" ? u"top" : u"";
  }
  int i0 = -1;
  for (int i : cands)
    if (!pref.empty() && pos[i]->side == pref) { i0 = i; break; }
  if (i0 < 0) i0 = cands.empty() ? 0 : cands[0];
  if (single) {
    // one row: number away from pin 1, no wrap-around
    std::vector<int> others;
    std::vector<double> dist(n);
    for (int i = 0; i < n; i++) {
      dist[i] = js::hypot({pos[i]->x - pos[i0]->x, pos[i]->y - pos[i0]->y});
      if (i != i0) others.push_back(i);
    }
    std::stable_sort(others.begin(), others.end(), [&](int a, int b) { return dist[a] < dist[b]; });
    std::vector<int> out{i0};
    out.insert(out.end(), others.begin(), others.end());
    return out;
  }
  const int dir = scheme == u"cw" ? -1 : 1;
  std::vector<int> out;
  for (int k = 0; k < n; k++) out.push_back(((i0 + dir * k) % n + n) % n);
  return out;
}

double to_outer(const LeadSpan& span, double T) {
  return span.qual == u"outer" ? span.v : span.qual == u"inner" ? span.v + 2 * T : span.v + T;
}

BB bb_of(const geom::Shape& shape, double rotDeg) {
  const geom::Box bb = geom::contour_bbox(geom::transform_contour(geom::shape_contour(shape, 0), rad(js::truthy(rotDeg) ? rotDeg : 0), 0, 0));
  if (!geom::box_valid(bb)) return {};
  return {{bb.x0, bb.x1}, {bb.y0, bb.y1}};
}

BB bb_of_body(const Body& b) { return {{-b.w / 2, b.w / 2}, {-b.l / 2, b.l / 2}}; }

/** The kind of part its refdes names (SPEC 13.5), for the model's colors, marks and details:
 *  the longer prefixes first, so FB is a ferrite bead and not a fuse. */
std::optional<U> family_of(const Val& refdes) {
  static const std::pair<const char16_t*, const char16_t*> PREFIX[] = {
      {u"LED", u"diode"},     {u"FB", u"inductor"},  {u"XTAL", u"crystal"},   {u"OSC", u"oscillator"}, {u"XO", u"oscillator"},
      {u"SW", u"switch"},     {u"BZ", u"buzzer"},    {u"LS", u"buzzer"},      {u"CON", u"connector"},  {u"CN", u"connector"},
      {u"IC", u"ic"},         {u"D", u"diode"},      {u"L", u"inductor"},     {u"R", u"resistor"},     {u"C", u"capacitor"},
      {u"Y", u"crystal"},     {u"X", u"oscillator"}, {u"S", u"switch"},       {u"F", u"fuse"},         {u"J", u"connector"},
      {u"P", u"connector"},   {u"Q", u"transistor"}, {u"U", u"ic"},
  };
  U r;
  if (refdes.is_str()) r = js::to_upper(refdes.str());
  else if (refdes.truthy()) r = js::to_upper(refdes.is_num() ? num_text(refdes.num()) : U(u"[object Object]"));
  for (const auto& [p, fam] : PREFIX)
    if (r.rfind(p, 0) == 0) return U(fam);
  return std::nullopt;
}

/** The body style the 3D model draws (SPEC 13.1): from the main lead form and the body, and
 *  for a round body on wires, the part's family: a diode's is an LED. */
U style_of(const Body& b, const std::optional<U>& form, const Gen* gen, const std::optional<U>& family) {
  const U f = form ? *form : U();
  if (f == u"gullwing" || f == u"jlead" || f == u"lbend" || f == u"straight") return u"molded";
  if (f == u"column") return u"cga";
  if (f == u"flat" || f == u"tab") return b.kind == u"cyl" ? u"can" : u"sawn";
  if (f == u"endcap") return b.axial ? u"melf" : u"chip";
  if (f == u"ball") return u"bga";
  if (f == u"pin") return gen && gen->kind == u"dual" ? u"dip" : u"header";
  if (f == u"wire") return b.axial ? u"axial" : (b.kind == u"cyl" ? (family == u"diode" ? u"led" : u"can") : u"radial");
  if (f == u"castellated") return u"module";
  return b.kind == u"cyl" ? u"can" : u"block";
}

/** Copies of graphic items with their points moved through `map`. Text stays upright. */
Gfxs map_items(const Gfxs& items, const MapFn& map, const Val& src) {
  Gfxs out;
  out.reserve(items.size());
  for (const Gfx& it : items) {
    Gfx o = it;
    o.src = src;
    if (it.pts) {
      Poly m;
      m.reserve(it.pts->size());
      for (const Pt& q : *it.pts) m.push_back(map(q));
      o.pts = std::move(m);
    }
    if (it.c) o.c = map(*it.c);
    if (it.at) o.at = map(*it.at);
    out.push_back(std::move(o));
  }
  return out;
}

/** A closed rectangle outline, as four corners plus the first again. */
Gfx rect_item(double x0, double y0, double x1, double y1, double w) {
  Gfx g;
  g.type = u"line";
  g.pts = Poly{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}, {x0, y0}};
  g.w = w;
  return g;
}

double min_dist_to_poly(Pt p, const Poly& poly) {
  double best = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < poly.size(); ++i) {
    const Pt a = poly[i], b = poly[(i + 1) % poly.size()];
    const double dx = b.x - a.x, dy = b.y - a.y;
    double L2 = dx * dx + dy * dy;
    if (!js::truthy(L2)) L2 = 1;
    const double t = js::max(0, js::min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    best = js::min(best, js::hypot({p.x - (a.x + t * dx), p.y - (a.y + t * dy)}));
  }
  return best;
}

const Val& F(const ObjP& o, Key k) {
  static const Val undef;
  return o ? o->get(k) : undef;
}

U text_of(const U& src, const Val& x) {
  if (src.empty() || !x.is_obj()) return U();
  const double n = static_cast<double>(src.size());
  const double s = std::min(std::max(x.obj()->get(K_s).num(), 0.0), n);
  const double e = std::min(std::max(x.obj()->get(K_e).num(), 0.0), n);
  return e > s ? src.substr(static_cast<std::size_t>(s), static_cast<std::size_t>(e - s)) : U();
}

}  // namespace stomp::compiler
