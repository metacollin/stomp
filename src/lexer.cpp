// The lexer: a port of demo/js/lexer.js, branch for branch, so both give the same tokens
// and the same messages (tests/compare checks).
#include "lexer.hpp"

#include <algorithm>
#include <unordered_set>

#include "jsrt.hpp"

namespace stomp {

namespace {

using U = std::u16string;
using V = std::u16string_view;

const std::unordered_set<U>& reserved() {
  static const std::unordered_set<U> set = [] {
    const char* words =
        "above across align and arc assembly at auto ball balls bar below between "
        "bga body bottom bottom-left bottom-right box castellated ccw center centered "
        "centers chamfer circle col-major color cols column copper courtyard coverage cw "
        "cylinder d datasheet default defined deg delete density description "
        "dimple divide dot down draft drill dshape dual end endcap extends feature fill flat "
        "footprint footprints from gap going grid group gullwing gutter h height hole "
        "horizontal horizontally in inner is jlead layer lbend lead leads least left "
        "length line manufacturer mask mil mirrors mm model most mpn name nc nm no "
        "nominal none notch numbering of offset omit on only origin outer outline "
        "oval pad pads paste pin pin1 pins pitch polarized polygon quad r rad "
        "rect ref refdes right rotate roundrect row row-major rows scale shape "
        "side silk single size slot span standoff start step straight stripe tab tags "
        "template text thermal thickness tht to top top-left top-right um units up value "
        "vertical vertically vias wire with width x y zigzag "
        "section loft sweep prism sphere disc face slab hatch";
    std::unordered_set<U> out;
    U w;
    for (const char* p = words;; ++p) {
      if (*p == ' ' || *p == 0) {
        if (!w.empty()) out.insert(w);
        w.clear();
        if (*p == 0) break;
      } else {
        w.push_back(static_cast<char16_t>(*p));
      }
    }
    return out;
  }();
  return set;
}

// words that start a top-level item: an unclosed `(` stops swallowing newlines there
bool is_reset(V w) { return w == u"end" || w == u"footprint" || w == u"footprints" || w == u"template"; }

const V HYPHENATED[] = {u"row-major", u"col-major", u"top-left", u"top-right", u"bottom-left", u"bottom-right"};
bool is_unit(V w) { return w == u"mm" || w == u"um" || w == u"nm" || w == u"mil" || w == u"in"; }
bool is_angle(V w) { return w == u"deg" || w == u"rad"; }

struct Suffix {
  bool ok = false;
  U unit;               // empty with has_unit false: none
  bool has_unit = false;
  char16_t axis = 0;
};
// A number's suffix: a unit or an angle unit, and/or a side mark after any unit (43milw)
Suffix split_suffix(V word) {
  if (is_unit(word) || is_angle(word)) return {true, U(word), true, 0};
  if (word.empty()) return {};
  const char16_t mark = word.back();
  const V unit = word.substr(0, word.size() - 1);
  if ((mark == u'w' || mark == u'h') && (unit.empty() || is_unit(unit))) return {true, U(unit), !unit.empty(), mark};
  return {};
}

bool is_letter_wh(char16_t c) { return c == u'w' || c == u'h'; }

U suffix_hint(V word, V text) {
  if (!word.empty() && word[0] == u'x')
    return U(u"put spaces around the size separator: `") + U(text) + u" x " + (word.size() > 1 ? U(word.substr(1)) : U(u"...")) + u"`";
  // /^([wh])(mm|um|nm|mil|in)$/
  if (word.size() >= 3 && is_letter_wh(word[0]) && is_unit(word.substr(1)))
    return U(u"put the unit before the side mark: `") + U(text) + U(word.substr(1)) + word[0] + u"`";
  // /^mils?[wh]?$/ or mils
  auto mils = [](V w) {
    if (w.substr(0, 3) != u"mil") return false;
    V r = w.substr(3);
    if (!r.empty() && r[0] == u's') r = r.substr(1);
    return r.empty() || (r.size() == 1 && is_letter_wh(r[0]));
  };
  if (mils(word) || word == u"mils") return u"write mils as `mil`";
  if (word == u"inch" || word == u"inches") return u"write inches as `in`";
  // /^(mm|um|nm|mil|in)?[WH]$/
  if (!word.empty() && (word.back() == u'W' || word.back() == u'H') && (word.size() == 1 || is_unit(word.substr(0, word.size() - 1))))
    return u"side marks are lowercase: `w` and `h`";
  return u"units are mm, um, nm, mil and in (angles: deg, rad), and `w` and `h` mark the sides of a size";
}

bool is_punct(char16_t c) {
  switch (c) {
    case u'(': case u')': case u',': case u';': case u':': case u'=': case u'+': case u'-': case u'*': case u'/': return true;
    default: return false;
  }
}
// a newline right after one of these doesn't end a statement (SPEC 4)
bool is_joiner(V v) { return v == u"," || v == u"+" || v == u"-" || v == u"*" || v == u"/"; }

bool is_digit(char16_t c) { return c >= u'0' && c <= u'9'; }
bool is_id_start(char16_t c) { return (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') || c == u'_'; }
bool is_id_char(char16_t c) { return is_id_start(c) || is_digit(c); }
bool is_alpha(char16_t c) { return (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z'); }
// /[0-9.(\s-]/ on src[i] || ' '
bool may_follow_x(V src, std::size_t i) {
  if (i >= src.size()) return true;
  const char16_t c = src[i];
  return is_digit(c) || c == u'.' || c == u'(' || c == u'-' || js::is_space(c);
}

struct Lexer {
  V src;
  Diags* diags;
  Lexed out;
  std::size_t i = 0;
  int line = 1;
  std::size_t line_start = 0;

  char16_t at(std::size_t k) const { return k < src.size() ? src[k] : 0; }
  void report(U msg, Offset s, Offset e) {
    if (diags) diags->push_back(Diag{Severity::Error, std::move(msg), s, e, true});
  }
  Token& tok(Tok t, std::size_t s, std::size_t e) {
    Token k;
    k.t = t;
    k.s = static_cast<Offset>(s);
    k.e = static_cast<Offset>(e);
    k.line = line;
    k.col = static_cast<Offset>(s - line_start + 1);
    out.all.push_back(std::move(k));
    return out.all.back();
  }

  void run() {
    const std::size_t n = src.size();
    while (i < n) {
      const char16_t c = src[i];
      const std::size_t s = i;
      if (c == u' ' || c == u'\t' || c == u'\r') { ++i; continue; }
      if (c == u'\n') {
        tok(Tok::Nl, s, s + 1);
        ++i; ++line; line_start = i;
        continue;
      }
      if (c == u'#') {
        while (i < n && src[i] != u'\n') ++i;
        tok(Tok::Comment, s, i).v = U(src.substr(s, i - s));
        continue;
      }
      if (c == u'"') { string(s); continue; }
      if (is_digit(c) || (c == u'.' && is_digit(at(i + 1)))) { number(s); continue; }
      if (is_id_start(c)) {
        while (i < n && is_id_char(src[i])) ++i;
        U word(src.substr(s, i - s));
        if (at(i) == u'-') {
          for (V h : HYPHENATED) {
            if (h.substr(0, word.size() + 1) == word + u"-" && src.substr(s, h.size()) == h && !is_id_char(at(s + h.size()))) {
              word = U(h);
              i = s + h.size();
              break;
            }
          }
        }
        Token& k = tok(Tok::Word, s, i);
        k.kw = reserved().count(word) != 0;
        k.v = std::move(word);
        continue;
      }
      if (c == u'.' && at(i + 1) == u'.') { i += 2; tok(Tok::P, s, i).v = u".."; continue; }
      if (c == u'{' || c == u'}') {
        ++i;
        report(c == u'{' ? U(u"stomp has no braces: a block starts on the line after its header, and closes with `end`") : U(u"close a block with `end`, not `}`"),
               static_cast<Offset>(s), static_cast<Offset>(i));
        Token& k = tok(Tok::Bad, s, i);
        k.v = U(1, c);
        k.brace = c;
        continue;
      }
      if (is_punct(c)) { ++i; tok(Tok::P, s, i).v = U(1, c); continue; }
      // anything else
      ++i;
      if (c > 127) {
        while (i < n && src[i] > 127 && src[i] != u'\n') ++i;
        report(u"non-ASCII text is only allowed inside \"strings\" and # comments", static_cast<Offset>(s), static_cast<Offset>(i));
      } else {
        report(U(u"unexpected character `") + c + u"`", static_cast<Offset>(s), static_cast<Offset>(i));
      }
      tok(Tok::Bad, s, i).v = U(src.substr(s, i - s));
    }
    out.eof.t = Tok::Eof;
    out.eof.s = out.eof.e = static_cast<Offset>(n);
    out.eof.line = line;
    out.eof.col = static_cast<Offset>(n - line_start + 1);
    build_stream();
  }

  // interpolation: "text {expr} text {expr:.2}" (SPEC 7); \" \\ \{ \} are escapes
  void string(std::size_t s) {
    const std::size_t n = src.size();
    U lit;
    std::size_t lit_s = i + 1;
    std::shared_ptr<std::vector<StrPart>> parts;
    ++i;
    bool closed = false;
    while (i < n && src[i] != u'\n') {
      const char16_t ch = src[i];
      const char16_t nx = at(i + 1);
      if (ch == u'\\' && (nx == u'"' || nx == u'\\' || nx == u'{' || nx == u'}')) { lit += nx; i += 2; continue; }
      if (ch == u'"') { closed = true; ++i; break; }
      if (ch == u'{') {
        const std::size_t open = i;
        std::size_t j = i + 1;
        while (j < n && src[j] != u'}' && src[j] != u'"' && src[j] != u'\n') ++j;
        if (at(j) != u'}' || j >= n) {
          report(u"unclosed `{` in a string — close it with `}`, or write a literal brace as `\\{`", static_cast<Offset>(open), static_cast<Offset>(j));
          lit += U(src.substr(open, j - open));
          i = j;
          continue;
        }
        const V inner = src.substr(open + 1, j - open - 1);
        const std::size_t colon = inner.rfind(u':');
        std::size_t code_e = j;
        int fmt = -1;
        Offset fmt_s = -1;
        if (colon != V::npos) {
          code_e = open + 1 + colon;
          fmt_s = static_cast<Offset>(code_e);
          const U spec = js::trim(inner.substr(colon + 1));
          if (spec.size() == 2 && spec[0] == u'.' && is_digit(spec[1])) fmt = spec[1] - u'0';
          else report(U(u"unknown format `:") + spec + u"` — use `:.N` for N decimal places, e.g. `{e:.2}`", fmt_s, static_cast<Offset>(j));
        }
        if (js::trim(src.substr(open + 1, code_e - open - 1)).empty())
          report(u"empty `{}` in a string — put an expression inside, or write `\\{\\}` for literal braces", static_cast<Offset>(open), static_cast<Offset>(j + 1));
        if (!parts) parts = std::make_shared<std::vector<StrPart>>();
        if (!lit.empty()) {
          StrPart p;
          p.lit = lit;
          p.s = static_cast<Offset>(lit_s);
          p.e = static_cast<Offset>(open);
          parts->push_back(std::move(p));
        }
        lit.clear();
        StrPart code;
        code.is_lit = false;
        code.open = static_cast<Offset>(open);
        code.close = static_cast<Offset>(j);
        code.code_s = static_cast<Offset>(open + 1);
        code.code_e = static_cast<Offset>(code_e);
        code.fmt = fmt;
        code.fmt_s = fmt_s;
        lex_range(open + 1, code_e, code);
        parts->push_back(std::move(code));
        i = j + 1;
        lit_s = i;
        continue;
      }
      lit += ch;
      ++i;
    }
    if (!closed) report(u"unterminated string — add a closing \"", static_cast<Offset>(s), static_cast<Offset>(i));
    if (parts && !lit.empty()) {
      StrPart p;
      p.lit = lit;
      p.s = static_cast<Offset>(lit_s);
      p.e = static_cast<Offset>(closed ? i - 1 : i);
      parts->push_back(std::move(p));
    }
    Token& k = tok(Tok::Str, s, i);
    if (parts) { k.v_null = true; k.parts = std::move(parts); }
    else k.v = std::move(lit);
  }

  /** Lex src[a, b) (the code inside a string's {...}) with absolute offsets. */
  void lex_range(std::size_t a, std::size_t b, StrPart& part) {
    Diags sub;
    Lexed r = lex(src.substr(a, b - a), &sub);
    for (auto& d : sub) {
      d.s += static_cast<Offset>(a);
      d.e += static_cast<Offset>(a);
      if (diags) diags->push_back(std::move(d));
    }
    auto shift = [&](Token& k) {
      k.s += static_cast<Offset>(a);
      k.e += static_cast<Offset>(a);
      k.line = line;
      k.col = k.s - static_cast<Offset>(line_start) + 1;
    };
    for (auto& k : r.all) shift(k);
    for (auto& k : r.stream) {
      if (k.t == Tok::Eof || k.t == Tok::Nl) continue;
      if (k.all_index >= 0) part.toks.push_back(r.all[static_cast<std::size_t>(k.all_index)]);
      else { shift(k); part.toks.push_back(k); }
    }
    for (auto& k : r.all)
      if (k.t != Tok::Nl) part.all.push_back(k);
    for (auto& k : part.toks) k.all_index = -1;
  }

  void number(std::size_t s) {
    const std::size_t n = src.size();
    const char16_t c = src[i];
    while (i < n && is_digit(src[i])) ++i;
    bool is_int = c != u'.';
    if (c == u'.') {                                          // .5
      ++i;
      while (i < n && is_digit(src[i])) ++i;
      is_int = false;
    } else if (at(i) == u'.' && at(i + 1) != u'.') {          // 1.25 / 1.  (but 1..4 is INT '..' INT)
      ++i;
      while (i < n && is_digit(src[i])) ++i;
      is_int = false;
    }
    // an exponent: 1e-9, 2.5E3
    if ((at(i) == u'e' || at(i) == u'E') && (is_digit(at(i + 1)) || ((at(i + 1) == u'-' || at(i + 1) == u'+') && is_digit(at(i + 2))))) {
      i += (at(i + 1) == u'-' || at(i + 1) == u'+') ? 2 : 1;
      while (i < n && is_digit(src[i])) ++i;
      is_int = false;
    }
    const U text(src.substr(s, i - s));
    const double value = js::parse_float(text[0] == u'.' ? u"0" + text : text);
    auto num_token = [&](std::size_t e) -> Token& {
      Token& k = tok(Tok::Num, s, e);
      k.value = value;
      k.text = U(src.substr(s, e - s));
      k.num = text;
      return k;
    };
    if (at(i) == u'%') {
      ++i;
      Token& k = num_token(i);
      k.suffix = u"%";
      k.has_suffix = true;
      k.is_int = false;
      return;
    }
    if (at(i) == u'x' && may_follow_x(src, i + 1)) {
      // `0.6x1.5`: the size separator can touch the number, so emit it as its own keyword token
      Token& k = num_token(i);
      k.is_int = is_int;
      k.has_axis_key = false;
      Token& x = tok(Tok::Word, i, i + 1);
      x.v = u"x";
      x.kw = true;
      ++i;
      return;
    }
    if (i < n && is_id_start(src[i])) {
      const std::size_t ss = i;
      std::size_t j = i;
      while (j < n && is_alpha(src[j])) ++j;
      V word = src.substr(ss, j - ss);
      Suffix touching;
      if (word.size() > 1 && word.back() == u'x') touching = split_suffix(word.substr(0, word.size() - 1));
      if (touching.ok && may_follow_x(src, j)) {
        // `1.1wx1.6h`, `0.6mmx1.5`: the separator touches a suffix
        i = j - 1;
        Token& k = num_token(i);
        k.suffix = touching.unit;
        k.has_suffix = touching.has_unit;
        k.axis = touching.axis;
        k.is_int = false;
        Token& x = tok(Tok::Word, i, i + 1);
        x.v = u"x";
        x.kw = true;
        ++i;
        return;
      }
      while (j < n && is_id_char(src[j])) ++j;
      word = src.substr(ss, j - ss);
      i = j;
      const Suffix sf = split_suffix(word);
      if (!sf.ok) {
        report(U(u"unknown suffix `") + U(word) + u"` on number " + text + u" — " + suffix_hint(word, text),
               static_cast<Offset>(ss), static_cast<Offset>(i));
        tok(Tok::Bad, s, i).v = U(src.substr(s, i - s));
        return;
      }
      Token& k = num_token(i);
      k.suffix = sf.unit;
      k.has_suffix = sf.has_unit;
      k.axis = sf.axis;
      k.is_int = false;
      return;
    }
    num_token(i).is_int = is_int;
  }

  // the parser's stream
  void build_stream() {
    int depth = 0;
    std::ptrdiff_t prev_at = -1;   // an index: the vector grows
    for (std::size_t idx = 0; idx < out.all.size(); ++idx) {
      Token k = out.all[idx];
      k.all_index = static_cast<int>(idx);
      if (k.t == Tok::Comment) continue;
      if (k.t == Tok::Bad) {
        if (k.brace != u'}') continue;
        Token e;
        e.t = Tok::Word;
        e.v = u"end";
        e.kw = true;
        e.s = k.s;
        e.e = k.e;
        e.line = k.line;
        e.col = k.col;
        e.from_brace = true;
        e.all_index = -1;
        k = std::move(e);
      }
      if (k.t == Tok::Nl) {
        const Token* prev = prev_at >= 0 ? &out.stream[static_cast<std::size_t>(prev_at)] : nullptr;
        if (depth > 0) continue;
        if (prev && prev->t == Tok::P && is_joiner(prev->v)) continue;
        if (prev && prev->t == Tok::Nl) continue;        // collapse blank lines
        if (!prev) continue;                             // leading newlines
      }
      if (k.t == Tok::P && k.v == u"(") ++depth;
      if (k.t == Tok::P && k.v == u")" && depth > 0) --depth;
      // parentheses never span blocks; resetting keeps an unclosed '(' typed mid-edit
      // from swallowing the newlines of the rest of the file
      if (k.t == Tok::Word && is_reset(k.v)) depth = 0;
      out.stream.push_back(std::move(k));
      prev_at = static_cast<std::ptrdiff_t>(out.stream.size()) - 1;
    }
    Token e = out.eof;
    e.all_index = -1;
    out.stream.push_back(std::move(e));
  }
};

}  // namespace

Lexed lex(std::u16string_view src, Diags* diags) {
  Lexer l{src, diags, {}};
  l.out.all.reserve(src.size() / 3 + 8);
  l.run();
  return std::move(l.out);
}

bool is_reserved(std::u16string_view word) { return reserved().count(U(word)) != 0; }

}  // namespace stomp
