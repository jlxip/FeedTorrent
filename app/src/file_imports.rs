//! Browser uploads are staged independently of navigation and committed by revision.
use super::*;
use axum::extract::Path as RoutePath;
use feedtorrent_posts::publishing::{Draft, Entry, SourceFile};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    kind: String,
    id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    path: Vec<String>,
    size: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    owner: Owner,
    page: u64,
    revision: u64,
    files: Vec<Input>,
    directory: String,
    committed: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    owner: Owner,
    page: u64,
    revision: u64,
    files: Vec<Input>,
}
struct Batch {
    manifest: Manifest,
    path: PathBuf,
    uploaded: BTreeSet<usize>,
    touched: Instant,
}
struct Job {
    batch: tokio::sync::Mutex<Batch>,
    cancel: AtomicBool,
}
pub struct Service {
    root: PathBuf,
    jobs: Mutex<BTreeMap<String, Arc<Job>>>,
}
fn safe_path(path: &[String]) -> bool {
    !path.is_empty()
        && path.len() <= 64
        && path.iter().all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.contains(['/', '\\'])
                && !p.chars().any(char::is_control)
        })
}
fn manifest_save(batch: &Batch) -> Result<()> {
    publishing::save(
        &batch.path.join("import.json"),
        &serde_json::to_vec(&batch.manifest)?,
    )
}
impl Service {
    pub fn new(dir: &Path) -> Result<Arc<Self>> {
        let root = dir.join("publishing-assets");
        fs::create_dir_all(&root)?;
        let service = Arc::new(Self {
            root: fs::canonicalize(root)?,
            jobs: Mutex::new(BTreeMap::new()),
        });
        // Only manifests created for this exact data directory authorize deletion.
        for entry in fs::read_dir(&service.root)? {
            let path = entry?.path();
            if let Some(m) = service.owned(&path) {
                if !m.committed {
                    fs::remove_dir_all(path)?;
                }
            }
        }
        Ok(service)
    }
    fn owned(&self, path: &Path) -> Option<Manifest> {
        if fs::symlink_metadata(path).ok()?.file_type().is_symlink() || !path.is_dir() {
            return None;
        }
        let name = path.file_name()?.to_str()?.strip_prefix("import-")?;
        if !valid_id(name) {
            return None;
        }
        let m: Manifest = serde_json::from_slice(&fs::read(path.join("import.json")).ok()?).ok()?;
        (m.directory == self.root.parent()?.to_str()?).then_some(m)
    }
    pub fn idle(&self) -> bool {
        self.jobs.lock().is_ok_and(|jobs| jobs.is_empty())
    }
    fn job(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs
            .lock()
            .map_err(|_| anyhow!("Import service stopped"))?
            .get(id)
            .cloned()
            .context("Import expired or cancelled")
    }
    fn expire(&self) -> Result<()> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| anyhow!("Import service stopped"))?
            .clone();
        for (id, job) in jobs {
            // Upload and commit hold this lease; never expire an active request.
            if let Ok(batch) = job.batch.try_lock() {
                if batch.touched.elapsed() > Duration::from_secs(1800) {
                    job.cancel.store(true, Ordering::Release);
                    // A job cloned just before commit can outlive its map entry.
                    // Committed bytes are collected only by the reference scan.
                    if !batch.manifest.committed {
                        fs::remove_dir_all(&batch.path)?;
                    }
                    self.jobs
                        .lock()
                        .map_err(|_| anyhow!("Import service stopped"))?
                        .remove(&id);
                }
            }
        }
        Ok(())
    }
    pub async fn cleanup(&self, app: &App) -> Result<()> {
        self.expire()?;
        // Backups and creation commits share this barrier. Workers
        // retain their inputs independently, so defer collection while any runs.
        let _serial = app.creation.gate.lock().await;
        if !app.creation.idle()
            || !app.publishing.view.borrow().busy.is_empty()
            || app
                .publishing
                .view
                .borrow()
                .posts
                .iter()
                .any(|p| p.operation.is_some())
        {
            return Ok(());
        }
        let mut references = BTreeSet::new();
        fn collect(value: &Value, refs: &mut BTreeSet<String>) {
            match value {
                Value::String(s) => {
                    refs.insert(s.clone());
                }
                Value::Array(a) => {
                    for v in a {
                        collect(v, refs);
                    }
                }
                Value::Object(o) => {
                    for v in o.values() {
                        collect(v, refs);
                    }
                }
                _ => {}
            }
        }
        for name in ["creation.json", "publishing.json"] {
            let path = app.creation.directory().join(name);
            if path.exists() {
                collect(&serde_json::from_slice(&fs::read(path)?)?, &mut references);
            }
        }
        // Retained/pinned publications may outlive the draft that created their
        // external mapping. Those persisted mappings are references too.
        use std::io::BufRead;
        let roots = [
            app.creation.directory().join("published"),
            PathBuf::from(&app.view.borrow().settings.download_dir),
        ];
        for root in roots {
            if !root.exists() {
                continue;
            }
            for entry in fs::read_dir(root)? {
                let path = entry?.path();
                if path.extension().is_some_and(|x| x == "external") {
                    for line in BufReader::new(File::open(path)?).lines() {
                        if let Some((_, source)) = line?.split_once('\t') {
                            references.insert(source.to_owned());
                        }
                    }
                }
            }
        }
        self.collect_confirmed(&references)
    }
    fn collect_confirmed(&self, references: &BTreeSet<String>) -> Result<()> {
        let live: BTreeSet<_> = self
            .jobs
            .lock()
            .map_err(|_| anyhow!("Import service stopped"))?
            .keys()
            .cloned()
            .collect();
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if let Some(m) = self.owned(&path) {
                let id = path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .trim_start_matches("import-");
                if !m.committed || live.contains(id) {
                    continue;
                }
                if !references.iter().any(|r| Path::new(r).starts_with(&path)) {
                    fs::remove_dir_all(path)?;
                }
            }
        }
        Ok(())
    }
}
async fn draft(app: &App, owner: &Owner, revision: u64) -> Result<(Draft, bool)> {
    if !valid_id(&owner.id) {
        bail!("Invalid import owner");
    }
    match owner.kind.as_str() {
        "creation" => {
            let d = app.creation.get(&owner.id)?;
            if d.revision != revision
                || d.result.is_some()
                || !matches!(d.phase.as_str(), "Draft" | "Created" | "Bound")
            {
                bail!("Draft changed; select files again");
            }
            Ok((d.draft, d.post))
        }
        "own" => {
            let v = app
                .publishing
                .call(publishing::Command::GetPost {
                    id: owner.id.clone(),
                })
                .await
                .map_err(anyhow::Error::msg)?;
            if v["revision"].as_u64() != Some(revision) {
                bail!("Draft changed; select files again");
            }
            Ok((serde_json::from_value(v["draft"].clone())?, true))
        }
        _ => bail!("Invalid import owner"),
    }
}
fn response(result: Result<Value>) -> Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, format!("{e:#}")),
    }
}
pub async fn start(State(app): State<Arc<App>>, Json(input): Json<Start>) -> Response {
    response(
        async {
            if !app.updates.sensitive() {
                bail!("An application update is waiting; cancel it before starting another import");
            }
            app.imports.cleanup(&app).await?;
            if input.files.is_empty() || input.files.len() > 100_000 {
                bail!("Select between 1 and 100000 files");
            }
            let mut paths = BTreeSet::new();
            let mut total = 0u64;
            for f in &input.files {
                if !safe_path(&f.path) || !paths.insert(f.path.clone()) {
                    bail!("Invalid or duplicate relative file path");
                }
                total = total.checked_add(f.size).context("Import size overflow")?;
            }
            // No file can also be a directory in the same batch.
            for path in &paths {
                for end in 1..path.len() {
                    if paths.contains(&path[..end]) {
                        bail!("Conflicting file paths");
                    }
                }
            }
            let (d, _) = draft(&app, &input.owner, input.revision).await?;
            if !d.pages.iter().any(|p| p.id == input.page) {
                bail!("Page unavailable");
            }
            let mut random = [0; 20];
            getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain import entropy"))?;
            let id = feedtorrent_posts::hex(&random);
            let path = app.imports.root.join(format!("import-{id}"));
            let manifest = Manifest {
                owner: input.owner,
                page: input.page,
                revision: input.revision,
                files: input.files,
                directory: app
                    .imports
                    .root
                    .parent()
                    .unwrap()
                    .to_str()
                    .context("Non-UTF-8 data directory")?
                    .into(),
                committed: false,
            };
            let mut jobs = app
                .imports
                .jobs
                .lock()
                .map_err(|_| anyhow!("Import service stopped"))?;
            if jobs.len() >= 16 {
                bail!("Too many unfinished imports");
            }
            fs::create_dir(&path)?;
            let batch = Batch {
                manifest,
                path: path.clone(),
                uploaded: BTreeSet::new(),
                touched: Instant::now(),
            };
            if let Err(e) = manifest_save(&batch) {
                let _ = fs::remove_dir_all(path);
                return Err(e);
            }
            jobs.insert(
                id.clone(),
                Arc::new(Job {
                    batch: tokio::sync::Mutex::new(batch),
                    cancel: AtomicBool::new(false),
                }),
            );
            Ok(json!({"id":id,"total":total}))
        }
        .await,
    )
}
pub async fn upload(
    State(app): State<Arc<App>>,
    RoutePath((id, index)): RoutePath<(String, usize)>,
    mut body: Body,
) -> Response {
    response(
        async {
            use axum::body::HttpBody;
            use tokio::io::AsyncWriteExt;
            let job = app.imports.job(&id)?;
            let mut batch = job.batch.lock().await;
            if job.cancel.load(Ordering::Acquire) || batch.manifest.committed {
                bail!("Import cancelled or committed");
            }
            let f = batch
                .manifest
                .files
                .get(index)
                .context("Unknown import file")?;
            let size = f.size;
            let path = batch.path.join(format!("{index}.part"));
            let result = async {
                let mut output = tokio::fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .open(&path)
                    .await?;
                let mut count = 0u64;
                while let Some(frame) =
                    std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
                {
                    if job.cancel.load(Ordering::Acquire) {
                        bail!("Import cancelled");
                    }
                    if let Ok(bytes) = frame?.into_data() {
                        count = count
                            .checked_add(bytes.len() as u64)
                            .context("File size overflow")?;
                        if count > size {
                            bail!("Upload exceeds declared size");
                        }
                        output.write_all(&bytes).await?;
                    }
                }
                if count != size || job.cancel.load(Ordering::Acquire) {
                    bail!("Incomplete or cancelled upload");
                }
                output.sync_all().await?;
                drop(output);
                tokio::fs::rename(&path, batch.path.join(index.to_string())).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            batch.touched = Instant::now();
            if let Err(e) = result {
                let _ = fs::remove_file(path);
                return Err(e);
            }
            batch.uploaded.insert(index);
            Ok(json!({"ok":true}))
        }
        .await,
    )
}
/// Conversion happens on a cloned draft; invalid metainfo cannot partially save.
pub(crate) fn post_entries(draft: &mut Draft) -> Result<()> {
    use std::io::Read;
    let mut bytes = draft.pages.iter().try_fold(0u64, |total, page| {
        let meta = page
            .entries
            .iter()
            .filter_map(|e| {
                if let Entry::Torrent { data, .. } = e {
                    Some(data.len() as u64)
                } else {
                    None
                }
            })
            .sum::<u64>();
        total
            .checked_add(page.body.len() as u64)
            .and_then(|n| n.checked_add(meta))
            .context("Draft content exceeds 32 MiB")
    })?;
    for page in &mut draft.pages {
        let mut entries = Vec::new();
        for entry in &page.entries {
            if let Entry::Files {
                name,
                files,
                linked,
                copy,
            } = entry
            {
                let mut ordinary = Vec::new();
                for file in files {
                    if file
                        .path
                        .last()
                        .is_some_and(|p| p.to_ascii_lowercase().ends_with(".torrent"))
                    {
                        creation::verify_source(file)?;
                        if file.length > 8 * 1024 * 1024 {
                            bail!("Torrent metadata exceeds 8 MiB: {}", file.path.join("/"));
                        }
                        bytes = bytes
                            .checked_add(file.length)
                            .context("Draft content exceeds 32 MiB")?;
                        if bytes > feedtorrent_posts::publishing::MAX_DRAFT_BYTES as u64 {
                            bail!("Draft content exceeds 32 MiB");
                        }
                        let mut data = Vec::new();
                        File::open(&file.source)?
                            .take(8 * 1024 * 1024 + 1)
                            .read_to_end(&mut data)?;
                        if data.len() as u64 != file.length {
                            bail!("Metainfo source changed");
                        }
                        creation::verify_source(file)?;
                        if !matches!(
                            feedtorrent_bep::bep49::inspect_item(&data),
                            feedtorrent_bep::bep49::ItemContent::Torrent(_)
                        ) {
                            bail!("Invalid .torrent: {}", file.path.join("/"));
                        }
                        entries.push(Entry::Torrent {
                            name: file.path.last().unwrap().clone(),
                            data,
                            original: Some(file.clone()),
                        });
                    } else {
                        ordinary.push(file.clone());
                    }
                }
                if !ordinary.is_empty() {
                    entries.push(Entry::Files {
                        name: name.clone(),
                        files: ordinary,
                        linked: *linked,
                        copy: *copy,
                    });
                }
            } else {
                entries.push(entry.clone());
            }
        }
        page.entries = entries;
    }
    draft.validate()?;
    Ok(())
}
pub async fn commit(State(app): State<Arc<App>>, RoutePath(id): RoutePath<String>) -> Response {
    response(
        async {
            let job = app.imports.job(&id)?;
            let mut batch = job.batch.lock().await;
            let _serial = app.creation.gate.lock().await;
            if job.cancel.load(Ordering::Acquire) || batch.manifest.committed {
                bail!("Import cancelled or committed");
            }
            if batch.uploaded.len() != batch.manifest.files.len() {
                bail!("Import still has missing files");
            }
            let m = batch.manifest.clone();
            let (mut d, post) = draft(&app, &m.owner, m.revision).await?;
            let page = d
                .pages
                .iter_mut()
                .find(|p| p.id == m.page)
                .context("Page unavailable")?;
            let mut groups: BTreeMap<String, Vec<SourceFile>> = BTreeMap::new();
            let mut existing = BTreeSet::new();
            for e in &page.entries {
                match e {
                    Entry::Files { files, .. } => {
                        existing.extend(files.iter().map(|f| f.path.clone()))
                    }
                    Entry::Torrent {
                        original: Some(f), ..
                    } => {
                        existing.insert(f.path.clone());
                    }
                    _ => {}
                }
            }
            for (index, f) in m.files.iter().enumerate() {
                if !existing.insert(f.path.clone()) {
                    bail!("File already selected: {}", f.path.join("/"));
                }
                let path = batch.path.join(index.to_string());
                let source = SourceFile {
                    path: f.path.clone(),
                    source: path.to_str().context("Non-UTF-8 import path")?.into(),
                    length: f.size,
                    modified: creation::stamp(&path)?,
                };
                creation::verify_source(&source)?;
                groups.entry(f.path[0].clone()).or_default().push(source);
            }
            for (name, files) in groups {
                page.entries.push(Entry::Files {
                    name,
                    files,
                    linked: false,
                    copy: true,
                });
            }
            if post {
                post_entries(&mut d)?;
            }
            d.validate()?;
            if job.cancel.load(Ordering::Acquire) {
                bail!("Import cancelled");
            }
            // Ownership becomes durable before publishing references. On a crash the
            // unreferenced batch is collectible, while a committed draft always wins.
            batch.manifest.committed = true;
            manifest_save(&batch)?;
            let saved = if m.owner.kind == "creation" {
                app.creation
                    .import_draft(&m.owner.id, m.revision, d.clone())
                    .map(|v| json!({"revision":v.revision,"draft":v.draft}))
            } else {
                app.publishing
                    .call(publishing::Command::SaveDraft {
                        id: m.owner.id,
                        revision: m.revision,
                        draft: d.clone(),
                    })
                    .await
                    .map_err(anyhow::Error::msg)
                    .map(|mut v| {
                        v["draft"] = json!(d);
                        v
                    })
            };
            match saved {
                Ok(v) => {
                    app.imports
                        .jobs
                        .lock()
                        .map_err(|_| anyhow!("Import service stopped"))?
                        .remove(&id);
                    Ok(v)
                }
                Err(e) => {
                    batch.manifest.committed = false;
                    manifest_save(&batch)?;
                    Err(e)
                }
            }
        }
        .await,
    )
}
pub async fn cancel(State(app): State<Arc<App>>, RoutePath(id): RoutePath<String>) -> Response {
    response(
        async {
            let job = app.imports.job(&id)?;
            job.cancel.store(true, Ordering::Release);
            let batch = job.batch.lock().await;
            if !batch.manifest.committed {
                fs::remove_dir_all(&batch.path)?;
            }
            app.imports
                .jobs
                .lock()
                .map_err(|_| anyhow!("Import service stopped"))?
                .remove(&id);
            Ok(json!({"ok":true}))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cleanup_protects_active_uploads_references_and_unowned_assets() {
        let mut random = [0; 20];
        getrandom::fill(&mut random).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "feedtorrent-import-{}",
            feedtorrent_posts::hex(&random)
        ));
        let service = Service::new(&dir).unwrap();
        let id = "a".repeat(40);
        let path = service.root.join(format!("import-{id}"));
        fs::create_dir(&path).unwrap();
        let batch = Batch {
            manifest: Manifest {
                owner: Owner {
                    kind: "creation".into(),
                    id: "b".repeat(40),
                },
                page: 1,
                revision: 1,
                files: vec![],
                directory: service.root.parent().unwrap().to_str().unwrap().into(),
                committed: false,
            },
            path: path.clone(),
            uploaded: BTreeSet::new(),
            touched: Instant::now() - Duration::from_secs(1801),
        };
        manifest_save(&batch).unwrap();
        let job = Arc::new(Job {
            batch: tokio::sync::Mutex::new(batch),
            cancel: AtomicBool::new(false),
        });
        service.jobs.lock().unwrap().insert(id.clone(), job.clone());
        let lease = job.batch.lock().await;
        service.expire().unwrap();
        assert!(path.exists());
        drop(lease);
        service.expire().unwrap();
        assert!(!path.exists());
        assert!(service.idle());
        fs::create_dir(&path).unwrap();
        let mut batch = job.batch.lock().await;
        batch.manifest.committed = true;
        manifest_save(&batch).unwrap();
        drop(batch);
        service.jobs.lock().unwrap().insert(id.clone(), job.clone());
        service.expire().unwrap();
        assert!(path.exists());
        assert!(service.idle());
        let unknown = service.root.join("unowned");
        fs::create_dir(&unknown).unwrap();
        service
            .collect_confirmed(&BTreeSet::from([path.join("0").display().to_string()]))
            .unwrap();
        assert!(path.exists());
        service.collect_confirmed(&BTreeSet::new()).unwrap();
        assert!(!path.exists());
        assert!(unknown.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
