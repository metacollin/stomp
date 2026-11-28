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

/** A footprint's result record, and the build it came from (for the outlines, the lazy layers and hooks). */
struct Result {
  ObjP rec;               // without the pads' and holes' outlines
  BuilderP builder;
  std::uint32_t id = 0;   // unique for the process's life: the browser keeps one object per id
  /** The record with the outlines: what compile.js returned, but for the lazy fields. */
  ObjP with_outlines() const;
  /** The record with the outlines and the lazy fields (silk, assembly, courtyard, bbox, ...). */
  ObjP full() const;
  /** About the memory it takes, in KB (most of it is per pad and hole). */
  double kb() const;
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

/** The features the engine calls (SPEC 13.5): name, kind (body, lead, pad, value, silk), the values it passes. */
struct HookInfo {
  U name;
  U kind;
  std::vector<U> args;
};
const std::vector<HookInfo>& hooks_table();
void clear_cache();
/** The library compiles use when they're given none (the built-in one until this is called). */
void set_library(std::vector<LibFile> files);

/** Line and column for diagnostics with offsets into source (compile.js finishDiags). */
ArrP finish_diags(const CDiags& diags, V source);
Val diag_val(const CDiag& d);

}  // namespace stomp::compiler

#endif  // STOMP_COMPILE_COMPILE_HPP
