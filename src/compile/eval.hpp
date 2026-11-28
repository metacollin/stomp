// Values and names (compile.js, "Values"): expressions evaluated to numbers, ratios,
// lengths, text and colors, in scopes of names that are evaluated on first use.
#ifndef STOMP_COMPILE_EVAL_HPP
#define STOMP_COMPILE_EVAL_HPP

#include <array>
#include <exception>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../ordered_map.hpp"
#include "../value.hpp"

namespace stomp::compiler {

using U = std::u16string;
using V = std::u16string_view;

/** Standard-library source is read at offsets from here up (compile.js LIB_BASE). */
inline constexpr double LIB_BASE = 1e9;
/** A node from the standard library (compile.js isLib). */
bool is_lib(const ObjP& n);

/** UNIT_MM: mm per unit; NaN for a unit it doesn't know (JavaScript's undefined). */
double unit_mm(V unit);
/** UNIT_MM[unit || 'mm'] for a unit field that may be missing. */
double unit_scale(const Val& unit);

/** Something to report at: an AST node or an { s, e } range. */
ObjP range(double s, double e);

struct Related {
  U message;
  ObjP node;
};
using Rels = std::vector<Related>;

/** A problem in the source (compile.js StompError). */
struct StompError : std::exception {
  U message;
  ObjP node;
  Rels related;
  bool silent = false;
  std::optional<U> missing;   // Scope.lookup: the name a feature has no value for
  StompError(U m, ObjP n, Rels r = {}) : message(std::move(m)), node(std::move(n)), related(std::move(r)) {}
  const char* what() const noexcept override { return "stomp error"; }
};
/** An error that is reported elsewhere already (compile.js SILENT). */
StompError silent(ObjP node);

// Values: 'num' (a plain number; a length in the file's unit where one is needed),
// 'ratio' (length / length), 'len' (mm), 'str' (text) and 'color'.
enum class VK : std::uint8_t { Num, Ratio, Len, Str, Color };
const char16_t* kind_name(VK k);   // KIND_NAME: number, ratio, length, text, color

struct Color {
  std::array<double, 3> rgb{};
  double metal = 0;
  std::optional<U> name;
};

struct EV {
  VK k = VK::Num;
  double v = 0;               // num, ratio, len
  U s;                        // str
  std::shared_ptr<const Color> c;   // color
  static EV num(double v) { return {VK::Num, v, {}, nullptr}; }
  static EV len(double v) { return {VK::Len, v, {}, nullptr}; }
  static EV str(U s) { return {VK::Str, 0, std::move(s), nullptr}; }
  static EV color(Color c) { return {VK::Color, 0, {}, std::make_shared<const Color>(std::move(c))}; }
};

class Scope;
struct Env {
  Scope* scope;
  double scale;
};

/** A name's definition: its expression, the unit it was written in and the scope it is read in. */
struct Def {
  Val x;
  Val unit;                       // the statement's unit ('mm' when missing)
  std::shared_ptr<Scope> scope;   // null: the scope that holds the definition
  std::optional<double> level;    // a footprint's names: the extends level they come from
  ObjP node;                      // the `NAME = value` statement, for footprint names
  std::optional<EV> value;        // once evaluated
  std::optional<U> missing;       // a feature's parameter with no value: the feature's name
  bool busy = false;
};

class Scope : public std::enable_shared_from_this<Scope> {
 public:
  std::shared_ptr<Scope> parent;
  OrderedMap<U, Def> defs;
  std::shared_ptr<Scope> library;   // a root scope's standard-library names, found last

  explicit Scope(std::shared_ptr<Scope> p = nullptr, std::shared_ptr<Scope> lib = nullptr)
      : parent(std::move(p)), library(std::move(lib)) {}
  Scope* root();
  bool has(const U& name) const;
  EV lookup(const U& name, const ObjP& node);
};
using ScopeP = std::shared_ptr<Scope>;

EV eval_expr(const Val& x, const Env& env);

struct Unified {
  VK k;
  double a, b;
};
/** Two values as one kind, the way `+` combines them. */
Unified unify(const EV& a, const EV& b, const Env& env, const ObjP& node, V what);

std::optional<Color> parse_color(V text, const ObjP& node);
Color to_color(const EV& v, const ObjP& node);
/** A color expression: a name (looked up, then the built-in colors), a string or a value. */
Color eval_color(const Val& x, const Env& env);
U hex_of(const std::array<double, 3>& rgb);

/** A string literal's text: plain, or { interp: [text | { x, fmt }] } evaluated in env. */
U interpolate(const Val& value, const Env& env);
U format_value(const EV* v, const Val& fmt, const Env& env);
U format_number(double n, std::optional<int> fmt);

/** The names of the built-in functions, for messages (compile.js FUNCTIONS). */
extern const char16_t* const FUNCTIONS;

}  // namespace stomp::compiler

#endif  // STOMP_COMPILE_EVAL_HPP
