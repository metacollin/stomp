// Features (SPEC 12.1; compile.js 2628-2965): lookup, flags, binding a call, and what a
// bound feature draws: 2D items on a layer, and solids for the 3D kernel.
#include <algorithm>
#include <cmath>

#include "../jsrt.hpp"
#include "../suggest.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
constexpr int MAX_DEPTH = 32;   // features placing features

bool contains(const std::vector<U>& v, const U& x) { return std::find(v.begin(), v.end(), x) != v.end(); }
const std::vector<Val>& items_of(const Val& v) {
  static const std::vector<Val> none;
  return v.is_arr() ? v.arr()->a : none;
}
U section_label(const ObjP& sec) {
  U out = u"`";
  const auto& names = sec->get(K_names).arr()->a;
  for (std::size_t i = 0; i < names.size(); ++i) out += (i ? U(u", ") : U()) + names[i].obj()->get(K_name).str();
  return out + u"`";
}
}  // namespace

/** A feature by name: the file's own first, then the standard library's. */
ObjP Builder::lookupFeature(const U& n) const {
  if (const ObjP* f = file->features.get(n)) return *f;
  if (const ObjP* f = file->lib->features.get(n)) return *f;
  return nullptr;
}

std::vector<U> Builder::featureNames() const {
  std::vector<U> out = file->features.keys();
  for (const U& k : file->lib->features.keys())
    if (!contains(out, k)) out.push_back(k);
  return out;
}

/** Every flag a feature takes: the names of its sections, and of the sections of every
 *  feature it places, at any depth. */
std::shared_ptr<Flags> Builder::flagsOf(const ObjP& f, std::unordered_set<const Obj*>* visiting) {
  auto& memo = file->flagMemo;
  if (auto it = memo.find(f.get()); it != memo.end()) return it->second;
  std::unordered_set<const Obj*> own;
  std::unordered_set<const Obj*>& seen = visiting ? *visiting : own;
  auto out = std::make_shared<Flags>();
  if (seen.count(f.get())) return out;
  seen.insert(f.get());
  std::function<void(const std::vector<Val>&)> walk = [&](const std::vector<Val>& list) {
    for (const Val& iv : list) {
      if (!iv.is_obj()) continue;
      const ObjP& it = iv.obj();
      const Val& t = it->get(K_type);
      if (is(t, u"Section")) {
        for (const Val& n : it->get(K_names).arr()->a) out->add(n.obj()->get(K_name).str());
        walk(items_of(it->get(K_body)));
      } else if (is(t, u"FeaturePlace")) {
        if (const ObjP g = lookupFeature(it->get(K_feature).obj()->get(K_name).str())) {
          const auto sub = flagsOf(g, &seen);
          for (const U& x : sub->list()) out->add(x);
        }
      }
    }
  };
  walk(items_of(f->get(K_body)));
  seen.erase(f.get());
  memo[f.get()] = out;
  return out;
}

/**
 * Bind a call of a feature: its parameters and names in a scope of its own, the flags in
 * effect (those passed down to it, and its own) and the sections they turn on.
 */
