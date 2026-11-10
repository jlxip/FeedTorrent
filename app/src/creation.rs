//! Durable drafts without a signing identity, and bounded host-file preparation.
use super::*;
use feedtorrent_posts::publishing::{Draft, Entry, SourceFile};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftView {
    pub id: String,
    pub revision: u64,
    pub post: bool,
    pub copy_files: bool,
    pub draft: Draft,
    pub phase: String,
    pub error: String,
    pub done: u64,
    pub total: u64,
    pub operation: u64,
    pub result: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Library {
    drafts: BTreeMap<String, DraftView>,
}
pub struct Service {
    pub gate: tokio::sync::Mutex<()>,
    path: PathBuf,
    state: Mutex<Library>,
    running: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    exports: Mutex<BTreeMap<String, (PathBuf, Instant)>>,
}
impl Service {
    pub fn prepare_export(self: &Arc<Self>, path: PathBuf) -> Result<String> {
        let mut exports = self
            .exports
            .lock()
            .map_err(|_| anyhow!("Export service stopped"))?;
        exports.retain(|_, (path, time)| {
            if time.elapsed() > Duration::from_secs(300) {
                let _ = fs::remove_file(path);
                false
            } else {
                true
            }
        });
        if exports.len() >= 16 {
            let _ = fs::remove_file(path);
            bail!("Too many pending backup downloads");
        }
        let mut random = [0; 20];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow!("Cannot obtain backup download entropy"))?;
        let token = feedtorrent_posts::hex(&random);
        exports.insert(token.clone(), (path, Instant::now()));
        let owner = Arc::downgrade(self);
        let expired = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if let Some(service) = owner.upgrade() {
                if let Ok(mut exports) = service.exports.lock() {
                    if let Some((path, _)) = exports.remove(&expired) {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        });
        Ok(token)
    }
    pub fn take_export(&self, token: &str) -> Result<PathBuf> {
        let (path, time) = self
            .exports
            .lock()
            .map_err(|_| anyhow!("Export service stopped"))?
            .remove(token)
            .context("Backup download expired; export again")?;
        if time.elapsed() > Duration::from_secs(300) {
            let _ = fs::remove_file(path);
            bail!("Backup download expired; export again");
        }
        Ok(path)
    }
    pub fn directory(&self) -> &Path {
        self.path.parent().expect("Draft data directory")
    }
    pub fn idle(&self) -> bool {
        self.running.lock().is_ok_and(|r| r.is_empty())
    }
    pub fn reload(&self) -> Result<()> {
        if !self.idle() {
            bail!("Wait for torrent creation before importing");
        }
        let next = Service::new(self.directory())?;
        *self
            .state
            .lock()
            .map_err(|_| anyhow!("Draft service stopped"))? = std::mem::take(
            &mut *next
                .state
                .lock()
                .map_err(|_| anyhow!("Draft service stopped"))?,
        );
        Ok(())
    }
    pub fn new(dir: &Path) -> Result<Arc<Self>> {
        let path = dir.join("creation.json");
        let mut state: Library = if path.exists() {
            serde_json::from_slice(&publishing::read(&path)?)?
        } else {
            Library::default()
        };
        for (id, d) in &mut state.drafts {
            if !valid_id(id) || d.id != *id || d.revision == 0 {
                bail!("Invalid creation draft");
            }
            d.draft.validate()?;
            if !matches!(d.phase.as_str(), "Draft" | "Created" | "Bound") {
                d.phase = "Draft".into();
                d.error =
                    "Creation interrupted; draft preserved. Retry to prepare files again.".into();
            }
        }
        Ok(Arc::new(Self {
            gate: tokio::sync::Mutex::new(()),
            path,
            state: Mutex::new(state),
            running: Mutex::new(BTreeMap::new()),
            handles: Mutex::new(vec![]),
            exports: Mutex::new(BTreeMap::new()),
        }))
    }
    fn change<T>(&self, action: impl FnOnce(&mut Library) -> Result<T>) -> Result<T> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("Draft service stopped"))?;
        let old = serde_json::to_vec(&*state)?;
        let result = action(&mut state).and_then(|value| {
            let bytes = serde_json::to_vec(&*state)?;
            if bytes.len() > 256 * 1024 * 1024 {
                bail!("Draft metadata exceeds 256 MiB");
            }
            publishing::save(&self.path, &bytes)?;
            Ok(value)
        });
        if result.is_err() {
            *state = serde_json::from_slice(&old)?;
        }
        result
    }
    fn get(&self, id: &str) -> Result<DraftView> {
        self.state
            .lock()
            .map_err(|_| anyhow!("Draft service stopped"))?
            .drafts
            .get(id)
            .cloned()
            .context("Draft unavailable")
    }
    fn progress(&self, id: &str, operation: u64, phase: &str, done: u64, total: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("Draft service stopped"))?;
        let d = state.drafts.get_mut(id).context("Draft unavailable")?;
        if d.operation != operation {
            bail!("Creation superseded");
        }
        d.phase = phase.into();
        d.done = done;
        d.total = total;
        Ok(())
    }
    pub async fn close(&self) {
        if let Ok(running) = self.running.lock() {
            for c in running.values() {
                c.store(true, Ordering::Release);
            }
        }
        let handles = self
            .handles
            .lock()
            .map(|mut h| std::mem::take(&mut *h))
            .unwrap_or_default();
        for h in handles {
            let _ = h.await;
        }
        if let Ok(mut exports) = self.exports.lock() {
            for (_, (path, _)) in std::mem::take(&mut *exports) {
                let _ = fs::remove_file(path);
            }
        }
    }
}
pub fn validate_backup(value: &Value) -> Result<()> {
    let library: Library = serde_json::from_value(value.clone())?;
    if library.drafts.len() > 256 {
        bail!("Backup has too many creation drafts");
    }
    for (id, d) in library.drafts {
        if !valid_id(&id)
            || id != d.id
            || d.revision == 0
            || d.result.as_ref().is_some_and(|id| !valid_id(id))
        {
            bail!("Invalid creation draft identity");
        }
        d.draft.validate()?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    List,
    CreateDraft,
    GetDraft {
        id: String,
    },
    SaveDraft {
        id: String,
        revision: u64,
        post: bool,
        copy_files: bool,
        draft: Draft,
    },
    DeleteDraft {
        id: String,
        revision: u64,
    },
    Browse {
        path: Option<String>,
        #[serde(default)]
        offset: usize,
    },
    Sources {
        paths: Vec<String>,
    },
    CreateTorrent {
        id: String,
        revision: u64,
    },
    Cancel {
        id: String,
        operation: u64,
    },
    BindPost {
        id: String,
        revision: u64,
        password: publishing_keys::Password,
        confirmation: publishing_keys::Password,
    },
}
fn check(d: &DraftView, revision: u64) -> Result<()> {
    if d.revision != revision {
        bail!("Draft changed; reload it before continuing");
    }
    if !matches!(d.phase.as_str(), "Draft" | "Created" | "Bound") {
        bail!("Wait for the current operation or cancel it");
    }
    Ok(())
}
pub async fn command(State(app): State<Arc<App>>, Json(action): Json<Action>) -> Response {
    match dispatch(app, action).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, format!("{e:#}")),
    }
}
#[derive(Deserialize)]
pub struct TorrentQuery {
    id: String,
}
pub async fn torrent_file(
    State(app): State<Arc<App>>,
    axum::extract::Query(query): axum::extract::Query<TorrentQuery>,
) -> Response {
    if !valid_id(&query.id) {
        return api_error(StatusCode::BAD_REQUEST, "Invalid torrent identity");
    }
    let path = app
        .view
        .borrow()
        .transfers
        .iter()
        .find(|t| t.id == query.id)
        .map(|t| PathBuf::from(&t.save_path));
    let Some(root) = path else {
        return api_error(StatusCode::NOT_FOUND, "Torrent unavailable");
    };
    let id = query.id;
    match tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let data = read_limited(
            &root
                .parent()
                .context("Missing transfer root")?
                .join(format!("{id}.source")),
        )?;
        if LibtorrentBackend::describe_torrent(&data)?.id != id {
            bail!("Torrent metadata is unavailable");
        }
        Ok(data)
    })
    .await
    {
        Ok(Ok(bytes)) => Response::builder()
            .header(header::CONTENT_TYPE, "application/x-bittorrent")
            .header(
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"torrent.torrent\"",
            )
            .body(Body::from(bytes))
            .unwrap(),
        Ok(Err(e)) => api_error(StatusCode::BAD_REQUEST, format!("{e:#}")),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}
