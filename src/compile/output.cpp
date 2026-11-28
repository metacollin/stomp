// The result (compile.js output, modelInfo, featureUseSolids, footprintSolid, leads3d):
// records with the fields the editor, the 3D engine and the KiCad writer read.
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <unordered_map>

#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
Val opt(const std::optional<double>& v) { return v ? Val(*v) : Val(nullptr); }
Val opt(const std::optional<U>& v) { return v ? Val(*v) : Val(nullptr); }

/** uniqRanges over nodes: {s, e} of each, once. */
Val ranges(const std::vector<ObjP>& nodes) {
  ArrP out = list();
  std::unordered_set<U> seen;
  for (const auto& n : nodes) {
    if (!n) continue;
    const Val& s = n->get(K_s);
    const Val& e = n->get(K_e);
    const U k = (s.is_num() ? js::to_u16string(s.num()) : U(u"undefined")) + u":" + (e.is_num() ? js::to_u16string(e.num()) : U(u"undefined"));
    if (seen.count(k)) continue;
    seen.insert(k);
    out->a.push_back(rec({{K_s, s}, {K_e, e}}));
  }
  return out;
}
Val bbox_val(double x, double y, const BB& bb) {
  return rec({{K_x0, x + bb.x.lo}, {K_x1, x + bb.x.hi}, {K_y0, y + bb.y.lo}, {K_y1, y + bb.y.hi}});
}
const char16_t* model_label(const U& k) {
  if (k == u"standoff") return u"standoff:";
  if (k == u"height") return u"height:";
  if (k == u"draft") return u"draft:";
  if (k == u"bodyColor") return u"body color:";
  if (k == u"leadsColor") return u"leads color:";
  if (k == u"thickness") return u"leads thickness:";
  if (k == u"below") return u"leads below:";
  if (k == u"above") return u"leads above:";
  if (k == u"pin1") return u"pin1:";
  if (k == u"step") return u"step:";
  if (k == u"bodyShape") return u"body shape:";
  if (k == u"leadsShape") return u"leads shape:";
  return u"undefined";
}
}  // namespace

