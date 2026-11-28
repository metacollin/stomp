#include <stomp/stomp.hpp>

#include "check.hpp"

TEST(utf8_round_trip) {
  const std::string s = "pad \"µΩ°\" 1.27 — 𝄞";
  const std::u16string u = stomp::from_utf8(s);
  CHECK_EQ(u.size(), std::size_t(19));      // 𝄞 is two UTF-16 units
  CHECK(u[17] == 0xD834 && u[18] == 0xDD1E);
  CHECK_EQ(stomp::to_utf8(u), s);
}

TEST(utf8_invalid_bytes_become_replacement_characters) {
  // a lone continuation byte, a truncated sequence, an overlong form, a surrogate
  CHECK(stomp::from_utf8("a\x80" "b") == u"a�b");
  CHECK(stomp::from_utf8("a\xE2\x82") == u"a�");
  CHECK(stomp::from_utf8("\xC0\xAF") == u"��");
  CHECK(stomp::from_utf8("\xED\xA0\x80") == u"���");
  // the byte that ended a bad sequence starts the next character
  CHECK(stomp::from_utf8("\xE2" "A") == u"�A");
}

TEST(lone_surrogates_are_written_as_replacement_characters) {
  const std::u16string u = {u'a', char16_t(0xD800), u'b'};
  CHECK_EQ(stomp::to_utf8(u), std::string("a\xEF\xBF\xBD" "b"));
}

TEST(builtin_library_is_in_order) {
  const auto& lib = stomp::builtin_library();
  CHECK_EQ(lib.size(), std::size_t(14));
  CHECK_EQ(lib.front().name, std::string("colors.stomp"));
  CHECK_EQ(lib.back().name, std::string("silk.stomp"));
  for (const auto& f : lib) CHECK(!f.source.empty());
}
