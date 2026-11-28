// The parser's machinery: PEGTL over the lexer's token stream.
//
// PEGTL reads a string with one byte per token, its class: w (word), n (number),
// s (string), L (newline), E (end of file), or the punctuation itself ( ) , ; : = + - * /
// and . for `..`. So a PEGTL position is a token index, and rules read the token itself
// from the parser's state when they need its text.
//
// Each production of the grammar is a PEGTL rule (struct g::NAME), run through PEGTL's
// control, and leaves the AST it builds on the state's stack. They are written as custom
// rules that follow demo/js/parser.js step by step, so the messages and the recovery are
// the same; lookaheads are PEGTL combinators over the token classes.
#ifndef STOMP_PARSER_CONTEXT_HPP
#define STOMP_PARSER_CONTEXT_HPP

#include <tao/pegtl.hpp>

#include <algorithm>
#include <cstddef>
#include <functional>
#include <initializer_list>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "../diag.hpp"
#include "../lexer.hpp"
#include "../value.hpp"

namespace stomp::parser {

namespace pegtl = tao::pegtl;
using Input = pegtl::memory_input<pegtl::tracking_mode::lazy, pegtl::eol::lf_crlf, const char*>;
using U = std::u16string;
using V = std::u16string_view;

/** A syntax error at [s, e): thrown, caught one statement up, reported, then skipped. */
struct ParseError {
  U message;
  Offset s, e;
};

/** The class byte PEGTL reads for a token. */
char token_class(const Token& k);

struct Dedent {
  const Token* head;
  Offset head_e;
  U what;
  const Token* close;
};

struct State {
  const std::vector<Token>* toks = nullptr;
  Diags* diags = nullptr;
  U unit = u"mm";
  V marks;                       // where a `w`/`h` side mark may appear: "size", or a reason it can't
  bool soft_end = false;         // a block stopped short of its `end`: the statement holding it is over
  std::optional<Dedent> dedent;  // the first `end` left of its own block's header
  bool last_from = false;        // the `footprint … from …` line just above has no `with` block
  Val stmt_target;               // what the statement being read is about (for Broken nodes)
  std::vector<Val> stack;        // what productions return
  int depth = 0;                 // productions running (see P::run)
};

// About 250 nested parentheses (4 productions each): far past any real file, and within
// a 512 KB stack for the parser and everything that walks its tree afterwards.
inline constexpr int kMaxDepth = 1000;

class P;

namespace g {
/** A production: a PEGTL rule that runs P::*Fn and leaves its value on the stack. */
template <typename R, Val (P::*Fn)()>
struct production {
  using rule_t = R;
  using subs_t = pegtl::type_list<>;
  template <pegtl::apply_mode, pegtl::rewind_mode, template <typename...> class, template <typename...> class, typename In>
  static bool match(In&, P& p);
};
}  // namespace g

class P {
 public:
  Input& in;
  State& st;
  P(Input& input, State& state) : in(input), st(state) {}

  // The token cursor
  std::size_t i() const { return static_cast<std::size_t>(in.current() - in.begin()); }
  void set_i(std::size_t k) { in.iterator() = in.begin() + k; }
  std::size_t n() const { return st.toks->size(); }
  const Token& at(std::size_t k) const { return (*st.toks)[std::min(k, n() - 1)]; }
  const Token& cur() const { return at(i()); }
  const Token& peek(std::size_t k = 0) const { return at(i() + k); }
  const Token& advance() {
    const Token& k = cur();
    if (k.t != Tok::Eof) in.bump(1);
    return k;
  }
  Offset prev_end() const { return i() > 0 ? (*st.toks)[i() - 1].e : 0; }
  bool is_word(V v, std::size_t k = 0) const { const Token& x = peek(k); return x.t == Tok::Word && x.v == v; }
  bool is_p(V v, std::size_t k = 0) const { const Token& x = peek(k); return x.t == Tok::P && x.v == v; }
  bool is_key(V v, std::size_t k = 0) const { return is_word(v, k) && is_p(u":", k + 1); }
  const Token* accept_p(V v) { return is_p(v) ? &advance() : nullptr; }
  const Token& expect_p(V v, V what = {});
  const Token* accept_word(V v);
  const Token& expect_word(V v, V what = {});
  const Token* accept_key(V v);
  const Token& expect_key(V v, V what = {});
  bool value_at(std::size_t k) const;
  [[noreturn]] void missing_colon();
  [[noreturn]] void expected(V what, const Token* tok = nullptr);
  [[noreturn]] void fail_at(U msg, const Token* tok = nullptr);
  [[noreturn]] void fail_range(U msg, Offset s, Offset e);
  void report(const ParseError& err);
  void note(U msg, Offset s, Offset e);
  template <typename F>
  auto with_marks(V ctx, F&& fn) {
    const V outer = st.marks;
    st.marks = ctx;
    struct Restore { State& st; V m; ~Restore() { st.marks = m; } } restore{st, outer};
    return fn();
  }

