//! Host-driven publication building. No filesystem, keys, network or OS clock.
use crate::{err, hex, Result};
use feedtorrent_bep::{bep44::MutableKey, bep49::*};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
};

pub const MAX_BODY: usize = 1024 * 1024;
pub const MAX_DRAFT_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    pub root: u64,
    pub pages: Vec<Page>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Entry {
    Page {
        page: u64,
    },
    Torrent {
        name: String,
        data: Vec<u8>,
    },
    Files {
        name: String,
        files: Vec<SourceFile>,
        linked: bool,
        copy: bool,
    },
}
/// Local host references only. Absolute source paths never enter shared metainfo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    pub path: Vec<String>,
    pub source: String,
    pub length: u64,
    pub modified: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Previous {
    pub fingerprint: String,
    pub metainfo: Vec<u8>,
    /// Read only from a verified previous package; absent for legacy catalogs.
    #[serde(default)]
    pub dates: Option<crate::dates::Dates>,
}
#[derive(Clone, Debug)]
pub struct Payload {
    pub path: Vec<String>,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct BuiltCatalog {
    pub page: u64,
    pub fingerprint: String,
    pub metainfo: Vec<u8>,
    pub files: Vec<Payload>,
}
#[derive(Clone, Debug)]
pub struct Publication {
    pub root: [u8; 20],
    pub catalogs: Vec<BuiltCatalog>,
    pub pages: BTreeMap<u64, Previous>,
}
#[derive(Clone, Debug)]
pub enum StreamData {
    Bytes(Vec<u8>),
    File { file: SourceFile, copy: bool },
}
#[derive(Clone, Debug)]
pub struct StreamPayload {
    pub path: Vec<String>,
    pub data: StreamData,
}
#[derive(Clone, Debug)]
pub struct StreamCatalog {
    pub page: u64,
    pub metainfo: Vec<u8>,
    pub files: Vec<StreamPayload>,
}
pub struct StreamPublication {
    pub root: [u8; 20],
    pub pages: BTreeMap<u64, Previous>,
    pub catalogs: Vec<StreamCatalog>,
}

impl Draft {
    /// Host-provided readers keep payloads and local paths out of metainfo and RAM.
    pub fn build_streaming<F, R>(
        &self,
        key: &MutableKey,
        previous: &BTreeMap<u64, Previous>,
        previous_root: Option<[u8; 20]>,
        time: u64,
        links: &BTreeMap<(u64, usize), Vec<u8>>,
        mut open: F,
    ) -> Result<StreamPublication>
    where
        F: FnMut(&SourceFile) -> std::io::Result<R>,
        R: std::io::Read,
    {
        self.validate()?;
        crate::dates::Dates::new(None, time)?;
        struct Builder<'a, F> {
            draft: &'a Draft,
            key: &'a MutableKey,
            previous: &'a BTreeMap<u64, Previous>,
            previous_root: Option<[u8; 20]>,
            time: u64,
            links: &'a BTreeMap<(u64, usize), Vec<u8>>,
            open: F,
            out: StreamPublication,
        }
        impl<F, R> Builder<'_, F>
        where
            F: FnMut(&SourceFile) -> std::io::Result<R>,
            R: std::io::Read,
        {
            fn page(&mut self, id: u64) -> Result<Vec<u8>> {
                let p = self
                    .draft
                    .pages
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| err("Unknown page"))?
                    .clone();
                let mut files = vec![];
                if !p.body.is_empty() {
                    files.push(StreamPayload {
                        path: vec!["metadata".into(), "body.md".into()],
                        data: StreamData::Bytes(p.body.as_bytes().to_vec()),
                    });
                }
                let mut names = BTreeSet::new();
                names.insert(vec!["metadata".to_owned(), "body.md".to_owned()]);
                names.insert(vec!["metadata".to_owned(), "dates.json".to_owned()]);
                for (index, e) in p.entries.iter().enumerate() {
                    if let Entry::Files {
                        files: selected,
                        linked: false,
                        copy,
                        ..
                    } = e
                    {
                        for f in selected {
                            if f.path.first().is_some_and(|p| p == "metadata")
                                || !names.insert(f.path.clone())
                            {
                                return Err(err("Duplicate or reserved payload path"));
                            }
                            files.push(StreamPayload {
                                path: f.path.clone(),
                                data: StreamData::File {
                                    file: f.clone(),
                                    copy: *copy,
                                },
                            });
                        }
                        continue;
                    }
                    let (base, data) = match e {
                        Entry::Page { page } => {
                            let title = self
                                .draft
                                .pages
                                .iter()
                                .find(|p| p.id == *page)
                                .ok_or_else(|| err("Unknown page"))?
                                .title
                                .clone();
                            (format!("{title}.torrent"), self.page(*page)?)
                        }
                        Entry::Torrent { name, data } => (name.clone(), data.clone()),
                        Entry::Files { name, .. } => (
                            format!("{name}.torrent"),
                            self.links
                                .get(&(id, index))
                                .ok_or_else(|| err("Linked torrent not prepared"))?
                                .clone(),
                        ),
                    };
                    let mut name = base.clone();
                    let mut suffix = index + 1;
                    while name == "metadata" || names.contains(&vec![name.clone()]) {
                        name = format!("{suffix}-{base}");
                        suffix += 1;
                    }
                    names.insert(vec![name.clone()]);
                    files.push(StreamPayload {
                        path: vec![name],
                        data: StreamData::Bytes(data),
                    });
                }
                if files.is_empty() {
                    return Err(err(format!(
                        "Page '{}' has no downloadable content",
                        p.title
                    )));
                }
                let mut fingerprint = Sha1::new();
                fingerprint.update(p.title.as_bytes());
                if id == self.draft.root {
                    fingerprint.update(self.key.public_key());
                    fingerprint.update(self.key.salt());
                }
                let mut buffer = [0; 65536];
                for file in &files {
                    fingerprint.update(serde_json::to_vec(&file.path).map_err(err)?);
                    match &file.data {
                        StreamData::Bytes(data) => {
                            fingerprint.update((data.len() as u64).to_be_bytes());
                            fingerprint.update(data);
                        }
                        StreamData::File { file, .. } => {
                            fingerprint.update(file.length.to_be_bytes());
                            let mut input = (self.open)(file).map_err(err)?;
                            let mut count = 0;
                            loop {
                                let n =
                                    std::io::Read::read(&mut input, &mut buffer).map_err(err)?;
                                if n == 0 {
                                    break;
                                }
                                count += n as u64;
                                fingerprint.update(&buffer[..n]);
                            }
                            if count != file.length {
                                return Err(err("Source file changed length"));
                            }
                        }
                    }
                }
                let fingerprint = hex(&fingerprint.finalize());
                if let Some(old) = self
                    .previous
                    .get(&id)
                    .filter(|p| p.fingerprint == fingerprint)
                {
                    self.out.pages.insert(id, old.clone());
                    return Ok(old.metainfo.clone());
                }
                let prior = if id == self.draft.root {
                    self.previous_root
                        .and_then(|h| {
                            self.previous.values().find(|p| {
                                Feed::from_metainfo(&p.metainfo).is_ok_and(|f| f.infohash() == h)
                            })
                        })
                        .or_else(|| self.previous.get(&id))
                } else {
                    self.previous.get(&id)
                };
                let created =
                    if prior.is_some() || id == self.draft.root && self.previous_root.is_some() {
                        prior.and_then(|p| p.dates).and_then(|d| d.created_at)
                    } else {
                        Some(self.time)
                    };
                let dates = crate::dates::Dates::new(created, self.time)?;
                files.push(StreamPayload {
                    path: vec!["metadata".into(), "dates.json".into()],
                    data: StreamData::Bytes(serde_json::to_vec(&dates).map_err(err)?),
                });
                let mut b = FeedBuilder::new(&p.title);
                b.outer.insert(
                    Cow::Borrowed(b"creation date"),
                    OuterValue::Integer(self.time as i64),
                );
                if id == self.draft.root {
                    b.fields.source = Some(self.key.clone());
                }
                b.fields.previous = if id == self.draft.root {
                    self.previous_root.map(TorrentLink::new)
                } else {
                    self.previous
                        .get(&id)
                        .map(|p| {
                            Feed::from_metainfo(&p.metainfo).map(|f| TorrentLink::new(f.infohash()))
                        })
                        .transpose()
                        .map_err(err)?
                };
                let total = files.iter().try_fold(0u64, |n, f| {
                    n.checked_add(match &f.data {
                        StreamData::Bytes(d) => d.len() as u64,
                        StreamData::File { file, .. } => file.length,
                    })
                    .ok_or_else(|| err("Total length overflow"))
                })?;
                while total.div_ceil(u64::from(b.piece_length)) > 100_000
                    && b.piece_length < 128 * 1024 * 1024
                {
                    b.piece_length *= 2;
                }
                b.entries = files
                    .iter()
                    .map(|f| {
                        BuildEntry::file(
                            f.path.clone(),
                            match &f.data {
                                StreamData::Bytes(d) => d.len() as u64,
                                StreamData::File { file, .. } => file.length,
                            },
                        )
                    })
                    .collect();
                let meta = b
                    .build(|i| -> std::io::Result<Box<dyn std::io::Read + '_>> {
                        match &files[i].data {
                            StreamData::Bytes(d) => Ok(Box::new(Cursor::new(d))),
                            StreamData::File { file, .. } => Ok(Box::new((self.open)(file)?)),
                        }
                    })
                    .map_err(err)?
                    .metainfo;
                self.out.pages.insert(
                    id,
                    Previous {
                        fingerprint,
                        metainfo: meta.clone(),
                        dates: Some(dates),
                    },
                );
                self.out.catalogs.push(StreamCatalog {
                    page: id,
                    metainfo: meta.clone(),
                    files,
                });
                Ok(meta)
            }
        }
        let mut b = Builder {
            draft: self,
            key,
            previous,
            previous_root,
            time,
            links,
            open: &mut open,
            out: StreamPublication {
                root: [0; 20],
                pages: BTreeMap::new(),
                catalogs: vec![],
            },
        };
        let meta = b.page(self.root)?;
        b.out.root = Feed::from_metainfo(&meta).map_err(err)?.infohash();
        Ok(b.out)
    }
}

