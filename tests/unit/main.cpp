// Runs every TEST, or those whose names contain argv[1].
#include <cstdio>
#include <cstring>
#include <exception>

#include "check.hpp"

namespace check {
std::vector<Case>& cases() {
  static std::vector<Case> all;
  return all;
}
static int failures = 0;
static const char* current = "";
void fail(const char* file, int line, const std::string& what) {
  ++failures;
  std::fprintf(stderr, "FAIL %s (%s:%d): %s\n", current, file, line, what.c_str());
}
}  // namespace check

int main(int argc, char** argv) {
  const char* only = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (const auto& c : check::cases()) {
    if (only && !std::strstr(c.name, only)) continue;
    check::current = c.name;
    ++ran;
    try {
      c.fn();
    } catch (const std::exception& e) {
      check::fail(__FILE__, __LINE__, std::string("threw: ") + e.what());
    }
  }
  std::printf("%d tests, %d failures\n", ran, check::failures);
  return check::failures ? 1 : 0;
}
