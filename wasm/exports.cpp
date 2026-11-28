// The C functions the JavaScript adapter (demo/js/engine.js) calls. Each one catches
// everything: an exception must never cross into JavaScript.
//
// Input text comes as UTF-16 in wasm memory (the adapter writes it). Results are left
// in an output buffer: stomp_out_ptr()/stomp_out_len() for bytes, stomp_out32_ptr()/
// stomp_out32_len() for 32-bit integers, valid until the next call.
#include <stomp/stomp.hpp>

#include <emscripten/emscripten.h>
#include <malloc.h>

#include <cstdint>
#include <cstring>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "compile/compile.hpp"
#include "encode.hpp"
#include "jsrt.hpp"
#include "json.hpp"
#include "kicad.hpp"
#include "lexer.hpp"
#include "model3d.hpp"
#include "ordered_map.hpp"
#include "parser.hpp"

namespace {

std::string out;                  // the last result, UTF-8 or bytes
std::vector<std::int32_t> out32;  // the last result, as integers
std::vector<float> outF;          // the last result's floats (mesh positions and normals)

void put_units(std::u16string_view s) {
  out32.push_back(static_cast<std::int32_t>(s.size()));
  for (char16_t c : s) out32.push_back(c);
}

// One token for the editor (engine.js lexTokens decodes it):
//   type, s, e, info, then for a string its parts. The info word:
//   word: 1 keyword, 2 the `end` a `}` became
//   num:  bits 0-15 the digits' length, 16 a suffix, 17-18 the side mark (1 w, 2 h),
//         19 the axis key exists, 20 an integer
//   str:  -1 no interpolation (then its value as UTF-16), else the number of parts
void put_token(const stomp::Token& k) {
  using stomp::Tok;
  out32.push_back(static_cast<std::int32_t>(k.t));
  out32.push_back(static_cast<std::int32_t>(k.s));
  out32.push_back(static_cast<std::int32_t>(k.e));
  switch (k.t) {
    case Tok::Word:
      out32.push_back((k.kw ? 1 : 0) | (k.from_brace ? 2 : 0));
      break;
    case Tok::Num:
      out32.push_back(static_cast<std::int32_t>(k.num.size()) | (k.has_suffix ? 1 << 16 : 0) |
                      ((k.axis == u'w' ? 1 : k.axis == u'h' ? 2 : 0) << 17) | (k.has_axis_key ? 1 << 19 : 0) |
                      (k.is_int ? 1 << 20 : 0));
      break;
    case Tok::Str:
      if (!k.parts) {
        out32.push_back(-1);
        put_units(k.v);
        break;
      }
      out32.push_back(static_cast<std::int32_t>(k.parts->size()));
      for (const auto& p : *k.parts) {
        if (p.is_lit) {
          out32.push_back(0);
          out32.push_back(static_cast<std::int32_t>(p.s));
          out32.push_back(static_cast<std::int32_t>(p.e));
          put_units(p.lit);
        } else {
          out32.push_back(1);
          out32.push_back(static_cast<std::int32_t>(p.open));
          out32.push_back(static_cast<std::int32_t>(p.close));
          out32.push_back(static_cast<std::int32_t>(p.code_s));
          out32.push_back(static_cast<std::int32_t>(p.code_e));
          out32.push_back(p.fmt);
          out32.push_back(static_cast<std::int32_t>(p.fmt_s));
          out32.push_back(static_cast<std::int32_t>(p.all.size()));
          for (const auto& c : p.all) put_token(c);
        }
      }
      break;
    default:
      out32.push_back(0);
      break;
  }
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* stomp_version() { return stomp::version(); }

EMSCRIPTEN_KEEPALIVE const char* stomp_out_ptr() { return out.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_out_len() { return static_cast<std::uint32_t>(out.size()); }
EMSCRIPTEN_KEEPALIVE const std::int32_t* stomp_out32_ptr() { return out32.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_out32_len() { return static_cast<std::uint32_t>(out32.size()); }

/** The built-in library's file names, one per line. */
EMSCRIPTEN_KEEPALIVE int stomp_library_names() {
  try {
    out.clear();
    for (const auto& f : stomp::builtin_library()) out += f.name + "\n";
    return 0;
  } catch (...) {
    out = "internal error";
    return 1;
  }
}

/**
 * Lex UTF-16 text for the editor: every token (put_token), then the parser's stream as
 * indices into them (-1 and a token for one the lexer made up), then the end.
 *   [count, token..., stream count, (index | -1 token)..., eof s, eof e]
 */
EMSCRIPTEN_KEEPALIVE int stomp_lex(const char16_t* src, std::uint32_t len) {
  try {
    out32.clear();
    const stomp::Lexed lx = stomp::lex(std::u16string_view(src, len), nullptr);
    out32.push_back(static_cast<std::int32_t>(lx.all.size()));
    for (const auto& k : lx.all) put_token(k);
    out32.push_back(static_cast<std::int32_t>(lx.stream.size()) - 1);   // the eof comes last, apart
    for (std::size_t i = 0; i + 1 < lx.stream.size(); ++i) {
      const auto& k = lx.stream[i];
      out32.push_back(k.all_index);
      if (k.all_index < 0) put_token(k);
    }
    out32.push_back(static_cast<std::int32_t>(lx.eof.s));
    out32.push_back(static_cast<std::int32_t>(lx.eof.e));
    return 0;
  } catch (...) {
    out32.clear();
    return 1;
  }
}

}  // extern "C"

// The engine for the editor (engine.js). Results and models stay here, by id, while the
// editor may still use them: the last compile's results while it is the last, and the most
// recently used others up to a limit. The editor's objects remember where they came from,
// and the adapter compiles (or builds) again one that was let go: the results are the same.
//
// Return codes: 0 done, 1 failed (the message in out), 2 that result was let go, 3 that model.

namespace {

using stomp::Val;
using stomp::ObjP;
using namespace stomp::compiler;

constexpr int RELEASED_RESULT = 2, RELEASED_MODEL = 3;

struct Released {
  int code;
};

/** The most recently used values by id, while there are at most `count` and their weights
 *  add up to at most `budget` (the newest always stays). */
template <typename T>
class Recent {
 public:
  Recent(std::size_t count, double budget, double (*weigh)(const T&)) : count_(count), budget_(budget), weigh_(weigh) {}
  void put(std::uint32_t id, T v) {
    drop(id);
    total_ += weigh_(v);
    map_.set(id, std::move(v));
    while (map_.size() > 1 && (map_.size() > count_ || total_ > budget_)) drop(map_.first()->first);
  }
  /** The value, now the most recent; null if it was let go. */
  T* use(std::uint32_t id) {
    T* v = map_.get(id);
    if (!v) return nullptr;
    T keep = std::move(*v);
    map_.erase(id);
    return &map_.set(id, std::move(keep));
  }

 private:
  void drop(std::uint32_t id) {
    if (T* v = map_.get(id)) {
      total_ -= weigh_(*v);
      map_.erase(id);
    }
  }
  stomp::OrderedMap<std::uint32_t, T> map_;
  std::size_t count_;
  double budget_, total_ = 0;
  double (*weigh_)(const T&);
};

using ModelP = std::shared_ptr<const stomp::model3d::Model>;
// About what each takes, in KB
double result_kb(const ResultP& r) { return r->kb(); }
double model_kb(const ModelP& m) {
  double bytes = 0;
  for (const auto& x : m->meshes) bytes += 4.0 * static_cast<double>(x.pos.size() + x.nrm.size() + x.idx.size());
  return 1 + bytes / 1024;
}

Recent<ResultP> recent(256, 96 * 1024, result_kb);   // besides the last compile's
stomp::OrderedMap<std::uint32_t, ResultP> lastCompile;   // in the file's order
Recent<ModelP> models(8, 64 * 1024, model_kb);
std::uint32_t nextModel = 0, lastId = 0;

const ResultP& result_of(std::uint32_t id) {
  if (const ResultP* r = lastCompile.get(id)) return *r;
  if (ResultP* r = recent.use(id)) return *r;
  throw Released{RELEASED_RESULT};
}
ModelP model_of(std::uint32_t id) {
  if (!id) return nullptr;
  if (auto* m = models.use(id)) return *m;
  throw Released{RELEASED_MODEL};
}
std::uint32_t keep_model(stomp::model3d::Model&& m) {
  models.put(++nextModel, std::make_shared<const stomp::model3d::Model>(std::move(m)));
  return nextModel;
}

std::u16string text(const char16_t* p, std::uint32_t n) { return std::u16string(p, n); }
/** JSON for the browser; AST records inside results go as { type, s, e }. */
void put_json(const Val& v) {
  static const stomp::Summarize ast = [](const stomp::Obj& o) { return o.ast; };
  out.clear();
  stomp::write_json(v, out, &ast);
}
int fail(const char* what) {
  out = what;
  out32.clear();
  outF.clear();
  return 1;
}

std::vector<LibFile> library_from(const char* json, std::uint32_t n) {
  std::vector<LibFile> files;
  const stomp::json::Value v = stomp::json::parse(std::string_view(json, n));
  for (const auto& f : v.array()) {
    const auto* name = f.get(u"file");
    const auto* source = f.get(u"source");
    files.push_back({name && name->is_string() ? name->string() : std::u16string(), source && source->is_string() ? source->string() : std::u16string()});
  }
  return files;
}

/** A model as JSON (meshes without their arrays: { ..., n vertices, t indices }), with the
 *  positions and normals of each mesh in outF and its indices in out32. */
void put_model(const stomp::model3d::Model& m, const std::vector<stomp::model3d::HookCall>* calls) {
  stomp::json::Value o = stomp::model3d::to_json(m);
  outF.clear();
  out32.clear();
  auto& meshes = const_cast<stomp::json::Array&>(o.get(u"meshes")->array());
  for (std::size_t i = 0; i < m.meshes.size(); ++i) {
    const auto& x = m.meshes[i];
    auto& me = meshes[i];
    auto& fields = me.object();
    fields.erase(std::remove_if(fields.begin(), fields.end(), [](const auto& f) { return f.first == u"pos" || f.first == u"nrm" || f.first == u"idx"; }),
                 fields.end());
    me.set(u"n", static_cast<double>(x.pos.size() / 3));
    me.set(u"t", static_cast<double>(x.idx.size()));
    outF.insert(outF.end(), x.pos.begin(), x.pos.end());
    outF.insert(outF.end(), x.nrm.begin(), x.nrm.end());
    for (std::uint32_t k : x.idx) out32.push_back(static_cast<std::int32_t>(k));
  }
  if (calls) {
    stomp::json::Value list = stomp::json::array();
    for (const auto& c : *calls) {
      stomp::json::Value e = stomp::json::object();
      e.set(u"name", c.name);
      stomp::json::Value vs = stomp::json::array();
      for (const auto& k : c.values) vs.push(k);
      e.set(u"values", std::move(vs));
      list.push(std::move(e));
    }
    o.set(u"hookCalls", std::move(list));
  }
  out = stomp::json::write(o);
}

CDiags diags_from(const stomp::json::Value& v) {
  CDiags ds;
  const auto num = [](const stomp::json::Value* x) { return x && x->is_number() ? Val(x->number()) : Val(); };
  for (const auto& d : v.array()) {
    CDiag c;
    const auto* sev = d.get(u"severity");
    c.error = !(sev && sev->is_string() && sev->string() == u"warning");
    if (const auto* m = d.get(u"message"); m && m->is_string()) c.message = m->string();
    c.s = num(d.get(u"s"));
    c.e = num(d.get(u"e"));
    if (const auto* f = d.get(u"footprint")) c.footprint = f->is_string() ? Val(f->string()) : Val(nullptr);
    if (const auto* f = d.get(u"file"); f && f->is_string()) c.file = f->string();
    if (const auto* sy = d.get(u"syntax"); sy && sy->is_bool()) c.syntax = sy->boolean();
    if (const auto* rel = d.get(u"related"); rel && rel->is_array()) {
      c.related.emplace();
      for (const auto& r : rel->array()) {
        const auto* m = r.get(u"message");
        c.related->push_back({m && m->is_string() ? m->string() : std::u16string(), num(r.get(u"s")), num(r.get(u"e"))});
      }
    }
    ds.push_back(std::move(c));
  }
  return ds;
}

/** Run an export's work: its return code, and never an exception into JavaScript. */
template <typename F>
int guarded(F&& f) {
  try {
    f();
    return 0;
  } catch (const Released& r) {
    out = "released";
    out32.clear();
    outF.clear();
    return r.code;
  } catch (const std::exception& e) {
    return fail(e.what());
  } catch (...) {
    return fail("internal error");
  }
}

Compiled compile_text(const char16_t* src, std::uint32_t n, const char* lib, std::uint32_t m, int flags) {
  std::vector<LibFile> files;
  Options o;
  o.cache = !(flags & 1);
  if (lib) {
    files = library_from(lib, m);
    o.stdlib = &files;
  }
  return compile(std::u16string_view(src, n), o);
}

}  // namespace

extern "C" {

/**
 * Compile UTF-16 text. lib is null for the built-in library, else UTF-8 JSON [{file, source}];
 * flags: 1 no cache. JSON out: { diagnostics, footprints (result: an id or null), templates,
 * tables, library: { files, diagnostics } }. A result's body comes from stomp_result.
 */
EMSCRIPTEN_KEEPALIVE int stomp_compile(const char16_t* src, std::uint32_t n, const char* lib, std::uint32_t m, int flags) {
  return guarded([&] {
    const Compiled c = compile_text(src, n, lib, m, flags);
    // the compile before this one joins the recently used results
    lastCompile.each([](std::uint32_t id, const ResultP& r) { recent.put(id, r); });
    lastCompile.clear();
    stomp::ArrP fps = stomp::list();
    for (std::size_t i = 0; i < c.footprints->a.size(); ++i) {
      auto f = std::make_shared<stomp::Obj>(*c.footprints->a[i].obj());
      if (const ResultP& r = c.results[i]) {
        lastCompile.set(r->id, r);
        f->set(stomp::K_result, static_cast<double>(r->id));
      }
      fps->a.push_back(f);
    }
    put_json(stomp::rec({{stomp::K_diagnostics, c.diagnostics},
                         {stomp::K_footprints, fps},
                         {stomp::K_templates, c.templates},
                         {stomp::K_tables, c.tables},
                         {stomp::K_library, stomp::rec({{stomp::K_files, c.libraryFiles}, {stomp::K_diagnostics, c.libraryDiagnostics}})}}));
  });
}

/** Compile again as stomp_compile did, for the result of footprint `index` that the engine let
 *  go while the editor still had it: the new id in stomp_last_id (the same values). */
EMSCRIPTEN_KEEPALIVE int stomp_recompile(const char16_t* src, std::uint32_t n, const char* lib, std::uint32_t m, int flags, std::uint32_t index) {
  return guarded([&] {
    const Compiled c = compile_text(src, n, lib, m, flags);
    if (index >= c.results.size() || !c.results[index]) throw std::runtime_error("that footprint no longer builds");
    const ResultP& r = c.results[index];
    if (!lastCompile.has(r->id)) recent.put(r->id, r);
    lastId = r->id;
    out.clear();
  });
}

EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_last_id() { return lastId; }

/** A result's record, without the lazy layers, and with nulls for the pads' and holes' outlines. */
EMSCRIPTEN_KEEPALIVE int stomp_result(std::uint32_t id) {
  return guarded([&] {
    const ResultP& r = result_of(id);
    put_json(r->builder->withOutlines(r->rec, true));
  });
}

EMSCRIPTEN_KEEPALIVE void stomp_clear_cache() { clear_cache(); }

/** The library compiles use when given none: UTF-8 JSON [{file, source}] (the page's stdlib.js). */
EMSCRIPTEN_KEEPALIVE int stomp_set_library(const char* lib, std::uint32_t m) {
  return guarded([&] { set_library(library_from(lib, m)); });
}

/** A result's lazy fields: silk, assembly, courtyard, bbox, courtyardBox, courtyardClearance. */
EMSCRIPTEN_KEEPALIVE int stomp_layers(std::uint32_t id) {
  return guarded([&] { put_json(result_of(id)->builder->lazyFields()); });
}

/** A result's outlines: { pads: [[land, copper, mask, paste, drillShape]], holes: [[land, mask]] }. */
EMSCRIPTEN_KEEPALIVE int stomp_contours(std::uint32_t id) {
  return guarded([&] { put_json(result_of(id)->builder->outlines()); });
}

/** Build a result's 3D model, its id in stomp_last_id. flags: 1 strict, 2 record the hooks
 *  bound, 4 only keep it (no output: the editor has its meshes and lost the engine's copy). */
EMSCRIPTEN_KEEPALIVE int stomp_model(std::uint32_t id, int flags) {
  return guarded([&] {
    const ResultP r = result_of(id);
    std::vector<stomp::model3d::HookCall> calls;
    stomp::model3d::Model m = stomp::model3d::build(*r, flags & 1, flags & 2 ? &calls : nullptr);
    if (flags & 4) out.clear();
    else put_model(m, flags & 2 ? &calls : nullptr);
    lastId = keep_model(std::move(m));
  });
}

/** The board under a result's part (model 0 for none), in stomp_model's form. */
EMSCRIPTEN_KEEPALIVE int stomp_board(std::uint32_t id, std::uint32_t model) {
  return guarded([&] {
    const ResultP r = result_of(id);
    const auto m = model_of(model);
    put_model(stomp::model3d::board(r->full(), m.get()), nullptr);
  });
}

EMSCRIPTEN_KEEPALIVE int stomp_vrml(std::uint32_t model, const char16_t* name, std::uint32_t n) {
  return guarded([&] { out = stomp::model3d::to_vrml(*model_of(model), text(name, n)); });
}

EMSCRIPTEN_KEEPALIVE int stomp_stl(std::uint32_t model, const char16_t* name, std::uint32_t n) {
  return guarded([&] {
    const auto bytes = stomp::model3d::to_stl(*model_of(model), text(name, n));
    out.assign(bytes.begin(), bytes.end());
  });
}

/** A result as a KiCad footprint, with the model (0: none) embedded: JSON { name, file, text, embedded, notes }. */
EMSCRIPTEN_KEEPALIVE int stomp_kicad(std::uint32_t id, const char16_t* name, std::uint32_t n, std::uint32_t model) {
  return guarded([&] {
    const ResultP r = result_of(id);
    const auto m = model_of(model);
    const ObjP res = r->full();
    std::u16string nm = text(name, n);
    const Val& rn = res->get(stomp::K_name);
    const std::u16string safe = stomp::kicad::safe_name(!nm.empty() ? nm : rn.is_str() && !rn.str().empty() ? rn.str() : std::u16string(u"footprint"));
    std::string vrml;
    const bool embed = m && !m->none && !m->meshes.empty();
    if (embed) vrml = stomp::model3d::to_vrml(*m, safe);
    const auto k = stomp::kicad::footprint(res, nm, embed ? &vrml : nullptr);
    stomp::ArrP notes = stomp::list();
    for (const auto& note : k.notes) notes->a.push_back(note);
    put_json(stomp::rec({{stomp::K_name, k.name},
                         {stomp::K_file, k.file},
                         {stomp::K_text, k.text},
                         {stomp::K_embedded, static_cast<double>(k.embedded)},
                         {stomp::K_notes, notes}}));
  });
}

/** Bytes of the heap in use (the tests bound it). */
EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_memory() { return static_cast<std::uint32_t>(mallinfo().uordblks); }

/** Line and column for diagnostics (UTF-8 JSON) with offsets into src. */
EMSCRIPTEN_KEEPALIVE int stomp_locate(const char* diags, std::uint32_t m, const char16_t* src, std::uint32_t n) {
  try {
    put_json(finish_diags(diags_from(stomp::json::parse(std::string_view(diags, m))), std::u16string_view(src, n)));
    return 0;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

/** The engine's constants: { D (drawing defaults), UNIT_MM, HOOKS: { name: { kind, args } } }. */
EMSCRIPTEN_KEEPALIVE int stomp_constants() {
  try {
    const auto& d = D();
    stomp::json::Value o = stomp::json::object(), dv = stomp::json::object(), units = stomp::json::object(), hooks = stomp::json::object();
    dv.set(u"mask", d.mask);
    dv.set(u"maskDefinedOverlap", d.maskDefinedOverlap);
    dv.set(u"holeMask", d.holeMask);
    dv.set(u"silkW", d.silkW);
    dv.set(u"silkClear", d.silkClear);
    dv.set(u"silkOffset", d.silkOffset);
    dv.set(u"fabW", d.fabW);
    dv.set(u"crtW", d.crtW);
    dv.set(u"dot", d.dot);
    dv.set(u"tol", d.tol);
    for (const char16_t* u : {u"mm", u"um", u"nm", u"mil", u"in"}) units.set(u, unit_mm(u));
    for (const auto& h : hooks_table()) {
      stomp::json::Value e = stomp::json::object(), args = stomp::json::array();
      e.set(u"kind", h.kind);
      for (const auto& a : h.args) args.push(a);
      e.set(u"args", std::move(args));
      hooks.set(h.name, std::move(e));
    }
    o.set(u"D", std::move(dv));
    o.set(u"UNIT_MM", std::move(units));
    o.set(u"HOOKS", std::move(hooks));
    out = stomp::json::write(o);
    return 0;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

/** A file's items, for tools and tests: [{ type, name, params: [{ name, def }] }]. */
EMSCRIPTEN_KEEPALIVE int stomp_outline(const char16_t* src, std::uint32_t n) {
  try {
    stomp::Diags diags;
    const stomp::Lexed lx = stomp::lex(std::u16string_view(src, n), &diags);
    const ObjP ast = stomp::parse(lx.stream, diags);
    stomp::ArrP items = stomp::list();
    for (const Val& iv : ast->get(stomp::K_items).arr()->a) {
      const auto& it = *iv.obj();
      ObjP o = stomp::rec({{stomp::K_type, it.get(stomp::K_type)}, {stomp::K_name, it.get(stomp::K_name).is_str() ? it.get(stomp::K_name) : Val(nullptr)}});
      if (it.get(stomp::K_params).is_arr()) {
        stomp::ArrP ps = stomp::list();
        for (const Val& q : it.get(stomp::K_params).arr()->a)
          ps->a.push_back(stomp::rec({{stomp::K_name, q.obj()->get(stomp::K_name)}, {stomp::K_def, q.obj()->get(stomp::K_def).truthy()}}));
        o->set(stomp::K_params, ps);
      }
      items->a.push_back(o);
    }
    put_json(items);
    return 0;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

/** The lexer's and parser's problems with a text: [{ severity, message, s, e }]. */
EMSCRIPTEN_KEEPALIVE int stomp_syntax(const char16_t* src, std::uint32_t n) {
  try {
    stomp::Diags diags;
    const stomp::Lexed lx = stomp::lex(std::u16string_view(src, n), &diags);
    stomp::parse(lx.stream, diags);
    stomp::ArrP out_ = stomp::list();
    for (const auto& d : diags)
      out_->a.push_back(stomp::rec({{stomp::K_severity, d.severity == stomp::Severity::Error ? u"error" : u"warning"},
                                     {stomp::K_message, d.message},
                                     {stomp::K_s, static_cast<double>(d.s)},
                                     {stomp::K_e, static_cast<double>(d.e)}}));
    put_json(out_);
    return 0;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

/** KiCad's encodings, for the tests: 0 checksum (text), 1 MurmurHash3 x64 (16 bytes), 2 zstd frame, 3 base64 (text). */
EMSCRIPTEN_KEEPALIVE int stomp_encode(int op, const std::uint8_t* bytes, std::uint32_t n, std::uint32_t seed) {
  try {
    const std::span<const std::uint8_t> in(bytes, n);
    if (op == 0) out = stomp::encode::kicad_checksum(in, seed);
    else if (op == 1) {
      const auto h = stomp::encode::murmur3x64(in, seed);
      out.assign(h.begin(), h.end());
    } else if (op == 2) {
      const auto f = stomp::encode::zstd_frame(in);
      out.assign(f.begin(), f.end());
    } else out = stomp::encode::base64(in);
    return 0;
  } catch (const std::exception& e) {
    return fail(e.what());
  }
}

EMSCRIPTEN_KEEPALIVE const float* stomp_outF_ptr() { return outF.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_outF_len() { return static_cast<std::uint32_t>(outF.size()); }

}  // extern "C"