/// Verify piece hashes and individual file hashes with bounded host readers.
pub fn verify_readers<F, R>(metainfo: &[u8], mut open: F) -> Result<()>
where
    F: FnMut(&FeedEntry) -> std::io::Result<R>,
    R: std::io::Read,
{
    let post = Feed::from_metainfo(metainfo).map_err(err)?;
    let mut piece = Sha1::new();
    let mut filled = 0usize;
    let mut hashes = vec![];
    let mut buffer = [0; 32768];
    for entry in post.entries() {
        let padding = entry.kind() == EntryKind::Padding;
        let mut reader = if padding {
            None
        } else {
            Some(open(entry).map_err(err)?)
        };
        let mut file_hash = Sha1::new();
        let mut offset = 0u64;
        while offset < entry.length() {
            let n = (entry.length() - offset)
                .min(buffer.len() as u64)
                .min((post.piece_length() as usize - filled) as u64) as usize;
            if let Some(r) = &mut reader {
                std::io::Read::read_exact(r, &mut buffer[..n]).map_err(err)?;
            } else {
                buffer[..n].fill(0);
            }
            piece.update(&buffer[..n]);
            file_hash.update(&buffer[..n]);
            offset += n as u64;
            filled += n;
            if filled == post.piece_length() as usize {
                hashes.extend_from_slice(&piece.finalize_reset());
                filled = 0;
            }
        }
        if let Some(r) = &mut reader {
            if std::io::Read::read(r, &mut buffer[..1]).map_err(err)? != 0 {
                return Err(err("Catalog file length mismatch"));
            }
        }
        if !padding
            && entry
                .sha1()
                .is_some_and(|h| h != <[u8; 20]>::from(file_hash.finalize()))
        {
            return Err(err("Catalog file hash mismatch"));
        }
    }
    if filled > 0 {
        hashes.extend_from_slice(&piece.finalize());
    }
    if hashes != post.pieces() {
        return Err(err("Catalog piece hashes do not match payload"));
    }
    Ok(())
}
fn component(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 256
        || s == "."
        || s == ".."
        || s.chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(err(
            "Title or filename is not a safe path component (maximum 256 bytes)",
        ));
    }
    Ok(())
}
impl Draft {
    pub fn new(title: String) -> Self {
        Self {
            root: 1,
            pages: vec![Page {
                id: 1,
                title,
                body: String::new(),
                entries: vec![],
            }],
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.pages.is_empty() || self.pages.len() > 256 {
            return Err(err("A draft needs between 1 and 256 pages"));
        }
        let pages: BTreeMap<_, _> = self.pages.iter().map(|p| (p.id, p)).collect();
        if pages.len() != self.pages.len() {
            return Err(err("Duplicate page identifier"));
        }
        let mut bytes = 0usize;
        for p in &self.pages {
            component(&p.title)?;
            if p.body.len() > MAX_BODY || p.entries.len() > 1024 {
                return Err(err("Page exceeds body or item limit"));
            }
            bytes = bytes
                .checked_add(p.body.len())
                .ok_or_else(|| err("Draft too large"))?;
            for entry in &p.entries {
                if let Entry::Files { name, files, .. } = entry {
                    component(name)?;
                    if files.is_empty() || files.len() > 100_000 {
                        return Err(err("Invalid file selection"));
                    }
                    let mut seen = BTreeSet::new();
                    for f in files {
                        if f.path.is_empty()
                            || !seen.insert(&f.path)
                            || f.source.is_empty()
                            || f.source.chars().any(char::is_control)
                        {
                            return Err(err("Invalid file reference"));
                        }
                        for c in &f.path {
                            component(c)?;
                        }
                        bytes = bytes
                            .checked_add(
                                f.source.len() + f.path.iter().map(String::len).sum::<usize>() + 64,
                            )
                            .ok_or_else(|| err("Draft too large"))?;
                    }
                }
                if let Entry::Torrent { name, data } = entry {
                    component(name)?;
                    if data.len() > MAX_METAINFO
                        || !matches!(inspect_item(data), ItemContent::Torrent(_))
                    {
                        return Err(err("Expected a valid .torrent, at most 8 MiB"));
                    }
                    bytes = bytes
                        .checked_add(data.len())
                        .ok_or_else(|| err("Draft too large"))?;
                }
            }
        }
        if bytes > MAX_DRAFT_BYTES {
            return Err(err("Draft content exceeds 32 MiB"));
        }
        fn walk(
            id: u64,
            pages: &BTreeMap<u64, &Page>,
            seen: &mut BTreeSet<u64>,
            depth: usize,
        ) -> Result<()> {
            if depth > 64 || !seen.insert(id) {
                return Err(err(
                    "Page cycle, repeated parent or nesting beyond 64 levels",
                ));
            }
            let p = pages.get(&id).ok_or_else(|| err("Unknown page"))?;
            for e in &p.entries {
                if let Entry::Page { page } = e {
                    walk(*page, pages, seen, depth + 1)?
                }
            }
            Ok(())
        }
        let mut seen = BTreeSet::new();
        walk(self.root, &pages, &mut seen, 1)?;
        if seen.len() != pages.len() {
            return Err(err("Draft contains unreachable pages"));
        }
        Ok(())
    }
    pub fn build(
        &self,
        key: &MutableKey,
        previous: &BTreeMap<u64, Previous>,
        prepared_at: u64,
    ) -> Result<Publication> {
        self.build_with_previous_root(key, previous, None, prepared_at)
    }
    /// Build a real publication with one host-supplied, durable operation time.
    pub fn build_with_previous_root(
        &self,
        key: &MutableKey,
        previous: &BTreeMap<u64, Previous>,
        previous_root: Option<[u8; 20]>,
        prepared_at: u64,
    ) -> Result<Publication> {
        crate::dates::Dates::new(None, prepared_at)?;
        self.construct(key, previous, previous_root, Some(prepared_at))
    }
    /// Virtual comparison only; never assigns publication dates to a draft.
    pub fn preview(
        &self,
        key: &MutableKey,
        previous: &BTreeMap<u64, Previous>,
    ) -> Result<Publication> {
        self.construct(key, previous, None, None)
    }
    fn construct(
        &self,
        key: &MutableKey,
        previous: &BTreeMap<u64, Previous>,
        previous_root: Option<[u8; 20]>,
        prepared_at: Option<u64>,
    ) -> Result<Publication> {
        self.validate()?;
        struct Builder<'a> {
            prepared_at: Option<u64>,
            previous_root: Option<[u8; 20]>,
            draft: &'a Draft,
            key: &'a MutableKey,
            previous: &'a BTreeMap<u64, Previous>,
            out: Publication,
        }
        impl Builder<'_> {
            fn page(&mut self, id: u64) -> Result<Vec<u8>> {
                let p = self
                    .draft
                    .pages
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| err("Unknown page"))?
                    .clone();
                let mut files = vec![];
                if !p.body.is_empty() {
                    files.push(Payload {
                        path: vec!["metadata".into(), "body.md".into()],
                        data: p.body.as_bytes().to_vec(),
                    })
                }
                for (index, e) in p.entries.iter().enumerate() {
                    let (name, data) = match e {
                        Entry::Page { page } => {
                            let title = self
                                .draft
                                .pages
                                .iter()
                                .find(|p| p.id == *page)
                                .ok_or_else(|| err("Unknown page"))?
                                .title
                                .clone();
                            (format!("{title}.torrent"), self.page(*page)?)
                        }
                        Entry::Torrent { name, data } => (name.clone(), data.clone()),
                        Entry::Files { .. } => {
                            return Err(err("File references require the host streaming builder"))
                        }
                    };
                    // Ordered local names avoid collisions, including repeated .torrent names.
                    let base = name;
                    let mut name = base.clone();
                    let mut suffix = index + 1;
                    while name == "metadata"
                        || files.iter().any(|f: &Payload| f.path == vec![name.clone()])
                    {
                        name = format!("{suffix}-{base}");
                        suffix += 1;
                    }
                    files.push(Payload {
                        path: vec![name],
                        data,
                    });
                }
                if files.iter().all(|f| f.data.is_empty()) {
                    return Err(err(format!(
                        "Page '{}' has no downloadable content",
                        p.title
                    )));
                }
                let mut hash = Sha1::new();
                hash.update(serde_json::to_vec(&p).map_err(err)?);
                if id == self.draft.root {
                    hash.update(self.key.public_key());
                    hash.update(self.key.salt());
                }
                for f in &files {
                    hash.update((f.data.len() as u64).to_be_bytes());
                    hash.update(&f.data)
                }
                let fingerprint = hex(&hash.finalize());
                if let Some(old) = self
                    .previous
                    .get(&id)
                    .filter(|old| old.fingerprint == fingerprint)
                {
                    Feed::from_metainfo(&old.metainfo).map_err(err)?;
                    self.out.pages.insert(id, old.clone());
                    return Ok(old.metainfo.clone());
                }
                let dates = if let Some(time) = self.prepared_at {
                    let prior = if id == self.draft.root {
                        if let Some(root) = self.previous_root {
                            self.previous.values().find(|old| {
                                Feed::from_metainfo(&old.metainfo)
                                    .is_ok_and(|f| f.infohash() == root)
                            })
                        } else {
                            self.previous.get(&id)
                        }
                    } else {
                        self.previous.get(&id)
                    };
                    let has_previous =
                        prior.is_some() || (id == self.draft.root && self.previous_root.is_some());
                    let created = if has_previous {
                        prior.and_then(|p| p.dates).and_then(|d| d.created_at)
                    } else {
                        Some(time)
                    };
                    let dates = crate::dates::Dates::new(created, time)?;
                    files.push(Payload {
                        path: vec!["metadata".into(), "dates.json".into()],
                        data: serde_json::to_vec(&dates).map_err(err)?,
                    });
                    Some(dates)
                } else {
                    None
                };
                let mut b = FeedBuilder::new(&p.title);
                if let Some(d) = dates {
                    b.outer.insert(
                        Cow::Borrowed(b"creation date"),
                        OuterValue::Integer(d.updated_at as i64),
                    );
                }
                if id == self.draft.root {
                    b.fields.source = Some(self.key.clone())
                }
                if let Some(old) = self.previous.get(&id) {
                    b.fields.previous = Some(TorrentLink::new(
                        Feed::from_metainfo(&old.metainfo).map_err(err)?.infohash(),
                    ))
                }
                if id == self.draft.root && self.previous_root.is_some() {
                    b.fields.previous = self.previous_root.map(TorrentLink::new);
                }
                b.entries = files
                    .iter()
                    .map(|f| BuildEntry::file(f.path.clone(), f.data.len() as u64))
                    .collect();
                let built = b.build(|i| Ok(Cursor::new(&files[i].data))).map_err(err)?;
                let meta = built.metainfo;
                self.out.pages.insert(
                    id,
                    Previous {
                        fingerprint: fingerprint.clone(),
                        metainfo: meta.clone(),
                        dates,
                    },
                );
                self.out.catalogs.push(BuiltCatalog {
                    page: id,
                    fingerprint,
                    metainfo: meta.clone(),
                    files,
                });
                Ok(meta)
            }
        }
        let mut b = Builder {
            prepared_at,
            previous_root,
            draft: self,
            key,
            previous,
            out: Publication {
                root: [0; 20],
                catalogs: vec![],
                pages: BTreeMap::new(),
            },
        };
        let root = b.page(self.root)?;
        b.out.root = Feed::from_metainfo(&root).map_err(err)?.infohash();
        Ok(b.out)
    }
}

