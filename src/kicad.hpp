// KiCad export (demo/js/kicad.js): a footprint's result as a KiCad 9 footprint
// (.kicad_mod) with its 3D model embedded, and a whole .pretty folder.
//
// Embedded files work as in KiCad 9 (file version 20241229): the bytes go in a zstd frame,
// base64-encoded in 76-character lines between "|" marks, with KiCad's MurmurHash3
// checksum. The model is referenced as kicad-embed://NAME. stomp's y axis points up and
// KiCad's points down, so y is negated.
#ifndef STOMP_KICAD_HPP
#define STOMP_KICAD_HPP

#include <optional>
#include <string>
#include <vector>

#include "value.hpp"

namespace stomp::kicad {

inline constexpr int VERSION = 20241229;   // pcbnew file format of KiCad 9.0

struct Footprint {
  std::u16string name;
  std::u16string file;
  std::u16string text;
  std::size_t embedded = 0;          // bytes of the embedded model, or 0
  std::vector<std::u16string> notes;
};

/**
 * One footprint. res is a compile result with its layers (compiler::Result::full); name is
 * the name to write (empty: res.name); vrml is the built model as VRML text to embed, or
 * null for none.
 */
Footprint footprint(const ObjP& res, const std::u16string& name, const std::string* vrml);

/** A file name without the characters file systems refuse ("footprint" when nothing is left). */
std::u16string safe_name(const std::u16string& n);

}  // namespace stomp::kicad

#endif  // STOMP_KICAD_HPP
