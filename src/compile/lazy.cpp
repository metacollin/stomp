// The automatic silk, assembly and courtyard (compile.js 2986-3011, 3145-3379), computed on
// first use: only footprints on screen need them.
#include <cmath>

#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
struct AutoLine {
  Poly pts;
  bool closed = false;
  std::optional<double> w;
  Val src;
};
using Map2 = std::array<double, 4>;

double sign_or(double v, double fallback) {
  const double s = js::sign(v);
  return js::truthy(s) ? s : fallback;
}
double fixed4(double v) { return js::parse_float(js::u16(js::to_fixed(v, 4))); }
}  // namespace

namespace {

/** Place a mark's items: at `at`, through the 2x2 map m (a turn or a mirror). Lines marked
 *  `clear` join the automatic outline, to be cut back from the copper. */
void put_marks(const std::optional<Gfxs>& items, Pt at, const Map2& m, const ObjP& src, std::vector<AutoLine>& autos, Gfxs& out) {
  const MapFn map = [at, m](Pt q) { return Pt{at.x + q.x * m[0] + q.y * m[1], at.y + q.x * m[2] + q.y * m[3]}; };
  for (Gfx& it : map_items(items ? *items : Gfxs{}, map, src ? Val(src) : Val())) {
    if (it.clear && it.type == u"line") {
      autos.push_back({it.pts ? *it.pts : Poly{}, false, it.w, it.src});
      continue;
    }
    it.auto_ = true;
    out.push_back(std::move(it));
  }
}

/** How far a mark's items reach from its origin. */
double mark_extent(const Gfxs& items) {
  double r = 0;
  for (const Gfx& it : items) {
    Poly qs;
    if (it.pts) qs = *it.pts;
    else if (it.c) qs = {*it.c};
    else if (it.at) qs = {*it.at};
    for (const Pt& q : qs) r = js::max(r, js::hypot({q.x, q.y}) + (js::truthy(it.r) ? it.r : 0));
  }
  return r;
}

}  // namespace

void Builder::finishLayers() {
  if (finished) return;
  finished = true;
  keepouts.clear();
  pads.each([&](const U&, const PadP& p) {
    const Spec& s = *p->spec;
    const double m = s.mask && s.mask->mode == u"none" ? 0 : (s.mask && s.mask->mode == u"expand" ? js::max(0, s.mask->v) : D().mask);
    const double grow = (s.mask && s.mask->mode == u"defined" ? D().maskDefinedOverlap : m) + D().silkClear + D().silkW / 2;
    keepouts.push_back(geom::contour_to_poly(geom::transform_contour(geom::shape_contour(s.shape, grow), rad(p->rot), *p->x, *p->y), rad(8)));
  });
  holes.each([&](const U&, const HoleP& h) {
    keepouts.push_back(geom::contour_to_poly(
        geom::transform_contour(geom::shape_contour(h->shape, D().holeMask + D().silkClear + D().silkW / 2), 0, h->x, h->y), rad(8)));
  });
  for (void (Builder::*fn)() : {&Builder::silkLayer, &Builder::assemblyLayer, &Builder::courtyardLayer}) {
    try {
      (this->*fn)();
    } catch (...) {
      // a layer that fails draws what it had so far (compile.js logs it)
    }
  }
  // manual items and footprint-level text come after the automatic ones; silk lines marked
  // `clear` are cut back from the copper
  for (const Gfx& it : manual.silk) {
    if (!(it.clear && it.type == u"line")) {
      lay.silk.push_back(it);
      continue;
    }
    for (Poly& piece : geom::clip_polyline_outside(it.pts ? *it.pts : Poly{}, keepouts, false)) {
      if (geom::path_length(piece) >= 2 * (it.w ? *it.w : NAN)) {
        Gfx g = it;
        g.pts = std::move(piece);
        lay.silk.push_back(std::move(g));
      }
    }
  }
  for (const Gfx& it : manual.assembly) lay.assembly.push_back(it);
  for (const Gfx& it : manual.courtyard) lay.courtyard.push_back(it);
}