/// Check every payload and padding byte before accepting an imported catalog.
pub fn verify_payload(metainfo: &[u8], files: &[(Vec<String>, Vec<u8>)]) -> Result<()> {
    let post = Feed::from_metainfo(metainfo).map_err(err)?;
    let mut piece = Sha1::new();
    let mut filled = 0usize;
    let mut hashes = vec![];
    let zeros = [0u8; 32768];
    let mut seen = 0;
    for entry in post.entries() {
        let padding = entry.kind() == EntryKind::Padding;
        let data = if padding {
            None
        } else {
            seen += 1;
            Some(
                &files
                    .iter()
                    .find(|(p, _)| *p == entry.path())
                    .ok_or_else(|| err("Missing catalog payload"))?
                    .1,
            )
        };
        if let Some(data) = data {
            if data.len() as u64 != entry.length()
                || entry
                    .sha1()
                    .is_some_and(|h| h != <[u8; 20]>::from(Sha1::digest(data)))
            {
                return Err(err("Catalog file hash or length mismatch"));
            }
        }
        let mut offset = 0u64;
        while offset < entry.length() {
            let len = (entry.length() - offset)
                .min(zeros.len() as u64)
                .min((post.piece_length() as usize - filled) as u64) as usize;
            if let Some(data) = data {
                piece.update(&data[offset as usize..offset as usize + len])
            } else {
                piece.update(&zeros[..len])
            }
            offset += len as u64;
            filled += len;
            if filled == post.piece_length() as usize {
                hashes.extend_from_slice(&piece.finalize_reset());
                filled = 0;
            }
        }
    }
    if filled > 0 {
        hashes.extend_from_slice(&piece.finalize())
    }
    if seen != files.len() || hashes != post.pieces() {
        return Err(err("Catalog piece hashes do not match payload"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use feedtorrent_bep::bep44::Bep44Signer;
    #[test]
    fn nested_revisions_reuse_and_exact_outer_bytes() {
        let key =
            MutableKey::new(Bep44Signer::from_seed(&[3; 32]).public_key(), vec![1; 32]).unwrap();
        let mut d = Draft::new("root".into());
        d.pages[0].entries.push(Entry::Page { page: 2 });
        d.pages.push(Page {
            id: 2,
            title: "child".into(),
            body: "hello".into(),
            entries: vec![],
        });
        let a = d.build(&key, &BTreeMap::new(), 1_700_000_000).unwrap();
        assert_eq!(a.catalogs.len(), 2);
        let b = d.build(&key, &a.pages, 1_700_000_100).unwrap();
        assert_eq!(a.root, b.root);
        assert!(b.catalogs.is_empty());
        d.pages[1].body = "updated".into();
        let c = d.build(&key, &a.pages, 1_700_000_100).unwrap();
        assert_ne!(a.root, c.root);
        assert_eq!(c.catalogs.len(), 2);
        let root = Feed::from_metainfo(&c.pages[&1].metainfo).unwrap();
        assert_eq!(root.fields().previous.as_ref().unwrap().infohash(), a.root);
        assert!(Feed::from_metainfo(&c.pages[&2].metainfo)
            .unwrap()
            .fields()
            .source
            .is_none());
        let child = &c.catalogs[1].files[0].data;
        assert_eq!(child, &c.pages[&2].metainfo);
    }
    #[test]
    fn unsafe_cycle_empty_and_unreachable() {
        let mut d = Draft::new("root".into());
        assert!(d.validate().is_ok());
        d.pages[0].entries.push(Entry::Page { page: 1 });
        assert!(d.validate().is_err());
        d.pages[0].entries.clear();
        d.pages[0].title = "../escape".into();
        assert!(d.validate().is_err());
    }

    #[test]
    fn duplicate_names_outer_bytes_and_large_piece_corruption() {
        use std::borrow::Cow;
        let key = MutableKey::new(Bep44Signer::from_seed(&[8; 32]).public_key(), vec![1]).unwrap();
        let mut b = FeedBuilder::new("item");
        b.entries.push(BuildEntry::file(vec!["data".into()], 40000));
        let data = vec![7; 40000];
        b.outer.insert(
            Cow::Borrowed(b"comment"),
            OuterValue::Bytes(Cow::Borrowed(b"first")),
        );
        let a = b.build(|_| Ok(Cursor::new(&data))).unwrap();
        b.outer.insert(
            Cow::Borrowed(b"comment"),
            OuterValue::Bytes(Cow::Borrowed(b"second")),
        );
        let c = b.build(|_| Ok(Cursor::new(&data))).unwrap();
        assert_eq!(a.feed.infohash(), c.feed.infohash());
        assert_ne!(a.metainfo, c.metainfo);
        let mut d = Draft::new("large".into());
        d.pages[0].body = "x".repeat(900000);
        d.pages[0].entries = vec![
            Entry::Torrent {
                name: "x.torrent".into(),
                data: a.metainfo.clone(),
            },
            Entry::Torrent {
                name: "3-x.torrent".into(),
                data: c.metainfo.clone(),
            },
            Entry::Torrent {
                name: "x.torrent".into(),
                data: a.metainfo,
            },
        ];
        let built = d.build(&key, &BTreeMap::new(), 1_700_000_000).unwrap();
        let package = &built.catalogs[0];
        let files: Vec<_> = package
            .files
            .iter()
            .map(|f| (f.path.clone(), f.data.clone()))
            .collect();
        verify_payload(&package.metainfo, &files).unwrap();
        let paths: BTreeSet<_> = files.iter().map(|f| &f.0).collect();
        assert_eq!(paths.len(), files.len());
        assert_eq!(files[2].1, c.metainfo);
        let mut corrupt = files;
        corrupt[0].1[32769] ^= 1;
        assert!(verify_payload(&package.metainfo, &corrupt).is_err());
    }

    #[test]
    fn restored_root_keeps_previous_link_without_cached_metadata() {
        let key = MutableKey::new(Bep44Signer::from_seed(&[9; 32]).public_key(), vec![3]).unwrap();
        let mut d = Draft::new("restored".into());
        d.pages[0].body = "Recovered text".into();
        let built = d
            .build_with_previous_root(&key, &BTreeMap::new(), Some([42; 20]), 1_700_000_000)
            .unwrap();
        let root = Feed::from_metainfo(&built.catalogs[0].metainfo).unwrap();
        assert_eq!(
            root.fields().previous.as_ref().unwrap().infohash(),
            [42; 20]
        );
        let other =
            MutableKey::new(Bep44Signer::from_seed(&[10; 32]).public_key(), vec![3]).unwrap();
        let changed = d.build(&other, &built.pages, 1_700_000_100).unwrap();
        assert_ne!(built.root, changed.root);
    }
}

#[cfg(test)]
#[path = "publishing_dates_tests.rs"]
mod dates_tests;
