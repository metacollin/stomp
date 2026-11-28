// Collecting statements, and pad specs (compile.js 931-1158).
#include <algorithm>
#include <cmath>

#include "../jsrt.hpp"
#include "builder.hpp"

namespace stomp::compiler {

void Builder::gather() {
  broken.clear();
  st = St{};
  OrderedMap<U, Item> singles;
  const auto single = [&](std::optional<Item>& slot, const U& key, const Item& it, V label) {
    const Item* prev = singles.get(key);
    if (prev && prev->level == it.level) {
      err(tick(label) + u" is given twice in this footprint (first on line " + num_text(lineAt(prev->s->get(K_s).num())) + u")", it.s,
          {{u"first given here", prev->s}});
      return;
    }
    if (!prev || prev->level < it.level) {
      singles.set(key, it);
      slot = it;
    }
  };
  for (const auto& it : items) {
    const ObjP& s = it.s;
    const U& t = s->get(K_type).str();
    if (t == u"Let") continue;
    if (t == u"Broken") {
      const Val& target = s->get(K_target);
      if (target.truthy()) {
        const Val& n = target.obj()->get(K_name);
        if (!n.nullish()) broken.insert(n.is_str() ? n.str() : num_text(n.num()));
        if (is(target.obj()->get(K_kind), u"body")) broken.insert(u"#body");
      }
    } else if (t == u"Meta") {
      st.meta.set(s->get(K_key).str(), {s->get(K_value), s});
    } else if (t == u"Name") {
      if (!is(decl->get(K_mode), u"from") && it.level == ownLevel)
        err(u"`name:` belongs in a template (or a `from … with` block) — this footprint is already named in its header", s);
    } else if (t == u"Body") single(st.body, u"body", it, u"body");
    else if (t == u"Pins" || t == u"Balls") single(st.gen, u"gen", it, t == u"Balls" ? u"balls" : u"pins");
    else if (t == u"Lead") {
      if (s->get(K_names).truthy()) st.pinLeads.push_back(it);
      else single(st.lead, u"lead", it, u"lead");
    } else if (t == u"Density") single(st.density, u"density", it, u"density");
    else if (t == u"Pin1") single(st.pin1, u"pin1", it, u"pin1");
    else if (t == u"Polarized") st.polarized = it;
    else if (t == u"DefaultPad") single(st.defaultPad, u"defaultPad", it, u"default pad");
    else if (t == u"Origin") single(st.origin, u"origin", it, u"origin");
    else if (t == u"MeasureBare") {
      if (is(s->get(K_word), u"pitch")) single(st.barePitch, u"barePitch", it, u"pitch");
      else single(st.bareSpan, u"bareSpan", it, u"span/gap");
    } else if (t == u"Model") {
      // model blocks merge down an extends chain; two at one level is an error
      const Item* twin = nullptr;
      for (const auto& m : st.models)
        if (m.level == it.level) { twin = &m; break; }
      if (twin)
        err(tick(s->get(K_none).truthy() ? u"no model" : u"model") + u" is given twice in this footprint (first on line " +
                num_text(lineAt(twin->s->get(K_s).num())) + u")",
            s, {{u"first given here", twin->s}});
      else st.models.push_back(it);
    } else if (t == u"Omit") st.omits.push_back(it);
    else if (t == u"Only") st.onlys.push_back(it);
    else if (t == u"Pad") st.padStmts.push_back(it);
    else if (t == u"Pads") st.padsStmts.push_back(it);
    else if (t == u"Hole") st.holes.push_back(it);
    else if (t == u"Delete") st.deletes.push_back(it);
    else if (t == u"Row") st.rows.push_back(it);
    else if (t == u"Group") st.groups.push_back(it);
    else if (t == u"Thermal") st.thermals.push_back(it);
    else if (t == u"Text") st.texts.push_back(it);
    else if (t == u"FeatureUse") st.features.push_back(it);
    else if (t == u"Layer") st.layer(s->get(K_layer).str()).push_back(it);
    else if (t == u"At" || t == u"Is" || t == u"Centered" || t == u"Mirrors" || t == u"Align" || t == u"MeasurePair") st.places.push_back(it);
  }
  density = st.density ? st.density->s->get(K_level).str() : U(u"nominal");
  lv = density == u"most" ? 0 : density == u"least" ? 2 : 1;
  // body
  body.reset();
  if (st.body) {
    const ObjP b = st.body->s;
    bodyFailed = true;
    guard_void(b, [&] {
      Body nb;
      nb.node = b;
      if (b->get(K_cyl).truthy()) {
        nb.kind = u"cyl";
        nb.w = plen(b->get(K_d), b, u"body diameter");
        nb.l = 0;
        nb.h = plen(b->get(K_h), b, u"body height");
        nb.l = nb.w;
      } else {
        nb.kind = u"box";
        nb.w = plen(b->get(K_w), b, u"body width");
        nb.l = plen(b->get(K_l), b, u"body length");
        if (b->get(K_h).truthy()) nb.h = plen(b->get(K_h), b, u"body height");
      }
      body = std::move(nb);
      bodyFailed = false;
    });
  }
  // lead
  lead.reset();
  if (st.lead) {
    const ObjP n = st.lead->s;
    guard_void(n, [&] {
      lead = leadFrom(n);
      if (is(n->get(K_form), u"castellated")) warn(u"castellated leads are provisional (SPEC §17.7): the demo draws a plain edge land", n);
    });
  }
  // per-pin leads: a later line wins for a pin named twice
  pinLeads.clear();
  std::vector<Item> per = st.pinLeads;
  std::stable_sort(per.begin(), per.end(), [](const Item& a, const Item& b) {
    if (a.level != b.level) return a.level < b.level;
    return a.s->get(K_s).num() < b.s->get(K_s).num();
  });
  for (const auto& it : per) {
    const ObjP n = it.s;
    guard_void(n, [&] {
      LeadP L;
      if (n->get(K_none).truthy()) {
        L = std::make_shared<Lead>();
        L->form = u"none";
        L->node = n;
      } else {
        L = leadFrom(n);
      }
      L->perPin = true;
      for (const Val& sv : n->get(K_names).arr()->a) {
        const ObjP& sel = sv.obj();
        std::vector<U> names;
        if (sel->get(K_range).truthy()) {
          const auto& r = sel->get(K_range).arr()->a;
          names = expand_range(r[0].obj(), r[1].obj(), sel);
        } else {
          const Val& nm = sel->get(K_name).obj()->get(K_name);
          names.push_back(nm.is_str() ? nm.str() : num_text(nm.num()));
        }
        for (const U& nm : names) pinLeads.set(nm, {L, sel});
      }
    });
  }
  // default pad
  defaultSpec.reset();
  if (st.defaultPad) {
    const ObjP s = st.defaultPad->s;
    if (auto spec = guard(s, [&] { return specFromGeom(s->get(K_geom).obj(), s); })) defaultSpec = std::move(*spec);
  }
  if (st.polarized) polarized = true;
}

LeadP Builder::leadFrom(const ObjP& n) {
  auto L = std::make_shared<Lead>();
  L->form = n->get(K_form).str();
  L->node = n;
  if (n->get(K_dims).truthy()) {
    const ObjP& dims = n->get(K_dims).obj();
    if (dims->get(K_d).truthy()) L->d = plen(dims->get(K_d), n, u"lead diameter");
    else if (dims->get(K_w).truthy()) {
      L->w = plen(dims->get(K_w), n, u"lead width");
      L->l = plen(dims->get(K_l), n, u"lead length");
    } else L->v = plen(dims->get(K_v), n, u"lead size");
  }
  if (n->get(K_span).truthy()) {
    const ObjP& sp = n->get(K_span).obj();
    LeadSpan span;
    span.v = plen(sp->get(K_x), n, u"span");
    span.qual = sp->get(K_qual).truthy() ? sp->get(K_qual).str() : U(u"outer");
    span.node = sp;
    L->span = std::move(span);
  }
  return L;
}

geom::Shape Builder::shapeFrom(const ObjP& sh, const ObjP& stmt) {
  const auto L = [&](const Val& x, V what) { return plen(x, stmt, what); };
  const U& kind = sh->get(K_kind).str();
  geom::Shape out;
  if (kind == u"rect" || kind == u"oval") {
    out.kind = kind == u"rect" ? geom::Kind::Rect : geom::Kind::Oval;
    const ObjP& size = sh->get(K_size).obj();
    out.w = L(size->get(K_w), u"pad width");
    out.l = L(size->get(K_l), u"pad length");
    return out;
  }
  if (kind == u"roundrect") {
    out.kind = geom::Kind::Roundrect;
    const ObjP& size = sh->get(K_size).obj();
    out.w = L(size->get(K_w), u"pad width");
    out.l = L(size->get(K_l), u"pad length");
    const ObjP& r = sh->get(K_r).obj();
    if (!r->get(K_pct).nullish()) {
      out.r_pct = r->get(K_pct).num();
      out.r = (*out.r_pct / 100) * js::min(out.w, out.l);
    } else {
      out.r = L(r->get(K_x), u"corner radius");
    }
    return out;
  }
  if (kind == u"dshape") {
    out.kind = geom::Kind::Dshape;
    const ObjP& size = sh->get(K_size).obj();
    out.w = L(size->get(K_w), u"pad width");
    out.l = L(size->get(K_l), u"pad length");
    out.flat = sh->get(K_flat).truthy() ? sh->get(K_flat).str() : U(u"left");
    return out;
  }
  if (kind == u"circle") {
    out.kind = geom::Kind::Circle;
    out.d = L(sh->get(K_d), u"pad diameter");
    return out;
  }
  if (kind == u"polygon") {
    Poly pts;
    for (const Val& p : sh->get(K_pts).arr()->a) {
      const double x = len(p.obj()->get(K_x), stmt);
      const double y = len(p.obj()->get(K_y), stmt);
      pts.push_back({x, y});
    }
    if (std::fabs(geom::poly_area(pts)) < 1e-12) throw StompError(u"polygon pad has no area", sh);
    const Pt c = geom::poly_centroid(pts);
    Poly rel;
    for (const Pt& p : pts) rel.push_back({p.x - c.x, p.y - c.y});
    out.kind = geom::Kind::Polygon;
    out.pts = geom::ensure_ccw(rel);
    return out;
  }
  throw StompError(u"unknown shape", sh);
}

Drill Builder::drillFrom(const ObjP& d, const ObjP& stmt) {
  Drill out;
  if (d->get(K_slot).truthy()) {
    const ObjP& slot = d->get(K_slot).obj();
    out.slotW = plen(slot->get(K_w), stmt, u"slot width");
    out.slotL = plen(slot->get(K_l), stmt, u"slot length");
    return out;
  }
  out.d = plen(d->get(K_d), stmt, u"drill diameter");
  return out;
}

void Builder::applyProp(Spec& spec, const ObjP& p, const ObjP& stmt) {
  const U& prop = p->get(K_prop).str();
  if (prop == u"rotate") {
    spec.rot = angleOf(p->get(K_angle).obj(), stmt);
  } else if (prop == u"mask") {
    const U& mode = p->get(K_mode).str();
    Mask m{mode, 0};
    if (mode == u"expand") {
      const ObjP& value = p->get(K_value).obj();
      m.v = value->get(K_sign).num() * len(value->get(K_x), stmt);
    }
    spec.mask = m;
  } else if (prop == u"paste") {
    const U& mode = p->get(K_mode).str();
    if (mode == u"expand") {
      const ObjP& value = p->get(K_value).obj();
      Paste pa;
      pa.mode = mode;
      pa.v = value->get(K_sign).num() * len(value->get(K_x), stmt);
      spec.paste = pa;
    } else if (mode == u"divide") {
      const double nx = countOf(p->get(K_nx).obj(), stmt), ny = countOf(p->get(K_ny).obj(), stmt);
      if (nx < 1 || ny < 1) throw StompError(u"paste divide needs at least 1 x 1 windows", p);
      Paste pa;
      pa.mode = mode;
      pa.nx = nx;
      pa.ny = ny;
      if (p->get(K_coverage).truthy()) pa.coverage = p->get(K_coverage).obj()->get(K_pct).num() / 100;
      if (p->get(K_gutter).truthy()) pa.gutter = plen(p->get(K_gutter), stmt, u"gutter");
      spec.paste = pa;
      if (pa.coverage && !(*pa.coverage > 0 && *pa.coverage <= 1))
        throw StompError(u"paste coverage must be between 0% and 100%", p->get(K_coverage).obj());
    } else {
      Paste pa;
      pa.mode = mode;
      spec.paste = pa;
    }
  } else if (prop == u"vias") {
    Vias v;
    v.nx = countOf(p->get(K_nx).obj(), stmt);
    v.ny = countOf(p->get(K_ny).obj(), stmt);
    v.drill = plen(p->get(K_drill), stmt, u"via drill");
    v.pitch = plen(p->get(K_pitch), stmt, u"via pitch");
    spec.vias = v;
  }
  if (!spec.src) spec.src.emplace();
  spec.src->push_back(p);
}

Spec Builder::specFromGeom(const ObjP& g, const ObjP& stmt) {
  Spec spec;
  spec.shape = shapeFrom(g->get(K_shape).obj(), stmt);
  spec.tht = g->get(K_tht).truthy();
  if (g->get(K_drill).truthy()) spec.drill = drillFrom(g->get(K_drill).obj(), stmt);
  for (const Val& p : g->get(K_props).arr()->a) applyProp(spec, p.obj(), stmt);
  if (spec.tht && !spec.drill) throw StompError(u"a `tht` pad needs a drill: add `drill: D` or `drill: slot W x L`", g);
  if (!spec.tht && spec.drill) {
    warn(u"this pad has a drill but isn't marked `tht`; treating it as through-hole", g);
    spec.tht = true;
  }
  return spec;
}

void Builder::applyBlock(Spec& spec, const ArrP& stmts, const ObjP& stmt) {
  for (const Val& bv : stmts->a) {
    const ObjP& b = bv.obj();
    guard_void(b, [&] {
      const U& op = b->get(K_op).str();
      if (op == u"shape") spec.shape = shapeFrom(b->get(K_shape).obj(), stmt);
      else if (op == u"size") {
        const ObjP& size = b->get(K_size).obj();
        const double w = plen(size->get(K_w), stmt, u"pad width");
        const double l = plen(size->get(K_l), stmt, u"pad length");
        resize(spec, w, l, b);
      } else if (op == u"width") resize(spec, plen(b->get(K_x), stmt, u"pad width"), std::nullopt, b);
      else if (op == u"length") resize(spec, std::nullopt, plen(b->get(K_x), stmt, u"pad length"), b);
      else if (op == u"drill") {
        spec.drill = drillFrom(b->get(K_drill).obj(), stmt);
        if (!spec.tht) {
          warn(u"adding a drill makes this an SMD pad through-hole", b);
          spec.tht = true;
        }
      } else if (op == u"prop") applyProp(spec, b->get(K_prop).obj(), stmt);
    });
  }
}

void Builder::resize(Spec& spec, std::optional<double> w, std::optional<double> l, const ObjP& node) {
  geom::Shape& sh = spec.shape;
  if (sh.kind == geom::Kind::Polygon)
    throw StompError(u"`width`/`length`/`size` can't resize a polygon pad — give it a new `shape`", node);
  if (sh.kind == geom::Kind::Circle) {
    const double W = w ? *w : sh.d, Lg = l ? *l : sh.d;
    geom::Shape n;
    if (std::fabs(W - Lg) < 1e-12) {
      n.kind = geom::Kind::Circle;
      n.d = W;
    } else {
      n.kind = geom::Kind::Oval;
      n.w = W;
      n.l = Lg;
    }
    spec.shape = n;
    return;
  }
  if (w) sh.w = *w;
  if (l) sh.l = *l;
  if (sh.kind == geom::Kind::Roundrect && sh.r_pct) sh.r = (*sh.r_pct / 100) * js::min(sh.w, sh.l);
}

Spec clone_spec(const Spec& s) {
  Spec c;
  c.shape = s.shape;
  c.tht = s.tht;
  c.drill = s.drill;
  c.rot = js::truthy(s.rot) ? s.rot : 0;
  c.mask = s.mask;
  c.paste = s.paste;
  c.vias = s.vias;
  c.ipc = s.ipc;
  c.castellated = s.castellated;
  c.src = s.src ? *s.src : std::vector<ObjP>{};
  return c;
}

}  // namespace stomp::compiler
