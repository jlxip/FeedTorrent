#include "src/native/engine.h"
#include "feedtorrent-libtorrent/src/bridge.rs.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/bdecode.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/entry.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/extensions/ut_metadata.hpp>
#include <libtorrent/extensions/ut_pex.hpp>
#include <libtorrent/hasher.hpp>
#include <libtorrent/hex.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/session_stats.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/write_resume_data.hpp>
#include <map>
#include <set>
#include <stdexcept>
#include <thread>
namespace lt = libtorrent;
namespace fs = std::filesystem;
namespace ft {
static std::string str(rust::Str s) { return std::string(s); }
struct TorrentBuilder::Impl {
  std::vector<lt::create_file_entry> files;
  std::vector<std::string> sources;
  std::unique_ptr<lt::create_torrent> torrent;
  std::ifstream input;
  std::size_t file = 0;
  std::int64_t remaining = 0;
  std::uint64_t done = 0;
  int piece = 0;
  bool padding = false;
  std::shared_ptr<lt::torrent_info const> expected;
  std::vector<std::uint8_t> original;
};
TorrentBuilder::TorrentBuilder(rust::Str name, rust::Slice<const NativeInput> files) : impl(new Impl) {
  auto title = str(name);
  if (title.empty() || fs::path(title).filename() != title || title == "." || title == "..")
    throw std::runtime_error("Invalid torrent title");
  std::set<std::string> names;
  for (auto const& f : files) {
    fs::path path(std::string(f.name));
    if (path.empty() || path.is_absolute() || !names.insert(path.generic_string()).second)
      throw std::runtime_error("Invalid or duplicate torrent path");
    for (auto const& p : path) if (p == ".." || p == ".") throw std::runtime_error("Unsafe torrent path");
    if (f.length > std::uint64_t(INT64_MAX)) throw std::runtime_error("File too large");
    impl->files.emplace_back(title + "/" + path.generic_string(), std::int64_t(f.length));
    impl->sources.emplace_back(std::string(f.source));
  }
  impl->torrent = std::make_unique<lt::create_torrent>(impl->files, 0, lt::create_torrent::v1_only);
  impl->torrent->set_creator("FeedTorrent");
}
TorrentBuilder::~TorrentBuilder() = default;
TorrentBuilder::TorrentBuilder(rust::Slice<const std::uint8_t> data, rust::Slice<const NativeInput> files) : impl(new Impl) {
  if (data.size() > 8 * 1024 * 1024) throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  auto params=lt::load_torrent_buffer(lt::span<char const>(reinterpret_cast<char const*>(data.data()),int(data.size())));
  auto& b=*impl; b.expected=params.ti;
  if (!b.expected || !b.expected->info_hashes().has_v1()) throw std::runtime_error("Expected v1 metainfo");
  std::set<std::string> used;
  for(auto index:b.expected->layout().file_range()) {
    auto const& layout=b.expected->layout();auto name=layout.file_path(index);std::string source;
    if (!layout.pad_file_at(index)) {
      auto it=std::find_if(files.begin(),files.end(),[&](auto const& f){return std::string(f.name)==name;});
      if(it==files.end() || it->length!=std::uint64_t(layout.file_size(index)) || !used.insert(name).second) throw std::runtime_error("Missing or mismatched torrent payload");
      source=std::string(it->source);
    }
    b.files.emplace_back(name,layout.file_size(index),layout.file_flags(index));b.sources.push_back(source);
  }
  if(used.size()!=files.size())throw std::runtime_error("Unexpected torrent payload files");
  b.torrent=std::make_unique<lt::create_torrent>(b.files,b.expected->piece_length(),lt::create_torrent::v1_only);
  b.original.assign(data.begin(),data.end());
}
std::unique_ptr<TorrentBuilder> torrent_verifier(rust::Slice<const std::uint8_t> data,rust::Slice<const NativeInput> files) {
  return std::make_unique<TorrentBuilder>(data,files);
}
std::unique_ptr<TorrentBuilder> torrent_builder(rust::Str name, rust::Slice<const NativeInput> files) {
  return std::make_unique<TorrentBuilder>(name, files);
}
std::uint64_t TorrentBuilder::step() {
  auto& b = *impl;
  if (b.piece >= b.torrent->num_pieces()) return b.done;
  lt::hasher hash;
  std::vector<char> buffer(64 * 1024);
  std::int64_t left = b.torrent->piece_size(lt::piece_index_t(b.piece));
  while (left > 0) {
    while (b.remaining == 0) {
      if (b.input.is_open()) { if (b.input.peek() != EOF) throw std::runtime_error("Source file changed size"); b.input.close(); }
      if (b.file >= b.files.size()) throw std::runtime_error("Incomplete torrent source");
      auto const index = b.file++;
      auto const& source = b.sources[index];
      b.padding=bool(b.files[index].flags & lt::file_storage::flag_pad_file);
      b.remaining = b.files[index].size;
      if(b.padding) { if(b.remaining==0)continue; break; }
      if (!fs::is_regular_file(fs::symlink_status(source))) throw std::runtime_error("Source is no longer a regular file");
      b.input.open(source, std::ios::binary);
      if (!b.input) throw std::runtime_error("Cannot open torrent source");
    }
    auto n = std::min<std::int64_t>({left, b.remaining, std::int64_t(buffer.size())});
    if(b.padding)std::fill(buffer.begin(),buffer.begin()+n,0);
    else {b.input.read(buffer.data(), n);if (b.input.gcount() != n) throw std::runtime_error("Source file changed or cannot be read");}
    hash.update(buffer.data(), int(n));
    b.remaining -= n; left -= n; b.done += std::uint64_t(n);
  }
  auto digest=hash.final();
  if(b.expected && digest!=b.expected->hash_for_piece(lt::piece_index_t(b.piece)))throw std::runtime_error("Torrent piece hash mismatch");
  b.torrent->set_hash(lt::piece_index_t(b.piece++), digest);
  return b.done;
}
rust::Vec<std::uint8_t> TorrentBuilder::finish() const {
  if (impl->piece != impl->torrent->num_pieces()) throw std::runtime_error("Torrent hashing is incomplete");
  auto bytes = impl->torrent->generate_buf();
  if(impl->expected)bytes.assign(impl->original.begin(),impl->original.end());
  if (bytes.size() > 8 * 1024 * 1024) throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  rust::Vec<std::uint8_t> out;
  out.reserve(bytes.size()); for (auto c : bytes) out.push_back(std::uint8_t(c));
  return out;
}
static std::pair<bool, std::int64_t> creation_date(rust::Slice<const std::uint8_t> data) {
  lt::error_code ec;
  auto root = lt::bdecode(lt::span<char const>(reinterpret_cast<char const *>(data.data()), static_cast<int>(data.size())), ec);
  if (ec || root.type() != lt::bdecode_node::dict_t) return {false, 0};
  auto date = root.dict_find("creation date");
  if (date.type() != lt::bdecode_node::int_t) return {false, 0};
  return {true, date.int_value()};
}
static std::string hash(lt::info_hash_t const &h) {
  if (!h.has_v1())
    throw std::runtime_error(
        "Only v1 torrents and v1-compatible hybrids are supported");
  return lt::aux::to_hex(h.v1);
}
static void validate(lt::torrent_info const &ti) {
  hash(ti.info_hashes());
  if (ti.priv())
    throw std::runtime_error("Private torrents are not supported");
  if (ti.layout().num_files() == 0)
    throw std::runtime_error("Torrent contains no files");
  for (auto i : ti.layout().file_range()) {
    fs::path p(ti.layout().file_path(i));
    if (p.is_absolute())
      throw std::runtime_error("Unsafe torrent path");
    for (auto const &part : p)
      if (part == "..")
        throw std::runtime_error("Unsafe torrent path");
    if (ti.layout().file_flags(i) & lt::file_storage::flag_symlink)
      throw std::runtime_error("Torrent symlinks are not supported");
  }
}
static lt::add_torrent_params magnet_params(rust::Str uri) {
  auto text = str(uri);
  if (text.find("urn:btpk:") != std::string::npos)
    throw std::runtime_error("Feed magnets are not supported yet");
  auto p = lt::parse_magnet_uri(text);
  hash(p.info_hashes);
  return p;
}
static lt::add_torrent_params
torrent_params(rust::Slice<const std::uint8_t> bytes) {
  if (bytes.size() > 8 * 1024 * 1024)
    throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  auto p = lt::load_torrent_buffer(
      lt::span<char const>(reinterpret_cast<char const *>(bytes.data()),
                           static_cast<int>(bytes.size())));
  validate(*p.ti);
  p.info_hashes = p.ti->info_hashes();
  return p;
}
rust::String inspect_magnet(rust::Str s) {
  return hash(magnet_params(s).info_hashes);
}
rust::String inspect_torrent(rust::Slice<const std::uint8_t> b) {
  return hash(torrent_params(b).info_hashes);
}
static std::vector<char> read(fs::path const &p) {
  if (!fs::exists(p))
    return {};
  if (fs::file_size(p) > 32 * 1024 * 1024)
    throw std::runtime_error("Saved state exceeds 32 MiB");
  std::ifstream f(p, std::ios::binary);
  if (!f)
    throw std::runtime_error("Cannot read " + p.string());
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}
static void write(fs::path const &p, std::vector<char> const &data) {
  auto tmp = p;
  tmp += ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    f.write(data.data(), data.size());
    f.flush();
    if (!f)
      throw std::runtime_error("Cannot persist " + p.string());
  }
  fs::rename(tmp, p);
}
// A native lookup has no caller userdata. Keep its key reserved until its
// terminal alert is consumed, including after a host-side timeout.
struct DhtSlot {
  std::uint64_t id;
  std::uint8_t kind;
  std::shared_ptr<std::atomic<bool>> conflict;
};
static std::string dht_key(lt::sha1_hash const &hash) {
  return hash.to_string();
}
static std::string dht_key(std::array<char, 32> const &pk,
                           std::string const &salt) {
  lt::hasher h(pk.data(), 32);
  h.update(salt.data(), int(salt.size()));
  return h.final().to_string();
}
static std::vector<char> encoded(lt::entry const &value) {
  std::vector<char> out;
  lt::bencode(std::back_inserter(out), value);
  return out;
}
template <typename T> static rust::Vec<std::uint8_t> binary(T const &bytes) {
  rust::Vec<std::uint8_t> out;
  for (auto byte : bytes)
    out.push_back(std::uint8_t(byte));
  return out;
}
static void item_event(NativeDhtEvent &event, lt::entry const &value) {
  event.has_value = true;
  event.value = binary(encoded(value));
}
struct Session::Impl {
  fs::path dir;
  std::unique_ptr<lt::session> session;
  std::map<std::string, lt::torrent_handle> handles;
  std::map<std::string, fs::path> transfer_roots;
  std::map<std::string, std::pair<bool, std::int64_t>> dates;
  std::map<std::string, std::string> errors, warnings;
  std::set<std::string> metadata_guard, approval_guard, pending, external_guard;
  struct Original { fs::path path; std::uintmax_t size; fs::file_time_type time; };
  std::map<std::string, std::vector<Original>> originals;
  std::string warning;
  int nodes = 0;
  int node_metric = -1;
  bool stopped = false;
  bool dht_alerts = false;
  std::map<std::string, DhtSlot> dht_slots;
  std::map<std::uint64_t, NativeDhtEvent> dht_events;
  std::map<std::string, std::set<std::string>> peer_events;
  lt::torrent_handle handle(rust::Str id) { return handles.at(str(id)); }
  void alerts() {
    std::vector<lt::alert *> alerts;
    session->pop_alerts(&alerts);
    for (auto *a : alerts) {
      if (auto *p = lt::alert_cast<lt::dht_get_peers_reply_alert>(a)) {
        const auto key = dht_key(p->info_hash);
        if (peer_events.count(key) || peer_events.size() < 1024) {
          auto &peers = peer_events[key];
          for (auto const &ep : p->peers()) {
            if (peers.size() >= 512) break;
            auto address = ep.address().to_string();
            if (ep.address().is_v6()) address = "[" + address + "]";
            peers.insert(address + ":" + std::to_string(ep.port()));
          }
        }
      }
      if (auto *t = lt::alert_cast<lt::dht_immutable_item_alert>(a)) {
        auto slot = dht_slots.find(dht_key(t->target));
        if (slot != dht_slots.end() && slot->second.kind == 0) {
          auto &event = dht_events[slot->second.id];
          event.id = slot->second.id;
          event.terminal = true;
          if (t->item.type() != lt::entry::undefined_t)
            item_event(event, t->item);
        }
      }
      if (auto *t = lt::alert_cast<lt::dht_mutable_item_alert>(a)) {
        auto slot = dht_slots.find(dht_key(t->key, t->salt));
        if (slot != dht_slots.end() && slot->second.kind == 1) {
          auto &event = dht_events[slot->second.id];
          event.id = slot->second.id;
          event.terminal = event.terminal || t->authoritative;
          if (t->item.type() != lt::entry::undefined_t) {
            if (!event.has_value || t->seq > event.sequence) {
              item_event(event, t->item);
              event.key = binary(t->key);
              event.signature = binary(t->signature);
              event.salt = binary(t->salt);
              event.sequence = t->seq;
            } else if (t->seq == event.sequence &&
                       encoded(t->item) !=
                           std::vector<char>(event.value.begin(),
                                             event.value.end()))
              event.conflict = true;
          }
        }
      }
      if (auto *t = lt::alert_cast<lt::dht_put_alert>(a)) {
        auto key = t->public_key != std::array<char, 32>{}
                       ? dht_key(t->public_key, t->salt)
                       : dht_key(t->target);
        auto slot = dht_slots.find(key);
        if (slot != dht_slots.end() && slot->second.kind >= 2) {
          auto &event = dht_events[slot->second.id];
          event.id = slot->second.id;
          event.terminal = true;
          event.acknowledged_nodes = std::uint32_t(std::max(t->num_success, 0));
          event.conflict =
              slot->second.conflict && slot->second.conflict->load();
        }
      }

      if (auto *t = lt::alert_cast<lt::metadata_received_alert>(a)) {
        auto id = hash(t->handle.info_hashes());
        try {
          auto ti = t->handle.torrent_file();
          if (!ti)
            throw std::runtime_error("Missing metadata");
          validate(*ti);
          metadata_guard.erase(id);
          if (!approval_guard.count(id) && !external_guard.count(id)) t->handle.unset_flags(lt::torrent_flags::upload_mode);
        } catch (std::exception const &e) {
          errors[id] = e.what();
          t->handle.pause();
        }
      }
      if (auto *t = lt::alert_cast<lt::torrent_error_alert>(a))
        errors[hash(t->handle.info_hashes())] = t->error.message();
      if (auto *t = lt::alert_cast<lt::file_error_alert>(a)) {
        errors[hash(t->handle.info_hashes())] = t->error.message();
        t->handle.pause();
      }
      if (auto *t = lt::alert_cast<lt::tracker_error_alert>(a))
        warnings[hash(t->handle.info_hashes())] = t->message();
      if (auto *t = lt::alert_cast<lt::tracker_reply_alert>(a))
        warnings.erase(hash(t->handle.info_hashes()));
      if (auto *t = lt::alert_cast<lt::peer_disconnected_alert>(a)) {
        if (t->error && t->handle.is_valid() &&
            !t->handle.status().is_finished &&
            t->handle.info_hashes().has_v1() &&
            t->error != lt::errors::self_connection &&
            t->error != lt::errors::upload_upload_connection &&
            t->error != lt::errors::torrent_paused &&
            t->error != lt::errors::torrent_finished &&
            t->error != lt::errors::duplicate_peer_id) {
          warnings[hash(t->handle.info_hashes())] =
              "Peer: " + t->error.message() + " [" +
              t->error.category().name() + ":" +
              std::to_string(t->error.value()) + "]";
        }
      }
      if (auto *t = lt::alert_cast<lt::listen_failed_alert>(a))
        warning = "Listen: " + t->error.message();
      if (auto *t = lt::alert_cast<lt::dht_error_alert>(a))
        warning = "DHT: " + t->error.message();
      if (auto *t = lt::alert_cast<lt::session_stats_alert>(a)) {
        auto c = t->counters();
        if (node_metric >= 0 && node_metric < int(c.size()))
          nodes = int(c[node_metric]);
      }
      if (auto *t = lt::alert_cast<lt::save_resume_data_alert>(a)) {
        auto id = hash(t->params.info_hashes);
        try {
          if (transfer_roots.count(id))
            write(transfer_roots.at(id) / (id + ".resume"), lt::write_resume_data_buf(t->params));
        } catch (std::exception const &e) {
          warning = e.what();
        }
        pending.erase(id);
      }
      if (auto *t = lt::alert_cast<lt::save_resume_data_failed_alert>(a)) {
        pending.erase(hash(t->handle.info_hashes()));
        warning = "Resume data: " + t->error.message();
      }
    }
  }
};
Session::Session(rust::Str dir, std::uint16_t port, rust::Str bootstrap,
                 bool isolated, bool ipv6_only)
    : impl(std::make_unique<Impl>()) {
  impl->dir = str(dir);
  fs::create_directories(impl->dir);
  lt::session_params params;
  try {
    auto b = read(impl->dir / "session.state");
    if (!b.empty())
      params = lt::read_session_params(b, lt::session_handle::save_dht_state);
  } catch (std::exception const &e) {
    impl->warning = std::string("Saved DHT state: ") + e.what();
  }
  auto &s = params.settings;
  s.set_str(lt::settings_pack::listen_interfaces,
            isolated ? (ipv6_only ? "[::1]:" : "127.0.0.1:") + std::to_string(port)
                     : "0.0.0.0:" + std::to_string(port) +
                           ",[::]:" + std::to_string(port));
  s.set_str(lt::settings_pack::user_agent, "FeedTorrent/1.0.0-dev");
  s.set_bool(lt::settings_pack::enable_dht, true);
  s.set_bool(lt::settings_pack::enable_lsd, !isolated);
  s.set_bool(lt::settings_pack::enable_upnp, !isolated);
  s.set_bool(lt::settings_pack::enable_natpmp, !isolated);
  s.set_int(lt::settings_pack::connections_limit, 150);
  s.set_int(lt::settings_pack::alert_mask,
            static_cast<std::uint32_t>(
                lt::alert_category::error | lt::alert_category::status |
                lt::alert_category::storage | lt::alert_category::tracker |
                lt::alert_category::stats | lt::alert_category::connect));
  if (!bootstrap.empty() || isolated)
    s.set_str(lt::settings_pack::dht_bootstrap_nodes, str(bootstrap));
  if (isolated) {
    // Local fixtures share loopback; identify them by IP and port.
    s.set_bool(lt::settings_pack::allow_multiple_connections_per_ip, true);
    s.set_bool(lt::settings_pack::dht_restrict_routing_ips, false);
    s.set_bool(lt::settings_pack::dht_restrict_search_ips, false);
    s.set_bool(lt::settings_pack::dht_enforce_node_id, false);
    s.set_bool(lt::settings_pack::dht_ignore_dark_internet, false);
    // Many independent test nodes share one loopback IP.
    s.set_int(lt::settings_pack::dht_block_ratelimit, 1000);
  }
  impl->session = std::make_unique<lt::session>(std::move(params));
  impl->node_metric = lt::find_metric_idx("dht.dht_nodes");
}
Session::~Session() = default;
std::unique_ptr<Session> new_session(rust::Str d, std::uint16_t p, rust::Str b,
                                     bool i, bool v6) {
  return std::make_unique<Session>(d, p, b, i, v6);
}
void Session::add(rust::Str id, rust::Slice<const std::uint8_t> bytes,
                  bool magnet, rust::Str path, bool active, bool restore, bool held) {
  std::string uri(reinterpret_cast<char const *>(bytes.data()), bytes.size());
  auto p = magnet ? magnet_params(uri) : torrent_params(bytes);
  auto key = str(id);
  if (hash(p.info_hashes) != key)
    throw std::runtime_error("Infohash mismatch");
  if (impl->handles.count(key))
    throw std::runtime_error("Transfer already exists");
  if (restore) {
    try {
      auto data = read(fs::path(str(path)).parent_path() / (key + ".resume"));
      if (!data.empty()) {
        auto saved = lt::read_resume_data(data);
        if (hash(saved.info_hashes) != key)
          throw std::runtime_error("Saved infohash mismatch");
        if (saved.ti)
          validate(*saved.ti);
        // Reuse metadata and peer hints, never the fast-resume piece map.
        // force_recheck() issued during checking_resume_data is ignored by
        // libtorrent. Fresh add parameters force ordinary disk hashing even
        // when a corrupted file retains the recorded size and timestamp.
        if (!p.ti && saved.ti) p.ti = std::move(saved.ti);
        p.peers = std::move(saved.peers);
      }
    } catch (std::exception const &e) {
      impl->warning = "Rebuilding resume data: " + std::string(e.what());
    }
  }
  if (restore && !p.ti) {
    try {
      auto cached = read(fs::path(str(path)).parent_path() / (key + ".info"));
      if (!cached.empty()) {
        if (cached.size() > 8 * 1024 * 1024) throw std::runtime_error("Cached metadata exceeds 8 MiB");
        std::string data = "d4:info";
        data.append(cached.data(), cached.size()); data += 'e';
        auto metadata = lt::load_torrent_buffer(lt::span<char const>(data.data(), static_cast<int>(data.size())));
        validate(*metadata.ti);
        if (hash(metadata.ti->info_hashes()) != key) throw std::runtime_error("Cached metadata infohash mismatch");
        p.ti = std::move(metadata.ti);
      }
    } catch (std::exception const &e) { impl->warning = "Rebuilding cached metadata: " + std::string(e.what()); }
  }
  p.save_path = str(path);
  // This local-only sidecar is never part of metainfo or received from peers.
  // Storage mappings are installed before adding the torrent, not after checking starts.
  auto mapping = fs::path(str(path)).parent_path() / (key + ".external");
  if (fs::exists(mapping)) {
    if (!p.ti || !fs::is_regular_file(fs::symlink_status(mapping)))
      throw std::runtime_error("Invalid external source manifest");
    std::ifstream manifest(mapping);
    std::vector<Impl::Original> originals;
    std::string line;
    while (std::getline(manifest, line)) {
      auto tab = line.find('\t');
      if (tab == std::string::npos) throw std::runtime_error("Invalid external source entry");
      int index = -1;
      for (auto i : p.ti->layout().file_range()) if (p.ti->layout().file_path(i) == line.substr(0, tab)) index = int(i);
      fs::path original(line.substr(tab + 1));
      if (index < 0 || index >= p.ti->num_files() || !original.is_absolute() ||
          !fs::is_regular_file(fs::symlink_status(original)))
        throw std::runtime_error("External source missing or not a regular file");
      for (auto parent = original.parent_path(); !parent.empty(); parent = parent.parent_path()) {
        if (fs::is_symlink(fs::symlink_status(parent))) throw std::runtime_error("External source symlinks are not supported");
        if (parent == parent.parent_path()) break;
      }
      if (fs::file_size(original) != std::uintmax_t(p.ti->layout().file_size(lt::file_index_t(index))))
        throw std::runtime_error("External source changed size");
      p.renamed_files[lt::file_index_t(index)] = original.string();
      originals.push_back({original, fs::file_size(original), fs::last_write_time(original)});
    }
    if (originals.empty()) throw std::runtime_error("Empty external source manifest");
    impl->external_guard.insert(key);
    impl->originals[key] = std::move(originals);
  }
  p.flags &= ~lt::torrent_flags::auto_managed;
  p.flags &= ~lt::torrent_flags::seed_mode;
  p.flags &= ~lt::torrent_flags::stop_when_ready;
  p.flags &= ~lt::torrent_flags::upload_mode;
  if (impl->external_guard.count(key)) p.flags |= lt::torrent_flags::upload_mode;
  p.flags |= lt::torrent_flags::paused;
  if (!held) impl->approval_guard.erase(key);
  if (held) {
    p.flags |= lt::torrent_flags::upload_mode;
    impl->approval_guard.insert(key);
  }
  if (!p.ti) {
    p.flags |= lt::torrent_flags::upload_mode;
    impl->metadata_guard.insert(key);
  }
  auto h = impl->session->add_torrent(std::move(p));
  impl->handles[key] = h;
  impl->transfer_roots[key] = fs::path(str(path)).parent_path();
  impl->dates[key] = magnet ? std::make_pair(false, std::int64_t(0)) : creation_date(bytes);
  if (active)
    h.resume();
}
void Session::pause(rust::Str id) { impl->handle(id).pause(); }
void Session::resume(rust::Str id) {
  auto h = impl->handle(id);
  if (auto ti = h.torrent_file())
    validate(*ti);
  const bool recover = !impl->errors[str(id)].empty() || bool(h.status().errc);
  if (impl->external_guard.count(str(id))) {
    for (auto& f : impl->originals.at(str(id))) {
      if (!fs::is_regular_file(fs::symlink_status(f.path)) || fs::file_size(f.path) != f.size)
        throw std::runtime_error("Original file missing or changed size");
      f.time = fs::last_write_time(f.path);
    }
    h.set_flags(lt::torrent_flags::upload_mode);
    h.force_recheck();
  }
  impl->errors.erase(str(id));
  if (recover)
    h.pause();
  h.clear_error();
  if (recover && h.torrent_file()) {
    if (!impl->approval_guard.count(str(id)) && !impl->external_guard.count(str(id))) h.unset_flags(lt::torrent_flags::upload_mode);
    h.force_recheck();
  }
  h.resume();
}
void Session::remove(rust::Str id) {
  auto key = str(id);
  auto h = impl->handle(id);
  impl->session->remove_torrent(h);
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (h.is_valid() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  if (h.is_valid())
    throw std::runtime_error(
        "Timed out detaching transfer; files were preserved");
  impl->handles.erase(key);
  impl->dates.erase(key);
  impl->metadata_guard.erase(key);
  impl->approval_guard.erase(key);
  impl->external_guard.erase(key);
  impl->originals.erase(key);
  impl->errors.erase(key);
  impl->warnings.erase(key);
  if (impl->transfer_roots.count(key)) {
    fs::remove(impl->transfer_roots.at(key) / (key + ".resume"));
    impl->transfer_roots.erase(key);
  }
}
NativeSnapshot Session::snapshot() {
  impl->alerts();
  impl->session->post_session_stats();
  NativeSnapshot out;
  out.dht_nodes = impl->nodes;
  out.listen_port = impl->session->listen_port();
  out.warning = impl->warning;
  for (auto const &[id, h] : impl->handles) {
    if (impl->external_guard.count(id)) {
      try {
        for (auto const& f : impl->originals.at(id)) {
          if (!fs::is_regular_file(fs::symlink_status(f.path)) || fs::file_size(f.path) != f.size || fs::last_write_time(f.path) != f.time)
            throw std::runtime_error("Original file changed or disappeared; source files preserved");
        }
      } catch (std::exception const& error) {
        h.pause(); impl->errors[id] = error.what();
      }
    }
    auto s = h.status();
    if (impl->external_guard.count(id) && s.state != lt::torrent_status::checking_files &&
        s.state != lt::torrent_status::checking_resume_data && !s.is_finished) {
      h.pause(); impl->errors[id] = "Original files do not match this torrent; files preserved";
    }
    NativeTransfer t;
    t.id = id;
    t.name = s.name;
    t.total = std::max<std::int64_t>(s.total_wanted, 0);
    // total_done can include unfinished blocks; only verified pieces count.
    t.verified = std::max<std::int64_t>(s.total_wanted_done, 0);
    t.down = std::max(s.download_payload_rate, 0);
    t.up = std::max(s.upload_payload_rate, 0);
    t.peers = std::max(s.num_peers, 0);
    t.error = impl->errors[id];
    if (s.errc)
      t.error = s.errc.message();
    // A completed seed normally closes upload-only peer connections.
    if (s.is_finished && impl->warnings[id].rfind("Peer:", 0) == 0)
      impl->warnings.erase(id);
    t.warning = impl->warnings[id];
    t.finished = s.is_finished;
    if (!t.error.empty())
      t.state = "Error";
    else if (s.flags & lt::torrent_flags::paused)
      t.state = "Paused";
    else if (s.state == lt::torrent_status::checking_files ||
             s.state == lt::torrent_status::checking_resume_data)
      t.state = "Checking";
    else if (!s.has_metadata)
      t.state = "Waiting for metadata";
    else if (s.is_finished)
      t.state = "Seeding";
    else if (!s.num_peers)
      t.state = "Waiting for peers";
    else
      t.state = "Downloading";
    if (auto ti = h.torrent_file()) {
      std::vector<std::int64_t> progress;
      h.file_progress(progress, lt::torrent_handle::piece_granularity);
      auto const &files = ti->layout();
      t.verified = 0;
      t.total = 0;
      for (auto i : files.file_range()) {
        if (files.pad_file_at(i))
          continue;
        NativeFile f;
        f.padding = false;
        f.name = files.file_path(i);
        f.length = files.file_size(i);
        f.verified = std::max<std::int64_t>(progress.at(int(i)), 0);
        t.verified += f.verified;
        t.total += f.length;
        t.files.push_back(std::move(f));
      }
    }
    out.transfers.push_back(std::move(t));
  }
  return out;
}
rust::Vec<std::uint8_t> Session::info_bytes(rust::Str id) const {
  if (impl->stopped) throw std::runtime_error("Backend closed");
  auto handle = impl->handles.find(str(id));
  if (handle == impl->handles.end()) throw std::runtime_error("Unknown transfer");
  auto file = handle->second.torrent_file();
  rust::Vec<std::uint8_t> out;
  if (!file) return out;
  auto info = file->info_section();
  if (info.size() > 8 * 1024 * 1024) throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  out.reserve(info.size());
  for (char byte : info) out.push_back(static_cast<std::uint8_t>(byte));
  return out;
}
bool Session::is_closed() const { return impl->stopped; }
void Session::peer_discover(rust::Slice<const std::uint8_t> target, std::uint16_t port) {
  if (impl->stopped) throw std::runtime_error("Backend closed");
  if (!dht_ready()) throw std::runtime_error("DHT not running");
  if (target.size() != 20) throw std::runtime_error("Invalid target");
  auto mask = impl->session->get_settings().get_int(lt::settings_pack::alert_mask);
  lt::settings_pack settings;
  settings.set_int(lt::settings_pack::alert_mask, mask | int(static_cast<std::uint32_t>(lt::alert_category::dht_operation)));
  impl->session->apply_settings(settings);
  lt::sha1_hash hash(reinterpret_cast<char const *>(target.data()));
  if (port) impl->session->dht_announce(hash, port);
  else impl->session->dht_get_peers(hash);
}
rust::Vec<NativePeerHints> Session::peer_hints() {
  if (impl->stopped) throw std::runtime_error("Backend closed");
  impl->alerts();
  rust::Vec<NativePeerHints> out;
  for (auto const &entry : impl->peer_events) {
    NativePeerHints item;
    item.target = binary(entry.first);
    for (auto const &peer : entry.second) item.peers.push_back(peer);
    out.push_back(std::move(item));
  }
  impl->peer_events.clear();
  return out;
}
bool Session::dht_ready() const {
  return !impl->stopped && impl->session->is_dht_running();
}
void Session::dht_start(NativeDhtRequest const &r) {
  if (!dht_ready())
    throw std::runtime_error("DHT not running");
  if (r.target.size() != 20 || r.kind > 3)
    throw std::runtime_error("Invalid DHT request");
  std::string key(reinterpret_cast<char const *>(r.target.data()),
                  r.target.size());
  if (impl->dht_slots.count(key))
    throw std::runtime_error("DHT key busy");
  if (!impl->dht_alerts) {
    auto mask =
        impl->session->get_settings().get_int(lt::settings_pack::alert_mask);
    lt::settings_pack settings;
    settings.set_int(
        lt::settings_pack::alert_mask,
        mask | int(static_cast<std::uint32_t>(lt::alert_category::dht)));
    impl->session->apply_settings(settings);
    impl->dht_alerts = true;
  }
  lt::sha1_hash target(key.data());
  std::array<char, 32> pk{};
  std::string salt(reinterpret_cast<char const *>(r.salt.data()),
                   r.salt.size());
  if (r.kind == 1 || r.kind == 3) {
    if (r.key.size() != 32 || r.salt.size() > 64)
      throw std::runtime_error("Invalid mutable key");
    std::copy(r.key.begin(), r.key.end(), pk.begin());
    if (dht_key(pk, salt) != key)
      throw std::runtime_error("DHT identity mismatch");
  }
  lt::entry value;
  if (r.kind >= 2) {
    if (r.value.empty() || r.value.size() > 1000)
      throw std::runtime_error("Invalid DHT value size");
    lt::error_code ec;
    auto node = lt::bdecode({reinterpret_cast<char const *>(r.value.data()),
                             static_cast<std::ptrdiff_t>(r.value.size())},
                            ec, nullptr, 65, 2048);
    if (ec)
      throw std::runtime_error(ec.message());
    value = lt::entry(node);
    if (encoded(value) != std::vector<char>(r.value.begin(), r.value.end()))
      throw std::runtime_error("Noncanonical DHT value");
    if (r.kind == 2 && lt::hasher(encoded(value)).final() != target)
      throw std::runtime_error("DHT hash mismatch");
  }
  if (r.kind == 3 && (r.signature.size() != 64 || r.sequence < 0))
    throw std::runtime_error("Invalid signed DHT record");
  auto conflict = std::make_shared<std::atomic<bool>>(false);
  impl->dht_slots.emplace(key, DhtSlot{r.id, r.kind, conflict});
  if (r.kind == 0)
    impl->session->dht_get_item(target);
  else if (r.kind == 1)
    impl->session->dht_get_item(pk, salt);
  else if (r.kind == 2)
    impl->session->dht_put_item(value);
  else {
    std::array<char, 64> sig{};
    std::copy(r.signature.begin(), r.signature.end(), sig.begin());
    auto sequence = r.sequence;
    auto bytes = encoded(value);
    impl->session->dht_put_item(
        pk,
        [value, sig, sequence, bytes,
         conflict](lt::entry &current, std::array<char, 64> &signature,
                   std::int64_t &seq, std::string const &) {
          if (current.type() != lt::entry::undefined_t &&
              (seq > sequence ||
               (seq == sequence && encoded(current) != bytes))) {
            // Preserve the existing signed native item. In particular do not
            // publish an equivocation after reporting this request as failed.
            conflict->store(true);
            return;
          }
          current = value;
          signature = sig;
          seq = sequence;
        },
        salt);
  }
}
rust::Vec<NativeDhtEvent> Session::dht_poll() {
  impl->alerts();
  rust::Vec<NativeDhtEvent> out;
  for (auto &item : impl->dht_events)
    out.push_back(std::move(item.second));
  impl->dht_events.clear();
  return out;
}
void Session::dht_release(std::uint64_t id) {
  for (auto i = impl->dht_slots.begin(); i != impl->dht_slots.end(); ++i) {
    if (i->second.id == id) {
      impl->dht_slots.erase(i);
      break;
    }
  }
  impl->dht_events.erase(id);
}
void Session::checkpoint() {
  for (auto const &[id, h] : impl->handles) {
    h.save_resume_data(lt::torrent_handle::save_info_dict |
                       lt::torrent_handle::flush_disk_cache);
    impl->pending.insert(id);
  }
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (!impl->pending.empty() &&
         std::chrono::steady_clock::now() < deadline) {
    impl->session->wait_for_alert(std::chrono::milliseconds(50));
    impl->alerts();
  }
  auto p = impl->session->session_state(lt::session_handle::save_dht_state);
  write(impl->dir / "session.state",
        lt::write_session_params_buf(p, lt::session_handle::save_dht_state));
  if (!impl->pending.empty())
    throw std::runtime_error(
        "Timed out saving resume data; next start will recheck files");
}
void Session::shutdown() {
  if (!impl->stopped) {
    checkpoint();
    impl->session->pause();
    impl->stopped = true;
  }
}
} // namespace ft

