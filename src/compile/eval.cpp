// compile.js "Values": evalExpr, unify, callFunction, the colors, interpolate and Scope.
#include "eval.hpp"

#include <cmath>
#include <limits>

#include "../geom.hpp"
#include "../jsrt.hpp"
#include "../suggest.hpp"

namespace stomp::compiler {

namespace {

constexpr double NaN = std::numeric_limits<double>::quiet_NaN();
constexpr double INF = std::numeric_limits<double>::infinity();

U num_text(double v) { return js::to_u16string(v); }
U tick(V s) { return U(u"`") + U(s) + u"`"; }

const ObjP& node_of(const Val& v) {
  static const ObjP none;
  return v.is_obj() ? v.obj() : none;
}

// 3D colors (SPEC 13.2); metals render shiny
struct NamedColor {
  const char16_t* name;
  const char16_t* hex;
};
constexpr NamedColor COLORS[] = {
    {u"black", u"#1d1e21"},  {u"gray", u"#6f7378"},     {u"grey", u"#6f7378"},   {u"white", u"#ecebe6"},
    {u"red", u"#b3352c"},    {u"green", u"#2f7a3e"},    {u"blue", u"#2c5aa6"},   {u"yellow", u"#e0bd3a"},
    {u"orange", u"#d8772c"}, {u"brown", u"#6b4b31"},    {u"tan", u"#c49c6d"},    {u"ceramic", u"#e2dbc9"},
    {u"tin", u"#c6cad0"},    {u"silver", u"#d4d7db"},   {u"gold", u"#d6af57"},   {u"copper", u"#c67a4d"},
    {u"aluminum", u"#cdd0d4"}, {u"aluminium", u"#cdd0d4"},
};
bool is_metal(V k) {
  return k == u"tin" || k == u"silver" || k == u"gold" || k == u"copper" || k == u"aluminum" || k == u"aluminium";
}
constexpr const char16_t* COLOR_NAMES =
    u"black, gray, white, red, green, blue, yellow, orange, brown, tan, ceramic, tin, silver, gold, copper, aluminum";

bool is_hex(char16_t c) { return (c >= u'0' && c <= u'9') || (c >= u'a' && c <= u'f') || (c >= u'A' && c <= u'F'); }
int hex_digit(char16_t c) { return c <= u'9' ? c - u'0' : (c | 0x20) - u'a' + 10; }

}  // namespace

const char16_t* const FUNCTIONS = u"min, max, clamp, abs, hypot, sqrt, sin, cos, tan, asin, acos, atan2, mix and metal";

bool is_lib(const ObjP& n) {
  if (!n) return false;
  const Val& s = n->get(K_s);
  return !s.nullish() && s.is_num() && s.num() >= LIB_BASE;
}

double unit_mm(V u) {
  if (u == u"mm") return 1;
  if (u == u"um") return 0.001;
  if (u == u"nm") return 1e-6;
  if (u == u"mil") return 0.0254;
  if (u == u"in") return 25.4;
  return NaN;
}

double unit_scale(const Val& unit) { return unit.truthy() ? unit_mm(unit.str()) : 1; }

ObjP range(double s, double e) { return rec({{K_s, s}, {K_e, e}}); }

StompError silent(ObjP node) {
  StompError e(U(), std::move(node));
  e.silent = true;
  return e;
}

const char16_t* kind_name(VK k) {
  switch (k) {
    case VK::Num: return u"number";
    case VK::Ratio: return u"ratio";
    case VK::Len: return u"length";
    case VK::Str: return u"text";
    case VK::Color: return u"color";
  }
  return u"?";
}

// Evaluation

namespace {
EV call_function(const ObjP& x, const Env& env);
}

EV eval_expr(const Val& xv, const Env& env) {
  const ObjP& x = xv.obj();
  const U& t = x->get(K_type).str();
  if (t == u"num") {
    const Val& unit = x->get(K_unit);
    return unit.truthy() ? EV::len(x->get(K_v).num() * unit_mm(unit.str())) : EV::num(x->get(K_v).num());
  }
  if (t == u"id") return env.scope->lookup(x->get(K_name).str(), x);
  if (t == u"str") return EV::str(interpolate(x->get(K_value), env));
  if (t == u"paren") return eval_expr(x->get(K_x), env);
  if (t == u"call") return call_function(x, env);
  if (t == u"neg") {
    EV a = eval_expr(x->get(K_x), env);
    if (a.k == VK::Str) throw StompError(u"text can't be negated — text values are only for `{…}` in strings", x);
    if (a.k == VK::Color) throw StompError(u"a color can't be negated", x);
    a.v = -a.v;
    return a;
  }
  if (t == u"bin") {
    const EV a = eval_expr(x->get(K_a), env), b = eval_expr(x->get(K_b), env);
    if (a.k == VK::Str || b.k == VK::Str)
      throw StompError(u"text can't take part in arithmetic — to build a string, write the pieces into one: \"{a}-{b}\"", x);
    if (a.k == VK::Color || b.k == VK::Color)
      throw StompError(u"a color can't take part in arithmetic; `mix(a, b, t)` blends two", x);
    const U& op = x->get(K_op).str();
    if (op == u"+" || op == u"-") {
      const double sg = op == u"+" ? 1 : -1;
      if (a.k == b.k) return {a.k, a.v + sg * b.v, {}, nullptr};
      if (a.k == VK::Len && b.k == VK::Num) return EV::len(a.v + sg * b.v * env.scale);
      if (a.k == VK::Num && b.k == VK::Len) return EV::len(a.v * env.scale + sg * b.v);
      if (a.k != VK::Len && b.k != VK::Len) return {VK::Ratio, a.v + sg * b.v, {}, nullptr};
      throw StompError(U(u"can't ") + (op == u"+" ? u"add" : u"subtract") + u" a " + kind_name(b.k) + (op == u"+" ? u" to" : u" from") +
                           u" a " + kind_name(a.k),
                       x);
    }
    if (op == u"*") {
      if (a.k == VK::Len && b.k == VK::Len) throw StompError(u"multiplying two lengths gives an area — a unit error", x);
      if (a.k == VK::Len || b.k == VK::Len) return EV::len(a.v * b.v);
      return {a.k == VK::Ratio || b.k == VK::Ratio ? VK::Ratio : VK::Num, a.v * b.v, {}, nullptr};
    }
    if (b.v == 0) throw StompError(u"division by zero", x);
    if (a.k == VK::Len && b.k == VK::Len) return {VK::Ratio, a.v / b.v, {}, nullptr};
    if (b.k == VK::Len) throw StompError(U(u"can't divide a ") + kind_name(a.k) + u" by a length", x);
    if (a.k == VK::Len) return EV::len(a.v / b.v);
    return {a.k == VK::Ratio || b.k == VK::Ratio ? VK::Ratio : VK::Num, a.v / b.v, {}, nullptr};
  }
  throw StompError(u"bad expression", x);
}

Unified unify(const EV& a, const EV& b, const Env& env, const ObjP& node, V what) {
  for (const EV* v : {&a, &b}) {
    if (v->k == VK::Str || v->k == VK::Color)
      throw StompError(U(what) + u" takes numbers and lengths, not " + (v->k == VK::Str ? u"text" : u"a color"), node);
  }
  if (a.k == b.k) return {a.k, a.v, b.v};
  if (a.k == VK::Len && b.k == VK::Num) return {VK::Len, a.v, b.v * env.scale};
  if (a.k == VK::Num && b.k == VK::Len) return {VK::Len, a.v * env.scale, b.v};
  if (a.k != VK::Len && b.k != VK::Len) return {VK::Ratio, a.v, b.v};
  throw StompError(U(what) + u" can't mix a " + kind_name(a.k) + u" and a " + kind_name(b.k), node);
}

namespace {

/** The built-in functions (SPEC 7). Angles are in degrees. */
EV call_function(const ObjP& x, const Env& env) {
  std::vector<EV> args;
  for (const Val& a : x->get(K_args).arr()->a) args.push_back(eval_expr(a, env));
  const U& n = x->get(K_name).str();
  const auto need = [&](std::size_t lo, double hi) {
    if (args.size() < lo || static_cast<double>(args.size()) > hi) {
      const U want = static_cast<double>(lo) == hi ? num_text(static_cast<double>(lo))
                     : hi == INF                   ? num_text(static_cast<double>(lo)) + u" or more"
                                                   : num_text(static_cast<double>(lo)) + u" to " + num_text(hi);
      throw StompError(tick(n) + u" takes " + want + u" argument" + (lo == 1 && hi == 1 ? u"" : u"s") + u", but this gives " +
                           num_text(static_cast<double>(args.size())),
                       x);
    }
  };
  const auto plain = [&](const EV& v, V what) {
    if (v.k == VK::Num || v.k == VK::Ratio) return v.v;
    throw StompError(tick(n) + u" needs " + U(what) + u", not a " + kind_name(v.k), x);
  };
  // the arguments as one kind, as `+` would combine them
  struct Common {
    VK k;
    std::vector<double> v;
  };
  const auto common = [&]() {
    const U what = tick(n);
    for (const EV& v : args) unify(v, v, env, x, what);
    bool any_len = false, any_ratio = false;
    for (const EV& v : args) {
      any_len = any_len || v.k == VK::Len;
      any_ratio = any_ratio || v.k == VK::Ratio;
    }
    const VK k = any_len ? VK::Len : any_ratio ? VK::Ratio : VK::Num;
    if (k == VK::Len && any_ratio) {
      const EV* l = nullptr;
      const EV* r = nullptr;
      for (const EV& v : args) {
        if (!l && v.k == VK::Len) l = &v;
        if (!r && v.k == VK::Ratio) r = &v;
      }
      unify(*l, *r, env, x, what);
    }
    Common c{k, {}};
    for (const EV& v : args) c.v.push_back(k == VK::Len && v.k == VK::Num ? v.v * env.scale : v.v);
    return c;
  };
  const double R = 180 / geom::PI;
  const auto deg = [&](double v) {
    if (!std::isfinite(v)) throw StompError(tick(n) + u" is undefined here (got " + num_text(v) + u")", x);
    return EV::num(v);
  };
  if (n == u"min" || n == u"max") {
    need(1, INF);
    const Common c = common();
    double r = c.v[0];
    for (std::size_t i = 1; i < c.v.size(); ++i) r = n == u"min" ? js::min(r, c.v[i]) : js::max(r, c.v[i]);
    return {c.k, r, {}, nullptr};
  }
  if (n == u"clamp") {
    need(3, 3);
    const Common c = common();
    return {c.k, js::max(c.v[1], js::min(c.v[2], c.v[0])), {}, nullptr};
  }
  if (n == u"abs") {
    need(1, 1);
    const Common c = common();
    return {c.k, std::fabs(c.v[0]), {}, nullptr};
  }
  if (n == u"hypot") {
    need(1, INF);
    const Common c = common();
    return {c.k, js::hypot(c.v.data(), c.v.size()), {}, nullptr};
  }
  if (n == u"sqrt") {
    need(1, 1);
    const EV& a = args[0];
    if (a.k == VK::Len) throw StompError(u"`sqrt` of a length has no unit stomp can use; take it of a ratio or a plain number", x);
    const double v = plain(a, u"a number");
    if (v < 0) throw StompError(u"`sqrt` of a negative number (" + num_text(v) + u")", x);
    return {a.k, std::sqrt(v), {}, nullptr};
  }
  if (n == u"sin" || n == u"cos" || n == u"tan") {
    need(1, 1);
    const double a = plain(args[0], u"an angle in degrees");
    const auto cs = geom::cos_sin(a);   // exact at right angles
    return EV::num(n == u"sin" ? cs[1] : n == u"cos" ? cs[0] : js::tan(a * (geom::PI / 180)));
  }
  if (n == u"asin" || n == u"acos") {
    need(1, 1);
    const double a = plain(args[0], u"a number from -1 to 1");
    if (a < -1 || a > 1) throw StompError(tick(n) + u" takes a number from -1 to 1 (got " + format_number(a, std::nullopt) + u")", x);
    return deg((n == u"asin" ? js::asin(a) : js::acos(a)) * R);
  }
  if (n == u"atan2") {
    need(2, 2);
    const Unified u = unify(args[0], args[1], env, x, u"`atan2`");
    return deg(js::atan2(u.a, u.b) * R);
  }
  if (n == u"mix") {
    need(3, 3);
    const Color a = to_color(args[0], x), b = to_color(args[1], x);
    const double t = plain(args[2], u"a fraction from 0 to 1");
    Color c;
    for (int i = 0; i < 3; i++) c.rgb[i] = a.rgb[i] + (b.rgb[i] - a.rgb[i]) * t;
    return EV::color(std::move(c));
  }
  if (n == u"metal") {
    need(1, 1);
    Color c = to_color(args[0], x);
    c.metal = 1;
    return EV::color(std::move(c));
  }
  std::vector<U> names;
  {
    U list = FUNCTIONS;
    const auto at = list.find(u" and");
    list.replace(at, 4, u",");
    std::size_t i = 0;
    while (true) {
      const auto j = list.find(u", ", i);
      names.push_back(list.substr(i, j == U::npos ? U::npos : j - i));
      if (j == U::npos) break;
      i = j + 2;
    }
  }
  const auto hint = suggest(n, names);
  const Val& name_e = x->get(K_nameE);
  throw StompError(u"unknown function " + tick(n) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()) + u" (the functions are " +
                       FUNCTIONS + u")",
                   range(x->get(K_s).num(), name_e.truthy() ? name_e.num() : x->get(K_e).num()));
}

}  // namespace

