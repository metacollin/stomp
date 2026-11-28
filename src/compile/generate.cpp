// Generators (compile.js 1159-1606): grids and balls, rows of pins around a package,
// IPC lands derived from the leads, per-pin leads and depopulation.
#include <algorithm>
#include <cmath>
#include <limits>

#include "../jsrt.hpp"
#include "../suggest.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
constexpr double INF = std::numeric_limits<double>::infinity();
constexpr double BALL_LAND = 0.8;
constexpr double COLUMN_LAND = 0.3;   // column lands: the column's diameter plus this
constexpr std::array<double, 3> THT_ALLOWANCE{0.25, 0.20, 0.15}, THT_RING{0.40, 0.30, 0.20};

Spec plain_spec(geom::Shape shape) {
  Spec s;
  s.shape = std::move(shape);
  return s;
}
geom::Shape circle(double d) {
  geom::Shape sh;
  sh.kind = geom::Kind::Circle;
  sh.d = d;
  return sh;
}
bool is_digits(const U& s) {
  if (s.empty()) return false;
  for (char16_t c : s)
    if (c < u'0' || c > u'9') return false;
  return true;
}
}  // namespace

void Builder::generate() {
  gen.reset();
  if (!st.gen) {
    if (lead && st.thermals.empty())
      warn(u"`lead` describes leads, but there is no `pins`/`balls` statement to place them", lead->node);
    return;
  }
  const ObjP node = st.gen->s;
  guard_void(node, [&] { runGenerator(node); });
}

void Builder::runGenerator(const ObjP& node) {
  const ObjP C = node->get(K_clauses).truthy() ? node->get(K_clauses).obj() : std::make_shared<Obj>();
  const LeadP L0 = lead;
  std::optional<std::pair<double, std::optional<double>>> pitch;
  if (C->get(K_pitch).truthy()) {
    const ObjP& p = C->get(K_pitch).obj();
    const double x = plen(p->get(K_x), node, u"pitch");
    std::optional<double> y;
    if (p->get(K_y).truthy()) y = plen(p->get(K_y), node, u"pitch");
    pitch = std::make_pair(x, y);
  } else if (st.barePitch) {
    const ObjP& b = st.barePitch->s;
    pitch = std::make_pair(plen(b->get(K_x), b, u"pitch"), std::optional<double>());
  }
  SpecP clauseSpec;
  if (C->get(K_pad).truthy()) clauseSpec = std::make_shared<const Spec>(specFromGeom(C->get(K_pad).obj(), node));
  const SpecP proto = clauseSpec ? clauseSpec : defaultSpec ? std::make_shared<const Spec>(*defaultSpec) : nullptr;
  const std::optional<U> scheme = C->get(K_numbering).truthy() ? std::optional<U>(C->get(K_numbering).obj()->get(K_v).str()) : std::nullopt;
  const U start = C->get(K_start).truthy() ? C->get(K_start).obj()->get(K_v).str() : U(u"top-left");
  gen = std::make_shared<Gen>();
  gen->node = node;
  gen->proto = proto;
  gen->protoSrc = clauseSpec ? C->get(K_pad).obj() : defaultSpec ? st.defaultPad->s : nullptr;
  const U& type = node->get(K_type).str();
  // A MELF lies along its two pins, which also sets its end cap lands. decideAxial handles wires.
  if (body && body->kind == u"cyl" && L0 && L0->form == u"endcap" && type == u"Pins" && is(node->get(K_form), u"count")) {
    const U arr = node->get(K_arrangement).truthy() ? node->get(K_arrangement).str() : U(u"horizontal");
    if (arr == u"horizontal" || arr == u"vertical") makeAxial(arr == u"vertical" ? u'y' : u'x');
  }

  if (type == u"Balls" || is(node->get(K_form), u"grid")) {
    const double nx = countOf(node->get(K_nx).obj(), node), ny = countOf(node->get(K_ny).obj(), node);
    if (nx < 1 || ny < 1) throw StompError(u"a grid needs at least one row and one column", node);
    const std::optional<double> px = pitch ? std::optional<double>(pitch->first) : std::nullopt;
    const std::optional<double> py = pitch ? (pitch->second ? pitch->second : std::optional<double>(pitch->first)) : std::nullopt;
    if ((nx > 1 || ny > 1) && !px) throw StompError(u"the grid needs a `pitch:`", node);
    const bool isBalls = type == u"Balls";
    gen->kind = isBalls ? u"balls" : u"grid";
    if (isBalls && L0 && L0->form != u"ball" && L0->form != u"column")
      warn(u"`balls` implies `lead ball`, but the lead form here is `" + L0->form + u"`", L0->node);
    SpecP gridProto = proto;
    std::optional<U> derived;
    if (!gridProto) {
      gridProto = std::make_shared<const Spec>(ipcGridSpec(isBalls, node));
      derived = L0 && (L0->form == u"ball" || L0->form == u"column") ? u"ball" : u"tht";
    }
    const U sch = scheme ? *scheme : U(isBalls ? u"bga" : u"zigzag");
    if (sch == u"ccw" || sch == u"cw")
      throw StompError(u"`numbering: " + sch + u"` walks the package perimeter; grids use zigzag, row-major, col-major or bga",
                       C->get(K_numbering).obj());
    const GridNames names = number_grid(nx, ny, sch, start, px, py);
    const double pxv = px && js::truthy(*px) ? *px : 0, pyv = py && js::truthy(*py) ? *py : 0;
    const double m = js::min(px && js::truthy(*px) ? *px : INF, py && js::truthy(*py) ? *py : INF);
    for (double r = 0; r < ny; r++) {
      for (double c = 0; c < nx; c++) {
        auto p = std::make_shared<Pos>();
        p->name = names.name(c, r);
        p->x = (c - (nx - 1) / 2) * pxv;
        p->y = ((ny - 1) / 2 - r) * pyv;
        p->rot = 0;
        p->col = c;
        p->row = r;
        p->rowKey = names.rowKey(r);
        p->colKey = names.colKey(c);
        p->order = names.order(c, r);
        p->proto = gridProto;
        p->derived = derived;
        if (m < INF) p->pitch = m;
        gen->positions.push_back(std::move(p));
      }
    }
    gen->grid = Grid{nx, ny, sch, start, names};
  } else if (is(node->get(K_form), u"sides")) {
    gen->kind = u"sides";
    sidesLayout(node, pitch, proto);
  } else {
    countLayout(node, pitch, proto, scheme, start);
  }
  // pin 1 is first in numbering order (kept even if omitted, for the markers)
  std::vector<PosP> sorted = gen->positions;
  std::stable_sort(sorted.begin(), sorted.end(), [](const PosP& a, const PosP& b) { return a->order < b->order; });
  gen->pin1 = sorted.empty() ? nullptr : sorted[0];
  // duplicate names
  std::unordered_set<U> seen;
  for (const auto& p : gen->positions) {
    if (seen.count(p->name)) throw StompError(u"pin name " + p->name + u" is used twice by this generator", node);
    seen.insert(p->name);
  }
  depopulate();
  applyPinLeads();
  decideAxial();
}

