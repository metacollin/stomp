// Compiling a file (compile.js compile): every footprint built, or replayed from the cache.
#ifndef STOMP_COMPILE_COMPILE_HPP
#define STOMP_COMPILE_COMPILE_HPP

#include <memory>
#include <string>
#include <vector>

#include "../value.hpp"
#include "builder.hpp"

namespace stomp::compiler {

struct LibFile {
  U file;
  U source;
};

struct Options {
  bool cache = true;
  const std::vector<LibFile>* stdlib = nullptr;   // null: the built-in library
};

/** A footprint's result record, and the build it came from (for the lazy layers and hooks). */
struct Result {
  ObjP rec;
  BuilderP builder;
  /** The record with the lazy fields (silk, assembly, courtyard, bbox, ...) added. */
  ObjP full() const;
};
using ResultP = std::shared_ptr<Result>;

struct Compiled {
  ArrP diagnostics;            // finished: positions, lines and columns, sorted
  ArrP footprints;             // { name, s, e, nameS, nameE, mode, result, deps, origin }
  std::vector<ResultP> results;   // per footprint, null where the build failed
  ArrP templates, tables;
  ObjP ast;
  ArrP libraryFiles;
  ArrP libraryDiagnostics;
};

Compiled compile(V source, const Options& opts = {});
void clear_cache();

/** Line and column for diagnostics with offsets into source (compile.js finishDiags). */
ArrP finish_diags(const CDiags& diags, V source);
Val diag_val(const CDiag& d);

}  // namespace stomp::compiler

#endif  // STOMP_COMPILE_COMPILE_HPP
