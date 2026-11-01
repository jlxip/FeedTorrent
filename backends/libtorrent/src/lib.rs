//! Native libtorrent adapter. CXX types remain private to this crate.
mod bridge;
use bridge::ffi;
use feedtorrent_core::{
    AddTransfer, BackendError, BackendFile, BackendSnapshot, BackendTransfer, Result,
    TorrentBackend, TorrentSource,
};

pub struct LibtorrentBackend {
    session: cxx::UniquePtr<ffi::Session>,
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
        Ok(Self {
            session: ffi::new_session(state_dir, port, bootstrap, isolated).map_err(error)?,
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
        self.session.pin_mut().shutdown().map_err(error)
    }
}

#[cfg(test)]
mod tests;
