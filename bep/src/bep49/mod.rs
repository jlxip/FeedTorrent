//! Portable BEP 49 feed catalogs. No filesystem, automatic traversal or policies.
//!
//! ```
//! use std::io::Cursor;
//! use feedtorrent_bep::bep49::{FeedBuilder, BuildEntry, Feed};
//! let mut builder = FeedBuilder::new("catalog");
//! builder.entries.push(BuildEntry::file(vec!["note.txt".into()], 5));
//! let built = builder.build(|_| Ok(Cursor::new(b"hello")))?;
//! let feed = Feed::from_metainfo(&built.metainfo)?;
//! assert_eq!(feed.items().count(), 1);
//! assert_eq!(feed.infohash(), built.feed.infohash());
//! # Ok::<(), feedtorrent_bep::bep49::Error>(())
//! ```
mod builder;
mod codec;
use crate::{bep44::MutableKey, bep46::InfoHash};
/// Value type for explicitly supplied outer metainfo fields.
pub use bendy::value::Value as OuterValue;
pub use builder::*;
pub use codec::{inspect_item, Feed, ItemContent, TorrentItem};
use std::fmt;
pub const MAX_METAINFO: usize = 8 * 1024 * 1024;
pub const DEFAULT_PIECE_LENGTH: u32 = 16 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(String),
    TooLarge,
    InvalidReference,
    Io(String),
    LengthMismatch { index: usize },
    IdentityMismatch,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BEP 49: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
/// A conventional v1 magnet reference, retaining additional URI parameters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TorrentLink {
    uri: String,
    infohash: InfoHash,
}
impl TorrentLink {
    pub fn new(infohash: InfoHash) -> Self {
        Self {
            uri: format!(
                "magnet:?xt=urn:btih:{}",
                infohash
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            infohash,
        }
    }
    pub fn parse(uri: &str) -> Result<Self> {
        let uri = uri.trim();
        if uri.chars().any(|c| c.is_control() || c.is_whitespace()) || uri.contains('#') {
            return Err(Error::InvalidReference);
        }
        let (scheme, query) = uri.split_once('?').ok_or(Error::InvalidReference)?;
        if !scheme.eq_ignore_ascii_case("magnet:") {
            return Err(Error::InvalidReference);
        }
        let mut infohash = None;
        for part in query.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = part.split_once('=').unwrap_or((part, ""));
            let k = decode_query(k)?;
            let v = decode_query(v)?;
            if k == b"xt"
                && v.get(..9)
                    .is_some_and(|p| p.eq_ignore_ascii_case(b"urn:btih:"))
            {
                if infohash.is_some() {
                    return Err(Error::InvalidReference);
                }
                let v = &v[9..];
                let mut hash = [0; 20];
                if v.len() == 40 {
                    for (i, pair) in v.chunks_exact(2).enumerate() {
                        hash[i] = digit(pair[0]).ok_or(Error::InvalidReference)? * 16
                            + digit(pair[1]).ok_or(Error::InvalidReference)?;
                    }
                } else if v.len() == 32 {
                    let (mut acc, mut bits, mut index) = (0u32, 0, 0);
                    for b in v {
                        let b = b.to_ascii_uppercase();
                        let x = match b {
                            b'A'..=b'Z' => b - b'A',
                            b'2'..=b'7' => b - b'2' + 26,
                            _ => return Err(Error::InvalidReference),
                        };
                        acc = (acc << 5) | u32::from(x);
                        bits += 5;
                        if bits >= 8 {
                            bits -= 8;
                            hash[index] = (acc >> bits) as u8;
                            index += 1;
                            acc &= (1 << bits) - 1;
                        }
                    }
                } else {
                    return Err(Error::InvalidReference);
                }
                infohash = Some(hash);
            }
        }
        Ok(Self {
            uri: uri.to_owned(),
            infohash: infohash.ok_or(Error::InvalidReference)?,
        })
    }
    pub fn uri(&self) -> &str {
        &self.uri
    }
    pub fn infohash(&self) -> InfoHash {
        self.infohash
    }
}
fn digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
fn decode_query(s: &str) -> Result<Vec<u8>> {
    let mut it = s.bytes();
    let mut out = Vec::new();
    while let Some(b) = it.next() {
        out.push(match b {
            b'%' => {
                it.next().and_then(digit).ok_or(Error::InvalidReference)? * 16
                    + it.next().and_then(digit).ok_or(Error::InvalidReference)?
            }
            b'+' => b' ',
            x => x,
        });
    }
    Ok(out)
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedFields {
    pub source: Option<MutableKey>,
    pub archive_next: Option<TorrentLink>,
    pub archive: bool,
    pub previous: Option<TorrentLink>,
}
impl FeedFields {
    pub fn validate(&self) -> Result<()> {
        if self.archive && (self.source.is_some() || self.previous.is_some()) {
            return Err(invalid("Archives cannot have prev or bep46 source"));
        }
        Ok(())
    }
    /// The identity actually used to resolve the feed wins over an embedded hint.
    pub fn effective_source<'a>(
        &'a self,
        resolved: Option<&'a MutableKey>,
    ) -> Option<&'a MutableKey> {
        resolved.or(self.source.as_ref())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Item,
    Metadata,
    Padding,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedEntry {
    index: usize,
    path: Vec<String>,
    length: u64,
    attributes: Vec<u8>,
    sha1: Option<InfoHash>,
    kind: EntryKind,
}
impl FeedEntry {
    pub fn index(&self) -> usize {
        self.index
    }
    /// Empty only for a BEP47 padding entry without a path.
    pub fn path(&self) -> &[String] {
        &self.path
    }
    pub fn length(&self) -> u64 {
        self.length
    }
    pub fn attributes(&self) -> &[u8] {
        &self.attributes
    }
    pub fn sha1(&self) -> Option<InfoHash> {
        self.sha1
    }
    pub fn kind(&self) -> EntryKind {
        self.kind
    }
    /// A file hash is a hint, never evidence that canonical piece hashes match.
    pub fn check_sha1<R: std::io::Read>(&self, mut reader: R) -> Result<Option<bool>> {
        use sha1::{Digest, Sha1};
        let mut hash = Sha1::new();
        let mut buf = [0; 32768];
        let mut left = self.length;
        while left > 0 {
            let n = left.min(buf.len() as u64) as usize;
            match reader.read_exact(&mut buf[..n]) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Err(Error::LengthMismatch { index: self.index })
                }
                Err(e) => return Err(e.into()),
            }
            hash.update(&buf[..n]);
            left -= n as u64;
        }
        if has_extra(&mut reader)? {
            return Err(Error::LengthMismatch { index: self.index });
        }
        let actual: InfoHash = hash.finalize().into();
        Ok(self.sha1.map(|expected| expected == actual))
    }
}
fn has_extra<R: std::io::Read>(reader: &mut R) -> Result<bool> {
    let mut byte = [0];
    loop {
        match reader.read(&mut byte) {
            Ok(n) => return Ok(n != 0),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
}
#[cfg(test)]
mod tests;