/** Per-pin leads: re-derive a pin's land from its own lead, if its land was derived. */
void Builder::applyPinLeads() {
  if (!pinLeads.size()) return;
  const auto side_form = [](const U& f) {
    return f == u"gullwing" || f == u"jlead" || f == u"lbend" || f == u"straight" || f == u"flat" || f == u"endcap" || f == u"tab";
  };
  for (const auto& pos : gen->positions) {
    const PinLead* pl = pinLeads.get(pos->name);
    if (!pl) continue;
    const Lead& L = *pl->lead;
    if (L.form == u"none" || !pos->derived) continue;
    guard_void(L.node, [&] {
      const Spacing* sp = pos->axis ? gen->spacing(*pos->axis) : nullptr;
      if (*pos->derived == u"ipc" && sp && sp->ipc && side_form(L.form)) {
        std::optional<double> W = L.w, T = L.l;
        if (L.form == u"endcap" && !W && (L.v || L.d)) {
          T = L.v ? L.v : L.d;
          W = sp->ipc->W;
        }
        if (!W || !T) return;   // no size: keep the land, the 3D lead is sized from it
        const double span = L.span ? to_outer(*L.span, *T) : sp->ipc->L;
        const IpcLand ipc = ipcLand(*sp->ipc->table, span, *T, *W);
        pos->proto = std::make_shared<const Spec>(ipcSpec(ipc));
        const double c = (ipc.Z + ipc.G) / 4;
        if (pos->side == u"left") pos->x = -c;
        else if (pos->side == u"right") pos->x = c;
        else if (pos->side == u"bottom") pos->y = -c;
        else pos->y = c;
        pos->leadSpan = span;
      } else if (*pos->derived == u"tht" && (L.form == u"pin" || L.form == u"wire") && (L.d || L.w || L.v)) {
        pos->proto = std::make_shared<const Spec>(thtSpec(L));
      } else if (*pos->derived == u"ball" && (L.form == u"ball" || L.form == u"column") && (L.v || L.d)) {
        const double d = L.v ? *L.v : *L.d;
        Spec s = plain_spec(circle(ceil_to(L.form == u"ball" ? d * BALL_LAND : d + COLUMN_LAND, 0.01)));
        s.ipc = true;
        pos->proto = std::make_shared<const Spec>(std::move(s));
      }
    });
  }
}

