// The encodings KiCad's files need: its MurmurHash3 checksum, zstd frames and base64.
#ifndef STOMP_ENCODE_HPP
#define STOMP_ENCODE_HPP

#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace stomp::encode {

/**
 * KiCad's embedded-file checksum (libs/kimath/include/mmh3_hash.h): MurmurHash3_x64_128,
 * except that the tail is zero-padded to a multiple of 4 and the padding counts in the
 * length. 32 uppercase hex digits.
 */
std::string kicad_checksum(std::span<const std::uint8_t> bytes, std::uint32_t seed = 0xABBA2345u);

/** Plain MurmurHash3_x64_128, its 16 bytes (h1 then h2, little-endian). */
std::array<std::uint8_t, 16> murmur3x64(std::span<const std::uint8_t> bytes, std::uint32_t seed);

/** A zstd frame of raw blocks (at most 128 KiB each), declaring its content size. */
std::vector<std::uint8_t> zstd_frame(std::span<const std::uint8_t> bytes);

/** Standard base64 with padding. */
std::string base64(std::span<const std::uint8_t> bytes);

}  // namespace stomp::encode

#endif  // STOMP_ENCODE_HPP
