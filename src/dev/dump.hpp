// The comparison harness's view of the engine (tests/compare): each layer's output in the
// canonical form, built with exactly the keys the JavaScript engine's objects have.
#ifndef STOMP_DEV_DUMP_HPP
#define STOMP_DEV_DUMP_HPP

#include <string>
#include <string_view>

#include "../diag.hpp"
#include "../json.hpp"
#include "../lexer.hpp"

namespace stomp::dev {

json::Value token_json(const Token& k);
json::Value syntax_diag_json(const Diag& d);   // {severity, message, s, e, syntax: true}

/** A layer's canonical text for one source: "lex", ... (the layers ported so far). */
std::string dump(std::string_view layer, std::u16string_view src, const json::Value* stdlib);

}  // namespace stomp::dev

#endif  // STOMP_DEV_DUMP_HPP
