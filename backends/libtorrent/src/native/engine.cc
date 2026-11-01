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
  std::map<std::string, std::string> errors, warnings;
  std::set<std::string> metadata_guard, pending;
  std::string warning;
  int nodes = 0;
  int node_metric = -1;
  bool stopped = false;
  bool dht_alerts = false;
  std::map<std::string, DhtSlot> dht_slots;
  std::map<std::uint64_t, NativeDhtEvent> dht_events;
  lt::torrent_handle handle(rust::Str id) { return handles.at(str(id)); }
  void alerts() {
    std::vector<lt::alert *> alerts;
    session->pop_alerts(&alerts);
    for (auto *a : alerts) {
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
          t->handle.unset_flags(lt::torrent_flags::upload_mode);
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
          write(dir / (id + ".resume"), lt::write_resume_data_buf(t->params));
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
                 bool isolated)
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
            isolated ? "127.0.0.1:" + std::to_string(port)
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
                                     bool i) {
  return std::make_unique<Session>(d, p, b, i);
}
void Session::add(rust::Str id, rust::Slice<const std::uint8_t> bytes,
                  bool magnet, rust::Str path, bool active, bool restore) {
  std::string uri(reinterpret_cast<char const *>(bytes.data()), bytes.size());
  auto p = magnet ? magnet_params(uri) : torrent_params(bytes);
  auto key = str(id);
  if (hash(p.info_hashes) != key)
    throw std::runtime_error("Infohash mismatch");
  if (impl->handles.count(key))
    throw std::runtime_error("Transfer already exists");
  if (restore) {
    try {
      auto data = read(impl->dir / (key + ".resume"));
      if (!data.empty()) {
        auto saved = lt::read_resume_data(data);
        if (hash(saved.info_hashes) != key)
          throw std::runtime_error("Saved infohash mismatch");
        if (saved.ti)
          validate(*saved.ti);
        p = std::move(saved);
      }
    } catch (std::exception const &e) {
      impl->warning = "Rebuilding resume data: " + std::string(e.what());
    }
  }
  p.save_path = str(path);
  p.flags &= ~lt::torrent_flags::auto_managed;
  p.flags &= ~lt::torrent_flags::seed_mode;
  p.flags &= ~lt::torrent_flags::stop_when_ready;
  p.flags &= ~lt::torrent_flags::upload_mode;
  p.flags |= lt::torrent_flags::paused;
  if (!p.ti) {
    p.flags |= lt::torrent_flags::upload_mode;
    impl->metadata_guard.insert(key);
  }
  auto h = impl->session->add_torrent(std::move(p));
  impl->handles[key] = h;
  if (h.torrent_file() && restore)
    h.force_recheck();
  if (active)
    h.resume();
}
void Session::pause(rust::Str id) { impl->handle(id).pause(); }
void Session::resume(rust::Str id) {
  auto h = impl->handle(id);
  if (auto ti = h.torrent_file())
    validate(*ti);
  const bool recover = !impl->errors[str(id)].empty() || bool(h.status().errc);
  impl->errors.erase(str(id));
  if (recover)
    h.pause();
  h.clear_error();
  if (recover && h.torrent_file()) {
    h.unset_flags(lt::torrent_flags::upload_mode);
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
  impl->metadata_guard.erase(key);
  impl->errors.erase(key);
  impl->warnings.erase(key);
  fs::remove(impl->dir / (key + ".resume"));
}
NativeSnapshot Session::snapshot() {
  impl->alerts();
  impl->session->post_session_stats();
  NativeSnapshot out;
  out.dht_nodes = impl->nodes;
  out.listen_port = impl->session->listen_port();
  out.warning = impl->warning;
  for (auto const &[id, h] : impl->handles) {
    auto s = h.status();
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
               (seq == sequence && encoded(current) != bytes)))
            conflict->store(true);
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
