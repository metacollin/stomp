// SHA-256 (FIPS 180-4), for the comparison harness's digests of exported files.
#ifndef STOMP_DEV_SHA256_HPP
#define STOMP_DEV_SHA256_HPP

#include <cstdint>
#include <span>
#include <string>

namespace stomp::dev {

/** The digest of bytes as 64 lowercase hex digits. */
std::string sha256_hex(std::span<const std::uint8_t> bytes);

}  // namespace stomp::dev

#endif  // STOMP_DEV_SHA256_HPP
