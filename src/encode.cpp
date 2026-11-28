#include "encode.hpp"

#include <algorithm>
#include <cstring>

namespace stomp::encode {

namespace {

constexpr std::uint64_t C1 = 0x87c37b91114253d5ULL, C2 = 0x4cf5ad432745937fULL;

inline std::uint64_t rotl(std::uint64_t x, int r) { return (x << r) | (x >> (64 - r)); }
inline std::uint64_t fmix(std::uint64_t k) {
  k ^= k >> 33;
  k *= 0xff51afd7ed558ccdULL;
  k ^= k >> 33;
  k *= 0xc4ceb9fe1a85ec53ULL;
  return k ^ (k >> 33);
}
inline std::uint64_t load64(const std::uint8_t* p) {
  std::uint64_t v = 0;
  for (int b = 7; b >= 0; --b) v = (v << 8) | p[b];
  return v;
}

struct H {
  std::uint64_t h1, h2;
  void block(const std::uint8_t* p) {
    std::uint64_t k1 = load64(p), k2 = load64(p + 8);
    k1 *= C1; k1 = rotl(k1, 31); k1 *= C2; h1 ^= k1;
    h1 = rotl(h1, 27); h1 += h2; h1 = h1 * 5 + 0x52dce729;
    k2 *= C2; k2 = rotl(k2, 33); k2 *= C1; h2 ^= k2;
    h2 = rotl(h2, 31); h2 += h1; h2 = h2 * 5 + 0x38495ab5;
  }
  // t bytes of tail (t < 16)
  void tail(const std::uint8_t* p, std::size_t t) {
    if (t > 8) {
      std::uint64_t k2 = 0;
      for (std::size_t j = t; j-- > 8;) k2 ^= static_cast<std::uint64_t>(p[j]) << ((j - 8) * 8);
      k2 *= C2; k2 = rotl(k2, 33); k2 *= C1; h2 ^= k2;
    }
    if (t > 0) {
      std::uint64_t k1 = 0;
      for (std::size_t j = std::min<std::size_t>(t, 8); j-- > 0;) k1 ^= static_cast<std::uint64_t>(p[j]) << (j * 8);
      k1 *= C1; k1 = rotl(k1, 31); k1 *= C2; h1 ^= k1;
    }
  }
  void finish(std::uint64_t len) {
    h1 ^= len; h2 ^= len;
    h1 += h2; h2 += h1;
    h1 = fmix(h1); h2 = fmix(h2);
    h1 += h2; h2 += h1;
  }
};

}  // namespace

std::string kicad_checksum(std::span<const std::uint8_t> bytes, std::uint32_t seed) {
  H h{seed, seed};
  const std::size_t n = bytes.size();
  std::uint32_t len = 0;
  std::size_t i = 0;
  for (; n - i >= 16; i += 16) {
    h.block(bytes.data() + i);
    len += 16;
  }
  std::uint8_t tail[16] = {};
  const std::size_t rem = n - i;
  if (rem > 0) {
    std::memcpy(tail, bytes.data() + i, rem);
    len += static_cast<std::uint32_t>(rem + (4 - ((rem + 4) % 4)));   // KiCad counts the padding
  }
  h.tail(tail, len & 15);
  h.finish(len);
  static const char* hex = "0123456789ABCDEF";
  std::string out(32, '0');
  for (int k = 0; k < 16; ++k) {
    out[static_cast<std::size_t>(k)] = hex[(h.h1 >> ((15 - k) * 4)) & 15];
    out[static_cast<std::size_t>(16 + k)] = hex[(h.h2 >> ((15 - k) * 4)) & 15];
  }
  return out;
}

std::array<std::uint8_t, 16> murmur3x64(std::span<const std::uint8_t> bytes, std::uint32_t seed) {
  H h{seed, seed};
  const std::size_t n = bytes.size();
  std::size_t i = 0;
  for (; n - i >= 16; i += 16) h.block(bytes.data() + i);
  h.tail(bytes.data() + i, n - i);
  h.finish(n);
  std::array<std::uint8_t, 16> out{};
  for (int b = 0; b < 8; ++b) {
    out[static_cast<std::size_t>(b)] = static_cast<std::uint8_t>(h.h1 >> (8 * b));
    out[static_cast<std::size_t>(8 + b)] = static_cast<std::uint8_t>(h.h2 >> (8 * b));
  }
  return out;
}

std::vector<std::uint8_t> zstd_frame(std::span<const std::uint8_t> bytes) {
  const std::size_t n = bytes.size();
  constexpr std::size_t BLOCK = 128 * 1024;
  const std::size_t blocks = std::max<std::size_t>(1, (n + BLOCK - 1) / BLOCK);
  std::vector<std::uint8_t> out;
  out.reserve(13 + blocks * 3 + n);
  for (std::uint32_t m = 0xFD2FB528u, k = 0; k < 4; ++k) out.push_back(static_cast<std::uint8_t>(m >> (8 * k)));   // magic
  out.push_back(0b11100000);   // an 8-byte content size, single segment, no checksum or dictionary
  for (int k = 0; k < 8; ++k) out.push_back(static_cast<std::uint8_t>(static_cast<std::uint64_t>(n) >> (8 * k)));
  for (std::size_t b = 0; b < blocks; ++b) {
    const std::size_t s = b * BLOCK, size = std::min(BLOCK, n - s);
    const std::uint32_t h = (b == blocks - 1 ? 1u : 0u) | static_cast<std::uint32_t>(size << 3);   // a raw block
    out.push_back(static_cast<std::uint8_t>(h));
    out.push_back(static_cast<std::uint8_t>(h >> 8));
    out.push_back(static_cast<std::uint8_t>(h >> 16));
    out.insert(out.end(), bytes.begin() + static_cast<std::ptrdiff_t>(s), bytes.begin() + static_cast<std::ptrdiff_t>(s + size));
  }
  return out;
}

std::string base64(std::span<const std::uint8_t> bytes) {
  static const char* B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  s.reserve((bytes.size() + 2) / 3 * 4);
  std::size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const std::uint32_t v = (static_cast<std::uint32_t>(bytes[i]) << 16) | (static_cast<std::uint32_t>(bytes[i + 1]) << 8) | bytes[i + 2];
    s += B[v >> 18]; s += B[(v >> 12) & 63]; s += B[(v >> 6) & 63]; s += B[v & 63];
  }
  const std::size_t r = bytes.size() - i;
  if (r == 1) {
    const std::uint32_t v = static_cast<std::uint32_t>(bytes[i]) << 16;
    s += B[v >> 18]; s += B[(v >> 12) & 63]; s += "==";
  } else if (r == 2) {
    const std::uint32_t v = (static_cast<std::uint32_t>(bytes[i]) << 16) | (static_cast<std::uint32_t>(bytes[i + 1]) << 8);
    s += B[v >> 18]; s += B[(v >> 12) & 63]; s += B[(v >> 6) & 63]; s += '=';
  }
  return s;
}

}  // namespace stomp::encode
