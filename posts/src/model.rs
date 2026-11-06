use feedtorrent_bep::{bep44::*, bep46};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub const DEFAULT_LIMIT: u64 = 8 * 1024 * 1024;
pub const MAX_METAINFO: usize = 8 * 1024 * 1024;
pub const POLL_MS: u64 = 15 * 60 * 1000;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
pub(crate) fn err(e: impl std::fmt::Display) -> Error {
    Error(e.to_string())
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex(s: &str) -> Result<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return Err(err("Invalid hexadecimal value"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(err))
        .collect()
}
pub fn hash(s: &str) -> Result<[u8; 20]> {
    unhex(s)?
        .try_into()
        .map_err(|_| err("Invalid torrent identifier"))
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    CurrentCatalog,
    MirrorCatalogs,
    MirrorAll,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub mode: Mode,
    pub automatic_limit: Option<u64>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            name: String::new(),
            mode: Mode::CurrentCatalog,
            automatic_limit: Some(DEFAULT_LIMIT),
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.name.chars().count() > 256 || self.automatic_limit == Some(0) {
            Err(err("Invalid post name or automatic download limit"))
        } else {
            Ok(())
        }
    }
}
/// Public, already signed data. No signing seeds are ever owned by this crate.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRecord {
    pub key: Vec<u8>,
    pub salt: Vec<u8>,
    pub signature: Vec<u8>,
    pub sequence: i64,
    pub value: Vec<u8>,
}
impl SignedRecord {
    pub fn from_record(r: &MutableRecord) -> Self {
        Self {
            key: r.key().public_key().to_vec(),
            salt: r.key().salt().to_vec(),
            signature: r.signature().to_vec(),
            sequence: r.sequence(),
            value: r.value().as_bytes().to_vec(),
        }
    }
    pub fn verify(&self, expected: &MutableKey) -> Result<MutableRecord> {
        let key = MutableKey::new(
            self.key
                .as_slice()
                .try_into()
                .map_err(|_| err("Invalid public key"))?,
            self.salt.clone(),
        )
        .map_err(err)?;
        let r = MutableRecord::verify(
            key,
            self.sequence,
            BencodedValue::parse(&self.value).map_err(err)?,
            self.signature
                .as_slice()
                .try_into()
                .map_err(|_| err("Invalid signature"))?,
        )
        .map_err(err)?;
        r.verify_for(expected).map_err(err)?;
        Ok(r)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Subscription {
    pub magnet: String,
    pub config: Config,
    pub followed: bool,
    pub records: Vec<SignedRecord>,
    pub manual_catalogs: BTreeSet<String>,
    pub manual_items: BTreeSet<(String, usize)>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Origin {
    Link(String),
    Item(String, usize),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reference {
    pub origin: Origin,
    pub pending: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Checkpoint {
    pub version: u32,
    #[serde(alias = "feeds")]
    pub posts: BTreeMap<String, Subscription>,
    pub suppressed: BTreeSet<String>,
    pub approvals: BTreeSet<String>,
    #[serde(default)]
    pub references: BTreeMap<String, BTreeMap<String, Reference>>,
    #[serde(default)]
    pub news: NewsState,
}
impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            version: 2,
            posts: BTreeMap::new(),
            suppressed: BTreeSet::new(),
            approvals: BTreeSet::new(),
            references: BTreeMap::new(),
            news: NewsState::default(),
        }
    }
}
#[derive(Clone, Debug)]
pub enum Source {
    Magnet(String),
    Torrent(Vec<u8>),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Catalog,
    Content,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WorkId(pub u64);
#[derive(Clone, Debug)]
pub enum Action {
    /// Already validated update, released only after the checkpoint barrier.
    Relay {
        post: String,
        record: MutableRecord,
    },
    Watch {
        post: String,
        key: MutableKey,
        known: Option<MutableRecord>,
    },
    Unwatch {
        post: String,
        key: MutableKey,
    },
    Lookup {
        work: WorkId,
        post: String,
        key: MutableKey,
    },
    Stage {
        work: WorkId,
        post: String,
        id: String,
        source: Source,
        role: Role,
    },
    Read {
        work: WorkId,
        post: String,
        catalog: String,
        index: usize,
        length: u64,
    },
    Approve {
        work: WorkId,
        post: String,
        id: String,
    },
}
/// Advisory notifications; snapshots and checkpoints remain authoritative.
/// The queue is bounded to the most recent 128 notifications.
#[derive(Clone, Debug)]
pub enum Event {
    RecordAccepted {
        post: String,
        sequence: i64,
        infohash: Option<[u8; 20]>,
    },
    Attention {
        post: String,
        message: String,
    },
    WorkFailed {
        work: WorkId,
        message: String,
    },
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileDescription {
    pub name: String,
    pub length: u64,
}
#[derive(Clone, Debug, Default)]
pub struct Description {
    pub id: String,
    pub name: String,
    pub total: u64,
    pub files: Vec<FileDescription>,
    pub error: String,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct EntryView {
    pub index: usize,
    pub source_name: String,
    pub name: String,
    pub length: u64,
    pub kind: String,
    pub infohash: Option<String>,
    pub total: Option<u64>,
    pub state: String,
    pub error: String,
    pub post_magnet: Option<String>,
    pub files: Vec<FileDescription>,
}
#[derive(Clone, Debug, Serialize)]
pub struct CatalogView {
    pub id: String,
    pub name: String,
    pub total: u64,
    pub state: String,
    pub error: String,
    pub ready: bool,
    pub previous: Option<String>,
    pub archive: Option<String>,
    pub foreign_post: Option<String>,
    pub count: usize,
    pub indexed: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct PostView {
    pub local_name: String,
    pub id: String,
    pub name: String,
    pub magnet: String,
    pub mode: Mode,
    pub automatic_limit: Option<u64>,
    pub sequence: Option<String>,
    pub head: Option<String>,
    pub available: Option<String>,
    pub state: String,
    pub error: String,
    pub update_peers: usize,
    pub last_checked_ms: Option<u64>,
    pub catalogs: Vec<CatalogView>,
    pub mirror_status: String,
}
#[derive(Clone, Debug)]
pub struct Page {
    pub catalog: CatalogView,
    pub entries: Vec<EntryView>,
    pub offset: usize,
    pub total: usize,
}
pub(crate) fn identity(uri: &str) -> Result<MutableKey> {
    bep46::parse_magnet(uri).map_err(err)
}
pub(crate) fn target_uri(id: &str) -> String {
    format!("magnet:?xt=urn:btih:{id}")
}

/// Local reading state; never encoded into a torrent or a signed record.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NewsState {
    pub entries: Vec<NewsRecord>,
    pub observed: BTreeMap<String, i64>,
    pub next_order: u64,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NewsRecord {
    #[serde(alias = "feed")]
    pub post: String,
    pub sequence: i64,
    pub catalog: String,
    pub detected_ms: Option<u64>,
    pub order: u64,
    pub read: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct NewsEntry {
    pub post: String,
    pub sequence: String,
    pub catalog: String,
    pub post_name: String,
    pub name: String,
    pub detected_ms: Option<u64>,
    pub read: bool,
    pub ready: bool,
    pub state: String,
    pub error: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct NewsPage {
    pub entries: Vec<NewsEntry>,
    pub offset: usize,
    pub total: usize,
    pub anchor: String,
}