ObjP Builder::output() {
  std::unordered_set<const void*> unplacedObj;
  for (int u : unplaced) {
    const Unit& un = *units[u];
    if (un.pad) unplacedObj.insert(un.pad.get());
    if (un.hole) unplacedObj.insert(un.hole.get());
    if (un.row) {
      unplacedObj.insert(un.row.get());
      for (const auto& m : un.row->members) unplacedObj.insert(m.get());
    }
  }
  // placements in effect also "belong" to the objects they move
  std::unordered_map<int, std::vector<ObjP>> placedBy;
  chosen.each([&](const U&, Con*& c) {
    if (c->strength != u"strong" || !c->node || c->node == decl) return;
    placedBy[c->unit].push_back(c->node);
  });
  const auto more = [&](Unit* u) -> std::vector<ObjP> {
    if (!u) return {};
    auto it = placedBy.find(u->id);
    return it == placedBy.end() ? std::vector<ObjP>{} : it->second;
  };
  const auto with_more = [&](const std::vector<ObjP>& from, Unit* u) {
    std::vector<ObjP> all = from;
    for (const auto& n : more(u)) all.push_back(n);
    return all;
  };
  const auto defOf = [&](const std::vector<ObjP>& from, const ObjP& explicitNode, const std::optional<MirrorRef>& mirror, Unit* u) -> Val {
    ObjP n = explicitNode;
    if (!n)
      for (const auto& x : from)
        if (is(x->get(K_type), u"Thermal") || is(x->get(K_type), u"Hole")) { n = x; break; }
    if (!n && mirror) n = mirror->node;
    if (!n)
      for (const auto& x : from)
        if (is(x->get(K_type), u"Row")) { n = x; break; }
    if (!n) {
      const auto m = more(u);
      if (!m.empty()) n = m[0];
    }
    if (!n && !from.empty()) n = from[0];
    return n ? Val(rec({{K_s, n->get(K_s)}, {K_e, n->get(K_e)}})) : Val(nullptr);
  };
  ArrP padsOut = list();
  // pads with one spec share its record, and its shape and drill (as compile.js's did)
  std::unordered_map<const Spec*, Val> specRecs;
  pads.each([&](const U&, const PadP& p) {
    const Spec& s = *p->spec;
    Val& specRec = specRecs[&s];
    if (specRec.undef()) specRec = spec_val(s);
    const Val shape = specRec.obj()->get(K_shape);
    ArrP vias = list();
    for (const Via& v : p->viaList) vias->a.push_back(rec({{K_x, v.x}, {K_y, v.y}, {K_d, v.d}}));
    const bool unpl = unplacedObj.count(p.get()) || (p->unit && ((p->unit->pad && unplacedObj.count(p->unit->pad.get())) ||
                                                                 (p->unit->row && unplacedObj.count(p->unit->row.get()))));
    const Val drill = specRec.obj()->get(K_drill);
    padsOut->a.push_back(rec({
        {K_kind, u"pad"},
        {K_name, p->name},
        {K_x, *p->x},
        {K_y, *p->y},
        {K_rot, p->rot},
        {K_spec, specRec},
        {K_shape, shape},
        {K_tht, s.tht},
        {K_drill, drill},   // the outlines go here (withOutlines)
        {K_vias, vias},
        {K_bbox, bbox_val(*p->x, *p->y, p->bb)},
        {K_generated, p->generated},
        {K_thermal, p->thermal},
        {K_side, p->gen ? opt(p->gen->side) : Val(nullptr)},
        {K_ipc, s.ipc.value_or(false) && !p->explicit_},
        {K_unplaced, unpl},
        {K_overlap, p->overlap},
        {K_missing, s.missing.value_or(false)},
        {K_src, ranges(with_more(p->src, p->unit))},
        {K_def, defOf(p->src, p->explicit_ ? p->explicit_->node : nullptr, p->mirror, p->unit)},
        {K_row, p->unit && p->unit->kind == u"row" ? Val(p->unit->row->name) : Val(nullptr)},
    }));
  });
  ArrP holesOut = list();
  holes.each([&](const U&, const HoleP& h) {
    holesOut->a.push_back(rec({
        {K_kind, u"hole"},
        {K_name, h->name},
        {K_x, h->x},
        {K_y, h->y},
        {K_rot, 0},
        {K_shape, shape_val(h->shape)},   // the outlines go here (withOutlines)
        {K_bbox, bbox_val(h->x, h->y, h->bb)},
        {K_unplaced, unplacedObj.count(h.get()) > 0},
        {K_src, ranges(with_more(h->src, h->unit))},
        {K_def, defOf(h->src, nullptr, h->mirror, h->unit)},
    }));
  });
  // dimension overlays for each placement in effect
  const auto P = [&](const Info& inf, char16_t axis, V w) { return anchor(inf, axis, U(w)).f(vals[ai(axis)]) - O[axis]; };
  const auto span = [&](const Info& inf, char16_t axis) { return Val(list({P(inf, axis, u"lo"), P(inf, axis, u"hi")})); };
  const auto boxOfInf = [&](const Info& inf) {
    return Val(rec({{K_x0, P(inf, u'x', u"lo")}, {K_x1, P(inf, u'x', u"hi")}, {K_y0, P(inf, u'y', u"lo")}, {K_y1, P(inf, u'y', u"hi")}}));
  };
  const auto ctr = [&](const Info& inf) { return Val(list({P(inf, u'x', u"center"), P(inf, u'y', u"center")})); };
  ArrP dims = list();
  chosen.each([&](const U&, Con*& cp) {
    const Con& c = *cp;
    if (c.strength != u"strong" || !c.viz) return;
    const Viz& v = *c.viz;
    try {
      const ObjP& node = c.clause ? c.clause : c.node;
      ObjP base = rec({{K_s, node->get(K_s)},
                       {K_e, node->get(K_e)},
                       {K_stmtS, c.node->get(K_s)},
                       {K_stmtE, c.node->get(K_e)},
                       {K_label, c.label}});
      const U ax(1, v.axis);
      if (v.kind == u"dim") {
        base->set(K_kind, u"dim");
        base->set(K_axis, ax);
        base->set(K_a, P(v.ri, v.axis, v.rw));
        base->set(K_b, P(v.ti, v.axis, v.tw));
        base->set(K_ra, span(v.ri, other(v.axis)));
        base->set(K_ta, span(v.ti, other(v.axis)));
        base->set(K_text, v.text);
        base->set(K_value, v.d);
        base->set(K_plain, v.plain);
        base->set(K_rbox, boxOfInf(v.ri));
        base->set(K_tbox, boxOfInf(v.ti));
      } else if (v.kind == u"measure") {
        const bool ia = v.word == u"pitch";
        const double pa = P(v.ai, v.axis, u"center"), pb = P(v.bi, v.axis, u"center");
        const Info& lo = pa <= pb ? v.ai : v.bi;
        const Info& hi = pa <= pb ? v.bi : v.ai;
        const double a = ia ? P(lo, v.axis, u"center") : v.word == u"gap" ? P(lo, v.axis, u"hi") : P(lo, v.axis, u"lo");
        const double b = ia ? P(hi, v.axis, u"center") : v.word == u"gap" ? P(hi, v.axis, u"lo") : P(hi, v.axis, u"hi");
        base->set(K_kind, u"dim");
        base->set(K_axis, ax);
        base->set(K_a, a);
        base->set(K_b, b);
        base->set(K_ra, span(lo, other(v.axis)));
        base->set(K_ta, span(hi, other(v.axis)));
        base->set(K_text, v.word + u" " + v.text);
        base->set(K_value, v.d);
        base->set(K_plain, v.plain);
        base->set(K_rbox, boxOfInf(lo));
        base->set(K_tbox, boxOfInf(hi));
      } else if (v.kind == u"between") {
        base->set(K_kind, u"between");
        base->set(K_axis, ax);
        base->set(K_a, ctr(v.ai));
        base->set(K_b, ctr(v.bi));
        base->set(K_t, ctr(v.ti));
        base->set(K_tbox, boxOfInf(v.ti));
      } else if (v.kind == u"on") {
        base->set(K_kind, u"on");
        base->set(K_axis, ax);
        base->set(K_o, ctr(v.oi));
        base->set(K_t, ctr(v.ti));
        base->set(K_obox, boxOfInf(v.oi));
        base->set(K_tbox, boxOfInf(v.ti));
      } else if (v.kind == u"align") {
        base->set(K_kind, u"align");
        base->set(K_axis, ax);
        base->set(K_a, ctr(v.ti));
        base->set(K_b, ctr(v.bi));
        base->set(K_tbox, boxOfInf(v.ti));
        base->set(K_bbox, boxOfInf(v.bi));
      } else if (v.kind == u"mirror") {
        base->set(K_kind, u"mirror");
        base->set(K_axis, ax);
        base->set(K_line, -O[v.axis]);
        base->set(K_p, ctr(v.pi));
        base->set(K_t, ctr(v.ti));
        base->set(K_pbox, boxOfInf(v.pi));
        base->set(K_tbox, boxOfInf(v.ti));
      } else if (v.kind == u"at") {
        if (c.axis != u'x') return;
        base->set(K_kind, u"at");
        base->set(K_point, list({v.px - O.x, v.py - O.y}));
        base->set(K_tbox, boxOfInf(v.ti));
      }
      dims->a.push_back(base);
    } catch (...) {
      // overlay is best-effort
    }
  });
  Val bodyOut = nullptr;
  Poly outline;
  if (body) {
    const Body& b = *body;
    outline = bodyOutline(0, nullptr);
    std::vector<ObjP> bsrc{b.node};
    for (const Con& c : cons)
      if (bodyUnit && c.unit == bodyUnit->id && c.strength == u"strong") bsrc.push_back(c.node);
    bodyOut = rec({
        {K_kind, b.kind},
        {K_w, b.w},
        {K_l, b.l},
        {K_h, opt(b.h)},
        {K_x, opt(b.x)},
        {K_y, opt(b.y)},
        {K_axial, b.axial ? Val(U(1, *b.axial)) : Val(nullptr)},
        {K_d, b.d ? Val(*b.d) : (b.kind == u"cyl" ? Val(b.w) : Val(nullptr))},
        {K_outline, poly_val(outline)},
        {K_src, ranges(bsrc)},
    });
  }
  ObjP meta = std::make_shared<Obj>();
  st.meta.each([&](const U& k, const MetaEntry& m) { meta->set(key(k), m.value); });
  // extents of pads, holes and body: cheap, and enough for a thumbnail
  geom::Box c0;
  pads.each([&](const U&, const PadP& p) {
    c0 = geom::union_box(c0, {*p->x + p->bb.x.lo, *p->y + p->bb.y.lo, *p->x + p->bb.x.hi, *p->y + p->bb.y.hi});
  });
  holes.each([&](const U&, const HoleP& h) { c0 = geom::union_box(c0, {h->x + h->bb.x.lo, h->y + h->bb.y.lo, h->x + h->bb.x.hi, h->y + h->bb.y.hi}); });
  if (body)
    for (const Pt& p : outline) geom::add_pt(c0, p);
  if (!geom::box_valid(c0)) c0 = {-1, -1, 1, 1};
  core = c0;
  const ObjP model = modelInfo();
  Val leads = list();
  try {
    leads = leads3d();
  } catch (const StompError&) {
  }
  const auto mainForm = mainFormNow();
  const Val& refdes = meta->get(K_refdes);
  const auto family = family_of(refdes);
  Val styleV = nullptr;
  if (body) styleV = style_of(*body, mainForm, gen.get(), family);
  std::vector<ObjP> markNodes;
  if (st.pin1) markNodes.push_back(st.pin1->s);
  if (st.polarized) markNodes.push_back(st.polarized->s);
  Val leadOut = nullptr;
  if (lead) {
    const Lead& L0 = *lead;
    leadOut = rec({{K_form, L0.form}, {K_w, opt(L0.w)}, {K_l, opt(L0.l)}, {K_d, opt(L0.d)}, {K_v, opt(L0.v)}, {K_src, ranges({L0.node})}});
  }
  Val pin1Out = nullptr;
  if (pin1)
    pin1Out = rec({{K_x, pin1->x},
                   {K_y, pin1->y},
                   {K_style, pin1Style},
                   {K_explicit, st.pin1.has_value()},
                   {K_pad, pin1->pad ? Val(pin1->pad->name) : Val(nullptr)}});
  Val genOut = nullptr;
  if (gen) {
    ArrP omitted = list();
    if (gen->omitted)
      for (const auto& p : *gen->omitted) omitted->a.push_back(p->name);
    Val pitch = nullptr;
    for (const auto& p : gen->positions)
      if (p->pitch && js::truthy(*p->pitch)) {
        pitch = *p->pitch;
        break;
      }
    ObjP spacing = std::make_shared<Obj>();
    if (gen->sx) spacing->set(K_x, rec({{K_C, gen->sx->C}, {K_how, gen->sx->how}}));
    if (gen->sy) spacing->set(K_y, rec({{K_C, gen->sy->C}, {K_how, gen->sy->how}}));
    genOut = rec({{K_kind, gen->kind.empty() ? Val(nullptr) : Val(gen->kind)},
                  {K_count, static_cast<double>(gen->positions.size())},
                  {K_omitted, omitted},
                  {K_pitch, pitch},
                  {K_grid, gen->grid ? Val(rec({{K_nx, gen->grid->nx}, {K_ny, gen->grid->ny}})) : Val(nullptr)},
                  {K_spacing, spacing},
                  {K_src, ranges({gen->node})}});
  }
  ObjP floating = std::make_shared<Obj>();
  if (floatX) floating->set(K_x, true);
  if (floatY) floating->set(K_y, true);
  const bool ext = is(decl->get(K_mode), u"extends");
  const bool from = is(decl->get(K_mode), u"from");
  return rec({
      {K_style, styleV},
      {K_family, opt(family)},
      {K_mainForm, opt(mainForm)},
      {K_markSrc, ranges(markNodes)},
      {K_leads, leads},
      {K_polarized, polarized},
      {K_lead, leadOut},
      {K_name, opt(name)},
      {K_meta, meta},
      {K_density, density},
      {K_pads, padsOut},
      {K_holes, holesOut},
      {K_body, bodyOut},
      {K_coreBox, box_val(core)},
      {K_extraTexts, gfxs_val(lay.texts)},
      {K_dims, dims},
      {K_origin, rec({{K_x, 0}, {K_y, 0}})},
      {K_originShift, rec({{K_x, O.x}, {K_y, O.y}})},
      {K_pin1, pin1Out},
      {K_generator, genOut},
      {K_ipcNote, ipcNote && !ipcNote->empty() ? Val(*ipcNote) : Val(nullptr)},
      {K_floating, floating},
      {K_originNote, opt(originNote)},
      {K_model, model},
      {K_extends, ext ? decl->get(K_parentName) : Val(nullptr)},
      {K_template, from ? decl->get(K_template).obj()->get(K_name) : Val(nullptr)},
  });
}

