// stomp: the command-line tool.
//
//   stomp check FILE...                 report problems; exit status 1 if there are errors
//   stomp build FILE... -o DIR          write a KiCad .pretty library
//   stomp model FILE --footprint NAME (--vrml | --stl) OUT
//   stomp dev ...                       for working on stomp itself (tests/compare)
//   stomp --version
#include <stomp/stomp.hpp>

#include "dev/dump.hpp"
#include "json.hpp"
#include "jsrt.hpp"

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
      "       stomp dev (library | math | dump --layer LAYER [--batch])\n"
      "       stomp --version\n",
      status ? stderr : stdout);
  return status;
}

std::string read_all(std::FILE* f) {
  std::string out;
  char buf[1 << 16];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  return out;
}

int dev(const std::vector<std::string_view>& args) {
  if (args.empty()) return usage(2);
  if (args[0] == "library") {
    for (const auto& f : stomp::builtin_library()) std::printf("%s %zu\n", f.name.c_str(), f.source.size());
    return 0;
  }
  if (args[0] == "math") {
    // records of three doubles (function, a, b) on stdin; one double each on stdout
    // (tests/compare/math.mjs compares them with Node's Math)
    double rec[3];
    std::vector<double> out;
    while (std::fread(rec, sizeof(double), 3, stdin) == 3) {
      const double a = rec[1], b = rec[2];
      double r = 0;
      switch (static_cast<int>(rec[0])) {
        case 0: r = stomp::js::sin(a); break;
        case 1: r = stomp::js::cos(a); break;
        case 2: r = stomp::js::tan(a); break;
        case 3: r = stomp::js::asin(a); break;
        case 4: r = stomp::js::acos(a); break;
        case 5: r = stomp::js::atan2(a, b); break;
        case 6: r = stomp::js::hypot({a, b}); break;
        case 7: r = stomp::js::round(a); break;
        default: break;
      }
      out.push_back(r);
    }
    std::fwrite(out.data(), sizeof(double), out.size(), stdout);
    return 0;
  }
  if (args[0] == "dump") {
    // --layer L:          one input, JSON {src, stdlib?}, on stdin; the canonical text out
    // --layer L --batch:  JSON lines {id, src, stdlib?} in; JSON lines {id, text} or {id, error} out
    std::string layer;
    bool batch = false;
    for (std::size_t k = 1; k < args.size(); ++k) {
      if (args[k] == "--layer" && k + 1 < args.size()) layer = std::string(args[++k]);
      else if (args[k] == "--batch") batch = true;
    }
    const std::string in = read_all(stdin);
    auto one = [&](const stomp::json::Value& v) {
      const stomp::json::Value* src = v.get(u"src");
      const stomp::json::Value* lib = v.get(u"stdlib");
      return stomp::dev::dump(layer, src ? src->string() : std::u16string(), lib && !lib->is_null() ? lib : nullptr);
    };
    if (!batch) {
      try {
        const std::string text = one(stomp::json::parse(in));
        std::fwrite(text.data(), 1, text.size(), stdout);
        return 0;
      } catch (const std::exception& e) {
        std::fprintf(stderr, "stomp dev dump: %s\n", e.what());
        return 1;
      }
    }
    std::size_t at = 0;
    while (at < in.size()) {
      std::size_t end = in.find('\n', at);
      if (end == std::string::npos) end = in.size();
      const std::string_view line(in.data() + at, end - at);
      at = end + 1;
      if (line.empty()) continue;
      stomp::json::Value out = stomp::json::object();
      try {
        const stomp::json::Value v = stomp::json::parse(line);
        if (const auto* id = v.get(u"id")) out.set(u"id", *id);
        out.set(u"text", stomp::from_utf8(one(v)));
      } catch (const std::exception& e) {
        out.set(u"error", stomp::from_utf8(e.what()));
      }
      std::string text = stomp::json::write(out);
      text.push_back('\n');
      std::fwrite(text.data(), 1, text.size(), stdout);
    }
    return 0;
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
