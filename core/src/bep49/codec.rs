use super::*;
use bendy::{
    decoding::{Decoder, FromBencode, Object},
    encoding::Encoder,
    value::Value,
};
use sha1::{Digest, Sha1};
use std::{borrow::Cow, collections::BTreeMap};
pub(super) type Dict = BTreeMap<Cow<'static, [u8]>, Value<'static>>;
pub(super) fn decode(bytes: &[u8]) -> Result<Value<'static>> {
    if bytes.len() > MAX_METAINFO {
        return Err(Error::TooLarge);
    }
    let mut decoder = Decoder::new(bytes).with_max_depth(64);
    let object = decoder
        .next_object()
        .map_err(|e| invalid(&e.to_string()))?
        .ok_or_else(|| invalid("Missing bencode"))?;
    let value = Value::decode_bencode_object(object)
        .map_err(|e| invalid(&e.to_string()))?
        .into_owned();
    if decoder
        .next_object()
        .map_err(|e| invalid(&e.to_string()))?
        .is_some()
    {
        return Err(invalid("Trailing bencode"));
    }
    Ok(value)
}
pub(super) fn encode(value: &Value<'_>) -> Result<Vec<u8>> {
    let mut encoder = Encoder::new().with_max_depth(64);
    encoder.emit(value).map_err(|e| invalid(&e.to_string()))?;
    let bytes = encoder.get_output().map_err(|e| invalid(&e.to_string()))?;
    if bytes.len() > MAX_METAINFO {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}
pub(super) fn dict<'a>(v: &'a Value<'static>) -> Result<&'a Dict> {
    match v {
        Value::Dict(d) => Ok(d),
        _ => Err(invalid("Expected dictionary")),
    }
}
pub(super) fn required<'a>(d: &'a Dict, key: &[u8]) -> Result<&'a Value<'static>> {
    d.get(key).ok_or_else(|| invalid("Missing required field"))
}
pub(super) fn bytes<'a>(v: &'a Value<'_>) -> Result<&'a [u8]> {
    match v {
        Value::Bytes(b) => Ok(b),
        _ => Err(invalid("Expected byte string")),
    }
}
pub(super) fn text(v: &Value<'_>) -> Result<String> {
    String::from_utf8(bytes(v)?.to_vec()).map_err(|_| invalid("Invalid UTF-8"))
}
pub(super) fn integer(v: &Value<'_>) -> Result<u64> {
    match v {
        Value::Integer(i) => u64::try_from(*i).map_err(|_| invalid("Negative length")),
        _ => Err(invalid("Expected integer")),
    }
}
pub(super) fn component(s: &str) -> Result<()> {
    if s.is_empty()
        || s == "."
        || s == ".."
        || s.chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(invalid("Unsafe path component"));
    }
    Ok(())
}
fn path(v: &Value<'_>) -> Result<Vec<String>> {
    let Value::List(list) = v else {
        return Err(invalid("Expected path list"));
    };
    if list.is_empty() {
        return Err(invalid("Empty path"));
    }
    list.iter()
        .map(|v| {
            let s = text(v)?;
            component(&s)?;
            Ok(s)
        })
        .collect()
}
/// The returned slice is the original dictionary, not a decode/encode roundtrip.
fn original_info(bytes: &[u8]) -> Result<&[u8]> {
    let mut decoder = Decoder::new(bytes).with_max_depth(64);
    let Some(Object::Dict(mut d)) = decoder.next_object().map_err(|e| invalid(&e.to_string()))?
    else {
        return Err(invalid("Expected metainfo dictionary"));
    };
    while let Some((key, value)) = d.next_pair().map_err(|e| invalid(&e.to_string()))? {
        if key == b"info" {
            let Object::Dict(info) = value else {
                return Err(invalid("Expected info dictionary"));
            };
            return info.into_raw().map_err(|e| invalid(&e.to_string()));
        }
    }
    Err(invalid("Missing info"))
}
fn fields(d: &Dict) -> Result<FeedFields> {
    let mut out = FeedFields::default();
    if let Some(v) = d.get(b"archive".as_slice()) {
        if integer(v)? != 1 {
            return Err(invalid("archive must be 1"));
        }
        out.archive = true;
    }
    if let Some(v) = d.get(b"bep46 source".as_slice()) {
        out.source =
            Some(crate::bep46::parse_magnet(&text(v)?).map_err(|_| Error::InvalidReference)?);
    }
    if let Some(v) = d.get(b"archive next".as_slice()) {
        out.archive_next = Some(TorrentLink::parse(&text(v)?)?);
    }
    if let Some(v) = d.get(b"prev".as_slice()) {
        out.previous = Some(TorrentLink::parse(&text(v)?)?);
    }
    out.validate()?;
    Ok(out)
}
fn entries(info: &Dict, require_sha1: bool) -> Result<(Vec<FeedEntry>, u64)> {
    let Value::List(files) = required(info, b"files")? else {
        return Err(invalid("Expected multifile torrent"));
    };
    if info.contains_key(b"length".as_slice()) {
        return Err(invalid("Both files and length"));
    }
    let mut total = 0u64;
    let mut out = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let file = dict(file)?;
        let attributes = file
            .get(b"attr".as_slice())
            .map(bytes)
            .transpose()?
            .unwrap_or_default()
            .to_vec();
        let padding = attributes.contains(&b'p');
        if padding && attributes.contains(&b'l') {
            return Err(invalid("Padding cannot be a symlink"));
        }
        if attributes.contains(&b'l') && !file.contains_key(b"symlink path".as_slice()) {
            return Err(invalid("Missing symlink target"));
        }
        let length = match file.get(b"length".as_slice()) {
            Some(v) => integer(v)?,
            None if attributes.contains(&b'l') => 0,
            None => return Err(invalid("Missing file length")),
        };
        if attributes.contains(&b'l') && length != 0 {
            return Err(invalid("Nonzero symlink length"));
        }
        if let Some(v) = file.get(b"symlink path".as_slice()) {
            path(v)?;
        }
        let path = match file.get(b"path".as_slice()) {
            Some(v) => path(v)?,
            None if padding => vec![],
            None => return Err(invalid("Missing path")),
        };
        let kind = if padding {
            EntryKind::Padding
        } else if path.len() == 1 {
            EntryKind::Item
        } else {
            EntryKind::Metadata
        };
        let sha1 = file
            .get(b"sha1".as_slice())
            .map(|v| {
                bytes(v)?
                    .try_into()
                    .map_err(|_| invalid("sha1 must have 20 bytes"))
            })
            .transpose()?;
        if require_sha1 && kind == EntryKind::Item && sha1.is_none() {
            return Err(invalid("Feed item missing sha1"));
        }
        total = total
            .checked_add(length)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or_else(|| invalid("Total length overflow"))?;
        out.push(FeedEntry {
            index,
            path,
            length,
            attributes,
            sha1,
            kind,
        });
    }
    Ok((out, total))
}
fn pieces(info: &Dict, total: u64) -> Result<(u32, Vec<u8>)> {
    let size = u32::try_from(integer(required(info, b"piece length")?)?)
        .map_err(|_| invalid("Piece length overflow"))?;
    if size == 0 {
        return Err(invalid("Zero piece length"));
    }
    let pieces = bytes(required(info, b"pieces")?)?.to_vec();
    if pieces.len() % 20 != 0 || (pieces.len() / 20) as u64 != total.div_ceil(u64::from(size)) {
        return Err(invalid("Piece count does not match length"));
    }
    Ok((size, pieces))
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feed {
    info: Vec<u8>,
    metainfo: Option<Vec<u8>>,
    name: String,
    infohash: InfoHash,
    entries: Vec<FeedEntry>,
    fields: FeedFields,
    piece_length: u32,
    pieces: Vec<u8>,
    total: u64,
}
impl Feed {
    pub fn from_metainfo(data: &[u8]) -> Result<Self> {
        let value = decode(data)?;
        dict(&value)?;
        let mut feed = Self::from_info(original_info(data)?)?;
        feed.metainfo = Some(data.to_vec());
        Ok(feed)
    }
    pub fn from_info(data: &[u8]) -> Result<Self> {
        let value = decode(data)?;
        let info = dict(&value)?;
        let name = text(required(info, b"name")?)?;
        component(&name)?;
        let fields = fields(dict(required(info, b"bep49")?)?)?;
        let (entries, total) = entries(info, true)?;
        let (piece_length, pieces) = pieces(info, total)?;
        Ok(Self {
            info: data.to_vec(),
            metainfo: None,
            name,
            infohash: Sha1::digest(data).into(),
            entries,
            fields,
            piece_length,
            pieces,
            total,
        })
    }
    pub fn infohash(&self) -> InfoHash {
        self.infohash
    }
    pub fn verify_infohash(&self, expected: InfoHash) -> Result<()> {
        if self.infohash == expected {
            Ok(())
        } else {
            Err(Error::IdentityMismatch)
        }
    }
    pub fn raw_info(&self) -> &[u8] {
        &self.info
    }
    pub fn raw_metainfo(&self) -> Option<&[u8]> {
        self.metainfo.as_deref()
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn entries(&self) -> &[FeedEntry] {
        &self.entries
    }
    pub fn items(&self) -> impl Iterator<Item = &FeedEntry> {
        self.entries.iter().filter(|e| e.kind == EntryKind::Item)
    }
    pub fn fields(&self) -> &FeedFields {
        &self.fields
    }
    pub fn piece_length(&self) -> u32 {
        self.piece_length
    }
    pub fn pieces(&self) -> &[u8] {
        &self.pieces
    }
    pub fn total_length(&self) -> u64 {
        self.total
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TorrentItem<'a> {
    metainfo: &'a [u8],
    info: &'a [u8],
    infohash: InfoHash,
    private: bool,
    feed: bool,
}
impl<'a> TorrentItem<'a> {
    pub fn metainfo(&self) -> &'a [u8] {
        self.metainfo
    }
    pub fn info(&self) -> &'a [u8] {
        self.info
    }
    pub fn infohash(&self) -> InfoHash {
        self.infohash
    }
    pub fn is_private(&self) -> bool {
        self.private
    }
    pub fn is_feed(&self) -> bool {
        self.feed
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemContent<'a> {
    Torrent(TorrentItem<'a>),
    Opaque(&'a [u8]),
}
/// Best-effort v1/hybrid inspection. Unsupported or malformed items stay opaque.
/// No result grants permission to download or proves canonical piece integrity.
pub fn inspect_item(data: &[u8]) -> ItemContent<'_> {
    fn inspect(data: &[u8]) -> Result<TorrentItem<'_>> {
        decode(data)?;
        let raw = original_info(data)?;
        let value = decode(raw)?;
        let info = dict(&value)?;
        component(&text(required(info, b"name")?)?)?;
        let total = if info.contains_key(b"files".as_slice()) {
            entries(info, false)?.1
        } else {
            integer(required(info, b"length")?)?
        };
        pieces(info, total)?;
        let private = info
            .get(b"private".as_slice())
            .map(integer)
            .transpose()?
            .unwrap_or(0);
        if private > 1 {
            return Err(invalid("Invalid private flag"));
        }
        Ok(TorrentItem {
            metainfo: data,
            info: raw,
            infohash: Sha1::digest(raw).into(),
            private: private == 1,
            feed: matches!(info.get(b"bep49".as_slice()), Some(Value::Dict(_))),
        })
    }
    match inspect(data) {
        Ok(t) => ItemContent::Torrent(t),
        Err(_) => ItemContent::Opaque(data),
    }
}
