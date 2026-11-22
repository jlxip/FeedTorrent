#pragma once
#include <atomic>
#include <libtorrent/client_data.hpp>
#include <libtorrent/peer_connection_handle.hpp>

namespace ft {
// Owned by KnownPeers and its torrent/peer plugins for the torrent's lifetime.
// Only wire redundancy signaling is suppressed; upload_mode still blocks data.
struct metadata_gate {
  std::atomic<bool> pending{false};
};
inline bool awaiting_metadata_validation(libtorrent::client_data_t const& data) {
  auto const* gate = data.get<metadata_gate>();
  return gate && gate->pending.load();
}
// Defined in the adapted libtorrent translation unit; called on its I/O thread.
void restore_metadata_peer_cleanup(libtorrent::peer_connection_handle const& peer);
} // namespace ft
