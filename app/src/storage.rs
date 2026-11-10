//! The two torrent roots have the same portable layout. The registry keeps
//! global settings and references; each root can also restore its own torrents.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    magnet: bool,
    active: bool,
    seed: bool,
    held: bool,
    kind: String,
    post: Option<String>,
    #[serde(default)]
    pinned: bool,
}

pub(super) struct Discovered {
    pub record: Record,
    pub pinned: bool,
}

pub(super) fn published(dir: &Path) -> PathBuf {
    dir.join("published")
}

pub(super) fn sidecar(record: &Record, suffix: &str) -> Result<PathBuf> {
    if !valid_id(&record.id) || record.path.file_name().and_then(|s| s.to_str()) != Some(&record.id)
    {
        bail!("Invalid transfer path")
    }
    let root = record.path.parent().context("Transfer has no root")?;
    Ok(root.join(format!("{}.{suffix}", record.id)))
}

pub(super) fn write_manifest(record: &Record, pinned: bool) -> Result<()> {
    let path = sidecar(record, "transfer.json")?;
    let manifest = Manifest {
        version: 1,
        magnet: record.magnet,
        active: record.active,
        seed: record.seed,
        held: record.held,
        kind: record.kind.clone(),
        post: record.post.clone(),
        pinned,
    };
    atomic(&path, &serde_json::to_vec_pretty(&manifest)?)
}

pub(super) fn discover(root: &Path) -> Result<(Vec<Discovered>, Vec<String>)> {
    if !root.exists() {
        return Ok((vec![], vec![]));
    }
    reject_symlinks(root)?;
    let mut records = vec![];
    let mut errors = vec![];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(".transfer.json") else {
            if valid_id(name)
                && entry.file_type()?.is_dir()
                && !root.join(format!("{name}.transfer.json")).exists()
            {
                errors.push(format!("Torrent {name} has no recovery manifest"));
            }
            continue;
        };
        let record = (|| -> Result<Discovered> {
            if !valid_id(id) || !entry.file_type()?.is_file() {
                bail!("Invalid transfer manifest")
            }
            let path = root.join(id);
            if !path.is_dir() || !root.join(format!("{id}.source")).is_file() {
                bail!("Incomplete transfer backup")
            }
            reject_symlinks(&path)?;
            let manifest: Manifest = serde_json::from_slice(&read_limited(&entry.path())?)?;
            if manifest.version != 1 {
                bail!("Unsupported transfer manifest")
            }
            Ok(Discovered {
                record: Record {
                    id: id.into(),
                    magnet: manifest.magnet,
                    path,
                    active: manifest.active,
                    seed: manifest.seed,
                    held: manifest.held,
                    kind: manifest.kind,
                    post: manifest.post,
                },
                pinned: manifest.pinned,
            })
        })();
        match record {
            Ok(record) => records.push(record),
            Err(error) => errors.push(format!("Torrent {id}: {error:#}")),
        }
    }
    Ok((records, errors))
}

pub(super) fn move_record(record: &Record, root: &Path) -> Result<Record> {
    let mut moved = record.clone();
    if record.path.parent() == Some(root) {
        return Ok(moved);
    }
    fs::create_dir_all(root)?;
    reject_symlinks(root)?;
    let target = root.join(&record.id);
    if target.exists() {
        bail!(
            "Destination already contains torrent {}; files preserved",
            record.id
        )
    }
    reject_symlinks(&record.path)?;
    for suffix in ["source", "resume", "info", "transfer.json", "external"] {
        if root.join(format!("{}.{suffix}", record.id)).exists() {
            bail!(
                "Destination metadata conflicts for {}; files preserved",
                record.id
            )
        }
    }
    if !sidecar(record, "source")?.is_file() {
        bail!("Transfer source missing; files preserved")
    }
    // Make the destination self-contained before moving its payload. A crash
    // before the rename leaves the original complete; after it, the new root
    // can be discovered even if the central registry still names the old path.
    for suffix in ["source", "resume", "info", "transfer.json", "external"] {
        let from = sidecar(record, suffix)?;
        if from.exists() {
            let to = root.join(format!("{}.{suffix}", record.id));
            fs::copy(&from, &to)?;
            if fs::read(&from)? != fs::read(&to)? {
                bail!("Transfer metadata copy failed")
            }
        }
    }
    // Rename is atomic on the same volume. Across volumes, copy to a temporary
    // directory and verify every byte before replacing the old location.
    if let Err(error) = fs::rename(&record.path, &target) {
        if error.raw_os_error() != Some(18) {
            return Err(error.into());
        }
        let temp = root.join(format!("{}.moving", record.id));
        if temp.exists() {
            bail!("Interrupted transfer move: {}", temp.display())
        }
        copy_tree(&record.path, &temp)?;
        verify_tree(&record.path, &temp)?;
        fs::rename(&temp, &target)?;
        fs::remove_dir_all(&record.path)?;
    }
    moved.path = target;
    for suffix in ["source", "resume", "info", "transfer.json", "external"] {
        let from = sidecar(record, suffix)?;
        if from.exists() {
            fs::remove_file(from)?;
        }
    }
    Ok(moved)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if entry.file_type()?.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            bail!("Unsafe transfer entry")
        }
    }
    Ok(())
}