// The pads' and holes' outlines. Results keep them as the builder's contours, which take a
// fraction of the memory of records, and make records of them when asked.

namespace {

ArrP pad_outlines(const Pad& p) {
  ArrP paste;
  if (p.paste) {
    paste = list();
    for (const auto& c : *p.paste) paste->a.push_back(contour_val(c));
  }
  return list({contour_val(p.land), contour_val(p.copper), p.maskOpen ? contour_val(*p.maskOpen) : Val(nullptr), paste ? Val(paste) : Val(nullptr),
               p.drillShape ? contour_val(*p.drillShape) : Val(nullptr)});
}
ArrP hole_outlines(const Hole& h) { return list({contour_val(h.land), contour_val(h.maskOpen)}); }

/** o with fields put in after `after`. */
ObjP insert_after(const Obj& o, Key after, const std::vector<Key>& keys, const ArrP& values) {
  auto out = std::make_shared<Obj>();
  out->f.reserve(o.f.size() + keys.size());
  for (const auto& f : o.f) {
    out->f.push_back(f);
    if (f.first == after)
      for (std::size_t k = 0; k < keys.size(); ++k) out->f.emplace_back(keys[k], values->a[k]);
  }
  return out;
}

const std::vector<Key> PAD_OUTLINES{K_land, K_copper, K_mask, K_paste, K_drillShape}, HOLE_OUTLINES{K_land, K_mask};

}  // namespace