BoundP Builder::bindFeature(const ObjP& call, const BindOpts& o) {
  const U& cname = call->get(K_name).str();
  const ObjP f = lookupFeature(cname);
  if (!f) {
    const auto hint = suggest(cname, featureNames());
    throw StompError(u"unknown feature " + tick(cname) +
                         (hint ? u" — did you mean " + tick(*hint) + u"?" : u" — define it: `feature " + cname + u"`, its graphics or solids, then `end`"),
                     call);
  }
  const U& fname = f->get(K_name).str();
  const int depth = o.depth;
  if (depth > MAX_DEPTH)
    throw StompError(u"features place each other more than " + num_text(MAX_DEPTH) + u" deep: does " + tick(fname) + u" place itself?", call);
  const std::shared_ptr<Flags> accepted = flagsOf(f);
  const ScopeP callScope = o.scope ? o.scope : scope;
  Flags own;
  if (o.flags)
    for (const U& w : *o.flags)
      if (accepted->has(w)) own.add(w);
  std::vector<ObjP> pos;
  OrderedMap<U, ObjP> keys;
  bool seenPos = false;
  ObjP flagAfterPos;
  for (const Val& av : items_of(call->get(K_args))) {
    const ObjP& a = av.obj();
    if (a->get(K_key).truthy()) {
      const U& k = a->get(K_key).str();
      if (keys.has(k)) throw StompError(u"parameter " + tick(k) + u" is given twice", a);
      keys.set(k, a);
      continue;
    }
    const Val& word = a->get(K_word);
    if (!word.nullish() && accepted->has(word.str())) {
      const U& w = word.str();
      if (own.has(w) && !(o.flags && contains(*o.flags, w))) throw StompError(u"flag " + tick(w) + u" is given twice", a);
      own.add(w);
      if (seenPos && !flagAfterPos) flagAfterPos = a;
      continue;
    }
    if (!word.nullish()) {
      const U& w = word.str();
      Scope* lib = callScope->root()->library.get();
      const bool known = callScope->has(w) || w == u"pi" || parse_color(w, a) || (lib && lib->defs.has(w));
      // a lone word that's neither a flag nor a name: most likely a mistyped flag
      const auto hint = suggest(w, accepted->list());
      if (!known && hint) throw StompError(u"feature " + tick(fname) + u" has no flag " + tick(w) + u" — did you mean " + tick(*hint) + u"?", a);
      if (!known && accepted->size()) {
        std::vector<U> all = accepted->list();
        std::sort(all.begin(), all.end());
        U joined;
        for (std::size_t i = 0; i < all.size(); ++i) joined += (i ? U(u", ") : U()) + all[i];
        throw StompError(u"feature " + tick(fname) + u" has no flag " + tick(w) + u" (its flags: " + joined + u"), and no name " + tick(w) + u" is defined", a);
      }
    }
    if (flagAfterPos)
      throw StompError(u"a flag goes before or after the values, not between them: move " + tick(flagAfterPos->get(K_word).str()), flagAfterPos);
    seenPos = true;
    pos.push_back(a);
  }
  auto bound = std::make_shared<Bound>();
  if (o.inherit)
    for (const U& w : o.inherit->list()) bound->flags.add(w);
  for (const U& w : own.list()) bound->flags.add(w);
  const auto& params = items_of(f->get(K_params));
  if (pos.size() > params.size()) {
    throw StompError(u"feature " + tick(fname) + u" takes " + num_text(static_cast<double>(params.size())) + u" value" +
                         (params.size() == 1 ? U() : U(u"s")) + u", but this gives " + num_text(static_cast<double>(pos.size())),
                     pos[params.size()]);
  }
  std::vector<U> pnames;
  for (const Val& q : params) pnames.push_back(q.obj()->get(K_name).str());
  OrderedMap<U, ObjP> given;
  for (std::size_t i = 0; i < pos.size(); ++i) given.set(pnames[i], pos[i]);
  for (const U& k : keys.keys()) {
    const ObjP& a = *keys.get(k);
    if (!contains(pnames, k)) {
      const auto hint = suggest(k, pnames);
      throw StompError(u"feature " + tick(fname) + u" has no parameter " + tick(k) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()), a);
    }
    if (given.has(k)) throw StompError(u"parameter " + tick(k) + u" is given twice", a);
    given.set(k, a);
  }
  // the sections that are on, and the values they set: the innermost wins
  struct SetAt {
    ObjP st;
    std::vector<const Obj*> path;
    ObjP sec;
  };
  OrderedMap<U, SetAt> sets;
  const auto within = [](const std::vector<const Obj*>& a, const std::vector<const Obj*>& b) {
    if (a.size() > b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
      if (b[i] != a[i]) return false;
    return true;
  };
  std::function<void(const std::vector<Val>&, const std::vector<const Obj*>&)> walk = [&](const std::vector<Val>& list,
                                                                                            const std::vector<const Obj*>& path) {
    for (const Val& iv : list) {
      if (!iv.is_obj()) continue;
      const ObjP& it = iv.obj();
      if (!is(it->get(K_type), u"Section")) continue;
      bool on = false;
      for (const Val& n : it->get(K_names).arr()->a) on = on || bound->flags.has(n.obj()->get(K_name).str());
      if (!on) continue;
      bound->active.insert(it.get());
      std::vector<const Obj*> inner = path;
      inner.push_back(it.get());
      for (const Val& sv : items_of(it->get(K_body))) {
        if (!sv.is_obj() || !is(sv.obj()->get(K_type), u"Set")) continue;
        const ObjP& st2 = sv.obj();
        const U& sn = st2->get(K_name).str();
        const SetAt* prev = sets.get(sn);
        if (prev && prev->path.size() == inner.size() && within(prev->path, inner)) throw StompError(tick(sn) + u" is set twice in this section", st2);
        if (prev && !within(prev->path, inner) && !within(inner, prev->path)) {
          throw StompError(u"sections " + section_label(prev->sec) + u" and " + section_label(it) + u" are both on and both set " + tick(sn) +
                               u": nest one inside the other, or set it in one",
                           st2);
        }
        if (!prev || inner.size() > prev->path.size()) sets.set(sn, {st2, inner, it});
      }
      walk(items_of(it->get(K_body)), inner);
    }
  };
  walk(items_of(f->get(K_body)), {});
  auto sc = std::make_shared<Scope>(f->get(K_lib).truthy() ? file->lib->lets : file->lets);
  const Val funit = f->get(K_unit);
  for (const Val& qv : params) {
    const ObjP& q = qv.obj();
    const U& qn = q->get(K_name).str();
    const ObjP* g = given.get(qn);
    const SetAt* st2 = sets.get(qn);
    const EV* value = nullptr;
    if (o.values)
      for (const auto& [k, v] : *o.values)
        if (k == qn) { value = &v; break; }
    Def def;
    if (g) {
      def.x = (*g)->get(K_x);
      def.unit = o.unit;
      def.scope = callScope;
    } else if (value) {
      def.value = *value;
    } else if (st2) {
      def.x = st2->st->get(K_x);
      def.unit = st2->st->get(K_unit).truthy() ? st2->st->get(K_unit) : funit;
    } else if (q->get(K_def).truthy()) {
      def.x = q->get(K_def);
      def.unit = funit;
    } else {
      def.missing = fname;
    }
    sc->defs.set(qn, std::move(def));
  }
  for (const Val& lv2 : items_of(f->get(K_body))) {
    if (!lv2.is_obj() || !is(lv2.obj()->get(K_type), u"Let")) continue;
    const ObjP& l = lv2.obj();
    const U& ln = l->get(K_name).str();
    if (sc->defs.has(ln)) {
      throw StompError(contains(pnames, ln) ? tick(ln) + u" is a parameter of " + tick(fname) + u": give it a default in the parameter list, or a new value in a section"
                                            : tick(ln) + u" already has a value in " + tick(fname) + u" (a name gets one value)",
                       range(l->get(K_nameS).num(), l->get(K_nameE).num()));
    }
    const SetAt* st2 = sets.get(ln);
    Def def;
    if (st2) {
      def.x = st2->st->get(K_x);
      def.unit = st2->st->get(K_unit).truthy() ? st2->st->get(K_unit) : funit;
    } else {
      def.x = l->get(K_x);
      def.unit = l->get(K_unit).truthy() ? l->get(K_unit) : funit;
    }
    sc->defs.set(ln, std::move(def));
  }
  for (const U& sn : sets.keys()) {
    bool defined = contains(pnames, sn);
    for (const Val& lv2 : items_of(f->get(K_body)))
      defined = defined || (lv2.is_obj() && is(lv2.obj()->get(K_type), u"Let") && lv2.obj()->get(K_name).str() == sn);
    if (!defined) {
      const SetAt& v = *sets.get(sn);
      throw StompError(u"section " + section_label(v.sec) + u" sets " + tick(sn) + u", which isn't a parameter of " + tick(fname) + u" or a name defined in it",
                       range(v.st->get(K_nameS).num(), v.st->get(K_nameE).num()));
    }
  }
  bound->f = f;
  bound->scope = sc;
  bound->depth = depth;
  bound->lib = f->get(K_lib).truthy();
  bound->call = call;
  return bound;
}

