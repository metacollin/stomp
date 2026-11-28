#include "json.hpp"

#include <stomp/stomp.hpp>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>

#include "jsrt.hpp"

namespace stomp::json {

const Value* Value::get(std::u16string_view key) const {
  if (!is_object()) return nullptr;
  for (const auto& [k, val] : object())
    if (k == key) return &val;
  return nullptr;
}

Value& Value::set(std::u16string_view key, Value value) {
  auto& o = object();
  for (auto& [k, val] : o)
    if (k == key) { val = std::move(value); return val; }
  o.emplace_back(std::u16string(key), std::move(value));
  return o.back().second;
}

Value& Value::push(Value value) {
  auto& a = array();
  a.push_back(std::move(value));
  return a.back();
}

// Reading

namespace {

struct Reader {
  std::string_view t;
  std::size_t i = 0;

  [[noreturn]] void fail(const char* what) const { throw ParseError(std::string("JSON: ") + what + " at " + std::to_string(i), i); }
  void ws() {
    while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) ++i;
  }
  bool eat(char c) {
    ws();
    if (i < t.size() && t[i] == c) { ++i; return true; }
    return false;
  }
  void expect(char c) {
    if (!eat(c)) fail("unexpected character");
  }
  bool word(std::string_view w) {
    if (t.substr(i, w.size()) == w) { i += w.size(); return true; }
    return false;
  }
  unsigned hex4() {
    if (i + 4 > t.size()) fail("bad \\u escape");
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = t[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
      else fail("bad \\u escape");
    }
    return v;
  }
  std::u16string string() {
    // runs of plain bytes go through from_utf8; escapes add UTF-16 units directly
    std::u16string out;
    ++i;   // the opening quote
    std::size_t run = i;
    auto flush = [&] { if (i > run) out += from_utf8(t.substr(run, i - run)); };
    while (true) {
      if (i >= t.size()) fail("unterminated string");
      const char c = t[i];
      if (c == '"') { flush(); ++i; return out; }
      if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
      if (c != '\\') { ++i; continue; }
      flush();
      ++i;
      if (i >= t.size()) fail("unterminated string");
      const char e = t[i++];
      switch (e) {
        case '"': out.push_back(u'"'); break;
        case '\\': out.push_back(u'\\'); break;
        case '/': out.push_back(u'/'); break;
        case 'b': out.push_back(u'\b'); break;
        case 'f': out.push_back(u'\f'); break;
        case 'n': out.push_back(u'\n'); break;
        case 'r': out.push_back(u'\r'); break;
        case 't': out.push_back(u'\t'); break;
        case 'u': out.push_back(static_cast<char16_t>(hex4())); break;
        default: fail("bad escape");
      }
      run = i;
    }
  }
  double number() {
    const std::size_t start = i;
    if (i < t.size() && t[i] == '-') ++i;
    while (i < t.size() && ((t[i] >= '0' && t[i] <= '9') || t[i] == '.' || t[i] == 'e' || t[i] == 'E' || t[i] == '+' || t[i] == '-')) ++i;
    double v = 0;
    const auto r = std::from_chars(t.data() + start, t.data() + i, v);
    if (r.ec == std::errc::result_out_of_range) return std::strtod(std::string(t.substr(start, i - start)).c_str(), nullptr);
    if (r.ec != std::errc() || r.ptr != t.data() + i) fail("bad number");
    return v;
  }
  Value value(int depth) {
    if (depth > 512) fail("nested too deeply");
    ws();
    if (i >= t.size()) fail("unexpected end");
    const char c = t[i];
    if (c == '{') {
      ++i;
      Value o = json::object();
      if (eat('}')) return o;
      do {
        ws();
        if (i >= t.size() || t[i] != '"') fail("expected a key");
        std::u16string k = string();
        expect(':');
        o.object().emplace_back(std::move(k), value(depth + 1));
      } while (eat(','));
      expect('}');
      return o;
    }
    if (c == '[') {
      ++i;
      Value a = json::array();
      if (eat(']')) return a;
      do a.array().push_back(value(depth + 1));
      while (eat(','));
      expect(']');
      return a;
    }
    if (c == '"') return Value(string());
    if (word("true")) return Value(true);
    if (word("false")) return Value(false);
    if (word("null")) return Value(nullptr);
    if (c == '-' || (c >= '0' && c <= '9')) return Value(number());
    fail("unexpected character");
  }
};

}  // namespace

Value parse(std::string_view text) {
  Reader r{text};
  Value v = r.value(0);
  r.ws();
  if (r.i != text.size()) r.fail("trailing characters");
  return v;
}

// Writing

