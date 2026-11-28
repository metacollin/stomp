// A small test runner: TEST(name) { CHECK(...); CHECK_EQ(a, b); }
#ifndef STOMP_TESTS_CHECK_HPP
#define STOMP_TESTS_CHECK_HPP

#include <sstream>
#include <string>
#include <vector>

namespace check {

struct Case {
  const char* name;
  void (*fn)();
};
std::vector<Case>& cases();
void fail(const char* file, int line, const std::string& what);

struct Register {
  Register(const char* name, void (*fn)()) { cases().push_back({name, fn}); }
};

template <typename T>
std::string show(const T& v) {
  if constexpr (requires(std::ostream& o) { o << v; }) {
    std::ostringstream o;
    o << v;
    return o.str();
  } else {
    return "?";
  }
}

}  // namespace check

#define TEST(name)                                             \
  static void test_##name();                                   \
  static const ::check::Register reg_##name(#name, test_##name); \
  static void test_##name()

#define CHECK(cond)                                         \
  do {                                                      \
    if (!(cond)) ::check::fail(__FILE__, __LINE__, #cond);  \
  } while (0)

#define CHECK_EQ(a, b)                                                                          \
  do {                                                                                          \
    const auto& a_ = (a);                                                                       \
    const auto& b_ = (b);                                                                       \
    if (!(a_ == b_))                                                                            \
      ::check::fail(__FILE__, __LINE__, std::string(#a " == " #b ": ") + ::check::show(a_) +   \
                                            " vs " + ::check::show(b_));                        \
  } while (0)

#endif  // STOMP_TESTS_CHECK_HPP
