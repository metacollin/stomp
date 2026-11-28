// 3D models (SPEC 13; demo/js/model3d.js). build turns a compiled footprint into meshes: the
// shapes come from stomp features, the standard library's or the user's. The engine
// measures the part, picks the body and lead features to call (SPEC 13.5), and its kernel
// turns the solids they draw into meshes. board builds the board under it for the viewer;
// to_vrml and to_stl export the part.
//
// Units are mm: x and y as in the footprint, z up from the board (z = 0). Meshes are built in
// doubles and finished as floats, as the JavaScript engine's Float32Arrays.
#ifndef STOMP_MODEL3D_HPP
#define STOMP_MODEL3D_HPP

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "compile/compile.hpp"
#include "json.hpp"
#include "value.hpp"

namespace stomp::model3d {

using U = std::u16string;

struct Mesh {
  U name, kind;
  std::array<double, 3> color{};
  double metal = 0;
  Val src;                          // the source ranges it comes from
  std::vector<float> pos, nrm;      // xyz per vertex
  std::vector<std::uint32_t> idx;   // triangles, counterclockwise seen from outside
};

struct Box3 {
  double x0, y0, z0, x1, y1, z1;
};

struct Model {
  bool none = false;
  std::vector<Mesh> meshes;
  std::vector<U> notes;
  Val style = nullptr, summary = nullptr;
  double H = 0, standoff = 0;
  std::vector<Val> diagnostics;
  // what was built, when the engine got that far
  std::optional<U> short_, mark;
  std::optional<double> leadCount;
  // finished
  std::optional<Box3> bbox;
  std::optional<double> top;
  double triangles = 0;
  // the board
  bool board = false;
  std::vector<std::array<double, 6>> lines;
  Box3 extent{}, core{};
};

/** The part's model. strict throws on a problem instead of reporting it. */
Model build(const compiler::Result& res, bool strict = false);
/** The board under the part, for the viewer: res is the full result (with its layers). */
Model board(const ObjP& res, const Model* model);
/** VRML 2.0 for KiCad: 1 unit is 0.1 inch; repeated parts are written once and placed with USE. */
std::string to_vrml(const Model& model, const U& name);
/** Binary STL, mm. */
std::vector<std::uint8_t> to_stl(const Model& model, const U& name);
/** The model as the JavaScript engine's object (typed arrays included), for JSON and canon. */
json::Value to_json(const Model& model);
/** A record as a JSON value. */
json::Value val_json(const Val& v);

}  // namespace stomp::model3d

#endif  // STOMP_MODEL3D_HPP
