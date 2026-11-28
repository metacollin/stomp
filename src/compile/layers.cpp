// Final positions and the layers that report problems (compile.js 2415-2627, 3012-3516):
// copper, mask, paste and drills; pin 1; manual graphics and text; the courtyard settings;
// the automatic marks' items; and the overlap check. The automatic silk, assembly and
// courtyard geometry waits for finishLayers (lazy.cpp).
#include <algorithm>
#include <cmath>

#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
constexpr std::array<double, 3> CY_DEFAULT{0.5, 0.25, 0.1};
}  // namespace

void Builder::layers() {
  const auto pos = [&](Unit* u, const Off& off) { return std::make_pair(vals[0][u->id] + off.x, vals[1][u->id] + off.y); };
  pads.each([&](const U&, PadP& p) {
    const auto [x, y] = pos(p->unit, p->off);
    p->x = x;
    p->y = y;
  });
  holes.each([&](const U&, HoleP& h) {
    const auto [x, y] = pos(h->unit, h->off);
    h->x = x;
    h->y = y;
  });
  // body: as placed, at the generator center, or centered on the land pattern
  if (body) {
    Body& b = *body;
    const auto land = landBox();
    for (char16_t a : {u'x', u'y'}) {
      const bool solved = varsByAxis[ai(a)].count(bodyUnit->id) > 0;
      const double v = solved ? vals[ai(a)][bodyUnit->id] : (land ? (a == u'x' ? (land->x0 + land->x1) / 2 : (land->y0 + land->y1) / 2) : 0);
      (a == u'x' ? b.x : b.y) = v;
      vals[ai(a)][bodyUnit->id] = v;
    }
  }
  // final origin
  Off o{0, 0};
  const std::optional<Item>& og = st.origin;
  if (originUsed) o = {vals[0][originUnit->id], vals[1][originUnit->id]};
  else if (og) {
    const ObjP s = og->s;
    guard_void(s, [&] {
      if (s->get(K_point).truthy()) {
        const ObjP& point = s->get(K_point).obj();
        const double x = len(point->get(K_x), s), y = len(point->get(K_y), s);
        o = {x, y};
      } else if (s->get(K_ref).truthy()) {
        const ObjP& ref = s->get(K_ref).obj();
        const Info inf = info(ref);
        const double x = anchor(inf, u'x', whichStatic(ref, u'x')).f(vals[0]);
        const double y = anchor(inf, u'y', whichStatic(ref, u'y')).f(vals[1]);
        o = {x, y};
      } else {
        const auto& btw = s->get(K_between).arr()->a;
        const Info A = info(btw[0].obj()), B = info(btw[1].obj());
        const double x = (anchor(A, u'x', u"center").f(vals[0]) + anchor(B, u'x', u"center").f(vals[0])) / 2;
        const double y = (anchor(A, u'y', u"center").f(vals[1]) + anchor(B, u'y', u"center").f(vals[1])) / 2;
        o = {x, y};
      }
    });
  }
  O = o;
  U floatAxes;
  if (floatX) floatAxes = u"x";
  if (floatY) floatAxes += floatAxes.empty() ? U(u"y") : U(u" or y");
  if (og) originNote = stmtText(og->s);
  else if (!floatAxes.empty())
    originNote = U(body ? u"body center" : u"land-pattern center") + u": nothing fixes the layout on " + floatAxes + u", so the origin rule centers it";
  else if (body && gen) originNote = u"body center (generated package)";
  else originNote = u"(0, 0), where the placements put it";
  pads.each([&](const U&, PadP& p) {
    *p->x -= O.x;
    *p->y -= O.y;
  });
  holes.each([&](const U&, HoleP& h) {
    h->x -= O.x;
    h->y -= O.y;
  });
  if (body) {
    *body->x -= O.x;
    *body->y -= O.y;
  }
  // copper / mask / paste / drills
  lay = {};
  manual = {};
  pads.each([&](const U&, PadP& p) { padLayers(*p); });
  holes.each([&](const U&, HoleP& h) { holeLayers(*h); });
  // Everything that can report a problem runs now; the automatic silk, assembly and
  // courtyard geometry waits for finishLayers(), on first use.
  const std::pair<const char16_t*, void (Builder::*)()> steps[] = {
      {u"pin 1", &Builder::pin1Info}, {u"graphics", &Builder::manualLayers}, {u"text", &Builder::textLayer}};
  for (const auto& [what, fn] : steps) {
    try {
      (this->*fn)();
    } catch (const StompError& e) {
      if (!e.silent) err(e.message, e.node);
    } catch (const std::exception& e) {
      err(u"internal error while drawing the " + U(what) + u" layer: " + js::u16(e.what()), range(decl->get(K_nameS).num(), decl->get(K_nameE).num()));
    }
  }
}