ObjP Builder::lazyFields() {
  finishLayers();
  geom::Box bb = core;
  for (const Gfxs* layer : {&lay.silk, &lay.courtyard, &lay.assembly}) {
    for (const Gfx& it : *layer) {
      if (it.pts)
        for (const Pt& p : *it.pts) geom::add_pt(bb, p);
      if (it.c) {
        geom::add_pt(bb, {it.c->x - it.r, it.c->y - it.r});
        geom::add_pt(bb, {it.c->x + it.r, it.c->y + it.r});
      }
      if (it.at) geom::add_pt(bb, *it.at);
    }
  }
  geom::Box cy;
  for (const Gfx& it : lay.courtyard)
    if (it.pts)
      for (const Pt& p : *it.pts) geom::add_pt(cy, p);
  return rec({{K_silk, gfxs_val(lay.silk)},
              {K_assembly, gfxs_val(lay.assembly)},
              {K_courtyard, gfxs_val(lay.courtyard)},
              {K_bbox, box_val(bb)},
              {K_courtyardBox, geom::box_valid(cy) ? box_val(cy) : Val(nullptr)},
              {K_courtyardClearance, courtyardClearance ? Val(*courtyardClearance) : Val()}});
}

void Builder::silkLayer() {
  Gfxs& out = lay.silk;
  const U base = layerBase(u"silk");
  const double w = D().silkW;
  if (base != u"auto") return;
  std::vector<AutoLine> autos;
  const U& style = pin1Style;
  const auto corner = pin1Corner();
  if (body) {
    const Body& b = *body;
    OutlineMods mods;
    if (b.kind == u"box" && pin1 && style == u"chamfer") {
      const double c = chamferSize(corner);
      if (js::truthy(c)) mods.chamfer = OutlineMods::Chamfer{*corner, c};
    }
    if (b.kind == u"box" && pin1 && style == u"notch") {
      const U edge = pin1End(corner);
      const double edgeLen = edge == u"top" || edge == u"bottom" ? b.w : b.l;
      mods.notch = OutlineMods::Notch{edge, js::min(1.0, 0.15 * edgeLen)};
    }
    autos.push_back({bodyOutline(D().silkOffset, &mods), true, std::nullopt, Val()});
    if (b.kind == u"box" && pin1 && style == u"bar" && marks2d.bar) {
      // drawn for the top end; turned or mirrored so the body stays below it
      const double hw = b.w / 2 + D().silkOffset, hl = b.l / 2 + D().silkOffset;
      const U& edge = marks2d.bar->edge;
      Pt at;
      Map2 m;
      if (edge == u"top") {
        at = {*b.x, *b.y + hl};
        m = {1, 0, 0, 1};
      } else if (edge == u"bottom") {
        at = {*b.x, *b.y - hl};
        m = {1, 0, 0, -1};
      } else if (edge == u"left") {
        at = {*b.x - hw, *b.y};
        m = {0, -1, 1, 0};
      } else {
        at = {*b.x + hw, *b.y};
        m = {0, 1, 1, 0};
      }
      put_marks(marks2d.bar->items, at, m, marks2d.bar->src, autos, out);
    }
  }
  if (polarized) {
    // the polarity marks: a hatch and a "+" on a round part, else a bar beyond the marked
    // pin's land (the pin the `polarity` feature names)
    if (const auto& P = marks2d.polarity) {
      const Pad& mk = *P->mk;
      if (body && body->kind == u"cyl") {
        const Pt u = P->horiz ? Pt{sign_or(*mk.x - P->cx, 1), 0} : Pt{0, sign_or(*mk.y - P->cy, 1)};
        put_marks(P->hatch, {P->cx, P->cy}, {u.x, -u.y, u.y, u.x}, P->src, autos, out);
        if (P->other && P->plus) {
          const Pad& o = *P->other;
          const double ext = (P->horiz ? (o.bb.x.hi - o.bb.x.lo) : (o.bb.y.hi - o.bb.y.lo)) / 2;
          const double k = ext + 0.55;
          put_marks(P->plus, P->horiz ? Pt{*o.x, *o.y + k} : Pt{*o.x + k, *o.y}, {1, 0, 0, 1}, P->src, autos, out);
        }
      } else {
        const double grow = D().mask + D().silkClear + D().silkW / 2 + 0.05;
        if (P->horiz) {
          const double sgn = sign_or(*mk.x - P->cx, 1);
          const double x = sgn > 0 ? *mk.x + mk.bb.x.hi + grow : *mk.x + mk.bb.x.lo - grow;
          put_marks(P->bar, {x, P->cy}, {1, 0, 0, 1}, P->src, autos, out);
        } else {
          const double sgn = sign_or(*mk.y - P->cy, 1);
          const double y = sgn > 0 ? *mk.y + mk.bb.y.hi + grow : *mk.y + mk.bb.y.lo - grow;
          put_marks(P->bar, {P->cx, y}, {0, 1, -1, 0}, P->src, autos, out);
        }
      }
    }
  }
  // clip against copper keep-outs
  for (const AutoLine& pl : autos) {
    const double lw = pl.w && js::truthy(*pl.w) ? *pl.w : w;
    for (Poly& piece : geom::clip_polyline_outside(pl.pts, keepouts, pl.closed)) {
      if (geom::path_length(piece) >= 2 * lw) {   // no specks
        Gfx g;
        g.type = u"line";
        g.pts = std::move(piece);
        g.w = lw;
        g.auto_ = true;
        g.src = pl.src;
        out.push_back(std::move(g));
      }
    }
  }
  const bool box = body && body->kind == u"box";
  if (pin1 && style == u"feature" && pin1Feature) {
    // a custom pin-1 feature, centered where the dot would go and moved out to clear the
    // copper by its own size
    Gfxs all = pin1Feature->silk;
    all.insert(all.end(), pin1Feature->assembly.begin(), pin1Feature->assembly.end());
    if (auto c = pin1Spot(js::max(mark_extent(all), D().dot / 2))) {
      const MapFn map = [c](Pt q) { return Pt{c->x + q.x, c->y + q.y}; };
      const ObjP node = st.pin1->s;
      for (auto& g : map_items(pin1Feature->silk, map, node)) out.push_back(std::move(g));
      for (auto& g : map_items(pin1Feature->assembly, map, node)) lay.assembly.push_back(std::move(g));
    }
  }
  const auto pin1Dot = [&]() {
    const auto& m = marks2d.dot;
    if (!m || !m->items) return;
    const auto c = pin1Spot(js::max(mark_extent(*m->items), D().dot / 2));
    if (!c) return;
    for (Gfx& it : map_items(*m->items, [c](Pt q) { return Pt{c->x + q.x, c->y + q.y}; }, m->src ? Val(m->src) : Val())) {
      it.auto_ = true;
      out.push_back(std::move(it));
    }
  };
  if (pin1 && (style == u"dot" || (style == u"chamfer" && !box))) pin1Dot();
  if (pin1 && style == u"chamfer" && box && !js::truthy(chamferSize(corner))) pin1Dot();
}

