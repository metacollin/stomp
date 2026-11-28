// Objects (compile.js 1607-1847): pads, holes, rows and groups, and each pad's geometry.
#include <algorithm>
#include <cmath>

#include "../jsrt.hpp"
#include "../suggest.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
U name_text(const Val& n) { return n.is_str() ? n.str() : n.is_num() ? num_text(n.num()) : n.null() ? U(u"null") : U(u"undefined"); }
std::vector<U> sel_names(const ObjP& sel) {
  if (sel->get(K_range).truthy()) {
    const auto& r = sel->get(K_range).arr()->a;
    return expand_range(r[0].obj(), r[1].obj(), sel);
  }
  return {name_text(sel->get(K_name).obj()->get(K_name))};
}
}  // namespace

PadP Builder::newPad(const U& n) {
  auto p = std::make_shared<Pad>();
  p->name = n;
  pads.set(n, p);
  return p;
}

void Builder::makeObjects() {
  pads.clear();
  holes.clear();
  rows.clear();
  groups.clear();
  sides.clear();
  if (gen) {
    for (const auto& g : gen->positions) {
      PadP p = newPad(g->name);
      p->gen = g;
      p->generated = true;
      p->src.push_back(gen->node);
      if (gen->protoSrc) p->src.push_back(gen->protoSrc);
      if (gen->src) p->src.insert(p->src.end(), gen->src->begin(), gen->src->end());
      if (g->side) {
        if (!sides.has(*g->side)) sides.set(*g->side, {});
        sides.get(*g->side)->push_back(g->name);
      }
    }
  }
  for (const auto& it : st.thermals) {
    guard_void(it.s, [&] {
      const ObjP& s = it.s;
      const U n = s->get(K_name).truthy() ? name_text(s->get(K_name).obj()->get(K_name)) : U(u"EP");
      if (pads.has(n))
        throw StompError(u"thermal pad " + tick(n) + u" collides with an existing pad of that name — name it: `thermal pad 33 W x L`", s);
      const ObjP& size = s->get(K_size).obj();
      geom::Shape sh;
      sh.kind = geom::Kind::Rect;
      sh.w = plen(size->get(K_w), s, u"thermal pad width");
      sh.l = plen(size->get(K_l), s, u"thermal pad length");
      Spec proto;
      proto.shape = std::move(sh);
      auto g = std::make_shared<Pos>();
      g->proto = std::make_shared<const Spec>(std::move(proto));
      g->thermal = true;
      PadP p = newPad(n);
      p->gen = g;
      p->thermal = true;
      p->src.push_back(s);
      if (s->get(K_block).truthy()) p->partials.push_back({s->get(K_block).arr(), s, it.level});
    });
  }
  // explicit pads and pad blocks
  OrderedMap<U, Item> explicitAt;
  for (const auto& it : st.padStmts) {
    const ObjP& s = it.s;
    const U n = name_text(s->get(K_name).obj()->get(K_name));
    PadP* found = pads.get(n);
    PadP p = found ? *found : nullptr;
    if (s->get(K_geom).truthy()) {
      auto spec = guard(s, [&] { return specFromGeom(s->get(K_geom).obj(), s); });
      if (!p) p = newPad(n);
      if (!spec) p->geomFailed = true;
      const Item* prev = explicitAt.get(n);
      if (prev && prev->level == it.level) {
        err(u"pad " + n + u" is defined twice (first on line " + num_text(lineAt(prev->s->get(K_s).num())) + u")", s->get(K_name).obj(),
            {{u"first definition", prev->s}});
        continue;
      }
      if (!prev || prev->level < it.level) {
        explicitAt.set(n, it);
        if (spec) p->explicit_ = Explicit{std::move(*spec), it.level, s};
      }
      p->src.push_back(s);
    } else {
      if (!p) p = newPad(n);
      p->partials.push_back({s->get(K_block).arr(), s, it.level});
      p->src.push_back(s);
    }
  }
  for (const auto& it : st.holes) {
    const ObjP& s = it.s;
    const U n = name_text(s->get(K_name).obj()->get(K_name));
    if (holes.has(n) && (*holes.get(n))->level == it.level) {
      err(u"hole " + n + u" is defined twice", s->get(K_name).obj());
      continue;
    }
    if (pads.has(n)) {
      err(tick(n) + u" is already a pad — pads and holes share one namespace", s->get(K_name).obj());
      continue;
    }
    guard_void(s, [&] {
      auto h = std::make_shared<Hole>();
      h->name = n;
      if (s->get(K_slot).truthy()) {
        const ObjP& slot = s->get(K_slot).obj();
        h->shape.kind = geom::Kind::Oval;
        h->shape.w = plen(slot->get(K_w), s, u"slot width");
        h->shape.l = plen(slot->get(K_l), s, u"slot length");
        h->slot = true;
      } else {
        h->shape.kind = geom::Kind::Circle;
        h->shape.d = plen(s->get(K_d), s, u"hole diameter");
      }
      h->src = {s};
      h->level = it.level;
      holes.set(n, h);
    });
  }
  // rows (create missing member pads)
  for (const auto& it : st.rows) {
    const ObjP& s = it.s;
    guard_void(s, [&] {
      const U n = name_text(s->get(K_name).obj()->get(K_name));
      if (rows.has(n)) throw StompError(u"row " + n + u" is defined twice", s->get(K_name).obj());
      std::vector<PadP> members;
      for (const Val& sv : s->get(K_sel).arr()->a) {
        const ObjP& sel = sv.obj();
        for (const U& m : sel_names(sel)) {
          if (holes.has(m)) throw StompError(u"rows hold pads; " + tick(m) + u" is a hole", sel);
          PadP* found = pads.get(m);
          PadP p = found ? *found : newPad(m);
          p->src.push_back(s);
          members.push_back(p);
        }
      }
      auto row = std::make_shared<Row>();
      row->name = n;
      row->members = std::move(members);
      row->pitch = plen(s->get(K_pitch), s, u"row pitch");
      row->going = s->get(K_going).truthy() ? s->get(K_going).str() : U(u"right");
      row->node = s;
      rows.set(n, row);
    });
  }
  // mirrors create their target if needed (kind follows the prototype)
  for (const auto& it : st.places) {
    const ObjP& s = it.s;
    if (!is(s->get(K_type), u"Mirrors")) continue;
    const ObjP& target = s->get(K_target).obj();
    const ObjP& protoRef = s->get(K_proto).obj();
    const Val& tk = target->get(K_kind);
    const Val& pk = protoRef->get(K_kind);
    const U pname = name_text(protoRef->get(K_name));
    const bool protoIsHole = (is(pk, u"hole") || pk.nullish()) && holes.has(pname);
    const bool protoIsPad = (is(pk, u"pad") || pk.nullish()) && pads.has(pname);
    if (!protoIsHole && !protoIsPad) continue;   // reported later as unknown
    const U tname = name_text(target->get(K_name));
    if (tk.truthy() && !is(tk, u"pad") && !is(tk, u"hole")) continue;
    const U axis = s->get(K_axis).str();
    if (protoIsHole) {
      HoleP* hf = holes.get(tname);
      HoleP h = hf ? *hf : nullptr;
      if (!h && !pads.has(tname)) {
        const Hole& proto = **holes.get(pname);
        h = std::make_shared<Hole>();
        h->name = tname;
        h->shape = proto.shape;
        h->slot = proto.slot;
        h->src = {s};
        h->level = it.level;
        holes.set(tname, h);
      }
      if (h) {
        h->mirror = MirrorRef{pname, axis, s};
        h->src.push_back(s);
      }
    } else {
      PadP* pf = pads.get(tname);
      PadP p = pf ? *pf : nullptr;
      if (!p && !holes.has(tname)) p = newPad(tname);
      if (p) {
        if (p->mirror) err(u"pad " + tname + u" already mirrors pad " + p->mirror->proto, s, {{u"first mirror", p->mirror->node}});
        else p->mirror = MirrorRef{pname, axis, s};
        p->src.push_back(s);
      }
    }
  }
  // deletes
  for (const auto& it : st.deletes) {
    const ObjP& r = it.s->get(K_ref).obj();
    const Val& kind = r->get(K_kind);
    const U rn = name_text(r->get(K_name));
    if (is(kind, u"pad") || (kind.nullish() && pads.has(rn))) {
      if (!pads.erase(rn)) unknown(r, it.s);
      else
        sides.each([&](const U&, std::vector<U>& names) { names.erase(std::remove(names.begin(), names.end(), rn), names.end()); });
    } else if (is(kind, u"hole") || (kind.nullish() && holes.has(rn))) {
      if (!holes.erase(rn)) unknown(r, it.s);
    } else if (kind.nullish()) {
      unknown(r, it.s);
    } else {
      const U& k = kind.str();
      err(u"`delete` removes pads and holes, not " + (k == u"side" ? U(u"sides") : k + u"s"), r);
    }
  }
  rows.each([&](const U&, RowP& row) {
    std::vector<PadP> kept;
    for (const auto& p : row->members) {
      const PadP* cur = pads.get(p->name);
      if (cur && *cur == p) kept.push_back(p);
    }
    row->members = std::move(kept);
  });
  // per-pin leads must name a pad
  pinLeads.each([&](const U& nm, PinLead& pl) {
    if (PadP* p = pads.get(nm)) {
      (*p)->src.push_back(pl.lead->node);
      return;
    }
    bool omitted = false;
    if (gen && gen->omitted)
      for (const auto& q : *gen->omitted) omitted = omitted || q->name == nm;
    if (omitted) err(u"pin " + quote_name(nm) + u" is omitted, so it has no lead to describe", pl.sel);
    else unknown(rec({{K_kind, u"pad"}, {K_name, nm}, {K_s, pl.sel->get(K_s)}, {K_e, pl.sel->get(K_e)}}), pl.sel);
  });
  // bulk overrides
  for (const auto& it : st.padsStmts) {
    const ObjP& s = it.s;
    guard_void(s, [&] {
      for (const Val& sv : s->get(K_sel).arr()->a) {
        const ObjP& sel = sv.obj();
        for (const U& n : sel_names(sel)) {
          PadP* p = pads.get(n);
          if (!p) {
            unknown(rec({{K_kind, u"pad"}, {K_name, n}, {K_s, sel->get(K_s)}, {K_e, sel->get(K_e)}}), sel);
            continue;
          }
          (*p)->partials.push_back({s->get(K_block).arr(), s, it.level});
          (*p)->src.push_back(s);
        }
      }
    });
  }
  // order partials: inherited first, then source order
  pads.each([&](const U&, PadP& p) {
    std::stable_sort(p->partials.begin(), p->partials.end(), [](const Partial& a, const Partial& b) {
      if (a.level != b.level) return a.level < b.level;
      return a.stmt->get(K_s).num() < b.stmt->get(K_s).num();
    });
  });
  // groups
  for (const auto& it : st.groups) {
    const ObjP& s = it.s;
    const U n = name_text(s->get(K_name).obj()->get(K_name));
    if (groups.has(n) || pads.has(n) || holes.has(n) || rows.has(n)) {
      err(u"the name " + tick(n) + u" is already used — pads, holes, rows and groups share one namespace", s->get(K_name).obj());
      continue;
    }
    auto g = std::make_shared<Group>();
    g->name = n;
    g->refs = s->get(K_members).arr();
    g->node = s;
    groups.set(n, g);
  }
  for (const U& r : rows.keys()) {
    if (pads.has(r) || holes.has(r)) err(u"the name " + tick(r) + u" is already used by a pad or hole", (*rows.get(r))->node->get(K_name).obj());
  }
}

