// Records: the engine's AST and results, as the JavaScript engine had them, objects with
// named fields in insertion order, arrays, strings, numbers, booleans and null. Objects and
// arrays are shared by reference (a node can be in two places, and results point at the
// statements they came from), so they are held by shared_ptr.
//
// Field names are interned: a Key is a small number, and the common ones are constants
// (K_type, K_s, ...). The editor reads these records as JSON, field for field.
#ifndef STOMP_VALUE_HPP
#define STOMP_VALUE_HPP

#include <cstdint>
#include <functional>
#include <initializer_list>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace stomp {

struct Key {
  std::uint32_t id = 0;
  friend bool operator==(Key a, Key b) { return a.id == b.id; }
  friend bool operator!=(Key a, Key b) { return a.id != b.id; }
};
Key key(std::u16string_view name);                 // interned
const std::u16string& key_name(Key k);

// The field names used in the AST and results
#define STOMP_KEYS(X)                                                                                         \
  X(type) X(s) X(e) X(unit) X(name) X(nameS) X(nameE) X(x) X(y) X(z) X(params) X(def) X(body) X(items)         \
  X(template) X(args) X(callS) X(callE) X(mode) X(parent) X(header) X(rows) X(cells) X(line) X(headerS)       \
  X(headerE) X(key) X(word) X(value) X(vs) X(ve) X(level) X(style) X(feature) X(geom) X(sel) X(block) X(ref)  \
  X(a) X(b) X(axis) X(layer) X(clearance) X(size) X(which) X(at) X(rotate) X(onBody) X(none) X(props)         \
  X(target) X(point) X(between) X(proto) X(on) X(clauses) X(dist) X(dir) X(kind) X(alias) X(anchor) X(quoted) \
  X(tht) X(shape) X(drill) X(r) X(flat) X(d) X(pts) X(slot) X(prop) X(angle) X(sign) X(nx) X(ny) X(coverage)  \
  X(gutter) X(pitch) X(op) X(form) X(dims) X(span) X(names) X(qual) X(sides) X(count) X(arrangement) X(side) \
  X(numbering) X(start) X(v) X(id) X(positions) X(nc) X(range) X(cols) X(pct) X(deg) X(w) X(l) X(h) X(cyl)   \
  X(offset) X(c) X(from) X(to) X(width) X(fill) X(clear) X(field) X(str) X(members) X(going) X(rings)         \
  X(path) X(arc) X(pt) X(segments) X(color) X(call) X(file) X(xform) X(scale) X(solidKind) X(open) X(down)    \
  X(castellated) X(d2) X(t) X(fillet) X(step) X(interp) X(fmt) X(ast) X(diags) X(severity) X(message)       \
  X(syntax) X(lit) X(tags) X(meta)

#define STOMP_KEY_DECL(n) extern const Key K_##n;
STOMP_KEYS(STOMP_KEY_DECL)
#undef STOMP_KEY_DECL

struct Undef {};
class Obj;
class Arr;
using ObjP = std::shared_ptr<Obj>;
using ArrP = std::shared_ptr<Arr>;

class Val {
 public:
  std::variant<Undef, std::nullptr_t, bool, double, std::u16string, ObjP, ArrP> v;

  Val() : v(Undef{}) {}
  Val(Undef) : v(Undef{}) {}
  Val(std::nullptr_t) : v(nullptr) {}
  Val(bool b) : v(b) {}
  Val(double n) : v(n) {}
  Val(int n) : v(static_cast<double>(n)) {}
  Val(long n) : v(static_cast<double>(n)) {}
  Val(long long n) : v(static_cast<double>(n)) {}
  Val(unsigned n) : v(static_cast<double>(n)) {}
  Val(unsigned long n) : v(static_cast<double>(n)) {}
  Val(unsigned long long n) : v(static_cast<double>(n)) {}
  Val(std::u16string s) : v(std::move(s)) {}
  Val(std::u16string_view s) : v(std::u16string(s)) {}
  Val(const char16_t* s) : v(std::u16string(s)) {}
  Val(ObjP o) : v(o ? Val::V(std::move(o)) : Val::V(nullptr)) {}
  Val(ArrP a) : v(a ? Val::V(std::move(a)) : Val::V(nullptr)) {}

  bool undef() const { return std::holds_alternative<Undef>(v); }
  bool null() const { return std::holds_alternative<std::nullptr_t>(v); }
  bool nullish() const { return undef() || null(); }   // == null in JavaScript
  bool is_bool() const { return std::holds_alternative<bool>(v); }
  bool is_num() const { return std::holds_alternative<double>(v); }
  bool is_str() const { return std::holds_alternative<std::u16string>(v); }
  bool is_obj() const { return std::holds_alternative<ObjP>(v); }
  bool is_arr() const { return std::holds_alternative<ArrP>(v); }

  bool boolean() const { return std::get<bool>(v); }
  double num() const { return std::get<double>(v); }
  const std::u16string& str() const { return std::get<std::u16string>(v); }
  const ObjP& obj() const { return std::get<ObjP>(v); }
  const ArrP& arr() const { return std::get<ArrP>(v); }

  /** JavaScript truthiness. */
  bool truthy() const;

 private:
  using V = decltype(v);
};

class Obj {
 public:
  std::vector<std::pair<Key, Val>> f;
  bool ast = false;   // part of a parsed file (mark_ast): the browser gets {type, s, e} of it

  const Val* find(Key k) const {
    for (const auto& p : f)
      if (p.first == k) return &p.second;
    return nullptr;
  }
  Val* find(Key k) {
    for (auto& p : f)
      if (p.first == k) return &p.second;
    return nullptr;
  }
  /** The field's value, or undefined. */
  const Val& get(Key k) const;
  bool has(Key k) const { return find(k) != nullptr; }
  /** Set a field, keeping its place if it exists (as a JavaScript object does). */
  Val& set(Key k, Val v) {
    if (Val* p = find(k)) return *p = std::move(v);
    f.emplace_back(k, std::move(v));
    return f.back().second;
  }
  bool erase(Key k);
};

class Arr {
 public:
  std::vector<Val> a;
  Arr() = default;
  explicit Arr(std::vector<Val> v) : a(std::move(v)) {}
};

using Field = std::pair<Key, Val>;
inline ObjP rec(std::initializer_list<Field> fields) {
  auto o = std::make_shared<Obj>();
  o->f.assign(fields.begin(), fields.end());
  return o;
}
inline ArrP list(std::vector<Val> items = {}) { return std::make_shared<Arr>(std::move(items)); }

/** Mark every object reachable from root as part of a parsed file. */
void mark_ast(const Val& root);

/** Which objects to print as {type, s, e} only (AST nodes inside results); may be null. */
using Summarize = std::function<bool(const Obj&)>;

/** The comparison harness's canonical text (tests/compare/canon.cjs). */
void canon(const Val& v, std::string& out, const Summarize* summarize = nullptr);
std::string canon(const Val& v, const Summarize* summarize = nullptr);

/** JSON for the browser: -0 kept, Infinity as 1e999, NaN as null, undefined fields left out. */
void write_json(const Val& v, std::string& out, const Summarize* summarize = nullptr);

}  // namespace stomp

#endif  // STOMP_VALUE_HPP