/** Manual graphics, text and courtyard settings, evaluated now for their diagnostics. */
void Builder::manualLayers() {
  for (const auto& it : st.silk)
    if (is(it.s->get(K_mode), u"block")) gfx(it.s->get(K_items).arr(), u"silk", manual.silk, D().silkW);
  for (const auto& it : st.assembly)
    if (is(it.s->get(K_mode), u"block")) gfx(it.s->get(K_items).arr(), u"assembly", manual.assembly, D().fabW);
  // The courtyard is one rectangle: auto [clearance], rect W x L, none, or a rect or polygon
  // holding one rectangle. The last statement wins; a child's replaces its parent's.
  CyBase base;
  base.mode = u"auto";
  base.clearance = nullptr;
  const Item* prev = nullptr;
  for (const auto& it : st.courtyard) {
    if (prev && prev->level == it.level)
      warn(u"the courtyard is set twice in this footprint; the later one wins", it.s, {{u"first set here", prev->s}});
    prev = &it;
    base = CyBase{};
    if (is(it.s->get(K_mode), u"block")) {
      base.mode = u"box";
      base.node = it.s;
      base.items = it.s->get(K_items).arr();
    } else {
      base.mode = it.s->get(K_mode).str();
      base.node = it.s;
      base.clearance = it.s->get(K_clearance);
      base.size = it.s->get(K_size);
    }
  }
  if (base.mode == u"auto") {
    std::optional<double> c = courtyardExcess ? *courtyardExcess : CY_DEFAULT[lv];
    if (base.clearance.truthy()) c = guard(base.node, [&] { return plen(base.clearance, base.node, u"courtyard clearance"); });
    base.c = c ? *c : CY_DEFAULT[lv];
  } else if (base.mode == u"rect") {
    guard_void(base.node, [&] {
      const ObjP& size = base.size.obj();
      base.w = plen(size->get(K_w), base.node, u"courtyard width");
      base.l = plen(size->get(K_l), base.node, u"courtyard length");
    });
  } else if (base.mode == u"box") {
    auto box = guard(base.node, [&] { return courtyardBox(base.items, base.node); });
    if (box && *box) base.box = **box;
  }
  cyBase = base;
  // custom features: placed ones now, pin 1's once the copper is known (silkLayer)
  pin1Feature.reset();
  const ObjP p1s = st.pin1 ? st.pin1->s : nullptr;
  if (p1s && is(p1s->get(K_style), u"feature")) {
    if (auto fi = guard(p1s, [&] { return featureItems(p1s->get(K_feature).obj(), p1s); })) pin1Feature = std::move(*fi);
  }
  for (const auto& it : st.features) {
    guard_void(it.s, [&] {
      const ObjP& u = it.s;
      const FeatureItems fi = featureItems(u->get(K_feature).obj(), u);
      const Pt at = featureAt(u);
      const auto cs = geom::cos_sin(u->get(K_rotate).truthy() ? deg(u->get(K_rotate).obj()->get(K_z), u) : 0);
      const MapFn map = [at, cs](Pt q) { return Pt{at.x + q.x * cs[0] - q.y * cs[1], at.y + q.x * cs[1] + q.y * cs[0]}; };
      for (auto& g : map_items(fi.silk, map, u)) manual.silk.push_back(std::move(g));
      for (auto& g : map_items(fi.assembly, map, u)) manual.assembly.push_back(std::move(g));
    });
  }
  // polarity marks need a two-terminal part
  if (polarized && layerBase(u"silk") == u"auto") {
    if (!gen || gen->kind != u"two" || !pads.has(u"2")) warn(u"`polarized` marks two-terminal parts (pins 1 and 2)", st.polarized->s);
  }
  marks2d = layerBase(u"silk") == u"auto" ? evalMarks() : Marks{};
}

/** Where a footprint's `feature NAME at …` goes, in footprint coordinates: its point, an
 *  object's anchor, or (`on body` alone) the body's center. */
Pt Builder::featureAt(const ObjP& u) {
  if (u->get(K_onBody).truthy() && !body) throw StompError(u"`on body` needs a `body` to rest on", u);
  if (!u->get(K_at).truthy()) {
    if (!body) throw std::runtime_error("Cannot read properties of null (reading 'x')");
    return {*body->x, *body->y};
  }
  const ObjP& at = u->get(K_at).obj();
  if (at->get(K_point).truthy()) {
    const ObjP& point = at->get(K_point).obj();
    const double x = len(point->get(K_x), u), y = len(point->get(K_y), u);
    return shift({x, y});
  }
  const ObjP& ref = at->get(K_ref).obj();
  if (is(ref->get(K_kind), u"origin")) return {0, 0};
  const Info inf = info(ref, u);
  const double x = anchor(inf, u'x', whichStatic(ref, u'x')).f(vals[0]) - O.x;
  const double y = anchor(inf, u'y', whichStatic(ref, u'y')).f(vals[1]) - O.y;
  return {x, y};
}