/** A bound feature's statements in order, those of its sections that are on in place. */
void Builder::eachItem(const Bound& bound, const std::function<void(const ObjP&)>& fn) {
  std::function<void(const std::vector<Val>&)> walk = [&](const std::vector<Val>& list) {
    for (const Val& iv : list) {
      if (!iv.is_obj()) continue;
      const ObjP& it = iv.obj();
      const Val& t = it->get(K_type);
      if (is(t, u"Section")) {
        if (bound.active.count(it.get())) walk(items_of(it->get(K_body)));
      } else if (!is(t, u"Let") && !is(t, u"Set")) {
        fn(it);
      }
    }
  };
  walk(items_of(bound.f->get(K_body)));
}

/** The items a bound feature draws on one 2D layer, through `map` (local point to footprint). */
Gfxs Builder::featureLayer(const BoundP& bound, V layer, const MapFn& map) {
  Gfxs out;
  inFeature(bound, [&] {
    eachItem(*bound, [&](const ObjP& it) {
      if (is(it->get(K_type), u"FeatureLayer") && is(it->get(K_layer), layer))
        gfx(it->get(K_items).arr(), layer, out, layer == u"silk" ? D().silkW : D().fabW, &map, bound.get());
      else if (is(it->get(K_type), u"FeaturePlace"))
        guard_void(it, [&] {
          for (auto& g : placedLayer(it, bound, layer, map)) out.push_back(std::move(g));
        });
    });
  });
  return out;
}