/**
 * A cylinder lies down when its pins can't leave its bottom: always for end caps (a MELF),
 * and for wire leads outside the circle (an axial part). In 2D it's then a rectangle: h
 * along the pins, d across.
 */
void Builder::decideAxial() {
  if (!body || body->kind != u"cyl" || !gen || !lead || gen->kind != u"two" || gen->positions.size() != 2) return;
  const Pos& p = *gen->positions[0];
  const Pos& q = *gen->positions[1];
  const char16_t axis = std::fabs(p.x - q.x) >= std::fabs(p.y - q.y) ? u'x' : u'y';
  bool outside = true;
  for (const auto& g : gen->positions) outside = outside && js::hypot({g->x, g->y}) > body->w / 2 + 1e-9;
  if (!(lead->form == u"endcap" || (lead->form == u"wire" && outside))) return;
  makeAxial(axis);
}

void Builder::makeAxial(char16_t axis) {
  Body& b = *body;
  if (b.axial) return;
  const double d = b.w;
  const double len = b.h ? *b.h : NAN;
  b.axial = axis;
  b.d = d;
  b.kind = u"box";
  b.cylinder = true;
  if (axis == u'x') {
    b.w = len;
    b.l = d;
  } else {
    b.w = d;
    b.l = len;
  }
  b.h = d;
}

Spec Builder::ipcGridSpec(bool, const ObjP& node) {
  if (!lead) throw StompError(u"no pad geometry for the grid: add `default pad …`, a `pad …` clause, or a `lead`", node);
  const Lead& L = *lead;
  if (L.form == u"ball") {
    const std::optional<double> d = L.v ? L.v : L.d;
    if (!d) throw StompError(u"`lead ball` needs the ball diameter", L.node);
    ipcNote = u"ball lands: " + num_text(js::round(BALL_LAND * 100)) + u"% of the " + fmt_mm(*d) + u" ball (NSMD)";
    Spec s = plain_spec(circle(ceil_to(*d * BALL_LAND, 0.01)));
    s.ipc = true;
    return s;
  }
  if (L.form == u"column") {
    const std::optional<double> d = L.v ? L.v : L.d;
    if (!d) throw StompError(u"`lead column` needs the column diameter: `lead column d: 0.5`", L.node);
    ipcNote = u"column lands: the " + fmt_mm(*d) + u" column + " + fmt_mm(COLUMN_LAND);
    Spec s = plain_spec(circle(ceil_to(*d + COLUMN_LAND, 0.01)));
    s.ipc = true;
    return s;
  }
  if (L.form == u"pin" || L.form == u"wire") return thtSpec(L);
  throw StompError(u"can't derive grid pads from a `" + L.form + u"` lead — give `default pad …`", L.node);
}

Spec Builder::thtSpec(const Lead& L) {
  std::optional<double> dim = L.d ? L.d : L.w ? std::optional<double>(js::hypot({*L.w, L.l ? *L.l : NAN})) : L.v;
  if (!dim) throw StompError(u"`lead " + L.form + u"` needs its size (`d: 0.6` or `W x L`)", L.node);
  const double drill = ceil_to(*dim + THT_ALLOWANCE[lv], 0.05);
  const double pad = ceil_to(drill + 2 * THT_RING[lv], 0.05);
  ipcNote = u"through-hole: drill = lead " + fmt_mm(*dim) + u" + " + fmt_mm(THT_ALLOWANCE[lv]) + u", pad = drill + 2 × " + fmt_mm(THT_RING[lv]) +
            u" ring";
  Spec s = plain_spec(circle(pad));
  s.tht = true;
  s.drill = Drill{drill, 0, 0};
  s.ipc = true;
  return s;
}

