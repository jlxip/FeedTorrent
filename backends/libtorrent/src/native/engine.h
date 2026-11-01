#pragma once
#include "rust/cxx.h"
#include <memory>
namespace ft {
struct NativeSnapshot;
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

private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
std::unique_ptr<Session> new_session(rust::Str state, std::uint16_t port,
                                     rust::Str bootstrap, bool isolated);
rust::String inspect_magnet(rust::Str uri);
rust::String inspect_torrent(rust::Slice<const std::uint8_t> data);
} // namespace ft