double Builder::chamferSize(const std::optional<U>& corner) {
  if (!corner) return 0;
  const Body& b = *body;
  const double o = D().silkOffset;
  const double hw = b.w / 2 + o, hl = b.l / 2 + o;
  const bool left = (*corner)[1] == u'l', top = (*corner)[0] == u't';
  const Pt K{*b.x + (left ? -hw : hw), *b.y + (top ? hl : -hl)};
  const auto leg = [&](Pt dir, double len) {
    const Pt end{K.x + dir.x * len, K.y + dir.y * len};
    for (const Poly& pc : geom::clip_polyline_outside({K, end}, keepouts, false))
      if (geom::dist(pc[0], K) < 1e-6) return geom::path_length(pc);
    return 0.0;
  };
  const double lx = leg({left ? 1.0 : -1.0, 0}, 2 * hw);
  const double ly = leg({0, top ? -1.0 : 1.0}, 2 * hl);
  const double c = js::min(js::min(js::min(lx, ly), 1.0), 0.25 * js::min(b.w, b.l));
  if (c < 0.15) return 0;
  return c;
}

/** Where a pin-1 mark of radius r goes: outside the corner nearest pin 1, clear of copper. */
std::optional<Pt> Builder::pin1Spot(double r) {
  const Pin1& p1 = *pin1;
  std::vector<Pt> cands;
  if (body && body->kind == u"box") {
    const Body& b = *body;
    const double sx = p1.x <= *b.x ? -1 : 1, sy = p1.y >= *b.y ? 1 : -1;
    const double k = D().silkOffset + r + 0.15;
    cands.push_back({*b.x + sx * (b.w / 2 + k), *b.y + sy * (b.l / 2 + k)});
  }
  if (p1.pad) {
    const Pad& pd = *p1.pad;
    const std::optional<U> side = pd.gen ? pd.gen->side : std::nullopt;
    const double cx = body ? *body->x : 0, cy = body ? *body->y : 0;
    Pt out2;
    if (side == u"left") out2 = {-1, 0};
    else if (side == u"right") out2 = {1, 0};
    else if (side == u"top") out2 = {0, 1};
    else if (side == u"bottom") out2 = {0, -1};
    else out2 = std::fabs(*pd.x - cx) >= std::fabs(*pd.y - cy) ? Pt{sign_or(*pd.x - cx, -1), 0} : Pt{0, sign_or(*pd.y - cy, 1)};
    const double ext = js::truthy(out2.x) ? (out2.x > 0 ? pd.bb.x.hi : -pd.bb.x.lo) : (out2.y > 0 ? pd.bb.y.hi : -pd.bb.y.lo);
    const double k = ext + D().mask + D().silkClear + r + 0.1;
    cands.push_back({*pd.x + out2.x * k, *pd.y + out2.y * k});
    const Pt along = js::truthy(out2.x) ? Pt{0, 1} : Pt{-1, 0};
    const double ext2 = js::truthy(along.y) ? pd.bb.y.hi : -pd.bb.x.lo;
    const double k2 = ext2 + D().mask + D().silkClear + r + 0.1;
    cands.push_back({*pd.x + along.x * k2, *pd.y + along.y * k2});
  } else if (!body) {
    cands.push_back({p1.x - 1, p1.y + 1});
  }
  for (const Pt& c : cands) {
    bool blocked = false;
    for (const Poly& k : keepouts) blocked = blocked || geom::point_in_poly(c, k) || min_dist_to_poly(c, k) < r;
    if (!blocked) return c;
  }
  if (!cands.empty()) return cands[0];
  return std::nullopt;
}