/** Center-to-center row spacing along axis (x for left/right rows, y for top/bottom). */
Spacing Builder::rowSpacing(char16_t axis, const SpecP& proto, SpacingCtx& ctx) {
  const std::optional<double> bodyAlong = body ? std::optional<double>(axis == u'x' ? body->w : body->l) : std::nullopt;
  const std::optional<double> bodyAcross = body ? std::optional<double>(axis == u'x' ? body->l : body->w) : std::nullopt;
  const ObjP& node = ctx.node;
  const ObjP C = node->get(K_clauses).truthy() ? node->get(K_clauses).obj() : std::make_shared<Obj>();
  const auto padLen = [&]() {
    if (!proto) throw StompError(u"a pad-measured span needs pad geometry — add `default pad …`", node);
    const geom::Box bb = geom::contour_bbox(geom::transform_contour(geom::shape_contour(proto->shape, 0), rad(js::truthy(proto->rot) ? proto->rot : 0), 0, 0));
    if (!geom::box_valid(bb)) throw StompError(u"the default pad has zero size, so a pad-measured span can't place it", node);
    return bb.y1 - bb.y0;   // unrotated, the lead runs along y
  };
  const auto padMeasured = [&](double v, const U& qual) {
    const U q = qual.empty() ? U(u"outer") : qual;
    return q == u"centers" ? v : q == u"inner" ? v + padLen() : v - padLen();
  };
  // a bare span or gap measures pads and overrides everything
  if (st.bareSpan) {
    const ObjP& b = st.bareSpan->s;
    const U& word = b->get(K_word).str();
    const double v = plen(b->get(K_x), b, word);
    const U qual = word == u"gap" ? U(u"inner") : b->get(K_qual).truthy() ? b->get(K_qual).str() : U(u"outer");
    if (word == u"gap" && b->get(K_qual).truthy() && b->get(K_qual).str() != u"inner")
      warn(u"`gap` is always inner-to-inner; the qualifier is ignored", b);
    ctx.src->push_back(b);
    Spacing s;
    s.C = padMeasured(v, qual);
    s.how = word + u" " + fmt_mm(v) + u" (pads, " + qual + u")";
    return s;
  }
  std::optional<LeadSpan> pspan;
  if (C->get(K_span).truthy()) {
    const ObjP& sp = C->get(K_span).obj();
    LeadSpan ls;
    ls.v = plen(sp->get(K_x), node, u"span");
    ls.qual = sp->get(K_qual).truthy() ? sp->get(K_qual).str() : U(u"outer");
    pspan = ls;
  }
  if (!lead) {
    Spacing s;
    if (pspan) {
      s.C = padMeasured(pspan->v, pspan->qual);
      s.how = u"span " + fmt_mm(pspan->v) + u" (pads, " + pspan->qual + u")";
      return s;
    }
    if (ctx.twoPin && ctx.pitch) {
      s.C = *ctx.pitch;
      s.how = u"pitch " + fmt_mm(*ctx.pitch) + u" (centers)";
      return s;
    }
    throw StompError(u"the pad rows need a spacing: add `span: …` or `gap: …` (measured on the pads), or describe the leads with `lead … span: …`", node);
  }
  ctx.src->push_back(lead->node);
  const std::optional<LeadSpan> span = pspan ? pspan : lead->span;
  const U& f = lead->form;
  if (f == u"pin" || f == u"wire") {
    const std::optional<double> t = lead->d ? lead->d : lead->l ? lead->l : lead->v;
    Spacing s;
    if (!span) {
      if (ctx.twoPin && ctx.pitch) {
        s.C = *ctx.pitch;
        s.how = u"pitch " + fmt_mm(*ctx.pitch) + u" (lead centers)";
        return s;
      }
      throw StompError(u"through-hole rows need the lead spacing: add `span: … centers` to `pins` or `lead`", node);
    }
    const double tv = t && js::truthy(*t) ? *t : 0;
    s.C = span->qual == u"centers" ? span->v : span->qual == u"inner" ? span->v + tv : span->v - tv;
    s.how = u"lead span " + fmt_mm(span->v) + u" " + span->qual;
    return s;
  }
  if (f == u"ball" || f == u"column") throw StompError(u"`lead " + f + u"` belongs with `balls` or `pins grid`", lead->node);
  // SMD lead forms: IPC land from the lead span
  std::optional<double> T, W;
  if (f == u"castellated") {
    const std::optional<double> d = lead->d ? lead->d : lead->v;
    if (!d) throw StompError(u"`lead castellated` needs the hole size: `lead castellated d: 0.6`", lead->node);
    const std::optional<double> Lc = span ? std::optional<double>(to_outer(*span, 0)) : bodyAlong;
    if (!Lc) throw StompError(u"castellations need a `body` (they sit on its edges) or a span", node);
    Spacing s;
    s.C = *Lc;
    s.how = u"castellations on the body edge";
    s.castellated = *d;
    return s;
  }
  if (f == u"endcap") {
    if (lead->w) {
      W = lead->w;
      T = lead->l;
    } else {
      T = lead->v ? lead->v : lead->d;
      W = bodyAcross;
    }
    if (!T) throw StompError(u"`lead endcap` needs the termination length: `lead endcap 0.3`", lead->node);
    if (!W) throw StompError(u"endcap width defaults to the body width — add a `body`", lead->node);
  } else {
    if (!lead->w) throw StompError(u"`lead " + f + u"` needs `W x L` (lead width x foot length)", lead->node);
    W = lead->w;
    T = lead->l;
  }
  const bool flatish = f == u"flat" || f == u"endcap" || f == u"tab" || f == u"lbend";
  double L;
  if (span) L = to_outer(*span, T ? *T : NAN);
  else if (flatish && bodyAlong) L = *bodyAlong;
  else if (ctx.twoPin && ctx.pitch) {
    Spacing s;
    s.C = *ctx.pitch;
    s.how = u"pitch " + fmt_mm(*ctx.pitch) + u" (centers)";
    return s;
  } else if (bodyFailed && flatish) throw silent(lead->node);   // follows from the body error
  else throw StompError(u"`lead " + f + u"` needs a span: `lead " + f + u" … span S` (outer edge to outer edge)", lead->node);
  const IpcTable* table;
  if (f == u"gullwing") table = ctx.pitch && *ctx.pitch <= 0.625 + 1e-9 ? &ipc::gullwingFine : &ipc::gullwing;
  else if (f == u"jlead") table = &ipc::jlead;
  else if (f == u"lbend") table = &ipc::lbend;
  else if (f == u"straight") table = &ipc::straight;
  else if (f == u"endcap") table = (bodyAlong && *bodyAlong < 1.6 - 1e-9) ? &ipc::chipSmall : &ipc::chip;
  else table = &ipc::flat;
  const IpcLand land = ipcLand(*table, L, T ? *T : NAN, W ? *W : NAN);
  courtyardExcess = table->cy[lv];
  ipcNote = U(table->name) + u", density " + density + u": Z = " + fmt_mm(land.Z) + u", G = " + fmt_mm(land.G) + u", X = " + fmt_mm(land.X) +
            u" (toe " + fmt_mm(table->toe[lv]) + u", heel " + fmt_mm(table->heel[lv]) + u", side " + fmt_mm(table->side[lv]) + u")";
  Spacing s;
  s.C = (land.Z + land.G) / 2;
  s.ipc = land;
  s.how = u"IPC land from lead span " + fmt_mm(L);
  return s;
}

