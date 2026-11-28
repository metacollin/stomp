// stomp: a language for PCB footprints. The engine's public API.
//
// Text is UTF-16 throughout, as in the browser editor, so every offset the engine
// reports is the editor's own index. Convert UTF-8 files with from_utf8.
#ifndef STOMP_STOMP_HPP
#define STOMP_STOMP_HPP

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace stomp {

/** The library's version, e.g. "0.1.0". */
const char* version();

/** UTF-8 to UTF-16 and back, as browsers and Node do it: invalid UTF-8 and unpaired surrogates become U+FFFD. */
std::u16string from_utf8(std::string_view utf8);
std::string to_utf8(std::u16string_view utf16);

/** One file of a standard library: its name ("colors.stomp") and its text. */
struct LibraryFile {
  std::string name;
  std::u16string source;
};

/** The standard library built into this copy of stomp, in the order it is read. */
const std::vector<LibraryFile>& builtin_library();

}  // namespace stomp

#endif  // STOMP_STOMP_HPP
