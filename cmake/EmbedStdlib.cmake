# Writes OUT, a C++ file holding the standard library's .stomp files from DIR, in the
# order stdlib/ORDER gives (the order the JavaScript build uses too). Each file is a
# byte array, which keeps clear of string-literal limits and escaping.
#   cmake -DORDER=stdlib/ORDER -DDIR=stdlib -DOUT=stdlib_data.cpp -P EmbedStdlib.cmake
file(STRINGS ${ORDER} names REGEX "^[^#].*")
set(arrays "")
set(table "")
set(i 0)
foreach(name IN LISTS names)
  file(READ ${DIR}/${name} hex HEX)
  string(LENGTH "${hex}" n)
  math(EXPR size "${n} / 2")
  string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
  string(REGEX REPLACE "((0x[0-9a-f][0-9a-f],){24})" "\\1\n  " bytes "${bytes}")
  string(APPEND arrays "const unsigned char file${i}[] = {\n  ${bytes}\n};\n")
  string(APPEND table "  {\"${name}\", file${i}, ${size}},\n")
  math(EXPR i "${i} + 1")
endforeach()
file(WRITE ${OUT}.tmp "// Generated from stdlib/*.stomp by cmake/EmbedStdlib.cmake. Don't edit.
#include <cstddef>

namespace stomp::detail {

struct EmbeddedFile {
  const char* name;
  const unsigned char* data;
  std::size_t size;
};

namespace {
${arrays}}  // namespace

extern const EmbeddedFile kStdlibFiles[] = {
${table}};
extern const std::size_t kStdlibCount = ${i};

}  // namespace stomp::detail
")
# Only touch OUT when it changes, so the library isn't rebuilt for nothing
file(COPY_FILE ${OUT}.tmp ${OUT} ONLY_IF_DIFFERENT)
file(REMOVE ${OUT}.tmp)