ObjP Builder::withOutlines(const ObjP& res, bool placeholders) const {
  auto o = std::make_shared<Obj>(*res);
  ArrP padsOut = list(), holesOut = list();
  std::size_t i = 0;
  const auto& padRecs = res->get(K_pads).arr()->a;
  const auto& holeRecs = res->get(K_holes).arr()->a;
  if (padRecs.size() != pads.size() || holeRecs.size() != holes.size()) throw std::logic_error("the pads changed after the footprint was built");
  const ArrP padNulls = list({nullptr, nullptr, nullptr, nullptr, nullptr}), holeNulls = list({nullptr, nullptr});
  pads.each([&](const U&, const PadP& p) {
    padsOut->a.push_back(insert_after(*padRecs[i++].obj(), K_drill, PAD_OUTLINES, placeholders ? padNulls : pad_outlines(*p)));
  });
  i = 0;
  holes.each([&](const U&, const HoleP& h) {
    holesOut->a.push_back(insert_after(*holeRecs[i++].obj(), K_shape, HOLE_OUTLINES, placeholders ? holeNulls : hole_outlines(*h)));
  });
  o->set(K_pads, padsOut);
  o->set(K_holes, holesOut);
  return o;
}

ObjP Builder::outlines() const {
  ArrP padsOut = list(), holesOut = list();
  pads.each([&](const U&, const PadP& p) { padsOut->a.push_back(pad_outlines(*p)); });
  holes.each([&](const U&, const HoleP& h) { holesOut->a.push_back(hole_outlines(*h)); });
  return rec({{K_pads, padsOut}, {K_holes, holesOut}});
}

