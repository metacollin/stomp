// UTF-8 <-> UTF-16, as browsers and Node do it: the WHATWG UTF-8 decoder (each maximal
// ill-formed subsequence becomes one U+FFFD) and an encoder that writes U+FFFD for an
// unpaired surrogate.
#include <stomp/stomp.hpp>

namespace stomp {

std::u16string from_utf8(std::string_view s) {
  std::u16string out;
  out.reserve(s.size());
  const auto* p = reinterpret_cast<const unsigned char*>(s.data());
  const std::size_t n = s.size();
  std::size_t i = 0;
  while (i < n) {
    const unsigned c = p[i];
    if (c < 0x80) { out.push_back(static_cast<char16_t>(c)); ++i; continue; }
    // the WHATWG decoder: how many continuation bytes, and the bounds on the first one
    unsigned need = 0, cp = 0, lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) { need = 1; cp = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { need = 2; cp = c & 0x0F; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { need = 3; cp = c & 0x07; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    else { out.push_back(u'�'); ++i; continue; }
    std::size_t j = i + 1;
    bool ok = true;
    for (unsigned k = 0; k < need; ++k, ++j) {
      if (j >= n || p[j] < lo || p[j] > hi) { ok = false; break; }
      cp = (cp << 6) | (p[j] & 0x3F);
      lo = 0x80; hi = 0xBF;
    }
    if (!ok) { out.push_back(u'�'); i = j; continue; }   // the bytes read so far are one error
    i = j;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
  }
  return out;
}

std::string to_utf8(std::u16string_view s) {
  std::string out;
  out.reserve(s.size());
  auto put = [&](unsigned cp) {
    if (cp < 0x80) out.push_back(static_cast<char>(cp));
    else if (cp < 0x800) { out.push_back(static_cast<char>(0xC0 | (cp >> 6))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  };
  for (std::size_t i = 0; i < s.size(); ++i) {
    const unsigned c = s[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
      put(0x10000 + ((c - 0xD800) << 10) + (s[i + 1] - 0xDC00u));
      ++i;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      put(0xFFFD);
    } else {
      put(c);
    }
  }
  return out;
}

}  // namespace stomp
