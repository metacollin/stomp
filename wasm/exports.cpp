// The C functions the JavaScript adapter (demo/js/engine.js) calls. Each one catches
// everything: an exception must never cross into JavaScript.
//
// Results larger than a number are left in an output buffer: stomp_out_ptr() and
// stomp_out_len() give where it is, valid until the next call.
#include <stomp/stomp.hpp>

#include <emscripten/emscripten.h>

#include <cstdint>
#include <string>

namespace {
std::string out;   // the last result, UTF-8 or bytes
}

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* stomp_version() { return stomp::version(); }

EMSCRIPTEN_KEEPALIVE const char* stomp_out_ptr() { return out.data(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t stomp_out_len() { return static_cast<std::uint32_t>(out.size()); }

/** The built-in library's file names, one per line (a first check that calls work). */
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

}  // extern "C"
