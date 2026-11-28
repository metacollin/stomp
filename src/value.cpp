#include "value.hpp"

#include <stomp/stomp.hpp>

#include <algorithm>
#include <cmath>
#include <unordered_map>

#include "json.hpp"
#include "jsrt.hpp"

namespace stomp {

namespace {
struct Interned {
  std::vector<std::u16string> names;
  std::unordered_map<std::u16string, std::uint32_t> ids;
};
Interned& interned() {
  static Interned t;
  return t;
}
}  // namespace

Key key(std::u16string_view name) {
  auto& t = interned();
  const std::u16string n(name);
  const auto it = t.ids.find(n);
  if (it != t.ids.end()) return Key{it->second};
  const auto id = static_cast<std::uint32_t>(t.names.size());
  t.names.push_back(n);
  t.ids.emplace(n, id);
  return Key{id};
}

const std::u16string& key_name(Key k) { return interned().names.at(k.id); }

#define STOMP_KEY_DEF(n) const Key K_##n = key(u"" #n);
STOMP_KEYS(STOMP_KEY_DEF)
#undef STOMP_KEY_DEF

bool Val::truthy() const {
  return std::visit([](const auto& x) -> bool {
    using T = std::decay_t<decltype(x)>;
    if constexpr (std::is_same_v<T, Undef> || std::is_same_v<T, std::nullptr_t>) return false;
    else if constexpr (std::is_same_v<T, bool>) return x;
    else if constexpr (std::is_same_v<T, double>) return js::truthy(x);
    else if constexpr (std::is_same_v<T, std::u16string>) return !x.empty();
    else return true;
  }, v);
}

const Val& Obj::get(Key k) const {
  static const Val undef;
  const Val* p = find(k);
  return p ? *p : undef;
}

void mark_ast(const Val& root) {
  std::vector<const Val*> todo{&root};
  while (!todo.empty()) {
    const Val* v = todo.back();
    todo.pop_back();
    if (v->is_obj()) {
      Obj& o = *v->obj();
      if (o.ast) continue;
      o.ast = true;
      for (const auto& f : o.f) todo.push_back(&f.second);
    } else if (v->is_arr()) {
      for (const auto& x : v->arr()->a) todo.push_back(&x);
    }
  }
}

bool Obj::erase(Key k) {
  const auto it = std::find_if(f.begin(), f.end(), [&](const Field& p) { return p.first == k; });
  if (it == f.end()) return false;
  f.erase(it);
  return true;
}

// Writing

namespace {

void number_canon(double n, std::string& out) {
  if (n == 0 && std::signbit(n)) { out += "-0"; return; }
  out += js::to_string(n);
}

void number_json(double n, std::string& out) {
  if (std::isnan(n)) { out += "null"; return; }
  if (std::isinf(n)) { out += n < 0 ? "-1e999" : "1e999"; return; }
  if (n == 0 && std::signbit(n)) { out += "-0"; return; }
  out += js::to_string(n);
}

struct Canon {
  std::string& out;
  const Summarize* summarize;
  std::vector<const void*> stack;

  void put(const Val& v) {
    std::visit([&](const auto& x) {
      using T = std::decay_t<decltype(x)>;
      if constexpr (std::is_same_v<T, Undef>) out += "undefined";
      else if constexpr (std::is_same_v<T, std::nullptr_t>) out += "null";
      else if constexpr (std::is_same_v<T, bool>) out += x ? "true" : "false";
      else if constexpr (std::is_same_v<T, double>) number_canon(x, out);
      else if constexpr (std::is_same_v<T, std::u16string>) json::quote(x, out);
      else if constexpr (std::is_same_v<T, ArrP>) array(*x);
      else object(*x);
    }, v.v);
  }
  bool cycle(const void* p) {
    if (std::find(stack.begin(), stack.end(), p) == stack.end()) return false;
    out += "\"<cycle>\"";
    return true;
  }
  void array(const Arr& a) {
    if (cycle(&a)) return;
    stack.push_back(&a);
    out.push_back('[');
    for (std::size_t i = 0; i < a.a.size(); ++i) {
      if (i) out.push_back(',');
      put(a.a[i]);
    }
    out.push_back(']');
    stack.pop_back();
  }
  void object(const Obj& o) {
    if (cycle(&o)) return;
    if (summarize && *summarize && (*summarize)(o)) {
      // an AST node inside a result: {type, s, e}, whichever it has
      Obj short_;
      for (Key k : {K_type, K_s, K_e})
        if (const Val* v = o.find(k); v && !v->undef()) short_.set(k, *v);
      object_fields(short_);
      return;
    }
    stack.push_back(&o);
    object_fields(o);
    stack.pop_back();
  }
  void object_fields(const Obj& o) {
    std::vector<const Field*> keys;
    for (const auto& p : o.f)
      if (!p.second.undef()) keys.push_back(&p);
    std::sort(keys.begin(), keys.end(), [](const Field* a, const Field* b) { return key_name(a->first) < key_name(b->first); });
    out.push_back('{');
    for (std::size_t i = 0; i < keys.size(); ++i) {
      if (i) out.push_back(',');
      json::quote(key_name(keys[i]->first), out);
      out.push_back(':');
      put(keys[i]->second);
    }
    out.push_back('}');
  }
};

struct Json {
  std::string& out;
  const Summarize* summarize;

  void put(const Val& v) {
    std::visit([&](const auto& x) {
      using T = std::decay_t<decltype(x)>;
      if constexpr (std::is_same_v<T, Undef> || std::is_same_v<T, std::nullptr_t>) out += "null";
      else if constexpr (std::is_same_v<T, bool>) out += x ? "true" : "false";
      else if constexpr (std::is_same_v<T, double>) number_json(x, out);
      else if constexpr (std::is_same_v<T, std::u16string>) json::quote(x, out);
      else if constexpr (std::is_same_v<T, ArrP>) {
        out.push_back('[');
        for (std::size_t i = 0; i < x->a.size(); ++i) {
          if (i) out.push_back(',');
          put(x->a[i]);
        }
        out.push_back(']');
      } else {
        const bool sum = summarize && *summarize && (*summarize)(*x);
        out.push_back('{');
        bool first = true;
        for (const auto& [k, val] : x->f) {
          if (val.undef()) continue;
          if (sum && k != K_type && k != K_s && k != K_e) continue;
          if (!first) out.push_back(',');
          first = false;
          json::quote(key_name(k), out);
          out.push_back(':');
          put(val);
        }
        out.push_back('}');
      }
    }, v.v);
  }
};

}  // namespace

void canon(const Val& v, std::string& out, const Summarize* summarize) {
  Canon c{out, summarize, {}};
  c.put(v);
}

std::string canon(const Val& v, const Summarize* summarize) {
  std::string out;
  canon(v, out, summarize);
  return out;
}

void write_json(const Val& v, std::string& out, const Summarize* summarize) {
  Json j{out, summarize};
  j.put(v);
}

}  // namespace stomp