/** The merged model blocks, resolved to numbers and colors. */
ObjP Builder::modelInfo() {
  std::vector<Item> models = st.models;
  std::stable_sort(models.begin(), models.end(), [](const Item& a, const Item& b) { return a.level < b.level; });
  ObjP info = rec({{K_none, false}, {K_props, std::make_shared<Obj>()}, {K_solids, list()}, {K_extras, 0}, {K_step, nullptr}, {K_src, list()}});
  const auto props = [&]() -> Obj& { return *info->get(K_props).obj(); };
  const auto solids = [&]() -> Arr& { return *info->get(K_solids).arr(); };
  std::vector<ObjP> nodes;
  for (const auto& it : models) {
    const ObjP& m = it.s;
    if (m->get(K_none).truthy()) {
      info->set(K_none, true);
      info->set(K_props, std::make_shared<Obj>());
      info->set(K_solids, list());
      info->set(K_extras, 0);
      info->set(K_step, nullptr);
      nodes = {m};
      continue;
    }
    info->set(K_none, false);
    nodes.push_back(m);
    OrderedMap<U, ObjP> seen;
    for (const Val& pv : m->get(K_props).arr()->a) {
      const ObjP& p = pv.obj();
      const U& k = p->get(K_key).str();
      if (k != u"solid") {
        if (const ObjP* prev = seen.get(k))
          warn(u"`" + U(model_label(k)) + u"` is given twice in this model block — the later one wins", p, {{u"first given here", *prev}});
        seen.set(k, p);
      }
      guard_void(p, [&] {
        const auto nonNeg = [&](V what) {
          const double v = len(p->get(K_x), p);
          if (v < 0) throw StompError(U(what) + u" must not be negative (got " + fmt_mm(v) + u")", p->get(K_x).obj());
          return v;
        };
        const auto pos = [&](V what) {
          const double v = len(p->get(K_x), p);
          if (!(v > 0)) throw StompError(U(what) + u" must be more than zero (got " + fmt_mm(v) + u")", p->get(K_x).obj());
          return v;
        };
        if (k == u"standoff") props().set(K_standoff, nonNeg(u"the standoff"));
        else if (k == u"height") props().set(K_height, pos(u"the model height"));
        else if (k == u"thickness") props().set(K_thickness, pos(u"the lead thickness"));
        else if (k == u"below") props().set(K_below, nonNeg(u"`leads below:`"));
        else if (k == u"above") props().set(K_above, nonNeg(u"`leads above:`"));
        else if (k == u"draft") {
          const double a = angleOf(p->get(K_angle).obj(), p);
          if (!(a >= 0 && a < 45))
            throw StompError(u"a draft is between 0 and 45 degrees (got " + format_number(a, std::nullopt) + u")", p->get(K_angle).obj());
          props().set(K_draft, a);
        } else if (k == u"bodyColor") props().set(K_bodyColor, color_val(colorValue(p->get(K_color), p)));
        else if (k == u"leadsColor") props().set(K_leadsColor, color_val(colorValue(p->get(K_color), p)));
        else if (k == u"bodyShape" || k == u"leadsShape") {
          const ObjP& call = p->get(K_call).obj();
          if (!lookupFeature(call->get(K_name).str())) bindFeature(call, BindOpts{});   // reports an unknown name now
          props().set(key(k), rec({{K_call, call}, {K_unit, p->get(K_unit)}, {K_node, rec({{K_s, p->get(K_s)}, {K_e, p->get(K_e)}})}}));
        } else if (k == u"pin1") props().set(K_pin1, p->get(K_v));
        else if (k == u"step") {
          const ObjP& x = p->get(K_xform).obj();
          const auto P3 = [&](const Val& q) -> Val {
            if (!q.truthy()) return nullptr;
            const ObjP& o = q.obj();
            const double a = len(o->get(K_x), p), b = len(o->get(K_y), p), c = len(o->get(K_z), p);
            return list({a, b, c});
          };
          const auto A3 = [&](const Val& q) -> Val {
            if (!q.truthy()) return nullptr;
            const ObjP& o = q.obj();
            const double a = deg(o->get(K_x), p), b = deg(o->get(K_y), p), c = deg(o->get(K_z), p);
            return list({a, b, c});
          };
          const Val offset = P3(x->get(K_offset));
          const Val rotate = A3(x->get(K_rotate));
          const double scale = x->get(K_scale).truthy() ? num(x->get(K_scale), p) : 1;
          info->set(K_step, rec({{K_file, p->get(K_file)}, {K_offset, offset}, {K_rotate, rotate}, {K_scale, scale}}));
        } else if (k == u"solid") {
          solids().a.push_back(footprintSolid(p));
          info->set(K_extras, info->get(K_extras).num() + 1);
        }
      });
    }
  }
  // features placed in the footprint add their solids
  if (!info->get(K_none).truthy()) {
    for (const auto& it : st.features) {
      const auto got = guard(it.s, [&] { return featureUseSolids(it.s); });
      if (got && !got->empty()) {
        for (const auto& d : *got) solids().a.push_back(d);
        info->set(K_extras, info->get(K_extras).num() + 1);
      }
    }
  }
  // properties that only some leads can use
  std::unordered_set<U> forms;
  if (lead) forms.insert(lead->form);
  pinLeads.each([&](const U&, const PinLead& pl) { forms.insert(pl.lead->form); });
  const auto prop = [&](V k) -> ObjP {
    for (std::size_t i = nodes.size(); i-- > 0;) {
      const Val& ps = nodes[i]->get(K_props);
      if (!ps.is_arr()) continue;
      for (const Val& q : ps.arr()->a)
        if (is(q.obj()->get(K_key), k)) return q.obj();
    }
    return nullptr;
  };
  if (!props().get(K_below).nullish() && !forms.count(u"pin") && !forms.count(u"wire"))
    warn(u"`leads below:` sets how far through-hole leads reach under the board; these leads are surface-mount", prop(u"below"));
  if (!props().get(K_above).nullish() && !(forms.count(u"pin") && gen && gen->kind != u"dual"))
    warn(u"`leads above:` is for straight through-hole pins (headers), which rise above their housing", prop(u"above"));
  ArrP srcs = list();
  for (const auto& n : nodes)
    if (!n->get(K_s).nullish()) srcs->a.push_back(rec({{K_s, n->get(K_s)}, {K_e, n->get(K_e)}}));
  info->set(K_src, srcs);
  info->set(K_generated, !info->get(K_none).truthy() && !info->get(K_step).truthy() && body.has_value());
  props().set(K_pin1, props().get(K_pin1).truthy() ? props().get(K_pin1) : Val(nullptr));
  info->set(K_hooks, std::make_shared<Obj>());   // functions for the 3D engine (hooks.cpp); a record holds none
  return info;
}