  bool at_stmt_end(std::size_t k = 0) const;
  void skip_eos();
  void end_stmt();
  void sync();

  /** Run a production through PEGTL and take its value. */
  template <typename R>
  Val run() {
    // Deep nesting would overflow the stack (and in WebAssembly corrupt memory without a
    // word), so past kMaxDepth productions it is a syntax error instead.
    struct Depth {
      int& d;
      explicit Depth(int& x) : d(x) { ++d; }
      ~Depth() { --d; }
    } depth{st.depth};
    if (st.depth > kMaxDepth) throw ParseError{u"this is nested too deeply to read", cur().s, std::max(cur().e, cur().s + 1)};
    // a production always matches (or throws a ParseError)
    if (!pegtl::normal<R>::template match<pegtl::apply_mode::action, pegtl::rewind_mode::dontcare, pegtl::nothing, pegtl::normal>(in, *this))
      throw std::logic_error("stomp: a production didn't match");
    Val v = std::move(st.stack.back());
    st.stack.pop_back();
    return v;
  }
  /** Does a PEGTL rule match here? (lookaheads: nothing is consumed) */
  template <typename R>
  bool looking_at() {
    const std::size_t save = i();
    const bool ok = pegtl::normal<R>::template match<pegtl::apply_mode::nothing, pegtl::rewind_mode::required, pegtl::nothing, pegtl::normal>(in, *this);
    set_i(save);
    return ok;
  }

  // Productions (parser.js's methods, in its order)
  Val file();
  Val top_stmt();
  Val template_();
  Val feature_decl();
  Val feature_item_let();
  Val feature_item_set();
  Val feature_call();
  Val feature_place();
  Val feature_use();
  Val footprint();
  Val call_args();
  Val table();
  Val cell();
  Val statement();
  Val tag();
  Val origin_stmt();
  Val body_or_placement();
  Val pins();
  Val balls();
  Val count();
  Val pins_clauses();
  Val lead();
  Val thermal();
  Val measure();
  Val region_or_name();
  Val range();
  Val range_end();
  Val sel_list();
  Val sel_item();
  Val pad_or_placement();
  Val hole_or_placement();
  Val row_or_placement();
  Val group_or_placement();
  Val placement();
  Val rel_clause();
  Val objref();
  Val name();
  Val pad_geom();
  Val shape_spec();
  Val drill_spec();
  Val pad_prop();
  Val pad_props();
  Val signed_expr();
  Val percent();
  Val length_or_pct();
  Val angle();
  Val gfx_footprint();
  Val gfx_feature();
  Val gfx_courtyard();
  Val courtyard();
  Val model();
  Val model_item();
  Val solid_footprint();
  Val solid_feature();
  Val path();
  Val rotation();
  Val color();
  Val expr();
  Val term();
  Val factor();
  Val primary();
  Val size();
  Val point();
  Val point3opt();
  Val point3();

