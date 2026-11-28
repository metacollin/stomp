// A map that iterates in insertion order, with JavaScript Map's semantics: setting an
// existing key keeps its place; deleting and setting again moves it to the end.
#ifndef STOMP_ORDERED_MAP_HPP
#define STOMP_ORDERED_MAP_HPP

#include <cstddef>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

namespace stomp {

template <typename K, typename V, typename Hash = std::hash<K>>
class OrderedMap {
 public:
  using Entry = std::pair<K, V>;

  bool has(const K& k) const { return index_.count(k) != 0; }
  std::size_t size() const { return index_.size(); }
  bool empty() const { return index_.empty(); }

  V* get(const K& k) {
    const auto it = index_.find(k);
    return it == index_.end() ? nullptr : &entries_[it->second]->second;
  }
  const V* get(const K& k) const {
    const auto it = index_.find(k);
    return it == index_.end() ? nullptr : &entries_[it->second]->second;
  }

  V& set(const K& k, V v) {
    const auto it = index_.find(k);
    if (it != index_.end()) return entries_[it->second]->second = std::move(v);
    index_.emplace(k, entries_.size());
    entries_.emplace_back(Entry(k, std::move(v)));
    return entries_.back()->second;
  }

  /** Move an entry to the end, as deleting and setting it again would (without copying it). */
  bool touch(const K& k) {
    const auto it = index_.find(k);
    if (it == index_.end()) return false;
    if (it->second + 1 == entries_.size()) return true;
    entries_.emplace_back(std::move(entries_[it->second]));
    entries_[it->second].reset();
    it->second = entries_.size() - 1;
    if (++holes_ > 32 && holes_ * 2 > entries_.size()) compact();
    return true;
  }

  bool erase(const K& k) {
    const auto it = index_.find(k);
    if (it == index_.end()) return false;
    entries_[it->second].reset();
    index_.erase(it);
    if (++holes_ > 32 && holes_ * 2 > entries_.size()) compact();
    return true;
  }

  void clear() { entries_.clear(); index_.clear(); holes_ = 0; }

  /** The first entry in order (the oldest), or nullptr. */
  Entry* first() {
    for (auto& e : entries_)
      if (e) return &*e;
    return nullptr;
  }

  template <typename F>
  void each(F&& f) {
    for (auto& e : entries_)
      if (e) f(e->first, e->second);
  }
  template <typename F>
  void each(F&& f) const {
    for (const auto& e : entries_)
      if (e) f(e->first, e->second);
  }
  std::vector<K> keys() const {
    std::vector<K> out;
    out.reserve(size());
    each([&](const K& k, const V&) { out.push_back(k); });
    return out;
  }

 private:
  void compact() {
    std::vector<std::optional<Entry>> kept;
    kept.reserve(index_.size());
    for (auto& e : entries_)
      if (e) {
        index_[e->first] = kept.size();
        kept.emplace_back(std::move(*e));
      }
    entries_ = std::move(kept);
    holes_ = 0;
  }

  std::vector<std::optional<Entry>> entries_;
  std::unordered_map<K, std::size_t, Hash> index_;
  std::size_t holes_ = 0;
};

}  // namespace stomp

#endif  // STOMP_ORDERED_MAP_HPP