fn verify_tree(from: &Path, to: &Path) -> Result<()> {
    let a = fs::read_dir(from)?.collect::<std::io::Result<Vec<_>>>()?;
    let b = fs::read_dir(to)?.collect::<std::io::Result<Vec<_>>>()?;
    if a.len() != b.len() {
        bail!("Transfer copy differs")
    }
    for entry in a {
        let other = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            verify_tree(&entry.path(), &other)?;
        } else if fs::read(entry.path())? != fs::read(other)? {
            bail!("Transfer copy differs")
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_roots_use_the_same_restorable_layout_and_moves_preserve_bytes() {
        let dir = std::env::temp_dir().join(format!("feedtorrent-storage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let downloads = dir.join("downloads");
        let published = dir.join("published");
        let id = "0123456789012345678901234567890123456789";
        fs::create_dir_all(downloads.join(id).join("Document")).unwrap();
        fs::write(downloads.join(id).join("Document/body.md"), b"post bytes").unwrap();
        let record = Record {
            id: id.into(),
            magnet: false,
            path: downloads.join(id),
            active: true,
            seed: true,
            held: false,
            kind: "owned_catalog".into(),
            post: None,
        };
        fs::write(sidecar(&record, "source").unwrap(), b"metainfo").unwrap();
        fs::write(sidecar(&record, "resume").unwrap(), b"resume").unwrap();
        write_manifest(&record, false).unwrap();
        let (found, errors) = discover(&downloads).unwrap();
        assert!(errors.is_empty());
        assert_eq!(found.len(), 1);
        assert!(!found[0].pinned);
        let moved = move_record(&found[0].record, &published).unwrap();
        let (found, errors) = discover(&published).unwrap();
        assert!(errors.is_empty());
        assert_eq!(found[0].record.path, moved.path);
        assert_eq!(
            fs::read(moved.path.join("Document/body.md")).unwrap(),
            b"post bytes"
        );
        assert_eq!(
            fs::read(sidecar(&moved, "source").unwrap()).unwrap(),
            b"metainfo"
        );
        assert_eq!(
            fs::read(sidecar(&moved, "resume").unwrap()).unwrap(),
            b"resume"
        );
        assert!(!record.path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incomplete_and_conflicting_copies_do_not_overwrite_files() {
        let dir = std::env::temp_dir().join(format!(
            "feedtorrent-storage-incomplete-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let downloads = dir.join("downloads");
        let published = dir.join("published");
        let id = "0123456789012345678901234567890123456789";
        fs::create_dir_all(downloads.join(id)).unwrap();
        fs::create_dir_all(&published).unwrap();
        let (found, errors) = discover(&downloads).unwrap();
        assert!(found.is_empty());
        assert_eq!(errors.len(), 1);
        let record = Record {
            id: id.into(),
            magnet: false,
            path: downloads.join(id),
            active: true,
            seed: true,
            held: false,
            kind: String::new(),
            post: None,
        };
        fs::write(sidecar(&record, "source").unwrap(), b"source").unwrap();
        write_manifest(&record, true).unwrap();
        assert!(discover(&downloads).unwrap().0[0].pinned);
        fs::write(published.join(format!("{id}.source")), b"conflict").unwrap();
        assert!(move_record(&record, &published).is_err());
        assert!(record.path.exists());
        assert_eq!(
            fs::read(published.join(format!("{id}.source"))).unwrap(),
            b"conflict"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