/** The items of a feature placed in another (`feature NAME at (x, y) rotate: A`) on one
 *  layer: at its point, turned about z, then through the outer feature's map. */
Gfxs Builder::placedLayer(const ObjP& u, const BoundP& bound, V layer, const MapFn& map) {
  BindOpts o;
  o.inherit = &bound->flags;
  o.depth = bound->depth + 1;
  o.unit = u->get(K_unit);
  o.scope = scope;
  const BoundP sub = bindFeature(u->get(K_feature).obj(), o);
  const ObjP& at = u->get(K_at).obj();
  const double ox = len(at->get(K_x), u), oy = len(at->get(K_y), u);
  const auto cs = geom::cos_sin(u->get(K_rotate).truthy() ? deg(u->get(K_rotate).obj()->get(K_z), u) : 0);
  return featureLayer(sub, layer, [map, ox, oy, cs](Pt q) { return map({ox + q.x * cs[0] - q.y * cs[1], oy + q.x * cs[1] + q.y * cs[0]}); });
}

/** A feature's graphics around its own origin. Its parameters take the arguments like a
 *  template's; plain numbers in them take the unit of the feature's statements. */
FeatureItems Builder::featureItems(const ObjP& use, const ObjP& node) {
  BindOpts o;
  o.unit = node->get(K_unit);
  o.scope = scope;
  const BoundP bound = bindFeature(use, o);
  const MapFn id = [](Pt q) { return q; };
  FeatureItems fi;
  fi.silk = featureLayer(bound, u"silk", id);
  fi.assembly = featureLayer(bound, u"assembly", id);
  fi.bound = bound;
  return fi;
}