/** A footprint's `feature NAME at …`: its solids in footprint coordinates, z from the board
 *  (or from the body's top with `on body`). */
std::vector<ObjP> Builder::featureUseSolids(const ObjP& u) {
  BindOpts o;
  o.unit = u->get(K_unit);
  o.scope = scope;
  const BoundP bound = bindFeature(u->get(K_feature).obj(), o);
  const Pt xy = featureAt(u);
  Val zp;
  if (u->get(K_at).truthy() && u->get(K_at).obj()->get(K_point).truthy()) zp = u->get(K_at).obj()->get(K_point).obj()->get(K_z);
  if (zp.truthy() && u->get(K_onBody).truthy())
    warn(u"`on body` and a z coordinate both set the height — the z wins", u->get(K_at).obj()->get(K_point).obj());
  std::array<double, 3> rot{0, 0, 0};
  if (u->get(K_rotate).truthy()) {
    const ObjP& r = u->get(K_rotate).obj();
    rot[0] = deg(r->get(K_x), u);
    rot[1] = deg(r->get(K_y), u);
    rot[2] = deg(r->get(K_z), u);
  }
  const double z = zp.truthy() ? len(zp, u) : 0;
  std::vector<ObjP> out = featureSolids(bound, geom::frame3({xy.x, xy.y, z}, rot));
  for (const auto& d : out) {
    d->set(K_src, list({rec({{K_s, u->get(K_s)}, {K_e, u->get(K_e)}})}));
    if (!d->get(K_name).truthy()) d->set(K_name, u->get(K_feature).obj()->get(K_name));
    if (!d->get(K_kind).truthy()) d->set(K_kind, u"solid");
    if (u->get(K_onBody).truthy() && !zp.truthy()) d->set(K_lift, true);
  }
  return out;
}