void quote(std::u16string_view s, std::string& out) {
  static const char* hex = "0123456789abcdef";
  out.push_back('"');
  std::size_t run = 0;
  auto flush = [&](std::size_t end) { if (end > run) out += to_utf8(s.substr(run, end - run)); };
  for (std::size_t i = 0; i < s.size(); ++i) {
    const char16_t c = s[i];
    const char* esc = nullptr;
    switch (c) {
      case u'"': esc = "\\\""; break;
      case u'\\': esc = "\\\\"; break;
      case u'\b': esc = "\\b"; break;
      case u'\f': esc = "\\f"; break;
      case u'\n': esc = "\\n"; break;
      case u'\r': esc = "\\r"; break;
      case u'\t': esc = "\\t"; break;
      default: break;
    }
    bool lone = false;
    if (c >= 0xD800 && c <= 0xDBFF) lone = !(i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF);
    else if (c >= 0xDC00 && c <= 0xDFFF) lone = !(i > 0 && s[i - 1] >= 0xD800 && s[i - 1] <= 0xDBFF);
    if (esc || c < 0x20 || lone) {
      flush(i);
      if (esc) out += esc;
      else {
        out += "\\u";
        for (int sh = 12; sh >= 0; sh -= 4) out.push_back(hex[(c >> sh) & 15]);
      }
      run = i + 1;
    }
  }
  flush(s.size());
  out.push_back('"');
}

namespace {

void number_json(double n, std::string& out) {
  if (std::isnan(n)) { out += "null"; return; }
  if (std::isinf(n)) { out += n < 0 ? "-1e999" : "1e999"; return; }
  if (n == 0 && std::signbit(n)) { out += "-0"; return; }
  out += js::to_string(n);
}

void number_canon(double n, std::string& out) {
  if (n == 0 && std::signbit(n)) { out += "-0"; return; }
  out += js::to_string(n);
}

}  // namespace

void write(const Value& v, std::string& out) {
  std::visit([&](const auto& x) {
    using T = std::decay_t<decltype(x)>;
    if constexpr (std::is_same_v<T, Undefined> || std::is_same_v<T, std::nullptr_t>) out += "null";
    else if constexpr (std::is_same_v<T, bool>) out += x ? "true" : "false";
    else if constexpr (std::is_same_v<T, double>) number_json(x, out);
    else if constexpr (std::is_same_v<T, std::u16string>) quote(x, out);
    else if constexpr (std::is_same_v<T, Array>) {
      out.push_back('[');
      for (std::size_t k = 0; k < x.size(); ++k) {
        if (k) out.push_back(',');
        write(x[k], out);
      }
      out.push_back(']');
    } else if constexpr (std::is_same_v<T, Object>) {
      out.push_back('{');
      bool first = true;
      for (const auto& [key, val] : x) {
        if (val.is_undefined()) continue;
        if (!first) out.push_back(',');
        first = false;
        quote(key, out);
        out.push_back(':');
        write(val, out);
      }
      out.push_back('}');
    } else {   // Typed
      out.push_back('[');
      for (std::size_t k = 0; k < x.values.size(); ++k) {
        if (k) out.push_back(',');
        number_json(x.values[k], out);
      }
      out.push_back(']');
    }
  }, v.v);
}

std::string write(const Value& v) {
  std::string out;
  write(v, out);
  return out;
}

namespace {

void canon_to(const Value& v, std::string& out) {
  std::visit([&](const auto& x) {
    using T = std::decay_t<decltype(x)>;
    if constexpr (std::is_same_v<T, Undefined>) out += "undefined";
    else if constexpr (std::is_same_v<T, std::nullptr_t>) out += "null";
    else if constexpr (std::is_same_v<T, bool>) out += x ? "true" : "false";
    else if constexpr (std::is_same_v<T, double>) number_canon(x, out);
    else if constexpr (std::is_same_v<T, std::u16string>) quote(x, out);
    else if constexpr (std::is_same_v<T, Array>) {
      out.push_back('[');
      for (std::size_t k = 0; k < x.size(); ++k) {
        if (k) out.push_back(',');
        canon_to(x[k], out);
      }
      out.push_back(']');
    } else if constexpr (std::is_same_v<T, Object>) {
      // keys sorted as JavaScript sorts strings: by UTF-16 code units
      std::vector<const std::pair<std::u16string, Value>*> keys;
      for (const auto& m : x)
        if (!m.second.is_undefined()) keys.push_back(&m);
      std::sort(keys.begin(), keys.end(), [](auto* a, auto* b) { return a->first < b->first; });
      out.push_back('{');
      for (std::size_t k = 0; k < keys.size(); ++k) {
        if (k) out.push_back(',');
        quote(keys[k]->first, out);
        out.push_back(':');
        canon_to(keys[k]->second, out);
      }
      out.push_back('}');
    } else {   // Typed
      out += x.name;
      out.push_back('[');
      for (std::size_t k = 0; k < x.values.size(); ++k) {
        if (k) out.push_back(',');
        number_canon(x.values[k], out);
      }
      out.push_back(']');
    }
  }, v.v);
}

}  // namespace

std::string canon(const Value& v) {
  std::string out;
  canon_to(v, out);
  return out;
}

}  // namespace stomp::json