/** The solids a bound feature draws, as descriptors for the 3D kernel, in frame M. */
std::vector<ObjP> Builder::featureSolids(const BoundP& bound, const std::optional<geom::Frame>& M) {
  std::vector<ObjP> out;
  inFeature(bound, [&] {
    eachItem(*bound, [&](const ObjP& it) {
      if (is(it->get(K_type), u"FeaturePlace")) {
        guard_void(it, [&] {
          BindOpts o;
          o.inherit = &bound->flags;
          o.depth = bound->depth + 1;
          o.unit = it->get(K_unit);
          o.scope = scope;
          const BoundP sub = bindFeature(it->get(K_feature).obj(), o);
          const geom::Frame B = placement3(it);
          const std::optional<geom::Frame> MB = M ? geom::compose3(*M, B) : B;
          for (auto& d : featureSolids(sub, MB)) out.push_back(std::move(d));
        });
      } else if (is(it->get(K_type), u"FeatureModel")) {
        for (const Val& q : items_of(it->get(K_items))) guard_void(q.obj(), [&] { out.push_back(solidDesc(q.obj(), M, true)); });
      }
    });
  });
  return out;
}

/** The frame `feature NAME at (x, y, z) rotate: R` puts its feature in. */
geom::Frame Builder::placement3(const ObjP& q) {
  std::array<double, 3> at{0, 0, 0}, rot{0, 0, 0};
  if (q->get(K_at).truthy()) {
    const ObjP& a = q->get(K_at).obj();
    at[0] = len(a->get(K_x), q);
    at[1] = len(a->get(K_y), q);
    at[2] = a->get(K_z).truthy() ? len(a->get(K_z), q) : 0;
  }
  if (q->get(K_rotate).truthy()) {
    const ObjP& r = q->get(K_rotate).obj();
    rot[0] = deg(r->get(K_x), q);
    rot[1] = deg(r->get(K_y), q);
    rot[2] = deg(r->get(K_z), q);
  }
  return geom::frame3(at, rot);
}

/** A path's points, arcs filled in; arcs[i] is true for an arc's own points, which a fillet
 *  leaves as they are. */
ArrP Builder::pathPts(const ArrP& path, const ObjP& stmt, ArrP* arcs) {
  ArrP pts = list();
  ArrP flags = list();
  for (const Val& iv : path->a) {
    const ObjP& it = iv.obj();
    if (it->get(K_pt).truthy()) {
      const ObjP& pt = it->get(K_pt).obj();
      const double x = len(pt->get(K_x), stmt), y = len(pt->get(K_y), stmt);
      pts->a.push_back(pt_val({x, y}));
      flags->a.push_back(false);
      continue;
    }
    const ObjP& c = it->get(K_c).obj();
    const double cx = len(c->get(K_x), stmt), cy = len(c->get(K_y), stmt);
    const double r = len(it->get(K_r), stmt);
    const double a0 = angleOf(it->get(K_from).obj(), stmt), a1 = angleOf(it->get(K_to).obj(), stmt);
    const double n = it->get(K_segments).truthy() ? countIn(it->get(K_segments), stmt, 1, 1024, u"an arc's `segments`")
                                                  : js::max(2, std::ceil(std::fabs(a1 - a0) / 10));
    for (double j = 0; j <= n; j++) {
      const double a = ((a0 + ((a1 - a0) * j) / n) * geom::PI) / 180;
      pts->a.push_back(pt_val({cx + r * js::cos(a), cy + r * js::sin(a)}));
      flags->a.push_back(true);
    }
  }
  if (arcs) *arcs = flags;
  return pts;
}

/** A solid's `name:` as text, or null: a "string", interpolated, or a parameter that holds
 *  text. An empty name is no name. */
Val Builder::solidName(const ObjP& p) {
  const Val& n = p->get(K_name);
  if (n.nullish()) return nullptr;
  U t;
  if (n.is_str()) t = n.str();
  else if (n.obj()->get(K_interp).truthy()) t = interpolate(n, env(p));
  else {
    const Val& x = n.obj()->get(K_x);
    const EV v = val(x, p);
    if (v.k != VK::Str) throw StompError(u"a solid's `name:` is text, such as \"lid\"", x.obj());
    t = v.s;
  }
  return t.empty() ? Val(nullptr) : Val(t);
}

