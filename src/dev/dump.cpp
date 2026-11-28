#include "dump.hpp"

#include <stdexcept>

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

Value syntax_diag_json(const Diag& d) {
  Value o = json::object();
  o.set(u"severity", d.severity == Severity::Error ? u"error" : u"warning");
  o.set(u"message", d.message);
  o.set(u"s", static_cast<double>(d.s));
  o.set(u"e", static_cast<double>(d.e));
  o.set(u"syntax", true);
  return o;
}

std::string dump(std::string_view layer, std::u16string_view src, const json::Value*) {
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
  throw std::runtime_error("layer " + std::string(layer) + " isn't ported yet");
}

}  // namespace stomp::dev
