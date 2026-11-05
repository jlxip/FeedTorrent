mod feeds;
mod publishing;
mod publishing_keys;
use anyhow::{anyhow, bail, Context, Result};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use feedtorrent_bep::{
    normalize_magnet_input, valid_id, AddTransfer, TorrentBackend, TorrentSource,
};
use feedtorrent_libtorrent::LibtorrentBackend;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    convert::Infallible,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};

#[derive(Parser, Debug)]
#[command(version, about = "FeedTorrent local BitTorrent client")]
struct Args {
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    download_dir: Option<PathBuf>,
    #[arg(long, default_value_t = 0)]
    http_port: u16,
    #[arg(long)]
    peer_port: Option<u16>,
    #[arg(long)]
    no_open: bool,
    /// Isolate the network for deterministic integration tests.
    #[arg(long, hide = true)]
    isolated: bool,
    #[arg(long, hide = true)]
    dht_bootstrap: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Settings {
    download_dir: String,
    peer_port: u16,
    #[serde(default = "default_seed")]
    seed_by_default: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    id: String,
    magnet: bool,
    path: PathBuf,
    active: bool,
    #[serde(default = "default_seed")]
    seed: bool,
    #[serde(default)]
    held: bool,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    feed: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Store {
    version: u32,
    settings: Settings,
    records: Vec<Record>,
}
#[derive(Clone, Default, Debug, Serialize)]
struct TorrentFile {
    name: String,
    length: u64,
    verified: u64,
    ready: bool,
}
#[derive(Clone, Default, Debug, Serialize)]
struct Transfer {
    id: String,
    name: String,
    state: String,
    error: String,
    warning: String,
    active: bool,
    verified: u64,
    total: u64,
    progress: f64,
    down: u64,
    up: u64,
    peers: u32,
    files: Vec<TorrentFile>,
    save_path: String,
    held: bool,
    approval_size: Option<u64>,
    kind: String,
    feed: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
struct Snapshot {
    engine: &'static str,
    transfers: Vec<Transfer>,
    settings: Settings,
    dht_nodes: u32,
    listen_port: u16,
    warning: String,
    ready: bool,
    feeds: Vec<feedtorrent_feeds::FeedView>,
    feed_error: String,
    feed_time_ms: u64,
    news_unread: usize,
    news_revision: String,
    publishing: publishing::View,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    NewsPage {
        #[serde(default)]
        offset: usize,
        anchor: Option<String>,
    },
    SetUpdateRead {
        feed: String,
        sequence: String,
        read: bool,
    },
    MarkCatalogRead {
        feed: String,
        catalog: String,
        sequence: Option<String>,
    },
    ReadCatalogBody {
        feed: String,
        catalog: String,
    },
    InspectSource {
        uri: String,
    },
    FollowFeed {
        uri: String,
        config: feedtorrent_feeds::Config,
    },
    ConfigureFeed {
        id: String,
        config: feedtorrent_feeds::Config,
    },
    UnfollowFeed {
        id: String,
    },
    RefreshFeed {
        id: String,
    },
    OpenCatalog {
        feed: String,
        id: String,
    },
    DownloadEntry {
        feed: String,
        catalog: String,
        index: usize,
    },
    ApproveTransfer {
        id: String,
    },
    RevealEntry {
        catalog: String,
        index: usize,
    },
    CatalogPage {
        feed: String,
        catalog: String,
        #[serde(default)]
        offset: usize,
    },
    AddMagnet {
        uri: String,
    },
    AddTorrent {
        data: Vec<u8>,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
    },
    Remove {
        id: String,
        #[serde(default)]
        delete_files: bool,
    },
    Reveal {
        id: String,
        file: Option<usize>,
    },
    Configure {
        settings: Settings,
    },
}
struct Job {
    command: Command,
    reply: oneshot::Sender<std::result::Result<serde_json::Value, String>>,
}
#[derive(Clone)]
struct App {
    publishing: publishing::Client,
    jobs: mpsc::SyncSender<Job>,
    view: watch::Receiver<Snapshot>,
    origin: String,
    host: String,
    token: String,
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("tmp");
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&temp, path)?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
fn read_limited(path: &Path) -> Result<Vec<u8>> {
    if fs::metadata(path)?.len() > 32 * 1024 * 1024 {
        bail!("Saved state exceeds 32 MiB");
    }
    Ok(fs::read(path)?)
}
fn default_seed() -> bool {
    true
}
fn default_store() -> Store {
    Store {
        version: 3,
        settings: Settings {
            download_dir: "downloads".into(),
            peer_port: 6881,
            seed_by_default: true,
        },
        records: vec![],
    }
}
fn migrate_store(store: &mut Store, home: &Path) -> Result<()> {
    match store.version {
        1 => {
            if Path::new(&store.settings.download_dir) == home.join("Downloads/FeedTorrent") {
                store.settings.download_dir = "downloads".into();
            }
            store.version = 2;
        }
        2 | 3 => {}
        _ => bail!("Unsupported transfer registry version; data preserved"),
    }
    store.version = 3;
    Ok(())
}
fn directory_setting(value: &str) -> Result<String> {
    if value.is_empty() {
        bail!("Download folder cannot be empty");
    }
    ensure_directory(Path::new(value))?;
    Ok(value.to_owned())
}
fn ensure_directory(path: &Path) -> Result<PathBuf> {
    fs::create_dir_all(path).with_context(|| format!("Cannot create {}", path.display()))?;
    Ok(fs::canonicalize(path)?)
}
fn reject_symlinks(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    if m.file_type().is_symlink() {
        bail!("Symlink in transfer directory: {}", path.display());
    }
    if m.is_dir() {
        for e in fs::read_dir(path)? {
            reject_symlinks(&e?.path())?;
        }
    }
    Ok(())
}
fn payload_path(base: &str, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("Invalid transfer identifier");
    }
    let base = ensure_directory(Path::new(base))?;
    let target = base.join(id);
    if !target.exists() {
        fs::create_dir(&target)?;
    }
    reject_symlinks(&target)?;
    Ok(target)
}
struct Engine {
    refresh_serial: u64,
    native: LibtorrentBackend,
    publication_native: Option<publishing::Bridge>,
    publication_view: Option<watch::Receiver<publishing::View>>,
    feeds: Option<feeds::FeedHost>,
    store: Store,
    dir: PathBuf,
    failures: BTreeMap<String, String>,
    view: Snapshot,
}
impl Engine {
    fn persist(&self) -> Result<()> {
        atomic(
            &self.dir.join("transfers.json"),
            &serde_json::to_vec_pretty(&self.store)?,
        )
        .context("Cannot save transfer registry")
    }
    fn new(args: &Args, dir: PathBuf, store: Store) -> Result<Self> {
        let native = LibtorrentBackend::new(
            dir.to_str().context("Non-UTF-8 state directory")?,
            store.settings.peer_port,
            args.dht_bootstrap.as_deref().unwrap_or(""),
            args.isolated,
        )?;
        let view = Snapshot {
            engine: "libtorrent-rasterbar 2.1.2",
            transfers: vec![],
            settings: store.settings.clone(),
            dht_nodes: 0,
            listen_port: 0,
            warning: String::new(),
            ready: false,
            feeds: vec![],
            feed_error: String::new(),
            feed_time_ms: 0,
            news_unread: 0,
            news_revision: String::new(),
            publishing: publishing::View::default(),
        };
        let mut e = Self {
            refresh_serial: 0,
            native,
            publication_native: None,
            publication_view: None,
            feeds: Some(feeds::FeedHost::new(&dir, args.isolated)),
            store,
            dir,
            failures: BTreeMap::new(),
            view,
        };
        for record in e.store.records.clone() {
            let outcome = (|| -> Result<()> {
                if !valid_id(&record.id)
                    || record.path.file_name().and_then(|s| s.to_str()) != Some(record.id.as_str())
                {
                    bail!("Invalid stored transfer path");
                }
                fs::create_dir_all(&record.path)?;
                reject_symlinks(&record.path)?;
                let bytes = read_limited(&e.dir.join(format!("{}.source", record.id)))?;
                let transfer = AddTransfer {
                    id: &record.id,
                    source: TorrentSource::from_bytes(&bytes, record.magnet)?,
                    save_path: record.path.to_str().context("Non-UTF-8 transfer path")?,
                    active: record.active,
                    restore: true,
                };
                if record.held {
                    e.native.stage(transfer)?;
                } else {
                    e.native.add(transfer)?;
                }
                Ok(())
            })();
            if let Err(err) = outcome {
                e.failures
                    .insert(record.id.clone(), format!("Restore: {err:#}"));
                if let Some(r) = e.store.records.iter_mut().find(|r| r.id == record.id) {
                    r.active = false;
                }
            }
        }
        e.persist()?;
        // Commit migrations and their detection times before serving the first snapshot.
        if let Err(error) = e.persist_feeds() {
            if let Some(host) = &mut e.feeds {
                host.error = format!("Feed persistence: {error:#}");
            }
        }
        e.refresh()?;
        Ok(e)
    }
    fn record(&self, id: &str) -> Result<&Record> {
        self.store
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow!("Transfer not found"))
    }
    fn add(&mut self, bytes: Vec<u8>, magnet: bool) -> Result<()> {
        if bytes.len() > 8 * 1024 * 1024 {
            bail!("Torrent metadata exceeds 8 MiB");
        }
        let id = self
            .native
            .inspect(TorrentSource::from_bytes(&bytes, magnet)?)?;
        if self.store.records.iter().any(|r| r.id == id) {
            bail!("Transfer already exists");
        }
        let path = payload_path(&self.store.settings.download_dir, &id)?;
        atomic(&self.dir.join(format!("{id}.source")), &bytes)?;
        self.native.add(AddTransfer {
            id: &id,
            source: TorrentSource::from_bytes(&bytes, magnet)?,
            save_path: path.to_str().context("Non-UTF-8 transfer path")?,
            active: true,
            restore: false,
        })?;
        self.store.records.push(Record {
            id: id.clone(),
            magnet,
            path,
            active: true,
            seed: self.store.settings.seed_by_default,
            held: false,
            kind: String::new(),
            feed: None,
        });
        if let Err(error) = self.persist() {
            self.store.records.retain(|r| r.id != id);
            let _ = self.native.remove(&id);
            return Err(error);
        }
        Ok(())
    }
    fn apply(&mut self, command: Command) -> Result<()> {
        match command {
            Command::SetUpdateRead {
                feed,
                sequence,
                read,
            } => return self.news_read(&feed, &sequence, read),
            Command::MarkCatalogRead {
                feed,
                catalog,
                sequence,
            } => {
                let host = self.feeds.as_ref().context("Feed service unavailable")?;
                if !host.manager.page(&feed, &catalog, 0)?.catalog.ready {
                    bail!("Catalog has not been verified")
                }
                if let Some(seq) =
                    host.manager
                        .news_for_catalog(&feed, &catalog, sequence.as_deref())
                {
                    return self.news_read(&feed, &seq, true);
                }
                return Ok(());
            }
            c @ (Command::FollowFeed { .. }
            | Command::ConfigureFeed { .. }
            | Command::UnfollowFeed { .. }
            | Command::RefreshFeed { .. }
            | Command::OpenCatalog { .. }
            | Command::DownloadEntry { .. }
            | Command::ApproveTransfer { .. }
            | Command::RevealEntry { .. }) => return self.feed_command(c),
            Command::InspectSource { .. }
            | Command::NewsPage { .. }
            | Command::CatalogPage { .. }
            | Command::ReadCatalogBody { .. } => {
                bail!("Read-only command dispatched incorrectly")
            }
            Command::AddMagnet { uri } => {
                self.add(normalize_magnet_input(&uri)?.into_bytes(), true)?
            }
            Command::AddTorrent { data } => self.add(data, false)?,
            Command::Pause { id } => {
                self.record(&id)?;
                if let Some(h) = &mut self.feeds {
                    h.manager.suppress(&id)?;
                }
                self.persist_feeds()?;
                self.record(&id)?;
                if !self.failures.contains_key(&id) {
                    self.native.pause(&id)?;
                }
                self.store
                    .records
                    .iter_mut()
                    .find(|r| r.id == id)
                    .unwrap()
                    .active = false;
                self.persist()?;
            }
            Command::Resume { id } => {
                let r = self.record(&id)?.clone();
                if r.held {
                    if !self.failures.contains_key(&id) {
                        bail!("Download requires approval; use Download once")
                    }
                    // Recover a failed native restore without granting payload
                    // permission. The held flag remains durable and enforced.
                    fs::create_dir_all(&r.path)?;
                    reject_symlinks(&r.path)?;
                    let bytes = read_limited(&self.dir.join(format!("{id}.source")))?;
                    self.native.stage(AddTransfer {
                        id: &id,
                        source: TorrentSource::from_bytes(&bytes, r.magnet)?,
                        save_path: r.path.to_str().context("Non-UTF-8 transfer path")?,
                        active: true,
                        restore: true,
                    })?;
                    self.failures.remove(&id);
                    self.store
                        .records
                        .iter_mut()
                        .find(|r| r.id == id)
                        .unwrap()
                        .active = true;
                    self.persist()?;
                    if let (Some(feed), Some(host)) = (&r.feed, &mut self.feeds) {
                        let now = host.now();
                        host.manager.refresh(feed, now)?;
                    }
                    self.persist_feeds()?;
                    return Ok(());
                };
                if let Some(h) = &mut self.feeds {
                    h.manager.approve_once(&id)?;
                }
                self.persist_feeds()?;
                if self.failures.contains_key(&id) {
                    reject_symlinks(&r.path)?;
                    let bytes = read_limited(&self.dir.join(format!("{id}.source")))?;
                    self.native.add(AddTransfer {
                        id: &id,
                        source: TorrentSource::from_bytes(&bytes, r.magnet)?,
                        save_path: r.path.to_str().context("Non-UTF-8 transfer path")?,
                        active: true,
                        restore: true,
                    })?;
                    self.failures.remove(&id);
                } else if r.seed
                    || !self.view.transfers.iter().any(|t| {
                        t.id == id
                            && t.progress == 1.0
                            && t.error.is_empty()
                            && t.files.iter().all(|f| f.ready)
                    })
                {
                    self.native.resume(&id)?;
                }
                self.store
                    .records
                    .iter_mut()
                    .find(|r| r.id == id)
                    .unwrap()
                    .active = true;
                self.persist()?;
            }
            Command::Remove { id, delete_files } => {
                self.record(&id)?;
                if let Some(h) = &mut self.feeds {
                    h.manager.suppress(&id)?;
                    h.manager.removed(&id);
                }
                self.persist_feeds()?;
                let record = self.record(&id)?.clone();
                if !self.failures.contains_key(&id) {
                    self.native.remove(&id)?;
                }
                self.store.records.retain(|r| r.id != id);
                self.persist()?;
                self.failures.remove(&id);
                for suffix in ["source", "resume", "info"] {
                    let path = self.dir.join(format!("{id}.{suffix}"));
                    if path.exists() {
                        fs::remove_file(path)?;
                    }
                }
                if delete_files && record.path.exists() {
                    if !valid_id(&id)
                        || record.path.file_name().and_then(|s| s.to_str()) != Some(&id)
                    {
                        bail!("Unsafe deletion path; files preserved");
                    }
                    reject_symlinks(&record.path)?;
                    fs::remove_dir_all(&record.path)
                        .context("Transfer removed, but downloaded files could not be deleted")?;
                }
            }
            Command::Reveal { id, file } => {
                let r = self.record(&id)?;
                let path = if let Some(index) = file {
                    let t = self
                        .view
                        .transfers
                        .iter()
                        .find(|t| t.id == id)
                        .context("Transfer unavailable")?;
                    let f = t.files.get(index).context("File not found")?;
                    if !f.ready {
                        bail!("File is not complete");
                    }
                    r.path.join(&f.name)
                } else {
                    r.path.clone()
                };
                let canonical = fs::canonicalize(&path)?;
                if !canonical.starts_with(fs::canonicalize(&r.path)?) {
                    bail!("Unsafe file path");
                }
                let status = std::process::Command::new("/usr/bin/open")
                    .arg("-R")
                    .arg(canonical)
                    .status()?;
                if !status.success() {
                    bail!("Finder could not reveal this file");
                }
            }
            Command::Configure { mut settings } => {
                settings.download_dir = directory_setting(&settings.download_dir)?;
                self.store.settings = settings;
                self.persist()?;
            }
        }
        Ok(())
    }
    fn refresh(&mut self) -> Result<()> {
        let native = self.native.snapshot()?;
        self.refresh_serial = self.refresh_serial.wrapping_add(1);
        let mut transfers = Vec::new();
        let mut changed = false;
        for record in &mut self.store.records {
            if let Some(t) = native.transfers.iter().find(|t| t.id == record.id) {
                if record.active && !t.error.is_empty() {
                    record.active = false;
                    changed = true;
                }
                // Completed is an enabled transfer with no network activity.
                // Quiesce libtorrent without changing the application's pause state.
                if record.active
                    && !record.held
                    && !record.seed
                    && t.finished
                    && t.state == "Seeding"
                {
                    self.native.pause(&record.id)?;
                }
            }
        }
        if changed {
            self.persist()?;
        }
        for r in &self.store.records {
            if let Some(n) = native.transfers.iter().find(|t| t.id == r.id) {
                let files = n
                    .files
                    .iter()
                    .map(|f| TorrentFile {
                        name: f.name.clone(),
                        length: f.length,
                        verified: f.verified,
                        ready: f.verified == f.length
                            && n.state != "Checking"
                            && n.state != "Error",
                    })
                    .collect();
                let feed_error = if r.held {
                    self.feeds
                        .as_ref()
                        .and_then(|h| h.manager.validation_error(&r.id))
                        .unwrap_or("")
                } else {
                    ""
                };
                transfers.push(Transfer {
                    id: r.id.clone(),
                    name: if n.name.is_empty() {
                        r.id.clone()
                    } else {
                        n.name.clone()
                    },
                    state: if !feed_error.is_empty() {
                        "Error".into()
                    } else if r.held
                        && r.active
                        && n.error.is_empty()
                        && !n.files.is_empty()
                        && n.state != "Checking"
                    {
                        "Awaiting approval".into()
                    } else if !r.active && n.error.is_empty() {
                        "Paused".into()
                    } else if r.active
                        && !r.seed
                        && n.finished
                        && n.state != "Checking"
                        && n.error.is_empty()
                    {
                        "Completed".into()
                    } else {
                        n.state.clone()
                    },
                    error: if feed_error.is_empty() {
                        n.error.clone()
                    } else {
                        feed_error.into()
                    },
                    warning: n.warning.clone(),
                    active: r.active,
                    verified: n.verified,
                    total: n.total,
                    progress: if n.total > 0 {
                        n.verified as f64 / n.total as f64
                    } else if n.finished {
                        1.0
                    } else {
                        0.0
                    },
                    down: n.down,
                    up: n.up,
                    peers: n.peers,
                    files,
                    save_path: r.path.display().to_string(),
                    held: r.held,
                    approval_size: if r.held {
                        self.feeds
                            .as_ref()
                            .and_then(|h| h.manager.approval_size(&r.id))
                    } else {
                        None
                    },
                    kind: r.kind.clone(),
                    feed: r.feed.clone(),
                });
            } else {
                transfers.push(Transfer {
                    id: r.id.clone(),
                    name: r.id.clone(),
                    state: "Error".into(),
                    error: self
                        .failures
                        .get(&r.id)
                        .cloned()
                        .unwrap_or_else(|| "Transfer unavailable".into()),
                    save_path: r.path.display().to_string(),
                    held: r.held,
                    kind: r.kind.clone(),
                    feed: r.feed.clone(),
                    ..Default::default()
                });
            }
        }
        self.view = Snapshot {
            engine: "libtorrent-rasterbar 2.1.2",
            transfers,
            settings: self.store.settings.clone(),
            dht_nodes: native.dht_nodes,
            listen_port: native.listen_port,
            warning: native.warning,
            publishing: self
                .publication_view
                .as_ref()
                .map(|v| v.borrow().clone())
                .unwrap_or_default(),
            ready: true,
            feeds: self
                .feeds
                .as_ref()
                .map(|h| h.manager.views())
                .unwrap_or_default(),
            feed_time_ms: self.feeds.as_ref().map_or(0, |h| h.now()),
            news_unread: self.feeds.as_ref().map_or(0, |h| h.manager.news_unread()),
            news_revision: self
                .feeds
                .as_ref()
                .map_or_else(String::new, |h| h.manager.news_revision()),
            feed_error: self
                .feeds
                .as_ref()
                .map(|h| h.error.clone())
                .unwrap_or_default(),
        };
        Ok(())
    }
    fn checkpoint(&mut self) -> Result<()> {
        self.persist()?;
        let feeds = self.persist_feeds();
        self.native.checkpoint()?;
        feeds?;
        Ok(())
    }
}
fn api_error(status: StatusCode, message: impl ToString) -> Response {
    (
        status,
        Json(serde_json::json!({"error":message.to_string()})),
    )
        .into_response()
}
async fn guard(State(app): State<Arc<App>>, request: Request<Body>, next: Next) -> Response {
    let h = request.headers();
    if h.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(app.host.as_str()) {
        return api_error(StatusCode::FORBIDDEN, "Invalid Host");
    }
    if h.get(header::ORIGIN)
        .is_some_and(|v| v.to_str().ok() != Some(app.origin.as_str()))
    {
        return api_error(StatusCode::FORBIDDEN, "Invalid Origin");
    }
    let api = request.uri().path().starts_with("/api/");
    if api {
        let expected = format!("ft_session={}", app.token);
        let cookie = h
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !cookie.split(';').any(|s| s.trim() == expected) {
            return api_error(
                StatusCode::UNAUTHORIZED,
                "Open FeedTorrent in this browser first",
            );
        }
        if request.method() != axum::http::Method::GET
            && h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(app.origin.as_str())
        {
            return api_error(StatusCode::FORBIDDEN, "Origin required");
        }
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn index(State(app): State<Arc<App>>) -> Response {
    let mut response = (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../../web/dist/index.html"),
    )
        .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "ft_session={}; HttpOnly; SameSite=Strict; Path=/",
            app.token
        )
        .parse()
        .unwrap(),
    );
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'".parse().unwrap());
    response
}
async fn snapshot(State(app): State<Arc<App>>) -> Json<Snapshot> {
    Json(app.view.borrow().clone())
}
async fn events(State(app): State<Arc<App>>) -> impl IntoResponse {
    let mut rx = app.view.clone();
    let stream = async_stream::stream! {
        loop {
            let value={ rx.borrow_and_update().clone() };
            yield Ok::<_,Infallible>(Event::default().event("snapshot").json_data(value).unwrap());
            if rx.changed().await.is_err() {break;}
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}
async fn command(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    payload: std::result::Result<Json<Command>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| !v.starts_with("application/json"))
    {
        return api_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let command = match payload {
        Ok(Json(c)) => c,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e.body_text()),
    };
    if let Command::InspectSource { uri } = &command {
        if let Ok(key) = feedtorrent_bep::bep46::parse_magnet(uri) {
            return Json(serde_json::json!({"ok":true,"kind":"feed","magnet":feedtorrent_bep::bep46::format_magnet(&key),"id":feedtorrent_feeds::hex(&key.target())})).into_response();
        }
        return match normalize_magnet_input(uri) {
            Ok(uri) => {
                Json(serde_json::json!({"ok":true,"kind":"torrent","uri":uri})).into_response()
            }
            Err(e) => api_error(StatusCode::BAD_REQUEST, e),
        };
    }
    let read_body = matches!(&command, Command::ReadCatalogBody { .. });
    let (tx, rx) = oneshot::channel();
    if app.jobs.try_send(Job { command, reply: tx }).is_err() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Engine busy or stopped; retry shortly",
        );
    }
    match rx.await {
        Ok(Ok(result)) => {
            if read_body {
                let Some(path) = result.get("path").and_then(|p| p.as_str()) else {
                    return Json(serde_json::json!({"body":null})).into_response();
                };
                return match app.publishing.read_body(PathBuf::from(path)).await {
                    Ok(v) => Json(v).into_response(),
                    Err(e) => api_error(StatusCode::BAD_REQUEST, e),
                };
            }
            Json(result).into_response()
        }
        Ok(Err(e)) => api_error(StatusCode::BAD_REQUEST, e),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Engine stopped"),
    }
}
async fn asset(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let (content_type, bytes): (&str, &[u8]) = match name.as_str() {
        "main.js" => ("text/javascript", include_bytes!("../../web/dist/main.js")),
        "publishing.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/publishing.js"),
        ),
        "markdown.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/markdown.js"),
        ),
        "feeds.js" => ("text/javascript", include_bytes!("../../web/dist/feeds.js")),
        "news.js" => ("text/javascript", include_bytes!("../../web/dist/news.js")),
        "library.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/library.js"),
        ),
        "types.js" => ("text/javascript", include_bytes!("../../web/dist/types.js")),
        "app.css" => ("text/css", include_bytes!("../../web/dist/app.css")),
        "basecoat.css" => ("text/css", include_bytes!("../../web/dist/basecoat.css")),
        "basecoat-runtime.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/basecoat-runtime.js"),
        ),
        "basecoat-tabs.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/basecoat-tabs.js"),
        ),
        "basecoat-sidebar.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/basecoat-sidebar.js"),
        ),
        "theme.js" => ("text/javascript", include_bytes!("../../web/dist/theme.js")),
        "lucide.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/lucide.js"),
        ),
        "BASECOAT-LICENSE.md" => (
            "text/plain",
            include_bytes!("../../web/vendor/BASECOAT-LICENSE.md"),
        ),
        "LUCIDE-LICENSE" => (
            "text/plain",
            include_bytes!("../../web/vendor/LUCIDE-LICENSE"),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let home = PathBuf::from(std::env::var_os("HOME").context("HOME is unset")?);
    let dir = ensure_directory(
        &args
            .data_dir
            .clone()
            .unwrap_or_else(|| home.join("Library/Application Support/FeedTorrent")),
    )?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("instance.lock"))?;
    lock.try_lock()
        .context("FeedTorrent is already running with this data directory")?;
    let registry = dir.join("transfers.json");
    let mut store = if registry.exists() {
        serde_json::from_slice::<Store>(&read_limited(&registry)?)
            .context("Cannot read transfer registry; original data was preserved")?
    } else {
        default_store()
    };
    migrate_store(&mut store, &home)?;
    if let Some(path) = &args.download_dir {
        store.settings.download_dir =
            directory_setting(path.to_str().context("Non-UTF-8 download directory")?)?;
    }
    if let Some(port) = args.peer_port {
        store.settings.peer_port = port;
    }
    ensure_directory(Path::new(&store.settings.download_dir))?;
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, args.http_port)).await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let first = Snapshot {
        engine: "libtorrent-rasterbar 2.1.2",
        transfers: vec![],
        settings: store.settings.clone(),
        dht_nodes: 0,
        listen_port: 0,
        warning: String::new(),
        ready: false,
        feeds: vec![],
        feed_error: String::new(),
        feed_time_ms: 0,
        news_unread: 0,
        news_revision: String::new(),
        publishing: publishing::View::default(),
    };
    let (publication_tx, publication_rx) = mpsc::sync_channel(16);
    let (publishing, publishing_thread) = publishing::start(&dir, publication_tx)?;
    let publication_view = publishing.view.clone();
    let (views, view) = watch::channel(first);
    let (jobs, receiver) = mpsc::sync_channel::<Job>(32);
    let (init_tx, init_rx) = oneshot::channel();
    let (stop, stopping) = mpsc::channel();
    let thread = std::thread::spawn(move || -> Result<()> {
        let mut engine = match Engine::new(&args, dir, store) {
            Ok(e) => e,
            Err(e) => {
                let _ = init_tx.send(Err(format!("{e:#}")));
                return Err(e);
            }
        };
        engine.publication_native = Some(publishing::Bridge::new(publication_rx));
        engine.publication_view = Some(publication_view);
        engine.refresh()?;
        views.send_replace(engine.view.clone());
        let _ = init_tx.send(Ok(()));
        let mut checkpoint = Instant::now();
        let mut refresh = Instant::now();
        loop {
            if stopping.try_recv().is_ok() {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(job) => {
                    let result = match job.command {
                        Command::NewsPage{offset,anchor}=>engine.feeds.as_ref().context("Feed service unavailable").and_then(|h|h.manager.news_page(offset,anchor.as_deref()).map_err(Into::into)).and_then(|p|serde_json::to_value(p).map_err(Into::into)),
                        Command::ReadCatalogBody{feed,catalog}=>engine.catalog_body(&feed,&catalog).map(|p|serde_json::json!({"path":p})),
                        Command::CatalogPage{feed,catalog,offset}=>engine.feeds.as_ref().context("Feed service unavailable").and_then(|h|h.manager.page(&feed,&catalog,offset).map_err(Into::into)).map(|p|serde_json::json!({"catalog":p.catalog,"entries":p.entries,"offset":p.offset,"total":p.total})),
                        c=>engine.apply(c).map(|()|serde_json::json!({"ok":true})),
                    }.map_err(|e|format!("{e:#}"));
                    if let Err(e) = engine.refresh() {
                        engine.view.warning = format!("Engine: {e:#}");
                    }
                    views.send_replace(engine.view.clone());
                    let _ = job.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(mut bridge) = engine.publication_native.take() {
                bridge.tick(&mut engine);
                engine.publication_native = Some(bridge);
            }
            engine.feed_tick();
            if refresh.elapsed() >= Duration::from_secs(1) {
                if let Err(e) = engine.refresh() {
                    engine.view.warning = format!("Engine: {e:#}");
                }
                views.send_replace(engine.view.clone());
                refresh = Instant::now();
            }
            if checkpoint.elapsed() >= Duration::from_secs(30) {
                if let Err(e) = engine.checkpoint() {
                    engine.view.warning = format!("Persistence: {e:#}");
                    views.send_replace(engine.view.clone());
                }
                checkpoint = Instant::now();
            }
        }
        engine.persist()?;
        let feed_result = engine.persist_feeds();
        if let Some(host) = &mut engine.feeds {
            host.close();
        }
        engine.native.shutdown()?;
        feed_result?;
        Ok(())
    });
    init_rx.await?.map_err(anyhow::Error::msg)?;
    let mut token = [0_u8; 32];
    getrandom::fill(&mut token).map_err(|e| anyhow!("Cannot create session token: {e}"))?;
    let token = token.iter().map(|b| format!("{b:02x}")).collect();
    let app = Arc::new(App {
        publishing: publishing.clone(),
        jobs,
        view,
        origin: origin.clone(),
        host: address.to_string(),
        token,
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/{name}", get(asset))
        .route("/api/snapshot", get(snapshot))
        .route("/api/events", get(events))
        .route("/api/commands", post(command))
        .route("/api/publishing", post(publishing::http::command))
        .route("/api/publishing/backup", get(publishing::http::export))
        .route(
            "/api/publishing/import",
            post(publishing::http::import).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app);
    println!("FeedTorrent {origin}/");
    if !Args::parse().no_open {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(format!("{origin}/"))
            .spawn();
    }
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("signal handler");
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            let _ = stop.send(());
        })
        .await?;
    publishing.stop();
    thread
        .join()
        .map_err(|_| anyhow!("Engine thread panicked"))??;
    publishing_thread
        .join()
        .map_err(|_| anyhow!("Publishing worker panicked"))?;
    drop(lock);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_and_one_time_registry_migration() {
        let home = Path::new("/fixture-home");
        let mut store = default_store();
        assert_eq!(store.version, 3);
        assert_eq!(store.settings.download_dir, "downloads");
        assert!(store.settings.seed_by_default);
        let legacy: Settings =
            serde_json::from_str(r#"{"download_dir":"downloads","peer_port":6881}"#).unwrap();
        assert!(legacy.seed_by_default);
        store.version = 1;
        store.settings.download_dir = home.join("Downloads/FeedTorrent").display().to_string();
        store.records.push(Record {
            id: "1".repeat(40),
            magnet: true,
            path: PathBuf::from("/existing/payload"),
            active: false,
            seed: true,
            held: false,
            kind: String::new(),
            feed: None,
        });
        migrate_store(&mut store, home).unwrap();
        assert_eq!(store.settings.download_dir, "downloads");
        assert_eq!(store.records[0].path, Path::new("/existing/payload"));
        store.settings.download_dir = home.join("Downloads/FeedTorrent").display().to_string();
        migrate_store(&mut store, home).unwrap();
        assert!(store
            .settings
            .download_dir
            .ends_with("Downloads/FeedTorrent"));
        store.version = 1;
        store.settings.download_dir = "/custom".into();
        migrate_store(&mut store, home).unwrap();
        assert_eq!(store.settings.download_dir, "/custom");
        store.version = 99;
        assert!(migrate_store(&mut store, home).is_err());
    }
    #[test]
    fn identifiers_and_commands_are_strict() {
        assert!(valid_id("56f31e2d486209003454e245d11561cd252be30f"));
        assert!(!valid_id("../../x"));
        let legacy: Record =
            serde_json::from_str(r#"{"id":"x","magnet":true,"path":"/legacy","active":true}"#)
                .unwrap();
        assert!(legacy.seed);
        assert!(serde_json::from_str::<Command>(r#"{"type":"remove","id":"x"}"#).is_ok());
        assert!(
            serde_json::from_str::<Command>(r#"{"type":"remove","id":"x","path":"/tmp"}"#).is_err()
        );
    }
}