/** The main lead form, as the 3D model takes it: the footprint's `lead`, else the first
 *  per-pin lead (a tab only if there's nothing else). */
std::optional<U> Builder::mainFormNow() const {
  if (lead) return lead->form;
  std::vector<U> forms;
  pads.each([&](const U&, const PadP& p) {
    if (p->thermal) return;
    const PinLead* pl = pinLeads.get(p->name);
    if (pl && pl->lead->form != u"none") forms.push_back(pl->lead->form);
  });
  for (const U& f : forms)
    if (f != u"tab") return f;
  if (!forms.empty()) return forms[0];
  return std::nullopt;
}

std::optional<U> Builder::styleNow() const {
  if (!body) return std::nullopt;
  return style_of(*body, mainFormNow(), gen.get(), familyNow());
}

std::optional<U> Builder::familyNow() const {
  const MetaEntry* r = st.meta.get(u"refdes");
  return family_of(r ? r->value : Val(U()));
}

/** The flags the automatic marks are drawn with: the body's style and the part's family. */
std::vector<U> Builder::markFlags() const {
  std::vector<U> out;
  if (auto s = styleNow(); s && !s->empty()) out.push_back(*s);
  if (auto f = familyNow(); f && !f->empty()) out.push_back(*f);
  return out;
}

/** A mark feature's silk items around its own origin, or null when there's no feature by
 *  that name. Problems are reported at `trigger`. */
std::optional<Gfxs> Builder::markItems(const U& n, const std::vector<std::pair<U, EV>>& values, const std::vector<U>& flags,
                                       const ObjP& trig) {
  if (!lookupFeature(n)) return std::nullopt;
  const ObjP outer = trigger;
  trigger = trig;
  struct Restore {
    Builder* b;
    ObjP outer;
    ~Restore() { b->trigger = outer; }
  } restore{this, outer};
  return guard(trig, [&] {
    BindOpts o;
    o.values = &values;
    o.flags = &flags;
    const BoundP bound = bindFeature(rec({{K_name, n}, {K_args, list()}, {K_s, trig->get(K_s)}, {K_e, trig->get(K_e)}}), o);
    return featureLayer(bound, u"silk", [](Pt q) { return q; });
  });
}

/** Which pin the polarity marks go by (SPEC 12): the `polarity` feature's `stripe_at`. */
U Builder::polarityPin(const ObjP& trig) {
  if (!lookupFeature(u"polarity")) return u"2";
  const auto v = guard(trig, [&]() -> U {
    BindOpts o;
    const std::vector<U> flags = markFlags();
    o.flags = &flags;
    const BoundP bound = bindFeature(rec({{K_name, u"polarity"}, {K_args, list()}, {K_s, trig->get(K_s)}, {K_e, trig->get(K_e)}}), o);
    if (!bound->scope->defs.has(u"stripe_at")) return u"2";
    const EV val = inFeature(bound, [&] { return bound->scope->lookup(u"stripe_at", trig); });
    return format_value(&val, Val(nullptr), env(trig));
  });
  return v ? *v : U(u"2");
}

/** The automatic marks' items, before they're placed (silkLayer places them). */
Marks Builder::evalMarks() {
  Marks out;
  const std::optional<Pin1>& p1 = pin1;
  const U& style = pin1Style;
  const ObjP p1s = st.pin1 ? st.pin1->s : nullptr;
  const ObjP at1 = p1s ? p1s : range(decl->get(K_nameS).num(), decl->get(K_nameE).num());
  const std::vector<U> flags = markFlags();
  if (p1 && (style == u"dot" || style == u"chamfer")) out.dot = Marks::Dot{markItems(u"pin1_dot", {}, flags, at1), p1s};
  if (p1 && style == u"bar" && body && body->kind == u"box") {
    const Body& b = *body;
    const auto corner = pin1Corner();
    const U edge = pin1End(corner);
    const bool tb = edge == u"top" || edge == u"bottom";
    const double len2 = 2 * ((tb ? b.w : b.l) / 2 + D().silkOffset);
    out.bar = Marks::Bar{edge, markItems(u"pin1_bar", {{u"len", EV::len(len2)}, {u"depth", EV::len(tb ? b.l : b.w)}}, flags, at1), p1s};
  }
  if (polarized && gen && gen->kind == u"two" && pads.has(u"2")) {
    const ObjP pz = st.polarized->s;
    const U pin = polarityPin(pz);
    const PadP mk = pads.has(pin) ? *pads.get(pin) : *pads.get(u"2");
    PadP oth;
    pads.each([&](const U&, const PadP& q) {
      if (!oth && q != mk && !q->thermal && (q->name == u"1" || q->name == u"2")) oth = q;
    });
    const double cx = body ? *body->x : (oth ? (*oth->x + *mk->x) / 2 : 0);
    const double cy = body ? *body->y : (oth ? (*oth->y + *mk->y) / 2 : 0);
    const Pad& p2 = **pads.get(u"2");
    const bool horiz = std::fabs(*p2.x - cx) >= std::fabs(*p2.y - cy);
    Marks::Polarity P;
    P.mk = mk;
    P.other = oth;
    P.cx = cx;
    P.cy = cy;
    P.horiz = horiz;
    P.src = pz;
    if (body && body->kind == u"cyl") {
      P.hatch = markItems(u"polarity_hatch", {{u"r", EV::len(body->w / 2 + D().silkOffset)}}, flags, pz);
      if (oth) P.plus = markItems(u"polarity_plus", {}, flags, pz);
    } else {
      const double half = horiz ? js::max(body ? body->l / 2 + D().silkOffset : 0, (mk->bb.y.hi - mk->bb.y.lo) / 2 + 0.1)
                                : js::max(body ? body->w / 2 + D().silkOffset : 0, (mk->bb.x.hi - mk->bb.x.lo) / 2 + 0.1);
      P.half = half;
      P.bar = markItems(u"polarity_bar", {{u"len", EV::len(2 * half)}}, flags, pz);
    }
    out.polarity = std::move(P);
  }
  return out;
}

