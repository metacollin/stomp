// stomp: the command-line tool.
//
//   stomp check FILE...                       report problems; exit status 1 if there are errors
//   stomp build FILE... -o DIR                write DIR as a KiCad library (.pretty) of the footprints
//   stomp model FILE [--footprint NAME] (--vrml OUT | --stl OUT)...
//                                             write a footprint's 3D model
//   stomp dev ...                             for working on stomp itself (tests/compare)
//   stomp --version
#include <stomp/stomp.hpp>

#include "compile/compile.hpp"
#include "dev/dump.hpp"
#include "json.hpp"
#include "jsrt.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {

int usage(int status) {
  std::fputs(
      "usage: stomp check FILE...\n"
      "       stomp build FILE... -o DIR\n"
      "       stomp model FILE [--footprint NAME] (--vrml OUT | --stl OUT)...\n"
      "       stomp dev (library | math | dump --layer LAYER [--batch] | bench FILE...)\n"
      "       stomp --version\n"
      "\n"
      "check  reports each file's problems as FILE:LINE:COLUMN: error|warning: MESSAGE.\n"
      "build  writes DIR (say, Parts.pretty) as a KiCad 9 library: a .kicad_mod for each\n"
      "       footprint, with its 3D model embedded. Footprints with errors are left out.\n"
      "model  writes a footprint's 3D model as VRML 2.0 for KiCad (0.1-inch units) or\n"
      "       binary STL (mm). NAME can be left out when the file has one footprint.\n"
      "Exit status: 0 done, 1 errors in the files, 2 a usage problem or a file that\n"
      "can't be read or written.\n",
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
  if (args[0] == "bench") {
    // compile each file (no cache), best of five runs: the footprints and the time
    std::vector<std::u16string> sources;
    for (std::size_t k = 1; k < args.size(); ++k) {
      std::FILE* f = std::fopen(std::string(args[k]).c_str(), "rb");
      if (!f) {
        std::fprintf(stderr, "stomp: can't read %s\n", std::string(args[k]).c_str());
        return 1;
      }
      sources.push_back(stomp::from_utf8(read_all(f)));
      std::fclose(f);
    }
    stomp::compiler::Options opts;
    opts.cache = false;
    double best = 1e300;
    std::size_t count = 0;
    for (int run = 0; run < 5; ++run) {
      const auto t0 = std::chrono::steady_clock::now();
      count = 0;
      for (const auto& src : sources) count += stomp::compiler::compile(src, opts).footprints->a.size();
      const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      if (ms < best) best = ms;
    }
    std::printf("%zu footprints in %.1f ms\n", count, best);
    return 0;
  }
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

// The commands

using Path = std::filesystem::path;
Path path_of(std::string_view utf8) { return Path(std::u8string(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size())); }
std::string shown(const Path& p) {
  const std::u8string s = p.generic_u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

/** A file's text, or nullopt (and a message) if it can't be read. */
std::optional<std::string> read_file(std::string_view name) {
  std::ifstream in(path_of(name), std::ios::binary);
  if (!in) {
    std::fprintf(stderr, "stomp: can't read %.*s\n", static_cast<int>(name.size()), name.data());
    return std::nullopt;
  }
  return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

bool write_file(const Path& p, const void* data, std::size_t n) {
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out.write(static_cast<const char*>(data), static_cast<std::streamsize>(n));
  if (!out) {
    std::fprintf(stderr, "stomp: can't write %s\n", shown(p).c_str());
    return false;
  }
  return true;
}

/** Print a file's problems as FILE:LINE:COLUMN: error|warning: MESSAGE, and its notes. */
void report(std::FILE* to, std::string_view file, const stomp::Compiled& out) {
  const auto put = [&](std::string_view where, const stomp::Diagnostic& d) {
    std::fprintf(to, "%.*s:%zu:%zu: %s: %s", static_cast<int>(where.size()), where.data(), d.line, d.column, d.error ? "error" : "warning",
                 d.message.c_str());
    if (!d.footprint.empty()) std::fprintf(to, " (footprint %s)", d.footprint.c_str());
    std::fputc('\n', to);
    for (const auto& n : d.notes)
      std::fprintf(to, "%.*s:%zu:%zu: note: %s\n", static_cast<int>(where.size()), where.data(), n.line, n.column, n.message.c_str());
  };
  for (const auto& d : out.library_diagnostics) put("stdlib/" + d.file, d);
  for (const auto& d : out.diagnostics) put(file, d);
}

int check(const std::vector<std::string_view>& files) {
  if (files.empty()) return usage(2);
  bool unreadable = false, errors = false;
  for (const auto& f : files) {
    const auto text = read_file(f);
    if (!text) {
      unreadable = true;
      continue;
    }
    const stomp::Compiled out = stomp::compile(*text);
    report(stdout, f, out);
    errors = errors || out.has_errors();
  }
  return unreadable ? 2 : errors ? 1 : 0;
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

int build(const std::vector<std::string_view>& args) {
  std::vector<std::string_view> files;
  std::optional<std::string_view> dir;
  for (std::size_t k = 0; k < args.size(); ++k) {
    if ((args[k] == "-o" || args[k] == "--output") && k + 1 < args.size()) dir = args[++k];
    else if (!args[k].empty() && args[k][0] == '-') return usage(2);
    else files.push_back(args[k]);
  }
  if (files.empty() || !dir) return usage(2);
  const Path out = path_of(*dir);
  std::error_code ec;
  std::filesystem::create_directories(out, ec);
  if (ec) {
    std::fprintf(stderr, "stomp: can't make the folder %s: %s\n", shown(out).c_str(), ec.message().c_str());
    return 2;
  }
  bool unreadable = false, errors = false;
  std::size_t written = 0, models = 0, skipped = 0;
  std::set<std::string> used;   // file names, lowercased: one folder can't hold two that differ only in case
  for (const auto& f : files) {
    const auto text = read_file(f);
    if (!text) {
      unreadable = true;
      continue;
    }
    const stomp::Compiled compiled = stomp::compile(*text);
    report(stderr, f, compiled);
    errors = errors || compiled.has_errors();
    for (const stomp::Footprint& fp : compiled.footprints) {
      if (!fp.ok()) {
        skipped++;
        continue;
      }
      const stomp::KicadFile k = fp.kicad();
      // the same name twice gets _2, _3, ... (as the editor's export does)
      std::string file = k.file;
      const std::string stem = file.substr(0, file.size() - std::strlen(".kicad_mod"));
      for (int n = 2; used.count(lower(file)); ++n) file = stem + "_" + std::to_string(n) + ".kicad_mod";
      used.insert(lower(file));
      if (!write_file(out / path_of(file), k.text.data(), k.text.size())) return 2;
      written++;
      if (k.model) models++;
    }
  }
  std::printf("%s: %zu footprint%s, %zu with a 3D model", shown(out).c_str(), written, written == 1 ? "" : "s", models);
  if (skipped) std::printf("; left out %zu with errors", skipped);
  std::printf("\n");
  return unreadable ? 2 : errors ? 1 : 0;
}

int model(const std::vector<std::string_view>& args) {
  std::optional<std::string_view> file, name, vrml, stl;
  for (std::size_t k = 0; k < args.size(); ++k) {
    const bool more = k + 1 < args.size();
    if (args[k] == "--footprint" && more) name = args[++k];
    else if (args[k] == "--vrml" && more) vrml = args[++k];
    else if (args[k] == "--stl" && more) stl = args[++k];
    else if (!file && !args[k].empty() && args[k][0] != '-') file = args[k];
    else return usage(2);
  }
  if (!file || (!vrml && !stl)) return usage(2);
  const auto text = read_file(*file);
  if (!text) return 2;
  const stomp::Compiled compiled = stomp::compile(*text);
  const auto& fps = compiled.footprints;
  const stomp::Footprint* fp = nullptr;
  if (name) {
    for (const auto& x : fps)
      if (x.name() == *name) fp = &x;
  } else if (fps.size() == 1) {
    fp = &fps[0];
  }
  if (!fp) {
    if (name) std::fprintf(stderr, "stomp: %.*s has no footprint named %.*s", static_cast<int>(file->size()), file->data(), static_cast<int>(name->size()), name->data());
    else std::fprintf(stderr, "stomp: %.*s has %zu footprints; name one with --footprint", static_cast<int>(file->size()), file->data(), fps.size());
    if (!fps.empty()) {
      std::fprintf(stderr, ". It has:");
      for (std::size_t i = 0; i < fps.size() && i < 20; ++i) std::fprintf(stderr, "%s %s", i ? "," : "", fps[i].name().c_str());
      if (fps.size() > 20) std::fprintf(stderr, " and %zu more", fps.size() - 20);
    }
    std::fprintf(stderr, "\n");
    return 2;
  }
  if (!fp->ok()) {
    report(stderr, *file, compiled);
    std::fprintf(stderr, "stomp: %s has errors\n", fp->name().c_str());
    return 1;
  }
  const std::string v = vrml ? fp->vrml() : std::string();
  const std::vector<std::uint8_t> b = stl ? fp->stl() : std::vector<std::uint8_t>();
  if ((vrml && v.empty()) || (stl && b.empty())) {
    std::fprintf(stderr, "stomp: %s has no 3D model\n", fp->name().c_str());
    return 1;
  }
  if (vrml && !write_file(path_of(*vrml), v.data(), v.size())) return 2;
  if (stl && !write_file(path_of(*stl), b.data(), b.size())) return 2;
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string_view> args(argv + 1, argv + argc);
  if (args.empty()) return usage(2);
  const std::string_view cmd = args[0];
  const std::vector<std::string_view> rest(args.begin() + 1, args.end());
  if (cmd == "--version" || cmd == "version") {
    std::printf("stomp %s\n", stomp::version());
    return 0;
  }
  if (cmd == "--help" || cmd == "help" || cmd == "-h") return usage(0);
  try {
    if (cmd == "check") return check(rest);
    if (cmd == "build") return build(rest);
    if (cmd == "model") return model(rest);
    if (cmd == "dev") return dev(rest);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "stomp: internal error: %s\n", e.what());
    return 3;
  }
  return usage(2);
}
