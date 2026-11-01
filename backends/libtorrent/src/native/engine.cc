#include "src/native/engine.h"
#include "feedtorrent-libtorrent/src/bridge.rs.h"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/extensions/ut_metadata.hpp>
#include <libtorrent/extensions/ut_pex.hpp>
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
  lt::torrent_handle handle(rust::Str id) { return handles.at(str(id)); }
  void alerts() {
    std::vector<lt::alert *> alerts;
    session->pop_alerts(&alerts);
    for (auto *a : alerts) {
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