/** The body corner nearest pin 1: 'tl', 'tr', 'bl' or 'br'. */
std::optional<U> Builder::pin1Corner() const {
  if (!body || !pin1 || body->kind != u"box") return std::nullopt;
  const Body& b = *body;
  const Pin1& p1 = *pin1;
  return (p1.x <= *b.x ? u'l' : u'r') == u'l' ? (p1.y >= *b.y ? U(u"tl") : U(u"bl")) : (p1.y >= *b.y ? U(u"tr") : U(u"br"));
}

U Builder::pin1End(const std::optional<U>& corner) const {
  const Body& b = *body;
  const Pin1& p1 = *pin1;
  const PadP& pad = p1.pad;
  std::optional<U> side;
  if (pad && pad->gen && pad->gen->side) side = pad->gen->side;
  else if (p1.side) side = p1.side;
  const bool two = gen && gen->kind == u"two";
  if (two && side) return *side;
  if (side == u"left" || side == u"right") return corner && (*corner)[0] == u't' ? u"top" : u"bottom";
  if (side == u"top" || side == u"bottom") return corner && (*corner)[1] == u'l' ? u"left" : u"right";
  // no side info: the body edge nearest pin 1
  const double dx = (p1.x - *b.x) / b.w, dy = (p1.y - *b.y) / b.l;
  return std::fabs(dx) > std::fabs(dy) ? (dx < 0 ? u"left" : u"right") : (dy < 0 ? u"bottom" : u"top");
}

// Copper, mask, paste and drills

void Builder::padLayers(Pad& p) {
  const Spec& s = *p.spec;
  const double r = rad(p.rot);
  const double px = *p.x, py = *p.y;
  const auto at = [&](const Contour& edges) { return geom::transform_contour(edges, r, px, py); };
  p.land = at(geom::shape_contour(s.shape, 0));
  const U maskMode = s.mask ? s.mask->mode : U(u"default");
  p.copper = maskMode == u"defined" ? at(geom::shape_contour(s.shape, D().maskDefinedOverlap)) : p.land;
  if (maskMode == u"none") p.maskOpen.reset();
  else if (maskMode == u"defined") p.maskOpen = p.land;
  else p.maskOpen = at(geom::shape_contour(s.shape, maskMode == u"expand" ? s.mask->v : D().mask));
  // paste
  const U pm = s.paste ? s.paste->mode : U(s.tht ? u"none" : u"default");
  p.paste.reset();
  if (pm == u"default") p.paste = std::vector<Contour>{p.land};
  else if (pm == u"expand") p.paste = std::vector<Contour>{at(geom::shape_contour(s.shape, s.paste->v))};
  else if (pm == u"divide") p.paste = pasteWindows(s, at);
  // drill
  p.drillShape.reset();
  if (s.drill) {
    if (s.drill->d) p.drillShape = geom::circle_contour(*s.drill->d / 2, {px, py});
    else {
      geom::Shape oval;
      oval.kind = geom::Kind::Oval;
      oval.w = s.drill->slotW;
      oval.l = s.drill->slotL;
      p.drillShape = at(geom::shape_contour(oval, 0));
    }
  }
  // thermal vias
  p.viaList.clear();
  if (s.vias) {
    const Vias& v = *s.vias;
    const double c = js::cos(r), sn = js::sin(r);
    for (double i = 0; i < v.nx; i++) {
      for (double j = 0; j < v.ny; j++) {
        const double lx = (i - (v.nx - 1) / 2) * v.pitch, ly = ((v.ny - 1) / 2 - j) * v.pitch;
        p.viaList.push_back({px + lx * c - ly * sn, py + lx * sn + ly * c, v.drill});
      }
    }
    const double bw = p.bb.x.hi - p.bb.x.lo, bl = p.bb.y.hi - p.bb.y.lo;
    if ((v.nx - 1) * v.pitch + v.drill > js::max(bw, bl) + 1e-9 || (v.ny - 1) * v.pitch + v.drill > js::max(bw, bl) + 1e-9) {
      ObjP node;
      if (s.src)
        for (const auto& n : *s.src)
          if (is(n->get(K_prop), u"vias")) { node = n; break; }
      if (!node && !p.src.empty()) node = p.src[0];
      warn(u"pad " + p.name + u": the via array extends beyond the pad", node);
    }
  }
}