/** IPC-7351 land for one lead: outer span L, foot T, width W (all mm). */
IpcLand Builder::ipcLand(const IpcTable& table, double L, double T, double W) const {
  IpcLand r;
  r.Z = ceil_to(L + 2 * table.toe[lv] + D().tol, 0.01);
  r.G = floor_to(L - 2 * T - 2 * table.heel[lv] - D().tol, 0.01);
  if (r.G < 0) r.G = 0;
  r.X = ceil_to(W + 2 * table.side[lv] + D().tol, 0.01);
  r.len = (r.Z - r.G) / 2;
  r.table = &table;
  r.L = L;
  r.T = T;
  r.W = W;
  return r;
}

Spec Builder::ipcSpec(const IpcLand& land) const {
  geom::Shape sh;
  sh.kind = geom::Kind::Roundrect;
  sh.w = land.X;
  sh.l = land.len;
  sh.r = js::min(0.25 * js::min(land.X, land.len), 0.25);
  Spec s = plain_spec(std::move(sh));
  s.ipc = true;
  return s;
}

void Builder::countLayout(const ObjP& node, const std::optional<std::pair<double, std::optional<double>>>& pitch, const SpecP& proto,
                          const std::optional<U>& scheme, const U& start) {
  const double N = countOf(node->get(K_count).obj(), node);
  const ObjP count = node->get(K_count).obj();
  U arr = node->get(K_arrangement).truthy() ? node->get(K_arrangement).str() : U();
  if (arr.empty()) arr = N == 2 ? u"horizontal" : u"dual";
  std::vector<std::pair<U, double>> sideList;
  if (arr == u"dual") {
    if (N < 2 || std::fmod(N, 2) != 0) throw StompError(u"`pins " + num_text(N) + u" dual` needs an even count", count);
    sideList = {{u"left", N / 2}, {u"right", N / 2}};
  } else if (arr == u"quad") {
    if (N < 4 || std::fmod(N, 4) != 0)
      throw StompError(u"`pins " + num_text(N) + u" quad` needs a multiple of 4 (for uneven sides, list them under a `pins` line)", count);
    sideList = {{u"left", N / 4}, {u"bottom", N / 4}, {u"right", N / 4}, {u"top", N / 4}};
  } else if (arr == u"horizontal") {
    if (N != 2) throw StompError(u"`horizontal` is for two-terminal parts: `pins 2 horizontal`", count);
    sideList = {{u"left", 1}, {u"right", 1}};
  } else if (arr == u"vertical") {
    if (N != 2) throw StompError(u"`vertical` is for two-terminal parts: `pins 2 vertical`", count);
    sideList = {{u"top", 1}, {u"bottom", 1}};
  } else {
    if (N < 1) throw StompError(u"a single row needs at least one pin", count);
    sideList = {{node->get(K_side).is_str() ? node->get(K_side).str() : U(), N}};
  }
  gen->kind = arr == u"horizontal" || arr == u"vertical" ? U(u"two") : arr;
  const bool twoPin = gen->kind == u"two";
  const std::optional<double> P = pitch ? std::optional<double>(pitch->first) : std::nullopt;
  bool many = false;
  for (const auto& sd : sideList) many = many || sd.second > 1;
  if (!twoPin && many && !P) throw StompError(u"this package needs a `pitch:`", node);
  std::vector<SideEntry> entries;
  for (const auto& [side, k] : sideList) {
    SideEntry e;
    e.side = side;
    e.slots.resize(static_cast<std::size_t>(k));
    e.pitch = P;
    entries.push_back(std::move(e));
  }
  layoutSides(node, entries, proto, twoPin, P);
  // numbering
  const U sch = scheme ? *scheme : U(u"ccw");
  auto& pos = gen->positions;
  const ObjP clauses = node->get(K_clauses).truthy() ? node->get(K_clauses).obj() : nullptr;
  const ObjP numbering = clauses && clauses->get(K_numbering).truthy() ? clauses->get(K_numbering).obj() : nullptr;
  if (sch == u"bga") throw StompError(u"`numbering: bga` needs a grid (`balls` or `pins grid`)", numbering);
  if (sch == u"ccw" || sch == u"cw") {
    const std::vector<int> order = walk_order(pos, sch, start, arr == u"single");
    for (std::size_t k = 0; k < order.size(); ++k) {
      pos[order[k]]->name = num_text(static_cast<double>(k + 1));
      pos[order[k]]->order = static_cast<double>(k);
    }
    return;
  }
  if (arr == u"quad")
    throw StompError(u"`numbering: " + sch + u"` needs rows and columns; quad packages use ccw or cw", numbering);
  // treat the arrangement as a small grid
  double ncols = 1, nrows = 1;
  for (const auto& p : pos) {
    if (arr == u"dual" || arr == u"horizontal") p->col = p->side == u"left" ? 0 : 1;
    if (arr == u"vertical") p->row = p->side == u"top" ? 0 : 1;
  }
  if (arr == u"dual") {
    const double k = N / 2;
    ncols = 2;
    nrows = k;
    for (const auto& p : pos) p->row = p->side == u"left" ? p->walk : k - 1 - p->walk;
  } else if (arr == u"horizontal") {
    ncols = 2;
    nrows = 1;
    for (const auto& p : pos) p->row = 0;
  } else if (arr == u"vertical") {
    ncols = 1;
    nrows = 2;
    for (const auto& p : pos) p->col = 0;
  } else {
    const Val& s = node->get(K_side);
    for (const auto& p : pos) {
      if (is(s, u"bottom")) {
        p->col = p->walk;
        p->row = 0;
        ncols = N;
      } else if (is(s, u"top")) {
        p->col = N - 1 - p->walk;
        p->row = 0;
        ncols = N;
      } else if (is(s, u"left")) {
        p->row = p->walk;
        p->col = 0;
        nrows = N;
      } else {
        p->row = N - 1 - p->walk;
        p->col = 0;
        nrows = N;
      }
    }
  }
  const GridNames names = number_grid(ncols, nrows, sch, start, P, P);
  for (const auto& p : pos) {
    p->name = names.name(p->col, p->row);
    p->order = names.order(p->col, p->row);
  }
}