// Colors

std::optional<Color> parse_color(V text, const ObjP& node) {
  const U t = js::trim(text);
  if (!t.empty() && t[0] == u'#') {
    bool ok = t.size() == 4 || t.size() == 7;
    for (std::size_t i = 1; ok && i < t.size(); ++i) ok = is_hex(t[i]);
    if (!ok) throw StompError(tick(t) + u" isn't a color — write it as \"#rrggbb\"", node);
    U h = t;
    if (t.size() == 4) {
      h = u"#";
      for (std::size_t i = 1; i < 4; ++i) h += U(2, t[i]);
    }
    int n = 0;
    for (std::size_t i = 1; i < 7; ++i) n = n * 16 + hex_digit(h[i]);
    Color c;
    c.rgb = {((n >> 16) & 255) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0};
    c.name = js::to_lower(h);
    return c;
  }
  const U k = js::to_lower(t);
  for (const auto& nc : COLORS) {
    if (k != nc.name) continue;
    Color c = *parse_color(nc.hex, node);
    c.metal = is_metal(k) ? 1 : 0;
    c.name = k;
    return c;
  }
  return std::nullopt;
}

Color to_color(const EV& v, const ObjP& node) {
  if (v.k == VK::Color) return *v.c;
  if (v.k == VK::Str) {
    if (auto c = parse_color(v.s, node)) return *c;
    throw StompError(u"unknown color \"" + v.s + u"\" (names: " + COLOR_NAMES + u"; or \"#rrggbb\")", node);
  }
  throw StompError(U(u"a color is needed here, not a ") + kind_name(v.k), node);
}