void Builder::unknown(const ObjP& r, const ObjP& node) {
  const U rn = name_text(r->get(K_name));
  if (broken.count(rn)) return;
  std::vector<U> all = pads.keys();
  for (const U& k : holes.keys()) all.push_back(k);
  for (const U& k : rows.keys()) all.push_back(k);
  for (const U& k : groups.keys()) all.push_back(k);
  const auto hint = suggest(rn, all);
  const Val& kind = r->get(K_kind);
  const U label = kind.truthy() && !is(kind, u"side")
                      ? (r->get(K_alias).truthy() ? r->get(K_alias).str() : kind.str()) + u" " + quote_name(rn)
                      : quote_name(rn);
  err(u"unknown object: " + label + (hint ? u" — did you mean " + quote_name(*hint) + u"?" : U()), !r->get(K_s).nullish() ? r : node);
}

// Geometry

void Builder::resolveGeometry() {
  pads.each([&](const U&, PadP& p) { resolvePad(p, {}); });
  holes.each([&](const U&, HoleP& h) {
    if (h->mirror) {
      HoleP* proto = holes.get(h->mirror->proto);
      bool own = false;
      for (const auto& n : h->src) own = own || is(n->get(K_type), u"Hole");
      if (proto && !own) h->shape = geom::mirror_shape((*proto)->shape, h->mirror->axis.empty() ? u'?' : h->mirror->axis[0]);
    }
    h->rot = 0;
    h->bb = bb_of(h->shape, 0);
  });
}

