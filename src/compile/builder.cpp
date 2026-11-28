// FootprintBuilder: reporting, values, and prepare (compile.js 686-930).
#include "builder.hpp"

#include <cmath>

#include "../jsrt.hpp"
#include "../suggest.hpp"

namespace stomp::compiler {

Builder::Builder(ObjP d, FileP f, U source) : decl(std::move(d)), file(std::move(f)), src(std::move(source)) {
  const Val& n = decl->get(K_name);
  if (n.is_str()) name = n.str();   // computed names arrive from compile()
  scope = std::make_shared<Scope>(file->lets);
}

// Reporting

void Builder::report(bool error, U msg, ObjP node, const Rels& related) {
  ObjP n = node ? node : decl;
  // a problem in the standard library: reported at the statement that used it, once (one bad
  // value can surface in several places that use it)
  if (is_lib(n)) {
    const ObjP at = trigger && !is_lib(trigger) ? trigger : range(decl->get(K_nameS).num(), decl->get(K_nameE).num());
    CDiags* sink = diagSink ? diagSink : &diags;
    auto& seen = libSeen[sink];
    const U key = U(error ? u"error" : u"warning") + u"|" + js::to_u16string(at->get(K_s).num()) + u"|" +
                  js::to_u16string(at->get(K_e).num()) + u"|" + msg;
    if (seen.count(key)) return;
    seen.insert(key);
    std::vector<const Bound*> chain;
    for (const auto& b : stack) {
      if (!b->lib) continue;
      bool dup = false;
      for (const Bound* c : chain) dup = dup || c == b.get();
      if (!dup) chain.push_back(b.get());
    }
    U names;
    for (std::size_t i = 0; i < chain.size(); ++i) {
      if (i) names += u" → ";
      names += tick(chain[i]->f->get(K_name).str());
    }
    msg = u"in the standard library's " + (chain.empty() ? U(u"features") : names) + u": " + msg;
    n = at;
  }
  if (error && !diagSink) errorCount++;
  CDiag d;
  d.error = error;
  d.message = std::move(msg);
  d.s = n->get(K_s);
  d.e = n->get(K_e);
  d.footprint = name ? Val(*name) : Val(nullptr);
  d.related.emplace();
  for (const auto& r : related) {
    if (!r.node || is_lib(r.node)) continue;
    d.related->push_back({r.message, r.node->get(K_s), r.node->get(K_e)});
  }
  // inside the template body of a `from` call: remember the call (see rehome())
  if (tmpl && !n->get(K_s).nullish() && n->get(K_s).num() >= tmpl->s && n->get(K_e).num() <= tmpl->e) {
    const bool call = !decl->get(K_callS).nullish();
    d.inst = Inst{decl->get(call ? K_callS : K_nameS).num(), decl->get(call ? K_callE : K_nameE).num(), tmpl->tmpl};
  }
  (diagSink ? diagSink : &diags)->push_back(std::move(d));
}

U Builder::stmtText(const ObjP& node) const {
  if (!node || node->get(K_s).nullish()) return u"another statement";
  const double s = node->get(K_s).num(), e = node->get(K_e).num();
  const double n = static_cast<double>(src.size());
  const double a = std::min(std::max(s, 0.0), n), b = std::min(std::max(e, 0.0), n);
  const U slice = b > a ? src.substr(static_cast<std::size_t>(a), static_cast<std::size_t>(b - a)) : U();
  U t;
  bool space = false;
  for (char16_t c : slice) {
    if (js::is_space(c)) {
      space = true;
      continue;
    }
    if (space) t += u' ';
    space = false;
    t += c;
  }
  if (space) t += u' ';
  t = js::trim(t);
  return t.size() > 48 ? t.substr(0, 45) + u"…" : t;
}

double Builder::lineAt(double off) const {
  double n = 1;
  for (std::size_t i = 0; static_cast<double>(i) < off && i < src.size(); ++i)
    if (src[i] == u'\n') n++;
  return n;
}

// Values

Env Builder::env(const ObjP& stmt) const { return {scope.get(), stmt ? unit_scale(stmt->get(K_unit)) : 1}; }

EV Builder::val(const Val& x, const ObjP& stmt) const { return eval_expr(x, env(stmt)); }

double Builder::len(const Val& x, const ObjP& stmt) const {
  const EV v = val(x, stmt);
  if (v.k == VK::Len) return v.v;
  if (v.k == VK::Num) return v.v * (stmt ? unit_scale(stmt->get(K_unit)) : 1);
  if (v.k == VK::Str) throw StompError(u"this is text (\"" + v.s + u"\"), but a length is needed here", x.obj());
  throw StompError(u"a ratio (length ÷ length) can't be used as a length", x.obj());
}

double Builder::plen(const Val& x, const ObjP& stmt, V what) {
  const double v = len(x, stmt);
  const U w = what.empty() ? U(u"this size") : U(what);
  if (v < 0) throw StompError(w + u" must not be negative (got " + fmt_mm(v) + u")", x.obj());
  if (v == 0) warn(w + u" is zero", x.obj());
  return v;
}

double Builder::countOf(const ObjP& c, const ObjP& stmt) const {
  if (!c->get(K_v).nullish()) return c->get(K_v).num();
  const U& id = c->get(K_id).str();
  const EV v = val(rec({{K_type, u"id"}, {K_name, id}, {K_s, c->get(K_s)}, {K_e, c->get(K_e)}}), stmt);
  if (v.k == VK::Len) throw StompError(tick(id) + u" is a length, but a count is needed here", c);
  if (v.k == VK::Str) throw StompError(tick(id) + u" is text (\"" + v.s + u"\"), but a count is needed here", c);
  const double r = v.k == VK::Color ? NAN : js::round(v.v * 1e9) / 1e9;
  if (!(std::isfinite(r) && std::floor(r) == r) || v.v < 0)
    throw StompError(u"a count must be a whole number (" + tick(id) + u" = " + (v.k == VK::Color ? U(u"undefined") : num_text(v.v)) + u")", c);
  return js::round(v.v);
}

double Builder::deg(const Val& x, const ObjP& stmt) const {
  const EV v = val(x, stmt);
  if (v.k != VK::Num) throw StompError(u"an angle in degrees is needed here (a plain number)", x.obj());
  return v.v;
}

double Builder::num(const Val& x, const ObjP& stmt) const {
  const EV v = val(x, stmt);
  if (v.k != VK::Num) throw StompError(u"a plain number is needed here", x.obj());
  return v.v;
}

double Builder::angleOf(const ObjP& a, const ObjP& stmt) const {
  const Val& d = a->get(K_deg);
  return !d.nullish() ? d.num() : deg(a->get(K_x), stmt);
}

double Builder::countIn(const Val& x, const ObjP& stmt, double lo, double hi, V what) const {
  const double v = num(x, stmt);
  const double n = js::round(v);
  if (std::fabs(v - n) > 1e-9 || n < lo || n > hi)
    throw StompError(U(what) + u" is a whole number from " + num_text(lo) + u" to " + num_text(hi) + u" (got " + format_number(v, std::nullopt) + u")",
                     x.obj());
  return n;
}

Color Builder::colorValue(const Val& c, const ObjP& node) const { return eval_color(c, env(node)); }

// Build

void Builder::prepare() {
  if (prepared) return;
  prepared = true;
  Flat flat = flatten(decl, {});
  ownLevel = flat.max;
  bindParams(flat.params);
  items = std::move(flat.items);
  defineLets();
  for (auto& it : items) it.s = resolveStmt(it.s);
}

std::optional<U> Builder::computeName() {
  const ObjP& d = decl;
  if (!d->get(K_name).nullish())
    return nameOf(rec({{K_name, d->get(K_name)}, {K_s, d->get(K_nameS)}, {K_e, d->get(K_nameE)}}), d->get(K_unit));
  if (!is(d->get(K_mode), u"from")) return std::nullopt;
  const Item* best = nullptr;
  for (const auto& it : items)
    if (is(it.s->get(K_type), u"Name") && (!best || it.level >= best->level)) best = &it;
  if (!best) {
    const U& t = d->get(K_template).obj()->get(K_name).str();
    const Val& table = d->get(K_table);
    if (table.truthy()) {
      err(u"template " + tick(t) + u" doesn't name its footprints, so these rows have no names — add `name: \"…\"` to the template, e.g. `name: \"" +
              js::to_upper(t) + u"-{…}\"`",
          range(table.obj()->get(K_callS).num(), table.obj()->get(K_callE).num()));
    } else {
      err(u"this footprint has no name — add one (`footprint \"NAME\" from " + t + u"(…)`) or give template " + tick(t) + u" a `name: \"…\"` line",
          range(d->get(K_callS).num(), d->get(K_callE).num()));
    }
    return std::nullopt;
  }
  const Val& v = best->s->get(K_value);
  return v.is_str() ? std::optional<U>(v.str()) : std::nullopt;
}

std::optional<U> Builder::nameOf(const Val& n, const Val& unit) {
  if (!n.truthy()) return std::nullopt;
  const Val& nm = n.obj()->get(K_name);
  if (nm.is_str()) return nm.str();
  const Val& u = unit.truthy() ? unit : decl->get(K_unit);
  return interpolate(nm, Env{scope.get(), unit_scale(u)});
}

ObjP Builder::resolveStmt(const ObjP& stmt) {
  if (!stmt) return stmt;
  const Env e = env(stmt);
  std::function<Val(const Val&)> walk = [&](const Val& n) -> Val {
    if (n.is_obj()) {
      const ObjP& o = n.obj();
      if (o->get(K_interp).is_arr()) {
        try {
          return interpolate(n, e);
        } catch (const StompError& ex) {
          err(ex.message, ex.node ? ex.node : o);
          return U(u"?");
        }
      }
      const Val& t = o->get(K_type);
      if (t.is_str()) {
        const U& ty = t.str();
        // expressions evaluate their strings lazily
        if (ty == u"num" || ty == u"id" || ty == u"str" || ty == u"neg" || ty == u"paren" || ty == u"bin") return n;
      }
      ObjP out;
      for (std::size_t i = 0; i < o->f.size(); ++i) {
        const Val& v = o->f[i].second;
        if (!v.is_obj() && !v.is_arr()) continue;
        Val w = walk(v);
        const bool same = (w.is_obj() && v.is_obj() && w.obj() == v.obj()) || (w.is_arr() && v.is_arr() && w.arr() == v.arr());
        if (same) continue;
        if (!out) out = std::make_shared<Obj>(*o);
        out->f[i].second = std::move(w);
      }
      return out ? Val(out) : n;
    }
    if (n.is_arr()) {
      const ArrP& a = n.arr();
      ArrP out;
      for (std::size_t i = 0; i < a->a.size(); ++i) {
        const Val& x = a->a[i];
        if (!x.is_obj() && !x.is_arr()) continue;
        Val y = walk(x);
        const bool same = (y.is_obj() && x.is_obj() && y.obj() == x.obj()) || (y.is_arr() && x.is_arr() && y.arr() == x.arr());
        if (same) continue;
        if (!out) out = std::make_shared<Arr>(*a);
        out->a[i] = std::move(y);
      }
      return out ? Val(out) : n;
    }
    return n;
  };
  return walk(stmt).obj();
}

ObjP Builder::build() {
  prepare();
  gather();
  generate();
  makeObjects();
  resolveGeometry();
  solve();
  layers();
  checks();
  return output();
}

// Templates and parents

Builder::Flat Builder::flatten(const ObjP& d, std::vector<U> chain) {
  U key;
  if (d->get(K_computedName).truthy()) key = d->get(K_computedName).str();
  else if (d->get(K_name).is_str()) key = d->get(K_name).str();
  else key = u"@" + num_text(d->get(K_s).num());
  for (const U& c : chain) {
    if (c != key) continue;
    U msg = u"inheritance cycle: ";
    chain.push_back(key);
    for (std::size_t i = 0; i < chain.size(); ++i) msg += (i ? u" → \"" : u"\"") + chain[i] + u"\"";
    err(msg, range(d->get(K_nameS).num(), d->get(K_nameE).num()));
    return {};
  }
  std::vector<U> next = chain;
  next.push_back(key);
  std::vector<ObjP> stmts;
  if (d->get(K_body).is_arr())
    for (const Val& s : d->get(K_body).arr()->a) stmts.push_back(s.is_obj() ? s.obj() : nullptr);
  const auto at = [&](int level) {
    std::vector<Item> out;
    for (const auto& s : stmts) out.push_back({s, level});
    return out;
  };
  const Val& mode = d->get(K_mode);
  if (is(mode, u"from")) {
    const ObjP& tn = d->get(K_template).obj();
    const U& tname = tn->get(K_name).str();
    const ObjP* t = file->templates.get(tname);
    if (!t) {
      const auto hint = suggest(tname, file->templates.keys());
      err(u"unknown template " + tick(tname) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()), tn);
      return {at(1), {}, 1};
    }
    if (!tmpl) tmpl = Inst{(*t)->get(K_s).num(), (*t)->get(K_e).num(), (*t)->get(K_name).str()};
    Flat f;
    for (const Val& s : (*t)->get(K_body).arr()->a) f.items.push_back({s.is_obj() ? s.obj() : nullptr, 0});
    for (auto& it : at(1)) f.items.push_back(it);
    f.params.push_back({*t, d});
    f.max = 1;
    return f;
  }
  if (is(mode, u"extends")) {
    std::optional<U> pname;
    if (!d->get(K_parentName).nullish()) pname = d->get(K_parentName).str();
    else pname = nameOf(d->get(K_parent), Val());
    const ObjP* p = pname ? file->footprints.get(*pname) : nullptr;
    if (!p) {
      const U pn = pname ? *pname : U(u"null");
      const auto hint = suggest(pn, file->footprints.keys());
      err(u"unknown parent footprint \"" + pn + u"\"" + (hint ? u" — did you mean \"" + *hint + u"\"?" : U()), d->get(K_parent).obj());
      return {at(0), {}, 0};
    }
    Flat base = flatten(*p, next);
    const int L = base.max + 1;
    for (auto& it : at(L)) base.items.push_back(it);
    base.max = L;
    return base;
  }
  return {at(0), {}, 0};
}

