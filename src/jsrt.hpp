// JavaScript's semantics where stomp's output depends on them. The engine was written in
// JavaScript first; these keep the C++ engine's numbers and text identical to it.
// Each function says which JavaScript operation it is.
#ifndef STOMP_JSRT_HPP
#define STOMP_JSRT_HPP

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>

namespace stomp::js {

// Numbers
std::string to_string(double x);                 // String(x): "0.1", "1e+21", "-Infinity", "NaN"; -0 is "0"
std::u16string to_u16string(double x);           // the same, as UTF-16
std::string to_fixed(double x, int digits);      // x.toFixed(digits), ties away from zero
double parse_float(std::u16string_view s);        // parseFloat(s) for a decimal literal; NaN if none
double round(double x);                          // Math.round: halves up, -0 kept
double hypot(const double* v, std::size_t n);    // Math.hypot, V8's algorithm
inline double hypot(std::initializer_list<double> v) { return hypot(v.begin(), v.size()); }
double min(double a, double b);                  // Math.min(a, b): NaN wins, -0 < 0
double max(double a, double b);                  // Math.max(a, b)
double sign(double x);                           // Math.sign
inline bool truthy(double x) { return x == x && x != 0; }   // `x || ...` on a number
std::int32_t to_int32(double x);                 // x | 0
std::uint32_t to_uint32(double x);               // x >>> 0

// Trigonometry: V8's fdlibm (third_party/v8-ieee754)
double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan2(double y, double x);

// Strings (UTF-16)
bool is_space(char16_t c);                       // /\s/ and String.prototype.trim's set
std::u16string trim(std::u16string_view s);      // s.trim()
std::u16string to_lower(std::u16string_view s);  // s.toLowerCase(), with Unicode's final-sigma rule
std::u16string to_upper(std::u16string_view s);  // s.toUpperCase()

// Shorthands
std::u16string u16(std::string_view ascii);      // an ASCII literal as UTF-16
std::string narrow(std::u16string_view s);       // UTF-16 to UTF-8

}  // namespace stomp::js

#endif  // STOMP_JSRT_HPP
