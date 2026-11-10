//! Durable publication jobs. Worker credentials exist only in memory; operation
//! IDs fence every callback, including callbacks arriving after cancellation.
use super::*;
use std::sync::{atomic::AtomicBool, Mutex};

pub(super) fn first_operation() -> u64 {
    1
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub id: u64,
    pub revision: u64,
    pub draft: Draft,
    pub phase: String,
    pub retry_at: Option<u64>,
    pub signed: Option<SignedRecord>,
    pub pages: BTreeMap<u64, PageRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_at: Option<u64>,
}
impl Pending {
    pub fn validate(&self, f: &Owned, next: u64, used: &mut BTreeSet<u64>) -> Result<()> {
        if self.id == 0 || self.id >= next || !used.insert(self.id) || self.revision > f.revision {
            bail!("Invalid publication operation or revision")
        }
        self.draft.validate()?;
        if self
            .prepared_at
            .is_some_and(|t| t > feedtorrent_posts::dates::MAX_TIMESTAMP)
        {
            bail!("Invalid publication preparation time")
        }
        if !matches!(
            self.phase.as_str(),
            "Queued"
                | "Preparing"
                | "Checking DHT"
                | "Checking catalogs"
                | "Publishing"
                | "Retrying"
        ) {
            bail!("Invalid publication stage")
        }
        if let Some(record) = &self.signed {
            let key = bep46::parse_magnet(&f.magnet)?;
            TorrentPointer::from_record(&key, record.verify(&key)?)?;
            if f.signed_revision != self.revision
                || f.record.as_ref().is_none_or(|r| {
                    r.signature != record.signature
                        || r.sequence != record.sequence
                        || r.value != record.value
                })
            {
                bail!("Publication does not own its signed record")
            }
        } else if !self.pages.is_empty() {
            bail!("Unsigned publication has signed catalog references")
        }
        for p in self.pages.values() {
            if !valid_id(&p.hash) {
                bail!("Invalid queued catalog hash")
            }
        }
        Ok(())
    }
}
type Secrets = Arc<Mutex<Option<(Vault, Password)>>>;
struct Running {
    operation: u64,
    cancel: Arc<AtomicBool>,
}
pub(super) struct Work {
    id: String,
    operation: u64,
    pub(super) cancel: Arc<AtomicBool>,
    secrets: Secrets,
    tx: mpsc::SyncSender<Message>,
}
impl Work {
    pub fn identity(&self) -> (&str, u64) {
        (&self.id, self.operation)
    }
    pub fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) {
            bail!("Publication canceled")
        }
        Ok(())
    }
    fn wait<T>(&self, rx: &mpsc::Receiver<T>) -> Result<T> {
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            self.check()?;
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => {
                    self.check()?;
                    return Ok(value);
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(_) => {
                    return Err(native::Failure::Unavailable(
                        "Publishing service stopped or timed out".into(),
                    )
                    .into())
                }
            }
        }
    }
    pub fn phase(&self, state: &str) -> Result<()> {
        self.check()?;
        let (reply, rx) = mpsc::channel();
        self.tx
            .try_send(Message::Phase {
                id: self.id.clone(),
                operation: self.operation,
                state: state.into(),
                reply,
            })
            .map_err(|_| {
                native::Failure::Unavailable("Publishing service busy or stopped".into())
            })?;
        self.wait(&rx)?.map_err(anyhow::Error::msg)
    }
    pub fn signed(&self, record: SignedRecord, pages: BTreeMap<u64, PageRef>) -> Result<()> {
        self.check()?;
        *self
            .secrets
            .lock()
            .map_err(|_| anyhow!("Publishing credentials unavailable"))? = None;
        let hashes = pages.values().map(|p| p.hash.clone()).collect();
        let (reply, rx) = mpsc::channel();
        self.tx
            .try_send(Message::Signed {
                id: self.id.clone(),
                operation: self.operation,
                record,
                pages,
                hashes,
                reply,
            })
            .map_err(|_| {
                native::Failure::Unavailable("Publishing service busy or stopped".into())
            })?;
        self.wait(&rx)?.map_err(anyhow::Error::msg)
    }
    pub fn signer(&self) -> Result<Bep44Signer> {
        self.check()?;
        // Never hold the queue's credentials lock during password derivation.
        // Cancellation can erase its copy while this bounded worker unwinds.
        let (vault, password) = {
            let credentials = self
                .secrets
                .lock()
                .map_err(|_| anyhow!("Publishing credentials unavailable"))?;
            let (vault, password) = credentials
                .as_ref()
                .context("Publication credentials unavailable; publish again")?;
            (vault.clone(), Password(password.0.clone()))
        };
        let seed = vault.unlock(&password)?;
        drop(password);
        self.check()?;
        let signer = Bep44Signer::from_seed(&seed);
        drop(seed);
        Ok(signer)
    }
    pub fn call(
        &self,
        native: &mpsc::SyncSender<NativeTask>,
        command: Native,
    ) -> Result<NativeReply> {
        call(native, command, self.cancel.clone())
    }
}
pub(super) fn call(
    native: &mpsc::SyncSender<NativeTask>,
    command: Native,
    cancel: Arc<AtomicBool>,
) -> Result<NativeReply> {
    if cancel.load(Ordering::Acquire) {
        bail!("Publication canceled")
    }
    let (reply, rx) = mpsc::channel();
    native
        .try_send(NativeTask {
            command,
            reply,
            cancel: cancel.clone(),
        })
        .map_err(|_| native::Failure::Unavailable("Transfer service busy or stopped".into()))?;
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        if cancel.load(Ordering::Acquire) {
            bail!("Publication canceled")
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(value) => {
                if cancel.load(Ordering::Acquire) {
                    bail!("Publication canceled")
                }
                return value.map_err(anyhow::Error::new);
            }
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
            Err(_) => {
                return Err(native::Failure::Unavailable(
                    "Transfer service stopped or timed out".into(),
                )
                .into())
            }
        }
    }
}
fn allocate(lib: &mut Library) -> Result<u64> {
    let id = lib.next_operation;
    lib.next_operation = id
        .checked_add(1)
        .context("Publication identifiers exhausted")?;
    Ok(id)
}
fn pending(f: &Owned, id: u64, signed: bool) -> Pending {
    Pending {
        prepared_at: Some(now_ms() / 1000),
        id,
        revision: if signed {
            f.signed_revision
        } else {
            f.revision
        },
        draft: f.draft.clone(),
        phase: "Queued".into(),
        retry_at: None,
        signed: signed.then(|| f.record.clone()).flatten(),
        pages: if signed {
            f.pages.clone()
        } else {
            BTreeMap::new()
        },
    }
}
fn recover(lib: &mut Library) -> Result<bool> {
    let mut changed = lib.version != 2;
    let old = lib.version == 1;
    lib.version = 2;
    let mut next = lib.next_operation;
    for f in lib.posts.values_mut() {
        changed |= recover_published_sequence(f)?;
        if old
            && f.pending.is_none()
            && f.state == "Publication pending"
            && f.record.is_some()
            && f.active
        {
            let id = next;
            next = next
                .checked_add(1)
                .context("Publication identifiers exhausted")?;
            if f.signed_revision == 0 {
                f.signed_revision = f.published_revision.max(f.revision);
            }
            f.pending = Some(pending(f, id, true));
            changed = true;
        }
        if let Some(p) = &mut f.pending {
            changed = true;
            if p.signed.is_some() {
                p.phase = "Queued".into();
                p.retry_at = None;
                f.state = "Publication pending".into();
                f.error.clear();
            } else {
                f.pending = None;
                f.active = false;
                f.state = "Canceled".into();
                f.error = "Publication interrupted before signing; draft preserved. Publish again."
                    .into();
            }
        } else if matches!(
            f.state.as_str(),
            "Preparing" | "Checking DHT" | "Checking catalogs"
        ) {
            f.active = false;
            f.state = "Canceled".into();
            f.error =
                "Publication interrupted before signing; draft preserved. Publish again.".into();
            changed = true;
        }
    }
    lib.next_operation = next;
    Ok(changed)
}
struct Manager {
    dir: PathBuf,
    lib: Library,
    disabled: Option<String>,
    error: String,
    tx: mpsc::SyncSender<Message>,
    native: mpsc::SyncSender<NativeTask>,
    views: watch::Sender<View>,
    running: BTreeMap<String, Running>,
    secrets: BTreeMap<u64, Secrets>,
    handles: Vec<std::thread::JoinHandle<()>>,
    renewals: BTreeMap<String, Instant>,
    retry_delay: Duration,
    stopping: bool,
}
impl Manager {
    fn current_view(&self) -> View {
        let mut value = view(
            &self.lib,
            self.disabled.clone().unwrap_or_else(|| self.error.clone()),
        );
        value.busy = self.running.keys().cloned().collect();
        value
    }
    fn commit(&mut self, candidate: Library) -> Result<()> {
        persist(&self.dir, &candidate)?;
        self.lib = candidate;
        self.error.clear();
        Ok(())
    }
    fn clear_secret(&mut self, operation: u64) {
        if let Some(secret) = self.secrets.remove(&operation) {
            if let Ok(mut value) = secret.lock() {
                *value = None;
            }
        }
    }
    fn current(&self, id: &str, operation: u64) -> bool {
        !self.stopping
            && self
                .lib
                .posts
                .get(id)
                .and_then(|f| f.pending.as_ref())
                .is_some_and(|p| p.id == operation)
            && self
                .running
                .get(id)
                .is_some_and(|r| r.operation == operation && !r.cancel.load(Ordering::Acquire))
    }
    fn command(&mut self, command: Command) -> Result<serde_json::Value> {
        if let Some(error) = &self.disabled {
            if !matches!(command, Command::Preview { .. }) {
                bail!("{error}")
            }
        }
        if self.stopping {
            bail!("Publishing service stopped")
        }
        let lib = &mut self.lib;
        let dir = &self.dir;
        match command {
            Command::CreateFromDraft {
                token,
                draft,
                password,
                confirmation,
            } => {
                if !valid_id(&token) {
                    bail!("Invalid draft identity");
                }
                draft.validate()?;
                let mut c = lib.clone();
                if c.vault.is_none() {
                    if password.0 != confirmation.0 {
                        bail!("Passwords do not match");
                    }
                    c.vault = Some(Vault::create(&password)?);
                }
                let v = c.vault.as_ref().context("No publishing key")?;
                drop(v.unlock(&password)?);
                let key = MutableKey::new(
                    unhex(&v.public_key)?
                        .try_into()
                        .map_err(|_| anyhow!("Invalid key"))?,
                    format!("draft:{token}").into_bytes(),
                )?;
                let id = hex(&key.target());
                if c.posts.contains_key(&id) {
                    return Ok(serde_json::json!({"id":id,"revision":c.posts[&id].revision}));
                }
                if c.posts.len() >= 256 {
                    bail!("Publishing library has 256 posts");
                }
                let title = draft
                    .pages
                    .iter()
                    .find(|p| p.id == draft.root)
                    .context("Root unavailable")?
                    .title
                    .clone();
                c.posts.insert(
                    id.clone(),
                    Owned {
                        id: id.clone(),
                        magnet: bep46::format_magnet(&key),
                        title,
                        draft,
                        revision: 1,
                        published_revision: 0,
                        published_sequence: None,
                        published: None,
                        changed_at_us: crate::organization::now_us(),
                        signed_revision: 0,
                        pages: BTreeMap::new(),
                        record: None,
                        history: vec![],
                        active: true,
                        state: "Draft".into(),
                        error: String::new(),
                        pending: None,
                    },
                );
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"id":id,"revision":1}))
            }
            Command::Preview { body } => {
                Ok(serde_json::json!({"body":feedtorrent_posts::markdown::parse(&body)?}))
            }
            Command::CreateKey {
                password,
                confirmation,
            } => {
                if lib.vault.is_some() {
                    bail!("Publishing key already exists")
                };
                if password.0 != confirmation.0 {
                    bail!("Passwords do not match")
                };
                let mut candidate = lib.clone();
                candidate.vault = Some(Vault::create(&password)?);
                persist(dir, &candidate)?;
                *lib = candidate;
                Ok(serde_json::json!({"ok":true}))
            }
            Command::ChangePassword {
                old,
                password,
                confirmation,
            } => {
                if password.0 != confirmation.0 {
                    bail!("Passwords do not match")
                };
                let changed = lib
                    .vault
                    .as_ref()
                    .context("No publishing key")?
                    .change(&old, &password)?;
                let mut c = lib.clone();
                c.vault = Some(changed);
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"ok":true}))
            }
            Command::CreatePost { title } => {
                if lib.posts.len() >= 256 {
                    bail!("Publishing library has 256 posts")
                };
                let d = Draft::new(title.clone());
                d.validate()?;
                let v = lib
                    .vault
                    .as_ref()
                    .context("Create or import your publishing key first")?;
                let mut salt = [0; 32];
                getrandom::fill(&mut salt).map_err(|_| anyhow!("Cannot obtain post entropy"))?;
                let key = MutableKey::new(
                    unhex(&v.public_key)?
                        .try_into()
                        .map_err(|_| anyhow!("Invalid key"))?,
                    salt.to_vec(),
                )?;
                let id = hex(&key.target());
                let f = Owned {
                    id: id.clone(),
                    magnet: bep46::format_magnet(&key),
                    title,
                    draft: d,
                    revision: 1,
                    published_revision: 0,
                    published_sequence: None,
                    published: None,
                    changed_at_us: crate::organization::now_us(),
                    signed_revision: 0,
                    pages: BTreeMap::new(),
                    record: None,
                    history: vec![],
                    active: true,
                    state: "Draft".into(),
                    error: String::new(),
                    pending: None,
                };
                let mut c = lib.clone();
                c.posts.insert(id.clone(), f);
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"id":id}))
            }
            Command::RemovePost { id } => {
                let f = lib.posts.get(&id).context("Own post not found")?;
                let operation = f.pending.as_ref().map(|p| p.id);
                let mut candidate = lib.clone();
                candidate.posts.remove(&id);
                // Commit before canceling: a failed write preserves the draft and job.
                persist(dir, &candidate)?;
                *lib = candidate;
                if let Some(job) = self.running.get(&id) {
                    job.cancel.store(true, Ordering::Release);
                }
                if let Some(operation) = operation {
                    self.clear_secret(operation);
                }
                self.renewals.remove(&id);
                Ok(serde_json::json!({"ok":true}))
            }
            Command::InspectEntry { id, page, infohash } => {
                let f = lib.posts.get(&id).context("Own post not found")?;
                let p = f
                    .draft
                    .pages
                    .iter()
                    .find(|p| p.id == page)
                    .context("Page unavailable")?;
                let data = p
                    .entries
                    .iter()
                    .find_map(|entry| {
                        if let feedtorrent_posts::publishing::Entry::Torrent { data, .. } = entry {
                            if let feedtorrent_bep::bep49::ItemContent::Torrent(t) =
                                feedtorrent_bep::bep49::inspect_item(data)
                            {
                                if hex(&t.infohash()) == infohash {
                                    return Some(data);
                                }
                            }
                        }
                        None
                    })
                    .context("Torrent is not referenced by this draft page")?;
                let mut view = crate::content::preview(data)?;
                view["source"] = serde_json::json!(data);
                Ok(view)
            }
            Command::GetPost { id } => {
                let f = lib.posts.get(&id).context("Own post not found")?;
                let mut value = reader_dates(dir, f);
                value["draft"] = serde_json::json!(f.draft);
                value["revision"] = serde_json::json!(f.revision);
                value["torrent_ids"] = serde_json::json!(reader_torrent_ids(&f.draft));
                Ok(value)
            }
            Command::SaveDraft {
                id,
                revision,
                draft,
            } => {
                draft.validate()?;
                let f = lib.posts.get(&id).context("Own post not found")?;
                if revision != f.revision {
                    bail!("Draft changed in another tab; reload before editing")
                };
                if f.draft == draft {
                    return Ok(serde_json::json!({"revision": f.revision}));
                }
                let mut c = lib.clone();
                let f = c.posts.get_mut(&id).unwrap();
                f.changed_at_us = crate::organization::now_us();
                f.title = draft
                    .pages
                    .iter()
                    .find(|p| p.id == draft.root)
                    .context("Missing root")?
                    .title
                    .clone();
                f.draft = draft;
                f.revision = f
                    .revision
                    .checked_add(1)
                    .context("Draft revision exhausted")?;
                let revision = f.revision;
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"revision":revision}))
            }
            Command::SetActive { id, active } => {
                if lib.posts.get(&id).is_some_and(|f| f.pending.is_some())
                    || self.running.contains_key(&id)
                {
                    bail!("Wait for the current publication")
                }
                let mut c = lib.clone();
                c.posts.get_mut(&id).context("Own post not found")?.active = active;
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"ok":true}))
            }
            Command::Publish {
                id,
                revision,
                password,
            } => {
                let f = lib.posts.get(&id).context("Own post not found")?;
                if f.pending.is_some() {
                    bail!("Publication busy; wait or cancel the current operation")
                }
                if f.revision != revision {
                    bail!("Draft changed; save it before publishing")
                }
                if password.0.is_empty() || password.0.len() > 4096 {
                    bail!("Enter a password between 1 and 4096 bytes")
                }
                let vault = lib.vault.clone().context("No publishing key")?;
                let mut c = lib.clone();
                let operation = allocate(&mut c)?;
                let f = c.posts.get_mut(&id).unwrap();
                f.pending = Some(pending(f, operation, false));
                f.active = true;
                f.state = "Queued".into();
                f.error.clear();
                persist(dir, &c)?;
                *lib = c;
                self.secrets
                    .insert(operation, Arc::new(Mutex::new(Some((vault, password)))));
                Ok(serde_json::json!({"operation":operation}))
            }
            Command::RetryPublication { id, operation } => {
                let mut c = lib.clone();
                let f = c.posts.get_mut(&id).context("Own post not found")?;
                let p = f
                    .pending
                    .as_mut()
                    .filter(|p| p.id == operation)
                    .context("Publication is no longer pending")?;
                if self.running.contains_key(&id) {
                    bail!("Publication already running")
                }
                p.retry_at = None;
                p.phase = "Queued".into();
                f.state = "Queued".into();
                f.error.clear();
                persist(dir, &c)?;
                *lib = c;
                Ok(serde_json::json!({"ok":true}))
            }
            Command::CancelPublication { id, operation } => {
                let mut c = lib.clone();
                let f = c.posts.get_mut(&id).context("Own post not found")?;
                let p = f
                    .pending
                    .as_ref()
                    .filter(|p| p.id == operation)
                    .context("Publication is no longer pending")?;
                f.error = if p.signed.is_some() {
                    "Publication canceled; announcements already sent cannot be withdrawn."
                } else {
                    "Publication canceled; draft preserved."
                }
                .into();
                f.pending = None;
                f.active = false;
                f.state = "Canceled".into();
                persist(dir, &c)?;
                *lib = c;
                if let Some(r) = self.running.get(&id).filter(|r| r.operation == operation) {
                    r.cancel.store(true, Ordering::Release);
                }
                self.clear_secret(operation);
                Ok(serde_json::json!({"ok":true}))
            }
        }
    }
    fn phase(&mut self, id: &str, operation: u64, state: String) -> Result<()> {
        if !self.current(id, operation) {
            bail!("Publication canceled or replaced")
        }
        let mut c = self.lib.clone();
        let f = c.posts.get_mut(id).unwrap();
        let p = f.pending.as_mut().unwrap();
        p.phase = state.clone();
        p.retry_at = None;
        f.state = if p.signed.is_some() {
            "Publication pending".into()
        } else {
            state
        };
        f.error.clear();
        self.commit(c)
    }
    fn signed(
        &mut self,
        id: &str,
        operation: u64,
        record: SignedRecord,
        pages: BTreeMap<u64, PageRef>,
        hashes: Vec<String>,
    ) -> Result<()> {
        if !self.current(id, operation) {
            bail!("Publication canceled or replaced")
        }
        let mut c = self.lib.clone();
        let f = c.posts.get_mut(id).unwrap();
        if f.published.is_none() {
            f.published = confirmed(f);
        }
        let p = f.pending.as_mut().unwrap();
        let key = bep46::parse_magnet(&f.magnet)?;
        let verified = record.verify(&key)?;
        if let Some(previous) = &f.record {
            select_mutable(Some(&previous.verify(&key)?), verified)?;
        }
        p.signed = Some(record.clone());
        p.pages = pages.clone();
        p.phase = "Publishing".into();
        f.record = Some(record);
        f.signed_revision = p.revision;
        f.pages = pages;
        for h in hashes {
            if !f.history.contains(&h) {
                f.history.push(h);
            }
        }
        f.state = "Publication pending".into();
        self.commit(c)
    }
    fn finished(
        &mut self,
        id: String,
        operation: u64,
        result: std::result::Result<u32, PublicationFailure>,
    ) {
        if self
            .running
            .get(&id)
            .is_some_and(|r| r.operation == operation)
        {
            self.running.remove(&id);
        }
        if self.stopping
            || self
                .lib
                .posts
                .get(&id)
                .and_then(|f| f.pending.as_ref())
                .is_none_or(|p| p.id != operation)
        {
            self.clear_secret(operation);
            return;
        }
        let mut c = self.lib.clone();
        let f = c.posts.get_mut(&id).unwrap();
        let p = f.pending.as_mut().unwrap();
        match result {
            Ok(_) => {
                if let Some(record) = &p.signed {
                    f.published_sequence = Some(record.sequence);
                }
                // Only an acknowledged operation becomes the reader's publication.
                if let Some(record) = &p.signed {
                    if let Ok(key) = bep46::parse_magnet(&f.magnet) {
                        if let Some(pointer) = record
                            .verify(&key)
                            .ok()
                            .and_then(|r| TorrentPointer::from_record(&key, r).ok())
                        {
                            let root = hex(&pointer.infohash());
                            if p.pages.values().any(|page| page.hash == root) {
                                f.published = Some(Published {
                                    root,
                                    pages: p.pages.clone(),
                                });
                            }
                        }
                    }
                }
                f.published_revision = p.revision;
                f.pending = None;
                f.state = "Published".into();
                f.error.clear();
                self.renewals
                    .insert(id, Instant::now() + Duration::from_secs(900));
            }
            Err(error) => {
                let credentials = self
                    .secrets
                    .get(&operation)
                    .is_some_and(|s| s.lock().is_ok_and(|s| s.is_some()));
                if error.transient && (p.signed.is_some() || credentials) {
                    p.phase = "Retrying".into();
                    p.retry_at = Some(now_ms().saturating_add(
                        self.retry_delay.as_millis().try_into().unwrap_or(u64::MAX),
                    ));
                    f.state = "Publication pending".into();
                    f.error = error.message;
                } else {
                    f.pending = None;
                    f.active = false;
                    f.state = "Error".into();
                    f.error = error.message;
                }
            }
        }
        let finished = f.pending.is_none();
        if let Err(e) = self.commit(c) {
            self.error = format!("Publishing persistence: {e:#}");
        }
        if finished {
            self.clear_secret(operation);
        }
    }
    fn pump(&mut self) -> Result<()> {
        if self.stopping || self.disabled.is_some() || !self.error.is_empty() {
            return Ok(());
        }
        while self.running.len() < 2 {
            let ready = self
                .lib
                .posts
                .values()
                .filter(|f| !self.running.contains_key(&f.id))
                .filter_map(|f| {
                    f.pending
                        .as_ref()
                        .filter(|p| p.retry_at.is_none_or(|at| at <= now_ms()))
                        .map(|p| (p.id, f.id.clone()))
                })
                .min();
            let id = if let Some((_, id)) = ready {
                id
            } else {
                let renewal = self
                    .lib
                    .posts
                    .values()
                    .find(|f| {
                        f.active
                            && f.pending.is_none()
                            && f.state == "Published"
                            && f.record.is_some()
                            && !self.running.contains_key(&f.id)
                            && self
                                .renewals
                                .get(&f.id)
                                .is_none_or(|t| *t <= Instant::now())
                    })
                    .map(|f| f.id.clone());
                let Some(id) = renewal else { break };
                let mut c = self.lib.clone();
                let operation = allocate(&mut c)?;
                let f = c.posts.get_mut(&id).unwrap();
                f.pending = Some(pending(f, operation, true));
                f.state = "Queued".into();
                self.commit(c)?;
                id
            };
            let mut c = self.lib.clone();
            let f = c.posts.get_mut(&id).unwrap();
            let p = f.pending.as_mut().unwrap();
            p.retry_at = None;
            p.phase = "Preparing".into();
            let p = p.clone();
            let f = f.clone();
            self.commit(c)?;
            let cancel = Arc::new(AtomicBool::new(false));
            self.running.insert(
                id.clone(),
                Running {
                    operation: p.id,
                    cancel: cancel.clone(),
                },
            );
            let secrets = self
                .secrets
                .entry(p.id)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone();
            let work = Work {
                id: id.clone(),
                operation: p.id,
                cancel,
                secrets,
                tx: self.tx.clone(),
            };
            let (native, dir, tx) = (self.native.clone(), self.dir.clone(), self.tx.clone());
            self.handles.push(std::thread::spawn(move || {
                let result =
                    publish(&dir, &f, &p, &native, &work).map_err(PublicationFailure::from);
                let _ = tx.send(Message::Finished {
                    id,
                    operation: p.id,
                    result,
                });
            }));
        }
        Ok(())
    }
    fn stop(&mut self) {
        self.stopping = true;
        for r in self.running.values() {
            r.cancel.store(true, Ordering::Release);
        }
        for (_, secret) in std::mem::take(&mut self.secrets) {
            if let Ok(mut value) = secret.lock() {
                *value = None;
            }
        }
        // A failed load uses an empty in-memory view, never a replacement library.
        if self.disabled.is_some() {
            return;
        }
        let mut c = self.lib.clone();
        if let Err(e) = recover(&mut c).and_then(|_| self.commit(c)) {
            self.error = format!("Publishing shutdown: {e:#}");
        }
    }
    fn message(&mut self, message: Message) {
        match message {
            Message::Command(command, reply) => {
                let writes = !matches!(&command, Command::Preview { .. } | Command::GetPost { .. });
                let result = self.command(command);
                if writes && result.is_ok() {
                    self.error.clear();
                }
                // Publish is acknowledged only after the immutable job is saved.
                self.views.send_replace(self.current_view());
                let _ = reply.send(result.map_err(|e| format!("{e:#}")));
            }
            Message::Phase {
                id,
                operation,
                state,
                reply,
            } => {
                let result = self.phase(&id, operation, state);
                let _ = reply.send(result.map_err(|e| format!("{e:#}")));
            }
            Message::Signed {
                id,
                operation,
                record,
                pages,
                hashes,
                reply,
            } => {
                let result = self.signed(&id, operation, record, pages, hashes);
                let _ = reply.send(result.map_err(|e| format!("{e:#}")));
            }
            Message::Finished {
                id,
                operation,
                result,
            } => self.finished(id, operation, result),
            Message::Export { full, reply } => {
                let result =
                    backup::export(&self.dir, &self.lib, full).map_err(|e| format!("{e:#}"));
                if let Err(Ok(path)) = reply.send(result) {
                    let _ = fs::remove_file(path);
                }
            }
            Message::Import {
                path,
                password,
                reply,
            } => {
                let result = if let Some(error) = &self.disabled {
                    Err(anyhow!(error.clone()))
                } else if self.running.is_empty()
                    && self.lib.posts.values().all(|f| f.pending.is_none())
                {
                    File::open(path)
                        .map_err(Into::into)
                        .and_then(|file| {
                            backup::import_reader(&self.dir, &self.lib, file, &password)
                        })
                        .map(|lib| {
                            self.lib = lib;
                            serde_json::json!({"ok":true})
                        })
                } else {
                    Err(anyhow!("Wait for pending publications before importing"))
                };
                let _ = reply.send(result.map_err(|e| format!("{e:#}")));
            }
            Message::ReadBody { path, reply } => {
                let result = (|| -> Result<serde_json::Value> {
                    if fs::metadata(&path)?.len() > feedtorrent_posts::publishing::MAX_BODY as u64 {
                        bail!("Markdown exceeds 1 MiB")
                    }
                    let mut bytes = vec![];
                    File::open(path)?
                        .take(feedtorrent_posts::publishing::MAX_BODY as u64 + 1)
                        .read_to_end(&mut bytes)?;
                    let text = std::str::from_utf8(&bytes).context("Markdown must be UTF-8")?;
                    Ok(serde_json::json!({"body":feedtorrent_posts::markdown::parse(text)?}))
                })();
                let _ = reply.send(result.map_err(|e| format!("{e:#}")));
            }
            Message::Stop => self.stop(),
        }
    }
}
pub(super) fn start(
    data_dir: &Path,
    native: mpsc::SyncSender<NativeTask>,
    retry_delay: Duration,
) -> Result<(Client, std::thread::JoinHandle<()>)> {
    use std::os::unix::fs::PermissionsExt;
    let dir = data_dir.to_path_buf();
    let initial = (|| -> Result<Library> {
        fs::create_dir_all(dir.join("published"))?;
        reject_symlinks(&dir.join("published"))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        let mut lib = load(&dir)?;
        if recover(&mut lib)? {
            persist(&dir, &lib)?;
        }
        Ok(lib)
    })();
    let (lib, disabled) = match initial {
        Ok(lib) => (lib, None),
        Err(e) => (
            Library::default(),
            Some(format!(
                "Publishing unavailable: {e:#}; original data preserved"
            )),
        ),
    };
    let (tx, rx) = mpsc::sync_channel(32);
    let (views, view_rx) = watch::channel(view(&lib, disabled.clone().unwrap_or_default()));
    let client = Client {
        tx: tx.clone(),
        view: view_rx,
    };
    let thread = std::thread::spawn(move || {
        let mut m = Manager {
            dir,
            lib,
            disabled,
            error: String::new(),
            tx,
            native,
            views,
            running: BTreeMap::new(),
            secrets: BTreeMap::new(),
            handles: vec![],
            renewals: BTreeMap::new(),
            retry_delay,
            stopping: false,
        };
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(message) => m.message(message),
                Err(mpsc::RecvTimeoutError::Disconnected) => m.stop(),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            m.handles.retain(|h| !h.is_finished());
            if m.stopping && m.running.is_empty() {
                break;
            }
            if let Err(e) = m.pump() {
                m.error = format!("Publishing queue: {e:#}");
            }
            m.views.send_replace(m.current_view());
        }
        for handle in m.handles {
            let _ = handle.join();
        }
    });
    Ok((client, thread))
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