std::vector<Contour> Builder::pasteWindows(const Spec& s, const std::function<Contour(const Contour&)>& at) {
  const geom::Box bb = geom::contour_bbox(geom::shape_contour(s.shape, 0));
  const double W = bb.x1 - bb.x0, Lh = bb.y1 - bb.y0;
  const double nx = s.paste->nx, ny = s.paste->ny;
  std::vector<Contour> out;
  if (s.paste->gutter) {
    const double g = *s.paste->gutter;
    const double w = (W - (nx - 1) * g) / nx, l = (Lh - (ny - 1) * g) / ny;
    if (w <= 0 || l <= 0) {
      ObjP node;
      if (s.src)
        for (const auto& n : *s.src)
          if (is(n->get(K_prop), u"paste")) { node = n; break; }
      warn(u"paste gutter is too wide for this pad — no windows left", node);
      return {};
    }
    for (double i = 0; i < nx; i++)
      for (double j = 0; j < ny; j++) {
        const double cx = bb.x0 + i * (w + g) + w / 2, cy = bb.y0 + j * (l + g) + l / 2;
        out.push_back(at(geom::transform_contour(geom::rrect_contour(w, l, {}), 0, cx, cy)));
      }
    return out;
  }
  const double cov = s.paste->coverage ? *s.paste->coverage : 0.5;
  const double k = std::sqrt(cov);
  const double cw = W / nx, cl = Lh / ny;
  for (double i = 0; i < nx; i++)
    for (double j = 0; j < ny; j++) {
      const double cx = bb.x0 + (i + 0.5) * cw, cy = bb.y0 + (j + 0.5) * cl;
      out.push_back(at(geom::transform_contour(geom::rrect_contour(cw * k, cl * k, {}), 0, cx, cy)));
    }
  return out;
}

void Builder::holeLayers(Hole& h) {
  h.rot = 0;
  h.land = geom::transform_contour(geom::shape_contour(h.shape, 0), 0, h.x, h.y);
  h.maskOpen = geom::transform_contour(geom::shape_contour(h.shape, D().holeMask), 0, h.x, h.y);
}

void Builder::pin1Info() {
  pin1.reset();
  PadP named;
  if (PadP* p = pads.get(u"1")) named = *p;
  else if (gen && gen->kind == u"balls") {
    if (PadP* q = pads.get(u"A1")) named = *q;
  }
  if (named) pin1 = Pin1{*named->x, *named->y, named, std::nullopt};
  else if (gen && gen->pin1) {
    if (PadP* p = pads.get(gen->pin1->name)) pin1 = Pin1{*(*p)->x, *(*p)->y, *p, std::nullopt};
    else pin1 = Pin1{gen->pin1->x - O.x, gen->pin1->y - O.y, nullptr, gen->pin1->side};
  }
  if (st.pin1) pin1Style = st.pin1->s->get(K_style).str();
  else
    pin1Style = gen && (gen->kind == u"dual" || gen->kind == u"quad" || gen->kind == u"single" || gen->kind == u"sides") ? u"dot" : u"none";
}

