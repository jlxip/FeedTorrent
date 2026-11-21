#pragma once
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>

namespace ft {
// One immutable process configuration, shared by startup and every new peer.
inline std::pair<unsigned short, unsigned short> ice_port_range() {
  static const auto range = []() -> std::pair<unsigned short, unsigned short> {
    auto const* value = std::getenv("FEEDTORRENT_ICE_PORT_RANGE");
    if (!value) return {1024, 65535};
    auto invalid = []() -> void {
      throw std::runtime_error("FEEDTORRENT_ICE_PORT_RANGE must be BEGIN-END (1024 <= BEGIN <= END <= 65535)");
    };
    std::string text(value);
    auto const dash = text.find('-');
    if (dash == std::string::npos) invalid();
    auto port = [&](std::string const& part) -> unsigned short {
      if (part.empty()) invalid();
      unsigned int result = 0;
      for (auto c : part) {
        if (c < '0' || c > '9') invalid();
        result = result * 10 + unsigned(c - '0');
        if (result > 65535) invalid();
      }
      if (result < 1024) invalid();
      return static_cast<unsigned short>(result);
    };
    auto const begin = port(text.substr(0, dash));
    auto const end = port(text.substr(dash + 1));
    if (begin > end) invalid();
    return {begin, end};
  }();
  return range;
}
} // namespace ft
