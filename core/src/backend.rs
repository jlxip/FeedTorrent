use std::fmt;

/// Backend failure without native engine or application types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendError {
    message: String,
}
impl BackendError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for BackendError {}
pub type Result<T> = std::result::Result<T, BackendError>;

#[derive(Clone, Copy, Debug)]
pub enum TorrentSource<'a> {
    Magnet(&'a str),
    Torrent(&'a [u8]),
}
impl<'a> TorrentSource<'a> {
    pub fn from_bytes(bytes: &'a [u8], magnet: bool) -> Result<Self> {
        if magnet {
            Ok(Self::Magnet(
                std::str::from_utf8(bytes).map_err(|e| BackendError::new(e.to_string()))?,
            ))
        } else {
            Ok(Self::Torrent(bytes))
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct AddTransfer<'a> {
    pub id: &'a str,
    pub source: TorrentSource<'a>,
    pub save_path: &'a str,
    pub active: bool,
    /// Recheck saved payloads before sharing them.
    pub restore: bool,
}
#[derive(Clone, Debug, Default)]
pub struct BackendFile {
    pub name: String,
    pub length: u64,
    pub verified: u64,
}
#[derive(Clone, Debug, Default)]
pub struct BackendTransfer {
    pub id: String,
    pub name: String,
    pub state: String,
    pub error: String,
    pub warning: String,
    pub verified: u64,
    pub total: u64,
    pub down: u64,
    pub up: u64,
    pub peers: u32,
    pub files: Vec<BackendFile>,
    pub finished: bool,
}
#[derive(Clone, Debug, Default)]
pub struct BackendSnapshot {
    pub transfers: Vec<BackendTransfer>,
    pub dht_nodes: u32,
    pub listen_port: u16,
    pub warning: String,
}
/// Synchronous operations owned and polled by one host actor.
/// Methods acknowledge commands; network activity continues inside the backend.
pub trait TorrentBackend {
    fn inspect(&self, source: TorrentSource<'_>) -> Result<String>;
    fn add(&mut self, transfer: AddTransfer<'_>) -> Result<()>;
    fn pause(&mut self, id: &str) -> Result<()>;
    fn resume(&mut self, id: &str) -> Result<()>;
    /// Detach a torrent; payload deletion is the host's responsibility.
    fn remove(&mut self, id: &str) -> Result<()>;
    fn snapshot(&mut self) -> Result<BackendSnapshot>;
    fn checkpoint(&mut self) -> Result<()>;
    fn shutdown(&mut self) -> Result<()>;
}

/// Read-only metadata capability. No network waits or reconstruction of info bytes.
pub trait TorrentMetadataBackend {
    /// None while metadata is pending; errors for unknown transfers/closed backend.
    fn info_bytes(&self, id: &str) -> Result<Option<Vec<u8>>>;
}