const Spec* Builder::resolvePad(const PadP& p, std::vector<Pad*> chain) {
  if (p->spec) return &*p->spec;
  if (std::find(chain.begin(), chain.end(), p.get()) != chain.end()) {
    U msg = u"mirror cycle: ";
    for (std::size_t i = 0; i < chain.size(); ++i) msg += (i ? u" → pad " : u"pad ") + chain[i]->name;
    msg += u" → pad " + p->name;
    err(msg, p->mirror->node);
    return nullptr;
  }
  std::optional<Spec> base;
  double sideRot = p->gen ? (js::truthy(p->gen->rot) ? p->gen->rot : 0) : 0;
  if (p->explicit_) base = clone_spec(p->explicit_->spec);
  else if (p->mirror) {
    if (PadP* proto = pads.get(p->mirror->proto)) {
      std::vector<Pad*> next = chain;
      next.push_back(p.get());
      const PadP protoP = *proto;
      if (const Spec* ps = resolvePad(protoP, next)) {
        base = clone_spec(*ps);
        base->shape = geom::mirror_shape(ps->shape, p->mirror->axis.empty() ? u'?' : p->mirror->axis[0]);
        base->rot = -((js::truthy(protoP->sideRot) ? protoP->sideRot : 0) + (js::truthy(ps->rot) ? ps->rot : 0));
        sideRot = 0;
      }
    }
  }
  if (!base && p->gen && p->gen->proto) base = clone_spec(*p->gen->proto);
  if (!base && defaultSpec) base = clone_spec(*defaultSpec);
  if (!base) {
    // the block form can give the whole geometry: `pad 1 { shape rect 1 x 2 }`
    bool shaped = false;
    for (const auto& part : p->partials)
      for (const Val& b : part.stmts->a) shaped = shaped || is(b.obj()->get(K_op), u"shape");
    const ObjP node = !p->src.empty() ? p->src[0] : decl;
    if (!shaped && !p->geomFailed && !broken.count(p->name))
      err(u"pad " + p->name + u" has no geometry — give it a shape, add `default pad …`, or describe the leads with `lead …`", node);
    Spec s;
    s.shape.kind = geom::Kind::Rect;
    s.shape.w = 0.5;
    s.shape.l = 0.5;
    s.missing = !shaped;
    base = std::move(s);
  }
  for (const auto& part : p->partials) applyBlock(*base, part.stmts, part.stmt);
  p->spec = std::move(base);
  const Spec& sp = *p->spec;
  p->sideRot = sideRot;
  p->rot = sideRot + (js::truthy(sp.rot) ? sp.rot : 0);
  p->bb = bb_of(sp.shape, p->rot);
  if (sp.drill) {
    const double d0 = sp.drill->d ? *sp.drill->d : sp.drill->slotW;
    const double d1 = sp.drill->d ? *sp.drill->d : sp.drill->slotL;
    const geom::Shape& sh = sp.shape;
    const double pw = sh.kind == geom::Kind::Circle ? sh.d : sh.w, pl = sh.kind == geom::Kind::Circle ? sh.d : sh.l;
    const bool hasPw = sh.kind != geom::Kind::Polygon;   // a polygon has no width
    if (hasPw && (d0 >= pw - 1e-9 || d1 >= pl - 1e-9))
      warn(u"pad " + p->name + u": the drill is as large as the pad — no annular ring", !p->src.empty() ? p->src.back() : decl);
  }
  return &*p->spec;
}

}  // namespace stomp::compiler
