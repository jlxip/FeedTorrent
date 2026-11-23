#pragma once
#include <algorithm>
#include <cstdint>
#include <chrono>
#include <iterator>
#include <memory>
#include <vector>
#include <array>
#include <cerrno>
#include <filesystem>
#include <fcntl.h>
#include <libtorrent/bdecode.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/entry.hpp>
#include <libtorrent/extensions.hpp>
#include <libtorrent/error_code.hpp>
#include "src/native/metadata_gate.h"
#include <libtorrent/peer_connection_handle.hpp>
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace ft {
// The persistent key never leaves this process. IDs are scoped to a catalog,
// so the extension does not replace the session's ephemeral peer ID.
class replica_identity {
  std::array<unsigned char, 32> key{};
  static std::array<unsigned char, 32> load(std::filesystem::path const& path) {
    int fd = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) throw std::runtime_error("Cannot open replica identity");
    struct stat st{};
    std::array<unsigned char, 32> bytes{};
    bool valid = ::fstat(fd, &st) == 0 && S_ISREG(st.st_mode)
      && st.st_uid == ::geteuid() && (st.st_mode & 0077) == 0 && st.st_size == 32;
    std::size_t offset = 0;
    while (valid && offset < bytes.size()) {
      auto n = ::read(fd, bytes.data() + offset, bytes.size() - offset);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) { valid = false; break; }
      offset += std::size_t(n);
    }
    ::close(fd);
    if (!valid) {
      OPENSSL_cleanse(bytes.data(), bytes.size());
      throw std::runtime_error("Invalid or insecure replica identity");
    }
    return bytes;
  }
public:
  explicit replica_identity(std::filesystem::path const& directory) {
    auto path = directory / "replica-id.key";
    struct stat st{};
    if (::lstat(path.c_str(), &st) == 0) { key = load(path); return; }
    if (errno != ENOENT) throw std::runtime_error("Cannot inspect replica identity");
    if (RAND_bytes(key.data(), int(key.size())) != 1)
      throw std::runtime_error("Cannot generate replica identity");
    std::string temporary = path.string() + ".XXXXXX";
    int fd = ::mkstemp(temporary.data());
    if (fd < 0) throw std::runtime_error("Cannot create replica identity");
    bool valid = ::fchmod(fd, 0600) == 0;
    std::size_t offset = 0;
    while (valid && offset < key.size()) {
      auto n = ::write(fd, key.data() + offset, key.size() - offset);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) { valid = false; break; }
      offset += std::size_t(n);
    }
    if (valid) valid = ::fsync(fd) == 0;
    if (::close(fd) != 0) valid = false;
    // link is atomic and never replaces an identity won by another process.
    int linked = valid ? ::link(temporary.c_str(), path.c_str()) : -1;
    int link_error = errno;
    ::unlink(temporary.c_str());
    if (!valid || (linked != 0 && link_error != EEXIST))
      throw std::runtime_error("Cannot preserve replica identity");
    key = load(path);
  }
  replica_identity(replica_identity const&) = delete;
  ~replica_identity() { OPENSSL_cleanse(key.data(), key.size()); }
  std::string scoped(std::string const& root) const {
    if (root.size() != 20) throw std::runtime_error("Invalid replica scope");
    static constexpr char domain[] = "FeedTorrent/ft_replica/v1";
    std::string input(domain, sizeof(domain));
    input += root;
    std::array<unsigned char, 32> output{};
    unsigned int length = 0;
    if (!HMAC(EVP_sha256(), key.data(), int(key.size()),
        reinterpret_cast<unsigned char const*>(input.data()), input.size(),
        output.data(), &length) || length != output.size())
      throw std::runtime_error("Cannot derive replica identity");
    return {reinterpret_cast<char const*>(output.data()), output.size()};
  }
};

