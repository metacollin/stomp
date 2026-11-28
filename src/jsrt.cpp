// JavaScript's semantics, as stomp's output needs them (jsrt.hpp).
//
// Math.hypot and Math.round follow V8 (src/builtins/math.tq, CodeStubAssembler::Float64Round);
// Copyright the V8 project authors, BSD license (third_party/v8-ieee754/LICENSE.v8).
#include "jsrt.hpp"

#include <stomp/stomp.hpp>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <vector>

#include "ieee754.h"

namespace stomp::js {

// Numbers

std::string to_string(double x) {
  if (std::isnan(x)) return "NaN";
  if (x == 0) return "0";
  if (std::isinf(x)) return x < 0 ? "-Infinity" : "Infinity";
  std::string out = x < 0 ? "-" : "";
  // the shortest digits that round-trip, and where the point goes (ECMA-262 Number::toString)
  char buf[64];
  const auto r = std::to_chars(buf, buf + sizeof buf, std::fabs(x), std::chars_format::scientific);
  const std::string_view sci(buf, static_cast<std::size_t>(r.ptr - buf));   // d.ddde+XX
  const auto e = sci.find('e');
  std::string digits(1, sci[0]);
  if (e > 1) digits.append(sci.substr(2, e - 2));
  int exp10 = 0;
  std::from_chars(sci.data() + e + (sci[e + 1] == '+' ? 2 : 1), sci.data() + sci.size(), exp10);
  const int k = static_cast<int>(digits.size());
  const int n = exp10 + 1;
  if (k <= n && n <= 21) return out + digits + std::string(static_cast<std::size_t>(n - k), '0');
  if (0 < n && n <= 21) return out + digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n));
  if (-6 < n && n <= 0) return out + "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
  const int ex = n - 1;
  out += digits.substr(0, 1);
  if (k > 1) out += "." + digits.substr(1);
  out += ex >= 0 ? "e+" : "e-";
  out += std::to_string(ex >= 0 ? ex : -ex);
  return out;
}

std::u16string to_u16string(double x) { return u16(to_string(x)); }

std::string to_fixed(double x, int f) {
  if (std::isnan(x)) return "NaN";
  if (std::fabs(x) >= 1e21) return to_string(x);
  std::string sign;
  if (x < 0) sign = "-";
  x = std::fabs(x);   // -0 too: its digits have no sign
  // The exact decimal value (a double has at most 1074 digits after the point), then
  // round at f digits with ties going up: the spec's "pick the larger n".
  static thread_local std::vector<char> buf(1200);
  const auto r = std::to_chars(buf.data(), buf.data() + buf.size(), x, std::chars_format::fixed, 1100);
  const std::string_view exact(buf.data(), static_cast<std::size_t>(r.ptr - buf.data()));
  const auto dot = exact.find('.');
  std::string digits(exact.substr(0, dot));
  const std::string_view frac = exact.substr(dot + 1);
  digits.append(frac.substr(0, static_cast<std::size_t>(f)));
  if (frac[static_cast<std::size_t>(f)] >= '5') {
    int i = static_cast<int>(digits.size()) - 1;
    for (; i >= 0 && digits[static_cast<std::size_t>(i)] == '9'; --i) digits[static_cast<std::size_t>(i)] = '0';
    if (i < 0) digits.insert(digits.begin(), '1');
    else ++digits[static_cast<std::size_t>(i)];
  }
  if (f == 0) return sign + digits;
  const std::size_t ip = digits.size() - static_cast<std::size_t>(f);
  return sign + digits.substr(0, ip) + "." + digits.substr(ip);
}

double parse_float(std::u16string_view s) {
  std::string a;
  a.reserve(s.size());
  for (char16_t c : s) {
    if (c > 0x7F) break;
    a.push_back(static_cast<char>(c));
  }
  double v = 0;
  const auto r = std::from_chars(a.data(), a.data() + a.size(), v);
  if (r.ec == std::errc::invalid_argument) return std::numeric_limits<double>::quiet_NaN();
  if (r.ec == std::errc::result_out_of_range) {
    // overflow is Infinity and underflow 0, as in JavaScript; strtod knows which
    const std::string lit(a.data(), static_cast<std::size_t>(r.ptr - a.data()));
    return std::strtod(lit.c_str(), nullptr);
  }
  return v;
}

double round(double x) {
  const double r = std::ceil(x);
  return r - 0.5 <= x ? r : r - 1.0;
}

double hypot(std::initializer_list<double> v) {
  if (v.size() == 0) return 0;
  bool nan = false;
  double max = 0;
  for (double x : v) {
    if (std::isnan(x)) { nan = true; continue; }
    max = std::max(max, std::fabs(x));
  }
  if (max == std::numeric_limits<double>::infinity()) return max;
  if (nan) return std::numeric_limits<double>::quiet_NaN();
  if (max == 0) return 0;
  // Kahan summation of the squares, normalized by the largest
  double sum = 0, compensation = 0;
  for (double x : v) {
    const double n = std::fabs(x) / max;
    const double summand = n * n - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return std::sqrt(sum) * max;
}

double min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == 0 && b == 0) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}

