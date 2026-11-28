// The parser: the lexer's stream (lexer.hpp) to the AST, as records (value.hpp) with the
// fields demo/js/parser.js gave its nodes. Built on PEGTL; see parser/context.hpp.
#ifndef STOMP_PARSER_HPP
#define STOMP_PARSER_HPP

#include <vector>

#include "diag.hpp"
#include "lexer.hpp"
#include "value.hpp"

namespace stomp {

/** The File node ({ type: 'File', items }). Syntax errors go to diags; the rest still parses. */
ObjP parse(const std::vector<Token>& stream, Diags& diags);

}  // namespace stomp

#endif  // STOMP_PARSER_HPP