inline std::string replica_raw(std::string const& hex) {
  if (hex.size() != 40 || hex.find_first_not_of("0123456789abcdef") != std::string::npos)
    throw std::runtime_error("Invalid replica component hash");
  std::string raw(20, '\0');
  for (std::size_t i = 0; i < 20; ++i) raw[i] = char(std::stoul(hex.substr(i * 2, 2), nullptr, 16));
  return raw;
}
struct replica_state {
  struct transfer { std::int64_t size = 0, have = 0; };
  std::mutex mutex;
  std::map<std::string, std::vector<std::string>> scopes;
  std::map<std::string, transfer> transfers;
};
struct replica_peer final : libtorrent::peer_plugin {
  static constexpr int message_id = 42;
  libtorrent::peer_connection_handle peer;
  std::shared_ptr<replica_identity const> identity;
  std::shared_ptr<replica_state> state;
  int remote_id = 0, requests = 0;
  std::string scope;
  std::string own, last_response;
  std::vector<std::string> allowed;
  bool watching = false;
  std::chrono::steady_clock::time_point watch_started;
  replica_peer(libtorrent::peer_connection_handle const& p,
      std::shared_ptr<replica_identity const> id, std::shared_ptr<replica_state> s,
      std::string torrent) : peer(p), identity(std::move(id)), state(std::move(s)), own(std::move(torrent)) {}
  libtorrent::string_view type() const override { return "ft_replica"; }
  void add_handshake(libtorrent::entry& h) override {
    h["m"]["ft_replica"] = message_id;
  }
  bool on_extension_handshake(libtorrent::bdecode_node const& h) override {
    auto m = h.dict_find_dict("m");
    auto id = m ? m.dict_find_int_value("ft_replica", 0) : 0;
    remote_id = id > 0 && id < 256 ? int(id) : 0;
    auto hint = h.dict_find_dict("ft_replica");
    if (remote_id && hint && hint.dict_size() == 3
        && hint.dict_find_int_value("v", 0) == 1 && hint.dict_find_int_value("watch", 0) == 1) {
      auto root = hint.dict_find_string("root");
      if (root && root.string_length() == 20 && scope.empty()) {
        scope.assign(root.string_ptr(), 20);
        watching = true; watch_started = std::chrono::steady_clock::now();
      }
    }
    return remote_id != 0;
  }
  bool authorized() const {
    std::lock_guard<std::mutex> guard(state->mutex);
    auto known = state->scopes.find(scope);
    return known != state->scopes.end()
      && std::find(known->second.begin(), known->second.end(), own) != known->second.end();
  }
  bool can_disconnect(libtorrent::error_code const& ec) override {
    if (!watching || (ec != libtorrent::errors::upload_upload_connection
        && ec != libtorrent::errors::uninteresting_upload_peer)) return true;
    // The wire is also an explicitly negotiated status subscription. All
    // payload/approval guards and ordinary network/host shutdowns still apply.
    return !authorized() && std::chrono::steady_clock::now() - watch_started >= std::chrono::seconds(2);
  }
  bool on_extended(int length, int message, libtorrent::span<char const> body) override {
    if (message != message_id) return false;
    if (length > 128 || length <= 0 || body.size() != length || remote_id == 0) return true;
    if (++requests > 4) return true;
    libtorrent::error_code ec;
    auto query = libtorrent::bdecode(body, ec);
    if (ec || query.type() != libtorrent::bdecode_node::dict_t
        || (query.dict_size() != 2 && query.dict_size() != 3) || query.dict_find_int_value("v", 0) != 1) return true;
    if (query.dict_size() == 3 && query.dict_find_int_value("watch", 0) != 1) return true;
    auto root = query.dict_find_string("root");
    if (!root || root.string_length() != 20) return true;
    std::string requested(root.string_ptr(), 20);
    if (!scope.empty() && scope != requested) return true;
    if (scope.empty()) watch_started = std::chrono::steady_clock::now();
    scope = requested;
    bool was_watching = watching;
    watching = query.dict_find_int_value("watch", 0) == 1;
    respond(true);
    if (was_watching && !watching && !peer.is_disconnecting()) ft::restore_metadata_peer_cleanup(peer);
    return true;
  }
  void tick() override {
    if (watching && !scope.empty()) {
      respond(false);
      if (!authorized() && std::chrono::steady_clock::now() - watch_started >= std::chrono::seconds(2)
          && !peer.is_disconnecting()) ft::restore_metadata_peer_cleanup(peer);
    }
  }
  void respond(bool force) {
    // A caller cannot turn arbitrary chosen roots into a global persistent
    // fingerprint. It must be on that wire or in its verified catalog scope.
    if (scope != own && !authorized()) return;
    libtorrent::entry answer;
    answer["v"] = 1; answer["root"] = scope; answer["node"] = identity->scoped(scope);
    if (watching) {
      std::lock_guard<std::mutex> guard(state->mutex);
      auto known = state->scopes.find(scope);
      if (known != state->scopes.end()
          && std::find(known->second.begin(), known->second.end(), own) != known->second.end())
        allowed = known->second;
      if (!allowed.empty()) {
        libtorrent::entry::list_type parts;
        bool measured = true;
        for (auto const& id : allowed) {
          auto found = state->transfers.find(id);
          auto value = found == state->transfers.end() ? replica_state::transfer{} : found->second;
          if (value.have < 0) measured = false;
          libtorrent::entry part;
          part["id"] = id; part["size"] = value.size; part["have"] = value.have;
          parts.push_back(std::move(part));
        }
        // Checking/approval/error is unknown, not evidence of lost pieces.
        if (measured) answer["parts"] = std::move(parts);
      }
    }
    std::vector<char> encoded;
    libtorrent::bencode(std::back_inserter(encoded), answer);
    std::string response(encoded.begin(), encoded.end());
    if (!force && response == last_response) return;
    last_response = std::move(response);
    auto size = std::uint32_t(encoded.size() + 2);
    std::vector<char> packet{char(size >> 24), char(size >> 16), char(size >> 8),
      char(size), char(20), char(remote_id)};
    packet.insert(packet.end(), encoded.begin(), encoded.end());
    peer.send_buffer(packet.data(), int(packet.size()));
  }
};
struct replica_torrent final : libtorrent::torrent_plugin {
  std::shared_ptr<replica_identity const> identity;
  std::shared_ptr<replica_state> state;
  std::string own;
  replica_torrent(std::shared_ptr<replica_identity const> id, std::shared_ptr<replica_state> s,
      std::string torrent) : identity(std::move(id)), state(std::move(s)), own(std::move(torrent)) {}
  std::shared_ptr<libtorrent::peer_plugin> new_connection(
      libtorrent::peer_connection_handle const& peer) override {
    return std::make_shared<replica_peer>(peer, identity, state, own);
  }
};
} // namespace ft
