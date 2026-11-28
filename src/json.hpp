// JSON values: read from the tool's and the adapter's input, and written out two ways:
// as JSON for the browser (write), and in the comparison harness's canonical form
// (canon; tests/compare/canon.cjs is its JavaScript twin).
#ifndef STOMP_JSON_HPP
#define STOMP_JSON_HPP

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace stomp::json {

struct Value;
struct Undefined {};
using Array = std::vector<Value>;
using Object = std::vector<std::pair<std::u16string, Value>>;   // in insertion order, as JS objects
/** A typed array (Float32Array, Uint32Array, ...): its class name and its values. */
struct Typed {
  std::string name;
  std::vector<double> values;
};

struct Value {
  std::variant<Undefined, std::nullptr_t, bool, double, std::u16string, Array, Object, Typed> v;

  Value() : v(nullptr) {}
  Value(Undefined) : v(Undefined{}) {}
  Value(std::nullptr_t) : v(nullptr) {}
  Value(bool b) : v(b) {}
  Value(double n) : v(n) {}
  Value(int n) : v(static_cast<double>(n)) {}
  Value(long n) : v(static_cast<double>(n)) {}
  Value(long long n) : v(static_cast<double>(n)) {}
  Value(unsigned n) : v(static_cast<double>(n)) {}
  Value(unsigned long n) : v(static_cast<double>(n)) {}
  Value(unsigned long long n) : v(static_cast<double>(n)) {}
  Value(std::u16string s) : v(std::move(s)) {}
  Value(std::u16string_view s) : v(std::u16string(s)) {}
  Value(const char16_t* s) : v(std::u16string(s)) {}
  Value(Array a) : v(std::move(a)) {}
  Value(Object o) : v(std::move(o)) {}
  Value(Typed t) : v(std::move(t)) {}

  bool is_undefined() const { return std::holds_alternative<Undefined>(v); }
  bool is_null() const { return std::holds_alternative<std::nullptr_t>(v); }
  bool is_bool() const { return std::holds_alternative<bool>(v); }
  bool is_number() const { return std::holds_alternative<double>(v); }
  bool is_string() const { return std::holds_alternative<std::u16string>(v); }
  bool is_array() const { return std::holds_alternative<Array>(v); }
  bool is_object() const { return std::holds_alternative<Object>(v); }

  bool boolean() const { return std::get<bool>(v); }
  double number() const { return std::get<double>(v); }
  const std::u16string& string() const { return std::get<std::u16string>(v); }
  const Array& array() const { return std::get<Array>(v); }
  Array& array() { return std::get<Array>(v); }
  const Object& object() const { return std::get<Object>(v); }
  Object& object() { return std::get<Object>(v); }

  /** A member of an object, or nullptr. */
  const Value* get(std::u16string_view key) const;
  /** Add or replace a member (keeps its place, as a JS object does). */
  Value& set(std::u16string_view key, Value value);
  /** Append to an array. */
  Value& push(Value value);
};

inline Value object() { return Value(Object{}); }
inline Value array() { return Value(Array{}); }

struct ParseError : std::runtime_error {
  std::size_t at;
  ParseError(const std::string& what, std::size_t pos) : std::runtime_error(what), at(pos) {}
};

/** Parse JSON text (UTF-8). Strings become UTF-16. Throws ParseError. */
Value parse(std::string_view text);

/**
 * JSON as JSON.stringify writes it (UTF-8), except that numbers keep what JSON can't:
 * -0 is written as -0, Infinity as 1e999 and -Infinity as -1e999 (JSON.parse reads all
 * three back), and NaN as null. Undefined members are left out; undefined array
 * elements are null. Typed arrays are written as arrays.
 */
std::string write(const Value& v);
void write(const Value& v, std::string& out);

/** The canonical text form (tests/compare/canon.cjs). */
std::string canon(const Value& v);

/** A string as JSON.stringify quotes it, appended to out (UTF-8). */
void quote(std::u16string_view s, std::string& out);

}  // namespace stomp::json

#endif  // STOMP_JSON_HPP
