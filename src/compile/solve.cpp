// The solver (SPEC 9; compile.js 1848-2414). Each pad, hole, row, the body and the origin
// is a unit with one variable per axis; each placement sets one variable from others.
#include <algorithm>
#include <cmath>
#include <limits>

#include "../jsrt.hpp"
#include "../suggest.hpp"
#include "builder.hpp"

namespace stomp::compiler {

namespace {
constexpr double INF = std::numeric_limits<double>::infinity();
U name_text(const Val& n) { return n.is_str() ? n.str() : n.is_num() ? num_text(n.num()) : n.null() ? U(u"null") : U(u"undefined"); }
bool contains(const std::vector<int>& v, int x) { return std::find(v.begin(), v.end(), x) != v.end(); }
std::vector<int> unique(std::vector<int> v) {
  std::vector<int> out;
  for (int x : v)
    if (!contains(out, x)) out.push_back(x);
  return out;
}
U axis_text(char16_t a) { return U(1, a); }
U con_key(int unit, char16_t axis) { return num_text(unit) + u":" + axis_text(axis); }
}  // namespace

Con& Builder::add(Con c) {
  cons.push_back(std::move(c));
  return cons.back();
}

void Builder::solve() {
  units.clear();
  const auto mk = [&](V kind, U label) {
    auto u = std::make_shared<Unit>();
    u->id = static_cast<int>(units.size());
    u->kind = U(kind);
    u->label = std::move(label);
    units.push_back(u);
    return u.get();
  };
  bodyUnit = body ? mk(u"body", u"body") : nullptr;
  originUnit = mk(u"origin", u"origin");
  // rows: rigid units
  std::unordered_map<const Pad*, Row*> rowOf;
  rows.each([&](const U&, RowP& row) {
    Unit* u = mk(u"row", u"row " + row->name);
    u->row = row;
    row->unit = u;
    double dx = 0, dy = 0;
    if (row->going == u"right") dx = 1;
    else if (row->going == u"left") dx = -1;
    else if (row->going == u"up") dy = 1;
    else if (row->going == u"down") dy = -1;
    else dx = dy = NAN;
    for (std::size_t i = 0; i < row->members.size(); ++i) {
      const PadP& p = row->members[i];
      if (auto it = rowOf.find(p.get()); it != rowOf.end()) {
        err(u"pad " + p->name + u" is in two rows (" + it->second->name + u" and " + row->name + u")", row->node);
        continue;
      }
      rowOf[p.get()] = row.get();
      p->unit = u;
      p->off = {dx * static_cast<double>(i) * row->pitch, dy * static_cast<double>(i) * row->pitch};
    }
    BB bb{{INF, -INF}, {INF, -INF}};
    for (const auto& p : row->members) {
      if (p->unit != u) continue;
      for (char16_t a : {u'x', u'y'}) {
        bb[a].lo = js::min(bb[a].lo, p->off[a] + p->bb[a].lo);
        bb[a].hi = js::max(bb[a].hi, p->off[a] + p->bb[a].hi);
      }
    }
    row->bb = bb;
  });
  pads.each([&](const U&, PadP& p) {
    if (!p->unit) {
      Unit* u = mk(u"pad", u"pad " + p->name);
      u->pad = p;
      p->unit = u;
      p->off = {};
    }
  });
  holes.each([&](const U&, HoleP& h) {
    Unit* u = mk(u"hole", u"hole " + h->name);
    u->hole = h;
    h->unit = u;
    h->off = {};
  });

  cons.clear();
  originUsed = false;
  // generator defaults are weak and absolute, so explicit placements win
  pads.each([&](const U&, PadP& p) {
    if (!p->gen) return;
    for (char16_t a : {u'x', u'y'}) {
      Con c;
      c.unit = p->unit->id;
      c.axis = a;
      c.strength = u"gen";
      c.level = -1;
      c.node = p->src.empty() ? nullptr : p->src[0];
      if (p->gen->thermal && bodyUnit) {
        const int bu = bodyUnit->id;
        const double off = p->off[a];
        c.deps = {bu};
        c.abs = false;
        c.f = [bu, off](const Vals& v) { return v[bu] - off; };
        c.label = p->unit->label + u" (centred on body)";
      } else {
        const double g = (a == u'x' ? p->gen->x : p->gen->y) - p->off[a];
        c.abs = true;
        c.f = [g](const Vals&) { return g; };
        c.label = p->unit->label + u" (generated)";
      }
      add(std::move(c));
    }
  });
  if (bodyUnit && gen) {
    for (char16_t a : {u'x', u'y'}) {
      Con c;
      c.unit = bodyUnit->id;
      c.axis = a;
      c.strength = u"gen";
      c.level = -1;
      c.abs = true;
      c.f = [](const Vals&) { return 0.0; };
      c.node = body->node;
      c.label = u"body (generator centre)";
      add(std::move(c));
    }
  }
  // explicit placements; a statement that fails still "claims" its target, so the target
  // isn't also reported as under-constrained
  for (const auto& it : st.places) {
    const std::size_t before = cons.size();
    guard_void(it.s, [&] { constrain(it); });
    if (!is(it.s->get(K_type), u"MeasurePair") && cons.size() == before) {
      const Val& tv = it.s->get(K_target).truthy() ? it.s->get(K_target) : it.s->get(K_a);
      if (tv.truthy()) {
        const ObjP& t = tv.obj();
        if (!t->get(K_name).nullish()) broken.insert(name_text(t->get(K_name)));
        if (is(t->get(K_kind), u"body")) broken.insert(u"#body");
      }
    }
  }
  // measure statements: decide which side they place
  resolveMeasures();
  // origin, when something measures from it
  if (originUsed) constrainOrigin();
  solveAxes();
}

Info Builder::padInfo(const PadP& p) {
  Info i;
  i.type = Info::Single;
  i.unit = p->unit;
  i.off = p->off;
  i.bb = p->bb;
  i.label = u"pad " + p->name;
  i.pad = p;
  return i;
}

Info Builder::info(const ObjP& r, const ObjP&) {
  const Val& kind = r->get(K_kind);
  if (is(kind, u"origin")) {
    originUsed = true;
    Info i;
    i.unit = originUnit;
    i.label = u"origin";
    return i;
  }
  if (is(kind, u"body")) {
    if (!body) throw StompError(u"there is no `body` to refer to — add `body W x L`", r);
    Info i;
    i.unit = bodyUnit;
    i.bb = bb_of_body(*body);
    i.label = u"body";
    return i;
  }
  const U n = name_text(r->get(K_name));
  if (is(kind, u"side")) {
    const std::vector<U>* names = sides.get(n);
    if (!names || names->empty())
      throw StompError(u"there is no `side " + n + u"` — sides come from `pins … dual/quad/single` and side blocks", r);
    Info i;
    i.type = Info::Set;
    i.label = u"side " + n;
    for (const U& m : *names) i.members.push_back(padInfo(*pads.get(m)));
    return i;
  }
  const bool any = kind.nullish();
  if ((is(kind, u"pad") || any) && pads.has(n)) return padInfo(*pads.get(n));
  if ((is(kind, u"hole") || any) && holes.has(n)) {
    const HoleP& h = *holes.get(n);
    Info i;
    i.unit = h->unit;
    i.off = h->off;
    i.bb = h->bb;
    i.label = u"hole " + n;
    i.hole = h;
    return i;
  }
  if ((is(kind, u"row") || any) && rows.has(n)) {
    const RowP& row = *rows.get(n);
    Info i;
    i.type = Info::RowT;
    i.unit = row->unit;
    i.bb = row->bb;
    i.label = u"row " + n;
    i.row = row;
    return i;
  }
  if ((is(kind, u"group") || any) && groups.has(n)) return groupInfo(*groups.get(n), {});
  // wrong kind keyword?
  const char16_t* actual = pads.has(n) ? u"pad" : holes.has(n) ? u"hole" : rows.has(n) ? u"row" : groups.has(n) ? u"group" : nullptr;
  const U alias = r->get(K_alias).truthy() ? r->get(K_alias).str() : kind.truthy() ? kind.str() : U(u"undefined");
  if (actual) throw StompError(tick(n) + u" is a " + actual + u", not a " + alias, r);
  if (broken.count(n)) throw silent(r);
  std::vector<U> all = pads.keys();
  for (const U& k : holes.keys()) all.push_back(k);
  for (const U& k : rows.keys()) all.push_back(k);
  for (const U& k : groups.keys()) all.push_back(k);
  const auto hint = suggest(n, all);
  throw StompError(u"unknown object: " + (kind.truthy() ? alias + u" " : U()) + quote_name(n) + (hint ? u" — did you mean " + quote_name(*hint) + u"?" : U()), r);
}

Info Builder::groupInfo(const GroupP& g, std::vector<Group*> chain) {
  if (std::find(chain.begin(), chain.end(), g.get()) != chain.end()) throw StompError(u"group " + g->name + u" contains itself", g->node);
  Info out;
  out.type = Info::Set;
  out.label = u"group " + g->name;
  for (const Val& rv : g->refs->a) {
    const ObjP& r = rv.obj();
    const Val& kind = r->get(K_kind);
    const U rn = name_text(r->get(K_name));
    const bool named = !r->get(K_name).nullish();
    if (is(kind, u"group") || (kind.nullish() && named && groups.has(rn) && !pads.has(rn))) {
      const GroupP* sub = groups.get(rn);
      if (!sub) throw StompError(u"unknown group " + rn, r);
      std::vector<Group*> next = chain;
      next.push_back(g.get());
      out.members.push_back(groupInfo(*sub, next));
    } else {
      out.members.push_back(info(r, g->node));
    }
  }
  return out;
}

/** Coordinate of an anchor ('center' | 'lo' | 'hi') as a function of solved unit values. */
Anchor Builder::anchor(const Info& inf, char16_t axis, const U& w) {
  if (inf.type == Info::Single) {
    const int u = inf.unit->id;
    const double k = inf.off[axis] + (w == u"center" ? 0 : w == u"lo" ? inf.bb[axis].lo : inf.bb[axis].hi);
    return {{u}, [u, k](const Vals& v) { return v[u] + k; }};
  }
  if (inf.type == Info::RowT) {
    const int u = inf.unit->id;
    const Span1 bb = inf.bb[axis];
    const double k = w == u"center" ? (bb.lo + bb.hi) / 2 : w == u"lo" ? bb.lo : bb.hi;
    return {{u}, [u, k](const Vals& v) { return v[u] + k; }};
  }
  struct Part {
    Anchor lo, hi;
  };
  auto parts = std::make_shared<std::vector<Part>>();
  std::vector<int> deps;
  for (const Info& m : inf.members) {
    parts->push_back({anchor(m, axis, u"lo"), anchor(m, axis, u"hi")});
    for (int d : parts->back().lo.deps) deps.push_back(d);
  }
  const int mode = w == u"center" ? 0 : w == u"lo" ? 1 : 2;
  return {unique(deps), [parts, mode](const Vals& v) {
            double lo = INF, hi = -INF;
            for (const auto& p : *parts) {
              lo = js::min(lo, p.lo.f(v));
              hi = js::max(hi, p.hi.f(v));
            }
            return mode == 0 ? (lo + hi) / 2 : mode == 1 ? lo : hi;
          }};
}

/** Offset of an anchor from the target unit's variable. */
double Builder::toff(const Info& inf, char16_t axis, const U& w) const {
  if (inf.type == Info::Single) return inf.off[axis] + (w == u"center" ? 0 : w == u"lo" ? inf.bb[axis].lo : inf.bb[axis].hi);
  const Span1 bb = inf.bb[axis];
  return w == u"center" ? (bb.lo + bb.hi) / 2 : w == u"lo" ? bb.lo : bb.hi;
}

/** Map an anchor word to lo, hi or center on an axis. s is the relation's sign: +1, -1 or 0. */
U Builder::which(const ObjP& ref, char16_t axis, double s, V role) {
  const U a = ref->get(K_anchor).truthy() ? ref->get(K_anchor).str() : U(u"center");
  if (a == u"center") return u"center";
  if (a == u"inner" || a == u"outer") {
    if (!js::truthy(s))
      throw StompError(tick(a) + u" is measured toward/away from another object, so it only works in `is … of` relations", ref);
    return (a == u"inner") == (role == u"ref") ? (s > 0 ? u"hi" : u"lo") : (s > 0 ? u"lo" : u"hi");
  }
  if (a == u"left" || a == u"right") {
    if (axis != u'x')
      throw StompError(u"anchor " + tick(a) + u" is a horizontal edge, but this measurement is vertical — use `top`, `bottom`, `inner` or `outer`", ref);
    return a == u"left" ? u"lo" : u"hi";
  }
  if (axis != u'y')
    throw StompError(u"anchor " + tick(a) + u" is a vertical edge, but this measurement is horizontal — use `left`, `right`, `inner` or `outer`", ref);
  return a == u"bottom" ? u"lo" : u"hi";
}

/** `at`/`align`/`centered` use only absolute anchors, on their own axis. */
U Builder::whichStatic(const ObjP& ref, char16_t axis) {
  const Val& av = ref->get(K_anchor);
  if (!av.truthy() || is(av, u"center")) return u"center";
  const U& a = av.str();
  if (a == u"inner" || a == u"outer") return which(ref, axis, 0, u"target");
  if ((a == u"left" || a == u"right") && axis == u'x') return a == u"left" ? u"lo" : u"hi";
  if ((a == u"top" || a == u"bottom") && axis == u'y') return a == u"bottom" ? u"lo" : u"hi";
  return u"center";
}

Info Builder::target(const ObjP& r) {
  if (is(r->get(K_kind), u"origin")) throw StompError(u"`origin` is moved with an `origin` statement, not placed like an object", r);
  Info inf = info(r);
  if (inf.type == Info::Set)
    throw StompError(inf.label + u" can't be placed — groups and sides only provide a bounding box to measure against; place their members instead", r);
  if (inf.unit == originUnit) throw StompError(u"`origin` is moved with an `origin` statement, not placed like an object", r);
  return inf;
}

void Builder::constrain(const Item& it) {
  const ObjP& s = it.s;
  const double level = it.level;
  const U& type = s->get(K_type).str();
  const auto strong = [&](int unit, char16_t axis) {
    Con c;
    c.level = level;
    c.node = s;
    c.unit = unit;
    c.axis = axis;
    c.strength = u"strong";
    return c;
  };
  if (type == u"At") {
    const ObjP& tgt = s->get(K_target).obj();
    const Info ti = target(tgt);
    const ObjP& point = s->get(K_point).obj();
    const double px = len(point->get(K_x), s), py = len(point->get(K_y), s);
    for (char16_t a : {u'x', u'y'}) {
      const double k = toff(ti, a, whichStatic(tgt, a));
      const double P = a == u'x' ? px : py;
      Con c = strong(ti.unit->id, a);
      c.abs = true;
      c.f = [P, k](const Vals&) { return P - k; };
      c.label = ti.label + u" at (" + fmt_mm(px) + u", " + fmt_mm(py) + u")";
      Viz v;
      v.kind = u"at";
      v.px = px;
      v.py = py;
      v.ti = ti;
      v.which = whichStatic(tgt, a);
      c.viz = std::move(v);
      add(std::move(c));
    }
    return;
  }
  if (type == u"Is") {
    const ObjP& tgt = s->get(K_target).obj();
    const Info ti = target(tgt);
    for (const Val& clv : s->get(K_clauses).arr()->a) {
      const ObjP& cl = clv.obj();
      guard_void(cl, [&] {
        const U& dir = cl->get(K_dir).str();
        const char16_t axis = dir == u"left" || dir == u"right" ? u'x' : u'y';
        const double sg = dir == u"right" || dir == u"above" ? 1 : -1;
        const double d = len(cl->get(K_dist), s);
        const ObjP& ref = cl->get(K_ref).obj();
        const Info ri = info(ref);
        const U rw = which(ref, axis, sg, u"ref");
        const U tw = which(tgt, axis, sg, u"target");
        const Anchor RA = anchor(ri, axis, rw);
        if (contains(RA.deps, ti.unit->id)) {
          throw StompError(ri.unit == ti.unit && ri.type != Info::Set
                               ? (ti.unit->kind == u"row" ? ti.label + u" and " + ri.label + u" move together as one row; their spacing comes from the row's pitch"
                                                          : ti.label + u" can't be placed relative to itself")
                               : ti.label + u" can't be placed relative to a group that contains it",
                           cl);
        }
        const double k = toff(ti, axis, tw);
        const U text = text_of(src, cl->get(K_dist));
        Con c = strong(ti.unit->id, axis);
        c.deps = RA.deps;
        c.abs = false;
        c.f = [f = RA.f, sg, d, k](const Vals& v) { return f(v) + sg * d - k; };
        c.clause = cl;
        c.label = ti.label + (tgt->get(K_anchor).truthy() ? u" " + tgt->get(K_anchor).str() : U()) + u" is " + text + u" " + dir +
                  (dir == u"left" || dir == u"right" ? U(u" of") : U()) + u" " + ri.label +
                  (ref->get(K_anchor).truthy() ? u" " + ref->get(K_anchor).str() : U());
        Viz v;
        v.kind = u"dim";
        v.axis = axis;
        v.ri = ri;
        v.rw = rw;
        v.ti = ti;
        v.tw = tw;
        v.d = d;
        v.sg = sg;
        v.text = text;
        v.plain = is(cl->get(K_dist).obj()->get(K_type), u"num");
        c.viz = std::move(v);
        add(std::move(c));
        // weak alignment on the other axis, center to center (SPEC 9.2)
        const char16_t o = other(axis);
        const Anchor RC = anchor(ri, o, u"center");
        const double kc = toff(ti, o, u"center");
        Con w;
        w.unit = ti.unit->id;
        w.axis = o;
        w.strength = u"weak";
        w.level = level;
        w.deps = RC.deps;
        w.abs = false;
        w.f = [f = RC.f, kc](const Vals& vs) { return f(vs) - kc; };
        w.node = s;
        w.label = ti.label + u" (aligned with " + ri.label + u")";
        add(std::move(w));
      });
    }
    return;
  }
  if (type == u"Centered") {
    const ObjP& tgt = s->get(K_target).obj();
    const Info ti = target(tgt);
    const Val& ax = s->get(K_axis);
    std::vector<char16_t> axes = is(ax, u"horizontally") ? std::vector<char16_t>{u'x'} : is(ax, u"vertically") ? std::vector<char16_t>{u'y'}
                                                                                                                : std::vector<char16_t>{u'x', u'y'};
    if (tgt->get(K_anchor).truthy() && !is(tgt->get(K_anchor), u"center"))
      throw StompError(u"`centered` places the object's centre; drop the anchor", tgt);
    for (char16_t a : axes) {
      const double k = toff(ti, a, u"center");
      if (s->get(K_between).truthy()) {
        const auto& btw = s->get(K_between).arr()->a;
        const Anchor A = anchor(info(btw[0].obj()), a, u"center");
        const Anchor B = anchor(info(btw[1].obj()), a, u"center");
        std::vector<int> deps = A.deps;
        deps.insert(deps.end(), B.deps.begin(), B.deps.end());
        deps = unique(deps);
        if (contains(deps, ti.unit->id)) throw StompError(ti.label + u" can't be centred between objects that move with it", s);
        Con c = strong(ti.unit->id, a);
        c.deps = deps;
        c.abs = false;
        c.f = [fa = A.f, fb = B.f, k](const Vals& v) { return (fa(v) + fb(v)) / 2 - k; };
        c.label = ti.label + u" centred between " + info(btw[0].obj()).label + u" and " + info(btw[1].obj()).label;
        Viz v;
        v.kind = u"between";
        v.axis = a;
        v.ai = info(btw[0].obj());
        v.bi = info(btw[1].obj());
        v.ti = ti;
        c.viz = std::move(v);
        add(std::move(c));
      } else {
        const Info oi = info(s->get(K_on).obj());
        const Anchor O_ = anchor(oi, a, u"center");
        if (contains(O_.deps, ti.unit->id)) throw StompError(ti.label + u" can't be centred on something that moves with it", s);
        Con c = strong(ti.unit->id, a);
        c.deps = O_.deps;
        c.abs = false;
        c.f = [f = O_.f, k](const Vals& v) { return f(v) - k; };
        c.label = ti.label + u" centred on " + oi.label;
        Viz v;
        v.kind = u"on";
        v.axis = a;
        v.oi = oi;
        v.ti = ti;
        c.viz = std::move(v);
        add(std::move(c));
      }
    }
    return;
  }
  if (type == u"Align") {
    const ObjP& sa = s->get(K_a).obj();
    const ObjP& sb = s->get(K_b).obj();
    const Info ti = target(sa);
    const char16_t a = is(s->get(K_axis), u"horizontally") ? u'y' : u'x';
    const Info bi = info(sb);
    const Anchor B = anchor(bi, a, whichStatic(sb, a));
    if (contains(B.deps, ti.unit->id)) throw StompError(ti.label + u" is already rigidly tied to " + bi.label, s);
    const double k = toff(ti, a, whichStatic(sa, a));
    Con c = strong(ti.unit->id, a);
    c.deps = B.deps;
    c.abs = false;
    c.f = [f = B.f, k](const Vals& v) { return f(v) - k; };
    c.label = ti.label + u" aligned " + s->get(K_axis).str() + u" with " + bi.label;
    Viz v;
    v.kind = u"align";
    v.axis = a;
    v.ti = ti;
    v.bi = bi;
    c.viz = std::move(v);
    add(std::move(c));
    return;
  }
  if (type == u"Mirrors") {
    const ObjP& sp = s->get(K_proto).obj();
    const ObjP& stg = s->get(K_target).obj();
    const Info pi = info(sp);
    const Info ti = target(stg);
    if (pi.type != Info::Single || !pi.has_obj()) throw StompError(u"`mirrors` works between pads or holes", sp);
    if (ti.type != Info::Single || !ti.has_obj()) throw StompError(u"`mirrors` works between pads or holes", stg);
    if (pi.unit == ti.unit) throw StompError(u"an object can't mirror itself", s);
    const U& sax = s->get(K_axis).str();
    const char16_t m = sax == u"y" ? u'x' : u'y';   // across y flips x
    for (char16_t a : {u'x', u'y'}) {
      const Anchor P = anchor(pi, a, u"center");
      const double k = toff(ti, a, u"center");
      const bool flip = a == m;
      Con c = strong(ti.unit->id, a);
      c.deps = P.deps;
      c.abs = flip;
      if (flip) c.f = [f = P.f, k](const Vals& v) { return -f(v) - k; };
      else c.f = [f = P.f, k](const Vals& v) { return f(v) - k; };
      c.label = ti.label + u" mirrors " + pi.label + u" across " + sax;
      c.mirror = MirrorCon{pi, ti, sax};
      if (flip) {
        Viz v;
        v.kind = u"mirror";
        v.axis = m;
        v.pi = pi;
        v.ti = ti;
        c.viz = std::move(v);
      }
      add(std::move(c));
    }
    return;
  }
}

void Builder::resolveMeasures() {
  struct Count {
    double level;
    int n;
    ObjP node;
  };
  OrderedMap<U, Count> count;
  for (const Con& c : cons) {
    if (c.strength != u"strong") continue;
    const U k = con_key(c.unit, c.axis);
    Count* prev = count.get(k);
    if (!prev || prev->level < c.level) count.set(k, {c.level, 1, c.node});
    else if (prev->level == c.level) prev->n++;
  }
  const auto strongAt = [&](int u, char16_t a, double level) -> const Count* {
    const Count* p = count.get(con_key(u, a));
    return p && p->level >= level ? p : nullptr;
  };
  for (const auto& it : st.places) {
    const ObjP& s = it.s;
    if (!is(s->get(K_type), u"MeasurePair")) continue;
    guard_void(s, [&] {
      const ObjP& sa = s->get(K_a).obj();
      const ObjP& sb = s->get(K_b).obj();
      const Info ai = info(sa), bi = info(sb);
      const U& word = s->get(K_word).str();
      if (sa->get(K_anchor).truthy() || sb->get(K_anchor).truthy()) {
        const U anc = sa->get(K_anchor).truthy() ? sa->get(K_anchor).str() : sb->get(K_anchor).str();
        throw StompError(tick(word) + u" decides the anchors itself (span: outer edges, gap: facing edges, pitch: centres) — drop " + tick(anc),
                         sa->get(K_anchor).truthy() ? sa : sb);
      }
      // a mirror pair between the two?
      const Con* mir = nullptr;
      for (const Con& c : cons) {
        if (!c.mirror || !c.viz) continue;
        if ((c.mirror->pi.unit == ai.unit && c.mirror->ti.unit == bi.unit) || (c.mirror->pi.unit == bi.unit && c.mirror->ti.unit == ai.unit)) {
          mir = &c;
          break;
        }
      }
      const Val& sax = s->get(K_axis);
      std::optional<char16_t> axis;
      if (is(sax, u"horizontally")) axis = u'x';
      else if (is(sax, u"vertically")) axis = u'y';
      if (!axis && mir) axis = mir->viz->axis;
      if (!axis) {
        for (const Con& c : cons) {
          if (!c.viz || c.viz->kind != u"align") continue;
          if ((c.viz->ti.unit == ai.unit && c.viz->bi.unit == bi.unit) || (c.viz->ti.unit == bi.unit && c.viz->bi.unit == ai.unit)) {
            axis = other(c.axis);
            break;
          }
        }
      }
      if (!axis) throw StompError(u"can't tell which way " + tick(word) + u" measures — append `horizontally` or `vertically`", s);
      const char16_t ax = *axis;
      const double d = len(s->get(K_x), s);
      const U text = text_of(src, s->get(K_x));
      const bool plain = is(s->get(K_x).obj()->get(K_type), u"num");
      if (mir && mir->viz->axis == ax) {
        // symmetric: the prototype takes -x (mirrored across y) or +y (across x). See SPEC 9.4.
        const Info proto = mir->mirror->pi, tgt = mir->mirror->ti;
        if (const Count* prev = strongAt(proto.unit->id, ax, it.level)) {
          throw StompError(proto.label + u" is already placed on " + axis_text(ax) + u" (and " + tgt.label + u" mirrors it), so this " + word +
                               u" over-constrains the pair",
                           s, {{u"placed here", prev->node}});
        }
        const double sgn = mir->mirror->axis == u"y" ? -1 : 1;   // side the prototype takes
        const Span1 pb = proto.bb[ax], tb = tgt.bb[ax];
        const double po = proto.off[ax];
        // the measured length for prototype coordinate c, with the mirror at -c
        const auto meas = [&](double c) {
          const double t = -c;
          struct E {
            double lo, hi, c;
          };
          const E P{c + pb.lo, c + pb.hi, c};
          const E T{t + tb.lo, t + tb.hi, t};
          const E& lowObj = sgn < 0 ? P : T;
          const E& highObj = sgn < 0 ? T : P;
          if (word == u"pitch") return highObj.c - lowObj.c;
          if (word == u"gap") return highObj.lo - lowObj.hi;
          return highObj.hi - lowObj.lo;
        };
        const double m0 = meas(0), m1 = meas(1);
        const double slope = m1 - m0;
        const double c = (d - m0) / slope;
        Con con;
        con.unit = proto.unit->id;
        con.axis = ax;
        con.strength = u"strong";
        con.level = it.level;
        con.abs = true;
        con.f = [c, po](const Vals&) { return c - po; };
        con.node = s;
        con.label = word + u" " + proto.label + u" to " + tgt.label + u" is " + text;
        Viz v;
        v.kind = u"measure";
        v.word = word;
        v.axis = ax;
        v.ai = proto;
        v.bi = tgt;
        v.d = d;
        v.text = text;
        v.plain = plain;
        con.viz = std::move(v);
        add(std::move(con));
        count.set(con_key(proto.unit->id, ax), {static_cast<double>(it.level), 1, s});
        return;
      }
      // ordinary pair: B on the + side of A by default; place whichever is still free
      const Info* tgtInf;
      const Info* refInf;
      double sg;
      if (!strongAt(bi.unit->id, ax, it.level)) {
        tgtInf = &bi;
        refInf = &ai;
        sg = 1;
      } else if (!strongAt(ai.unit->id, ax, it.level)) {
        tgtInf = &ai;
        refInf = &bi;
        sg = -1;
      } else {
        const Count* pa = strongAt(ai.unit->id, ax, it.level);
        const Count* pb = strongAt(bi.unit->id, ax, it.level);
        throw StompError(u"both " + ai.label + u" and " + bi.label + u" are already placed on " + axis_text(ax) + u", so this " + word +
                             u" over-constrains them",
                         s, {{ai.label + u" placed here", pa->node}, {bi.label + u" placed here", pb->node}});
      }
      if (tgtInf->type == Info::Set) throw StompError(tgtInf->label + u" can't be placed; measure to one of its members", s);
      const U wR = word == u"pitch" ? U(u"center") : word == u"gap" ? U(sg > 0 ? u"hi" : u"lo") : U(sg > 0 ? u"lo" : u"hi");
      const U wT = word == u"pitch" ? U(u"center") : word == u"gap" ? U(sg > 0 ? u"lo" : u"hi") : U(sg > 0 ? u"hi" : u"lo");
      const Anchor RA = anchor(*refInf, ax, wR);
      if (contains(RA.deps, tgtInf->unit->id)) throw StompError(ai.label + u" and " + bi.label + u" move together; their distance is already fixed", s);
      const double k = toff(*tgtInf, ax, wT);
      Con con;
      con.unit = tgtInf->unit->id;
      con.axis = ax;
      con.strength = u"strong";
      con.level = it.level;
      con.deps = RA.deps;
      con.abs = false;
      con.f = [f = RA.f, sg, d, k](const Vals& v) { return f(v) + sg * d - k; };
      con.node = s;
      con.label = word + u" " + ai.label + u" to " + bi.label + u" is " + text;
      Viz v;
      v.kind = u"measure";
      v.word = word;
      v.axis = ax;
      v.ai = ai;
      v.bi = bi;
      v.d = d;
      v.text = text;
      v.plain = plain;
      con.viz = std::move(v);
      const int tu = tgtInf->unit->id;
      add(std::move(con));
      count.set(con_key(tu, ax), {static_cast<double>(it.level), 1, s});
    });
  }
}

void Builder::constrainOrigin() {
  const int u = originUnit->id;
  const auto mk = [&](char16_t a, double level, ObjP node, U label) {
    Con c;
    c.unit = u;
    c.axis = a;
    c.strength = u"strong";
    c.level = level;
    c.node = std::move(node);
    c.label = std::move(label);
    return c;
  };
  if (!st.origin) {
    for (char16_t a : {u'x', u'y'}) {
      Con c = mk(a, 0, decl, u"origin");
      c.abs = true;
      c.f = [](const Vals&) { return 0.0; };
      add(std::move(c));
    }
    return;
  }
  const ObjP s = st.origin->s;
  const double level = st.origin->level;
  guard_void(s, [&] {
    if (s->get(K_point).truthy()) {
      const ObjP& point = s->get(K_point).obj();
      const double px = len(point->get(K_x), s), py = len(point->get(K_y), s);
      for (char16_t a : {u'x', u'y'}) {
        Con c = mk(a, level, s, u"origin");
        c.abs = true;
        const double P = a == u'x' ? px : py;
        c.f = [P](const Vals&) { return P; };
        add(std::move(c));
      }
    } else if (s->get(K_ref).truthy()) {
      const ObjP& ref = s->get(K_ref).obj();
      const Info inf = info(ref);
      for (char16_t a : {u'x', u'y'}) {
        const Anchor A = anchor(inf, a, whichStatic(ref, a));
        Con c = mk(a, level, s, u"origin at " + inf.label);
        c.deps = A.deps;
        c.abs = false;
        c.f = A.f;
        add(std::move(c));
      }
    } else {
      const auto& btw = s->get(K_between).arr()->a;
      const Info A0 = info(btw[0].obj()), B0 = info(btw[1].obj());
      for (char16_t a : {u'x', u'y'}) {
        const Anchor A = anchor(A0, a, u"center"), B = anchor(B0, a, u"center");
        std::vector<int> deps = A.deps;
        deps.insert(deps.end(), B.deps.begin(), B.deps.end());
        Con c = mk(a, level, s, u"origin");
        c.deps = unique(deps);
        c.abs = false;
        c.f = [fa = A.f, fb = B.f](const Vals& v) { return (fa(v) + fb(v)) / 2; };
        add(std::move(c));
      }
    }
  });
}

void Builder::solveAxes() {
  OrderedMap<U, std::vector<Con*>> byVar;
  for (Con& c : cons) {
    const U k = con_key(c.unit, c.axis);
    if (!byVar.has(k)) byVar.set(k, {});
    byVar.get(k)->push_back(&c);
  }
  chosen.clear();
  byVar.each([&](const U& k, std::vector<Con*>& list) {
    std::vector<Con*> strong;
    for (Con* c : list)
      if (c->strength == u"strong") strong.push_back(c);
    if (!strong.empty()) {
      double top = -INF;
      for (Con* c : strong) top = js::max(top, c->level);
      std::vector<Con*> tops;
      for (Con* c : strong)
        if (c->level == top) tops.push_back(c);
      const auto sOf = [](const Con* c) {
        const Val& s = c->node ? c->node->get(K_s) : Val();
        return s.is_num() && js::truthy(s.num()) ? s.num() : 0.0;
      };
      std::stable_sort(tops.begin(), tops.end(), [&](const Con* a, const Con* b) { return sOf(a) < sOf(b); });
      chosen.set(k, tops[0]);
      for (std::size_t i = 1; i < tops.size(); ++i) {
        const Con* extra = tops[i];
        const Unit& u = *units[extra->unit];
        err(u.label + u": its " + axis_text(extra->axis) + u" position is already set by `" + stmtText(tops[0]->node) + u"` (line " +
                num_text(lineAt(tops[0]->node->get(K_s).num())) + u") — each axis takes exactly one placement (over-constrained)",
            extra->clause ? extra->clause : extra->node, {{axis_text(extra->axis) + u" first set here", tops[0]->clause ? tops[0]->clause : tops[0]->node}});
      }
    } else {
      Con* w = nullptr;
      for (Con* c : list)
        if (c->strength == u"weak") { w = c; break; }
      if (!w)
        for (Con* c : list)
          if (c->strength == u"gen") { w = c; break; }
      if (w) chosen.set(k, w);
    }
  });
  vals[0].assign(units.size(), 0);
  vals[1].assign(units.size(), 0);
  unplaced.clear();
  floatX = floatY = false;
  under.clear();
  cycles.clear();
  solveAxis(u'x');
  solveAxis(u'y');
  under.each([&](const int& u, Under& inf) {
    const Unit& unit = *units[u];
    std::optional<U> nm;
    if (unit.kind == u"body") nm = u"#body";
    else if (unit.pad) nm = unit.pad->name;
    else if (unit.hole) nm = unit.hole->name;
    else if (unit.row) nm = unit.row->name;
    if (nm && broken.count(*nm)) return;
    U axes;
    for (std::size_t i = 0; i < inf.axes.size(); ++i) axes += (i ? U(u" and ") : U()) + axis_text(inf.axes[i]);
    ObjP node;
    if (const auto* s = unit.src(); s && !s->empty() && (*s)[0]) node = (*s)[0];
    else if (unit.row && unit.row->node) node = unit.row->node;
    else node = unit.kind == u"body" && body ? body->node : decl;
    if (inf.why) {
      err(unit.label + u" and the objects placed from it float free of the rest of the footprint on " + axes + u" — tie " + unit.label +
              u" to something already placed (under-constrained)",
          node);
      return;
    }
    const U how = inf.axes.size() > 1 ? U(u"`at (x, y)`, a relation (`is … right of …`) or `centered …`")
                  : inf.axes[0] == u'x'
                      ? U(u"`at`, `is … left of / right of …`, `centered … horizontally` or `align … vertically`")
                      : U(u"`at`, `is … above / below …`, `centered … vertically` or `align … horizontally`");
    err(unit.label + u" has no " + axes + u" position — place it with " + how + u" (under-constrained)", node);
  });
  struct Merged {
    std::vector<int> units;
    std::vector<ObjP> nodes;
    std::vector<char16_t> axes;
  };
  OrderedMap<U, Merged> merged;
  for (const Cycle& c : cycles) {
    U k;
    for (std::size_t i = 0; i < c.units.size(); ++i) k += (i ? U(u",") : U()) + num_text(c.units[i]);
    if (Merged* m = merged.get(k)) m->axes.push_back(c.axis);
    else merged.set(k, {c.units, c.nodes, {c.axis}});
  }
  merged.each([&](const U&, Merged& c) {
    U axes, names;
    for (std::size_t i = 0; i < c.axes.size(); ++i) axes += (i ? U(u" and ") : U()) + axis_text(c.axes[i]);
    for (std::size_t i = 0; i < c.units.size(); ++i) names += (i ? U(u", ") : U()) + units[c.units[i]]->label;
    Rels rel;
    for (std::size_t i = 1; i < c.nodes.size(); ++i) rel.push_back({u"part of the cycle", c.nodes[i]});
    err(u"circular placement on " + axes + u": " + names + u" each depend on another — place one of them from a fixed point to break the cycle",
        c.nodes.empty() ? nullptr : c.nodes[0], rel);
  });
}

void Builder::solveAxis(char16_t axis) {
  const auto chosenOf = [&](int u) -> Con* {
    Con* const* c = chosen.get(con_key(u, axis));
    return c ? *c : nullptr;
  };
  std::unordered_set<int> depended;
  chosen.each([&](const U&, Con*& c) {
    if (c->axis == axis)
      for (int d : c->deps) depended.insert(d);
  });
  // which units take part
  std::vector<int> vars;
  for (const auto& u : units) {
    bool in;
    if (u->kind == u"origin") in = originUsed;
    else if (u->kind == u"body") in = chosenOf(u->id) || depended.count(u->id);
    else if (u->kind == u"row") {
      in = false;
      for (const auto& p : u->row->members) in = in || p->unit == u.get();
    } else in = true;
    if (in) vars.push_back(u->id);
  }
  std::unordered_set<int> inVars(vars.begin(), vars.end());
  varsByAxis[ai(axis)] = inVars;
  // union-find components
  std::unordered_map<int, int> parent;
  for (int v : vars) parent[v] = v;
  const auto find = [&](int x) {
    while (parent[x] != x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (int v : vars) {
    const Con* c = chosenOf(v);
    if (!c) continue;
    for (int d : c->deps)
      if (inVars.count(d)) parent[find(d)] = find(v);
  }
  struct Comp {
    std::vector<int> units;
    bool anchored = false;
    std::vector<int> roots;
    bool floating = false;
  };
  OrderedMap<int, Comp> comps;
  for (int v : vars) {
    const int r = find(v);
    if (!comps.has(r)) comps.set(r, {});
    Comp& comp = *comps.get(r);
    comp.units.push_back(v);
    const Con* c = chosenOf(v);
    if (!c) comp.roots.push_back(v);
    else if (c->abs) comp.anchored = true;
  }
  std::vector<Comp*> list;
  comps.each([&](const int&, Comp& c) { list.push_back(&c); });
  bool anyAnchored = false;
  for (Comp* c : list) anyAnchored = anyAnchored || c->anchored;
  Comp* main = nullptr;
  if (!anyAnchored && !list.empty()) {
    if (bodyUnit)
      for (Comp* c : list)
        if (contains(c->units, bodyUnit->id)) { main = c; break; }
    if (!main) {
      std::vector<Comp*> sorted = list;
      std::stable_sort(sorted.begin(), sorted.end(), [](const Comp* a, const Comp* b) { return a->units.size() > b->units.size(); });
      main = sorted[0];
    }
  }
  Vals& Vx = vals[ai(axis)];
  const auto underOf = [&](int u, bool why) {
    unplaced.insert(u);
    if (!under.has(u)) under.set(u, {{}, why});
    under.get(u)->axes.push_back(axis);
  };
  for (Comp* comp : list) {
    if (comp->anchored) {
      for (int u : comp->roots) underOf(u, false);
    } else if (comp == main) {
      for (std::size_t i = 1; i < comp->roots.size(); ++i) underOf(comp->roots[i], false);
      comp->floating = true;
    } else {
      // An object with no placement "has no position". A placed group floating free of the
      // rest "isn't tied" to it.
      for (int u : comp->roots) underOf(u, comp->units.size() > 1);
      for (int u : comp->units) unplaced.insert(u);   // positions are arbitrary
    }
    for (int u : comp->roots) Vx[u] = 0;
  }
  // topological evaluation
  std::unordered_set<int> done;
  for (Comp* comp : list)
    for (int u : comp->roots) done.insert(u);
  std::vector<int> pending;
  for (int u : vars)
    if (!done.count(u)) pending.push_back(u);
  bool progress = true;
  while (progress) {
    progress = false;
    for (int u : pending) {
      if (done.count(u)) continue;
      const Con* c = chosenOf(u);
      bool ready = true;
      for (int d : c->deps) ready = ready && (done.count(d) || !inVars.count(d));
      if (ready) {
        Vx[u] = c->f(Vx);
        done.insert(u);
        progress = true;
      }
    }
  }
  std::vector<int> stuck;
  for (int u : pending)
    if (!done.count(u)) stuck.push_back(u);
  if (!stuck.empty()) {
    std::vector<ObjP> nodes;
    for (int u : stuck) {
      const ObjP& n = chosenOf(u)->node;
      if (std::find(nodes.begin(), nodes.end(), n) == nodes.end()) nodes.push_back(n);
    }
    cycles.push_back({axis, stuck, nodes});
    for (int u : stuck) {
      Vx[u] = 0;
      unplaced.insert(u);
    }
  }
  // floating layout: the origin rule fixes its position (body center, else land center). See SPEC 6.
  if (main && main->floating) {
    (axis == u'x' ? floatX : floatY) = true;
    std::optional<double> ref;
    if (bodyUnit && contains(main->units, bodyUnit->id)) ref = Vx[bodyUnit->id];
    else {
      double lo = INF, hi = -INF;
      for (int u : main->units) {
        const Unit& un = *units[u];
        const auto addObj = [&](const Off& off, const BB& bb) {
          lo = js::min(lo, Vx[u] + off[axis] + bb[axis].lo);
          hi = js::max(hi, Vx[u] + off[axis] + bb[axis].hi);
        };
        if (un.kind == u"row") {
          for (const auto& m : un.row->members) addObj(m->off, m->bb);
        } else if (un.pad) addObj(un.pad->off, un.pad->bb);
        else if (un.hole) addObj(un.hole->off, un.hole->bb);
      }
      if (lo <= hi) ref = (lo + hi) / 2;
    }
    if (ref)
      for (int u : main->units) Vx[u] -= *ref;
  }
}

}  // namespace stomp::compiler
