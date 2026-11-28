// The C functions the JavaScript adapter (demo/js/engine.js) calls. Each one catches
// everything: an exception must never cross into JavaScript.
//
// Input text comes as UTF-16 in wasm memory (the adapter writes it). Results are left
// in an output buffer: stomp_out_ptr()/stomp_out_len() for bytes, stomp_out32_ptr()/
// stomp_out32_len() for 32-bit integers, valid until the next call.
#include <stomp/stomp.hpp>

#include <emscripten/emscripten.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "lexer.hpp"

namespace {

std::string out;                  // the last result, UTF-8 or bytes
std::vector<std::int32_t> out32;  // the last result, as integers

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