/** Body outline as a closed polyline, offset by o, with an optional pin-1 chamfer or notch. */
Poly Builder::bodyOutline(double o, const OutlineMods* mods) const {
  const Body& b = *body;
  const double bx = *b.x, by = *b.y;
  if (b.kind == u"cyl") {
    Poly pts = geom::arc_points({bx, by}, b.w / 2 + o, 0, geom::PI * 2, rad(3));
    if (!pts.empty()) pts.pop_back();
    return pts;
  }
  const double hw = b.w / 2 + o, hl = b.l / 2 + o;
  const char16_t* seq[] = {u"bl", u"br", u"tr", u"tl"};
  const Pt C[] = {{bx - hw, by - hl}, {bx + hw, by - hl}, {bx + hw, by + hl}, {bx - hw, by + hl}};
  Poly pts;
  for (int i = 0; i < 4; i++) {
    const U k = seq[i];
    if (mods && mods->chamfer && mods->chamfer->corner == k && mods->chamfer->c > 0) {
      const Pt prev = C[(i + 3) % 4], next = C[(i + 1) % 4], cur = C[i];
      const double cc = mods->chamfer->c;
      const auto tow = [&](Pt q) {
        const double d = geom::dist(cur, q);
        return d < 1e-12 ? cur : Pt{cur.x + ((q.x - cur.x) / d) * cc, cur.y + ((q.y - cur.y) / d) * cc};
      };
      pts.push_back(tow(prev));
      pts.push_back(tow(next));
    } else pts.push_back(C[i]);
    if (mods && mods->notch) {
      // edge from this corner to the next
      const char16_t* edgeName = i == 0 ? u"bottom" : i == 1 ? u"right" : i == 2 ? u"top" : u"left";
      if (mods->notch->edge == edgeName) {
        const Pt a = C[i], bn = C[(i + 1) % 4];
        const Pt m{(a.x + bn.x) / 2, (a.y + bn.y) / 2};
        const double len2 = geom::dist(a, bn);
        const Pt t{(bn.x - a.x) / len2, (bn.y - a.y) / len2};
        const Pt n{-t.y, t.x};   // inward for a CCW outline
        const double r = mods->notch->r;
        for (int j = 0; j <= 16; j++) {
          const double phi = (geom::PI * j) / 16;
          pts.push_back({m.x - r * t.x * js::cos(phi) + r * n.x * js::sin(phi), m.y - r * t.y * js::cos(phi) + r * n.y * js::sin(phi)});
        }
      }
    }
  }
  return pts;
}

U Builder::layerBase(V layer) const {
  U base = u"auto";
  for (const auto& it : const_cast<St&>(st).layer(layer)) {
    const Val& m = it.s->get(K_mode);
    if (is(m, u"auto") || is(m, u"none")) base = m.str();
  }
  return base;
}

U Builder::refLabel() const {
  const MetaEntry* r = st.meta.get(u"refdes");
  const U v = r ? (r->value.is_str() ? r->value.str() : U(u"[object Object]")) : U(u"REF");
  return v + u"?";
}

/** Graphics statements to items. `map` takes local points to the footprint (a feature's
 *  frame); without it, points are footprint coordinates. A `clear` item is cut back from
 *  the copper when the layers are finished. */
void Builder::gfx(const ArrP& gitems, V layer, Gfxs& out, double defW, const MapFn* map, const Bound*) {
  const MapFn M = map ? *map : MapFn([this](Pt q) { return shift(q); });
  for (const Val& gv : gitems->a) {
    const ObjP& g = gv.obj();
    guard_void(g, [&] {
      const std::size_t start = out.size();
      gfxItem(g, layer, out, defW, M, map);
      if (g->get(K_clear).truthy())
        for (std::size_t i = start; i < out.size(); ++i)
          if (out[i].type == u"line") out[i].clear = true;
    });
  }
}

