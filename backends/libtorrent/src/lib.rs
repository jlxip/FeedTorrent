//! Native libtorrent adapter. CXX types remain private to this crate.
mod bridge;
pub mod creation;
mod dht;
use bridge::ffi;
use feedtorrent_bep::{
    AddTransfer, BackendError, BackendFile, BackendSnapshot, BackendTransfer, Result,
    TorrentBackend, TorrentSource,
};

/// Native transfer and DHT backend.
///
/// libtorrent retains its wire decoder limits (10 levels and 500 tokens for the
/// complete KRPC packet). Highly nested/token-dense values accepted by the core
/// may therefore fail to propagate. Publication acknowledgements report only
/// what this operation observed; they do not promise durable availability.
/// Without CAS, conflict detection cannot roll back a partial publication on a
/// different address-family traversal that had not observed the conflicting item.
pub struct LibtorrentBackend {
    session: cxx::UniquePtr<ffi::Session>,
    dht: dht::DhtState,
}
fn error(e: impl std::fmt::Display) -> BackendError {
    BackendError::new(e.to_string())
}
fn inspect(source: TorrentSource<'_>) -> Result<String> {
    match source {
        TorrentSource::Magnet(uri) => ffi::inspect_magnet(uri).map_err(error),
        TorrentSource::Torrent(bytes) => ffi::inspect_torrent(bytes).map_err(error),
    }
}
impl LibtorrentBackend {
    pub fn new(state_dir: &str, port: u16, bootstrap: &str, isolated: bool) -> Result<Self> {
        Self::create(state_dir, port, bootstrap, isolated, false)
    }
    /// Isolated IPv6 loopback session for hosts testing IPv6 without IPv4 fallback.
    pub fn new_isolated_ipv6(state_dir: &str, port: u16, bootstrap: &str) -> Result<Self> {
        Self::create(state_dir, port, bootstrap, true, true)
    }
    fn create(
        state_dir: &str,
        port: u16,
        bootstrap: &str,
        isolated: bool,
        ipv6_only: bool,
    ) -> Result<Self> {
        Ok(Self {
            session: ffi::new_session(state_dir, port, bootstrap, isolated, ipv6_only)
                .map_err(error)?,
            dht: dht::DhtState::default(),
        })
    }
}
impl TorrentBackend for LibtorrentBackend {
    fn inspect(&self, source: TorrentSource<'_>) -> Result<String> {
        inspect(source)
    }
    fn add(&mut self, transfer: AddTransfer<'_>) -> Result<()> {
        let (bytes, magnet) = match transfer.source {
            TorrentSource::Magnet(uri) => (uri.as_bytes(), true),
            TorrentSource::Torrent(bytes) => (bytes, false),
        };
        self.session
            .pin_mut()
            .add(
                transfer.id,
                bytes,
                magnet,
                transfer.save_path,
                transfer.active,
                transfer.restore,
                false,
            )
            .map_err(error)
    }
    fn pause(&mut self, id: &str) -> Result<()> {
        self.session.pin_mut().pause(id).map_err(error)
    }
    fn resume(&mut self, id: &str) -> Result<()> {
        self.session.pin_mut().resume(id).map_err(error)
    }
    fn remove(&mut self, id: &str) -> Result<()> {
        self.session.pin_mut().remove(id).map_err(error)
    }
    fn snapshot(&mut self) -> Result<BackendSnapshot> {
        let s = self.session.pin_mut().snapshot().map_err(error)?;
        Ok(BackendSnapshot {
            dht_nodes: s.dht_nodes,
            listen_port: s.listen_port,
            warning: s.warning,
            transfers: s
                .transfers
                .into_iter()
                .map(|t| BackendTransfer {
                    id: t.id,
                    name: t.name,
                    state: t.state,
                    error: t.error,
                    warning: t.warning,
                    verified: t.verified,
                    total: t.total,
                    down: t.down,
                    up: t.up,
                    peers: t.peers,
                    finished: t.finished,
                    files: t
                        .files
                        .into_iter()
                        .map(|f| BackendFile {
                            name: f.name,
                            length: f.length,
                            verified: f.verified,
                        })
                        .collect(),
                })
                .collect(),
        })
    }
    fn checkpoint(&mut self) -> Result<()> {
        self.session.pin_mut().checkpoint().map_err(error)
    }
    fn shutdown(&mut self) -> Result<()> {
        self.close_dht();
        self.session.pin_mut().shutdown().map_err(error)
    }
}

impl feedtorrent_bep::TorrentMetadataBackend for LibtorrentBackend {
    fn info_bytes(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let bytes = self.session.info_bytes(id).map_err(error)?;
        Ok((!bytes.is_empty()).then_some(bytes))
    }
}

#[cfg(test)]
mod tests;

mod discovery;
mod metadata;
pub use metadata::TorrentDescription;