void Builder::assemblyLayer() {
  Gfxs& out = lay.assembly;
  if (layerBase(u"assembly") != u"auto" || !body) return;
  const Body& b = *body;
  OutlineMods mods;
  if (b.kind == u"box" && pin1 && gen && gen->kind != u"two" && pin1Style != u"none") {
    const U corner = U(1, pin1->y >= *b.y ? u't' : u'b') + U(1, pin1->x <= *b.x ? u'l' : u'r');
    mods.chamfer = OutlineMods::Chamfer{corner, js::min(1.0, 0.25 * js::min(b.w, b.l))};
  }
  Poly outline = bodyOutline(0, &mods);
  const Poly again = bodyOutline(0, &mods);
  if (!again.empty()) outline.push_back(again[0]);
  Gfx line;
  line.type = u"line";
  line.pts = std::move(outline);
  line.w = D().fabW;
  line.auto_ = true;
  out.push_back(std::move(line));
  const U label = refLabel();
  const double size = geom::clamp(0.3 * js::min(b.w, b.l), 0.2, 1.0);
  const double maxW = 0.85 * (b.kind == u"cyl" ? b.w * 0.7 : b.w);
  const double fit = js::min(size, maxW / (0.62 * static_cast<double>(label.size())));
  Gfx text;
  text.type = u"text";
  text.at = Pt{*b.x, *b.y};
  text.size = fit;
  text.str = label;
  text.auto_ = true;
  out.push_back(std::move(text));
  // castellation half-holes
  if (gen && lead && lead->form == u"castellated") {
    const double d = lead->d ? *lead->d : lead->v ? *lead->v : NAN;
    pads.each([&](const U&, const PadP& p) {
      if (!p->gen || !p->gen->side) return;
      const U& side = *p->gen->side;
      const double ex = side == u"left" ? *b.x - b.w / 2 : side == u"right" ? *b.x + b.w / 2 : *p->x;
      const double ey = side == u"bottom" ? *b.y - b.l / 2 : side == u"top" ? *b.y + b.l / 2 : *p->y;
      const double a0 = side == u"bottom" ? 0 : side == u"right" ? geom::PI / 2 : side == u"top" ? geom::PI : side == u"left" ? -geom::PI / 2 : NAN;
      Gfx arc;
      arc.type = u"line";
      arc.pts = geom::arc_points({side == u"left" || side == u"right" ? ex : *p->x, side == u"top" || side == u"bottom" ? ey : *p->y}, d / 2, a0,
                                 a0 + geom::PI);
      arc.w = D().fabW;
      arc.auto_ = true;
      out.push_back(std::move(arc));
    });
  }
}