void Builder::bindParams(const std::vector<std::pair<ObjP, ObjP>>& list) {
  for (const auto& [t, d] : list) {
    const auto& params = t->get(K_params).arr()->a;
    const U& tname = t->get(K_name).str();
    OrderedMap<U, ObjP> given;
    std::vector<ObjP> pos;
    for (const Val& a : d->get(K_args).arr()->a)
      if (!a.obj()->get(K_key).truthy() && a.obj()->get(K_x).truthy()) pos.push_back(a.obj());
    if (pos.size() > params.size())
      err(u"template " + tick(tname) + u" takes " + num_text(static_cast<double>(params.size())) + u" parameter(s), got " +
              num_text(static_cast<double>(pos.size())),
          pos[params.size()]);
    for (std::size_t i = 0; i < pos.size() && i < params.size(); ++i) given.set(params[i].obj()->get(K_name).str(), pos[i]);
    for (const Val& av : d->get(K_args).arr()->a) {
      const ObjP& a = av.obj();
      if (!a->get(K_key).truthy()) continue;
      const U& k = a->get(K_key).str();
      bool known = false;
      std::vector<U> names;
      for (const Val& p : params) {
        names.push_back(p.obj()->get(K_name).str());
        known = known || names.back() == k;
      }
      const ObjP at = a->get(K_hdr).truthy() ? a->get(K_hdr).obj() : a;
      if (!known) {
        const auto hint = suggest(k, names);
        err(u"template " + tick(tname) + u" has no parameter " + tick(k) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()), at);
      } else if (given.has(k)) {
        err(u"parameter " + tick(k) + u" is given twice" + (a->get(K_hdr).truthy() ? U(u" — in the call and as a column") : U()), at);
      } else {
        given.set(k, a);
      }
    }
    for (const Val& pv : params) {
      const ObjP& p = pv.obj();
      const U& pn = p->get(K_name).str();
      if (const ObjP* a = given.get(pn)) {
        Def def;
        def.x = (*a)->get(K_x);
        def.unit = d->get(K_unit);
        def.scope = file->lets;
        def.level = 0;
        scope->defs.set(pn, std::move(def));
      } else if (p->get(K_def).truthy()) {
        Def def;
        def.x = p->get(K_def);
        def.unit = t->get(K_unit);
        def.level = 0;
        scope->defs.set(pn, std::move(def));
      } else if (d->get(K_table).truthy()) {
        err(u"template parameter " + tick(pn) + u" has no value — add a " + tick(pn) + u" column, or give it in the call: `footprints from " + tname +
                u"(" + pn + u": …)`",
            d->get(K_missingAt).truthy() ? d->get(K_missingAt).obj() : range(d->get(K_template).obj()->get(K_s).num(), d->get(K_e).num()));
      } else {
        err(u"missing argument for template parameter " + tick(pn),
            d->get(K_missingAt).truthy() ? d->get(K_missingAt).obj() : range(d->get(K_template).obj()->get(K_s).num(), d->get(K_e).num()));
      }
    }
  }
}

void Builder::defineLets() {
  for (const auto& it : items) {
    const ObjP& s = it.s;
    if (!s || !is(s->get(K_type), u"Let")) continue;
    const U& n = s->get(K_name).str();
    const Def* prev = scope->defs.get(n);
    if (prev && prev->level && *prev->level == it.level && prev->node) {
      err(tick(n) + u" already has a value in this footprint (a name gets one value)", range(s->get(K_nameS).num(), s->get(K_nameE).num()));
      continue;
    }
    if (!prev || (prev->level && *prev->level <= it.level)) {
      Def def;
      def.x = s->get(K_x);
      def.unit = s->get(K_unit);
      def.level = it.level;
      def.node = s;
      scope->defs.set(n, std::move(def));
    }
  }
}

}  // namespace stomp::compiler
