// stomp: a language for PCB footprints. The engine's public API.
//
// compile() reads a stomp file and gives its footprints and the problems it found; a
// footprint gives its KiCad 9 footprint and its 3D model.
//
//   const stomp::Compiled out = stomp::compile(text);
//   for (const stomp::Diagnostic& d : out.diagnostics)
//     std::printf("%zu:%zu: %s\n", d.line, d.column, d.message.c_str());
//   for (const stomp::Footprint& fp : out.footprints)
//     if (fp.ok()) save(fp.kicad());
//
// Text comes back as UTF-8. Lines and columns count from 1, and a column counts UTF-16
// code units, as the editor does. The engine keeps a cache between compiles, so use it
// from one thread at a time.
#ifndef STOMP_STOMP_HPP
#define STOMP_STOMP_HPP

#include <cstddef>
#include <cstdint>
#include <memory>
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

/** A problem found in a file. */
struct Diagnostic {
  bool error = true;   // false: a warning
  std::string message;
  std::size_t line = 1, column = 1, end_line = 1, end_column = 1;
  std::string footprint;   // the footprint it is about, if one
  std::string file;        // in Compiled::library_diagnostics, the library file it is in
  /** Other places it involves, such as where a name was first defined. */
  struct Note {
    std::string message;
    std::size_t line = 1, column = 1;
  };
  std::vector<Note> notes;
};

/** A footprint as a KiCad 9 file. */
struct KicadFile {
  std::string file;     // NAME.kicad_mod, with the characters file systems refuse replaced
  std::string text;
  bool model = false;   // the 3D model is embedded in it
};

/** One footprint of a compiled file. Copies share one footprint. */
class Footprint {
 public:
  /** Its name, as the file gives it or a template makes it. */
  const std::string& name() const;
  /** Whether it built. */
  bool built() const;
  /** It built, and no error is about it: what the editor exports. */
  bool ok() const;
  /** Its 3D model as VRML 2.0, 1 unit to 0.1 inch as KiCad reads it; empty if it has none. */
  std::string vrml() const;
  /** Its 3D model as binary STL, in mm; empty if it has none. */
  std::vector<std::uint8_t> stl() const;
  /** The KiCad footprint, with the 3D model embedded. Throws std::logic_error if it didn't build. */
  KicadFile kicad() const;

  struct Impl;
  explicit Footprint(std::shared_ptr<Impl> impl);

 private:
  std::shared_ptr<Impl> impl_;
};

struct Options {
  /** The standard library to compile with; empty for the built-in one. */
  std::vector<LibraryFile> library;
  /** Reuse the footprints that haven't changed since an earlier compile. */
  bool cache = true;
};

struct Compiled {
  std::vector<Diagnostic> diagnostics;           // in order; at one place, errors first
  std::vector<Diagnostic> library_diagnostics;   // problems in Options::library's files
  std::vector<Footprint> footprints;             // in the file's order, with the ones that failed
  bool has_errors() const;
};

/** Compile a file, given as UTF-8 or UTF-16. */
Compiled compile(std::string_view utf8, const Options& options = {});
Compiled compile(std::u16string_view source, const Options& options = {});

}  // namespace stomp

#endif  // STOMP_STOMP_HPP
