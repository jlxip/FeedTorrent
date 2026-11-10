//! Incremental torrent construction, independent from the live network session.
use super::{error, ffi};
use feedtorrent_bep::Result;

pub struct Input {
    pub name: String,
    pub source: String,
    pub length: u64,
}
pub struct Builder {
    native: cxx::UniquePtr<ffi::TorrentBuilder>,
}
impl Builder {
    pub fn verifier(data: &[u8], files: Vec<Input>) -> Result<Self> {
        let files: Vec<_> = files
            .into_iter()
            .map(|f| ffi::NativeInput {
                name: f.name,
                source: f.source,
                length: f.length,
            })
            .collect();
        Ok(Self {
            native: ffi::torrent_verifier(data, &files).map_err(error)?,
        })
    }
    pub fn new(name: &str, files: Vec<Input>) -> Result<Self> {
        let files: Vec<_> = files
            .into_iter()
            .map(|f| ffi::NativeInput {
                name: f.name,
                source: f.source,
                length: f.length,
            })
            .collect();
        Ok(Self {
            native: ffi::torrent_builder(name, &files).map_err(error)?,
        })
    }
    pub fn step(&mut self) -> Result<u64> {
        self.native.pin_mut().step().map_err(error)
    }
    pub fn finish(&self) -> Result<Vec<u8>> {
        self.native.finish().map_err(error)
    }
}