Color eval_color(const Val& xv, const Env& env) {
  const ObjP& x = node_of(xv);
  if (x && x->get(K_type).str() == u"id" && !env.scope->has(x->get(K_name).str())) {
    const U& name = x->get(K_name).str();
    if (auto c = parse_color(name, x)) return *c;
    Scope* lib = env.scope->root()->library.get();
    if (lib && lib->defs.has(name)) return to_color(lib->lookup(name, x), x);
    std::vector<U> cands;
    for (const auto& nc : COLORS) cands.push_back(nc.name);
    if (lib)
      for (const U& k : lib->defs.keys()) cands.push_back(k);
    const auto hint = suggest(js::to_lower(name), cands);
    throw StompError(u"unknown color " + tick(name) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()) + u" (names: " +
                         COLOR_NAMES + u"; or \"#rrggbb\")",
                     x);
  }
  return to_color(eval_expr(xv, env), x);
}

U hex_of(const std::array<double, 3>& rgb) {
  static const char16_t* digits = u"0123456789abcdef";
  U out = u"#";
  for (double c : rgb) {
    const double v = js::round(js::max(0, js::min(1, c)) * 255);
    if (std::isnan(v)) {
      out += u"NaN";
      continue;
    }
    const int i = static_cast<int>(v);
    out += digits[(i >> 4) & 15];
    out += digits[i & 15];
  }
  return out;
}

