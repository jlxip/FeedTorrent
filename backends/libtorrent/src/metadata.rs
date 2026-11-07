use super::{error, ffi, LibtorrentBackend};
use feedtorrent_bep::{AddTransfer, BackendFile, Result, TorrentSource};
#[derive(Clone, Debug)]
pub struct TorrentDescription {
    pub creation_date: Option<u64>,
    pub id: String,
    pub name: String,
    pub total: u64,
    pub files: Vec<BackendFile>,
    pub info: Vec<u8>,
    pub error: String,
}
fn convert(d: ffi::NativeDescription) -> TorrentDescription {
    TorrentDescription {
        creation_date: (d.has_creation_date
            && d.creation_date >= 0
            && d.creation_date <= 253_402_300_799)
            .then_some(d.creation_date as u64),
        id: d.id,
        name: d.name,
        total: d.total,
        info: d.info,
        error: d.error,
        files: d
            .files
            .into_iter()
            .filter(|f| !f.padding)
            .map(|f| BackendFile {
                name: f.name,
                length: f.length,
                verified: f.verified,
            })
            .collect(),
    }
}
impl LibtorrentBackend {
    pub fn describe_torrent(bytes: &[u8]) -> Result<TorrentDescription> {
        ffi::describe_torrent(bytes).map(convert).map_err(error)
    }
    pub fn description(&self, id: &str) -> Result<TorrentDescription> {
        self.session.description(id).map(convert).map_err(error)
    }
    pub fn file_at(&self, id: &str, index: usize) -> Result<BackendFile> {
        let index = u32::try_from(index).map_err(error)?;
        let f = self.session.file_at(id, index).map_err(error)?;
        Ok(BackendFile {
            name: f.name,
            length: f.length,
            verified: f.verified,
        })
    }
    /// Metadata may be fetched, but no payload pieces are requested until the host
    /// explicitly allows them. This hold survives native metadata/error callbacks.
    pub fn stage(&mut self, t: AddTransfer<'_>) -> Result<()> {
        let (bytes, magnet) = match t.source {
            TorrentSource::Magnet(uri) => (uri.as_bytes(), true),
            TorrentSource::Torrent(b) => (b, false),
        };
        self.session
            .pin_mut()
            .add(t.id, bytes, magnet, t.save_path, t.active, t.restore, true)
            .map_err(error)
    }
    pub fn allow_download(&mut self, id: &str) -> Result<()> {
        self.session.pin_mut().allow_download(id).map_err(error)
    }
}