double max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == 0 && b == 0) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

double sign(double x) {
  if (std::isnan(x) || x == 0) return x;
  return x > 0 ? 1.0 : -1.0;
}

std::uint32_t to_uint32(double x) {
  if (!std::isfinite(x)) return 0;
  double t = std::trunc(x);
  t = std::fmod(t, 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return static_cast<std::uint32_t>(t);
}

std::int32_t to_int32(double x) {
  const std::uint32_t u = to_uint32(x);
  return static_cast<std::int32_t>(u);   // two's complement, as C++20 defines it
}

double sin(double x) { return v8math::sin(x); }
double cos(double x) { return v8math::cos(x); }
double tan(double x) { return v8math::tan(x); }
double asin(double x) { return v8math::asin(x); }
double acos(double x) { return v8math::acos(x); }
double atan2(double y, double x) { return v8math::atan2(y, x); }

// Strings

bool is_space(char16_t c) {
  switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0:
    case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200A;
  }
}

std::u16string trim(std::u16string_view s) {
  std::size_t a = 0, b = s.size();
  while (a < b && is_space(s[a])) ++a;
  while (b > a && is_space(s[b - 1])) --b;
  return std::u16string(s.substr(a, b - a));
}

namespace {

struct CaseMap {
  char32_t cp;
  unsigned char len;
  char16_t out[3];
};
struct Range {
  char32_t lo, hi;
};
#include "unicase_data.inc"

template <std::size_t N>
const CaseMap* find_map(const CaseMap (&t)[N], char32_t cp) {
  const auto it = std::lower_bound(std::begin(t), std::end(t), cp, [](const CaseMap& m, char32_t c) { return m.cp < c; });
  return it != std::end(t) && it->cp == cp ? it : nullptr;
}

template <std::size_t N>
bool in_ranges(const Range (&t)[N], char32_t cp) {
  const auto it = std::upper_bound(std::begin(t), std::end(t), cp, [](char32_t c, const Range& r) { return c < r.lo; });
  return it != std::begin(t) && std::prev(it)->hi >= cp;
}

// Code points of a UTF-16 string, unpaired surrogates as themselves
char32_t at(std::u16string_view s, std::size_t i, std::size_t& next) {
  const char16_t c = s[i];
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
    next = i + 2;
    return 0x10000 + ((static_cast<char32_t>(c) - 0xD800) << 10) + (s[i + 1] - 0xDC00);
  }
  next = i + 1;
  return c;
}
char32_t before(std::u16string_view s, std::size_t i, std::size_t& prev) {   // the code point ending at i
  const char16_t c = s[i - 1];
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2 && s[i - 2] >= 0xD800 && s[i - 2] <= 0xDBFF) {
    prev = i - 2;
    return 0x10000 + ((static_cast<char32_t>(s[i - 2]) - 0xD800) << 10) + (c - 0xDC00);
  }
  prev = i - 1;
  return c;
}

// Unicode's Final_Sigma: a capital sigma lowercases to ς after a cased letter and not
// before one, ignoring case-ignorable characters in between.
bool final_sigma(std::u16string_view s, std::size_t start, std::size_t end) {
  bool cased_before = false;
  for (std::size_t i = start; i > 0;) {
    std::size_t p;
    const char32_t cp = before(s, i, p);
    i = p;
    if (in_ranges(kCaseIgnorable, cp)) continue;
    cased_before = in_ranges(kCased, cp);
    break;
  }
  if (!cased_before) return false;
  for (std::size_t i = end; i < s.size();) {
    std::size_t n;
    const char32_t cp = at(s, i, n);
    i = n;
    if (in_ranges(kCaseIgnorable, cp)) continue;
    return !in_ranges(kCased, cp);
  }
  return true;
}

template <std::size_t N>
std::u16string map_case(std::u16string_view s, const CaseMap (&t)[N], bool lower) {
  std::u16string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size();) {
    std::size_t n;
    const char32_t cp = at(s, i, n);
    if (cp < 0x80) {
      char16_t c = static_cast<char16_t>(cp);
      if (lower && c >= u'A' && c <= u'Z') c = static_cast<char16_t>(c + 32);
      if (!lower && c >= u'a' && c <= u'z') c = static_cast<char16_t>(c - 32);
      out.push_back(c);
    } else if (lower && cp == 0x3A3) {
      out.push_back(final_sigma(s, i, n) ? u'ς' : u'σ');
    } else if (const CaseMap* m = find_map(t, cp)) {
      out.append(m->out, m->len);
    } else {
      out.append(s.substr(i, n - i));
    }
    i = n;
  }
  return out;
}

}  // namespace

std::u16string to_lower(std::u16string_view s) { return map_case(s, kLower, true); }
std::u16string to_upper(std::u16string_view s) { return map_case(s, kUpper, false); }

std::u16string u16(std::string_view ascii) { return std::u16string(ascii.begin(), ascii.end()); }
std::string narrow(std::u16string_view s) { return stomp::to_utf8(s); }

}  // namespace stomp::js