// Text

U interpolate(const Val& value, const Env& env) {
  if (value.is_str()) return value.str();
  U out;
  for (const Val& p : value.obj()->get(K_interp).arr()->a) {
    if (p.is_str()) {
      out += p.str();
      continue;
    }
    const ObjP& part = p.obj();
    const Val& x = part->get(K_x);
    if (x.truthy()) {
      const EV v = eval_expr(x, env);
      out += format_value(&v, part->get(K_fmt), env);
    } else {
      out += format_value(nullptr, part->get(K_fmt), env);
    }
  }
  return out;
}

U format_value(const EV* v, const Val& fmt, const Env& env) {
  if (!v) return U();
  if (v->k == VK::Str) return v->s;
  if (v->k == VK::Color) return v->c->name && !v->c->name->empty() ? *v->c->name : hex_of(v->c->rgb);
  const double n = v->k == VK::Len ? v->v / env.scale : v->v;
  return format_number(n, fmt.is_num() ? std::optional<int>(static_cast<int>(fmt.num())) : std::nullopt);
}

U format_number(double n, std::optional<int> fmt) {
  if (fmt) {
    const U t = js::u16(js::to_fixed(n, *fmt));
    // "-0", "-0." and "-0.00..." lose their sign
    bool neg_zero = t.size() >= 2 && t[0] == u'-' && t[1] == u'0';
    std::size_t i = 2;
    if (neg_zero && i < t.size() && t[i] == u'.') ++i;
    while (neg_zero && i < t.size()) neg_zero = t[i++] == u'0';
    return neg_zero ? t.substr(1) : t;
  }
  double r = js::parse_float(js::u16(js::to_fixed(n, 6)));
  if (r == 0) r = 0;   // -0 prints as 0
  return js::to_u16string(r);
}

