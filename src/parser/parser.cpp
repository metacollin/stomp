// The parser: demo/js/parser.js, production by production, on PEGTL (context.hpp).
// Each function names the parser.js method it follows; the nodes have the same fields.
#include "../parser.hpp"

#include <cmath>
#include <functional>
#include <numbers>

#include "../jsrt.hpp"
#include "../suggest.hpp"
#include "context.hpp"

namespace stomp::parser {

namespace {

bool among(V v, std::initializer_list<V> set) {
  for (V x : set)
    if (x == v) return true;
  return false;
}
bool hard(V v) { return v == u"x" || v == u"end"; }

const std::initializer_list<V> SHAPES = {u"rect", u"oval", u"roundrect", u"dshape", u"circle", u"polygon"};
const std::initializer_list<V> KINDS = {u"pad", u"hole", u"row", u"group", u"ball"};
const std::initializer_list<V> SIDE_WORDS = {u"left", u"right", u"top", u"bottom"};
const std::initializer_list<V> ANCHORS = {u"center", u"inner", u"outer", u"left", u"right", u"top", u"bottom"};
const std::initializer_list<V> UNITS = {u"mm", u"um", u"nm", u"mil", u"in"};
const std::initializer_list<V> LEAD_FORMS = {u"gullwing", u"jlead", u"lbend", u"straight", u"flat", u"endcap",
                                             u"ball", u"column", u"pin", u"wire", u"tab", u"castellated"};
const std::initializer_list<V> ARRANGEMENTS = {u"dual", u"quad", u"horizontal", u"vertical"};
const std::initializer_list<V> SCHEMES = {u"ccw", u"cw", u"zigzag", u"row-major", u"col-major", u"bga"};
const std::initializer_list<V> CORNERS = {u"top-left", u"top-right", u"bottom-left", u"bottom-right"};
const std::initializer_list<V> PAD_PROPS = {u"drill", u"rotate", u"mask", u"paste", u"vias"};
const std::initializer_list<V> PAD_KEYS = {u"shape", u"size", u"width", u"length", u"drill", u"rotate", u"mask", u"paste", u"vias"};
const std::initializer_list<V> SOLIDS = {u"box", u"cylinder", u"sphere", u"disc", u"prism", u"face", u"loft", u"sweep", u"wire", u"slab"};
const std::initializer_list<V> GFX = {u"outline", u"line", u"arc", u"circle", u"rect", u"polygon", u"hatch", u"text"};
const std::initializer_list<V> FILLED = {u"circle", u"rect", u"polygon"};
const std::initializer_list<V> CLEARED = {u"outline", u"line", u"arc", u"rect", u"polygon", u"hatch"};
// words that begin a footprint statement (for recovery and hints)
const std::vector<U> STMT_WORDS = {
    u"description", u"datasheet", u"manufacturer", u"mpn", u"refdes", u"tags", u"origin", u"body", u"pins",
    u"balls", u"lead", u"thermal", u"span", u"gap", u"pitch", u"density", u"omit", u"only", u"pin1", u"polarized",
    u"default", u"pad", u"pads", u"hole", u"delete", u"row", u"group", u"align", u"silk", u"courtyard", u"assembly",
    u"text", u"model", u"no", u"name", u"footprint", u"footprints", u"template", u"units", u"feature",
    u"outline", u"line", u"arc", u"circle", u"rect", u"polygon", u"hatch"};
bool stmt_word(V v) { return std::find(STMT_WORDS.begin(), STMT_WORDS.end(), v) != STMT_WORDS.end(); }
const std::initializer_list<V> KEY_STMTS = {u"units", u"description", u"datasheet", u"manufacturer", u"mpn", u"refdes",
                                            u"tags", u"name", u"density", u"pin1", u"silk", u"assembly", u"courtyard"};
const std::initializer_list<V> MEASURES = {u"span", u"gap", u"pitch"};
bool model_word(V v) {
  return among(v, {u"standoff", u"height", u"draft", u"body", u"leads", u"pin1", u"step", u"feature"}) || among(v, SOLIDS);
}
// every word that takes a colon somewhere, for "did you mean" hints
const std::vector<U> KEYS = {
    u"units", u"description", u"datasheet", u"manufacturer", u"mpn", u"refdes", u"tags", u"name", u"density", u"pin1",
    u"silk", u"assembly", u"courtyard", u"span", u"gap", u"pitch", u"numbering", u"start", u"pad", u"flat", u"drill",
    u"rotate", u"mask", u"paste", u"vias", u"gutter", u"coverage", u"size", u"width", u"length", u"shape", u"offset",
    u"layer", u"standoff", u"height", u"draft", u"color", u"thickness", u"below", u"above", u"step", u"scale", u"kind",
    u"segments", u"fillet", u"going"};

U bq(V v) { return U(u"`") + U(v) + u"`"; }

U describe(const Token& k) {
  switch (k.t) {
    case Tok::Nl: return u"end of line";
    case Tok::Eof: return u"end of file";
    case Tok::Str: return k.parts ? U(u"a string") : U(u"\"") + k.v + u"\"";
    case Tok::Num: return bq(k.text);
    default: return bq(k.v);
  }
}
U hard_name(V v) {
  return v == u"x" ? U(u"`x` separates the sides of a size, so it can't be a name") : U(u"`end` closes a block, so it can't be a name");
}
U num_text(double n) { return js::to_u16string(n); }

// Fields of record values
const Obj& O(const Val& v) { return *v.obj(); }
Offset S(const Val& v) { return static_cast<Offset>(O(v).get(K_s).num()); }
Offset E(const Val& v) { return static_cast<Offset>(O(v).get(K_e).num()); }

}  // namespace

char token_class(const Token& k) {
  switch (k.t) {
    case Tok::Word: return 'w';
    case Tok::Num: return 'n';
    case Tok::Str: return 's';
    case Tok::Nl: return 'L';
    case Tok::Eof: return 'E';
    case Tok::P: return k.v == u".." ? '.' : static_cast<char>(k.v[0]);
    default: return '?';
  }
}

// The token cursor and messages (parser.js 98-186)

const Token& P::expect_p(V v, V what) {
  if (is_p(v)) return advance();
  expected(bq(v) + (what.empty() ? U() : u" " + U(what)));
}

const Token* P::accept_word(V v) {
  if (!is_word(v)) return nullptr;
  if (is_p(u":", 1)) fail_at(bq(v) + u" takes no colon", &peek(1));
  return &advance();
}

const Token& P::expect_word(V v, V what) {
  if (const Token* k = accept_word(v)) return *k;
  expected(bq(v) + (what.empty() ? U() : u" " + U(what)));
}

const Token* P::accept_key(V v) {
  if (!is_word(v)) return nullptr;
  if (is_p(u":", 1)) {
    const Token& k = advance();
    advance();
    return &k;
  }
  if (value_at(1)) missing_colon();
  return nullptr;
}

const Token& P::expect_key(V v, V what) {
  if (is_word(v) && !is_p(u":", 1)) missing_colon();
  if (const Token* k = accept_key(v)) return *k;
  expected(u"`" + U(v) + u":`" + (what.empty() ? U() : u" " + U(what)));
}

bool P::value_at(std::size_t k) const {
  const Token& x = peek(k);
  if (x.t == Tok::Num || x.t == Tok::Str) return true;
  if (x.t == Tok::Word) return !hard(x.v);
  return x.t == Tok::P && (x.v == u"(" || x.v == u"-" || x.v == u"+");
}

void P::missing_colon() {
  const Token& k = cur();
  const Token& nx = peek(1);
  U v = u"…";
  if (nx.t == Tok::Num) v = nx.text;
  else if (nx.t == Tok::Word) v = nx.v;
  else if (nx.t == Tok::Str) v = u"\"…\"";
  else if (nx.t == Tok::P && nx.v == u"(") v = u"(…)";
  else if (nx.t == Tok::P && peek(2).t == Tok::Num) v = nx.v + peek(2).text;
  fail_at(bq(k.v) + u" needs a colon: `" + k.v + u": " + v + u"`", &k);
}

void P::expected(V what, const Token* tok) {
  const Token& k = tok ? *tok : cur();
  if ((k.t == Tok::Nl || k.t == Tok::Eof) && i() > 0) {
    const Token& prev = (*st.toks)[i() - 1];
    throw ParseError{u"expected " + U(what) + u" after " + describe(prev), prev.s, prev.e};
  }
  throw ParseError{u"expected " + U(what) + u", found " + describe(k), k.s, std::max(k.e, k.s + 1)};
}

void P::fail_at(U msg, const Token* tok) {
  const Token& k = tok ? *tok : cur();
  throw ParseError{std::move(msg), k.s, std::max(k.e, k.s + 1)};
}

void P::fail_range(U msg, Offset s, Offset e) { throw ParseError{std::move(msg), s, std::max(e, s + 1)}; }

void P::report(const ParseError& err) { st.diags->push_back(Diag{Severity::Error, err.message, err.s, err.e, true}); }
void P::note(U msg, Offset s, Offset e) { st.diags->push_back(Diag{Severity::Error, std::move(msg), s, e, true}); }

bool P::at_stmt_end(std::size_t k) const {
  const Token& x = peek(k);
  return x.t == Tok::Nl || x.t == Tok::Eof || (x.t == Tok::P && x.v == u";") || (x.t == Tok::Word && x.v == u"end");
}

void P::skip_eos() {
  while (cur().t == Tok::Nl || is_p(u";")) advance();
}

void P::end_stmt() {
  if (st.soft_end) { st.soft_end = false; return; }   // a block in it stopped short of its `end`
  if (at_stmt_end()) return;
  const Token& k = cur();
  if (k.t == Tok::Word && is_p(u":", 1)) {
    std::optional<U> hint;
    if (k.v.size() > 2) hint = suggest(k.v, KEYS);
    fail_at(u"`" + k.v + u":` isn't an option here" + (hint && *hint != k.v ? u" — did you mean `" + *hint + u":`?" : U()), &k);
  }
  fail_at(u"unexpected " + describe(k) + u" — expected the end of the statement");
}

void P::sync() {
  while (!at_stmt_end()) advance();
}

/** `NAME = …` at the start of a statement. */
bool P::is_decl() {
  const Token& k = cur();
  if (k.t != Tok::Word || !is_p(u"=", 1)) return false;
  if (hard(k.v)) fail_at(hard_name(k.v));
  return true;
}

/** `NAME = expr`: a declaration ('Let') or, in a section, a new value ('Set'). */
Val P::decl(V type) {
  const Token& k = advance();
  advance();
  Val x = run<g::expr>();
  return rec({{K_type, type}, {K_name, k.v}, {K_nameS, k.s}, {K_nameE, k.e}, {K_x, x}});
}

/** `let NAME = …`, from before names were declared by `=` alone. */
Val P::old_let(V type) {
  const Token& l = advance();
  const Token& k = cur();
  if (k.t == Tok::Word && !hard(k.v) && is_p(u"=", 1)) {
    note(u"there's no `let`: write `" + k.v + u" = …`", l.s, l.e);
    return decl(type);
  }
  fail_at(u"there's no `let`: write `NAME = value`", &l);
}

// Blocks (parser.js 213-264)

P::Block P::block(const Token& head, V what, const StmtFn& parse_stmt, bool units, const StopFn& stops) {
  const U outer = st.unit;
  struct Restore { State& st; U u; ~Restore() { st.unit = u; } } restore{st, outer};
  return block_body(head, what, parse_stmt, units, stops);
}

P::Block P::block_body(const Token& head, V what, const StmtFn& parse_stmt, bool units, const StopFn& stops) {
  const Offset head_e = prev_end();
  if (!at_stmt_end()) {
    note(u"unexpected " + describe(cur()) + u" — the " + U(what) + u"'s statements go on the lines below", cur().s, std::max(cur().e, cur().s + 1));
    sync();
  }
  Block out;
  skip_eos();
  while (!is_word(u"end")) {
    const Token& k = cur();
    if (k.t == Tok::Eof || starts_top_item() || (stops && stops())) {
      missing_end(head, head_e, what, k);
      st.soft_end = true;
      return out;
    }
    const std::size_t start = i();
    const Val outer_target = st.stmt_target;
    st.stmt_target = nullptr;
    try {
      Val stmt = (units && is_word(u"units") && !is_p(u"=", 1)) ? block_units(out.stmts.size()) : parse_stmt();
      if (stmt.is_obj()) {
        if (!O(stmt).has(K_unit)) stmt.obj()->set(K_unit, st.unit);   // inner statements use the file units too
        out.stmts.push_back(stmt);                                    // kept even if junk follows it
      }
      st.stmt_target = nullptr;
      end_stmt();
    } catch (const ParseError& err) {
      report(err);
      // remember what the broken statement was about, so the evaluator doesn't pile
      // follow-on errors (unplaced / unknown) onto it
      if (st.stmt_target.truthy()) out.stmts.push_back(rec({{K_type, u"Broken"}, {K_target, st.stmt_target}, {K_s, err.s}, {K_e, err.e}}));
      sync();
      if (i() == start) advance();
    }
    st.stmt_target = outer_target;
    skip_eos();
  }
  const Token& close = advance();
  if (close.col < head.col && !st.dedent) st.dedent = Dedent{&head, head_e, U(what), &close};
  out.close = &close;
  return out;
}

/** A block ran out: report its missing `end` at its header. If a block inside it was
 *  closed by an `end` lined up with this one, that block is the culprit. */
void P::missing_end(const Token& head, Offset head_e, V what, const Token& at) {
  if (st.dedent && st.dedent->head->s > head.s && st.dedent->close->col <= head.col) {
    const Dedent d = *st.dedent;
    st.dedent.reset();
    note(u"missing `end` for this " + d.what + u" (the `end` on line " + js::u16(std::to_string(d.close->line)) +
             u" lines up with the " + U(what) + u" on line " + js::u16(std::to_string(head.line)) + u")",
         d.head->s, d.head_e);
    return;
  }
  note(u"missing `end` for this " + U(what) + (at.t == Tok::Eof ? U() : u" before line " + js::u16(std::to_string(at.line))), head.s, head_e);
}

/** Does a top-level item start here (so an open block is missing its `end`)? */
bool P::starts_top_item() {
  const Token& k = cur();
  if (k.t != Tok::Word || is_p(u"=", 1) || is_p(u":", 1)) return false;
  if (k.v == u"footprint" || k.v == u"footprints" || k.v == u"template") return true;
  // `feature NAME (…)` ending its line at the left margin declares a feature; indented,
  // it's a placement missing its `at`
  return k.v == u"feature" && k.col == 1 && feature_decl_ahead();
}

/** `feature NAME [(…)]` and then the end of the line. */
bool P::feature_decl_ahead() const {
  std::size_t j = i() + 1;
  if (j >= n() || (*st.toks)[j].t != Tok::Word) return false;
  ++j;
  if (j < n() && (*st.toks)[j].t == Tok::P && (*st.toks)[j].v == u"(") j = match_paren(j);
  if (j >= n()) return true;
  const Token& q = (*st.toks)[j];
  return q.t == Tok::Nl || q.t == Tok::Eof || (q.t == Tok::P && q.v == u";");
}

/** The index just past the `)` that closes the `(` at index j (or the line's end). */
std::size_t P::match_paren(std::size_t j) const {
  int depth = 0;
  for (; j < n(); ++j) {
    const Token& q = (*st.toks)[j];
    if (q.t == Tok::Eof || q.t == Tok::Nl) return j;
    if (q.t == Tok::P && q.v == u"(") ++depth;
    else if (q.t == Tok::P && q.v == u")" && --depth == 0) return j + 1;
  }
  return j;
}

/** Is the `(` at offset k a point or tuple (a comma at its own level) rather than a
 *  parenthesized expression? */
bool P::paren_has_comma(std::size_t k) const {
  int depth = 0;
  for (std::size_t j = i() + k; j < n(); ++j) {
    const Token& q = (*st.toks)[j];
    if (q.t == Tok::Eof || q.t == Tok::Nl) return false;
    if (q.t != Tok::P) continue;
    if (q.v == u"(") ++depth;
    else if (q.v == u")") { if (--depth == 0) return false; }
    else if (q.v == u"," && depth == 1) return true;
  }
  return false;
}

/** `units: mil` at the top of a footprint or template body. */
Val P::block_units(std::size_t before) {
  const Token& k = expect_key(u"units");
  if (before) throw ParseError{u"`units:` goes first in a footprint or template, before the statements it applies to", k.s, k.e};
  st.unit = unit_word();
  return nullptr;
}

/** The word after `units:`. */
U P::unit_word() {
  const Token& u = cur();
  if (u.t == Tok::Word && among(u.v, UNITS)) return advance().v;
  if (u.t == Tok::Word && u.v == u"mils") fail_at(u"write mils as `mil`");
  if (u.t == Tok::Word && (u.v == u"inch" || u.v == u"inches")) fail_at(u"write inches as `in`");
  expected(u"a unit: mm, um, nm, mil or in");
}

// The file (parser.js 339-411)

Val P::file() {
  auto items = list();
  skip_eos();
  while (cur().t != Tok::Eof) {
    const std::size_t start = i();
    try {
      if (is_word(u"end")) fail_at(u"this `end` has no block to close");
      Val it = run<g::top_stmt>();
      if (it.is_obj()) items->a.push_back(it);   // kept even if junk follows it
      end_stmt();
    } catch (const ParseError& err) {
      report(err);
      sync();
      if (i() == start) advance();
    }
    st.dedent.reset();
    skip_eos();
  }
  return rec({{K_type, u"File"}, {K_items, items}});
}

Val P::top_stmt() {
  const Token& k = cur();
  const Offset s = k.s;
  const bool from = st.last_from;
  st.last_from = false;
  Val node;
  if (is_decl()) node = decl(u"Let");
  else if (is_word(u"let")) node = old_let(u"Let");
  else if (is_word(u"units")) {
    expect_key(u"units");
    st.unit = unit_word();
    node = rec({{K_type, u"Units"}, {K_unit, st.unit}});
  } else if (is_word(u"template")) node = run<g::template_>();
  else if (is_word(u"feature")) node = run<g::feature_decl>();
  else if (is_word(u"footprint")) node = run<g::footprint>();
  else if (is_word(u"footprints")) node = run<g::table>();
  else if (k.t == Tok::Word && stmt_word(k.v)) {
    fail_at(from ? bq(k.v) + u" goes in a footprint: to add statements to the `footprint … from …` above, end its line with `with` and close them with `end`"
                 : bq(k.v) + u" goes in a footprint (`footprint \"NAME\"`, its statements, then `end`)");
  } else {
    expected(u"`footprint`, `footprints`, `template`, `feature`, `units:` or `NAME = value`");
  }
  if (!node.is_obj()) return nullptr;
  Obj& o = *node.obj();
  o.set(K_s, s);
  o.set(K_e, prev_end());
  const Val& u = o.get(K_unit);
  o.set(K_unit, u.truthy() && o.get(K_type).str() == u"Units" ? u : Val(st.unit));
  return node;
}

/** A top-level item whose header line is broken: report it, then read its block anyway
 *  (its problems unreported), so its statements aren't taken for top-level ones. */
Val P::skip_block(const ParseError& err, const Token& head, V what, const StmtFn& parse_stmt) {
  report(err);
  sync();
  const std::size_t keep = st.diags->size();
  block(head, what, parse_stmt);
  st.diags->resize(keep);
  st.soft_end = true;
  return nullptr;
}

/** Does this `footprint` line open a block? Unless it's a `from` line without `with`. */
bool P::line_opens_block() const {
  bool from = false;
  const Token* last = nullptr;
  for (std::size_t j = i(); j < n(); ++j) {
    const Token& q = (*st.toks)[j];
    if (q.t == Tok::Nl || q.t == Tok::Eof || (q.t == Tok::P && q.v == u";")) break;
    if (q.t == Tok::Word && q.v == u"from") from = true;
    last = &q;
  }
  return !from || (last && last->t == Tok::Word && last->v == u"with");
}

/** A name for a template or feature (or a template named in a call): any word but `x` and `end`. */
const Token& P::decl_name(V what) {
  const Token& k = cur();
  if (k.t != Tok::Word) expected(what);
  if (hard(k.v)) fail_at(hard_name(k.v));
  return advance();
}

Val P::template_() {
  const Token& head = expect_word(u"template");
  const Token* nm;
  Val params;
  try {
    nm = &decl_name(u"a template name");
    params = param_list(u"template");
  } catch (const ParseError& err) {
    return skip_block(err, head, u"`template`", [this] { return run<g::statement>(); });
  }
  Block blk = block(head, u"`template`", [this] { return run<g::statement>(); }, true);
  return rec({{K_type, u"Template"}, {K_name, nm->v}, {K_nameS, nm->s}, {K_nameE, nm->e}, {K_params, params}, {K_body, list(std::move(blk.stmts))}});
}

/** `( name, name = default, ... )` for a template or feature. */
Val P::param_list(V what) {
  expect_p(u"(", u"to open the parameter list");
  auto params = list();
  if (!is_p(u")")) {
    do {
      const Token& p = cur();
      if (p.t != Tok::Word) expected(u"a " + U(what) + u" parameter name");
      if (hard(p.v)) fail_at(hard_name(p.v));
      advance();
      if (is_p(u":")) fail_at(u"a parameter's default takes `=`: `" + p.v + u" = …`", &cur());
      Val def = nullptr;
      if (accept_p(u"=")) def = run<g::expr>();
      params->a.push_back(rec({{K_name, p.v}, {K_def, def}, {K_s, p.s}, {K_e, prev_end()}}));
    } while (accept_p(u","));
  }
  expect_p(u")");
  return params;
}

/** `feature NAME [(params)]` and its items, then `end`. */
Val P::feature_decl() {
  const Token& head = expect_word(u"feature");
  const Token* nm;
  Val params;
  try {
    nm = &decl_name(u"a feature name");
    params = is_p(u"(") ? param_list(u"feature") : Val(list());
  } catch (const ParseError& err) {
    return skip_block(err, head, u"`feature`", [this] { return feature_item(false); });
  }
  if (is_word(u"at") || (is_word(u"on") && is_word(u"body", 1)))
    fail_at(u"a feature is placed in a footprint or in another feature; here, `feature NAME` defines one", &head);
  Block blk = block(head, u"`feature`", [this] { return feature_item(false); });
  return rec({{K_type, u"Feature"}, {K_name, nm->v}, {K_nameS, nm->s}, {K_nameE, nm->e}, {K_params, params}, {K_body, list(std::move(blk.stmts))}});
}

/** One item of a feature, or of a section in it. */
Val P::feature_item(bool in_section) {
  const Token& k = cur();
  const Offset s = k.s;
  Val node;
  if (k.t == Tok::Word && is_p(u":", 1) && (among(k.v, GFX) || among(k.v, SOLIDS) || k.v == u"section" || k.v == u"feature"))
    fail_at(bq(k.v) + u" takes no colon", &peek(1));
  if (is_decl()) node = decl(in_section ? u"Set" : u"Let");
  else if (is_word(u"let")) node = old_let(in_section ? u"Set" : u"Let");
  else if (is_word(u"section")) {
    const Token& head = advance();
    auto names = list({flag_name()});
    for (;;) {
      if (accept_p(u",")) names->a.push_back(flag_name());
      else if (cur().t == Tok::Word && !at_stmt_end() && !hard(cur().v)) {
        // `section a b`: reported, and read as `section a, b`, so the block still holds together
        const Token& k2 = cur();
        note(u"separate the flags with commas: `section " + O(names->a.back()).get(K_name).str() + u", " + k2.v + u"`", k2.s, k2.e);
        names->a.push_back(flag_name());
      } else break;
    }
    Block blk = block(head, u"`section`", [this] { return feature_item(true); });
    node = rec({{K_type, u"Section"}, {K_names, names}, {K_body, list(std::move(blk.stmts))}});
  } else if (is_word(u"feature")) node = run<g::feature_place>();
  else if (k.t == Tok::Word && among(k.v, GFX)) {
    Val gr = gfx_stmt(u"feature");
    gr.obj()->set(K_unit, st.unit);
    const Val& layer = O(gr).get(K_layer);
    node = rec({{K_type, u"FeatureLayer"}, {K_layer, layer.truthy() ? layer : Val(u"silk")}, {K_items, list({gr})}});
  } else if (k.t == Tok::Word && among(k.v, SOLIDS)) {
    Val q = solid(true);
    q.obj()->set(K_unit, st.unit);
    node = rec({{K_type, u"FeatureModel"}, {K_items, list({q})}});
  } else if (k.t == Tok::Word && (k.v == u"silk" || k.v == u"assembly" || k.v == u"model")) {
    fail_at(u"a feature's graphics and solids go straight in it, with no `" + k.v + u"` block" +
            (k.v == u"model" ? U() : k.v == u"assembly" ? U(u": give a graphic `layer: assembly`") : U(u" (they go on the silk unless they say `layer: assembly`)")));
  } else if (is_word(u"units")) {
    fail_at(u"`units:` goes at the top of the file, or first in a footprint or template");
  } else if (in_section) {
    expected(u"`NAME = value`, a graphic, a solid, `section` or `feature NAME at …`");
  } else {
    expected(u"a graphic (line, circle, …), a solid (box, cylinder, …), `NAME = value`, `section` or `feature NAME at …`");
  }
  node.obj()->set(K_s, s);
  node.obj()->set(K_e, prev_end());
  return node;
}

Val P::feature_item_let() { return feature_item(false); }
Val P::feature_item_set() { return feature_item(true); }

/** A flag: any word but `x` and `end` (`section dot`, `section gullwing`). */
Val P::flag_name() {
  const Token& k = cur();
  if (k.t != Tok::Word) expected(u"a flag name");
  if (hard(k.v)) fail_at(hard_name(k.v));
  advance();
  return rec({{K_name, k.v}, {K_s, k.s}, {K_e, k.e}});
}

/** `NAME [(args)]`: the feature a statement places, or `body shape:` names. */
Val P::feature_call() {
  const Token& k = decl_name(u"the name of a feature");
  Val args = is_p(u"(") ? run<g::call_args>() : Val(list());
  return rec({{K_name, k.v}, {K_s, k.s}, {K_e, k.e}, {K_args, args}});
}

/** `feature NAME [(args)] at (x, y[, z]) [rotate: R]` in a feature. */
Val P::feature_place() {
  expect_word(u"feature");
  Val feature = run<g::feature_call>();
  Val at = nullptr, rotate = nullptr;
  for (;;) {
    const Token& c = cur();
    if (accept_word(u"at")) {
      if (at.truthy()) fail_at(u"`at` is given twice", &c);
      if (!is_p(u"(")) fail_at(u"in a feature, place another feature at a point: `feature NAME at (x, y)`");
      at = run<g::point3opt>();
    } else if (accept_key(u"rotate")) {
      if (rotate.truthy()) fail_at(u"`rotate:` is given twice", &c);
      rotate = run<g::rotation>();
    } else if (is_word(u"on") && is_word(u"body", 1)) {
      fail_at(u"`on body` works in a footprint; in a feature, give the height in `at (x, y, z)`");
    } else break;
  }
  if (!at.truthy()) {
    const U& name = O(feature).get(K_name).str();
    if (at_stmt_end())
      fail_range(u"give `" + name + u"` a place: `feature " + name + (O(feature).get(K_args).arr()->a.empty() ? U() : U(u"(…)")) + u" at (0, 0)`",
                 S(feature), E(feature));
    expected(u"`at (x, y)` or `rotate:`");
  }
  return rec({{K_type, u"FeaturePlace"}, {K_feature, feature}, {K_at, at}, {K_rotate, rotate}});
}

/** `feature NAME [(args)] at POINT | OBJECT [rotate: R] [on body]` in a footprint. */
Val P::feature_use() {
  expect_word(u"feature");
  Val feature = run<g::feature_call>();
  Val at = nullptr, rotate = nullptr;
  bool on_body = false;
  for (;;) {
    const Token& c = cur();
    if (accept_word(u"at")) {
      if (at.truthy()) fail_at(u"`at` is given twice", &c);
      at = is_p(u"(") ? Val(rec({{K_point, run<g::point3opt>()}})) : Val(rec({{K_ref, run<g::objref>()}}));
    } else if (accept_key(u"rotate")) {
      if (rotate.truthy()) fail_at(u"`rotate:` is given twice", &c);
      rotate = run<g::rotation>();
    } else if (is_word(u"on") && is_word(u"body", 1)) {
      if (on_body) fail_at(u"`on body` is given twice", &c);
      advance();
      advance();
      on_body = true;
    } else break;
  }
  if (!at.truthy() && !on_body) {
    const U& name = O(feature).get(K_name).str();
    if (at_stmt_end()) fail_range(u"give `" + name + u"` a place: `at (x, y)`, `at pad 1` or `on body`", S(feature), E(feature));
    expected(u"`at`, `rotate:` or `on body`");
  }
  return rec({{K_type, u"FeatureUse"}, {K_feature, feature}, {K_at, at}, {K_rotate, rotate}, {K_onBody, on_body}});
}

Val P::footprint() {
  const Token& head = expect_word(u"footprint");
  const bool opens = line_opens_block();
  ObjP node = rec({{K_type, u"Footprint"}, {K_name, nullptr}, {K_nameS, nullptr}, {K_nameE, nullptr}, {K_mode, u"block"}, {K_body, nullptr}});
  try {
    // `footprint from qfn(...)` can leave the name to the template
    Val nm = is_word(u"from") ? Val(nullptr) : name_what(u"a footprint name, or `from TEMPLATE(…)`");
    if (nm.truthy()) {
      node->set(K_name, O(nm).get(K_name));
      node->set(K_nameS, O(nm).get(K_s));
      node->set(K_nameE, O(nm).get(K_e));
    }
    if (nm.truthy() && accept_word(u"extends")) {
      node->set(K_mode, u"extends");
      node->set(K_parent, name_what(u"the parent footprint name"));
    } else if (accept_word(u"from")) {
      node->set(K_mode, u"from");
      const Token& t = decl_name(u"a template name");
      node->set(K_template, rec({{K_name, t.v}, {K_s, t.s}, {K_e, t.e}}));
      node->set(K_args, run<g::call_args>());
      node->set(K_callS, t.s);
      node->set(K_callE, prev_end());
      if (!nm.truthy()) {
        node->set(K_nameS, t.s);
        node->set(K_nameE, node->get(K_callE));
      }
      if (!accept_word(u"with")) {
        if (!at_stmt_end()) expected(u"the end of the line, or `with` and the statements to add");
        st.last_from = true;
        return node;
      }
    } else if (!at_stmt_end()) {
      // reported, and the block read anyway: the footprint still builds
      const Token& k = cur();
      std::optional<U> hint;
      if (k.t == Tok::Word) hint = suggest(k.v, {u"extends", u"from"});
      note(u"unexpected " + describe(k) + u" after the footprint name" +
               (hint ? u" — did you mean `" + *hint + u"`?" : U(u": the line ends there, or goes on with `extends NAME` or `from TEMPLATE(…)`")),
           k.s, std::max(k.e, k.s + 1));
      sync();
    }
  } catch (const ParseError& err) {
    if (!opens) throw;
    return skip_block(err, head, u"`footprint`", [this] { return run<g::statement>(); });
  }
  node->set(K_body, list(block(head, u"`footprint`", [this] { return run<g::statement>(); }, true).stmts));
  return node;
}

/** `( arg, key: arg, ... )`. A lone word is kept as a word: the compiler decides whether
 *  it's a flag of the feature called or a value. */
Val P::call_args() {
  expect_p(u"(");
  auto args = list();
  if (!is_p(u")")) {
    do {
      const Offset s = cur().s;
      const Token& k = cur();
      const bool word = k.t == Tok::Word && !hard(k.v);
      if (word && is_p(u":", 1)) {
        advance();
        advance();
        Val x = run<g::expr>();
        args->a.push_back(rec({{K_key, k.v}, {K_x, x}, {K_s, s}, {K_e, prev_end()}}));
        continue;
      }
      if (word && is_p(u"=", 1)) fail_at(u"a named value takes a colon: `" + k.v + u": …`", &peek(1));
      if (word && (is_p(u",", 1) || is_p(u")", 1))) {
        advance();
        args->a.push_back(rec({{K_key, nullptr}, {K_word, k.v}, {K_x, rec({{K_type, u"id"}, {K_name, k.v}, {K_s, k.s}, {K_e, k.e}})}, {K_s, s}, {K_e, k.e}}));
        continue;
      }
      Val x = run<g::expr>();
      args->a.push_back(rec({{K_key, nullptr}, {K_x, x}, {K_s, s}, {K_e, prev_end()}}));
    } while (accept_p(u","));
  }
  expect_p(u")", u"to close the call");
  return args;
}

/**
 * footprints from TEMPLATE [(fixed args)]
 *   COLUMN COLUMN ...      header: template parameter names
 *   cell   cell   ...      one row per footprint
 * end
 */
Val P::table() {
  const Token& head = expect_word(u"footprints");
  ObjP node = rec({{K_type, u"Table"}, {K_template, nullptr}, {K_args, list()}, {K_header, list()}, {K_rows, list()}});
  try {
    expect_word(u"from", u"(`footprints from TEMPLATE`, the table, then `end`)");
    const Token& t = decl_name(u"a template name");
    node->set(K_template, rec({{K_name, t.v}, {K_s, t.s}, {K_e, t.e}}));
    if (is_p(u"(")) node->set(K_args, run<g::call_args>());
    node->set(K_callS, t.s);
    node->set(K_callE, prev_end());
  } catch (const ParseError& err) {
    return skip_block(err, head, u"table", [this] { sync(); return Val(nullptr); });
  }
  const Offset head_e = prev_end();
  if (!at_stmt_end()) {
    note(u"unexpected " + describe(cur()) + u" — the table goes on the lines below: a header row of parameter names, then one row per footprint",
         cur().s, std::max(cur().e, cur().s + 1));
    sync();
  }
  skip_eos();
  node->set(K_headerS, cur().s);
  ArrP header = node->get(K_header).arr();
  ArrP rows = node->get(K_rows).arr();
  bool rows_ok = true;
  try {
    while (cur().t == Tok::Word && !is_word(u"end") && !starts_top_item()) {
      const Token& h = cur();
      if (hard(h.v)) fail_at(hard_name(h.v));
      advance();
      header->a.push_back(rec({{K_name, h.v}, {K_s, h.s}, {K_e, h.e}}));
    }
    if (header->a.empty()) expected(u"a header row naming the template parameter each column fills");
    if (!at_stmt_end()) fail_at(u"the header row holds parameter names only — found " + describe(cur()));
  } catch (const ParseError& err) {
    report(err);
    sync();
    rows_ok = false;   // rows can't be matched to a broken header: skip them
  }
  node->set(K_headerE, prev_end());
  skip_eos();
  for (;;) {
    if (is_word(u"end")) { advance(); break; }
    if (cur().t == Tok::Eof || starts_top_item()) {
      missing_end(head, head_e, u"table", cur());
      st.soft_end = true;
      break;
    }
    const std::size_t start = i();
    const Offset rs = cur().s;
    try {
      auto cells = list();
      while (!at_stmt_end()) cells->a.push_back(run<g::cell>());
      const Offset re = prev_end();
      if (rows_ok && cells->a.size() != header->a.size()) {
        auto plural = [](std::size_t n, V w) { return js::u16(std::to_string(n)) + u" " + U(w) + (n == 1 ? U() : U(u"s")); };
        throw ParseError{u"this row has " + plural(cells->a.size(), u"value") + u" but the header names " + plural(header->a.size(), u"column"), rs, re};
      }
      if (rows_ok) rows->a.push_back(rec({{K_cells, cells}, {K_s, rs}, {K_e, re}, {K_line, (*st.toks)[start].line}}));
    } catch (const ParseError& err) {
      if (rows_ok) report(err);
      sync();
      if (i() == start) advance();
    }
    skip_eos();
  }
  return node;
}

/** One table cell: a number, a name, a "string" or a (parenthesized expression). */
Val P::cell() { return with_marks(u"cell", [this] { return cell_value(); }); }

Val P::cell_value() {
  const Token& k = cur();
  if (k.t == Tok::Str) {
    advance();
    Val x = rec({{K_type, u"str"}, {K_value, str_node(k)}, {K_s, k.s}, {K_e, k.e}});
    return rec({{K_x, x}, {K_s, k.s}, {K_e, k.e}});
  }
  if (is_p(u"(")) {
    Val x = run<g::primary>();
    return rec({{K_x, x}, {K_s, S(x)}, {K_e, E(x)}});
  }
  if (is_p(u"-")) {
    const Token& m = advance();
    if (cur().t != Tok::Num || cur().s != m.e)
      fail_at(u"write a negative value as `-0.5` (no space), or put arithmetic in parentheses: `(D - 0.5)`", &m);
    Val x = run<g::primary>();
    return rec({{K_x, rec({{K_type, u"neg"}, {K_x, x}, {K_s, m.s}, {K_e, E(x)}})}, {K_s, m.s}, {K_e, E(x)}});
  }
  if (k.t == Tok::Num || (k.t == Tok::Word && !hard(k.v))) {
    Val x = run<g::primary>();
    return rec({{K_x, x}, {K_s, S(x)}, {K_e, E(x)}});
  }
  if (k.t == Tok::P && k.v == u",") fail_at(u"table cells are separated by spaces, not commas");
  if (k.t == Tok::P && (k.v == u"+" || k.v == u"*" || k.v == u"/"))
    fail_at(u"a cell holds one value — put arithmetic in parentheses: `(D - 0.5)`");
  expected(u"a value: a number, a name, a \"string\" or a (parenthesized expression)");
}

/** A string token as a plain string, or { interp: [text | { x, fmt, s, e }], s, e }. */
Val P::str_node(const Token& k) {
  if (!k.parts) return k.v;
  auto parts = list();
  for (const StrPart& p : *k.parts) {
    if (p.is_lit) { parts->a.push_back(p.lit); continue; }
    Val x = nullptr;
    if (!p.toks.empty()) {
      // the code in {…}: its own parser, sharing the problems list and the units
      std::vector<Token> toks = p.toks;
      Token eof;
      eof.t = Tok::Eof;
      eof.s = eof.e = p.code_e;
      eof.line = k.line;
      eof.col = 0;
      toks.push_back(eof);
      std::string classes;
      for (const Token& t : toks) classes.push_back(token_class(t));
      Input sub_in(classes.data(), classes.size(), "{…}");
      State sub_st;
      sub_st.toks = &toks;
      sub_st.diags = st.diags;
      sub_st.unit = st.unit;
      P sub(sub_in, sub_st);
      try {
        x = sub.run<g::expr>();
        if (sub.cur().t != Tok::Eof) sub.fail_at(u"unexpected " + describe(sub.cur()) + u" — each `{…}` holds one expression");
      } catch (const ParseError& err) {
        report(err);
        x = nullptr;
      }
    }
    parts->a.push_back(rec({{K_x, x}, {K_fmt, p.fmt < 0 ? Val(nullptr) : Val(p.fmt)}, {K_s, p.open}, {K_e, p.close + 1}}));
  }
  return rec({{K_interp, parts}, {K_s, k.s}, {K_e, k.e}});
}


// Statements (parser.js 776-1302)

Val P::statement() {
  const Token& k = cur();
  const Offset s = k.s;
  Val node;
  if (k.t == Tok::Word && is_p(u":", 1) && stmt_word(k.v) && !among(k.v, KEY_STMTS) && !among(k.v, MEASURES))
    fail_at(bq(k.v) + u" takes no colon", &peek(1));
  if (is_decl()) node = decl(u"Let");
  else if (k.t == Tok::Word) {
    const V w = k.v;
    if (w == u"let") node = old_let(u"Let");
    else if (among(w, {u"description", u"datasheet", u"manufacturer", u"mpn", u"refdes"})) {
      expect_key(w);
      const Token& v = cur();
      if (v.t != Tok::Str) expected(u"a \"quoted string\" after `" + U(w) + u":`");
      advance();
      node = rec({{K_type, u"Meta"}, {K_key, w}, {K_value, str_node(v)}});
    } else if (w == u"name") {
      expect_key(u"name");
      const Token& v = cur();
      if (v.t != Tok::Str) expected(u"the footprint name as a \"string\", e.g. `name: \"QFN-{n}\"`");
      advance();
      node = rec({{K_type, u"Name"}, {K_value, str_node(v)}, {K_vs, v.s}, {K_ve, v.e}});
    } else if (w == u"tags") {
      expect_key(u"tags");
      auto tags = list({run<g::tag>()});
      while (accept_p(u",")) tags->a.push_back(run<g::tag>());
      node = rec({{K_type, u"Meta"}, {K_key, u"tags"}, {K_value, tags}});
    } else if (w == u"origin") {
      node = (is_word(u"at", 1) || is_word(u"centered", 1)) ? run<g::origin_stmt>() : run<g::placement>();
    } else if (w == u"body") node = run<g::body_or_placement>();
    else if (w == u"pins") node = run<g::pins>();
    else if (w == u"balls") node = run<g::balls>();
    else if (w == u"lead") node = run<g::lead>();
    else if (w == u"thermal") node = run<g::thermal>();
    else if (among(w, MEASURES)) node = run<g::measure>();
    else if (w == u"density") {
      expect_key(u"density");
      const Token& v = cur();
      if (v.t != Tok::Word || !among(v.v, {u"least", u"nominal", u"most"})) expected(u"`least`, `nominal` or `most`");
      advance();
      node = rec({{K_type, u"Density"}, {K_level, v.v}});
    } else if (w == u"omit" || w == u"only") {
      advance();
      auto items = list({run<g::region_or_name>()});
      while (accept_p(u",")) items->a.push_back(run<g::region_or_name>());
      node = rec({{K_type, w == u"omit" ? u"Omit" : u"Only"}, {K_items, items}});
    } else if (w == u"pin1") {
      expect_key(u"pin1");
      const Token& v = cur();
      if (v.t == Tok::Word && among(v.v, {u"dot", u"chamfer", u"notch", u"bar", u"none"})) {
        advance();
        node = rec({{K_type, u"Pin1"}, {K_style, v.v}});
      } else if (v.t == Tok::Word && !hard(v.v)) {
        // a custom marker: `pin1: plus`, `pin1: arrow(0.6)`
        node = rec({{K_type, u"Pin1"}, {K_style, u"feature"}, {K_feature, run<g::feature_call>()}});
      } else {
        expected(u"a pin-1 marker: `dot`, `chamfer`, `notch`, `bar`, `none`, or the name of a feature");
      }
    } else if (w == u"polarized") {
      advance();
      node = rec({{K_type, u"Polarized"}});
    } else if (w == u"default") {
      advance();
      expect_word(u"pad", u"after `default`");
      node = rec({{K_type, u"DefaultPad"}, {K_geom, run<g::pad_geom>()}});
    } else if (w == u"pad") node = run<g::pad_or_placement>();
    else if (w == u"pads") {
      advance();
      Val sel = run<g::sel_list>();
      Val blk = run<g::pad_props>();
      if (blk.arr()->a.empty()) expected(u"pad properties after the selector, such as `mask: +0.05`");
      node = rec({{K_type, u"Pads"}, {K_sel, sel}, {K_block, blk}});
    } else if (w == u"hole") node = run<g::hole_or_placement>();
    else if (w == u"delete") {
      advance();
      node = rec({{K_type, u"Delete"}, {K_ref, run<g::objref>()}});
    } else if (w == u"row") node = run<g::row_or_placement>();
    else if (w == u"group") node = run<g::group_or_placement>();
    else if (w == u"align") {
      advance();
      Val a = run<g::objref>();
      expect_word(u"with");
      Val b = run<g::objref>();
      Val axis = axis_adv();
      if (!axis.truthy()) expected(u"`horizontally` (same y) or `vertically` (same x)");
      node = rec({{K_type, u"Align"}, {K_a, a}, {K_b, b}, {K_axis, axis}});
    } else if (w == u"silk" || w == u"assembly") {
      if (!is_p(u":", 1) && !is_word(u"auto", 1) && !is_word(u"none", 1))
        fail_at(u"`" + U(w) + u":` takes `auto` or `none`; graphics go straight in the footprint (`line …`" +
                (w == u"assembly" ? U(u" with `layer: assembly`") : U()) + u")");
      expect_key(w);
      if (accept_word(u"auto")) node = rec({{K_type, u"Layer"}, {K_layer, w}, {K_mode, u"auto"}});
      else if (accept_word(u"none")) node = rec({{K_type, u"Layer"}, {K_layer, w}, {K_mode, u"none"}});
      else expected(u"`auto` or `none`");
    } else if (w == u"courtyard") node = run<g::courtyard>();
    else if (among(w, {u"outline", u"line", u"arc", u"circle", u"rect", u"polygon", u"hatch"})) {
      Val gr = gfx_stmt(u"footprint");
      gr.obj()->set(K_unit, st.unit);
      const Val& layer = O(gr).get(K_layer);
      node = rec({{K_type, u"Layer"}, {K_layer, layer.truthy() ? layer : Val(u"silk")}, {K_mode, u"block"}, {K_items, list({gr})}});
    } else if (w == u"text") node = text(u"footprint");
    else if (w == u"feature") node = run<g::feature_use>();
    else if (w == u"model" || w == u"no") node = run<g::model>();
    else if (w == u"units") fail_at(u"`units:` goes first in a footprint or template, or at the top of the file");
    else if (w == u"section") fail_at(u"a `section` goes in a feature");
    else {
      if (among(w, SOLIDS) && k.kw) fail_at(u"a `" + U(w) + u"` goes in the footprint's `model` block, or in a feature");
      if ((model_word(w) && is_p(u":", 1)) || w == u"leads")
        fail_at(u"`" + U(w) + (w == u"leads" ? U(u" …") : U(u":")) + u"` goes in the footprint's `model` block");
      node = run<g::placement>();
    }
  } else {
    node = run<g::placement>();
  }
  Obj& o = *node.obj();
  o.set(K_s, s);
  o.set(K_e, prev_end());
  o.set(K_unit, st.unit);
  return node;
}

/** A tag: a word, a number or a "string". */
Val P::tag() {
  const Token& k = cur();
  if (k.t == Tok::Str) { advance(); return str_node(k); }
  if (k.t == Tok::Num && k.is_int) { advance(); return num_text(js::parse_float(k.text)); }
  if (k.t == Tok::Word && !hard(k.v)) { advance(); return k.v; }
  expected(u"a tag");
}

Val P::origin_stmt() {
  expect_word(u"origin");
  if (accept_word(u"at")) {
    if (is_p(u"(")) return rec({{K_type, u"Origin"}, {K_point, run<g::point>()}});
    return rec({{K_type, u"Origin"}, {K_ref, run<g::objref>()}});
  }
  expect_word(u"centered");
  expect_word(u"between");
  Val a = run<g::objref>();
  expect_word(u"and");
  Val b = run<g::objref>();
  return rec({{K_type, u"Origin"}, {K_between, list({a, b})}});
}

/** Is a placement (`at`, `is`, `mirrors`, maybe after an anchor) next, at offset k? */
bool P::is_place_ahead(std::size_t k) {
  if (i() + k >= n()) return false;
  const std::size_t save = i();
  set_i(save + k);
  const bool ok = looking_at<g::place_ahead>();
  set_i(save);
  return ok;
}

Val P::body_or_placement() {
  if (is_key(u"color", 1) || is_key(u"shape", 1)) fail_at(u"`body " + peek(1).v + u":` goes in the footprint's `model` block");
  if (is_word(u"cylinder", 1)) {
    advance();
    advance();
    expect_key(u"d", u"(the diameter: `body cylinder d: 8 h: 11.5`)");
    Val d = run<g::expr>();
    expect_key(u"h", u"(the height: `body cylinder d: 8 h: 11.5`)");
    Val h = run<g::expr>();
    return rec({{K_type, u"Body"}, {K_cyl, true}, {K_d, d}, {K_h, h}});
  }
  if (!is_place_ahead(1) && expr_start(1)) {
    advance();
    return with_marks(u"body", [this] {
      Val w = run<g::expr>();
      expect_word(u"x", u"between body width and length (`body 3.9 x 4.9 x 1.5`)");
      Val l = run<g::expr>();
      Val h = accept_word(u"x") ? run<g::expr>() : Val(nullptr);
      return Val(rec({{K_type, u"Body"}, {K_w, w}, {K_l, l}, {K_h, h}}));
    });
  }
  return run<g::placement>();
}

Val P::pins() {
  const Token& head = expect_word(u"pins");
  if (at_stmt_end()) return rec({{K_type, u"Pins"}, {K_form, u"sides"}, {K_sides, sides_block(head)}, {K_clauses, rec({})}});
  if (accept_word(u"grid")) {
    Val nx = run<g::count>();
    expect_word(u"x", u"(`pins grid COLS x ROWS`)");
    Val ny = run<g::count>();
    return rec({{K_type, u"Pins"}, {K_form, u"grid"}, {K_nx, nx}, {K_ny, ny}, {K_clauses, run<g::pins_clauses>()}});
  }
  Val count = run<g::count>();
  Val arrangement = nullptr, side = nullptr;
  const Token& a = cur();
  if (a.t == Tok::Word && among(a.v, ARRANGEMENTS) && !is_p(u":", 1)) { advance(); arrangement = a.v; }
  else if (accept_word(u"single")) { arrangement = u"single"; side = side_word(); }
  return rec({{K_type, u"Pins"}, {K_form, u"count"}, {K_count, count}, {K_arrangement, arrangement}, {K_side, side},
              {K_clauses, run<g::pins_clauses>()}});
}

Val P::balls() {
  expect_word(u"balls");
  Val nx = run<g::count>();
  expect_word(u"x", u"(`balls COLS x ROWS`)");
  Val ny = run<g::count>();
  return rec({{K_type, u"Balls"}, {K_nx, nx}, {K_ny, ny}, {K_clauses, run<g::pins_clauses>()}});
}

Val P::count() {
  const Token& k = cur();
  if (k.t == Tok::Num && k.is_int) { advance(); return rec({{K_v, k.value}, {K_s, k.s}, {K_e, k.e}}); }
  if (k.t == Tok::Word && !hard(k.v) && !among(k.v, ARRANGEMENTS) && k.v != u"single" && k.v != u"grid" && !is_p(u":", 1)) {
    advance();
    return rec({{K_id, k.v}, {K_s, k.s}, {K_e, k.e}});
  }
  if (k.t == Tok::Num) fail_at(u"a count must be a whole number, found `" + k.text + u"`");
  expected(u"a pin count");
}

Val P::pins_clauses() {
  ObjP c = rec({});
  auto once = [&](Key key, const Token& tok) {
    if (c->get(key).truthy()) fail_at(u"`" + key_name(key) + u":` is given twice", &tok);
  };
  for (;;) {
    const Token& k = cur();
    if (accept_key(u"pitch")) {
      once(K_pitch, k);
      Val x = run<g::expr>();
      Val y = accept_word(u"x") ? run<g::expr>() : Val(nullptr);
      c->set(K_pitch, rec({{K_x, x}, {K_y, y}, {K_s, k.s}, {K_e, prev_end()}}));
    } else if (accept_key(u"span")) {
      once(K_span, k);
      Val x = run<g::expr>();
      Val q = span_qual();
      c->set(K_span, rec({{K_x, x}, {K_qual, q}, {K_s, k.s}, {K_e, prev_end()}}));
    } else if (accept_key(u"pad")) {
      once(key(u"pad"), k);
      c->set(key(u"pad"), run<g::pad_geom>());
    } else if (accept_key(u"numbering")) {
      once(K_numbering, k);
      const Token& v = cur();
      if (v.t != Tok::Word || !among(v.v, SCHEMES)) expected(u"a numbering scheme: ccw, cw, zigzag, row-major, col-major or bga");
      advance();
      c->set(K_numbering, rec({{K_v, v.v}, {K_s, v.s}, {K_e, v.e}}));
    } else if (accept_key(u"start")) {
      once(K_start, k);
      const Token& v = cur();
      if (v.t != Tok::Word || !among(v.v, CORNERS)) expected(u"a corner: top-left, top-right, bottom-left or bottom-right");
      advance();
      c->set(K_start, rec({{K_v, v.v}, {K_s, v.s}, {K_e, v.e}}));
    } else break;
  }
  return c;
}

/** `pins` alone on its line: a list of sides, `left: 1, 2, 3 [pitch: P]`, then `end`. */
Val P::sides_block(const Token& head) {
  Block blk = block(head, u"`pins` list", [this] {
    const Token& k = cur();
    const U side = side_word();
    expect_p(u":", u"after `" + side + u"`");
    auto positions = list();
    do {
      const Token& p = cur();
      if (accept_word(u"nc")) positions->a.push_back(rec({{K_nc, true}, {K_s, p.s}, {K_e, p.e}}));
      else {
        Val nm = name_what(u"a pin name or `nc`");
        positions->a.push_back(rec({{K_name, O(nm).get(K_name)}, {K_s, O(nm).get(K_s)}, {K_e, O(nm).get(K_e)}}));
      }
    } while (accept_p(u","));
    Val pitch = accept_key(u"pitch") ? run<g::expr>() : Val(nullptr);
    return Val(rec({{K_side, side}, {K_positions, positions}, {K_pitch, pitch}, {K_s, k.s}, {K_e, prev_end()}}));
  }, false, [this] { return cur().t == Tok::Word && (stmt_word(cur().v) || is_p(u"=", 1)); });
  return list(std::move(blk.stmts));
}

Val P::lead() {
  expect_word(u"lead");
  const Token* f = &cur();
  Val names = nullptr;
  if (!(f->t == Tok::Word && among(f->v, LEAD_FORMS))) {
    // per-pin: `lead 4 gullwing ...`, `lead 1, 3 none` (SPEC 11.3)
    if ((f->t == Tok::Num && f->is_int && !f->has_suffix) || f->t == Tok::Str || (f->t == Tok::Word && !f->kw)) {
      names = run<g::sel_list>();
      if (accept_word(u"none")) return rec({{K_type, u"Lead"}, {K_names, names}, {K_none, true}});
      f = &cur();
      if (f->t != Tok::Word || !among(f->v, LEAD_FORMS))
        expected(u"a lead form for these pins (gullwing, jlead, lbend, straight, flat, endcap, ball, column, pin, wire, tab, castellated) or `none`");
    } else {
      expected(u"a lead form: gullwing, jlead, lbend, straight, flat, endcap, ball, column, pin, wire, tab or castellated");
    }
  }
  advance();
  Val dims = nullptr;
  if (accept_key(u"d")) dims = rec({{K_d, run<g::expr>()}});
  else if (expr_start()) {
    Val z = size_or_one(false);
    dims = O(z).get(K_v).truthy() ? Val(rec({{K_v, O(z).get(K_v)}})) : Val(rec({{K_w, O(z).get(K_w)}, {K_l, O(z).get(K_l)}}));
  }
  Val span = nullptr;
  const Token& k = cur();
  if (accept_key(u"span")) {
    Val x = run<g::expr>();
    Val q = span_qual();
    span = rec({{K_x, x}, {K_qual, q}, {K_s, k.s}, {K_e, prev_end()}});
  }
  return rec({{K_type, u"Lead"}, {K_form, f->v}, {K_dims, dims}, {K_span, span}, {K_names, names}});
}

Val P::thermal() {
  expect_word(u"thermal");
  expect_word(u"pad", u"after `thermal`");
  Val nm = nullptr, sz;
  const std::size_t save = i();
  try {
    Val n_ = run<g::name>();
    sz = run<g::size>();
    nm = n_;
  } catch (const ParseError&) {
    set_i(save);
    sz = run<g::size>();
  }
  Val blk = run<g::pad_props>();
  return rec({{K_type, u"Thermal"}, {K_name, nm}, {K_size, sz}, {K_block, blk.arr()->a.empty() ? Val(nullptr) : blk}});
}

/** The objects `A to …` at offset j, or null (parser.js measure's objectsAhead). */
Val P::object_or_null_at(std::size_t j) {
  const std::size_t save = i();
  set_i(save + j);
  Val a = nullptr;
  try {
    a = run<g::objref>();
  } catch (const ParseError&) {
    a = nullptr;
  }
  const bool pair = a.truthy() && is_word(u"to");
  set_i(save);
  return pair ? a : Val(nullptr);
}

/** `span: X`, `gap: X`, `pitch: X`, or `pitch A to B is X [horizontally]`. */
Val P::measure() {
  const Token& k = cur();
  const U word = k.v;
  if (is_p(u":", 1)) {
    Val a = object_or_null_at(2);
    if (a.truthy() && O(a).get(K_kind).truthy())
      fail_at(u"a " + word + u" between two objects takes no colon: `" + word + u" pad 1 to pad 2 is …`", &peek(1));
    advance();
    advance();
    Val x = run<g::expr>();
    Val q = span_qual();
    return rec({{K_type, u"MeasureBare"}, {K_word, word}, {K_x, x}, {K_qual, q}});
  }
  if (!object_or_null_at(1).truthy()) {
    if (value_at(1)) missing_colon();
    expected(u"`" + word + u":` and a value, or `" + word + u" A to B is VALUE`", &peek(1));
  }
  advance();
  Val a = run<g::objref>();
  expect_word(u"to");
  Val b = run<g::objref>();
  expect_word(u"is", u"(`" + word + u" A to B is VALUE`)");
  Val x = run<g::expr>();
  return rec({{K_type, u"MeasurePair"}, {K_word, word}, {K_a, a}, {K_b, b}, {K_x, x}, {K_axis, axis_adv()}});
}

Val P::span_qual() {
  const Token& k = cur();
  if (k.t == Tok::Word && (k.v == u"outer" || k.v == u"inner" || k.v == u"centers")) { advance(); return k.v; }
  return nullptr;
}

Val P::region_or_name() {
  const Token& k = cur();
  if (accept_word(u"rows")) {
    Val rows = run<g::range>();
    Val cols = accept_word(u"cols") ? run<g::range>() : Val(nullptr);
    return rec({{K_rows, rows}, {K_cols, cols}, {K_s, k.s}, {K_e, prev_end()}});
  }
  if (accept_word(u"cols")) {
    Val cols = run<g::range>();
    return rec({{K_cols, cols}, {K_s, k.s}, {K_e, prev_end()}});
  }
  Val a = name_what(u"a pin name, `rows …` or `cols …`");
  if (accept_p(u"..")) {
    Val b = name_what(u"the end of the range");
    return rec({{K_range, list({a, b})}, {K_s, k.s}, {K_e, prev_end()}});
  }
  return rec({{K_name, a}, {K_s, k.s}, {K_e, prev_end()}});
}

Val P::range() {
  Val a = run<g::range_end>();
  expect_p(u"..", u"(a range like `1..4` or `D..E`)");
  Val b = run<g::range_end>();
  return list({a, b});
}

Val P::range_end() {
  const Token& k = cur();
  if ((k.t == Tok::Num && k.is_int) || (k.t == Tok::Word && !k.kw)) return run<g::name>();
  expected(u"a row/column number or letter");
}

Val P::sel_list() {
  auto items = list({run<g::sel_item>()});
  while (accept_p(u",")) items->a.push_back(run<g::sel_item>());
  return items;
}

Val P::sel_item() {
  const Token& k = cur();
  Val a = name_what(u"a pad name");
  if (accept_p(u"..")) {
    Val b = name_what(u"the end of the range");
    if (O(a).get(K_quoted).truthy() || O(b).get(K_quoted).truthy()) fail_at(u"range ends must be numbers or identifiers, not \"strings\"", &k);
    return rec({{K_range, list({a, b})}, {K_s, k.s}, {K_e, prev_end()}});
  }
  return rec({{K_name, a}, {K_s, k.s}, {K_e, prev_end()}});
}

/** Is a pad property (`size: …`, `mask: …`) next? A known one missing its colon is reported. */
bool P::pad_key_ahead(int which) {
  const Token& k = cur();
  if (k.t != Tok::Word || !(which == 0 ? among(k.v, PAD_PROPS) : among(k.v, PAD_KEYS))) return false;
  if (is_p(u":", 1)) return true;
  if (value_at(1)) missing_colon();
  return false;
}

Val P::pad_or_placement() {
  const std::size_t save = i();
  advance();
  Val nm = name_what(u"a pad name");
  st.stmt_target = rec({{K_kind, u"pad"}, {K_name, O(nm).get(K_name)}});
  const Token& k = cur();
  if (is_word(u"tht") || (k.t == Tok::Word && among(k.v, SHAPES) && !is_p(u":", 1)))
    return rec({{K_type, u"Pad"}, {K_name, nm}, {K_geom, run<g::pad_geom>()}});
  if (pad_key_ahead(1)) return rec({{K_type, u"Pad"}, {K_name, nm}, {K_block, run<g::pad_props>()}});
  set_i(save);
  return placement_what(u"a pad shape, a property such as `size: 1 x 2`, `at`, `is` or `mirrors`");
}

Val P::hole_or_placement() {
  const std::size_t save = i();
  advance();
  Val nm = name_what(u"a hole name");
  st.stmt_target = rec({{K_kind, u"hole"}, {K_name, O(nm).get(K_name)}});
  if (!is_place_ahead(0)) {
    if (accept_word(u"slot")) return rec({{K_type, u"Hole"}, {K_name, nm}, {K_slot, run<g::size>()}});
    if (expr_start()) return rec({{K_type, u"Hole"}, {K_name, nm}, {K_d, run<g::expr>()}});
  }
  set_i(save);
  return placement_what(u"a hole diameter, `slot W x L`, `at`, `is` or `mirrors`");
}

Val P::row_or_placement() {
  const std::size_t save = i();
  advance();
  Val nm = name_what(u"a row name");
  if (accept_word(u"pads")) {
    Val sel = run<g::sel_list>();
    expect_key(u"pitch", u"(`row NAME pads 1..4 pitch: P going: down`)");
    Val pitch = run<g::expr>();
    Val going = nullptr;
    if (accept_key(u"going")) {
      const Token& gt = cur();
      if (gt.t != Tok::Word || !among(gt.v, {u"left", u"right", u"up", u"down"})) expected(u"`left`, `right`, `up` or `down`");
      advance();
      going = gt.v;
    }
    return rec({{K_type, u"Row"}, {K_name, nm}, {K_sel, sel}, {K_pitch, pitch}, {K_going, going}});
  }
  set_i(save);
  return placement_what(u"`pads …` or a placement");
}

Val P::group_or_placement() {
  if (is_p(u"=", 2)) {
    advance();
    Val nm = name_what(u"a group name");
    expect_p(u"=");
    auto members = list({run<g::objref>()});
    while (accept_p(u",")) members->a.push_back(run<g::objref>());
    return rec({{K_type, u"Group"}, {K_name, nm}, {K_members, members}});
  }
  return run<g::placement>();
}

// placement_stmt <- objref ( at_tail / is_tail / mirrors_tail )
Val P::placement() { return placement_what({}); }

Val P::placement_what(V what) {
  const Token& first = cur();
  Val target = run<g::objref>();
  st.stmt_target = target;
  if (accept_word(u"at")) return rec({{K_type, u"At"}, {K_target, target}, {K_point, run<g::point>()}});
  if (accept_word(u"mirrors")) {
    Val proto = run<g::objref>();
    expect_word(u"across");
    const Token& ax = cur();
    if (!(ax.t == Tok::Word && (ax.v == u"x" || ax.v == u"y"))) expected(u"`x` or `y` (the axis to mirror across)");
    advance();
    return rec({{K_type, u"Mirrors"}, {K_target, target}, {K_proto, proto}, {K_axis, ax.v}});
  }
  if (accept_word(u"is")) {
    if (accept_word(u"centered")) {
      if (accept_word(u"between")) {
        Val a = run<g::objref>();
        expect_word(u"and");
        Val b = run<g::objref>();
        return rec({{K_type, u"Centered"}, {K_target, target}, {K_between, list({a, b})}, {K_axis, axis_adv()}});
      }
      if (accept_word(u"on")) {
        Val on = run<g::objref>();
        return rec({{K_type, u"Centered"}, {K_target, target}, {K_on, on}, {K_axis, axis_adv()}});
      }
      expected(u"`between` or `on` after `centered`");
    }
    auto clauses = list({run<g::rel_clause>()});
    while (accept_word(u"and")) clauses->a.push_back(run<g::rel_clause>());
    return rec({{K_type, u"Is"}, {K_target, target}, {K_clauses, clauses}});
  }
  if (O(target).get(K_kind).null() && first.t == Tok::Word && !first.kw) {
    const auto hint = suggest(first.v, STMT_WORDS);
    fail_at(u"unknown statement `" + first.v + u"`" + (hint ? u" — did you mean `" + *hint + u"`?" : U()), &first);
  }
  expected(what.empty() ? V(u"`at`, `is` or `mirrors`") : what);
}

Val P::rel_clause() {
  const Offset s = cur().s;
  Val dist = run<g::expr>();
  Val dir = nullptr;
  if (accept_word(u"left")) { expect_word(u"of", u"(`left of`)"); dir = u"left"; }
  else if (accept_word(u"right")) { expect_word(u"of", u"(`right of`)"); dir = u"right"; }
  else if (accept_word(u"above")) dir = u"above";
  else if (accept_word(u"below")) dir = u"below";
  else expected(u"a direction: `left of`, `right of`, `above` or `below`");
  Val ref = run<g::objref>();
  return rec({{K_dist, dist}, {K_dir, dir}, {K_ref, ref}, {K_s, s}, {K_e, prev_end()}});
}

Val P::axis_adv() {
  if (accept_word(u"horizontally")) return u"horizontally";
  if (accept_word(u"vertically")) return u"vertically";
  return nullptr;
}

Val P::objref() {
  const Token& k = cur();
  const Offset s = k.s;
  if (accept_word(u"origin")) return rec({{K_kind, u"origin"}, {K_name, nullptr}, {K_anchor, nullptr}, {K_s, s}, {K_e, k.e}});
  if (accept_word(u"body")) {
    Val anc = anchor();
    return rec({{K_kind, u"body"}, {K_name, nullptr}, {K_anchor, anc}, {K_s, s}, {K_e, prev_end()}});
  }
  if (accept_word(u"side")) {
    const U side = side_word();
    Val anc = anchor();
    return rec({{K_kind, u"side"}, {K_name, side}, {K_anchor, anc}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.t == Tok::Word && among(k.v, KINDS)) {
    accept_word(k.v);
    Val nm = name_what(u"a " + k.v + u" name");
    Val anc = anchor();
    return rec({{K_kind, k.v == u"ball" ? V(u"pad") : V(k.v)}, {K_alias, k.v}, {K_name, O(nm).get(K_name)}, {K_anchor, anc}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.t == Tok::Str || (k.t == Tok::Num && k.is_int) || (k.t == Tok::Word && !k.kw)) {
    Val nm = run<g::name>();
    Val anc = anchor();
    return rec({{K_kind, nullptr}, {K_name, O(nm).get(K_name)}, {K_anchor, anc}, {K_s, s}, {K_e, prev_end()}});
  }
  expected(u"an object (`pad 1`, `hole M1`, `row A`, `group G`, `side left`, `body` or `origin`)");
}

Val P::anchor() {
  const Token& k = cur();
  if (k.t == Tok::Word && among(k.v, ANCHORS)) { advance(); return k.v; }
  return nullptr;
}

U P::side_word() {
  const Token& k = cur();
  if (k.t != Tok::Word || !among(k.v, SIDE_WORDS)) expected(u"`left`, `right`, `top` or `bottom`");
  advance();
  return k.v;
}

/** An object's name (a pad, hole, row or group): a whole number, an identifier or a
 *  "string". A keyword needs quotes here, since it would read as part of the statement. */
Val P::name() { return name_what({}); }

Val P::name_what(V what) {
  const Token& k = cur();
  if (k.t == Tok::Str) {
    advance();
    return rec({{K_name, str_node(k)}, {K_s, k.s}, {K_e, k.e}, {K_quoted, true}});
  }
  if (k.t == Tok::Num && k.is_int) { advance(); return rec({{K_name, num_text(js::parse_float(k.text))}, {K_s, k.s}, {K_e, k.e}}); }
  if (k.t == Tok::Word && !k.kw) { advance(); return rec({{K_name, k.v}, {K_s, k.s}, {K_e, k.e}}); }
  if (k.t == Tok::Word && k.kw) fail_at(u"`" + k.v + u"` is a keyword — quote it to use it as a name: \"" + k.v + u"\"");
  if (k.t == Tok::Num) fail_at(u"a name must be a whole number, an identifier or a \"string\", found `" + k.text + u"`");
  expected(what.empty() ? V(u"a name") : what);
}

// Pads (parser.js 1356-1506)

/** `[tht] SHAPE` and its properties, in any order. */
Val P::pad_geom() {
  const Offset s = cur().s;
  const bool tht = accept_word(u"tht") != nullptr;
  Val shape = run<g::shape_spec>();
  Val drill = nullptr;
  auto props = list();
  while (pad_key_ahead(0)) {
    const Token& k = cur();
    if (k.v == u"drill") {
      if (drill.truthy()) fail_at(u"`drill:` is given twice", &k);
      drill = run<g::drill_spec>();
    } else props->a.push_back(run<g::pad_prop>());
  }
  return rec({{K_tht, tht}, {K_shape, shape}, {K_drill, drill}, {K_props, props}, {K_s, s}, {K_e, prev_end()}});
}

Val P::shape_spec() {
  const Token& k = cur();
  if (k.t != Tok::Word || !among(k.v, SHAPES)) expected(u"a pad shape: rect, oval, roundrect, dshape, circle or polygon");
  accept_word(k.v);
  const Offset s = k.s;
  if (k.v == u"rect" || k.v == u"oval") {
    Val sz = run<g::size>();
    return rec({{K_kind, k.v}, {K_size, sz}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.v == u"roundrect") {
    Val sz = run<g::size>();
    expect_key(u"r", u"and a corner radius (`r: 25%` or `r: 0.1`)");
    Val r = run<g::length_or_pct>();
    return rec({{K_kind, u"roundrect"}, {K_size, sz}, {K_r, r}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.v == u"dshape") {
    Val sz = run<g::size>();
    Val flat = accept_key(u"flat") ? Val(side_word()) : Val(nullptr);
    return rec({{K_kind, u"dshape"}, {K_size, sz}, {K_flat, flat}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.v == u"circle") {
    Val d = run<g::expr>();
    return rec({{K_kind, u"circle"}, {K_d, d}, {K_s, s}, {K_e, prev_end()}});
  }
  auto pts = list({run<g::point>(), run<g::point>(), run<g::point>()});
  while (is_p(u"(")) pts->a.push_back(run<g::point>());
  return rec({{K_kind, u"polygon"}, {K_pts, pts}, {K_s, s}, {K_e, prev_end()}});
}

Val P::drill_spec() {
  const Token& k = expect_key(u"drill");
  if (accept_word(u"slot")) {
    Val sz = run<g::size>();
    return rec({{K_slot, sz}, {K_s, k.s}, {K_e, prev_end()}});
  }
  Val d = run<g::expr>();
  return rec({{K_d, d}, {K_s, k.s}, {K_e, prev_end()}});
}

/** `rotate: A`, `mask: …`, `paste: …` or `vias: …`. */
Val P::pad_prop() {
  const Token& k = advance();
  advance();   // the colon
  const Offset s = k.s;
  if (k.v == u"rotate") {
    Val a = run<g::angle>();
    return rec({{K_prop, u"rotate"}, {K_angle, a}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.v == u"mask") {
    if (accept_word(u"none")) return rec({{K_prop, u"mask"}, {K_mode, u"none"}, {K_s, s}, {K_e, prev_end()}});
    if (accept_word(u"defined")) return rec({{K_prop, u"mask"}, {K_mode, u"defined"}, {K_s, s}, {K_e, prev_end()}});
    Val v = run<g::signed_expr>();
    return rec({{K_prop, u"mask"}, {K_mode, u"expand"}, {K_value, v}, {K_s, s}, {K_e, prev_end()}});
  }
  if (k.v == u"paste") {
    if (accept_word(u"none")) return rec({{K_prop, u"paste"}, {K_mode, u"none"}, {K_s, s}, {K_e, prev_end()}});
    if (accept_word(u"divide")) {
      Val nx = run<g::count>();
      expect_word(u"x");
      Val ny = run<g::count>();
      Val coverage = nullptr, gutter = nullptr;
      if (accept_key(u"coverage")) coverage = run<g::percent>();
      else if (accept_key(u"gutter")) gutter = run<g::expr>();
      return rec({{K_prop, u"paste"}, {K_mode, u"divide"}, {K_nx, nx}, {K_ny, ny}, {K_coverage, coverage}, {K_gutter, gutter}, {K_s, s}, {K_e, prev_end()}});
    }
    Val v = run<g::signed_expr>();
    return rec({{K_prop, u"paste"}, {K_mode, u"expand"}, {K_value, v}, {K_s, s}, {K_e, prev_end()}});
  }
  // vias
  Val nx = run<g::count>();
  expect_word(u"x");
  Val ny = run<g::count>();
  expect_key(u"drill", u"(`vias: 3 x 3 drill: 0.3 pitch: 1.1`)");
  Val drill = run<g::expr>();
  expect_key(u"pitch", u"(`vias: 3 x 3 drill: 0.3 pitch: 1.1`)");
  Val pitch = run<g::expr>();
  return rec({{K_prop, u"vias"}, {K_nx, nx}, {K_ny, ny}, {K_drill, drill}, {K_pitch, pitch}, {K_s, s}, {K_e, prev_end()}});
}

/** Properties that change a pad, in any order. */
Val P::pad_props() {
  auto ops = list();
  while (pad_key_ahead(1)) {
    const Token& k = cur();
    const Offset s = k.s;
    if (k.v == u"shape") {
      expect_key(u"shape");
      Val shape = run<g::shape_spec>();
      ops->a.push_back(rec({{K_op, u"shape"}, {K_shape, shape}, {K_s, s}, {K_e, prev_end()}}));
    } else if (k.v == u"size") {
      expect_key(u"size");
      Val sz = run<g::size>();
      ops->a.push_back(rec({{K_op, u"size"}, {K_size, sz}, {K_s, s}, {K_e, prev_end()}}));
    } else if (k.v == u"width") {
      expect_key(u"width");
      Val x = run<g::expr>();
      ops->a.push_back(rec({{K_op, u"width"}, {K_x, x}, {K_s, s}, {K_e, prev_end()}}));
    } else if (k.v == u"length") {
      expect_key(u"length");
      Val x = run<g::expr>();
      ops->a.push_back(rec({{K_op, u"length"}, {K_x, x}, {K_s, s}, {K_e, prev_end()}}));
    } else if (k.v == u"drill") {
      Val d = run<g::drill_spec>();
      ops->a.push_back(rec({{K_op, u"drill"}, {K_drill, d}, {K_s, s}, {K_e, prev_end()}}));
    } else {
      Val p = run<g::pad_prop>();
      ops->a.push_back(rec({{K_op, u"prop"}, {K_prop, p}, {K_s, s}, {K_e, prev_end()}}));
    }
  }
  for (Val& op : ops->a) op.obj()->set(K_unit, st.unit);
  return ops;
}

Val P::signed_expr() {
  if (accept_p(u"+")) return rec({{K_sign, 1}, {K_x, run<g::expr>()}});
  if (accept_p(u"-")) return rec({{K_sign, -1}, {K_x, run<g::expr>()}});
  expected(u"a signed value such as `+0.05` or `-0.05`, or `none`");
}

Val P::percent() {
  const Token& k = cur();
  if (k.t == Tok::Num && k.has_suffix && k.suffix == u"%") { advance(); return rec({{K_pct, k.value}, {K_s, k.s}, {K_e, k.e}}); }
  expected(u"a percentage such as `68%`");
}

Val P::length_or_pct() {
  const Token& k = cur();
  if (k.t == Tok::Num && k.has_suffix && k.suffix == u"%") { advance(); return rec({{K_pct, k.value}, {K_s, k.s}, {K_e, k.e}}); }
  return rec({{K_x, run<g::expr>()}});
}

namespace {
// A constant angle in an expression: a plain number, its negation, or a product of them
std::optional<double> lit(const Val& n) {
  const Obj& o = O(n);
  const V t = o.get(K_type).str();
  if (t == u"num" && !o.get(K_unit).truthy()) return o.get(K_v).num();
  if (t == u"neg") {
    const Obj& x = O(o.get(K_x));
    if (x.get(K_type).str() == u"num" && !x.get(K_unit).truthy()) return -x.get(K_v).num();
    return std::nullopt;
  }
  if (t == u"bin" && o.get(K_op).str() == u"*") {
    const auto a = lit(o.get(K_a));
    const auto b = lit(o.get(K_b));
    if (a && b) return *a * *b;
  }
  return std::nullopt;
}
}  // namespace

/** An angle in degrees: `45`, `45deg`, `0.7854rad` or any expression (`a + 90`).
 *  A constant comes back as { deg }, anything else as { x } to evaluate. */
Val P::angle() {
  const Offset s = cur().s;
  const Token& c = cur();
  if (!expr_start() && !(c.t == Tok::Num && c.has_suffix && (c.suffix == u"deg" || c.suffix == u"rad")))
    expected(u"an angle such as `45`, `45deg` or `0.7854rad`");
  Val x = with_marks(u"angle", [this] { return run<g::expr>(); });
  if (is_word(u"deg")) advance();
  else if (is_word(u"rad")) {
    advance();
    Val b = rec({{K_type, u"num"}, {K_v, 180.0 / std::numbers::pi}, {K_s, S(x)}, {K_e, E(x)}});
    x = rec({{K_type, u"bin"}, {K_op, u"*"}, {K_a, x}, {K_b, b}, {K_s, S(x)}, {K_e, E(x)}});
  }
  if (const auto deg = lit(x)) return rec({{K_deg, *deg}, {K_s, s}, {K_e, prev_end()}});
  return rec({{K_x, x}, {K_s, s}, {K_e, prev_end()}});
}

// Graphics (parser.js 1508-1637)

Val P::gfx_footprint() { return gfx_stmt(u"footprint"); }
Val P::gfx_feature() { return gfx_stmt(u"feature"); }
Val P::gfx_courtyard() { return gfx_stmt(u"courtyard"); }

/** A graphic, then its options in any order (`width: W`, `fill`, `clear`, `layer: L`). */
Val P::gfx_stmt(V where) {
  const Token& k = cur();
  const Offset s = k.s;
  ObjP node;
  if (is_word(u"text")) {
    Val t = text(where);
    node = t.obj();
    node->set(K_op, u"text");
    node->set(K_s, s);
    node->set(K_e, prev_end());
    return node;
  }
  if (accept_word(u"outline")) {
    expect_word(u"body", u"(`outline body offset: 0.15`)");
    node = rec({{K_op, u"outline"}, {K_offset, nullptr}});
  } else if (accept_word(u"line")) {
    Val a = run<g::point>();
    Val b = run<g::point>();
    node = rec({{K_op, u"line"}, {K_a, a}, {K_b, b}});
  } else if (accept_word(u"arc")) {
    Val c = run<g::point>();
    expect_key(u"r", u"(an arc is `arc (x, y) r: R from A to B`)");
    Val r = run<g::expr>();
    expect_word(u"from", u"(an arc is `arc (x, y) r: R from A to B`)");
    Val from = run<g::angle>();
    expect_word(u"to");
    Val to = run<g::angle>();
    node = rec({{K_op, u"arc"}, {K_c, c}, {K_r, r}, {K_from, from}, {K_to, to}});
  } else if (accept_word(u"circle")) {
    Val c = run<g::point>();
    expect_key(u"d", u"(the circle's diameter)");
    Val d = run<g::expr>();
    node = rec({{K_op, u"circle"}, {K_c, c}, {K_d, d}});
  } else if (accept_word(u"rect")) {
    Val c = run<g::point>();
    Val sz = run<g::size>();
    node = rec({{K_op, u"rect"}, {K_c, c}, {K_size, sz}});
  } else if (accept_word(u"polygon")) {
    auto pts = list({run<g::point>(), run<g::point>(), run<g::point>()});
    while (is_p(u"(")) pts->a.push_back(run<g::point>());
    node = rec({{K_op, u"polygon"}, {K_pts, pts}});
  } else if (accept_word(u"hatch")) {
    // chords of a circle across x, from x = A while x < B, every P
    Val c = run<g::point>();
    expect_key(u"d", u"(`hatch (x, y) d: D from A to B pitch: P`)");
    Val d = run<g::expr>();
    expect_word(u"from", u"(`hatch (x, y) d: D from A to B pitch: P`)");
    Val from = run<g::expr>();
    expect_word(u"to");
    Val to = run<g::expr>();
    expect_key(u"pitch", u"(`hatch (x, y) d: D from A to B pitch: P`)");
    Val pitch = run<g::expr>();
    node = rec({{K_op, u"hatch"}, {K_c, c}, {K_d, d}, {K_from, from}, {K_to, to}, {K_pitch, pitch}});
  } else {
    expected(u"a graphic: outline, line, arc, circle, rect, polygon, hatch or text");
  }
  auto once = [&](Key key, const Token& c) {
    if (!node->get(key).nullish()) fail_at(bq(c.v) + u" is given twice", &c);
  };
  const U op = node->get(K_op).str();   // a copy: setting fields below can move the node's strings
  for (;;) {
    const Token& c = cur();
    if (op == u"outline" && accept_key(u"offset")) { once(K_offset, c); node->set(K_offset, run<g::expr>()); }
    else if (accept_key(u"width")) { once(K_width, c); node->set(K_width, run<g::expr>()); }
    else if (where == u"courtyard") break;
    else if (accept_word(u"fill")) {
      if (!among(op, FILLED)) fail_at(u"`fill` fills a circle, rect or polygon", &c);
      node->set(K_fill, true);
    } else if (accept_word(u"clear")) {
      if (!among(op, CLEARED)) fail_at(u"`clear` cuts lines back from the copper, and a circle is left whole", &c);
      node->set(K_clear, true);
    } else if (accept_key(u"layer")) { once(K_layer, c); node->set(K_layer, layer_word({u"silk", u"assembly"})); }
    else break;
  }
  const Val& fill = node->get(K_fill);
  const Val& width = node->get(K_width);
  if (fill.truthy() && width.truthy())
    throw ParseError{u"a filled shape has no line width: drop `width:` or `fill`", S(width), E(width)};
  if (fill.truthy() && node->get(K_clear).truthy())
    throw ParseError{u"`clear` cuts back lines, and a filled shape has none: drop `clear` or `fill`", s, prev_end()};
  node->set(K_s, s);
  node->set(K_e, prev_end());
  return node;
}

/** The word after `layer:`, one of `allowed`. */
U P::layer_word(std::initializer_list<V> allowed) {
  const Token& l = cur();
  if (l.t != Tok::Word || !among(l.v, allowed)) {
    std::vector<U> list_;
    for (V a : allowed) list_.push_back(bq(a));
    U msg;
    for (std::size_t k = 0; k + 1 < list_.size(); ++k) msg += (k ? U(u", ") : U()) + list_[k];
    expected(msg + u" or " + list_.back());
  }
  advance();
  return l.v;
}

/** `text ref | value | "STRING" at (x, y) [size: X] [layer: L]`. */
Val P::text(V where) {
  expect_word(u"text");
  const Token& k = cur();
  Val which;
  if (accept_word(u"ref")) which = rec({{K_field, u"ref"}});
  else if (accept_word(u"value")) which = rec({{K_field, u"value"}});
  else if (k.t == Tok::Str) { advance(); which = rec({{K_str, str_node(k)}}); }
  else expected(u"`ref`, `value` or a \"string\"");
  expect_word(u"at");
  Val at = run<g::point>();
  Val sz = nullptr, layer = nullptr;
  for (;;) {
    const Token& c = cur();
    if (accept_key(u"size")) {
      if (sz.truthy()) fail_at(u"`size:` is given twice", &c);
      sz = run<g::expr>();
    } else if (accept_key(u"layer")) {
      if (layer.truthy()) fail_at(u"`layer:` is given twice", &c);
      layer = where == u"feature" ? layer_word({u"silk", u"assembly"}) : layer_word({u"silk", u"assembly", u"copper", u"mask"});
    } else break;
  }
  return rec({{K_type, u"Text"}, {K_which, which}, {K_at, at}, {K_size, sz}, {K_layer, layer}});
}

/** `courtyard: auto [clearance]`, `rect W x L`, `rect (x, y) W x L` or `polygon` with four corners. */
Val P::courtyard() {
  expect_key(u"courtyard");
  if (accept_word(u"auto")) {
    Val clearance = expr_start() ? run<g::expr>() : Val(nullptr);
    return rec({{K_type, u"Layer"}, {K_layer, u"courtyard"}, {K_mode, u"auto"}, {K_clearance, clearance}});
  }
  if (is_word(u"rect") && !(is_p(u"(", 1) && paren_has_comma(1))) {
    accept_word(u"rect");
    Val sz = run<g::size>();
    return rec({{K_type, u"Layer"}, {K_layer, u"courtyard"}, {K_mode, u"rect"}, {K_size, sz}});
  }
  if (is_word(u"rect") || is_word(u"polygon")) {
    Val gr = run<g::gfx_courtyard>();
    gr.obj()->set(K_unit, st.unit);
    return rec({{K_type, u"Layer"}, {K_layer, u"courtyard"}, {K_mode, u"block"}, {K_items, list({gr})}});
  }
  fail_at(u"a courtyard is one rectangle: `courtyard: auto`, `rect W x L`, `rect (x, y) W x L`, or `polygon` and four corners");
}

// The 3D model (parser.js 1639-1864)

Val P::model() {
  if (accept_word(u"no")) {
    expect_word(u"model", u"after `no`");
    return rec({{K_type, u"Model"}, {K_none, true}});
  }
  const Token& head = expect_word(u"model");
  Block blk = block(head, u"`model`", [this] { return run<g::model_item>(); }, false, [this] { return ends_model(); });
  return rec({{K_type, u"Model"}, {K_props, list(std::move(blk.stmts))}});
}

/** A footprint statement that a model block can't hold: its `end` must be missing. */
bool P::ends_model() {
  const Token& k = cur();
  if (k.t != Tok::Word) return false;
  if (is_p(u"=", 1)) return true;
  if (model_word(k.v)) return k.v == u"body" && !(is_word(u"color", 1) || is_word(u"shape", 1));
  return stmt_word(k.v);
}

/** A model setting or solid. */
Val P::model_item() {
  const Token& k = cur();
  const Offset s = k.s;
  ObjP p;
  if (k.t == Tok::Word && among(k.v, SOLIDS)) {
    if (is_p(u":", 1)) fail_at(bq(k.v) + u" takes no colon", &peek(1));
    p = solid(false).obj();
  } else if (is_word(u"feature")) {
    fail_at(u"place a feature in the footprint, after the `model` block: `feature NAME at (x, y, z)` adds its solids to the model, and its silk");
  } else if (accept_key(u"standoff")) p = rec({{K_key, u"standoff"}, {K_x, run<g::expr>()}});
  else if (accept_key(u"height")) p = rec({{K_key, u"height"}, {K_x, run<g::expr>()}});
  else if (accept_key(u"draft")) p = rec({{K_key, u"draft"}, {K_angle, run<g::angle>()}});
  else if (accept_word(u"body")) {
    if (accept_key(u"color")) p = rec({{K_key, u"bodyColor"}, {K_color, run<g::color>()}});
    else if (accept_key(u"shape")) p = rec({{K_key, u"bodyShape"}, {K_call, run<g::feature_call>()}});
    else expected(u"`color:` or `shape:` after `body`");
  } else if (accept_word(u"leads")) {
    if (accept_key(u"color")) p = rec({{K_key, u"leadsColor"}, {K_color, run<g::color>()}});
    else if (accept_key(u"thickness")) p = rec({{K_key, u"thickness"}, {K_x, run<g::expr>()}});
    else if (accept_key(u"below")) p = rec({{K_key, u"below"}, {K_x, run<g::expr>()}});
    else if (accept_key(u"above")) p = rec({{K_key, u"above"}, {K_x, run<g::expr>()}});
    else if (accept_key(u"shape")) p = rec({{K_key, u"leadsShape"}, {K_call, run<g::feature_call>()}});
    else expected(u"`color:`, `thickness:`, `below:`, `above:` or `shape:` after `leads`");
  } else if (accept_key(u"pin1")) {
    const Token& v = cur();
    if (v.t != Tok::Word || !among(v.v, {u"dimple", u"dot", u"notch", u"stripe", u"none"}))
      expected(u"a pin-1 mark: `dimple`, `dot`, `notch`, `stripe` or `none`");
    advance();
    p = rec({{K_key, u"pin1"}, {K_v, v.v}});
  } else if (accept_key(u"step")) {
    const Token& f = cur();
    if (f.t != Tok::Str) expected(u"a \"file path\" for the STEP model");
    advance();
    ObjP xform = rec({});
    p = rec({{K_key, u"step"}, {K_file, str_node(f)}, {K_xform, xform}});
    for (;;) {
      const Token& c = cur();
      auto once = [&](Key key) {
        if (xform->get(key).truthy()) fail_at(u"`" + key_name(key) + u":` is given twice", &c);
      };
      if (accept_key(u"offset")) { once(K_offset); xform->set(K_offset, run<g::point3>()); }
      else if (accept_key(u"rotate")) { once(K_rotate); xform->set(K_rotate, run<g::point3>()); }
      else if (accept_key(u"scale")) { once(K_scale); xform->set(K_scale, run<g::expr>()); }
      else break;
    }
  } else {
    expected(u"a model setting (standoff:, height:, draft:, body color:, body shape:, leads …, pin1:, step:) or a solid");
  }
  p->set(K_s, s);
  p->set(K_e, prev_end());
  return p;
}

Val P::solid_footprint() { return solid(false); }
Val P::solid_feature() { return solid(true); }

/** A solid: its size, then options in any order (SPEC 13.3). */
Val P::solid(bool in_feature) {
  const Token& k = advance();
  const U kind = k.v;
  ObjP p = rec({{K_key, u"solid"}, {K_kind, kind}});
  auto dia = [&](V what) {
    expect_key(u"d", u"after `" + kind + u"` (" + U(what) + u")");
    return run<g::expr>();
  };
  if (kind == u"box" || kind == u"slab") {
    with_marks(u"box", [&] {
      p->set(K_w, run<g::expr>());
      expect_word(u"x", u"(a " + kind + u" is `W x L x H`)");
      p->set(K_l, run<g::expr>());
      expect_word(u"x", u"(a " + kind + u" is `W x L x H`)");
      p->set(K_h, run<g::expr>());
      return 0;
    });
    if (kind == u"slab" && accept_word(u"castellated")) p->set(K_castellated, true);
  } else if (kind == u"cylinder") {
    p->set(K_d, dia(u"`cylinder d: D h: H`"));
    if (accept_word(u"to")) p->set(K_d2, run<g::expr>());
    expect_key(u"h", u"(a cylinder is `d: D h: H`)");
    p->set(K_h, run<g::expr>());
  } else if (kind == u"sphere") {
    p->set(K_d, dia(u"`sphere d: D`"));
    if (accept_key(u"h")) p->set(K_h, run<g::expr>());
  } else if (kind == u"disc") {
    p->set(K_d, dia(u"`disc d: D`"));
    if (accept_word(u"to")) p->set(K_d2, run<g::expr>());
  } else if (kind == u"prism") {
    p->set(K_path, run<g::path>());
    expect_key(u"h", u"(a prism is `prism PATH h: H`)");
    p->set(K_h, run<g::expr>());
  } else if (kind == u"face") {
    p->set(K_path, run<g::path>());
  } else if (kind == u"loft") {
    auto rings = list();
    p->set(K_rings, rings);
    do {
      const Offset rs = cur().s;
      Val w = run<g::expr>();
      expect_word(u"x", u"(each ring of a loft is `W x L at Z`)");
      Val l = run<g::expr>();
      expect_word(u"at", u"(each ring of a loft is `W x L at Z`)");
      Val z = run<g::expr>();
      rings->a.push_back(rec({{K_w, w}, {K_l, l}, {K_z, z}, {K_s, rs}, {K_e, prev_end()}}));
    } while (accept_p(u","));
    if (rings->a.size() < 2) fail_at(u"a loft needs two rings or more: `loft W x L at Z, W x L at Z`");
  } else if (kind == u"sweep" || kind == u"wire") {
    if (kind == u"sweep") {
      p->set(K_w, run<g::expr>());
      expect_word(u"x", u"(a sweep is `W x T along PATH`)");
      p->set(K_t, run<g::expr>());
    } else {
      p->set(K_d, dia(u"`wire d: D along PATH`"));
    }
    if (accept_key(u"fillet")) {
      p->set(K_fillet, run<g::expr>());
      if (accept_key(u"step")) p->set(K_step, run<g::angle>());
    }
    if (!is_word(u"along")) expected(u"`along` and a path (`" + kind + u" … along (x, z), (x, z), …`)");
    accept_word(u"along");
    p->set(K_path, run<g::path>());
  }
  for (;;) {
    const Token& c = cur();
    auto once = [&](Key key) {
      if (!p->get(key).nullish()) fail_at(bq(c.v) + u" is given twice", &c);
    };
    if (accept_word(u"at")) { once(K_at); p->set(K_at, run<g::point3opt>()); }
    else if (is_word(u"on") && is_word(u"body", 1)) {
      if (in_feature) fail_at(u"`on body` works in a footprint's model block; in a feature, give the height in `at (x, y, z)`");
      advance();
      advance();
      p->set(K_onBody, true);
    } else if (accept_key(u"rotate")) { once(K_rotate); p->set(K_rotate, run<g::rotation>()); }
    else if (accept_key(u"color")) { once(K_color); p->set(K_color, run<g::color>()); }
    else if (accept_key(u"name")) {
      once(K_name);
      const Token& v = cur();
      if (v.t == Tok::Str) { advance(); p->set(K_name, str_node(v)); }
      else if (expr_start()) p->set(K_name, rec({{K_x, run<g::expr>()}}));   // a name that holds text: a parameter
      else expected(u"a name for the solid: a \"string\", or a parameter that holds one");
    } else if (accept_key(u"kind")) {
      once(K_solidKind);
      const Token& v = cur();
      if (v.t != Tok::Word || !among(v.v, {u"body", u"lead", u"mark"})) expected(u"`body`, `lead` or `mark`");
      advance();
      p->set(K_solidKind, v.v);
    } else if (accept_word(u"open")) {
      once(K_open);
      p->set(K_open, accept_word(u"top") ? u"top" : accept_word(u"bottom") ? u"bottom" : u"both");
    } else if (accept_word(u"from")) {
      once(K_from);
      p->set(K_from, run<g::angle>());
      expect_word(u"to", u"(`from A to B`)");
      p->set(K_to, run<g::angle>());
    } else if (accept_key(u"segments")) { once(K_segments); p->set(K_segments, run<g::expr>()); }
    else if (accept_word(u"down")) p->set(K_down, true);
    else break;
  }
  p->set(K_s, k.s);
  p->set(K_e, prev_end());
  return p;
}

/** A path: points and arcs, `(x, y), arc (cx, cy) r: R from A to B [segments: N], ...`. */
Val P::path() {
  auto items = list();
  do {
    const Offset s = cur().s;
    if (accept_word(u"arc")) {
      Val c = run<g::point>();
      expect_key(u"r", u"(an arc is `arc (x, y) r: R from A to B`)");
      Val r = run<g::expr>();
      expect_word(u"from", u"(an arc is `arc (x, y) r: R from A to B`)");
      Val from = run<g::angle>();
      expect_word(u"to");
      Val to = run<g::angle>();
      Val segments = accept_key(u"segments") ? run<g::expr>() : Val(nullptr);
      items->a.push_back(rec({{K_arc, true}, {K_c, c}, {K_r, r}, {K_from, from}, {K_to, to}, {K_segments, segments}, {K_s, s}, {K_e, prev_end()}}));
    } else if (is_p(u"(")) {
      Val pt = run<g::point>();
      items->a.push_back(rec({{K_pt, pt}, {K_s, s}, {K_e, prev_end()}}));
    } else expected(u"a point `(x, y)` or `arc (x, y) r: R from A to B`");
  } while (accept_p(u","));
  return items;
}

/** `(rx, ry, rz)` or one angle (about z), in degrees. */
Val P::rotation() {
  auto as_num = [](const Val& a) -> Val {
    const Obj& o = O(a);
    if (o.get(K_x).truthy()) return o.get(K_x);
    return rec({{K_type, u"num"}, {K_v, o.get(K_deg)}, {K_s, o.get(K_s)}, {K_e, o.get(K_e)}});
  };
  if (!(is_p(u"(") && paren_has_comma(0))) {
    Val a = run<g::angle>();
    Val zero = rec({{K_type, u"num"}, {K_v, 0}, {K_s, O(a).get(K_s)}, {K_e, O(a).get(K_s)}});
    return rec({{K_x, zero}, {K_y, zero}, {K_z, as_num(a)}, {K_s, O(a).get(K_s)}, {K_e, O(a).get(K_e)}});
  }
  const Token& open = expect_p(u"(");
  Val x = as_num(run<g::angle>());
  expect_p(u",", u"(a rotation is `(rx, ry, rz)` in degrees, or one angle about z)");
  Val y = as_num(run<g::angle>());
  expect_p(u",", u"(a rotation is `(rx, ry, rz)` in degrees, or one angle about z)");
  Val z = as_num(run<g::angle>());
  const Token& close = expect_p(u")");
  return rec({{K_x, x}, {K_y, y}, {K_z, z}, {K_s, open.s}, {K_e, close.e}});
}

/** A color: a name, "#rrggbb", or an expression such as `mix(body_color, "#000000", 0.5)`. */
Val P::color() {
  const Token& k = cur();
  if (k.t == Tok::Str) {
    advance();
    return rec({{K_type, u"str"}, {K_value, str_node(k)}, {K_s, k.s}, {K_e, k.e}});
  }
  if (expr_start()) return run<g::expr>();
  expected(u"a color: a \"#rrggbb\" string or a name such as black, tin or gold");
}

// Values (parser.js 1866-2024)

/** Can an expression start at offset k? A word followed by `:` names a value instead. */
bool P::expr_start(std::size_t k) const {
  const Token& x = peek(k);
  if (x.t == Tok::Num) return !x.has_suffix || !(x.suffix == u"%" || x.suffix == u"deg" || x.suffix == u"rad");
  if (x.t == Tok::Word) return !hard(x.v) && !is_p(u":", k + 1);
  return x.t == Tok::P && (x.v == u"(" || x.v == u"-");
}

Val P::expr() {
  Val a = run<g::term>();
  while (is_p(u"+") || is_p(u"-")) {
    const U op = advance().v;
    Val b = run<g::term>();
    a = rec({{K_type, u"bin"}, {K_op, op}, {K_a, a}, {K_b, b}, {K_s, S(a)}, {K_e, E(b)}});
  }
  return a;
}

Val P::term() {
  Val a = run<g::factor>();
  while (is_p(u"*") || is_p(u"/")) {
    const U op = advance().v;
    Val b = run<g::factor>();
    a = rec({{K_type, u"bin"}, {K_op, op}, {K_a, a}, {K_b, b}, {K_s, S(a)}, {K_e, E(b)}});
  }
  return a;
}

Val P::factor() {
  const Token& k = cur();
  if (accept_p(u"-")) {
    Val x = run<g::primary>();
    return rec({{K_type, u"neg"}, {K_x, x}, {K_s, k.s}, {K_e, E(x)}});
  }
  return run<g::primary>();
}

Val P::primary() {
  const Token& k = cur();
  if (k.t == Tok::Num) {
    if (k.has_suffix && k.suffix == u"%") fail_at(u"a percentage isn't allowed here");
    if (k.has_suffix && (k.suffix == u"deg" || k.suffix == u"rad")) {
      if (st.marks != u"angle") fail_at(u"an angle isn't allowed here");
      advance();
      return rec({{K_type, u"num"}, {K_v, k.suffix == u"rad" ? (k.value * 180) / std::numbers::pi : k.value}, {K_unit, nullptr}, {K_s, k.s}, {K_e, k.e}});
    }
    if (k.axis && st.marks != u"size") mark_error(V(&k.axis, 1), k);
    advance();
    ObjP node = rec({{K_type, u"num"}, {K_v, k.value}, {K_unit, k.has_suffix ? Val(k.suffix) : Val(nullptr)}, {K_s, k.s}, {K_e, k.e}});
    if (k.axis) node->set(K_axis, U(1, k.axis));
    return node;
  }
  if (k.t == Tok::Word && !hard(k.v)) {
    if (is_p(u":", 1)) fail_at(u"expected a value before `" + k.v + u":`");
    // a function call: the name touches its `(` (so table cells `D (D - 1)` stay two)
    if (is_p(u"(", 1) && peek(1).s == k.e) {
      advance();
      advance();
      auto args = list();
      if (!is_p(u")")) {
        do args->a.push_back(with_marks(st.marks == u"size" ? V() : st.marks, [this] { return run<g::expr>(); }));
        while (accept_p(u","));
      }
      const Token& close = expect_p(u")", u"to close `" + k.v + u"(…)`");
      return rec({{K_type, u"call"}, {K_name, k.v}, {K_args, args}, {K_s, k.s}, {K_e, close.e}, {K_nameE, k.e}});
    }
    advance();
    return rec({{K_type, u"id"}, {K_name, k.v}, {K_s, k.s}, {K_e, k.e}});
  }
  if (k.t == Tok::Str) {
    advance();
    return rec({{K_type, u"str"}, {K_value, str_node(k)}, {K_s, k.s}, {K_e, k.e}});
  }
  if (is_p(u"(")) {
    advance();
    Val x = run<g::expr>();
    const Token& close = expect_p(u")");
    ObjP node = rec({{K_type, u"paren"}, {K_x, x}, {K_s, k.s}, {K_e, close.e}});
    // `(D - 0.2)w`: a side mark right after the parenthesis
    const Token& m = cur();
    if (m.t == Tok::Word && m.s == close.e && (m.v == u"w" || (m.v == u"h" && st.marks == u"size"))) {
      if (st.marks != u"size") mark_error(m.v, m);
      advance();
      node->set(K_axis, m.v);
      node->set(K_e, m.e);
    }
    return node;
  }
  if (k.t == Tok::Word) fail_at(u"expected a value, found `" + k.v + u"`");
  expected(u"a number");
}

/** `W x L`. A side marked `w` or `h` (`1.6h x 1.1w`) goes in that slot whatever its place. */
Val P::size() { return size_or_one(true); }

/** `W x L`, or (unless a size is required) a single value: { v }. */
Val P::size_or_one(bool required) {
  return with_marks(u"size", [&]() -> Val {
    Val w = run<g::expr>();
    const U mw = side_mark(w);
    if (!required && !is_word(u"x")) {
      if (!mw.empty()) throw ParseError{u"`" + mw + u"` marks a side of a size, but this is a single value", S(w), E(w)};
      return rec({{K_v, w}});
    }
    expect_word(u"x", u"(sizes are written `WIDTH x LENGTH`)");
    Val l = run<g::expr>();
    const U ml = side_mark(l);
    if (!mw.empty() && mw == ml) throw ParseError{u"both sides are marked `" + mw + u"`: mark one `w` and the other `h`", S(w), E(l)};
    const Offset s = S(w), e = E(l);
    if (mw == u"h" || ml == u"w") std::swap(w, l);
    return rec({{K_w, w}, {K_l, l}, {K_s, s}, {K_e, e}});
  });
}

/** The side mark on an operand of a size. It must come last: `1.1w`, `(e / 2)w`. */
U P::side_mark(const Val& x) {
  U mark;
  const Offset xe = E(x);
  std::function<void(const Val&)> walk = [&](const Val& n) {
    const Obj& o = O(n);
    const Val& axis = o.get(K_axis);
    if (axis.truthy()) {
      if (E(n) != xe) throw ParseError{u"put `" + axis.str() + u"` after the whole side: `(...)" + axis.str() + u"`", S(n), E(n)};
      mark = axis.str();
    }
    for (Key k : {K_a, K_b, K_x}) {
      const Val& c = o.get(k);
      if (c.is_obj()) walk(c);
    }
  };
  walk(x);
  return mark;
}

void P::mark_error(V mark, const Token& tok) {
  if (st.marks == u"body") fail_at(u"a body is always `W x L x H`, so it takes no `w` or `h` marks", &tok);
  if (st.marks == u"box") fail_at(u"a box is always `W x L x H`, so it takes no `w` or `h` marks", &tok);
  if (st.marks == u"cell") fail_at(u"a table cell holds a plain value; mark the sides in the template's sizes instead", &tok);
  fail_at(u"`" + U(mark) + u"` marks a side of a size, as in `rect 1.1w x 1.6h`, and can't be used here", &tok);
}

Val P::point() {
  const Token& open = expect_p(u"(", u"(a point `(x, y)`)");
  Val x = run<g::expr>();
  expect_p(u",", u"between the x and y of a point");
  Val y = run<g::expr>();
  const Token& close = expect_p(u")");
  return rec({{K_x, x}, {K_y, y}, {K_s, open.s}, {K_e, close.e}});
}

/** `(x, y)` or `(x, y, z)`. */
Val P::point3opt() {
  const Token& open = expect_p(u"(", u"(a point `(x, y)` or `(x, y, z)`)");
  Val x = run<g::expr>();
  expect_p(u",", u"between the coordinates");
  Val y = run<g::expr>();
  Val z = accept_p(u",") ? run<g::expr>() : Val(nullptr);
  const Token& close = expect_p(u")");
  return rec({{K_x, x}, {K_y, y}, {K_z, z}, {K_s, open.s}, {K_e, close.e}});
}

Val P::point3() {
  const Token& open = expect_p(u"(");
  Val x = run<g::expr>();
  expect_p(u",");
  Val y = run<g::expr>();
  expect_p(u",");
  Val z = run<g::expr>();
  const Token& close = expect_p(u")");
  return rec({{K_x, x}, {K_y, y}, {K_z, z}, {K_s, open.s}, {K_e, close.e}});
}

}  // namespace stomp::parser

namespace stomp {

ObjP parse(const std::vector<Token>& stream, Diags& diags) {
  std::string classes;
  classes.reserve(stream.size());
  for (const Token& t : stream) classes.push_back(parser::token_class(t));
  parser::Input in(classes.data(), classes.size(), "stomp");
  parser::State st;
  st.toks = &stream;
  st.diags = &diags;
  parser::P p(in, st);
  return p.run<parser::g::file>().obj();
}

}  // namespace stomp
