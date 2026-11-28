// compile.js 331-682: compile, the standard library, the build cache, the file's names,
// and finishing the diagnostics.
#include "compile.hpp"

#include <stomp/stomp.hpp>

#include <algorithm>
#include <bit>
#include <cmath>
#include <set>

#include "../jsrt.hpp"
#include "../lexer.hpp"
#include "../parser.hpp"
#include "../suggest.hpp"

namespace stomp::compiler {

namespace {

// What the engine passes to the features it calls (SPEC 13.5): values by name, each only if
// the feature declares it, and flags, each only if it has a section for it.
struct Hook {
  const char16_t* kind;
  std::vector<U> args;
};
const std::vector<std::pair<U, Hook>>& hooks_list() {
  static const std::vector<std::pair<U, Hook>> hooks = [] {
    const std::vector<U> BODY_ARGS{u"W", u"L", u"H", u"z0", u"draft", u"body_color", u"lead_color", u"e", u"above", u"ball_d",
                                   u"cast_d", u"turn", u"T", u"sx", u"sy", u"nx", u"ny", u"ex", u"ey", u"ma"};
    const std::vector<U> LEAD_ARGS{u"edge", u"pad_u", u"toe", u"across", u"b", u"T", u"d", u"drill", u"pad_across", u"pad_along", u"z0",
                                   u"H", u"zp", u"housing", u"zc", u"len", u"ts", u"e", u"c", u"below", u"lead_color"};
    const char16_t* STYLES[] = {u"molded", u"dip", u"block", u"radial", u"sawn", u"cga", u"bga", u"chip", u"melf", u"axial", u"can", u"led", u"header", u"module"};
    const char16_t* LEAD_HOOKS[] = {u"gullwing", u"jlead", u"lbend", u"straight", u"flat", u"endcap", u"tab", u"contact", u"ball",
                                    u"column", u"castellated", u"dip", u"axial", u"header", u"tht"};
    std::vector<std::pair<U, Hook>> out;
    for (const char16_t* s : STYLES) out.push_back({U(u"body_") + s, {u"body", BODY_ARGS}});
    for (const char16_t* f : LEAD_HOOKS) out.push_back({U(u"lead_") + f, {u"lead", LEAD_ARGS}});
    out.push_back({u"exposed_pad", {u"pad", {u"w", u"l", u"z0", u"H", u"c", u"lead_color"}}});
    out.push_back({u"polarity", {u"value", {}}});
    out.push_back({u"pin1_dot", {u"silk", {}}});
    out.push_back({u"pin1_bar", {u"silk", {u"len", u"depth"}}});
    out.push_back({u"polarity_bar", {u"silk", {u"len"}}});
    out.push_back({u"polarity_hatch", {u"silk", {u"r"}}});
    out.push_back({u"polarity_plus", {u"silk", {}}});
    return out;
  }();
  return hooks;
}
const Hook* hook_of(const U& name) {
  for (const auto& [n, h] : hooks_list())
    if (n == name) return &h;
  return nullptr;
}

const std::vector<Val>& items_of(const Val& v) {
  static const std::vector<Val> none;
  return v.is_arr() ? v.arr()->a : none;
}
U name_of(const ObjP& o) { return o->get(K_name).is_str() ? o->get(K_name).str() : U(); }
U slice(V src, const Val& a, const Val& b) {
  const double n = static_cast<double>(src.size());
  const double s = std::min(std::max(a.is_num() ? a.num() : 0, 0.0), n), e = std::min(std::max(b.is_num() ? b.num() : n, 0.0), n);
  return e > s ? U(src.substr(static_cast<std::size_t>(s), static_cast<std::size_t>(e - s))) : U();
}
/** A cache key part: unambiguous text for a value (JSON.stringify's role in compile.js). */
void keypart(U& out, const Val& v) {
  if (v.nullish()) out += u"null";
  else if (v.is_num()) out += js::to_u16string(v.num());
  else if (v.is_str()) {
    out += num_text(static_cast<double>(v.str().size()));
    out += u':';
    out += v.str();
  } else out += u"?";
  out += u'|';
}

CDiag mkdiag(bool error, U message, const Val& s, const Val& e) {
  CDiag d;
  d.error = error;
  d.message = std::move(message);
  d.s = s;
  d.e = e;
  return d;
}

// The standard library (SPEC 13.5): stomp files of features and names, parsed once. Each
// file is read at an offset of its own from LIB_BASE up.
OrderedMap<U, std::shared_ptr<Library>>& libs() {
  static OrderedMap<U, std::shared_ptr<Library>> m;
  return m;
}
int libCount = 0;

void shift_tokens(std::vector<Token>& toks, Offset base);
void shift_token(Token& t, Offset base) {
  t.s += base;
  t.e += base;
  if (t.parts) {
    auto parts = std::make_shared<std::vector<StrPart>>(*t.parts);
    for (StrPart& q : *parts) {
      if (q.is_lit) {
        q.s += base;
        q.e += base;
      } else {
        q.open += base;
        q.close += base;
        q.code_s += base;
        q.code_e += base;
      }
      shift_tokens(q.toks, base);
    }
    t.parts = parts;
  }
}
void shift_tokens(std::vector<Token>& toks, Offset base) {
  for (Token& t : toks) shift_token(t, base);
}

std::shared_ptr<Library> load_library(const std::vector<LibFile>& list) {
  U sig;
  for (std::size_t i = 0; i < list.size(); ++i) {
    if (i) sig += u'\0';
    sig += list[i].file + u"\n" + list[i].source;
  }
  if (auto* hit = libs().get(sig)) return *hit;
  auto lib = std::make_shared<Library>();
  lib->lets = std::make_shared<Scope>();
  for (std::size_t i = 0; i < list.size(); ++i) {
    const LibFile& f = list[i];
    const double base = LIB_BASE * static_cast<double>(i + 1);
    Diags lexDiags, parseDiags;
    Lexed lx = lex(f.source, &lexDiags);
    shift_tokens(lx.stream, static_cast<Offset>(base));
    const ObjP ast = parse(lx.stream, parseDiags);
    mark_ast(ast);
    const auto where = [&](const CDiag& d, double off) {
      CDiag w = d;
      w.file = f.file;
      w.s = d.s.num() - off;
      w.e = d.e.num() - off;
      return w;
    };
    for (const Diag& d : lexDiags) {
      CDiag c = mkdiag(d.severity == Severity::Error, d.message, static_cast<double>(d.s), static_cast<double>(d.e));
      c.syntax = true;
      lib->diags.push_back(where(c, 0));
    }
    for (const Diag& d : parseDiags) {
      CDiag c = mkdiag(d.severity == Severity::Error, d.message, static_cast<double>(d.s), static_cast<double>(d.e));
      c.syntax = true;
      lib->diags.push_back(where(c, base));
    }
    for (const Val& iv : items_of(ast->get(K_items))) {
      const ObjP& it = iv.obj();
      const U& t = it->get(K_type).str();
      if (t == u"Let") {
        const U n = name_of(it);
        if (lib->lets->defs.has(n))
          lib->diags.push_back(where(mkdiag(true, tick(n) + u" is defined twice in the standard library", it->get(K_nameS), it->get(K_nameE)), base));
        else {
          Def def;
          def.x = it->get(K_x);
          def.unit = it->get(K_unit);
          lib->lets->defs.set(n, std::move(def));
        }
      } else if (t == u"Feature") {
        const U n = name_of(it);
        if (lib->features.has(n))
          lib->diags.push_back(where(mkdiag(true, u"feature " + tick(n) + u" is defined twice in the standard library", it->get(K_nameS), it->get(K_nameE)), base));
        else {
          it->set(K_lib, f.file);
          lib->features.set(n, it);
        }
      } else if (t != u"Units") {
        lib->diags.push_back(where(mkdiag(true, u"a library file holds features and `NAME = value` lines only", it->get(K_s), it->get(K_e)), base));
      }
    }
    lib->sources.push_back({f.file, base, f.source});
  }
  lib->id = ++libCount;
  libs().set(sig, lib);
  if (libs().size() > 8) libs().erase(libs().first()->first);
  return lib;
}

/** The library a compile uses when it's given none: the built-in one, until set_library. */
std::vector<LibFile>& default_library() {
  static std::vector<LibFile> files = [] {
    std::vector<LibFile> out;
    for (const auto& f : builtin_library()) out.push_back({js::u16(f.name), f.source});
    return out;
  }();
  return files;
}

// Results of earlier compiles, keyed by the text a footprint is built from: its own text,
// its template and the file's names. Editing one table row then rebuilds only that row.
// A row's position isn't part of its key; its diagnostics are moved when a cached result
// is reused.
struct CacheEntry {
  std::optional<U> name;
  ResultP result;
  CDiags diags;
  std::optional<Inst> tmpl;
  double rowS = 0, rowE = 0;
};
/** A cache key: the text a footprint is built from, hashed once and shared by its copies
 *  (keys run to kilobytes). */
struct CacheKey {
  std::shared_ptr<const U> text;
  std::size_t hash;
  explicit CacheKey(U t) : text(std::make_shared<const U>(std::move(t))), hash(std::hash<U>()(*text)) {}
  bool operator==(const CacheKey& o) const { return hash == o.hash && (text == o.text || *text == *o.text); }
};
struct CacheKeyHash {
  std::size_t operator()(const CacheKey& k) const { return k.hash; }
};

// The most recently used entries: at most CACHE_MAX (compile.js's limit), taking about
// CACHE_KB at most (a WebAssembly heap never shrinks).
constexpr std::size_t CACHE_MAX = 1500;
constexpr double CACHE_KB = 256 * 1024;
struct Cache {
  OrderedMap<CacheKey, std::shared_ptr<CacheEntry>, CacheKeyHash> m;
  double kb = 0;
};
Cache& cache() {
  static Cache c;
  return c;
}
double entry_kb(const CacheEntry& e) { return e.result ? e.result->kb() : 1; }
/** Set an entry, now the most recent. */
void cache_put(const CacheKey& key, std::shared_ptr<CacheEntry> e) {
  Cache& c = cache();
  if (auto* old = c.m.get(key)) {
    c.kb -= entry_kb(**old);
    c.m.erase(key);
  }
  c.kb += entry_kb(*e);
  c.m.set(key, std::move(e));
  while (c.m.size() > 1 && (c.m.size() > CACHE_MAX || c.kb > CACHE_KB)) {
    auto* first = c.m.first();
    c.kb -= entry_kb(*first->second);
    c.m.erase(first->first);
  }
}

/** A problem a build threw: reported at its node, or at the footprint (compile.js safely). */
template <typename F>
auto safely(Builder& b, F&& fn) -> std::optional<decltype(fn())> {
  try {
    return fn();
  } catch (const StompError& err) {
    const ObjP& d = b.decl;
    if (!err.silent)
      b.diags.push_back(mkdiag(true, err.message, err.node ? err.node->get(K_s) : d->get(K_s), err.node ? err.node->get(K_e) : d->get(K_e)));
  } catch (const std::exception& err) {
    const ObjP& d = b.decl;
    const U who = b.name && !b.name->empty() ? *b.name : d->get(K_computedName).truthy() ? d->get(K_computedName).str() : U(u"footprint");
    b.diags.push_back(mkdiag(true, u"internal error while evaluating \"" + who + u"\": " + js::u16(err.what()), d->get(K_nameS), d->get(K_nameE)));
  }
  return std::nullopt;
}

/** Everything a footprint's build depends on, or none when it isn't cached (extends). */
std::optional<U> cache_key(const ObjP& d, V source, const File& file, const U& letsSig) {
  U k;
  const Val& mode = d->get(K_mode);
  if (is(mode, u"from")) {
    const U tn = name_of(d->get(K_template).obj());
    const ObjP* t = file.templates.get(tn);
    if (t) {
      keypart(k, (*t)->get(K_s));
      keypart(k, slice(source, (*t)->get(K_s), (*t)->get(K_e)));
      keypart(k, (*t)->get(K_unit));
    } else {
      keypart(k, U(u"?"));
      keypart(k, tn);
    }
    if (d->get(K_table).truthy()) {
      const ObjP& tb = d->get(K_table).obj();
      U key = u"row|" + k;
      keypart(key, d->get(K_unit));
      for (const Val& av : items_of(d->get(K_args))) {
        const ObjP& a = av.obj();
        keypart(key, a->get(K_key));
        keypart(key, slice(source, a->get(K_s), a->get(K_e)));
      }
      keypart(key, tb->get(K_callS));
      keypart(key, slice(source, tb->get(K_callS), tb->get(K_headerE)));
      keypart(key, letsSig);
      return key;
    }
    U key = u"call|" + k;
    keypart(key, d->get(K_unit));
    keypart(key, d->get(K_s));
    keypart(key, slice(source, d->get(K_s), d->get(K_e)));
    keypart(key, letsSig);
    return key;
  }
  if (is(mode, u"block")) {
    U key = u"block|";
    keypart(key, d->get(K_s));
    keypart(key, slice(source, d->get(K_s), d->get(K_e)));
    keypart(key, d->get(K_unit));
    keypart(key, letsSig);
    return key;
  }
  return std::nullopt;
}

/** Diagnostics of a cached build, moved along with their table row. */
CDiags replay(const CacheEntry& entry, const ObjP& d) {
  const double delta = d->get(K_table).truthy() ? d->get(K_s).num() - entry.rowS : 0;
  const auto inside = [&](const Val& s, const Val& e) {
    return !(s.is_num() && s.num() < entry.rowS) && !(e.is_num() && e.num() > entry.rowE);
  };
  CDiags out;
  for (CDiag x : entry.diags) {
    if (js::truthy(delta) && inside(x.s, x.e)) {
      x.s = x.s.num() + delta;
      x.e = x.e.num() + delta;
    }
    if (x.inst && js::truthy(delta) && !(x.inst->s < entry.rowS) && !(x.inst->e > entry.rowE)) {
      x.inst->s += delta;
      x.inst->e += delta;
    }
    if (!x.related) x.related.emplace();
    for (RelD& r : *x.related) {
      if (js::truthy(delta) && inside(r.s, r.e)) {
        r.s = r.s.num() + delta;
        r.e = r.e.num() + delta;
      }
    }
    out.push_back(std::move(x));
  }
  return out;
}

/** Each table row is a `from` call of the table's template. */
std::vector<ObjP> row_decls(const ObjP& table) {
  std::vector<ObjP> out;
  const auto& rows = items_of(table->get(K_rows));
  const auto& header = items_of(table->get(K_header));
  for (std::size_t i = 0; i < rows.size(); ++i) {
    const ObjP& row = rows[i].obj();
    ArrP args = list(items_of(table->get(K_args)));
    const auto& cells = items_of(row->get(K_cells));
    for (std::size_t j = 0; j < cells.size(); ++j) {
      const ObjP& c = cells[j].obj();
      const Val hdr = j < header.size() ? header[j] : Val();
      args->a.push_back(rec({{K_key, hdr.is_obj() ? hdr.obj()->get(K_name) : Val()},
                             {K_x, c->get(K_x)},
                             {K_s, c->get(K_s)},
                             {K_e, c->get(K_e)},
                             {K_hdr, hdr}}));
    }
    out.push_back(rec({{K_type, u"Footprint"},
                       {K_mode, u"from"},
                       {K_name, nullptr},
                       {K_template, table->get(K_template)},
                       {K_args, args},
                       {K_body, nullptr},
                       {K_s, row->get(K_s)},
                       {K_e, row->get(K_e)},
                       {K_nameS, row->get(K_s)},
                       {K_nameE, row->get(K_e)},
                       {K_callS, row->get(K_s)},
                       {K_callE, row->get(K_e)},
                       {K_unit, table->get(K_unit)},
                       {K_table, table},
                       {K_row, row},
                       {K_rowIndex, static_cast<double>(i)},
                       {K_missingAt, rec({{K_s, table->get(K_callS)}, {K_e, table->get(K_headerE)}})}}));
  }
  return out;
}

/**
 * A problem inside a template body is reported once, at the template, when every call has
 * it. Otherwise it's reported on the calls that cause it: the table row or `from` call with
 * the bad values.
 */
/**
 * A diagnostic as compile.js's string keys `${severity}|${s}|${e}|${message}` told them
 * apart: positions equal as String() writes them (-0 as 0, every NaN alike), undefined
 * apart from both. Comparing the values instead of building the strings is much faster.
 */
std::uint64_t key_bits(double x) {
  if (std::isnan(x)) return 0x7ff8000000000000ULL;
  return std::bit_cast<std::uint64_t>(x == 0 ? 0.0 : x);
}
std::uint64_t key_bits(const Val& v) { return v.is_num() ? key_bits(v.num()) : 0x7ff8000000000001ULL; }
struct DiagKey {
  bool error;
  std::uint64_t s, e;
  const U* message;
  bool operator==(const DiagKey& o) const { return error == o.error && s == o.s && e == o.e && *message == *o.message; }
};
struct DiagKeyHash {
  std::size_t operator()(const DiagKey& k) const {
    std::size_t h = std::hash<U>()(*k.message);
    for (std::uint64_t x : {k.s, k.e, std::uint64_t(k.error)}) h = (h ^ std::hash<std::uint64_t>()(x)) * 0x100000001b3ULL;
    return h;
  }
};

CDiags rehome(const CDiags& diags, const OrderedMap<U, double>& instCount) {
  CDiags out;
  OrderedMap<DiagKey, std::vector<const CDiag*>, DiagKeyHash> groups;
  for (const CDiag& d : diags) {
    if (!d.inst) {
      out.push_back(d);
      continue;
    }
    const DiagKey k{d.error, key_bits(d.s), key_bits(d.e), &d.message};
    if (!groups.has(k)) groups.set(k, {});
    groups.get(k)->push_back(&d);
  }
  groups.each([&](const DiagKey&, std::vector<const CDiag*>& list) {
    const U t = list[0]->inst->tmpl;
    std::set<std::pair<std::uint64_t, std::uint64_t>> calls;
    for (const CDiag* d : list) calls.insert({key_bits(d->inst->s), key_bits(d->inst->e)});
    const double* count = instCount.get(t);
    if (static_cast<double>(calls.size()) >= (count && js::truthy(*count) ? *count : 1)) {
      CDiag d = *list[0];
      d.inst.reset();
      out.push_back(std::move(d));
      return;
    }
    for (const CDiag* dp : list) {
      CDiag d = *dp;
      d.inst.reset();
      d.s = dp->inst->s;
      d.e = dp->inst->e;
      std::vector<RelD> rel{{u"in template " + t, dp->s, dp->e}};
      if (dp->related)
        for (const RelD& r : *dp->related) rel.push_back(r);
      d.related = std::move(rel);
      out.push_back(std::move(d));
    }
  });
  return out;
}

/** Source ranges a footprint is built from: itself, its table header, its template, its ancestors. */
void dep_ranges(const ObjP& decl, const File& file, std::unordered_set<U>& chain, ArrP& out) {
  out->a.push_back(rec({{K_s, decl->get(K_s)}, {K_e, decl->get(K_e)}}));
  const Val& cn = decl->get(K_computedName).truthy() ? decl->get(K_computedName) : decl->get(K_name);
  const U key = cn.is_str() ? cn.str() : U(u"[object]");
  if (chain.count(key)) return;
  chain.insert(key);
  if (decl->get(K_table).truthy()) {
    const ObjP& tb = decl->get(K_table).obj();
    out->a.push_back(rec({{K_s, tb->get(K_s)}, {K_e, tb->get(K_headerE)}}));
  }
  if (is(decl->get(K_mode), u"from")) {
    if (const ObjP* t = file.templates.get(name_of(decl->get(K_template).obj()))) out->a.push_back(rec({{K_s, (*t)->get(K_s)}, {K_e, (*t)->get(K_e)}}));
  } else if (is(decl->get(K_mode), u"extends")) {
    const Val& pn = decl->get(K_parentName);
    const ObjP* p = !pn.nullish() ? file.footprints.get(pn.str()) : nullptr;
    if (p) dep_ranges(*p, file, chain, out);
  }
}

/** A library feature's flags, within the library alone (for checkReplacement). */
std::unordered_set<U> lib_flags(const Library& lib, const ObjP& f) {
  std::unordered_set<U> out;
  std::unordered_set<const Obj*> seen;
  std::function<void(const ObjP&)> walk = [&](const ObjP& g) {
    if (!g || seen.count(g.get())) return;
    seen.insert(g.get());
    std::function<void(const std::vector<Val>&)> visit = [&](const std::vector<Val>& items) {
      for (const Val& iv : items) {
        if (!iv.is_obj()) continue;
        const ObjP& it = iv.obj();
        if (is(it->get(K_type), u"Section")) {
          for (const Val& n : it->get(K_names).arr()->a) out.insert(n.obj()->get(K_name).str());
          visit(items_of(it->get(K_body)));
        } else if (is(it->get(K_type), u"FeaturePlace")) {
          const ObjP* sub = lib.features.get(it->get(K_feature).obj()->get(K_name).str());
          walk(sub ? *sub : nullptr);
        }
      }
    };
    visit(items_of(g->get(K_body)));
  };
  walk(f);
  return out;
}

/**
 * A feature that replaces the standard library's must take what the library passes it: the
 * engine's values by name (SPEC 13.5), or the arguments the library's own features place it
 * with. A parameter nobody gives a value gets a warning.
 */
void check_replacement(const ObjP& f, const Library& lib, CDiags& diags) {
  const auto warn = [&](U msg, const ObjP& n) { diags.push_back(mkdiag(false, std::move(msg), n->get(K_s), n->get(K_e))); };
  const U fname = name_of(f);
  const ObjP nameR = range(f->get(K_nameS).num(), f->get(K_nameE).num());
  const auto& params = items_of(f->get(K_params));
  if (const Hook* hook = hook_of(fname)) {
    for (const Val& qv : params) {
      const ObjP& q = qv.obj();
      if (q->get(K_def).truthy() || std::find(hook->args.begin(), hook->args.end(), name_of(q)) != hook->args.end()) continue;
      warn(tick(fname) + u" replaces the standard library's, and the " + (U(hook->kind) == u"silk" ? u"silk" : u"3D model") + u" never gives " +
               tick(name_of(q)) + u" a value: give it a default",
           q);
    }
    return;
  }
  // every place the library places this feature
  std::vector<ObjP> calls;
  std::function<void(const std::vector<Val>&)> walk = [&](const std::vector<Val>& items) {
    for (const Val& iv : items) {
      if (!iv.is_obj()) continue;
      const ObjP& it = iv.obj();
      if (is(it->get(K_type), u"Section")) walk(items_of(it->get(K_body)));
      else if (is(it->get(K_type), u"FeaturePlace") && it->get(K_feature).obj()->get(K_name).str() == fname) calls.push_back(it->get(K_feature).obj());
    }
  };
  lib.features.each([&](const U&, const ObjP& g) { walk(items_of(g->get(K_body))); });
  for (const ObjP& c : calls) {
    std::vector<ObjP> values;
    std::vector<U> keys;
    const ObjP* libf = lib.features.get(fname);
    std::optional<std::unordered_set<U>> lf;
    for (const Val& av : items_of(c->get(K_args))) {
      const ObjP& a = av.obj();
      if (a->get(K_key).truthy()) {
        keys.push_back(a->get(K_key).str());
        continue;
      }
      if (!a->get(K_x).truthy()) continue;
      if (!a->get(K_word).nullish() && libf) {
        if (!lf) lf = lib_flags(lib, *libf);
        if (lf->count(a->get(K_word).str())) continue;
      }
      values.push_back(a);
    }
    if (values.size() > params.size()) {
      warn(u"the standard library places " + tick(fname) + u" with " + num_text(static_cast<double>(values.size())) + u" values, but yours takes " +
               num_text(static_cast<double>(params.size())),
           nameR);
      return;
    }
    std::vector<ObjP> missing;
    for (std::size_t i = 0; i < params.size(); ++i) {
      const ObjP& q = params[i].obj();
      if (!q->get(K_def).truthy() && i >= values.size() && std::find(keys.begin(), keys.end(), name_of(q)) == keys.end()) missing.push_back(q);
    }
    if (!missing.empty()) {
      U names;
      for (std::size_t i = 0; i < missing.size(); ++i) names += (i ? U(u", ") : U()) + tick(name_of(missing[i]));
      warn(u"the standard library places " + tick(fname) + u" without a value for " + names + u": give " + (missing.size() > 1 ? u"them defaults" : u"it a default"),
           missing[0]);
      return;
    }
    std::vector<U> unknown;
    for (const U& k : keys) {
      bool known = false;
      for (const Val& qv : params) known = known || name_of(qv.obj()) == k;
      if (!known) unknown.push_back(k);
    }
    if (!unknown.empty()) {
      U names;
      for (std::size_t i = 0; i < unknown.size(); ++i) names += (i ? U(u", ") : U()) + u"`" + unknown[i] + u": …`";
      warn(u"the standard library places " + tick(fname) + u" with " + names + u", which yours doesn't take", nameR);
      return;
    }
  }
}

FileP build_file(const ObjP& ast, CDiags& diags, const std::shared_ptr<Library>& lib) {
  auto file = std::make_shared<File>();
  file->lets = std::make_shared<Scope>(nullptr, lib->lets);
  file->lib = lib;
  for (const Val& iv : items_of(ast->get(K_items))) {
    const ObjP& it = iv.obj();
    const U& t = it->get(K_type).str();
    if (t == u"Let") {
      const U n = name_of(it);
      if (file->lets->defs.has(n)) {
        diags.push_back(mkdiag(true, tick(n) + u" already has a value in this file (a name gets one value)", it->get(K_nameS), it->get(K_nameE)));
      } else {
        Def def;
        def.x = it->get(K_x);
        def.unit = it->get(K_unit);
        file->lets->defs.set(n, std::move(def));
      }
    } else if (t == u"Template") {
      const U n = name_of(it);
      if (file->templates.has(n)) diags.push_back(mkdiag(true, u"template " + tick(n) + u" is defined twice", it->get(K_nameS), it->get(K_nameE)));
      else file->templates.set(n, it);
    } else if (t == u"Feature") {
      const U n = name_of(it);
      if (file->features.has(n)) diags.push_back(mkdiag(true, u"feature " + tick(n) + u" is defined twice", it->get(K_nameS), it->get(K_nameE)));
      else file->features.set(n, it);
    }
  }
  file->features.each([&](const U& n, const ObjP& f) {
    if (lib->features.has(n) || hook_of(n)) check_replacement(f, *lib, diags);
  });
  // footprints are registered by compile() once their (possibly computed) names are known
  return file;
}

}  // namespace

const std::vector<HookInfo>& hooks_table() {
  static const std::vector<HookInfo> t = [] {
    std::vector<HookInfo> out;
    for (const auto& [n, h] : hooks_list()) out.push_back({n, h.kind, h.args});
    return out;
  }();
  return t;
}

ObjP Result::with_outlines() const { return builder->withOutlines(rec); }

ObjP Result::full() const {
  ObjP o = with_outlines();
  const ObjP lazy = builder->lazyFields();
  for (const auto& f : lazy->f) o->set(f.first, f.second);
  return o;
}

void set_library(std::vector<LibFile> files) { default_library() = std::move(files); }

void clear_cache() {
  cache().m.clear();
  cache().kb = 0;
}

double Result::kb() const { return 64 + 10 * static_cast<double>(builder->pads.size() + builder->holes.size()); }

Val diag_val(const CDiag& d) {
  ObjP o = rec({{K_severity, d.error ? u"error" : u"warning"}, {K_message, d.message}, {K_s, d.s}, {K_e, d.e}});
  if (!d.footprint.undef()) o->set(K_footprint, d.footprint);
  if (d.syntax) o->set(K_syntax, true);
  if (!d.file.undef()) o->set(K_file, d.file);
  if (d.related) {
    ArrP rel = list();
    for (const RelD& r : *d.related) rel->a.push_back(rec({{K_message, r.message}, {K_s, r.s}, {K_e, r.e}}));
    o->set(K_related, rel);
  }
  if (d.inst) o->set(K_inst, rec({{K_s, d.inst->s}, {K_e, d.inst->e}, {K_tmpl, d.inst->tmpl}}));
  return o;
}

ArrP finish_diags(const CDiags& diags, V source) {
  std::vector<double> starts{0};
  for (std::size_t i = 0; i < source.size(); ++i)
    if (source[i] == u'\n') starts.push_back(static_cast<double>(i + 1));
  const auto pos = [&](const Val& offv) -> std::pair<Val, Val> {
    if (!offv.is_num()) return {1, NAN};
    const double off = offv.num();
    std::size_t lo = 0, hi = starts.size() - 1;
    while (lo < hi) {
      const std::size_t mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return {static_cast<double>(lo + 1), off - starts[lo] + 1};
  };
  const double n = static_cast<double>(source.size());
  std::unordered_set<DiagKey, DiagKeyHash> seen;
  struct Done {
    ObjP o;
    double s;
    int rank;
  };
  std::vector<Done> out;
  for (const CDiag& d : diags) {
    const double s = js::max(0, js::min(d.s.nullish() ? 0 : d.s.num(), n));
    const double e = js::max(s, js::min(d.e.nullish() ? s : d.e.num(), n));
    const DiagKey key{d.error, key_bits(s), key_bits(e), &d.message};
    if (seen.count(key)) continue;
    seen.insert(key);
    const auto p = pos(s), q = pos(e);
    CDiag c = d;
    c.s = s;
    c.e = e;
    ObjP o = diag_val(c).obj();
    o->set(K_line, p.first);
    o->set(K_col, p.second);
    o->set(K_endLine, q.first);
    o->set(K_endCol, q.second);
    ArrP rel = list();
    if (d.related)
      for (const RelD& r : *d.related) {
        const auto rp = pos(r.s);
        rel->a.push_back(rec({{K_message, r.message}, {K_s, r.s}, {K_e, r.e}, {K_line, rp.first}, {K_col, rp.second}}));
      }
    o->set(K_related, rel);
    out.push_back({o, s, d.error ? 0 : 1});
  }
  // by position, errors before warnings; ties keep their order (the sort is stable)
  std::stable_sort(out.begin(), out.end(), [](const Done& a, const Done& b) {
    if (a.s != b.s) return a.s < b.s;
    return a.rank < b.rank;
  });
  ArrP arr = list();
  for (auto& d : out) arr->a.push_back(d.o);
  return arr;
}

Compiled compile(V source, const Options& opts) {
  const bool useCache = opts.cache;
  CDiags diags;
  const auto lib = load_library(opts.stdlib ? *opts.stdlib : default_library());
  Diags syntax;
  const Lexed lx = lex(source, &syntax);
  const ObjP ast = parse(lx.stream, syntax);
  mark_ast(ast);
  for (const Diag& d : syntax) {
    CDiag c = mkdiag(d.severity == Severity::Error, d.message, static_cast<double>(d.s), static_cast<double>(d.e));
    c.syntax = true;
    diags.push_back(std::move(c));
  }
  const FileP file = build_file(ast, diags, lib);
  const U src(source);

  // every footprint, with each table row as a `from` call
  std::vector<ObjP> decls;
  struct TableInfo {
    ObjP node;
    std::vector<ObjP> rows;
  };
  std::vector<TableInfo> tables;
  for (const Val& iv : items_of(ast->get(K_items))) {
    const ObjP& it = iv.obj();
    const Val& t = it->get(K_type);
    if (is(t, u"Footprint")) decls.push_back(it);
    else if (is(t, u"Table")) {
      std::vector<ObjP> rows = row_decls(it);
      decls.insert(decls.end(), rows.begin(), rows.end());
      tables.push_back({it, rows});
      if (items_of(it->get(K_rows)).empty()) diags.push_back(mkdiag(false, u"this table has no rows yet", it->get(K_callS), it->get(K_callE)));
    }
  }

  // pass 1: name every footprint (templates may compute names), then register them
  U letsSig;
  keypart(letsSig, static_cast<double>(lib->id));
  for (const Val& iv : items_of(ast->get(K_items))) {
    const ObjP& i = iv.obj();
    if (!is(i->get(K_type), u"Let") && !is(i->get(K_type), u"Feature")) continue;
    keypart(letsSig, i->get(K_s));
    keypart(letsSig, slice(source, i->get(K_s), i->get(K_e)));
    keypart(letsSig, i->get(K_unit));
  }
  struct B {
    BuilderP b;
    std::optional<CacheKey> key;
    std::shared_ptr<CacheEntry> cached;
  };
  std::vector<B> builders;
  for (const ObjP& d : decls) {
    B x{std::make_shared<Builder>(d, file, src), std::nullopt, nullptr};
    if (useCache)
      if (auto k = cache_key(d, source, *file, letsSig)) x.key.emplace(std::move(*k));
    if (x.key) {
      if (auto* hit = cache().m.get(*x.key)) {
        const auto entry = *hit;
        cache().m.touch(*x.key);   // keep recently used entries
        x.cached = entry;
        x.b->name = entry->name;
        x.b->tmpl = entry->tmpl;
      }
    }
    builders.push_back(std::move(x));
  }
  for (auto& x : builders) {
    Builder& b = *x.b;
    const ObjP& d = b.decl;
    if (x.cached) continue;
    const bool ext = is(d->get(K_mode), u"extends");
    safely(b, [&] {
      if (!ext) b.prepare();
      b.name = b.computeName();
      return 0;
    });
    if (ext) {
      const auto pn = safely(b, [&] { return b.nameOf(d->get(K_parent), Val()); });
      d->set(K_parentName, pn ? (*pn ? Val(**pn) : Val(nullptr)) : Val());
    }
    if (!b.name || b.name->empty()) {
      // placeholder names depend on position, which keys leave out, so don't cache them
      x.key.reset();
      if (d->get(K_table).truthy())
        b.name = name_of(d->get(K_template).obj()) + u" row " + num_text(d->get(K_rowIndex).num() + 1);
      else
        b.name = u"(unnamed, line " + num_text(b.lineAt(d->get(K_s).num())) + u")";
    }
  }
  OrderedMap<U, B*> seen;
  for (auto& x : builders) {
    Builder& b = *x.b;
    const ObjP& d = b.decl;
    if (B* const* firstp = seen.get(*b.name)) {
      const ObjP& fd = (*firstp)->b->decl;
      const bool sameTable = fd->get(K_table).truthy() && d->get(K_table).truthy() && fd->get(K_table).obj() == d->get(K_table).obj();
      const U where = sameTable ? u"row " + num_text(fd->get(K_rowIndex).num() + 1) + u" of this table" : u"line " + num_text(b.lineAt(fd->get(K_s).num()));
      CDiag e = mkdiag(true, u"footprint name \"" + *b.name + u"\" is already used by " + where + u" — names must be unique", d->get(K_nameS), d->get(K_nameE));
      e.related = std::vector<RelD>{{u"first used here", fd->get(K_nameS), fd->get(K_nameE)}};
      diags.push_back(std::move(e));
      double k = 2;
      while (seen.has(*b.name + u" #" + num_text(k))) k++;
      b.name = *b.name + u" #" + num_text(k);
      x.cached = nullptr;   // a renamed duplicate is rebuilt under its new name
    }
    seen.set(*b.name, &x);
    d->set(K_computedName, *b.name);
    if (!file->footprints.has(*b.name)) file->footprints.set(*b.name, d);
  }

  // pass 2: build (or replay a cached build)
  Compiled out;
  out.footprints = list();
  for (auto& x : builders) {
    Builder& b = *x.b;
    const ObjP& d = b.decl;
    ResultP result;
    if (x.cached) {
      result = x.cached->result;
      for (auto& dg : replay(*x.cached, d)) diags.push_back(std::move(dg));
    } else {
      if (auto r = safely(b, [&] { return b.build(); })) {
        static std::uint32_t nextId = 0;
        result = std::make_shared<Result>(Result{*r, x.b, ++nextId});
      }
      if (x.key) {
        auto entry = std::make_shared<CacheEntry>();
        entry->name = b.name;
        entry->result = result;
        entry->diags = b.diags;
        entry->tmpl = b.tmpl;
        entry->rowS = d->get(K_s).num();
        entry->rowE = d->get(K_e).num();
        cache_put(*x.key, entry);
      }
      for (const auto& dg : b.diags) diags.push_back(dg);
      b.src.clear();
    }
    out.results.push_back(result);
    ArrP deps = list();
    std::unordered_set<U> chain;
    dep_ranges(d, *file, chain, deps);
    ObjP origin;
    if (d->get(K_table).truthy())
      origin = rec({{K_kind, u"row"},
                    {K_row, d->get(K_rowIndex).num() + 1},
                    {K_template, d->get(K_template).obj()->get(K_name)},
                    {K_tableS, d->get(K_table).obj()->get(K_s)}});
    else if (is(d->get(K_mode), u"from")) origin = rec({{K_kind, u"call"}, {K_template, d->get(K_template).obj()->get(K_name)}});
    else origin = rec({{K_kind, d->get(K_mode)}});
    out.footprints->a.push_back(rec({{K_name, *b.name},
                                     {K_s, d->get(K_s)},
                                     {K_e, d->get(K_e)},
                                     {K_nameS, d->get(K_nameS)},
                                     {K_nameE, d->get(K_nameE)},
                                     {K_mode, d->get(K_mode)},
                                     {K_result, result ? Val(result->rec) : Val(nullptr)},
                                     {K_deps, deps},
                                     {K_origin, origin}}));
  }
  const auto users = [&](const U& n) {
    ArrP a = list();
    for (const auto& x : builders) {
      const ObjP& d = x.b->decl;
      if (is(d->get(K_mode), u"from") && name_of(d->get(K_template).obj()) == n) a->a.push_back(*x.b->name);
    }
    return a;
  };
  out.templates = list();
  for (const Val& iv : items_of(ast->get(K_items))) {
    const ObjP& t = iv.obj();
    if (!is(t->get(K_type), u"Template")) continue;
    out.templates->a.push_back(rec({{K_name, t->get(K_name)}, {K_s, t->get(K_s)}, {K_e, t->get(K_e)}, {K_users, users(name_of(t))}}));
  }
  out.tables = list();
  for (const auto& tb : tables) {
    ArrP us = list();
    for (const auto& r : tb.rows) us->a.push_back(r->get(K_computedName));
    out.tables->a.push_back(rec({{K_template, tb.node->get(K_template).obj()->get(K_name)},
                                 {K_s, tb.node->get(K_s)},
                                 {K_e, tb.node->get(K_e)},
                                 {K_head, slice(source, tb.node->get(K_s), tb.node->get(K_callE))},
                                 {K_users, us}}));
  }
  // instantiations per template, for deciding where template diagnostics belong
  OrderedMap<U, double> instCount;
  for (const auto& x : builders) {
    if (!x.b->tmpl) continue;
    const U& t = x.b->tmpl->tmpl;
    const double* c = instCount.get(t);
    instCount.set(t, (c && js::truthy(*c) ? *c : 0) + 1);
  }
  out.diagnostics = finish_diags(rehome(diags, instCount), source);
  out.ast = ast;
  out.libraryFiles = list();
  for (const auto& f : lib->sources) out.libraryFiles->a.push_back(f.file);
  out.libraryDiagnostics = list();
  for (const auto& d : lib->diags) out.libraryDiagnostics->a.push_back(diag_val(d));
  return out;
}

}  // namespace stomp::compiler
