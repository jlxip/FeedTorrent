#pragma once
#include "rust/cxx.h"
#include <memory>
namespace ft {
struct NativeSnapshot;
struct NativeDhtRequest;
struct NativePeerHints;
struct NativeDhtEvent;
class Session {
public:
  Session(rust::Str state, std::uint16_t port, rust::Str bootstrap,
          bool isolated, bool ipv6_only);
  ~Session();
  void add(rust::Str id, rust::Slice<const std::uint8_t> source, bool magnet,
           rust::Str path, bool active, bool restore);
  void pause(rust::Str id);
  void resume(rust::Str id);
  void remove(rust::Str id);
  NativeSnapshot snapshot();
  void checkpoint();
  void shutdown();
  rust::Vec<std::uint8_t> info_bytes(rust::Str id) const;
  bool is_closed() const;
  void peer_discover(rust::Slice<const std::uint8_t> target, std::uint16_t port);
  rust::Vec<NativePeerHints> peer_hints();
  bool dht_ready() const;
  void dht_start(NativeDhtRequest const &request);
  rust::Vec<NativeDhtEvent> dht_poll();
  void dht_release(std::uint64_t id);

private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
std::unique_ptr<Session> new_session(rust::Str state, std::uint16_t port,
                                     rust::Str bootstrap, bool isolated, bool ipv6_only);
rust::String inspect_magnet(rust::Str uri);
rust::String inspect_torrent(rust::Slice<const std::uint8_t> data);
} // namespace ft