namespace ft {
static NativeDescription describe(lt::torrent_info const &ti) {
  NativeDescription out;
  out.name = ti.name();
  auto info = ti.info_section();
  if (info.size() > 8*1024*1024) throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  for (char c : info) out.info.push_back(static_cast<std::uint8_t>(c));
  auto const &files = ti.layout();
  for (auto i : files.file_range()) {
    NativeFile file;
    file.name = files.file_path(i);
    file.verified = 0;
    file.length = std::uint64_t(files.file_size(i));
    file.padding = files.pad_file_at(i);
    out.total += file.length;
    out.files.push_back(std::move(file));
  }
  try { validate(ti); out.id = hash(ti.info_hashes()); }
  catch (std::exception const &e) { out.error = e.what(); }
  return out;
}
NativeDescription describe_torrent(rust::Slice<const std::uint8_t> data) {
  if (data.size()>8*1024*1024) throw std::runtime_error("Torrent metadata exceeds 8 MiB");
  auto p=lt::load_torrent_buffer(lt::span<char const>(reinterpret_cast<char const *>(data.data()),static_cast<int>(data.size())));
  if (!p.ti) throw std::runtime_error("Missing torrent metadata");
  auto out = describe(*p.ti);
  auto date = creation_date(data);
  out.has_creation_date = date.first; out.creation_date = date.second;
  return out;
}
NativeDescription Session::description(rust::Str id) const {
  if (impl->stopped) throw std::runtime_error("Backend closed");
  auto it=impl->handles.find(str(id));
  if(it==impl->handles.end()) throw std::runtime_error("Unknown transfer");
  auto ti=it->second.torrent_file();
  if(!ti) throw std::runtime_error("Metadata unavailable");
  auto out = describe(*ti);
  auto date = impl->dates.at(str(id));
  out.has_creation_date = date.first; out.creation_date = date.second;
  return out;
}
NativeFile Session::file_at(rust::Str id,std::uint32_t index) const {
  if (impl->stopped) throw std::runtime_error("Backend closed");
  auto it=impl->handles.find(str(id));
  if(it==impl->handles.end()) throw std::runtime_error("Unknown transfer");
  auto ti=it->second.torrent_file();
  if(!ti || index>=std::uint32_t(ti->layout().num_files())) throw std::runtime_error("Unknown file index");
  std::vector<std::int64_t> progress;
  it->second.file_progress(progress,lt::torrent_handle::piece_granularity);
  auto i=lt::file_index_t(static_cast<int>(index));
  NativeFile out;
  out.padding=ti->layout().pad_file_at(i);
  out.name=ti->layout().file_path(i);
  out.length=std::uint64_t(ti->layout().file_size(i));
  auto status=it->second.status();
  const bool checking=status.state==lt::torrent_status::checking_files || status.state==lt::torrent_status::checking_resume_data;
  out.verified=checking?0:std::uint64_t(std::max<std::int64_t>(progress.at(index),0));
  return out;
}
void Session::allow_download(rust::Str id) {
  if (impl->external_guard.count(str(id))) throw std::runtime_error("External originals are read-only; recreate this torrent to change its content");
  if (impl->stopped) throw std::runtime_error("Backend closed");
  auto h=impl->handle(id);
  auto ti=h.torrent_file();
  if(!ti) throw std::runtime_error("Metadata unavailable");
  validate(*ti);
  impl->approval_guard.erase(str(id));
  h.unset_flags(lt::torrent_flags::upload_mode);
  h.resume();
}
}