void Builder::courtyardLayer() {
  Gfxs& out = lay.courtyard;
  const U mode = cyBase ? cyBase->mode : U(u"none");
  if (mode == u"auto") {
    const double c = cyBase->c ? *cyBase->c : NAN;
    Poly pts;
    pads.each([&](const U&, const PadP& p) {
      for (const Pt& q : geom::contour_to_poly(p->copper, rad(10))) pts.push_back(q);
    });
    holes.each([&](const U&, const HoleP& h) {
      for (const Pt& q : geom::contour_to_poly(h->land, rad(10))) pts.push_back(q);
    });
    if (body)
      for (const Pt& q : bodyOutline(0, nullptr)) pts.push_back(q);
    if (pts.size() >= 3) {
      // the smallest rectangle around everything, plus the clearance, out to a 0.01 mm grid
      geom::Box bb;
      for (const Pt& q : pts) geom::add_pt(bb, q);
      const auto snap = [](double v, bool up) { return fixed4(up ? ceil_to(v, 0.01) : floor_to(v, 0.01)); };
      Gfx g = rect_item(snap(bb.x0 - c, false), snap(bb.y0 - c, false), snap(bb.x1 + c, true), snap(bb.y1 + c, true), D().crtW);
      g.auto_ = true;
      out.push_back(std::move(g));
      courtyardClearance = c;
    }
  } else if (mode == u"rect" && cyBase->w && cyBase->l) {
    const double w = *cyBase->w, l = *cyBase->l;
    const Pt c = body ? Pt{*body->x, *body->y} : shift({0, 0});
    Gfx g = rect_item(c.x - w / 2, c.y - l / 2, c.x + w / 2, c.y + l / 2, D().crtW);
    g.src = cyBase->node ? Val(cyBase->node) : Val();
    out.push_back(std::move(g));
  } else if (mode == u"box" && cyBase->box) {
    const auto& k = *cyBase->box;
    Gfx g = rect_item(k.x0, k.y0, k.x1, k.y1, k.w && js::truthy(*k.w) ? *k.w : D().crtW);
    g.src = k.node ? Val(k.node) : Val();
    out.push_back(std::move(g));
  }
}

}  // namespace stomp::compiler
