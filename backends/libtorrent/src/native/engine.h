#pragma once
#include "rust/cxx.h"
#include <memory>
namespace ft {
struct NativeSnapshot;
struct NativeDhtRequest;
struct NativeDhtEvent;
class Session {
public:
  Session(rust::Str state, std::uint16_t port, rust::Str bootstrap,
          bool isolated);
  ~Session();
  void add(rust::Str id, rust::Slice<const std::uint8_t> source, bool magnet,
           rust::Str path, bool active, bool restore);
  void pause(rust::Str id);
  void resume(rust::Str id);
  void remove(rust::Str id);
  NativeSnapshot snapshot();
  void checkpoint();
  void shutdown();
  bool dht_ready() const;
  void dht_start(NativeDhtRequest const &request);
  rust::Vec<NativeDhtEvent> dht_poll();
  void dht_release(std::uint64_t id);

private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
std::unique_ptr<Session> new_session(rust::Str state, std::uint16_t port,
                                     rust::Str bootstrap, bool isolated);
rust::String inspect_magnet(rust::Str uri);
rust::String inspect_torrent(rust::Slice<const std::uint8_t> data);
} // namespace ft