void Builder::sidesLayout(const ObjP& node, const std::optional<std::pair<double, std::optional<double>>>& pitch, const SpecP& proto) {
  std::unordered_set<U> seenSide;
  std::vector<SideEntry> entries;
  std::optional<double> lastPitch = pitch ? std::optional<double>(pitch->first) : std::nullopt;
  for (const Val& ev : node->get(K_sides).arr()->a) {
    const ObjP& ent = ev.obj();
    const U& side = ent->get(K_side).str();
    if (seenSide.count(side)) {
      err(u"side " + tick(side) + u" is listed twice", ent);
      continue;
    }
    seenSide.insert(side);
    std::optional<double> P;
    if (ent->get(K_pitch).truthy()) P = plen(ent->get(K_pitch), node, u"pitch");
    SideEntry e;
    e.side = side;
    for (const Val& pv : ent->get(K_positions).arr()->a) {
      const ObjP& p = pv.obj();
      Slot slot;
      if (p->get(K_nc).truthy()) slot.nc = true;
      else {
        const Val& n = p->get(K_name);
        slot.name = n.is_str() ? n.str() : num_text(n.num());
        slot.node = p;
      }
      e.slots.push_back(std::move(slot));
    }
    e.pitchGiven = P;
    e.node = ent;
    entries.push_back(std::move(e));
    if (P && !lastPitch) lastPitch = P;
  }
  for (auto& e : entries) {
    e.pitch = e.pitchGiven ? e.pitchGiven : lastPitch;
    if (e.slots.size() > 1 && !e.pitch) throw StompError(u"side " + tick(e.side) + u" needs a pitch", e.node);
  }
  const auto rank = [](const U& s) { return s == u"left" ? 0 : s == u"bottom" ? 1 : s == u"right" ? 2 : s == u"top" ? 3 : -1; };
  std::stable_sort(entries.begin(), entries.end(), [&](const SideEntry& a, const SideEntry& b) { return rank(a.side) < rank(b.side); });
  if (entries.empty()) throw StompError(u"the side block lists no pins", node);
  layoutSides(node, entries, proto, false, entries[0].pitch);
  double k = 0;
  // order: counterclockwise, as listed
  for (const auto& p : gen->positions) p->order = k++;
}