/** A model block's own solid: a descriptor, placed under its `at` point (or the body's
 *  center) with its bottom at z, on the board, or on the body. */
ObjP Builder::footprintSolid(const ObjP& p) {
  const ObjP d = solidDesc(p, std::nullopt, false);
  d->set(K_src, list({rec({{K_s, p->get(K_s)}, {K_e, p->get(K_e)}})}));
  d->set(K_name, d->get(K_name).truthy() ? d->get(K_name) : p->get(K_kind));
  d->set(K_kind, u"solid");
  if (p->get(K_at).truthy()) {
    const auto& at = d->get(K_at).arr()->a;
    d->set(K_place, rec({{K_x, at[0].num() - O.x}, {K_y, at[1].num() - O.y}, {K_z, at[2]}}));
    if (!at[2].nullish() && p->get(K_onBody).truthy()) warn(u"`on body` and a z coordinate both set the height — the z wins", p->get(K_at).obj());
  } else {
    d->set(K_place, rec({{K_x, body ? *body->x : 0}, {K_y, body ? *body->y : 0}, {K_z, nullptr}}));
  }
  d->set(K_at, nullptr);
  if (p->get(K_onBody).truthy() && !body) throw StompError(u"`on body` needs a `body` to rest on", p);
  d->set(K_onBody, p->get(K_onBody).truthy());
  return d;
}