void Builder::gfxItem(const ObjP& g, V layer, Gfxs& out, double defW, const MapFn& M, const MapFn* map) {
  const auto at = [&](const Val& pt) {
    const double x = len(pt.obj()->get(K_x), g), y = len(pt.obj()->get(K_y), g);
    return Pt{x, y};
  };
  const auto P = [&](const Val& pt) { return M(at(pt)); };
  const auto wOf = [&]() { return g->get(K_width).truthy() ? plen(g->get(K_width), g, u"line width") : defW; };
  const auto line = [&](Poly pts, double w) {
    Gfx it;
    it.type = u"line";
    it.pts = std::move(pts);
    it.w = w;
    it.src = g;
    return it;
  };
  const U& op = g->get(K_op).str();
  if (op == u"outline") {
    if (map) throw StompError(u"`outline body` draws around a footprint's body, so it can't go in a feature", g);
    if (!body) throw StompError(u"`outline body` needs a `body`", g);
    const double o = g->get(K_offset).truthy() ? len(g->get(K_offset), g) : 0;
    Poly pts = bodyOutline(o, nullptr);
    if (!pts.empty()) pts.push_back(pts[0]);
    out.push_back(line(std::move(pts), wOf()));
  } else if (op == u"line") {
    const Pt a = P(g->get(K_a));
    const Pt b = P(g->get(K_b));
    out.push_back(line({a, b}, wOf()));
  } else if (op == u"arc") {
    const Pt c = at(g->get(K_c));
    const double r = plen(g->get(K_r), g, u"arc radius");
    const double a0 = angleOf(g->get(K_from).obj(), g);
    double a1 = angleOf(g->get(K_to).obj(), g);
    while (a1 <= a0) a1 += 360;
    Poly pts = geom::arc_points(c, r, rad(a0), rad(a1));
    for (Pt& q : pts) q = M(q);
    out.push_back(line(std::move(pts), wOf()));
  } else if (op == u"circle") {
    const Pt c = P(g->get(K_c));
    const double r = plen(g->get(K_d), g, u"circle diameter") / 2;
    Gfx it;
    it.type = u"circle";
    it.c = c;
    it.r = r;
    if (g->get(K_fill).truthy()) it.fill = true;
    else it.w = wOf();
    it.src = g;
    out.push_back(std::move(it));
  } else if (op == u"rect") {
    const Pt c = at(g->get(K_c));
    const ObjP& size = g->get(K_size).obj();
    const double w = plen(size->get(K_w), g, u"width"), l = plen(size->get(K_l), g, u"length");
    Poly pts{{c.x - w / 2, c.y - l / 2}, {c.x + w / 2, c.y - l / 2}, {c.x + w / 2, c.y + l / 2}, {c.x - w / 2, c.y + l / 2}};
    for (Pt& q : pts) q = M(q);
    if (g->get(K_fill).truthy()) {
      Gfx it;
      it.type = u"poly";
      it.pts = std::move(pts);
      it.fill = true;
      it.src = g;
      out.push_back(std::move(it));
    } else {
      pts.push_back(pts[0]);
      out.push_back(line(std::move(pts), wOf()));
    }
  } else if (op == u"polygon") {
    Poly pts;
    for (const Val& p : g->get(K_pts).arr()->a) pts.push_back(P(p));
    if (g->get(K_fill).truthy()) {
      Gfx it;
      it.type = u"poly";
      it.pts = std::move(pts);
      it.fill = true;
      it.src = g;
      out.push_back(std::move(it));
    } else {
      if (!pts.empty()) pts.push_back(pts[0]);
      out.push_back(line(std::move(pts), wOf()));
    }
  } else if (op == u"hatch") {
    // chords across x of the circle (c) d D, from x = A while x < B, every P
    const Pt c = at(g->get(K_c));
    const double R = plen(g->get(K_d), g, u"hatch diameter") / 2;
    const double t0 = len(g->get(K_from), g), t1 = len(g->get(K_to), g), step = plen(g->get(K_pitch), g, u"hatch pitch");
    if (!(step > 0)) throw StompError(u"a hatch's pitch must be more than zero", g->get(K_pitch).obj());
    const double w = wOf();
    int n = 0;
    for (double t = t0; t < t1 && t < R; t += step) {
      if (++n > 1000) throw StompError(u"this hatch would draw more than 1000 lines", g);
      const double h = std::sqrt(R * R - t * t);
      out.push_back(line({M({c.x + t, c.y - h}), M({c.x + t, c.y + h})}, w));
    }
  } else if (op == u"text") {
    if (map) {
      Gfx it;
      it.type = u"text";
      it.at = P(g->get(K_at));
      it.size = g->get(K_size).truthy() ? plen(g->get(K_size), g, u"text size") : 1.0;
      it.str = textOf(g);
      it.src = g;
      out.push_back(std::move(it));
    } else {
      textItem(g, U(layer), out);
    }
  }
}

void Builder::textItem(const ObjP& t, const std::optional<U>& layerDefault, Gfxs& outDefault) {
  const ObjP& tat = t->get(K_at).obj();
  const double x = len(tat->get(K_x), t), y = len(tat->get(K_y), t);
  const Pt at = shift({x, y});
  const double size = t->get(K_size).truthy() ? plen(t->get(K_size), t, u"text size") : 1.0;
  const Val& field = t->get(K_which).obj()->get(K_field);
  const U str = textOf(t);
  U layer;
  if (t->get(K_layer).truthy()) layer = t->get(K_layer).str();
  else if (layerDefault && !layerDefault->empty()) layer = *layerDefault;
  else layer = is(field, u"value") ? u"assembly" : u"silk";
  Gfx item;
  item.type = u"text";
  item.at = at;
  item.size = size;
  item.str = str;
  item.src = t;
  item.field = field.truthy() ? field : Val(nullptr);
  if (layer == u"silk") manual.silk.push_back(std::move(item));
  else if (layer == u"assembly") manual.assembly.push_back(std::move(item));
  else if (layer == u"copper" || layer == u"mask") {
    item.layer = layer;
    lay.texts.push_back(std::move(item));
  } else outDefault.push_back(std::move(item));
}

/** What a text statement prints: the refdes, the value (name), or its string. */
U Builder::textOf(const ObjP& t) {
  const ObjP& which = t->get(K_which).obj();
  const Val& field = which->get(K_field);
  if (is(field, u"ref")) return refLabel();
  if (is(field, u"value")) return name ? *name : U(u"null");
  return interpolate(which->get(K_str), env(t));
}

void Builder::textLayer() {
  for (const auto& it : st.texts) guard_void(it.s, [&] { textItem(it.s, std::nullopt, manual.silk); });
}

/** The rectangle `courtyard: rect (x, y) W x L` or `courtyard: polygon …` draws: a polygon
 *  with four corners and sides parallel to x and y. */