/** Place pins on the package sides, counterclockwise within each side. */
void Builder::layoutSides(const ObjP& node, std::vector<SideEntry>& entries, const SpecP& proto, bool twoPin, std::optional<double> pitch) {
  const auto has = [&](V s) {
    for (const auto& e : entries)
      if (e.side == s) return true;
    return false;
  };
  std::vector<ObjP> srcs;
  const bool needX = has(u"left") || has(u"right"), needY = has(u"top") || has(u"bottom");
  const bool single = entries.size() == 1;
  SpacingCtx c{node, twoPin, pitch, &srcs};
  gen->sx.reset();
  gen->sy.reset();
  std::optional<Spacing> sx, sy;
  if (needX) sx = rowSpacing(u'x', proto, c);
  if (needY) sy = rowSpacing(u'y', proto, c);
  gen->sx = sx;
  gen->sy = sy;
  gen->hasSpacing = true;
  gen->src = srcs;
  for (auto& e : entries) {
    const char16_t axis = (e.side == u"left" || e.side == u"right") ? u'x' : u'y';
    const Spacing* sp = gen->spacing(axis);
    if (!sp || !std::isfinite(sp->C)) throw StompError(u"the pad rows' spacing came out undefined — check the span and pad sizes", node);
    const double line = (e.side == u"left" || e.side == u"bottom" ? -1 : 1) * sp->C / 2;
    SpecP pr = proto;
    std::optional<U> derived;
    if (!pr && sp->ipc) {
      pr = std::make_shared<const Spec>(ipcSpec(*sp->ipc));
      derived = u"ipc";
    }
    if (!pr && sp->castellated) {
      const double d = *sp->castellated;
      geom::Shape sh;
      sh.kind = geom::Kind::Rect;
      sh.w = ceil_to(d + 0.4, 0.01);
      sh.l = ceil_to(d + 0.8, 0.01);
      Spec s = plain_spec(std::move(sh));
      s.ipc = true;
      s.castellated = d;
      pr = std::make_shared<const Spec>(std::move(s));
      derived = u"cast";
    }
    if (!pr && lead && (lead->form == u"pin" || lead->form == u"wire")) {
      pr = std::make_shared<const Spec>(thtSpec(*lead));
      derived = u"tht";
    }
    const double k = static_cast<double>(e.slots.size());
    const double P = e.pitch && js::truthy(*e.pitch) ? *e.pitch : 0;
    const double rot = e.side == u"bottom" ? 0 : e.side == u"right" ? 90 : e.side == u"top" ? 180 : e.side == u"left" ? 270 : NAN;
    for (std::size_t i = 0; i < e.slots.size(); ++i) {
      const Slot& slot = e.slots[i];
      if (slot.nc) continue;
      const double o = (static_cast<double>(i) - (k - 1) / 2) * P;
      double x, y;
      if (e.side == u"left") {
        x = line;
        y = -o;
      } else if (e.side == u"bottom") {
        x = o;
        y = line;
      } else if (e.side == u"right") {
        x = line;
        y = o;
      } else {
        x = -o;
        y = line;
      }
      double shift = 0;
      if (sp->castellated) shift = 0.2;   // nudge edge lands outward
      if (e.side == u"left") x -= shift;
      if (e.side == u"right") x += shift;
      if (e.side == u"bottom") y -= shift;
      if (e.side == u"top") y += shift;
      auto p = std::make_shared<Pos>();
      p->name = slot.name;
      p->x = x;
      p->y = y;
      p->side = e.side;
      p->rot = rot;
      p->walk = static_cast<double>(i);
      p->proto = pr;
      p->node = slot.node;
      p->derived = derived;
      p->axis = axis;
      if (e.pitch && js::truthy(*e.pitch)) p->pitch = e.pitch;
      gen->positions.push_back(std::move(p));
    }
  }
  if (single && !entries[0].slots.empty() && gen->positions.empty()) throw StompError(u"every position is `nc`", node);
}

