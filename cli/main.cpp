// stomp: the command-line tool.
//
//   stomp check FILE...                 report problems; exit status 1 if there are errors
//   stomp build FILE... -o DIR          write a KiCad .pretty library
//   stomp model FILE --footprint NAME (--vrml | --stl) OUT
//   stomp dev ...                       for working on stomp itself (tests/compare)
//   stomp --version
#include <stomp/stomp.hpp>

#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace {

int usage(int status) {
  std::fputs(
      "usage: stomp check FILE...\n"
      "       stomp build FILE... -o DIR\n"
      "       stomp model FILE --footprint NAME (--vrml | --stl) OUT\n"
      "       stomp dev (library | dump --layer LAYER)\n"
      "       stomp --version\n",
      status ? stderr : stdout);
  return status;
}

int dev(const std::vector<std::string_view>& args) {
  if (args.empty()) return usage(2);
  if (args[0] == "library") {
    for (const auto& f : stomp::builtin_library()) std::printf("%s %zu\n", f.name.c_str(), f.source.size());
    return 0;
  }
  if (args[0] == "dump") {
    std::fprintf(stderr, "stomp dev dump: no layer is ported yet\n");
    return 3;
  }
  return usage(2);
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty()) return usage(2);
  const std::string_view cmd = args[0];
  const std::vector<std::string_view> rest(args.begin() + 1, args.end());
  if (cmd == "--version" || cmd == "version") { std::printf("stomp %s\n", stomp::version()); return 0; }
  if (cmd == "--help" || cmd == "help") return usage(0);
  if (cmd == "dev") return dev(rest);
  if (cmd == "check" || cmd == "build" || cmd == "model") {
    std::fprintf(stderr, "stomp %.*s: not ready yet; the engine is being ported\n", static_cast<int>(cmd.size()), cmd.data());
    return 3;
  }
  return usage(2);
}
