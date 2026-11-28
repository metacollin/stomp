#include "suggest.hpp"

#include <algorithm>

#include "jsrt.hpp"

namespace stomp {

std::size_t levenshtein(std::u16string_view a, std::u16string_view b) {
  const std::size_t m = a.size(), n = b.size();
  std::vector<std::size_t> prev(n + 1), cur(n + 1);
  for (std::size_t j = 0; j <= n; ++j) prev[j] = j;
  for (std::size_t i = 1; i <= m; ++i) {
    cur[0] = i;
    for (std::size_t j = 1; j <= n; ++j)
      cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)});
    std::swap(prev, cur);
  }
  return prev[n];
}

std::optional<std::u16string> suggest(std::u16string_view word, const std::vector<std::u16string>& candidates) {
  const std::u16string w = js::to_lower(word);
  const std::u16string* best = nullptr;
  std::size_t best_d = static_cast<std::size_t>(-1);
  for (const auto& c : candidates) {
    const std::size_t d = levenshtein(w, js::to_lower(c));
    if (d < best_d) { best_d = d; best = &c; }
  }
  const std::size_t limit = std::max<std::size_t>(1, word.size() / 3);
  if (best && best_d <= limit) return *best;
  return std::nullopt;
}

}  // namespace stomp
