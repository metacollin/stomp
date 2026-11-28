// Diagnostics: the problems the lexer, parser and compiler report.
#ifndef STOMP_DIAG_HPP
#define STOMP_DIAG_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace stomp {

/** A position in the text, in UTF-16 units. The standard library's files are read at 1e9 and up. */
using Offset = std::int64_t;

enum class Severity : std::uint8_t { Error, Warning };

struct Diag {
  Severity severity = Severity::Error;
  std::u16string message;
  Offset s = 0, e = 0;
  bool syntax = false;   // from the lexer or the parser
};

using Diags = std::vector<Diag>;

}  // namespace stomp

#endif  // STOMP_DIAG_HPP
