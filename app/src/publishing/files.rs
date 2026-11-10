//! Host filesystem adapters for streamed catalogs and immutable payloads.
use super::*;
use feedtorrent_posts::publishing::{Entry, SourceFile, StreamCatalog, StreamData};
use std::sync::atomic::AtomicBool;
pub(super) struct Package {
    pub metainfo: Vec<u8>,
    pub files: Vec<(Vec<String>, PathBuf)>,
}
pub(super) fn paths(dir: &Path, hash: &str) -> Result<Package> {
    let root = package_path(dir, hash)?;
    let metainfo = read(&dir.join("published").join(format!("{hash}.source")))?;
    let desc = LibtorrentBackend::describe_torrent(&metainfo)?;
    if desc.id != hash {
        bail!("Catalog identity mismatch");
    }
    let mapping = external(&root)?;
    let files = desc
        .files
        .iter()
        .map(|f| {
            let relative = f
                .name
                .strip_prefix(&format!("{}/", desc.name))
                .unwrap_or(&f.name)
                .split('/')
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let source = mapping
                .get(&f.name)
                .cloned()
                .unwrap_or_else(|| root.join(&f.name));
            Ok((relative, source))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Package { metainfo, files })
}
pub(crate) fn external(root: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let id = root
        .file_name()
        .and_then(|s| s.to_str())
        .context("Invalid transfer root")?;
    let file = root
        .parent()
        .context("Invalid transfer root")?
        .join(format!("{id}.external"));
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    let mut mapping = BTreeMap::new();
    for line in String::from_utf8(read_limited(&file)?)?.lines() {
        let (name, path) = line.split_once('\t').context("Invalid external manifest")?;
        if Path::new(name).is_absolute()
            || name.split('/').any(|p| matches!(p, ".." | "." | ""))
            || !Path::new(path).is_absolute()
            || mapping
                .insert(name.to_owned(), PathBuf::from(path))
                .is_some()
        {
            bail!("Invalid external manifest entry");
        }
    }
    Ok(mapping)
}
pub(super) fn verify(p: &Package) -> Result<()> {
    let desc = LibtorrentBackend::describe_torrent(&p.metainfo)?;
    let inputs = p
        .files
        .iter()
        .map(|(parts, path)| {
            let name = if desc.files.len() == 1 && desc.files[0].name == desc.name {
                desc.name.clone()
            } else {
                format!("{}/{}", desc.name, parts.join("/"))
            };
            Ok(feedtorrent_libtorrent::creation::Input {
                name,
                source: path.to_str().context("Non-UTF-8 payload path")?.into(),
                length: fs::metadata(path)?.len(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut verifier = feedtorrent_libtorrent::creation::Builder::verifier(&p.metainfo, inputs)?;
    let mut done = 0;
    while done < desc.total {
        done = verifier.step()?;
    }
    let _ = verifier.finish()?;
    Ok(())
}
pub(super) fn dates(dir: &Path, hash: &str) -> Option<feedtorrent_posts::dates::Dates> {
    let p = paths(dir, hash).ok()?;
    let path = &p
        .files
        .iter()
        .find(|(p, _)| p == &["metadata", "dates.json"])?
        .1;
    if fs::metadata(path).ok()?.len() > feedtorrent_posts::dates::MAX_BYTES as u64 {
        return None;
    }
    feedtorrent_posts::dates::Dates::parse(&fs::read(path).ok()?)
}
pub(super) fn equal(a: &Path, b: &Path) -> Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let mut a = File::open(a)?;
    let mut b = File::open(b)?;
    let mut x = [0; 65536];
    let mut y = [0; 65536];
    loop {
        let n = a.read(&mut x)?;
        if n == 0 {
            return Ok(true);
        }
        b.read_exact(&mut y[..n])?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
    }
}
fn copy_atomic(from: &Path, target: &Path, cancel: &AtomicBool) -> Result<()> {
    if target.exists() {
        if !equal(from, target)? {
            bail!("Existing catalog file differs; files preserved");
        }
        return Ok(());
    }
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain staging entropy"))?;
    let tmp = target.with_extension(format!("copy-{}", hex(&random)));
    let result = crate::creation::copy_stream(from, &tmp, cancel).and_then(|()| {
        fs::rename(&tmp, target)?;
        Ok(())
    });
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
pub(super) fn store(dir: &Path, c: &StreamCatalog, work: &queue::Work) -> Result<()> {
    let feed = Feed::from_metainfo(&c.metainfo)?;
    let id = hex(&feed.infohash());
    let root = package_path(dir, &id)?;
    fs::create_dir_all(&root)?;
    reject_symlinks(&root)?;
    let mut external = String::new();
    for f in &c.files {
        work.check()?;
        let name = format!("{}/{}", feed.name(), f.path.join("/"));
        let target = root.join(&name);
        fs::create_dir_all(target.parent().context("Missing catalog directory")?)?;
        match &f.data {
            StreamData::Bytes(bytes) => {
                if target.exists() {
                    if read(&target)? != *bytes {
                        bail!("Existing catalog file differs; files preserved");
                    }
                } else {
                    save(&target, bytes)?;
                }
            }
            StreamData::File { file, copy } => {
                crate::creation::verify_source(file)?;
                if *copy {
                    copy_atomic(Path::new(&file.source), &target, &work.cancel)?;
                } else {
                    external.push_str(&format!("{name}\t{}\n", file.source));
                }
            }
        }
    }
    if !external.is_empty() {
        save(
            &dir.join("published").join(format!("{id}.external")),
            external.as_bytes(),
        )?;
    }
    save(
        &dir.join("published").join(format!("{id}.source")),
        &c.metainfo,
    )?;
    verify(&paths(dir, &id)?)?;
    Ok(())
}
struct CheckedFile<'a> {
    file: File,
    work: &'a queue::Work,
}
impl Read for CheckedFile<'_> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.work.check().map_err(std::io::Error::other)?;
        self.file.read(b)
    }
}
pub(super) fn build(
    dir: &Path,
    pending: &queue::Pending,
    key: &MutableKey,
    previous: &BTreeMap<u64, Previous>,
    previous_root: Option<[u8; 20]>,
    native: &mpsc::SyncSender<NativeTask>,
    work: &queue::Work,
) -> Result<feedtorrent_posts::publishing::StreamPublication> {
    let mut links = BTreeMap::new();
    for page in &pending.draft.pages {
        for (index, entry) in page.entries.iter().enumerate() {
            if let Entry::Files {
                name,
                files,
                linked: true,
                copy,
            } = entry
            {
                let mut random = [0; 20];
                getrandom::fill(&mut random)
                    .map_err(|_| anyhow!("Cannot obtain torrent entropy"))?;
                let mut draft = Draft::new(name.clone());
                draft.pages[0].entries.push(Entry::Files {
                    name: name.clone(),
                    files: files.clone(),
                    linked: false,
                    copy: *copy,
                });
                let d = crate::creation::DraftView {
                    id: hex(&random),
                    draft,
                    revision: 1,
                    post: false,
                    copy_files: *copy,
                    phase: "Draft".into(),
                    error: String::new(),
                    done: 0,
                    total: 0,
                    operation: work.identity().1,
                    result: None,
                };
                let mut p = crate::creation::prepare_common(
                    &dir.join("published"),
                    dir,
                    &d,
                    &work.cancel,
                    |_, _, _| work.check(),
                )?;
                let prior = dir.join("published").join(format!("{}.source", p.id));
                if prior.exists() {
                    let bytes = read(&prior)?;
                    if LibtorrentBackend::describe_torrent(&bytes)?.id != p.id {
                        bail!("Linked torrent source conflicts");
                    }
                    p.metainfo = bytes;
                }
                let outcome: Result<()> = (|| {
                    work.call(
                        native,
                        Native::Reserve {
                            post: work.identity().0.into(),
                            operation: work.identity().1,
                            metainfo: p.metainfo.clone(),
                        },
                    )?;
                    let target = package_path(dir, &p.id)?;
                    let fresh = fs::read_dir(&target)?.next().is_none()
                        && !dir
                            .join("published")
                            .join(format!("{}.external", p.id))
                            .exists();
                    if fresh {
                        fs::remove_dir(&target)?;
                        fs::rename(&p.stage, &target)?;
                        let _ = fs::remove_file(target.join(".creation-owner"));
                    } else {
                        fs::remove_dir_all(&p.stage)?;
                    }
                    if fresh && !p.external.is_empty() {
                        save(
                            &dir.join("published").join(format!("{}.external", p.id)),
                            p.external.as_bytes(),
                        )?;
                    }
                    work.call(
                        native,
                        Native::Seed(vec![Seed {
                            id: p.id.clone(),
                            metainfo: p.metainfo.clone(),
                            path: target,
                        }]),
                    )?;
                    Ok(())
                })();
                if outcome.is_err() {
                    let _ = fs::remove_dir_all(&p.stage);
                }
                outcome?;
                links.insert((page.id, index), p.metainfo);
            }
        }
    }
    pending
        .draft
        .build_streaming(
            key,
            previous,
            previous_root,
            pending
                .prepared_at
                .context("Publication has no preparation time")?,
            &links,
            |file: &SourceFile| {
                crate::creation::verify_source(file).map_err(std::io::Error::other)?;
                Ok(CheckedFile {
                    file: File::open(&file.source)?,
                    work,
                })
            },
        )
        .map_err(Into::into)
}