  // Helpers that take arguments, or aren't productions of their own
  using StmtFn = std::function<Val()>;
  using StopFn = std::function<bool()>;
  struct Block {
    std::vector<Val> stmts;
    const Token* close = nullptr;
  };
  Val decl(V type);
  Val old_let(V type);
  Val feature_item(bool in_section);
  Val param_list(V what);
  Val flag_name();
  Val skip_block(const ParseError& err, const Token& head, V what, const StmtFn& parse_stmt);
  bool line_opens_block() const;
  const Token& decl_name(V what);
  Block block(const Token& head, V what, const StmtFn& parse_stmt, bool units = false, const StopFn& stops = {});
  Block block_body(const Token& head, V what, const StmtFn& parse_stmt, bool units, const StopFn& stops);
  Val block_units(std::size_t before);
  void missing_end(const Token& head, Offset head_e, V what, const Token& at);
  bool starts_top_item();
  bool feature_decl_ahead() const;
  std::size_t match_paren(std::size_t j) const;
  bool paren_has_comma(std::size_t k) const;
  U unit_word();
  Val str_node(const Token& k);
  bool is_decl();
  bool is_place_ahead(std::size_t k);
  Val sides_block(const Token& head);
  Val name_what(V what);
  Val placement_what(V what);
  Val span_qual();
  Val axis_adv();
  Val anchor();
  U side_word();
  bool pad_key_ahead(int which);   // 0: a pad shape's properties, 1: any pad key
  Val gfx_stmt(V where);
  U layer_word(std::initializer_list<V> allowed);
  Val text(V where);
  bool ends_model();
  Val solid(bool in_feature);
  bool expr_start(std::size_t k = 0) const;
  Val size_or_one(bool required);
  U side_mark(const Val& x);
  [[noreturn]] void mark_error(V mark, const Token& tok);
  Val cell_value();
  Val object_or_null_at(std::size_t j);
};

namespace g {
template <typename R, Val (P::*Fn)()>
template <pegtl::apply_mode, pegtl::rewind_mode, template <typename...> class, template <typename...> class, typename In>
bool production<R, Fn>::match(In&, P& p) {
  p.st.stack.push_back((p.*Fn)());
  return true;
}
#define STOMP_PRODUCTION(n) struct n : production<n, &P::n> {};
STOMP_PRODUCTION(file)
STOMP_PRODUCTION(top_stmt)
STOMP_PRODUCTION(template_)
STOMP_PRODUCTION(feature_decl)
STOMP_PRODUCTION(feature_item_let)
STOMP_PRODUCTION(feature_item_set)
STOMP_PRODUCTION(feature_call)
STOMP_PRODUCTION(feature_place)
STOMP_PRODUCTION(feature_use)
STOMP_PRODUCTION(footprint)
STOMP_PRODUCTION(call_args)
STOMP_PRODUCTION(table)
STOMP_PRODUCTION(cell)
STOMP_PRODUCTION(statement)
STOMP_PRODUCTION(tag)
STOMP_PRODUCTION(origin_stmt)
STOMP_PRODUCTION(body_or_placement)
STOMP_PRODUCTION(pins)
STOMP_PRODUCTION(balls)
STOMP_PRODUCTION(count)
STOMP_PRODUCTION(pins_clauses)
STOMP_PRODUCTION(lead)
STOMP_PRODUCTION(thermal)
STOMP_PRODUCTION(measure)
STOMP_PRODUCTION(region_or_name)
STOMP_PRODUCTION(range)
STOMP_PRODUCTION(range_end)
STOMP_PRODUCTION(sel_list)
STOMP_PRODUCTION(sel_item)
STOMP_PRODUCTION(pad_or_placement)
STOMP_PRODUCTION(hole_or_placement)
STOMP_PRODUCTION(row_or_placement)
STOMP_PRODUCTION(group_or_placement)
STOMP_PRODUCTION(placement)
STOMP_PRODUCTION(rel_clause)
STOMP_PRODUCTION(objref)
STOMP_PRODUCTION(name)
STOMP_PRODUCTION(pad_geom)
STOMP_PRODUCTION(shape_spec)
STOMP_PRODUCTION(drill_spec)
STOMP_PRODUCTION(pad_prop)
STOMP_PRODUCTION(pad_props)
STOMP_PRODUCTION(signed_expr)
STOMP_PRODUCTION(percent)
STOMP_PRODUCTION(length_or_pct)
STOMP_PRODUCTION(angle)
STOMP_PRODUCTION(gfx_footprint)
STOMP_PRODUCTION(gfx_feature)
STOMP_PRODUCTION(gfx_courtyard)
STOMP_PRODUCTION(courtyard)
STOMP_PRODUCTION(model)
STOMP_PRODUCTION(model_item)
STOMP_PRODUCTION(solid_footprint)
STOMP_PRODUCTION(solid_feature)
STOMP_PRODUCTION(path)
STOMP_PRODUCTION(rotation)
STOMP_PRODUCTION(color)
STOMP_PRODUCTION(expr)
STOMP_PRODUCTION(term)
STOMP_PRODUCTION(factor)
STOMP_PRODUCTION(primary)
STOMP_PRODUCTION(size)
STOMP_PRODUCTION(point)
STOMP_PRODUCTION(point3opt)
STOMP_PRODUCTION(point3)
#undef STOMP_PRODUCTION

// Terminals and lookaheads over the token classes
template <std::size_t N>
struct lit {
  char16_t s[N]{};
  constexpr lit(const char16_t (&x)[N]) { std::copy_n(x, N, s); }
  constexpr V view() const { return V(s, N - 1); }
};

/** A word with this text (no colon check: for lookaheads). */
template <lit W>
struct word {
  using rule_t = word;
  using subs_t = pegtl::type_list<>;
  template <pegtl::apply_mode, pegtl::rewind_mode, template <typename...> class, template <typename...> class, typename In>
  static bool match(In& in, P& p) {
    if (in.empty() || in.peek_char() != 'w' || p.cur().v != W.view()) return false;
    in.bump(1);
    return true;
  }
};
/** A token of a class (w n s L E or a punctuation byte). */
template <char C>
using cls = pegtl::one<C>;
/** A word whose text is one of a set. */
template <lit... W>
using one_of = pegtl::sor<word<W>...>;

// `at`, `is` or `mirrors`, maybe after an anchor word (parser.js isPlaceAhead)
using place = one_of<u"at", u"is", u"mirrors">;
using anchor_word = one_of<u"center", u"inner", u"outer", u"left", u"right", u"top", u"bottom">;
using place_ahead = pegtl::sor<place, pegtl::seq<anchor_word, place>>;
}  // namespace g

}  // namespace stomp::parser

#endif  // STOMP_PARSER_CONTEXT_HPP