void Builder::depopulate() {
  OrderedMap<U, PosP> byName;
  for (const auto& p : gen->positions) byName.set(p->name, p);
  const auto regionMatch = [&](const Pos& p, const ObjP& it, const ObjP& node) {
    if (!gen->grid) throw StompError(u"`rows`/`cols` regions apply to grids (`balls` / `pins grid`)", node);
    const auto inRange = [&](double key, const ArrP& range, bool isRow) {
      const auto ix = [&](const U& v) -> double {
        bool letters = isRow && (v.size() == 1 || v.size() == 2);
        for (char16_t ch : v) letters = letters && ch >= u'A' && ch <= u'Z';
        if (letters) return jedec_index(v);
        if (is_digits(v)) return js::parse_float(v) - 1;
        throw StompError(tick(v) + u" isn't a " + (isRow ? u"row letter or number" : u"column number"), node);
      };
      const auto rangeName = [](const Val& r) { const Val& n = r.obj()->get(K_name); return n.is_str() ? n.str() : num_text(n.num()); };
      const double a = ix(rangeName(range->a[0])), b = ix(rangeName(range->a[1]));
      return key >= js::min(a, b) && key <= js::max(a, b);
    };
    const double rIdx = gen->grid->names.ri(p.row), cIdx = gen->grid->names.ci(p.col);
    if (it->get(K_rows).truthy() && !inRange(rIdx, it->get(K_rows).arr(), true)) return false;
    if (it->get(K_cols).truthy() && !inRange(cIdx, it->get(K_cols).arr(), false)) return false;
    return true;
  };
  const auto select = [&](const ObjP& it, const ObjP& node) {
    std::vector<PosP> out;
    if (it->get(K_rows).truthy() || it->get(K_cols).truthy()) {
      for (const auto& p : gen->positions)
        if (regionMatch(*p, it, node)) out.push_back(p);
      return out;
    }
    std::vector<U> names;
    if (it->get(K_range).truthy()) {
      const auto& r = it->get(K_range).arr()->a;
      names = expand_range(r[0].obj(), r[1].obj(), node);
    } else {
      const Val& n = it->get(K_name).obj()->get(K_name);
      names.push_back(n.is_str() ? n.str() : num_text(n.num()));
    }
    for (const U& n : names) {
      if (const PosP* p = byName.get(n)) {
        out.push_back(*p);
        continue;
      }
      const auto hint = suggest(n, byName.keys());
      err(u"there is no generated pin " + tick(n) + u" to " + (is(node->get(K_type), u"Omit") ? u"omit" : u"keep") +
              (hint ? u" — did you mean " + tick(*hint) + u"?" : U()),
          it->get(K_name).truthy() ? it->get(K_name).obj() : it);
    }
    return out;
  };
  std::optional<std::unordered_set<const Pos*>> keep;
  for (const auto& o : st.onlys) {
    guard_void(o.s, [&] {
      if (!keep) keep.emplace();
      for (const Val& it : o.s->get(K_items).arr()->a)
        for (const auto& p : select(it.obj(), o.s)) keep->insert(p.get());
    });
  }
  std::unordered_set<const Pos*> drop;
  for (const auto& o : st.omits) {
    guard_void(o.s, [&] {
      for (const Val& it : o.s->get(K_items).arr()->a)
        for (const auto& p : select(it.obj(), o.s)) drop.insert(p.get());
    });
  }
  std::vector<PosP> omitted, kept;
  for (const auto& p : gen->positions) {
    const bool out = drop.count(p.get()) || (keep && !keep->count(p.get()));
    (out ? omitted : kept).push_back(p);
  }
  gen->omitted = std::move(omitted);
  gen->positions = std::move(kept);
}

}  // namespace stomp::compiler