// Scope

Scope* Scope::root() {
  Scope* sc = this;
  while (sc->parent) sc = sc->parent.get();
  return sc;
}

bool Scope::has(const U& name) const {
  for (const Scope* sc = this; sc; sc = sc->parent.get())
    if (sc->defs.has(name)) return true;
  return false;
}

EV Scope::lookup(const U& name, const ObjP& node) {
  for (Scope* sc = this; sc; sc = sc->parent.get()) {
    Def* d = sc->defs.get(name);
    if (!d) continue;
    if (d->value) return *d->value;
    if (d->missing) {
      StompError e(u"feature " + tick(*d->missing) + u" needs a value for " + tick(name), node);
      e.missing = name;
      throw e;
    }
    if (d->busy) throw StompError(tick(name) + u" is defined in terms of itself", node);
    d->busy = true;
    const Env env{d->scope ? d->scope.get() : sc, unit_scale(d->unit)};
    const Val x = d->x;
    EV v;
    try {
      v = eval_expr(x, env);
    } catch (...) {
      if (Def* again = sc->defs.get(name)) again->busy = false;
      throw;
    }
    d = sc->defs.get(name);   // evaluating may have moved it
    d->busy = false;
    d->value = v;
    return v;
  }
  // built-in names: pi, the color names, then the standard library's
  if (name == u"pi") return EV::num(geom::PI);
  if (auto c = parse_color(name, node); c && !(name.size() && name[0] == u'#')) return EV::color(std::move(*c));
  Scope* lib = root()->library.get();
  if (lib && lib->defs.has(name)) return lib->lookup(name, node);
  std::vector<U> all;
  for (Scope* sc = this; sc; sc = sc->parent.get())
    for (const U& k : sc->defs.keys()) all.push_back(k);
  // a name ending in w or h: perhaps a side mark on a name
  if (name.size() >= 2 && (name.back() == u'w' || name.back() == u'h')) {
    const U base = name.substr(0, name.size() - 1);
    for (const U& k : all) {
      if (k != base) continue;
      throw StompError(u"unknown name " + tick(name) + u" — to mark a side of a size, put the name in parentheses: `(" + base + u")" +
                           U(1, name.back()) + u"`",
                       node);
    }
  }
  const auto hint = suggest(name, all);
  throw StompError(u"unknown name " + tick(name) + (hint ? u" — did you mean " + tick(*hint) + u"?" : U()), node);
}

}  // namespace stomp::compiler
