// The standard library built into this copy of stomp (cmake/EmbedStdlib.cmake).
#include <stomp/stomp.hpp>

#include <cstddef>
#include <string_view>

namespace stomp::detail {
struct EmbeddedFile {
  const char* name;
  const unsigned char* data;
  std::size_t size;
};
extern const EmbeddedFile kStdlibFiles[];
extern const std::size_t kStdlibCount;
}  // namespace stomp::detail

namespace stomp {

const char* version() { return STOMP_VERSION; }

const std::vector<LibraryFile>& builtin_library() {
  static const std::vector<LibraryFile> files = [] {
    std::vector<LibraryFile> out;
    for (std::size_t i = 0; i < detail::kStdlibCount; ++i) {
      const auto& f = detail::kStdlibFiles[i];
      out.push_back({f.name, from_utf8(std::string_view(reinterpret_cast<const char*>(f.data), f.size))});
    }
    return out;
  }();
  return files;
}

}  // namespace stomp