/**
 * A solid as a descriptor for the 3D kernel. In a feature, `at` is where the solid's own
 * origin goes (a box, cylinder or sphere's is the middle of its bottom) and a size of zero
 * or less draws nothing. At the footprint level the sizes must be positive, and the solid
 * is placed as SPEC 13.3 says.
 */
ObjP Builder::solidDesc(const ObjP& p, const std::optional<geom::Frame>& M, bool inFeature) {
  const U& kind = p->get(K_kind).str();
  ObjP d = rec({{K_op, kind},
                {K_M, M ? frame_val(*M) : Val(nullptr)},
                {K_node, rec({{K_s, p->get(K_s)}, {K_e, p->get(K_e)}})},
                {K_name, solidName(p)},
                {K_kind, p->get(K_solidKind).truthy() ? p->get(K_solidKind) : Val(nullptr)}});
  const auto what = [&](V k) { return kind + u" " + U(k); };
  const auto size = [&](const Val& x, V k) {
    const double v = len(x, p);
    if (inFeature) {
      if (!(v > 0)) d->set(K_empty, true);
    } else if (v < 0) throw StompError(u"the " + what(k) + u" must not be negative (got " + fmt_mm(v) + u")", x.obj());
    else if (v == 0) warn(u"the " + what(k) + u" is zero", x.obj());
    return v;
  };
  const auto nonNeg = [&](const Val& x, V k) {
    const double v = len(x, p);
    if (v < 0) throw StompError(u"the " + what(k) + u" must not be negative (got " + fmt_mm(v) + u")", x.obj());
    return v;
  };
  if (kind == u"box" || kind == u"slab") {
    d->set(K_w, size(p->get(K_w), u"width"));
    d->set(K_l, size(p->get(K_l), u"length"));
    d->set(K_h, size(p->get(K_h), u"height"));
    if (p->get(K_castellated).truthy()) d->set(K_castellated, true);
  } else if (kind == u"cylinder") {
    const double dd = size(p->get(K_d), u"diameter");
    d->set(K_d, dd);
    d->set(K_d2, p->get(K_d2).truthy() ? nonNeg(p->get(K_d2), u"top diameter") : dd);
    d->set(K_h, size(p->get(K_h), u"height"));
  } else if (kind == u"sphere") {
    const double dd = size(p->get(K_d), u"diameter");
    d->set(K_d, dd);
    d->set(K_h, p->get(K_h).truthy() ? size(p->get(K_h), u"height") : dd);
  } else if (kind == u"disc") {
    if (p->get(K_d2).truthy()) {
      const double r0 = nonNeg(p->get(K_d), u"inner diameter") / 2;
      d->set(K_r0, r0);
      const double r1 = size(p->get(K_d2), u"outer diameter") / 2;
      d->set(K_r1, r1);
      if (!(r1 > r0)) d->set(K_empty, true);
    } else {
      d->set(K_r0, 0);
      d->set(K_r1, size(p->get(K_d), u"diameter") / 2);
    }
  } else if (kind == u"prism") {
    const ArrP path = pathPts(p->get(K_path).arr(), p, nullptr);
    d->set(K_path, path);
    d->set(K_h, size(p->get(K_h), u"height"));
    if (path->a.size() < 3) throw StompError(u"a prism's outline needs three points or more", p);
  } else if (kind == u"face") {
    const ArrP path = pathPts(p->get(K_path).arr(), p, nullptr);
    d->set(K_path, path);
    if (path->a.size() < 3) throw StompError(u"a face needs three points or more", p);
  } else if (kind == u"loft") {
    ArrP rings = list();
    for (const Val& rv : p->get(K_rings).arr()->a) {
      const ObjP& r = rv.obj();
      const double w = size(r->get(K_w), u"ring width");
      const double l = size(r->get(K_l), u"ring length");
      const double z = len(r->get(K_z), p);
      rings->a.push_back(rec({{K_w, w}, {K_l, l}, {K_z, z}}));
    }
    d->set(K_rings, rings);
  } else if (kind == u"sweep" || kind == u"wire") {
    if (kind == u"sweep") {
      d->set(K_w, size(p->get(K_w), u"width"));
      d->set(K_t, size(p->get(K_t), u"thickness"));
    } else {
      d->set(K_d, size(p->get(K_d), u"diameter"));
    }
    ArrP arcs;
    const ArrP path = pathPts(p->get(K_path).arr(), p, &arcs);
    d->set(K_path, path);
    d->set(K_keep, arcs);
    if (path->a.size() < 2) throw StompError(u"a " + kind + u" needs a path of two points or more", p);
    if (p->get(K_fillet).truthy()) {
      d->set(K_fillet, nonNeg(p->get(K_fillet), u"fillet radius"));
      const double step = p->get(K_step).truthy() ? angleOf(p->get(K_step).obj(), p) : 10;
      d->set(K_step, step);
      if (!(step > 0)) throw StompError(u"a fillet's `step` is an angle above zero", p->get(K_step).obj());
    }
  } else {
    throw StompError(u"unknown solid " + tick(kind), p);
  }
  const auto only = [&](Key key, std::initializer_list<const char16_t*> kinds, V text) {
    const Val& v = p->get(key);
    if (v.nullish() || (v.is_bool() && !v.boolean())) return;
    bool ok = false;
    U joined;
    for (const char16_t* k : kinds) {
      ok = ok || kind == k;
      joined += (joined.empty() ? U() : U(u" and ")) + k;
    }
    if (!ok) throw StompError(tick(text) + u" works on " + joined + u" solids, not on a " + kind, p);
  };
  only(K_open, {u"cylinder"}, u"open");
  only(K_from, {u"cylinder", u"disc"}, u"from … to …");
  only(K_down, {u"disc", u"face"}, u"down");
  only(K_segments, {u"cylinder", u"disc", u"sphere", u"wire"}, u"segments");
  if (!inFeature && p->get(K_solidKind).truthy())
    throw StompError(u"`kind` is for solids in a feature; a model block's own solids are extra parts", p);
  if (p->get(K_at).truthy()) {
    const ObjP& a = p->get(K_at).obj();
    const double x = len(a->get(K_x), p), y = len(a->get(K_y), p);
    const Val z = a->get(K_z).truthy() ? Val(len(a->get(K_z), p)) : Val(nullptr);
    ArrP at = list({x, y, z});
    if (inFeature && at->a[2].nullish()) at->a[2] = 0;
    d->set(K_at, at);
  } else {
    d->set(K_at, nullptr);
  }
  if (p->get(K_rotate).truthy()) {
    const ObjP& r = p->get(K_rotate).obj();
    const double rx = deg(r->get(K_x), p), ry = deg(r->get(K_y), p), rz = deg(r->get(K_z), p);
    d->set(K_rot, list({rx, ry, rz}));
  } else {
    d->set(K_rot, nullptr);
  }
  d->set(K_color, !p->get(K_color).nullish() ? color_val(colorValue(p->get(K_color), p)) : Val(nullptr));
  d->set(K_open, p->get(K_open).truthy() ? p->get(K_open) : Val(nullptr));
  if (p->get(K_from).truthy()) {
    d->set(K_from, angleOf(p->get(K_from).obj(), p));
    d->set(K_to, angleOf(p->get(K_to).obj(), p));
  }
  d->set(K_segments, p->get(K_segments).truthy() ? Val(countIn(p->get(K_segments), p, 3, 1024, u"`segments`")) : Val(nullptr));
  d->set(K_down, p->get(K_down).truthy());
  return d;
}

}  // namespace stomp::compiler
