#pragma once
#include "ice_ports.h"
#include <algorithm>
#include <atomic>
#include <memory>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <stdexcept>

namespace ft {
inline std::atomic<unsigned>& ice_slots() { static std::atomic<unsigned> used{0}; return used; }
inline std::atomic<unsigned>& outgoing_ice_slots() { static std::atomic<unsigned> used{0}; return used; }
// ICE negotiations own a UDP socket before they count as libtorrent peers.
// Keep the existing connection limit effective for that whole lifetime and
// never promise more sockets than the configured process-wide ICE range.
class ice_slot {
public:
  explicit ice_slot(int connection_limit, bool outgoing = false) : counter(outgoing ? outgoing_ice_slots() : ice_slots()) {
    auto const ports = ice_port_range();
    unsigned const width = unsigned(ports.second) - ports.first + 1;
    unsigned limit = connection_limit > 0 ? std::min(width, unsigned(connection_limit)) : width;
    // Reserve half the capacity for incoming offers. Otherwise a large library
    // could fill the entire range with unanswered outgoing negotiations.
    if (outgoing) limit = std::max(1u, limit / 2);
    auto& slots = counter;
    unsigned used = slots.load();
    while (used < limit) if (slots.compare_exchange_weak(used, used + 1)) return;
    throw std::runtime_error("WebRTC ICE capacity reached");
  }
  ice_slot(ice_slot const&) = delete;
  ice_slot& operator=(ice_slot const&) = delete;
  ~ice_slot() { counter.fetch_sub(1); }
private:
  std::atomic<unsigned>& counter;
};
// Only successful, unclaimed outgoing offers are registered. The tracker ACK
// can prove that an offer had no recipient, so its socket need not wait for
// the two-minute negotiation timeout. Keys include the session peer ID.
struct ice_offer_registration {
  std::weak_ptr<ice_slot> slot;
  std::function<void()> cancel;
};
inline auto& ice_offer_mutex() { static std::mutex mutex; return mutex; }
inline auto& ice_offers() { static std::map<std::string, ice_offer_registration> offers; return offers; }
inline void track_ice_offer(std::string key, std::weak_ptr<ice_slot> slot, std::function<void()> cancel) {
  std::lock_guard<std::mutex> lock(ice_offer_mutex());
  auto& offers = ice_offers();
  for (auto it = offers.begin(); it != offers.end();)
    if (it->second.slot.expired()) it = offers.erase(it); else ++it;
  offers.insert_or_assign(std::move(key), ice_offer_registration{std::move(slot), std::move(cancel)});
}
inline void cancel_unmatched_ice_offer(std::string const& key) {
  std::function<void()> cancel;
  {
    std::lock_guard<std::mutex> lock(ice_offer_mutex());
    auto& offers = ice_offers();
    auto const it = offers.find(key);
    if (it == offers.end()) return;
    if (!it->second.slot.expired()) cancel = std::move(it->second.cancel);
    offers.erase(it);
  }
  // The caller and registered callback belong to the same libtorrent I/O
  // context; never run a callback while holding the process-wide registry lock.
  if (cancel) cancel();
}
inline auto acquire_ice_slot(int limit) { return std::make_shared<ice_slot>(limit); }
inline auto acquire_outgoing_ice_slot(int limit) { return std::make_shared<ice_slot>(limit, true); }
} // namespace ft