async fn dispatch(app: Arc<App>, action: Action) -> Result<Value> {
    let service = &app.creation;
    let _serial = if matches!(
        &action,
        Action::CreateDraft
            | Action::SaveDraft { .. }
            | Action::DeleteDraft { .. }
            | Action::CreateTorrent { .. }
            | Action::BindPost { .. }
    ) {
        Some(service.gate.lock().await)
    } else {
        None
    };
    match action {
        Action::List => {
            let state = service
                .state
                .lock()
                .map_err(|_| anyhow!("Draft service stopped"))?;
            let drafts=state.drafts.values().map(|d| {
                let title=d.draft.pages.iter().find(|p|p.id==d.draft.root).map(|p|p.title.as_str()).unwrap_or("Untitled");
                json!({"id":d.id,"revision":d.revision,"post":d.post,"copy_files":d.copy_files,"phase":d.phase,"error":d.error,"done":d.done,"total":d.total,"operation":d.operation,"result":d.result,"draft":{"root":d.draft.root,"pages":[{"id":d.draft.root,"title":title,"body":"","entries":[]}]}})
            }).collect::<Vec<_>>();
            Ok(json!({"drafts":drafts}))
        }
        Action::CreateDraft => service.change(|s| {
            s.drafts.retain(|_, d| d.result.is_none());
            if s.drafts.len() >= 256 {
                bail!("There are 256 unfinished drafts");
            }
            let mut random = [0; 20];
            getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain draft entropy"))?;
            let id = feedtorrent_posts::hex(&random);
            let d = DraftView {
                id: id.clone(),
                revision: 1,
                post: true,
                copy_files: true,
                draft: Draft::new("Untitled".into()),
                phase: "Draft".into(),
                error: String::new(),
                done: 0,
                total: 0,
                operation: 0,
                result: None,
            };
            s.drafts.insert(id.clone(), d.clone());
            Ok(json!(d))
        }),
        Action::GetDraft { id } => Ok(json!(service.get(&id)?)),
        Action::SaveDraft {
            id,
            revision,
            post,
            copy_files,
            mut draft,
        } => service.change(|s| {
            draft.validate()?;
            let d = s.drafts.get_mut(&id).context("Draft unavailable")?;
            check(d, revision)?;
            if d.result.is_some() {
                bail!("Completed drafts cannot be changed");
            }
            for p in &mut draft.pages {
                for e in &mut p.entries {
                    if let Entry::Files { copy, .. } = e {
                        *copy = copy_files;
                    }
                }
            }
            d.draft = draft;
            d.post = post;
            d.copy_files = copy_files;
            d.revision = d
                .revision
                .checked_add(1)
                .context("Draft revision exhausted")?;
            d.error.clear();
            Ok(json!(d))
        }),
        Action::DeleteDraft { id, revision } => service.change(|s| {
            if let Some(d) = s.drafts.get(&id) {
                check(d, revision)?;
            }
            s.drafts.remove(&id);
            Ok(json!({"ok":true}))
        }),
        Action::Browse { path, offset } => {
            tokio::task::spawn_blocking(move || browse(path, offset)).await?
        }
        Action::Sources { paths } => {
            tokio::task::spawn_blocking(move || {
                if paths.is_empty() || paths.len() > 1024 {
                    bail!("Select between 1 and 1024 sources");
                }
                let mut entries = vec![];
                for source in paths {
                    let path = source_path(Path::new(&source))?;
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .context("Select a named file or directory")?
                        .to_owned();
                    let mut files = vec![];
                    scan(&path, vec![name.clone()], &mut files)?;
                    if files.is_empty() {
                        bail!("Selected directory contains no regular files");
                    }
                    entries.push(Entry::Files {
                        name,
                        files,
                        linked: false,
                        copy: true,
                    });
                }
                Ok(json!({"entries":entries}))
            })
            .await?
        }
        Action::Cancel { id, operation } => {
            let d = service.get(&id)?;
            if d.operation != operation {
                bail!("Creation superseded");
            }
            if let Some(c) = service
                .running
                .lock()
                .map_err(|_| anyhow!("Draft service stopped"))?
                .get(&id)
            {
                c.store(true, Ordering::Release);
            }
            Ok(json!({"ok":true}))
        }
        Action::CreateTorrent { id, revision } => {
            let cancel = Arc::new(AtomicBool::new(false));
            let draft = {
                let mut running = service
                    .running
                    .lock()
                    .map_err(|_| anyhow!("Draft service stopped"))?;
                if running.len() >= 2 {
                    bail!("Two torrents are already being prepared; wait or cancel one");
                }
                let draft = service.change(|s| {
                    let d = s.drafts.get_mut(&id).context("Draft unavailable")?;
                    check(d, revision)?;
                    if d.post {
                        bail!("Use Publish for posts");
                    }
                    if d.result.is_some() {
                        bail!("Torrent already created");
                    }
                    d.operation = d
                        .operation
                        .checked_add(1)
                        .context("Creation operation exhausted")?;
                    d.phase = "Preparing".into();
                    d.error.clear();
                    Ok(d.clone())
                })?;
                running.insert(id.clone(), cancel.clone());
                draft
            };
            let worker = app.clone();
            let handle = tokio::spawn(async move {
                let build = worker.clone();
                let input = draft.clone();
                let flag = cancel.clone();
                let root = PathBuf::from(&worker.view.borrow().settings.download_dir);
                let outcome = tokio::task::spawn_blocking(move || {
                    prepare_common(
                        &root,
                        build.creation.directory(),
                        &input,
                        &flag,
                        |phase, done, total| {
                            build
                                .creation
                                .progress(&input.id, input.operation, phase, done, total)
                        },
                    )
                })
                .await;
                let result = match outcome {
                    Ok(Ok(p)) => {
                        if cancel.load(Ordering::Acquire) {
                            p.discard();
                            Err(anyhow!("Creation canceled; draft preserved"))
                        } else {
                            let result = engine_call(
                                &worker,
                                Command::AdoptCreated {
                                    data: p.metainfo.clone(),
                                    stage: p.stage.clone(),
                                    external: p.external.clone(),
                                },
                            )
                            .await
                            .map_err(anyhow::Error::msg);
                            if result.is_err() {
                                p.discard();
                            }
                            result.map(|_| p.id)
                        }
                    }
                    Ok(Err(e)) => Err(e),
                    Err(e) => Err(e.into()),
                };
                let _ = worker.creation.change(|s| {
                    let d = s.drafts.get_mut(&id).context("Draft unavailable")?;
                    if d.operation != draft.operation {
                        bail!("Creation superseded");
                    }
                    match result {
                        Ok(hash) => {
                            d.phase = "Created".into();
                            d.result = Some(hash);
                            let title = d
                                .draft
                                .pages
                                .iter()
                                .find(|p| p.id == d.draft.root)
                                .context("Root unavailable")?
                                .title
                                .clone();
                            d.draft = Draft::new(title);
                            d.error.clear();
                        }
                        Err(e) => {
                            d.phase = "Draft".into();
                            d.error = format!("{e:#}");
                        }
                    }
                    Ok(())
                });
                if let Ok(mut running) = worker.creation.running.lock() {
                    if running
                        .get(&id)
                        .is_some_and(|flag| Arc::ptr_eq(flag, &cancel))
                    {
                        running.remove(&id);
                    }
                }
            });
            service
                .handles
                .lock()
                .map_err(|_| anyhow!("Draft service stopped"))?
                .push(handle);
            Ok(json!({"ok":true}))
        }
        Action::BindPost {
            id,
            revision,
            password,
            confirmation,
        } => {
            let d = service.get(&id)?;
            check(&d, revision)?;
            if !d.post {
                bail!("Use Create torrent for common torrents");
            }
            let value = app
                .publishing
                .call(publishing::Command::CreateFromDraft {
                    token: id.clone(),
                    draft: d.draft,
                    password,
                    confirmation,
                })
                .await
                .map_err(anyhow::Error::msg)?;
            let bound = value["id"]
                .as_str()
                .context("Missing publication identity")?
                .to_owned();
            service.change(|s| {
                let d = s.drafts.get_mut(&id).context("Draft unavailable")?;
                check(d, revision)?;
                d.phase = "Bound".into();
                d.result = Some(bound);
                let title = d
                    .draft
                    .pages
                    .iter()
                    .find(|p| p.id == d.draft.root)
                    .context("Root unavailable")?
                    .title
                    .clone();
                d.draft = Draft::new(title);
                Ok(())
            })?;
            Ok(value)
        }
    }
}
pub fn source_path(path: &Path) -> Result<PathBuf> {
    if path
        .as_os_str()
        .to_str()
        .is_none_or(|s| s.chars().any(char::is_control))
    {
        bail!("Source path is not valid UTF-8 or contains control characters");
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    for ancestor in absolute.ancestors() {
        if fs::symlink_metadata(ancestor)?.is_symlink() {
            bail!("Source symlinks are not supported: {}", ancestor.display());
        }
    }
    Ok(fs::canonicalize(absolute)?)
}
pub fn stamp(path: &Path) -> Result<String> {
    Ok(fs::metadata(path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos()
        .to_string())
}
fn scan(path: &Path, relative: Vec<String>, out: &mut Vec<SourceFile>) -> Result<()> {
    if out.len() >= 100_000 || relative.len() > 64 {
        bail!("Source selection is too large or deeply nested");
    }
    let m = fs::symlink_metadata(path)?;
    if m.is_symlink() {
        bail!("Symlinks are not supported: {}", path.display());
    }
    if m.is_file() {
        out.push(SourceFile {
            path: relative,
            source: path.to_str().context("Non-UTF-8 source")?.into(),
            length: m.len(),
            modified: stamp(path)?,
        });
    } else if m.is_dir() {
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|e| e.file_name());
        for e in children {
            let mut r = relative.clone();
            r.push(e.file_name().to_str().context("Non-UTF-8 filename")?.into());
            scan(&e.path(), r, out)?;
        }
    } else {
        bail!(
            "Only regular files and directories are supported: {}",
            path.display()
        );
    }
    Ok(())
}
fn browse(path: Option<String>, offset: usize) -> Result<Value> {
    let path = source_path(&path.map(PathBuf::from).unwrap_or(std::env::current_dir()?))?;
    if !path.is_dir() {
        bail!("Select a directory to browse");
    }
    let mut entries = fs::read_dir(&path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    let total = entries.len();
    let entries=entries.into_iter().skip(offset).take(500).map(|e|{
        let m=fs::symlink_metadata(e.path())?;let disabled=m.is_symlink()||!m.is_dir()&&!m.is_file();
        Ok(json!({"name":e.file_name().to_string_lossy(),"path":e.path(),"directory":m.is_dir(),"length":if m.is_file(){Some(m.len())}else{None},"disabled":disabled}))
    }).collect::<Result<Vec<_>>>()?;
    Ok(json!({"path":path,"parent":path.parent(),"entries":entries,"offset":offset,"total":total}))
}
pub fn verify_source(f: &SourceFile) -> Result<()> {
    let p = source_path(Path::new(&f.source))?;
    let m = fs::metadata(p)?;
    if !m.is_file() || m.len() != f.length || stamp(Path::new(&f.source))? != f.modified {
        bail!(
            "Source changed or disappeared: {}. Select it again.",
            f.source
        );
    }
    Ok(())
}
pub fn copy_stream(from: &Path, to: &Path, cancel: &AtomicBool) -> Result<()> {
    use std::io::Read;
    fs::create_dir_all(to.parent().context("Missing output directory")?)?;
    let mut input = File::open(from)?;
    let mut output = OpenOptions::new().create_new(true).write(true).open(to)?;
    let mut bytes = [0; 65536];
    loop {
        if cancel.load(Ordering::Acquire) {
            bail!("Creation canceled; draft preserved");
        }
        let n = input.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        output.write_all(&bytes[..n])?;
    }
    output.sync_all()?;
    Ok(())
}
pub struct Prepared {
    pub id: String,
    pub metainfo: Vec<u8>,
    pub stage: PathBuf,
    pub external: String,
}
impl Prepared {
    fn discard(&self) {
        let _ = fs::remove_dir_all(&self.stage);
    }
}
pub fn prepare_common(
    root: &Path,
    owner: &Path,
    d: &DraftView,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64, u64) -> Result<()>,
) -> Result<Prepared> {
    let title = &d
        .draft
        .pages
        .iter()
        .find(|p| p.id == d.draft.root)
        .context("Root page unavailable")?
        .title;
    let files: Vec<_> = d
        .draft
        .pages
        .iter()
        .flat_map(|p| &p.entries)
        .filter_map(|e| {
            if let Entry::Files { files, .. } = e {
                Some(files)
            } else {
                None
            }
        })
        .flatten()
        .cloned()
        .collect();
    if files.is_empty() {
        bail!("Add files before creating a torrent");
    }
    let total = files.iter().try_fold(0u64, |n, f| {
        n.checked_add(f.length).context("Total size overflow")
    })?;
    if total == 0 {
        bail!("Torrent has no downloadable bytes");
    }
    let mut seen = BTreeSet::new();
    for f in &files {
        if !seen.insert(f.path.clone()) {
            bail!("Duplicate torrent path: {}", f.path.join("/"));
        }
        verify_source(f)?;
    }
    fs::create_dir_all(root)?;
    let stage = root.join(format!(".create-{}-{}", d.id, d.operation));
    fs::create_dir(&stage)?;
    let result = (|| {
        publishing::save(
            &stage.join(".creation-owner"),
            fs::canonicalize(owner)?
                .to_str()
                .context("Non-UTF-8 data directory")?
                .as_bytes(),
        )?;
        let mut inputs = vec![];
        let mut external = String::new();
        let mut copied = 0;
        for f in &files {
            if cancel.load(Ordering::Acquire) {
                bail!("Creation canceled; draft preserved");
            }
            let logical = format!("{title}/{}", f.path.join("/"));
            let source = if d.copy_files {
                let target = stage.join(&logical);
                copy_stream(Path::new(&f.source), &target, cancel)?;
                copied += f.length;
                progress("Copying", copied, total)?;
                target
            } else {
                external.push_str(&format!("{logical}\t{}\n", f.source));
                PathBuf::from(&f.source)
            };
            inputs.push(feedtorrent_libtorrent::creation::Input {
                name: f.path.join("/"),
                source: source.to_str().context("Non-UTF-8 source")?.into(),
                length: f.length,
            });
        }
        let mut builder = feedtorrent_libtorrent::creation::Builder::new(title, inputs)?;
        let mut done = 0;
        while done < total {
            if cancel.load(Ordering::Acquire) {
                bail!("Creation canceled; draft preserved");
            }
            done = builder.step()?;
            progress("Hashing", done, total)?;
        }
        for f in &files {
            verify_source(f)?;
        }
        let metainfo = builder.finish()?;
        let id = LibtorrentBackend::describe_torrent(&metainfo)?.id;
        Ok(Prepared {
            id,
            metainfo,
            stage: stage.clone(),
            external,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}
pub fn cleanup_staging(root: &Path, owner: &Path) -> Result<()> {
    let owner = fs::canonicalize(owner)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry
                .file_name()
                .to_str()
                .is_some_and(|s| s.starts_with(".create-"))
        {
            continue;
        }
        let marker = entry.path().join(".creation-owner");
        if fs::symlink_metadata(&marker)
            .is_ok_and(|m| m.is_file() && !m.is_symlink() && m.len() < 4096)
            && fs::read(&marker)?
                == owner
                    .to_str()
                    .context("Non-UTF-8 data directory")?
                    .as_bytes()
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