/** One entry per pad that has a 3D lead, in final coordinates. */
ArrP Builder::leads3d() {
  ArrP out = list();
  const auto sign = [](const U& s) { return s == u"left" || s == u"bottom" ? -1.0 : 1.0; };
  const auto axisOf = [](const U& s) { return s == u"left" || s == u"right" ? u'x' : u'y'; };
  pads.each([&](const U&, const PadP& p) {
    if (p->thermal) return;
    const PinLead* pl = pinLeads.get(p->name);
    const LeadP L = pl ? pl->lead : (p->generated ? lead : nullptr);
    if (!L || L->form == u"none" || !p->x || !std::isfinite(*p->x) || !std::isfinite(*p->y)) return;
    const Pos* g = p->gen && !p->gen->thermal ? p->gen.get() : nullptr;
    std::optional<U> side = g ? g->side : std::nullopt;
    if (!side && !g && body && L->form != u"ball" && L->form != u"pin" && L->form != u"wire") {
      // land mode: the side of the body the pad lies beyond
      const Body& b = *body;
      const double dx = (*p->x - *b.x) / js::max(b.w / 2, 1e-6), dy = (*p->y - *b.y) / js::max(b.l / 2, 1e-6);
      side = std::fabs(dx) >= std::fabs(dy) ? (dx < 0 ? u"left" : u"right") : (dy < 0 ? u"bottom" : u"top");
    }
    const char16_t ax = side ? axisOf(*side) : u'?';
    const double bbW = p->bb.x.hi - p->bb.x.lo, bbL = p->bb.y.hi - p->bb.y.lo;
    const double across = ax == u'x' ? bbL : bbW, along = ax == u'x' ? bbW : bbL;
    Val drill = nullptr;
    if (p->spec && p->spec->drill) drill = p->spec->drill->d ? *p->spec->drill->d : js::min(0, 0);
    const ObjP d = rec({
        {K_pad, p->name},
        {K_form, L->form},
        {K_w, opt(L->w)},
        {K_l, opt(L->l)},
        {K_d, opt(L->d)},
        {K_v, opt(L->v)},
        {K_x, *p->x},
        {K_y, *p->y},
        {K_side, opt(side)},
        {K_generated, g != nullptr},
        {K_perPin, pl != nullptr},
        {K_pitch, g && g->pitch && js::truthy(*g->pitch) ? Val(*g->pitch) : Val(nullptr)},
        {K_padAcross, js::truthy(across) ? Val(across) : Val(nullptr)},
        {K_padAlong, js::truthy(along) ? Val(along) : Val(nullptr)},
        {K_drill, drill},
        {K_castellated, p->spec && p->spec->castellated ? Val(*p->spec->castellated) : Val(nullptr)},
        {K_toe, nullptr},
        {K_src, L->node && !L->node->get(K_s).nullish() ? Val(list({rec({{K_s, L->node->get(K_s)}, {K_e, L->node->get(K_e)}})})) : Val(list())},
    });
    std::optional<double> spn;
    const double T = L->l ? *L->l : L->v ? *L->v : 0;
    if (L->span) spn = to_outer(*L->span, T);
    else if (g && g->leadSpan) spn = g->leadSpan;
    else if (g && g->axis && gen && gen->spacing(*g->axis) && gen->spacing(*g->axis)->ipc) spn = gen->spacing(*g->axis)->ipc->L;
    if (spn && side) {
      const double c0 = g ? -O[ax] : (body ? (ax == u'x' ? *body->x : *body->y) : (ax == u'x' ? *p->x : *p->y));
      d->set(K_toe, c0 + sign(*side) * *spn / 2);
    }
    out->a.push_back(d);
  });
  return out;
}

}  // namespace stomp::compiler
