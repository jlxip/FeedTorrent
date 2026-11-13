mod content;
mod creation;
mod desktop;
mod images;
mod lifecycle;
mod local_http;
mod organization;
mod post_state;
mod posts;
mod publishing;
mod publishing_keys;
mod storage;
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
    io::{BufReader, Write},
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
    /// Web port (8790-8792); defaults to the first available port.
    #[arg(long)]
    http_port: Option<u16>,
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
    #[serde(alias = "feed")]
    post: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Store {
    version: u32,
    settings: Settings,
    records: Vec<Record>,
    #[serde(default)]
    image_preferences: images::Preferences,
    #[serde(default)]
    retention: lifecycle::Graph,
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
    post: Option<String>,
    pinned: bool,
    protected_by: Vec<String>,
    used_by: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
struct Snapshot {
    engine: &'static str,
    image_preferences: images::Preferences,
    transfers: Vec<Transfer>,
    settings: Settings,
    dht_nodes: u32,
    listen_port: u16,
    warning: String,
    ready: bool,
    posts: Vec<feedtorrent_posts::PostView>,
    post_error: String,
    post_time_ms: u64,
    news_unread: usize,
    news_revision: String,
    publishing: publishing::View,
    organization: organization::View,
    cleanup: Vec<lifecycle::Cleanup>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    #[serde(skip)]
    AdoptCreated {
        data: Vec<u8>,
        stage: PathBuf,
        external: String,
    },
    PreviewRemoval {
        target: lifecycle::Target,
    },
    DeletePost {
        post_kind: String,
        id: String,
        revision: String,
    },
    SetPin {
        id: String,
        pinned: bool,
        revision: Option<String>,
    },
    RetryCleanup {
        id: u64,
    },
    #[serde(skip)]
    BeginPostDelete {
        target: lifecycle::Target,
        revision: String,
    },
    #[serde(skip)]
    FinishPostDelete {
        job: u64,
    },
    #[serde(skip)]
    AbortPostDelete {
        job: u64,
    },
    #[serde(skip)]
    FailCleanup {
        job: u64,
        error: String,
    },
    OrganizePost {
        revision: String,
        key: String,
        action: String,
        parent: Option<String>,
        before: Option<String>,
    },
    NewsPage {
        #[serde(default)]
        offset: usize,
        anchor: Option<String>,
    },
    SetUpdateRead {
        #[serde(alias = "feed")]
        post: String,
        sequence: String,
        read: bool,
    },
    MarkCatalogRead {
        #[serde(alias = "feed")]
        post: String,
        catalog: String,
        sequence: Option<String>,
    },
    ReadCatalogBody {
        #[serde(alias = "feed")]
        post: String,
        catalog: String,
    },
    ReadContent {
        id: String,
        parent: Option<String>,
        #[serde(default)]
        offset: usize,
    },
    #[serde(skip)]
    ReadImage {
        id: String,
        path: String,
    },
    SetImagePreferences {
        update: images::Update,
    },
    InspectSource {
        uri: String,
    },
    FollowPost {
        uri: String,
        config: feedtorrent_posts::Config,
    },
    ConfigurePost {
        id: String,
        config: feedtorrent_posts::Config,
    },

    RefreshPost {
        id: String,
    },
    OpenCatalog {
        #[serde(alias = "feed")]
        post: String,
        id: String,
    },
    DownloadEntry {
        #[serde(alias = "feed")]
        post: String,
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
        #[serde(alias = "feed")]
        post: String,
        catalog: String,
        #[serde(default)]
        offset: usize,
    },
    AddMagnet {
        uri: String,
        origin: Option<lifecycle::SourceOrigin>,
    },
    AddTorrent {
        data: Vec<u8>,
        origin: Option<lifecycle::SourceOrigin>,
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
        revision: Option<String>,
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
    creation: Arc<creation::Service>,
    publishing: publishing::Client,
    jobs: mpsc::SyncSender<Job>,
    view: watch::Receiver<Snapshot>,
    origin: String,
    host: String,
    token: String,
    session_cookie: String,
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
        version: 4,
        settings: Settings {
            download_dir: "user/downloads".into(),
            peer_port: 6881,
            seed_by_default: true,
        },
        records: vec![],
        image_preferences: images::Preferences::default(),
        retention: lifecycle::Graph::default(),
    }
}
fn migrate_store(store: &mut Store, home: &Path) -> Result<()> {
    match store.version {
        1 => {
            if Path::new(&store.settings.download_dir) == home.join("Downloads/FeedTorrent") {
                store.settings.download_dir = "user/downloads".into();
            }
            store.version = 2;
        }
        2..=4 => {}
        _ => bail!("Unsupported transfer registry version; data preserved"),
    }
    store.version = 4;
    store.retention.validate()?;
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
struct Engine {
    refresh_serial: u64,
    organization: organization::Organization,
    organization_error: String,
    retention_recovery: std::collections::BTreeSet<u64>,
    native: LibtorrentBackend,
    publication_native: Option<publishing::Bridge>,
    publication_view: Option<watch::Receiver<publishing::View>>,
    posts: Option<posts::PostHost>,
    store: Store,
    dir: PathBuf,
    failures: BTreeMap<String, String>,
    storage_warning: String,
    view: Snapshot,
}
impl Engine {
    fn persist(&self) -> Result<()> {
        atomic(
            &self.dir.join("transfers.json"),
            &serde_json::to_vec_pretty(&self.store)?,
        )
        .context("Cannot save transfer registry")?;
        for record in &self.store.records {
            storage::write_manifest(record, self.store.retention.pins.contains(&record.id))?;
        }
        Ok(())
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
            image_preferences: store.image_preferences.clone(),
            dht_nodes: 0,
            listen_port: 0,
            warning: String::new(),
            ready: false,
            posts: vec![],
            post_error: String::new(),
            post_time_ms: 0,
            news_unread: 0,
            news_revision: String::new(),
            publishing: publishing::View::default(),
            organization: organization::View::default(),
            cleanup: vec![],
        };
        let mut e = Self {
            refresh_serial: 0,
            retention_recovery: store.retention.jobs.keys().copied().collect(),
            organization: organization::Organization::load(&dir)?,
            organization_error: String::new(),
            native,
            publication_native: None,
            publication_view: None,
            posts: Some(posts::PostHost::new(&dir, args.isolated)),
            store,
            dir,
            failures: BTreeMap::new(),
            storage_warning: String::new(),
            view,
        };
        let mut found = BTreeMap::<String, storage::Discovered>::new();
        let mut duplicate = std::collections::BTreeSet::new();
        let mut warnings = vec![];
        let empty_registry = e.store.records.is_empty() && !e.store.retention.initialized;
        let mut restored = 0;
        for root in [
            PathBuf::from(&e.store.settings.download_dir),
            storage::published(&e.dir),
        ] {
            match storage::discover(&root) {
                Ok((records, errors)) => {
                    warnings.extend(errors);
                    for discovered in records {
                        let id = discovered.record.id.clone();
                        if found.insert(id.clone(), discovered).is_some() {
                            duplicate.insert(id);
                        }
                    }
                }
                Err(error) => warnings.push(format!("{}: {error:#}", root.display())),
            }
        }
        for id in duplicate {
            found.remove(&id);
            warnings.push(format!(
                "Torrent {id} exists in both roots; files preserved"
            ));
        }
        for (id, discovered) in found {
            let record = discovered.record;
            let source = storage::sidecar(&record, "source")?;
            let valid = read_limited(&source).and_then(|bytes| {
                Ok(e.native
                    .inspect(TorrentSource::from_bytes(&bytes, record.magnet)?)?
                    == id)
            });
            if !matches!(valid, Ok(true)) {
                warnings.push(format!("Torrent {id} has invalid source; files preserved"));
                continue;
            }
            if let Some(existing) = e.store.records.iter_mut().find(|r| r.id == id) {
                if existing.path != record.path {
                    if existing.path.exists() {
                        warnings.push(format!(
                            "Torrent {id} conflicts with the registry; files preserved"
                        ));
                    } else {
                        *existing = record;
                    }
                }
            } else {
                e.store.retention.register_asset(&id)?;
                if discovered.pinned {
                    e.store.retention.pin(&id)?;
                }
                e.store.records.push(record);
                restored += 1;
            }
        }
        if empty_registry && restored > 0 {
            // The manifests state which torrents were explicitly pinned. The
            // legacy first-run fallback must not turn restored owned files into
            // permanent Pins when publishing.json is restored later.
            e.store.retention.initialized = true;
        }
        e.storage_warning = warnings.join("; ");
        for record in e.store.records.clone() {
            let outcome = (|| -> Result<()> {
                if !valid_id(&record.id)
                    || record.path.file_name().and_then(|s| s.to_str()) != Some(record.id.as_str())
                {
                    bail!("Invalid stored transfer path");
                }
                fs::create_dir_all(&record.path)?;
                reject_symlinks(&record.path)?;
                let bytes = read_limited(&storage::sidecar(&record, "source")?)?;
                let transfer = AddTransfer {
                    id: &record.id,
                    source: TorrentSource::from_bytes(&bytes, record.magnet)?,
                    save_path: record.path.to_str().context("Non-UTF-8 transfer path")?,
                    active: record.active
                        && !e
                            .store
                            .retention
                            .jobs
                            .values()
                            .any(|j| e.store.retention.may_delete(j.id, &record.id)),
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
        if let Err(error) = e.persist_posts() {
            if let Some(host) = &mut e.posts {
                host.error = format!("Post persistence: {error:#}");
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
        self.reserve_source(bytes, magnet, None, "", false, false)
            .map(|_| ())
    }
    fn apply(&mut self, command: Command) -> Result<()> {
        match command {
            Command::AdoptCreated {
                data,
                stage,
                external,
            } => {
                let id = self.native.inspect(TorrentSource::Torrent(&data))?;
                if self.store.records.iter().any(|r| r.id == id) {
                    bail!("This torrent is already in Library; existing files preserved");
                }
                let root = ensure_directory(Path::new(&self.store.settings.download_dir))?;
                let target = root.join(&id);
                if fs::canonicalize(stage.parent().context("Missing creation directory")?)? != root
                    || !stage
                        .file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.starts_with(".create-"))
                {
                    bail!("Creation location changed; retry");
                }
                reject_symlinks(&stage)?;
                if target.exists() || root.join(format!("{id}.source")).exists() {
                    bail!("Torrent destination exists; files preserved");
                }
                let before = self.store.clone();
                fs::rename(&stage, &target)?;
                let _ = fs::remove_file(target.join(".creation-owner"));
                let result = (|| -> Result<()> {
                    if !external.is_empty() {
                        publishing::save(
                            &root.join(format!("{id}.external")),
                            external.as_bytes(),
                        )?;
                    }
                    self.reserve_source(data, false, None, "content", false, false)?;
                    let r = self
                        .store
                        .records
                        .iter_mut()
                        .find(|r| r.id == id)
                        .context("Created torrent unavailable")?;
                    r.seed = true;
                    r.active = true;
                    self.persist()?;
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = self.native.remove(&id);
                    let _ = fs::remove_dir_all(&target);
                    for suffix in ["source", "resume", "info", "transfer.json", "external"] {
                        let _ = fs::remove_file(root.join(format!("{id}.{suffix}")));
                    }
                    self.store = before;
                    self.failures.remove(&id);
                    self.persist()?;
                    return Err(error);
                }
            }
            Command::OrganizePost {
                revision,
                key,
                action,
                parent,
                before,
            } => {
                self.sync_organization()?;
                self.organization
                    .change(&self.dir, &revision, &key, &action, parent, before)?;
            }
            Command::SetUpdateRead {
                post,
                sequence,
                read,
            } => return self.news_read(&post, &sequence, read),
            Command::MarkCatalogRead {
                post,
                catalog,
                sequence,
            } => {
                let host = self.posts.as_ref().context("Post service unavailable")?;
                if !host.manager.page(&post, &catalog, 0)?.catalog.ready {
                    bail!("Catalog has not been verified")
                }
                if let Some(seq) =
                    host.manager
                        .news_for_catalog(&post, &catalog, sequence.as_deref())
                {
                    return self.news_read(&post, &seq, true);
                }
                return Ok(());
            }
            c @ (Command::FollowPost { .. }
            | Command::ConfigurePost { .. }
            | Command::RefreshPost { .. }
            | Command::OpenCatalog { .. }
            | Command::DownloadEntry { .. }
            | Command::ApproveTransfer { .. }
            | Command::RevealEntry { .. }) => return self.post_command(c),
            Command::PreviewRemoval { .. }
            | Command::DeletePost { .. }
            | Command::SetPin { .. }
            | Command::BeginPostDelete { .. }
            | Command::FinishPostDelete { .. }
            | Command::AbortPostDelete { .. }
            | Command::FailCleanup { .. } => bail!("Lifecycle command dispatched incorrectly"),
            Command::InspectSource { .. }
            | Command::NewsPage { .. }
            | Command::CatalogPage { .. }
            | Command::ReadContent { .. }
            | Command::ReadCatalogBody { .. } => {
                bail!("Read-only command dispatched incorrectly")
            }
            Command::AddMagnet { uri, origin } => {
                let bytes = normalize_magnet_input(&uri)?.into_bytes();
                if origin.is_none() {
                    self.add(bytes, true)?;
                } else {
                    self.reserve_source(bytes, true, origin, "content", false, false)?;
                }
            }
            Command::AddTorrent { data, origin } => {
                if origin.is_none() {
                    self.add(data, false)?;
                } else {
                    self.reserve_source(data, false, origin, "content", false, false)?;
                }
            }
            Command::Pause { id } => {
                self.record(&id)?;
                if let Some(h) = &mut self.posts {
                    h.manager.suppress(&id)?;
                }
                self.persist_posts()?;
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
                    let bytes = read_limited(&storage::sidecar(&r, "source")?)?;
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
                    if let (Some(post), Some(host)) = (&r.post, &mut self.posts) {
                        let now = host.now();
                        host.manager.refresh(post, now)?;
                    }
                    self.persist_posts()?;
                    return Ok(());
                };
                if let Some(h) = &mut self.posts {
                    h.manager.approve_once(&id)?;
                }
                self.persist_posts()?;
                if self.failures.contains_key(&id) {
                    reject_symlinks(&r.path)?;
                    let bytes = read_limited(&storage::sidecar(&r, "source")?)?;
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
            Command::Remove {
                id,
                delete_files,
                revision,
            } => return self.remove_transfer(&id, delete_files, revision.as_deref()),
            Command::RetryCleanup { id } => return self.retry_cleanup(id),
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
                    self.verified_path(&id, &f.name)?
                } else {
                    let external = publishing::files::external(&r.path)?;
                    external
                        .values()
                        .next()
                        .and_then(|p| p.parent())
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| r.path.clone())
                };
                let canonical = fs::canonicalize(path)?;
                desktop::reveal(&canonical)?;
            }
            Command::ReadImage { .. } => bail!("Read-only command dispatched incorrectly"),
            Command::SetImagePreferences { update } => {
                let previous = self.store.image_preferences.clone();
                self.store.image_preferences.update(update)?;
                if let Err(error) = self.persist() {
                    self.store.image_preferences = previous;
                    return Err(error);
                }
            }
            Command::Configure { mut settings } => {
                settings.download_dir = directory_setting(&settings.download_dir)?;
                if fs::canonicalize(&settings.download_dir)?
                    == fs::canonicalize(storage::published(&self.dir))?
                {
                    bail!("Downloads and published must be different directories")
                }
                self.store.settings = settings;
                self.persist()?;
            }
        }
        Ok(())
    }
    fn sync_organization(&mut self) -> Result<()> {
        let Some(publication) = &self.publication_view else {
            return Ok(());
        };
        let publication = publication.borrow();
        if !publication.error.is_empty() {
            bail!("{}", publication.error);
        }
        if self.posts.as_ref().is_none_or(|h| !h.available()) {
            bail!("Post state unavailable; organization preserved");
        }
        let mut input: Vec<_> = self
            .posts
            .as_ref()
            .map(|h| h.manager.views())
            .unwrap_or_default()
            .iter()
            .map(|f| organization::Input {
                key: format!("followed:{}", f.id),
                stamp: f.head.clone().unwrap_or_default(),
                changed_at: organization::now_us(),
            })
            .collect();
        input.extend(publication.posts.iter().map(|f| organization::Input {
            key: format!("own:{}", f.id),
            stamp: format!("{}:{}", f.revision, f.changed_at_us),
            changed_at: f.changed_at_us,
        }));
        self.organization.sync(&self.dir, input)
    }
    fn refresh(&mut self) -> Result<()> {
        self.sync_retention()?;
        self.organization_error = self
            .sync_organization()
            .err()
            .map(|e| format!("Post organization: {e:#}"))
            .unwrap_or_default();
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
                let post_error = if r.held {
                    self.posts
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
                    state: if !post_error.is_empty() {
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
                    error: if post_error.is_empty() {
                        n.error.clone()
                    } else {
                        post_error.into()
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
                        self.posts
                            .as_ref()
                            .and_then(|h| h.manager.approval_size(&r.id))
                    } else {
                        None
                    },
                    kind: r.kind.clone(),
                    post: r.post.clone(),
                    pinned: self.store.retention.pins.contains(&r.id),
                    protected_by: self.store.retention.protected_by(&r.id),
                    used_by: self.store.retention.used_by(&r.id),
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
                    post: r.post.clone(),
                    pinned: self.store.retention.pins.contains(&r.id),
                    protected_by: self.store.retention.protected_by(&r.id),
                    used_by: self.store.retention.used_by(&r.id),
                    ..Default::default()
                });
            }
        }
        self.view = Snapshot {
            engine: "libtorrent-rasterbar 2.1.2",
            transfers,
            settings: self.store.settings.clone(),
            image_preferences: self.store.image_preferences.clone(),
            dht_nodes: native.dht_nodes,
            listen_port: native.listen_port,
            warning: [native.warning, self.storage_warning.clone()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("; "),
            publishing: self
                .publication_view
                .as_ref()
                .map(|v| v.borrow().clone())
                .unwrap_or_default(),
            ready: true,
            posts: self
                .posts
                .as_ref()
                .map(|h| h.manager.views())
                .unwrap_or_default(),
            organization: self.organization.view(self.organization_error.clone()),
            cleanup: self.store.retention.jobs.values().cloned().collect(),
            post_time_ms: self.posts.as_ref().map_or(0, |h| h.now()),
            news_unread: self.posts.as_ref().map_or(0, |h| h.manager.news_unread()),
            news_revision: self
                .posts
                .as_ref()
                .map_or_else(String::new, |h| h.manager.news_revision()),
            post_error: self
                .posts
                .as_ref()
                .map(|h| h.error.clone())
                .unwrap_or_default(),
        };
        Ok(())
    }
    fn checkpoint(&mut self) -> Result<()> {
        self.persist()?;
        let posts = self.persist_posts();
        self.native.checkpoint()?;
        posts?;
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
        let expected = format!("{}={}", app.session_cookie, app.token);
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
            "{}={}; HttpOnly; SameSite=Strict; Path=/",
            app.session_cookie, app.token
        )
        .parse()
        .unwrap(),
    );
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'".parse().unwrap());
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
async fn engine_call(
    app: &App,
    command: Command,
) -> std::result::Result<serde_json::Value, String> {
    let (tx, rx) = oneshot::channel();
    app.jobs
        .try_send(Job { command, reply: tx })
        .map_err(|_| "Engine busy or stopped".to_string())?;
    rx.await.map_err(|_| "Engine stopped".to_string())?
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
        Err(e) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!(
                    "Reload FeedTorrent to update this client: {}",
                    e.body_text()
                ),
            )
        }
    };
    if let Command::InspectSource { uri } = &command {
        if let Ok(key) = feedtorrent_bep::bep46::parse_magnet(uri) {
            return Json(serde_json::json!({"ok":true,"kind":"post","magnet":feedtorrent_bep::bep46::format_magnet(&key),"id":feedtorrent_posts::hex(&key.target())})).into_response();
        }
    }
    if let Command::DeletePost {
        post_kind,
        id,
        revision,
    } = &command
    {
        let target = lifecycle::Target::Post {
            post_kind: post_kind.clone(),
            id: id.clone(),
        };
        let begun = match engine_call(
            &app,
            Command::BeginPostDelete {
                target,
                revision: revision.clone(),
            },
        )
        .await
        {
            Ok(v) => v,
            Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
        };
        let job = begun["job"].as_u64().unwrap();
        if post_kind == "own" {
            if let Err(error) = app
                .publishing
                .call(publishing::Command::RemovePost { id: id.clone() })
                .await
            {
                let _ = engine_call(&app, Command::AbortPostDelete { job }).await;
                return api_error(StatusCode::BAD_REQUEST, error);
            }
        }
        return match engine_call(&app, Command::FinishPostDelete { job }).await {
            Ok(value) => Json(value).into_response(),
            Err(error) => {
                let _ = engine_call(
                    &app,
                    Command::FailCleanup {
                        job,
                        error: error.clone(),
                    },
                )
                .await;
                api_error(StatusCode::BAD_REQUEST, error)
            }
        };
    }
    if let Command::RetryCleanup { id } = &command {
        let job = app
            .view
            .borrow()
            .cleanup
            .iter()
            .find(|j| j.id == *id)
            .cloned();
        if let Some(job) = job {
            if !job.detached {
                if let lifecycle::Target::Post { post_kind, id } = &job.target {
                    if post_kind == "own"
                        && app
                            .publishing
                            .view
                            .borrow()
                            .posts
                            .iter()
                            .any(|p| &p.id == id)
                    {
                        if let Err(error) = app
                            .publishing
                            .call(publishing::Command::RemovePost { id: id.clone() })
                            .await
                        {
                            return api_error(StatusCode::BAD_REQUEST, error);
                        }
                    }
                }
            }
        }
    }
    let read_body = matches!(&command, Command::ReadCatalogBody { .. });
    let read_content = matches!(&command, Command::ReadContent { .. });
    let (tx, rx) = oneshot::channel();
    if app.jobs.try_send(Job { command, reply: tx }).is_err() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Engine busy or stopped; retry shortly",
        );
    }
    match rx.await {
        Ok(Ok(mut result)) => {
            if read_content {
                let path = result
                    .as_object_mut()
                    .and_then(|v| v.remove("body_path"))
                    .and_then(|v| v.as_str().map(PathBuf::from));
                if let Some(path) = path {
                    match app.publishing.read_body(path).await {
                        Ok(body) => result["body"] = body["body"].clone(),
                        Err(error) => {
                            result["body_state"] = serde_json::json!("error");
                            result["body_error"] = serde_json::json!(error);
                        }
                    }
                }
                return Json(result).into_response();
            }
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
        "creation.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/creation.js"),
        ),
        "main.js" => ("text/javascript", include_bytes!("../../web/dist/main.js")),
        "publishing.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/publishing.js"),
        ),
        "images.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/images.js"),
        ),
        "markdown.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/markdown.js"),
        ),
        "organization.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/organization.js"),
        ),
        "posts.js" => ("text/javascript", include_bytes!("../../web/dist/posts.js")),
        "news.js" => ("text/javascript", include_bytes!("../../web/dist/news.js")),
        "library.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/library.js"),
        ),
        "content.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/content.js"),
        ),
        "reader.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/reader.js"),
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
        "basecoat-dropdown-menu.js" => (
            "text/javascript",
            include_bytes!("../../web/dist/basecoat-dropdown-menu.js"),
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
    let http_ports = local_http::ports(args.http_port, args.isolated)?;
    let home = PathBuf::from(std::env::var_os("HOME").context("HOME is unset")?);
    let dir = match args.data_dir.as_deref() {
        Some(path) => ensure_directory(path)?,
        None => ensure_directory(&std::env::current_dir()?.join("user"))?,
    };
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
        // Registry writes are unbounded. Decode incrementally so a growing
        // library remains restartable without buffering the whole file too.
        serde_json::from_reader::<_, Store>(BufReader::new(File::open(&registry)?))
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
    let downloads = ensure_directory(Path::new(&store.settings.download_dir))?;
    let published = ensure_directory(&storage::published(&dir))?;
    if downloads == published {
        bail!("Downloads and published must be different directories")
    }
    let listener = local_http::bind(&http_ports).await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let first = Snapshot {
        engine: "libtorrent-rasterbar 2.1.2",
        transfers: vec![],
        settings: store.settings.clone(),
        image_preferences: store.image_preferences.clone(),
        dht_nodes: 0,
        listen_port: 0,
        warning: String::new(),
        ready: false,
        posts: vec![],
        post_error: String::new(),
        post_time_ms: 0,
        news_unread: 0,
        news_revision: String::new(),
        publishing: publishing::View::default(),
        organization: organization::View::default(),
        cleanup: vec![],
    };
    creation::cleanup_staging(&downloads, &dir)?;
    creation::cleanup_staging(&published, &dir)?;
    let creation = creation::Service::new(&dir)?;
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
                        Command::ReadImage{id,path}=>engine.image_source(&id,&path),
                        Command::InspectSource{uri}=>normalize_magnet_input(&uri).map_err(Into::into).and_then(|uri| {
                            let id=engine.native.inspect(TorrentSource::Magnet(&uri))?;
                            Ok(serde_json::json!({"ok":true,"kind":"torrent","uri":uri,"id":id}))
                        }),
                        Command::PreviewRemoval{target}=>engine.removal_preview(target),
                        Command::BeginPostDelete{target,revision}=>engine.begin_removal(target,&revision),
                        Command::FinishPostDelete{job}=>engine.finish_post_removal(job),
                        Command::AbortPostDelete{job}=>engine.cancel_removal(job),
                        Command::SetPin{id,pinned,revision}=>engine.set_pin(&id,pinned,revision.as_deref()),
                        Command::FailCleanup{job,error}=>engine.change_retention(|g|{g.jobs.get_mut(&job).context("Cleanup unavailable")?.error=error;Ok(())}).map(|()|serde_json::json!({"ok":true})),
                        Command::NewsPage{offset,anchor}=>engine.posts.as_ref().context("Post service unavailable").and_then(|h|h.manager.news_page(offset,anchor.as_deref()).map_err(Into::into)).and_then(|p|serde_json::to_value(p).map_err(Into::into)),
                        Command::ReadContent{id,parent,offset}=>engine.read_content(&id,parent.as_deref(),offset),
                        Command::ReadCatalogBody{post,catalog}=>engine.catalog_body(&post,&catalog).map(|p|serde_json::json!({"path":p})),
                        Command::CatalogPage{post,catalog,offset}=>engine.posts.as_ref().context("Post service unavailable").and_then(|h|h.manager.page(&post,&catalog,offset).map_err(Into::into)).map(|p|serde_json::json!({"catalog":p.catalog,"entries":p.entries,"offset":p.offset,"total":p.total,"created_at":engine.catalog_dates(&p.catalog.id).and_then(|d|d.created_at),"updated_at":engine.catalog_dates(&p.catalog.id).map(|d|d.updated_at)})),
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
            engine.post_tick();
            engine.cleanup_tick();
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
        let post_result = engine.persist_posts();
        if let Some(host) = &mut engine.posts {
            host.close();
        }
        engine.native.shutdown()?;
        post_result?;
        Ok(())
    });
    init_rx.await?.map_err(anyhow::Error::msg)?;
    let mut token = [0_u8; 32];
    getrandom::fill(&mut token).map_err(|e| anyhow!("Cannot create session token: {e}"))?;
    let token = token.iter().map(|b| format!("{b:02x}")).collect();
    let app = Arc::new(App {
        creation: creation.clone(),
        publishing: publishing.clone(),
        jobs,
        view,
        origin: origin.clone(),
        host: address.to_string(),
        session_cookie: format!("ft_session_{}", address.port()),
        token,
    });
    let recovery = app.clone();
    tokio::spawn(async move {
        let pending = recovery.view.borrow().cleanup.clone();
        for job in pending.into_iter().filter(|j| !j.detached) {
            if let lifecycle::Target::Post { post_kind, id } = &job.target {
                if post_kind == "own" {
                    let exists = recovery
                        .publishing
                        .view
                        .borrow()
                        .posts
                        .iter()
                        .any(|p| &p.id == id);
                    if exists {
                        if let Err(error) = recovery
                            .publishing
                            .call(publishing::Command::RemovePost { id: id.clone() })
                            .await
                        {
                            let _ =
                                engine_call(&recovery, Command::FailCleanup { job: job.id, error })
                                    .await;
                            continue;
                        }
                    }
                }
            }
            if let Err(error) =
                engine_call(&recovery, Command::FinishPostDelete { job: job.id }).await
            {
                let _ = engine_call(&recovery, Command::FailCleanup { job: job.id, error }).await;
            }
        }
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/{name}", get(asset))
        .route("/api/snapshot", get(snapshot))
        .route("/api/image", get(images::resource))
        .route("/api/events", get(events))
        .route("/api/commands", post(command))
        .route(
            "/api/creation",
            post(creation::command).layer(DefaultBodyLimit::max(128 * 1024 * 1024)),
        )
        .route("/api/torrent", get(creation::torrent_file))
        .route(
            "/api/publishing",
            post(publishing::http::command).layer(DefaultBodyLimit::max(128 * 1024 * 1024)),
        )
        .route("/api/publishing/backup", get(publishing::http::export))
        .route(
            "/api/publishing/import",
            post(publishing::http::import).layer(DefaultBodyLimit::disable()),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app);
    println!("FeedTorrent {origin}/");
    if !Args::parse().no_open {
        let _ = desktop::open_browser(&format!("{origin}/"));
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
            creation.close().await;
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
        assert_eq!(store.version, 4);
        assert_eq!(store.settings.download_dir, "user/downloads");
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
            post: None,
        });
        migrate_store(&mut store, home).unwrap();
        assert_eq!(store.settings.download_dir, "user/downloads");
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
