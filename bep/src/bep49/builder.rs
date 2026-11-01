use super::{codec::*, *};
use bendy::value::Value;
use sha1::{Digest, Sha1};
use std::{borrow::Cow, io::Read};
fn blob(b: impl Into<Vec<u8>>) -> Value<'static> {
    Value::Bytes(Cow::Owned(b.into()))
}
fn number(n: u64) -> Result<Value<'static>> {
    Ok(Value::Integer(
        i64::try_from(n).map_err(|_| invalid("Length overflow"))?,
    ))
}
fn put(d: &mut Dict, key: &'static [u8], value: Value<'static>) {
    d.insert(Cow::Borrowed(key), value);
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildEntry {
    pub path: Vec<String>,
    pub length: u64,
    pub attributes: Vec<u8>,
}
impl BuildEntry {
    pub fn file(path: Vec<String>, length: u64) -> Self {
        Self {
            path,
            length,
            attributes: vec![],
        }
    }
    pub fn padding(length: u64) -> Self {
        Self {
            path: vec![".pad".into(), length.to_string()],
            length,
            attributes: vec![b'p'],
        }
    }
    /// Preserve file order and existing padding when the host constructs a revision.
    pub fn from_entry(entry: &FeedEntry) -> Self {
        Self {
            path: entry.path.clone(),
            length: entry.length,
            attributes: entry.attributes.clone(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct FeedBuilder {
    pub name: String,
    pub entries: Vec<BuildEntry>,
    pub fields: FeedFields,
    pub piece_length: u32,
    /// Explicit outer fields, e.g. announce or comment. No defaults are injected.
    pub outer: Dict,
}
#[derive(Clone, Debug)]
pub struct BuiltFeed {
    pub metainfo: Vec<u8>,
    pub feed: Feed,
}
impl FeedBuilder {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            entries: vec![],
            fields: FeedFields::default(),
            piece_length: DEFAULT_PIECE_LENGTH,
            outer: Dict::new(),
        }
    }
    /// Reader indices correspond to input entries; padding never opens a reader.
    /// Uses a 32 KiB buffer and incremental SHA1 states, not whole-feed storage.
    /// Zero-size catalogs can be represented, but the current libtorrent backend
    /// rejects torrents with total size zero. No synthetic content is invented.
    pub fn build<F, R>(&self, mut open: F) -> Result<BuiltFeed>
    where
        F: FnMut(usize) -> std::io::Result<R>,
        R: Read,
    {
        component(&self.name)?;
        self.fields.validate()?;
        if self.piece_length < DEFAULT_PIECE_LENGTH
            || !self.piece_length.is_power_of_two()
            || self.piece_length > 128 * 1024 * 1024
        {
            return Err(invalid("Invalid creation piece length"));
        }
        if self.outer.contains_key(b"info".as_slice()) {
            return Err(invalid("Outer fields cannot replace info"));
        }
        let mut total = 0u64;
        for entry in &self.entries {
            if entry.path.is_empty() && !entry.attributes.contains(&b'p') {
                return Err(invalid("Missing creation path"));
            }
            for p in &entry.path {
                component(p)?;
            }
            if entry.attributes.contains(&b'l') {
                return Err(invalid("Symlink creation is not supported"));
            }
            total = total
                .checked_add(entry.length)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(|| invalid("Total length overflow"))?;
        }
        let padded_total = total
            .checked_add(
                (u64::from(self.piece_length) - total % u64::from(self.piece_length))
                    % u64::from(self.piece_length),
            )
            .ok_or_else(|| invalid("Padded length overflow"))?;
        if padded_total.div_ceil(u64::from(self.piece_length)) > (MAX_METAINFO / 20) as u64 {
            return Err(Error::TooLarge);
        }
        let mut hashing = PieceHasher {
            hash: Sha1::new(),
            filled: 0,
            size: u64::from(self.piece_length),
            pieces: vec![],
        };
        let mut files = Vec::with_capacity(self.entries.len() + 1);
        let mut buffer = [0u8; 32768];
        for (index, entry) in self.entries.iter().enumerate() {
            let mut file = Dict::new();
            put(&mut file, b"length", number(entry.length)?);
            if !entry.path.is_empty() {
                put(
                    &mut file,
                    b"path",
                    Value::List(entry.path.iter().map(|s| blob(s.as_bytes())).collect()),
                );
            }
            if !entry.attributes.is_empty() {
                put(&mut file, b"attr", blob(entry.attributes.clone()));
            }
            if entry.attributes.contains(&b'p') {
                hashing.zeros(entry.length)?;
            } else {
                let mut reader = open(index)?;
                let mut left = entry.length;
                let mut hash = Sha1::new();
                while left > 0 {
                    let n = left.min(buffer.len() as u64) as usize;
                    match reader.read_exact(&mut buffer[..n]) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                            return Err(Error::LengthMismatch { index })
                        }
                        Err(e) => return Err(e.into()),
                    }
                    hash.update(&buffer[..n]);
                    hashing.update(&buffer[..n])?;
                    left -= n as u64;
                }
                if has_extra(&mut reader)? {
                    return Err(Error::LengthMismatch { index });
                }
                put(&mut file, b"sha1", blob(hash.finalize().to_vec()));
            }
            files.push(Value::Dict(file));
        }
        let tail = padded_total - total;
        if tail > 0 {
            let mut pad = Dict::new();
            put(&mut pad, b"length", number(tail)?);
            put(&mut pad, b"attr", blob(b"p"));
            put(
                &mut pad,
                b"path",
                Value::List(vec![blob(b".pad"), blob(tail.to_string().into_bytes())]),
            );
            files.push(Value::Dict(pad));
            hashing.zeros(tail)?;
        }
        let mut fields = Dict::new();
        if self.fields.archive {
            put(&mut fields, b"archive", Value::Integer(1));
        }
        if let Some(key) = &self.fields.source {
            put(
                &mut fields,
                b"bep46 source",
                blob(crate::bep46::format_magnet(key).into_bytes()),
            );
        }
        if let Some(link) = &self.fields.archive_next {
            put(&mut fields, b"archive next", blob(link.uri().as_bytes()));
        }
        if let Some(link) = &self.fields.previous {
            put(&mut fields, b"prev", blob(link.uri().as_bytes()));
        }
        let mut info = Dict::new();
        put(&mut info, b"bep49", Value::Dict(fields));
        put(&mut info, b"files", Value::List(files));
        put(&mut info, b"name", blob(self.name.as_bytes()));
        put(
            &mut info,
            b"piece length",
            number(u64::from(self.piece_length))?,
        );
        put(&mut info, b"pieces", blob(hashing.pieces));
        let mut root = self.outer.clone();
        put(&mut root, b"info", Value::Dict(info));
        let metainfo = encode(&Value::Dict(root))?;
        let feed = Feed::from_metainfo(&metainfo)?;
        Ok(BuiltFeed { metainfo, feed })
    }
}
struct PieceHasher {
    hash: Sha1,
    filled: u64,
    size: u64,
    pieces: Vec<u8>,
}
impl PieceHasher {
    fn update(&mut self, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            let n = (self.size - self.filled).min(data.len() as u64) as usize;
            self.hash.update(&data[..n]);
            data = &data[n..];
            self.filled += n as u64;
            if self.filled == self.size {
                if self.pieces.len() + 20 > MAX_METAINFO {
                    return Err(Error::TooLarge);
                }
                self.pieces
                    .extend_from_slice(&std::mem::take(&mut self.hash).finalize());
                self.filled = 0;
            }
        }
        Ok(())
    }
    fn zeros(&mut self, mut length: u64) -> Result<()> {
        let zeros = [0u8; 32768];
        while length > 0 {
            let n = length.min(zeros.len() as u64) as usize;
            self.update(&zeros[..n])?;
            length -= n as u64;
        }
        Ok(())
    }
}