std::optional<CyBase::Box> Builder::courtyardBox(const ArrP& gitems, const ObjP& node) {
  std::vector<ObjP> shapes;
  for (const Val& g : gitems->a)
    if (g.is_obj() && g.obj()->get(K_op).truthy()) shapes.push_back(g.obj());
  const U one = u"a courtyard is one rectangle: `courtyard: rect W x L`, `courtyard: rect (x, y) W x L`, or a four-corner `courtyard: polygon`";
  if (shapes.size() != 1) throw StompError(one, shapes.size() > 1 ? shapes[1] : node);
  const ObjP& g = shapes[0];
  if (!is(g->get(K_op), u"rect") && !is(g->get(K_op), u"polygon")) throw StompError(one, g);
  if (g->get(K_fill).truthy()) throw StompError(u"a courtyard is an outline; drop `fill`", g);
  Gfxs tmp;
  gfx(list({g}), u"courtyard", tmp, D().crtW);
  if (tmp.empty() || !tmp[0].pts) return std::nullopt;   // already reported
  const Gfx& it = tmp[0];
  Poly pts(it.pts->begin(), it.pts->end() - (it.pts->empty() ? 0 : 1));
  geom::Box box;
  for (const Pt& q : pts) geom::add_pt(box, q);
  const auto onEdge = [&](Pt q) {
    return (std::fabs(q.x - box.x0) < 1e-6 || std::fabs(q.x - box.x1) < 1e-6) && (std::fabs(q.y - box.y0) < 1e-6 || std::fabs(q.y - box.y1) < 1e-6);
  };
  bool all = true;
  for (const Pt& q : pts) all = all && onEdge(q);
  if (pts.size() != 4 || !all)
    throw StompError(u"a courtyard is a rectangle, but this polygon isn't one: give four corners with sides parallel to x and y", g);
  return CyBase::Box{box.x0, box.y0, box.x1, box.y1, it.w, g};
}

std::optional<geom::Box> Builder::landBox() const {
  geom::Box bb;
  const auto add = [&](double x, double y, const BB& b) {
    bb = geom::union_box(bb, geom::Box{x + b.x.lo, y + b.y.lo, x + b.x.hi, y + b.y.hi});
  };
  pads.each([&](const U&, const PadP& p) { add(*p->x, *p->y, p->bb); });
  holes.each([&](const U&, const HoleP& h) { add(h->x, h->y, h->bb); });
  if (!geom::box_valid(bb)) return std::nullopt;
  return bb;
}

// Checks

void Builder::checks() {
  struct It {
    Pad* p;
    std::size_t i;
    geom::Box bb;
    std::optional<Poly> poly;
  };
  std::vector<It> its;
  pads.each([&](const U&, const PadP& p) {
    if (p->spec->missing && *p->spec->missing) return;
    if (unplaced.count(p->unit->id)) return;
    its.push_back({p.get(), its.size(), geom::contour_bbox(p->copper), std::nullopt});
  });
  const auto poly = [&](It& it) -> const Poly& {
    if (!it.poly) it.poly = geom::contour_to_poly(it.p->copper, rad(10));
    return *it.poly;
  };
  std::vector<It*> sorted;
  for (auto& it : its) sorted.push_back(&it);
  std::stable_sort(sorted.begin(), sorted.end(), [](const It* a, const It* b) { return a->bb.x0 < b->bb.x0; });
  std::vector<std::pair<It*, It*>> hits;
  for (std::size_t i = 0; i < sorted.size(); ++i) {
    It* A = sorted[i];
    for (std::size_t j = i + 1; j < sorted.size() && sorted[j]->bb.x0 <= A->bb.x1; ++j) {
      It* B = sorted[j];
      if (!geom::box_overlap(A->bb, B->bb)) continue;
      if (geom::polys_overlap(poly(*A), poly(*B))) hits.push_back(A->i < B->i ? std::make_pair(A, B) : std::make_pair(B, A));
    }
  }
  std::stable_sort(hits.begin(), hits.end(), [](const auto& a, const auto& b) {
    if (a.first->i != b.first->i) return a.first->i < b.first->i;
    return a.second->i < b.second->i;
  });
  for (std::size_t k = 0; k < hits.size() && k < 12; ++k) {
    It* A = hits[k].first;
    It* B = hits[k].second;
    const ObjP node = !B->p->src.empty() && B->p->src.back() ? B->p->src.back() : decl;
    warn(u"pads " + A->p->name + u" and " + B->p->name + u" overlap — intentional only if they share a net", node);
    A->p->overlap = B->p->overlap = true;
  }
  // no pads at all
  if (!pads.size() && !holes.size() && !errorCount && broken.empty())
    warn(u"footprint \"" + (name ? *name : U(u"null")) + u"\" has no pads", range(decl->get(K_nameS).num(), decl->get(K_nameE).num()));
}

}  // namespace stomp::compiler
