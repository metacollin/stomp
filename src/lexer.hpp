// The lexer (the token layer of grammar.peg, SPEC 4); a port of demo/js/lexer.js.
//
// Two streams come out of one pass:
//   all:    every token, comments included, for syntax highlighting;
//   stream: what the parser reads. Comments are dropped, and so are newlines that can't
//           end a statement (inside ( ... ) and after ',' or an operator); a `}` becomes
//           an `end`, so a block still closes where the writer meant.
#ifndef STOMP_LEXER_HPP
#define STOMP_LEXER_HPP

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "diag.hpp"

namespace stomp {

enum class Tok : std::uint8_t { Word, Num, Str, P, Nl, Comment, Bad, Eof };

struct Token;

/** A piece of an interpolated string: a literal run, or {code} with its own tokens. */
struct StrPart {
  bool is_lit = true;
  std::u16string lit;                     // a literal run
  Offset s = 0, e = 0;                    // a literal run's range
  Offset open = 0, close = 0, code_s = 0, code_e = 0;
  int fmt = -1;                           // {x:.N}: N, or -1 for none
  Offset fmt_s = -1;                      // where `:` is, or -1 for none
  std::vector<Token> toks;                // the code's parser stream (no newlines or eof)
  std::vector<Token> all;                 // every token of the code (no newlines)
};

struct Token {
  Tok t = Tok::Eof;
  Offset s = 0, e = 0;
  int line = 1;
  Offset col = 1;
  std::u16string v;          // a word, punctuation, a comment or a bad run: its text; a string: its value
  bool v_null = false;       // a string with interpolation has no single value
  bool kw = false;           // a word that is a keyword somewhere
  // numbers
  double value = 0;
  std::u16string text;       // the number with its suffix, as written
  std::u16string num;        // the number alone
  std::u16string suffix;     // mm, um, nm, mil, in, deg, rad or %
  bool has_suffix = false;
  char16_t axis = 0;         // a side mark: w or h
  bool has_axis_key = true;  // false when the size separator touched the number (no axis at all)
  bool is_int = false;
  // strings
  std::shared_ptr<std::vector<StrPart>> parts;   // null: no interpolation
  // bad tokens and the `end` a `}` becomes
  char16_t brace = 0;
  bool from_brace = false;
  int all_index = -1;        // in the parser stream: where the token is in `all` (-1: made up)

  bool is(Tok k, std::u16string_view text_) const { return t == k && v == text_; }
};

struct Lexed {
  std::vector<Token> all;
  std::vector<Token> stream;   // ends with the eof token
  Token eof;
};

/** Lex src. Problems go to diags when it isn't null (the editor lexes without them). */
Lexed lex(std::u16string_view src, Diags* diags);

/** Whether a word is a keyword somewhere (it needs quotes as an object's name). */
bool is_reserved(std::u16string_view word);

}  // namespace stomp

#endif  // STOMP_LEXER_HPP
