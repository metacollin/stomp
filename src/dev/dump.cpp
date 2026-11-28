#include "dump.hpp"

#include <stomp/stomp.hpp>

#include <functional>
#include <stdexcept>
#include <unordered_set>

#include "../compile/compile.hpp"
#include "../jsrt.hpp"
#include "../kicad.hpp"
#include "../model3d.hpp"
#include "sha256.hpp"
#include "../parser.hpp"

namespace stomp::dev {

namespace {

using json::Value;

const char16_t* tok_name(Tok t) {
  switch (t) {
    case Tok::Word: return u"word";
    case Tok::Num: return u"num";
    case Tok::Str: return u"str";
    case Tok::P: return u"p";
    case Tok::Nl: return u"nl";
    case Tok::Comment: return u"comment";
    case Tok::Bad: return u"bad";
    case Tok::Eof: return u"eof";
  }
  return u"?";
}

Value str_or_null(bool present, const std::u16string& s) { return present ? Value(s) : Value(nullptr); }

Value part_json(const StrPart& p) {
  Value o = json::object();
  if (p.is_lit) {
    o.set(u"lit", p.lit);
    o.set(u"s", static_cast<double>(p.s));
    o.set(u"e", static_cast<double>(p.e));
    return o;
  }
  o.set(u"open", static_cast<double>(p.open));
  o.set(u"close", static_cast<double>(p.close));
  o.set(u"codeS", static_cast<double>(p.code_s));
  o.set(u"codeE", static_cast<double>(p.code_e));
  o.set(u"fmt", p.fmt < 0 ? Value(nullptr) : Value(p.fmt));
  o.set(u"fmtS", p.fmt_s < 0 ? Value(nullptr) : Value(static_cast<double>(p.fmt_s)));
  Value toks = json::array(), all = json::array();
  for (const auto& k : p.toks) toks.push(token_json(k));
  for (const auto& k : p.all) all.push(token_json(k));
  o.set(u"toks", std::move(toks));
  o.set(u"all", std::move(all));
  return o;
}

}  // namespace

Value token_json(const Token& k) {
  Value o = json::object();
  o.set(u"t", tok_name(k.t));
  o.set(u"s", static_cast<double>(k.s));
  o.set(u"e", static_cast<double>(k.e));
  o.set(u"line", k.line);
  o.set(u"col", static_cast<double>(k.col));
  switch (k.t) {
    case Tok::Word:
      o.set(u"v", k.v);
      o.set(u"kw", k.kw);
      if (k.from_brace) o.set(u"brace", true);
      break;
    case Tok::Num:
      o.set(u"v", k.value);
      o.set(u"text", k.text);
      o.set(u"num", k.num);
      o.set(u"suffix", str_or_null(k.has_suffix, k.suffix));
      if (k.has_axis_key) o.set(u"axis", k.axis ? Value(std::u16string(1, k.axis)) : Value(nullptr));
      o.set(u"isInt", k.is_int);
      break;
    case Tok::Str: {
      o.set(u"v", k.v_null ? Value(nullptr) : Value(k.v));
      if (k.parts) {
        Value parts = json::array();
        for (const auto& p : *k.parts) parts.push(part_json(p));
        o.set(u"parts", std::move(parts));
      } else {
        o.set(u"parts", nullptr);
      }
      break;
    }
    case Tok::P:
    case Tok::Comment:
      o.set(u"v", k.v);
      break;
    case Tok::Bad:
      o.set(u"v", k.v);
      if (k.brace) o.set(u"brace", std::u16string(1, k.brace));
      break;
    case Tok::Nl:
    case Tok::Eof:
      break;
  }
  return o;
}

/** A syntax diagnostic as a record: {severity, message, s, e, syntax: true}. */
Val diag_val(const Diag& d) {
  return rec({{K_severity, d.severity == Severity::Error ? u"error" : u"warning"}, {K_message, d.message},
              {K_s, static_cast<double>(d.s)}, {K_e, static_cast<double>(d.e)}, {K_syntax, true}});
}

Value syntax_diag_json(const Diag& d) {
  Value o = json::object();
  o.set(u"severity", d.severity == Severity::Error ? u"error" : u"warning");
  o.set(u"message", d.message);
  o.set(u"s", static_cast<double>(d.s));
  o.set(u"e", static_cast<double>(d.e));
  o.set(u"syntax", true);
  return o;
}

namespace {

/** Everything reachable from the AST: what the harness prints as {type, s, e} inside results. */
std::unordered_set<const Obj*> ast_objects(const ObjP& ast) {
  std::unordered_set<const Obj*> set;
  std::function<void(const Val&)> walk = [&](const Val& v) {
    if (v.is_obj()) {
      const Obj* o = v.obj().get();
      if (!set.insert(o).second) return;
      for (const auto& f : o->f) walk(f.second);
    } else if (v.is_arr()) {
      for (const auto& x : v.arr()->a) walk(x);
    }
  };
  walk(ast);
  return set;
}

std::vector<compiler::LibFile> library_of(const json::Value* stdlib) {
  std::vector<compiler::LibFile> files;
  if (stdlib && stdlib->is_array()) {
    for (const auto& f : stdlib->array()) {
      const json::Value* name = f.get(u"file");
      const json::Value* source = f.get(u"source");
      files.push_back({name && name->is_string() ? name->string() : std::u16string(), source && source->is_string() ? source->string() : std::u16string()});
    }
  }
  return files;
}

std::string view_text(const compiler::Compiled& out, bool full) {
  const auto set = ast_objects(out.ast);
  const Summarize isAst = [&](const Obj& o) {
    if (set.count(&o)) return true;
    const Val& s = o.get(K_s);
    return s.is_num() && s.num() >= 1e9;
  };
  ArrP fps = list();
  for (std::size_t i = 0; i < out.footprints->a.size(); ++i) {
    auto f = std::make_shared<Obj>(*out.footprints->a[i].obj());
    const auto& r = out.results[i];
    if (full && r) f->set(K_result, r->full());
    fps->a.push_back(f);
  }
  const Val view = rec({{K_diagnostics, out.diagnostics},
                        {K_footprints, fps},
                        {K_templates, out.templates},
                        {K_tables, out.tables},
                        {K_library, rec({{K_diagnostics, out.libraryDiagnostics}})}});
  return canon(view, &isAst);
}

std::string compile_view(std::u16string_view src, const json::Value* stdlib, bool full) {
  const auto files = library_of(stdlib);
  compiler::Options opts;
  opts.cache = false;
  if (stdlib && stdlib->is_array()) opts.stdlib = &files;
  return view_text(compiler::compile(src, opts), full);
}

/** The cache layer: src is a JSON array of sources, compiled in turn with the cache on. Each
 *  line: which footprints reused an earlier result, then the compile's core view. */
std::string cache_view(std::u16string_view src, const json::Value* stdlib) {
  const json::Value seq = json::parse(std::string_view(js::narrow(src)));
  const auto files = library_of(stdlib);
  compiler::Options opts;
  if (stdlib && stdlib->is_array()) opts.stdlib = &files;
  compiler::clear_cache();
  std::unordered_set<const compiler::Result*> seen;
  std::string text;
  bool first = true;
  for (const auto& s : seq.array()) {
    const compiler::Compiled out = compiler::compile(s.string(), opts);
    std::string hits = "[";
    for (std::size_t i = 0; i < out.results.size(); ++i) {
      if (i) hits += ',';
      hits += out.results[i] && seen.count(out.results[i].get()) ? '1' : '0';
    }
    hits += ']';
    for (const auto& r : out.results)
      if (r) seen.insert(r.get());
    if (!first) text += '\n';
    first = false;
    text += hits + view_text(out, false);
  }
  compiler::clear_cache();
  return text;
}

}  // namespace

std::string dump(std::string_view layer, std::u16string_view src, const json::Value* stdlib) {
  if (layer == "core") return compile_view(src, stdlib, false);
  if (layer == "cache") return cache_view(src, stdlib);
  if (layer == "models" || layer == "models-full") {
    // each footprint's model and board, and its exports, as digests (or in full)
    const bool full = layer == "models-full";
    const auto files = library_of(stdlib);
    compiler::Options opts;
    opts.cache = false;
    if (stdlib && stdlib->is_array()) opts.stdlib = &files;
    const compiler::Compiled out = compiler::compile(src, opts);
    const auto bytes = [](const std::string& t) { return std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(t.data()), t.size()); };
    const auto sha = [&](const std::string& t) { return sha256_hex(bytes(t)).substr(0, 16); };
    const auto h = [&](const std::string& t) { return full ? t : sha(t); };
    Value rows = json::array();
    for (std::size_t i = 0; i < out.results.size(); ++i) {
      const std::u16string& name = out.footprints->a[i].obj()->get(K_name).str();
      Value row = json::object();
      row.set(u"name", name);
      const auto& r = out.results[i];
      if (!r) {
        row.set(u"none", true);
        rows.push(std::move(row));
        continue;
      }
      try {
        const model3d::Model model = model3d::build(*r);
        const ObjP res = r->full();
        const model3d::Model board = model3d::board(res, &model);
        std::string vrmlNamed;
        const bool embed = !model.none && !model.meshes.empty();
        if (embed) vrmlNamed = model3d::to_vrml(model, kicad::safe_name(name));
        const kicad::Footprint ki = kicad::footprint(res, name, embed ? &vrmlNamed : nullptr);
        row.set(u"model", from_utf8(h(json::canon(model3d::to_json(model)))));
        row.set(u"board", from_utf8(h(json::canon(model3d::to_json(board)))));
        row.set(u"kicad", from_utf8(h(js::narrow(ki.text))));
        row.set(u"vrml", from_utf8(h(model.none ? std::string() : model3d::to_vrml(model, u""))));
        const auto stl = model3d::to_stl(model, u"");
        row.set(u"stl", model.none ? std::u16string() : from_utf8(sha256_hex(stl).substr(0, 16)));
      } catch (const std::exception& e) {
        row = json::object();
        row.set(u"name", name);
        row.set(u"error", from_utf8(e.what()));
      }
      rows.push(std::move(row));
    }
    return json::write(rows);
  }
  if (layer == "kicad") {
    // each footprint's KiCad text, without its 3D model (as UTF-8)
    const auto files = library_of(stdlib);
    compiler::Options opts;
    opts.cache = false;
    if (stdlib && stdlib->is_array()) opts.stdlib = &files;
    const compiler::Compiled out = compiler::compile(src, opts);
    std::u16string text;
    for (std::size_t i = 0; i < out.results.size(); ++i) {
      const std::u16string& name = out.footprints->a[i].obj()->get(K_name).str();
      if (out.results[i]) text += kicad::footprint(out.results[i]->full(), name, nullptr).text;
      else text += u"(none " + name + u")\n";
    }
    return js::narrow(text);
  }
  if (layer == "compile") return compile_view(src, stdlib, true);
  if (layer == "lex") {
    Diags diags;
    const Lexed lx = lex(src, &diags);
    Value all = json::array(), stream = json::array(), ds = json::array();
    for (const auto& k : lx.all) all.push(token_json(k));
    for (const auto& k : lx.stream) stream.push(k.all_index >= 0 ? Value(k.all_index) : token_json(k));
    for (const auto& d : diags) ds.push(syntax_diag_json(d));
    Value o = json::object();
    o.set(u"all", std::move(all));
    o.set(u"stream", std::move(stream));
    o.set(u"eof", token_json(lx.eof));
    o.set(u"diags", std::move(ds));
    return json::canon(o);
  }
  if (layer == "parse") {
    // the parser's view: the lexer's problems aren't part of it (tests/compare/js-engine.cjs)
    Diags lex_diags, diags;
    const Lexed lx = lex(src, &lex_diags);
    const ObjP ast = parse(lx.stream, diags);
    auto ds = list();
    for (const auto& d : diags) ds->a.push_back(diag_val(d));
    return canon(Val(rec({{K_ast, ast}, {K_diags, ds}})));
  }
  throw std::runtime_error("layer " + std::string(layer) + " isn't ported yet");
}

}  // namespace stomp::dev
