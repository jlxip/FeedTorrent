//! Explicit publication worker. Neither slow cryptography nor construction runs
//! on the HTTP executor or the libtorrent actor. Secrets never enter native RPC.
use super::*;
use crate::publishing_keys::{Password, Vault};
use feedtorrent_bep::{
    bep44::{select_mutable, Bep44Signer, MutableKey, MutableRecord},
    bep46::{self, TorrentPointer},
    bep49::Feed,
};
use feedtorrent_posts::{
    hex,
    publishing::{BuiltCatalog, Draft, Previous},
    unhex, SignedRecord,
};
use std::{
    collections::BTreeSet,
    io::{Cursor, Read},
    sync::atomic::{AtomicU64, Ordering},
};
mod backup;
pub mod http;
mod native;
mod queue;
pub use native::{Bridge, NativeTask};
use native::{Native, NativeReply, Seed};
const MAX_LIBRARY: usize = 256 * 1024 * 1024;
#[derive(Clone, Default, Debug, Serialize)]
pub struct View {
    pub has_key: bool,
    pub public_key: String,
    pub posts: Vec<OwnView>,
    pub error: String,
    #[serde(skip)]
    pub(crate) retention: BTreeMap<String, BTreeSet<String>>,
    #[serde(skip)]
    pub(crate) entries: BTreeMap<String, BTreeSet<String>>,
    #[serde(skip)]
    pub(crate) busy: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct OwnView {
    pub id: String,
    pub title: String,
    pub magnet: String,
    pub revision: u64,
    pub published_revision: u64,
    pub changed_at_us: u64,
    pub sequence: Option<String>,
    pub state: String,
    pub error: String,
    pub active: bool,
    pub operation: Option<u64>,
    pub pending_revision: Option<u64>,
    pub phase: String,
    pub next_retry_at: Option<u64>,
}
// Derived response data only; never part of the saved draft or signed catalogs.
fn reader_torrent_ids(draft: &Draft) -> Vec<serde_json::Value> {
    let mut ids = Vec::new();
    for page in &draft.pages {
        for (index, entry) in page.entries.iter().enumerate() {
            if let feedtorrent_posts::publishing::Entry::Torrent { data, .. } = entry {
                if let feedtorrent_bep::bep49::ItemContent::Torrent(t) =
                    feedtorrent_bep::bep49::inspect_item(data)
                {
                    ids.push(serde_json::json!({"page":page.id,"index":index,"infohash":hex(&t.infohash())}));
                }
            }
        }
    }
    ids
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owned {
    id: String,
    magnet: String,
    title: String,
    draft: Draft,
    revision: u64,
    published_revision: u64,
    #[serde(default)]
    changed_at_us: u64,
    #[serde(default)]
    signed_revision: u64,
    pages: BTreeMap<u64, PageRef>,
    record: Option<SignedRecord>,
    history: Vec<String>,
    active: bool,
    state: String,
    error: String,
    #[serde(default)]
    pending: Option<queue::Pending>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageRef {
    fingerprint: String,
    hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Library {
    version: u32,
    vault: Option<Vault>,
    #[serde(alias = "feeds")]
    posts: BTreeMap<String, Owned>,
    #[serde(default = "queue::first_operation")]
    next_operation: u64,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            version: 2,
            vault: None,
            posts: BTreeMap::new(),
            next_operation: 1,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    metainfo: Vec<u8>,
    files: Vec<(Vec<String>, Vec<u8>)>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Preview {
        body: String,
    },
    CreateKey {
        password: Password,
        confirmation: Password,
    },
    CreatePost {
        title: String,
    },
    GetPost {
        id: String,
    },
    RemovePost {
        id: String,
    },
    InspectEntry {
        id: String,
        page: u64,
        infohash: String,
    },
    SaveDraft {
        id: String,
        revision: u64,
        draft: Draft,
    },
    Publish {
        id: String,
        revision: u64,
        password: Password,
    },
    RetryPublication {
        id: String,
        operation: u64,
    },
    CancelPublication {
        id: String,
        operation: u64,
    },
    SetActive {
        id: String,
        active: bool,
    },
    ChangePassword {
        old: Password,
        password: Password,
        confirmation: Password,
    },
}
// No Debug implementation: even a future added secret cannot leak by accident.
struct PublicationFailure {
    message: String,
    transient: bool,
}
impl From<anyhow::Error> for PublicationFailure {
    fn from(e: anyhow::Error) -> Self {
        let transient = e
            .downcast_ref::<native::Failure>()
            .is_some_and(|e| e.transient());
        Self {
            message: format!("{e:#}"),
            transient,
        }
    }
}
enum Message {
    Command(
        Command,
        oneshot::Sender<std::result::Result<serde_json::Value, String>>,
    ),
    Phase {
        id: String,
        operation: u64,
        state: String,
        reply: mpsc::Sender<std::result::Result<(), String>>,
    },
    Signed {
        id: String,
        operation: u64,
        record: SignedRecord,
        pages: BTreeMap<u64, PageRef>,
        hashes: Vec<String>,
        reply: mpsc::Sender<std::result::Result<(), String>>,
    },
    Finished {
        id: String,
        operation: u64,
        result: std::result::Result<u32, PublicationFailure>,
    },
    Export {
        full: bool,
        reply: oneshot::Sender<std::result::Result<PathBuf, String>>,
    },
    Import {
        bytes: Vec<u8>,
        password: Password,
        reply: oneshot::Sender<std::result::Result<serde_json::Value, String>>,
    },
    ReadBody {
        path: PathBuf,
        reply: oneshot::Sender<std::result::Result<serde_json::Value, String>>,
    },
    Stop,
}
#[derive(Clone)]
pub struct Client {
    tx: mpsc::SyncSender<Message>,
    pub view: watch::Receiver<View>,
}
impl Client {
    pub async fn call(&self, command: Command) -> std::result::Result<serde_json::Value, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Message::Command(command, tx))
            .map_err(|_| "Publishing service busy or stopped".to_string())?;
        rx.await
            .map_err(|_| "Publishing service stopped".to_string())?
    }
    pub async fn export(&self, full: bool) -> std::result::Result<PathBuf, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Message::Export { full, reply: tx })
            .map_err(|_| "Publishing service busy".to_string())?;
        rx.await
            .map_err(|_| "Publishing service stopped".to_string())?
    }
    pub async fn import(
        &self,
        bytes: Vec<u8>,
        password: Password,
    ) -> std::result::Result<serde_json::Value, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Message::Import {
                bytes,
                password,
                reply: tx,
            })
            .map_err(|_| "Publishing service busy".to_string())?;
        rx.await
            .map_err(|_| "Publishing service stopped".to_string())?
    }
    pub async fn read_body(&self, path: PathBuf) -> std::result::Result<serde_json::Value, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Message::ReadBody { path, reply: tx })
            .map_err(|_| "Reader busy".to_string())?;
        rx.await.map_err(|_| "Reader stopped".to_string())?
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Message::Stop);
    }
}
fn read(path: &Path) -> Result<Vec<u8>> {
    if fs::metadata(path)?.len() > MAX_LIBRARY as u64 {
        bail!("Publishing data exceeds 256 MiB")
    };
    Ok(fs::read(path)?)
}
fn save(path: &Path, data: &[u8]) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let tmp = path.with_extension(format!("tmp-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        File::open(path.parent().context("Missing parent")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn persist(dir: &Path, lib: &Library) -> Result<()> {
    let bytes = serde_json::to_vec(lib)?;
    if bytes.len() > MAX_LIBRARY {
        bail!("Publishing library exceeds 256 MiB")
    }
    save(&dir.join("library.json"), &bytes)
}
fn load(dir: &Path) -> Result<Library> {
    let p = dir.join("library.json");
    if !p.exists() {
        return Ok(Library::default());
    }
    let l: Library = serde_json::from_slice(&read(&p)?)?;
    validate(&l)?;
    Ok(l)
}
fn validate(lib: &Library) -> Result<()> {
    if !matches!(lib.version, 1 | 2) || lib.posts.len() > 256 || lib.next_operation == 0 {
        bail!("Unsupported publishing library or too many posts")
    }
    if let Some(vault) = &lib.vault {
        vault.validate()?;
    }
    let mut operations = BTreeSet::new();
    for (id, f) in &lib.posts {
        let key = bep46::parse_magnet(&f.magnet)?;
        if id != &hex(&key.target())
            || id != &f.id
            || lib
                .vault
                .as_ref()
                .is_none_or(|v| v.public_key != hex(&key.public_key()))
        {
            bail!("Publishing identity mismatch")
        };
        f.draft.validate()?;
        if let Some(p) = &f.pending {
            p.validate(f, lib.next_operation, &mut operations)?;
        }
        if let Some(r) = &f.record {
            TorrentPointer::from_record(&key, r.verify(&key)?)?;
        }
        for hash in f.history.iter().chain(f.pages.values().map(|p| &p.hash)) {
            if !valid_id(hash) {
                bail!("Invalid catalog hash")
            }
        }
    }
    Ok(())
}
fn view(lib: &Library, error: String) -> View {
    let retention = lib
        .posts
        .iter()
        .map(|(id, p)| {
            let mut hashes: BTreeSet<_> = p
                .history
                .iter()
                .cloned()
                .chain(p.pages.values().map(|p| p.hash.clone()))
                .collect();
            if let Some(p) = &p.pending {
                hashes.extend(p.pages.values().map(|p| p.hash.clone()));
            }
            (id.clone(), hashes)
        })
        .collect();
    let entries = lib
        .posts
        .iter()
        .map(|(id, p)| {
            (
                id.clone(),
                reader_torrent_ids(&p.draft)
                    .iter()
                    .filter_map(|e| e["infohash"].as_str().map(str::to_owned))
                    .collect(),
            )
        })
        .collect();
    View {
        retention,
        entries,
        busy: BTreeSet::new(),
        has_key: lib.vault.is_some(),
        public_key: lib
            .vault
            .as_ref()
            .map(|v| v.public_key.clone())
            .unwrap_or_default(),
        error,
        posts: lib
            .posts
            .values()
            .map(|f| OwnView {
                id: f.id.clone(),
                title: f.title.clone(),
                magnet: f.magnet.clone(),
                revision: f.revision,
                published_revision: f.published_revision,
                changed_at_us: f.changed_at_us,
                sequence: f.record.as_ref().map(|r| r.sequence.to_string()),
                state: f.state.clone(),
                error: f.error.clone(),
                active: f.active,
                operation: f.pending.as_ref().map(|p| p.id),
                pending_revision: f.pending.as_ref().map(|p| p.revision),
                phase: f
                    .pending
                    .as_ref()
                    .map_or_else(|| f.state.clone(), |p| p.phase.clone()),
                next_retry_at: f.pending.as_ref().and_then(|p| p.retry_at),
            })
            .collect(),
    }
}
pub fn start(
    data_dir: &Path,
    native: mpsc::SyncSender<NativeTask>,
) -> Result<(Client, std::thread::JoinHandle<()>)> {
    start_with_retry_delay(data_dir, native, Duration::from_secs(30))
}
fn start_with_retry_delay(
    data_dir: &Path,
    native: mpsc::SyncSender<NativeTask>,
    retry_delay: Duration,
) -> Result<(Client, std::thread::JoinHandle<()>)> {
    queue::start(data_dir, native, retry_delay)
}
#[cfg(test)]
fn call(native: &mpsc::SyncSender<NativeTask>, command: Native) -> Result<NativeReply> {
    queue::call(
        native,
        command,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
}
fn package_path(dir: &Path, hash: &str) -> Result<PathBuf> {
    if !valid_id(hash) {
        bail!("Invalid catalog identifier")
    };
    Ok(dir.join("catalogs").join(format!("{hash}.json")))
}
fn package(dir: &Path, hash: &str) -> Result<Package> {
    let p: Package = serde_json::from_slice(&read(&package_path(dir, hash)?)?)?;
    feedtorrent_posts::publishing::verify_payload(&p.metainfo, &p.files)?;
    if hex(&Feed::from_metainfo(&p.metainfo)?.infohash()) != hash {
        bail!("Saved catalog identity mismatch")
    };
    Ok(p)
}
fn store_package(dir: &Path, c: &BuiltCatalog) -> Result<String> {
    let id = hex(&Feed::from_metainfo(&c.metainfo)?.infohash());
    let p = Package {
        metainfo: c.metainfo.clone(),
        files: c
            .files
            .iter()
            .map(|f| (f.path.clone(), f.data.clone()))
            .collect(),
    };
    let path = package_path(dir, &id)?;
    if !path.exists() {
        save(&path, &serde_json::to_vec(&p)?)?
    }
    Ok(id)
}
fn publish(
    dir: &Path,
    f: &Owned,
    pending: &queue::Pending,
    native: &mpsc::SyncSender<NativeTask>,
    work: &queue::Work,
) -> Result<u32> {
    let key = bep46::parse_magnet(&f.magnet)?;
    work.phase("Checking DHT")?;
    let NativeReply::Record(remote) = work.call(native, Native::Lookup(key.clone()))? else {
        bail!("Unexpected DHT response")
    };
    let known = f.record.as_ref().map(|r| r.verify(&key)).transpose()?;
    if let Some(r) = &remote {
        let r = r.verify(&key)?;
        if let Some(k) = &known {
            if r.sequence() >= k.sequence() {
                select_mutable(Some(k), r.clone())?;
            }
            if r.sequence() > k.sequence() && r.value() != k.value() {
                bail!("External revision differs; publication blocked")
            }
        } else {
            bail!("Post identity already has a published revision")
        }
    }
    let (record, pages) = if let Some(record) = &pending.signed {
        let k = record.verify(&key)?;
        if remote.as_ref().is_some_and(|r| r.sequence > k.sequence()) {
            bail!("Newer external revision; republication blocked")
        }
        work.phase("Checking catalogs")?;
        work.call(
            native,
            Native::Ready(pending.pages.values().map(|p| p.hash.clone()).collect()),
        )?;
        (record.clone(), pending.pages.clone())
    } else {
        work.phase("Preparing")?;
        let signer = work.signer()?;
        let previous = f
            .pages
            .iter()
            .map(|(id, p)| {
                Ok((
                    *id,
                    Previous {
                        fingerprint: p.fingerprint.clone(),
                        metainfo: package(dir, &p.hash)?.metainfo,
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let previous_root = known
            .as_ref()
            .map(|r| TorrentPointer::from_record(&key, r.clone()).map(|p| p.infohash()))
            .transpose()?;
        let built = pending
            .draft
            .build_with_previous_root(&key, &previous, previous_root)?;
        work.check()?;
        for c in &built.catalogs {
            work.check()?;
            let (post, operation) = work.identity();
            work.call(
                native,
                Native::Reserve {
                    post: post.into(),
                    operation,
                    metainfo: c.metainfo.clone(),
                },
            )?;
            let children = c
                .files
                .iter()
                .filter_map(
                    |file| match feedtorrent_bep::bep49::inspect_item(&file.data) {
                        feedtorrent_bep::bep49::ItemContent::Torrent(t) => Some(hex(&t.infohash())),
                        _ => None,
                    },
                )
                .collect();
            let parent = hex(&Feed::from_metainfo(&c.metainfo)?.infohash());
            work.call(
                native,
                Native::Link {
                    post: post.into(),
                    operation,
                    parent,
                    children,
                },
            )?;
            store_package(dir, c)?;
        }
        let pages = built
            .pages
            .into_iter()
            .map(|(id, p)| {
                Ok((
                    id,
                    PageRef {
                        fingerprint: p.fingerprint,
                        hash: hex(&Feed::from_metainfo(&p.metainfo)?.infohash()),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        work.phase("Checking catalogs")?;
        seed_pages(dir, &pages, native, work)?;
        let seq = known
            .as_ref()
            .map_or(-1, |r| r.sequence())
            .max(remote.as_ref().map_or(-1, |r| r.sequence))
            .checked_add(1)
            .context("BEP 44 sequence exhausted")?;
        let pointer = TorrentPointer::sign(&signer, built.root, seq, key.salt().to_vec())?;
        drop(signer);
        let record = SignedRecord::from_record(pointer.record());
        (record, pages)
    };
    work.signed(record.clone(), pages)?;
    work.phase("Publishing")?;
    let NativeReply::Stored(count) = work.call(native, Native::Put(record.verify(&key)?))? else {
        bail!("Unexpected publication response")
    };
    if count == 0 {
        return Err(
            native::Failure::Dht(feedtorrent_bep::bep44::DhtError::NoAcknowledgements).into(),
        );
    }
    Ok(count)
}
fn seed_pages(
    dir: &Path,
    pages: &BTreeMap<u64, PageRef>,
    native: &mpsc::SyncSender<NativeTask>,
    work: &queue::Work,
) -> Result<()> {
    let mut seeds = vec![];
    for p in pages.values() {
        work.check()?;
        let pack = package(dir, &p.hash)?;
        let (post, operation) = work.identity();
        work.call(
            native,
            Native::Reserve {
                post: post.into(),
                operation,
                metainfo: pack.metainfo.clone(),
            },
        )?;
        let NativeReply::Location(path) = work.call(native, Native::Location(p.hash.clone()))?
        else {
            bail!("Invalid transfer path response")
        };
        let post = Feed::from_metainfo(&pack.metainfo)?;
        for (parts, bytes) in &pack.files {
            work.check()?;
            if !post
                .entries()
                .iter()
                .any(|f| f.path() == *parts && f.length() == bytes.len() as u64)
            {
                bail!("Saved payload disagrees with metadata")
            }
            let target = parts.iter().fold(path.join(post.name()), |p, n| p.join(n));
            fs::create_dir_all(target.parent().context("Missing catalog directory")?)?;
            reject_symlinks(&path)?;
            if target.exists() {
                if read(&target)? != *bytes {
                    bail!("Existing catalog file differs; files preserved")
                }
            } else {
                save(&target, bytes)?
            }
        }
        seeds.push(Seed {
            id: p.hash.clone(),
            metainfo: pack.metainfo,
            path,
        });
    }
    work.call(native, Native::Seed(seeds))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) async fn until(client: &Client, predicate: impl Fn(&View) -> bool) {
        for _ in 0..200 {
            if predicate(&client.view.borrow()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await
        }
        panic!("Publication worker did not reach expected state")
    }
    pub(super) fn root() -> PathBuf {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        let p = std::env::temp_dir().join(format!("feedtorrent-publishing-{}", hex(&id)));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[tokio::test]
    async fn no_ack_is_durable_and_restart_reuses_exact_record() {
        let dir = root();
        let (tx, rx) = mpsc::sync_channel::<NativeTask>(16);
        let records = Arc::new(std::sync::Mutex::new(vec![]));
        let seen = records.clone();
        let folder = dir.clone();
        let native = std::thread::spawn(move || {
            let mut first = true;
            for task in rx {
                let reply = match task.command {
                    Native::Lookup(_) => Ok(NativeReply::Record(None)),
                    Native::Location(id) => {
                        let p = folder.join("payload").join(id);
                        fs::create_dir_all(&p).unwrap();
                        Ok(NativeReply::Location(p))
                    }
                    Native::Link { .. }
                    | Native::Reserve { .. }
                    | Native::Seed(_)
                    | Native::Ready(_) => Ok(NativeReply::Ready),
                    Native::Put(record) => {
                        let lib = load(&folder.join("publishing")).unwrap();
                        assert!(lib.posts.values().any(|f| f
                            .record
                            .as_ref()
                            .is_some_and(|r| r.signature == record.signature())));
                        seen.lock().unwrap().push(record);
                        let count = if first {
                            first = false;
                            0
                        } else {
                            2
                        };
                        Ok(NativeReply::Stored(count))
                    }
                };
                let _ = task.reply.send(reply);
            }
        });
        let (client, worker) = start(&dir, tx.clone()).unwrap();
        let password = "worker test passphrase";
        client
            .call(Command::CreateKey {
                password: Password(password.into()),
                confirmation: Password(password.into()),
            })
            .await
            .unwrap();
        let id = client
            .call(Command::CreatePost {
                title: "worker".into(),
            })
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut draft = Draft::new("worker".into());
        draft.pages[0].body = "durable".into();
        client
            .call(Command::SaveDraft {
                id: id.clone(),
                revision: 1,
                draft,
            })
            .await
            .unwrap();
        client
            .call(Command::Publish {
                id: id.clone(),
                revision: 2,
                password: Password(password.into()),
            })
            .await
            .unwrap();
        until(&client, |v| {
            v.posts.iter().any(|f| {
                f.state == "Publication pending" && !f.error.is_empty() && f.operation.is_some()
            })
        })
        .await;
        client.stop();
        worker.join().unwrap();
        drop(client);
        let (client, worker) = start(&dir, tx.clone()).unwrap();
        until(&client, |v| {
            v.posts
                .iter()
                .any(|f| f.state == "Published" && f.published_revision == 2)
        })
        .await;
        client.stop();
        worker.join().unwrap();
        drop(client);
        drop(tx);
        native.join().unwrap();
        let records = records.lock().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0], records[1]);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn failed_draft_commit_preserves_memory_and_disk() {
        let dir = root();
        let (tx, _rx) = mpsc::sync_channel(1);
        let (client, worker) = start(&dir, tx).unwrap();
        let password = "persistence test passphrase";
        client
            .call(Command::CreateKey {
                password: Password(password.into()),
                confirmation: Password(password.into()),
            })
            .await
            .unwrap();
        let id = client
            .call(Command::CreatePost {
                title: "safe".into(),
            })
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let path = dir.join("publishing/library.json");
        let original = fs::read(&path).unwrap();
        fs::rename(&path, path.with_extension("preserved")).unwrap();
        fs::create_dir(&path).unwrap();
        let result = client
            .call(Command::SaveDraft {
                id: id.clone(),
                revision: 1,
                draft: Draft::new("changed".into()),
            })
            .await;
        assert!(result.is_err());
        let draft = client.call(Command::GetPost { id }).await.unwrap();
        assert_eq!(draft["revision"], 1);
        assert_eq!(draft["draft"]["pages"][0]["title"], "safe");
        assert_eq!(
            fs::read(path.with_extension("preserved")).unwrap(),
            original
        );
        client.stop();
        worker.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn corrupt_library_disables_only_publication_and_preserves_original() {
        let dir = root();
        fs::create_dir_all(dir.join("publishing")).unwrap();
        let path = dir.join("publishing/library.json");
        fs::write(&path, b"invalid original").unwrap();
        let (tx, _rx) = mpsc::sync_channel(1);
        let (client, worker) = start(&dir, tx).unwrap();
        assert!(client
            .view
            .borrow()
            .error
            .contains("original data preserved"));
        assert!(client
            .call(Command::CreatePost {
                title: "blocked".into()
            })
            .await
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid original");
        client.stop();
        worker.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"invalid original");
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn crash_before_signing_recovers_draft_without_publishing() {
        let dir = root();
        let (tx, rx) = mpsc::sync_channel(1);
        let (client, worker) = start(&dir, tx.clone()).unwrap();
        let password = "interrupted test passphrase";
        client
            .call(Command::CreateKey {
                password: Password(password.into()),
                confirmation: Password(password.into()),
            })
            .await
            .unwrap();
        let id = client
            .call(Command::CreatePost {
                title: "durable draft".into(),
            })
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        client.stop();
        worker.join().unwrap();
        drop(client);
        let folder = dir.join("publishing");
        let mut lib = load(&folder).unwrap();
        lib.posts.get_mut(&id).unwrap().state = "Preparing".into();
        persist(&folder, &lib).unwrap();
        let (client, worker) = start(&dir, tx).unwrap();
        assert!(client.view.borrow().posts[0].error.contains("interrupted"));
        assert_eq!(client.view.borrow().posts[0].operation, None);
        assert!(rx.try_recv().is_err());
        assert_eq!(
            client.call(Command::GetPost { id }).await.unwrap()["draft"]["pages"][0]["title"],
            "durable draft"
        );
        client.stop();
        worker.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn pending_publication_survives_retry_lookup_timeout_without_resigning() {
        use feedtorrent_bep::bep44::DhtError;
        let dir = root();
        let (tx, rx) = mpsc::sync_channel::<NativeTask>(16);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = seen.clone();
        let folder = dir.clone();
        let native = std::thread::spawn(move || {
            let mut puts = 0;
            let mut lookup_failed = false;
            for task in rx {
                let result = match task.command {
                    Native::Lookup(_) => {
                        if puts == 1 && !lookup_failed {
                            lookup_failed = true;
                            Err(native::Failure::Dht(DhtError::Timeout))
                        } else {
                            Ok(NativeReply::Record(None))
                        }
                    }
                    Native::Location(id) => {
                        let p = folder.join("payload").join(id);
                        fs::create_dir_all(&p).unwrap();
                        Ok(NativeReply::Location(p))
                    }
                    Native::Link { .. }
                    | Native::Reserve { .. }
                    | Native::Seed(_)
                    | Native::Ready(_) => Ok(NativeReply::Ready),
                    Native::Put(record) => {
                        puts += 1;
                        observed.lock().unwrap().push(record);
                        if puts == 1 {
                            Err(native::Failure::Dht(DhtError::Timeout))
                        } else {
                            Ok(NativeReply::Stored(2))
                        }
                    }
                };
                let _ = task.reply.send(result);
            }
            assert!(lookup_failed);
        });
        let (client, worker) =
            start_with_retry_delay(&dir, tx.clone(), Duration::from_millis(10)).unwrap();
        let password = "retry regression passphrase";
        client
            .call(Command::CreateKey {
                password: Password(password.into()),
                confirmation: Password(password.into()),
            })
            .await
            .unwrap();
        let id = client
            .call(Command::CreatePost {
                title: "saved publication".into(),
            })
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut draft = Draft::new("saved publication".into());
        draft.pages[0].body = "retain exact signature".into();
        client
            .call(Command::SaveDraft {
                id: id.clone(),
                revision: 1,
                draft,
            })
            .await
            .unwrap();
        client
            .call(Command::Publish {
                id,
                revision: 2,
                password: Password(password.into()),
            })
            .await
            .unwrap();
        until(&client, |v| {
            v.posts
                .iter()
                .any(|f| f.state == "Published" && f.published_revision == 2)
        })
        .await;
        client.stop();
        worker.join().unwrap();
        drop(client);
        drop(tx);
        native.join().unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1]);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn publication_conflicts_and_host_errors_are_not_retried_as_network_failures() {
        use feedtorrent_bep::bep44::DhtError;
        assert!(
            PublicationFailure::from(anyhow::Error::new(native::Failure::Dht(DhtError::Timeout)))
                .transient
        );
        assert!(
            !PublicationFailure::from(anyhow::Error::new(native::Failure::Dht(DhtError::Conflict)))
                .transient
        );
        assert!(
            !PublicationFailure::from(anyhow::Error::new(native::Failure::Other(
                "Catalog is paused".into()
            )))
            .transient
        );
    }

    #[test]
    fn stopped_transport_preserves_the_pending_publication_for_restart() {
        let (tx, rx) = mpsc::sync_channel(1);
        drop(rx);
        let error = match call(&tx, Native::Ready(vec![])) {
            Err(e) => e,
            Ok(_) => panic!("Closed transport accepted a command"),
        };
        assert!(PublicationFailure::from(error).transient);
    }
}

#[cfg(test)]
mod reader_tests {
    use super::*;
    #[test]
    fn reader_ids_are_derived_without_mutating_draft() {
        let mut draft = Draft::new("page".into());
        draft.pages[0]
            .entries
            .push(feedtorrent_posts::publishing::Entry::Torrent {
                name: "x.torrent".into(),
                data: b"d4:infod6:lengthi0e4:name1:x12:piece lengthi16384e6:pieces0:ee".to_vec(),
            });
        let before = serde_json::to_vec(&draft).unwrap();
        assert_eq!(
            reader_torrent_ids(&draft),
            vec![
                serde_json::json!({"page":1,"index":0,"infohash":"2ff89194550e83efb975086f9b976f1bc5252e70"})
            ]
        );
        assert_eq!(before, serde_json::to_vec(&draft).unwrap());
    }
}
