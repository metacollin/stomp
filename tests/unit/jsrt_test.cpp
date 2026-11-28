// jsrt, json, the encoders and the suggester against what JavaScript gives
// (tests/unit/vectors/js.json, made by vectors/make.mjs).
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>

#include "check.hpp"
#include "encode.hpp"
#include "json.hpp"
#include "jsrt.hpp"
#include "suggest.hpp"

using namespace stomp;

namespace {

const json::Value& vectors() {
  static const json::Value v = [] {
    std::ifstream f(STOMP_TEST_VECTORS, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return json::parse(ss.str());
  }();
  return v;
}
const json::Array& list(const char16_t* key) { return vectors().get(key)->array(); }

double from_bits(const json::Value& v) {
  std::uint64_t b = 0;
  for (char16_t c : v.string()) b = (b << 4) | static_cast<std::uint64_t>(c <= u'9' ? c - u'0' : c - u'a' + 10);
  return std::bit_cast<double>(b);
}
bool same(double a, double b) { return std::bit_cast<std::uint64_t>(a) == std::bit_cast<std::uint64_t>(b) || (std::isnan(a) && std::isnan(b)); }
std::string s8(const json::Value& v) { return js::narrow(v.string()); }

// Count mismatches, show the first few
struct Tally {
  const char* what;
  int bad = 0;
  void miss(const std::string& detail) {
    if (++bad <= 5) std::fprintf(stderr, "  %s: %s\n", what, detail.c_str());
  }
  ~Tally() { if (bad) ::check::fail(__FILE__, __LINE__, std::string(what) + ": " + std::to_string(bad) + " mismatches"); }
};

std::vector<std::uint8_t> bytes_of(std::uint32_t seed, std::size_t n) {
  // the generator make.mjs uses, in doubles as JavaScript computes it (the product rounds)
  std::vector<std::uint8_t> b(n);
  double q = seed;
  for (std::size_t i = 0; i < n; ++i) {
    q = std::fmod(q * 1103515245.0 + 12345.0, 2147483648.0);
    b[i] = static_cast<std::uint8_t>(static_cast<std::uint32_t>(q) & 255);
  }
  return b;
}

}  // namespace

TEST(number_to_string) {
  Tally t{"String(x)"};
  for (const auto& r : list(u"to_string")) {
    const double x = from_bits(r.array()[0]);
    const std::string got = js::to_string(x), want = s8(r.array()[1]);
    if (got != want) t.miss(want + " vs " + got);
  }
}

TEST(to_fixed) {
  Tally t{"toFixed"};
  for (const auto& r : list(u"to_fixed")) {
    const auto& a = r.array();
    const double x = from_bits(a[0]);
    const int d = static_cast<int>(a[1].number());
    const std::string got = js::to_fixed(x, d), want = s8(a[2]);
    if (got != want) t.miss(js::to_string(x) + ".toFixed(" + std::to_string(d) + "): " + want + " vs " + got);
  }
}

TEST(round_hypot_min_max_sign) {
  Tally t{"Math"};
  for (const auto& r : list(u"round")) {
    const double x = from_bits(r.array()[0]), want = from_bits(r.array()[1]);
    if (!same(js::round(x), want)) t.miss("round(" + js::to_string(x) + ")");
  }
  for (const auto& r : list(u"hypot")) {
    const auto& a = r.array();
    const double x = from_bits(a[0]), y = from_bits(a[1]);
    if (!same(js::hypot({x, y}), from_bits(a[2]))) t.miss("hypot(" + js::to_string(x) + ", " + js::to_string(y) + ")");
  }
  for (const auto& r : list(u"min_max_sign")) {
    const auto& a = r.array();
    const double x = from_bits(a[0]), y = from_bits(a[1]);
    if (!same(js::min(x, y), from_bits(a[2])) || !same(js::max(x, y), from_bits(a[3])) || !same(js::sign(x), from_bits(a[4])))
      t.miss("min/max/sign of " + js::to_string(x) + ", " + js::to_string(y));
  }
  for (const auto& r : list(u"int32")) {
    const auto& a = r.array();
    const double x = from_bits(a[0]);
    if (js::to_int32(x) != static_cast<std::int32_t>(a[1].number()) || js::to_uint32(x) != static_cast<std::uint32_t>(a[2].number()))
      t.miss("x|0 or x>>>0 of " + js::to_string(x));
  }
}

TEST(parse_float) {
  Tally t{"parseFloat"};
  for (const auto& r : list(u"parse_float")) {
    const auto& a = r.array();
    if (!same(js::parse_float(a[0].string()), from_bits(a[1]))) t.miss(s8(a[0]));
  }
}

TEST(case_mapping_and_trim) {
  Tally t{"case/trim"};
  for (const auto& r : list(u"lower"))
    if (js::to_lower(r.array()[0].string()) != r.array()[1].string()) t.miss("toLowerCase " + s8(r.array()[0]));
  for (const auto& r : list(u"upper"))
    if (js::to_upper(r.array()[0].string()) != r.array()[1].string()) t.miss("toUpperCase " + s8(r.array()[0]));
  for (const auto& r : list(u"trim"))
    if (js::trim(r.array()[0].string()) != r.array()[1].string()) t.miss("trim " + s8(r.array()[0]));
}

TEST(encoders) {
  Tally t{"encoders"};
  for (const auto& r : list(u"encoders")) {
    const auto n = static_cast<std::size_t>(r.get(u"n")->number());
    const auto b = bytes_of(static_cast<std::uint32_t>(r.get(u"seed")->number()), n);
    const std::string tag = " (" + std::to_string(n) + " bytes)";
    if (encode::kicad_checksum(b) != s8(*r.get(u"checksum"))) t.miss("checksum" + tag);
    if (encode::kicad_checksum(b, 0) != s8(*r.get(u"checksum_seed0"))) t.miss("checksum seed 0" + tag);
    const auto m = encode::murmur3x64(b, 0x9747b28c);
    std::string mh;
    for (auto x : m) { char h[3]; std::snprintf(h, sizeof h, "%02x", x); mh += h; }
    if (mh != s8(*r.get(u"murmur"))) t.miss("murmur3x64" + tag);
    const auto z = encode::zstd_frame(b);
    if (z.size() != static_cast<std::size_t>(r.get(u"zstd_len")->number()) || encode::kicad_checksum(z) != s8(*r.get(u"zstd_checksum")))
      t.miss("zstd frame" + tag);
    if (!r.get(u"base64")->is_null() && encode::base64(b) != s8(*r.get(u"base64"))) t.miss("base64" + tag);
  }
}

TEST(murmur3_published_value) {
  // SMHasher's verification value for MurmurHash3_x64_128: hash keys {}, {0}, {0,1}, ...
  // with seeds 256 down to 1, then hash the 256 hashes with seed 0
  std::vector<std::uint8_t> key(256), hashes(256 * 16);
  for (std::size_t i = 0; i < 256; ++i) {
    key[i] = static_cast<std::uint8_t>(i);
    const auto h = encode::murmur3x64(std::span(key.data(), i), static_cast<std::uint32_t>(256 - i));
    std::copy(h.begin(), h.end(), hashes.begin() + static_cast<std::ptrdiff_t>(i * 16));
  }
  const auto fin = encode::murmur3x64(hashes, 0);
  const std::uint32_t v = fin[0] | (fin[1] << 8) | (fin[2] << 16) | (static_cast<std::uint32_t>(fin[3]) << 24);
  CHECK_EQ(v, 0x6384BA69u);
}

TEST(suggestions) {
  Tally t{"suggest"};
  for (const auto& r : list(u"levenshtein")) {
    const auto& a = r.array();
    if (levenshtein(a[0].string(), a[1].string()) != static_cast<std::size_t>(a[2].number())) t.miss("levenshtein " + s8(a[0]));
  }
  for (const auto& r : list(u"suggest")) {
    const auto& a = r.array();
    std::vector<std::u16string> c;
    for (const auto& x : a[1].array()) c.push_back(x.string());
    const auto got = suggest(a[0].string(), c);
    const bool ok = a[2].is_null() ? !got : (got && *got == a[2].string());
    if (!ok) t.miss("suggest " + s8(a[0]));
  }
}

TEST(json_round_trip) {
  const std::string text = R"({"a":[1,-0,1e999,-1e999,null,true,"q\"\\\n\u0001\ud800"],"b":{"z":1,"y":2}})";
  const json::Value v = json::parse(text);
  CHECK(std::signbit(v.get(u"a")->array()[1].number()));
  CHECK(std::isinf(v.get(u"a")->array()[2].number()));
  CHECK_EQ(json::write(v), std::string(R"({"a":[1,-0,1e999,-1e999,null,true,"q\"\\\n\u0001\ud800"],"b":{"z":1,"y":2}})"));
  CHECK_EQ(json::canon(v), std::string(R"({"a":[1,-0,Infinity,-Infinity,null,true,"q\"\\\n\u0001\ud800"],"b":{"y":2,"z":1}})"));
}
