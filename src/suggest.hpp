// "Did you mean ...?": the nearest candidate by edit distance (parser.js suggest).
#ifndef STOMP_SUGGEST_HPP
#define STOMP_SUGGEST_HPP

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace stomp {

/** Edit distance over UTF-16 units. */
std::size_t levenshtein(std::u16string_view a, std::u16string_view b);

/**
 * The candidate nearest to word, ignoring case, if it is within a third of word's
 * length (at least 1). The first of equally near candidates wins.
 */
std::optional<std::u16string> suggest(std::u16string_view word, const std::vector<std::u16string>& candidates);

}  // namespace stomp

#endif  // STOMP_SUGGEST_HPP
