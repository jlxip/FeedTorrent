use super::*;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    full: bool,
    library: Library,
}
pub(super) fn export(dir: &Path, lib: &Library, full: bool) -> Result<PathBuf> {
    if lib.vault.is_none() {
        bail!("No publishing key to export")
    }
    let mut library = lib.clone();
    for f in library.posts.values_mut() {
        f.pending = None;
    }
    if !full {
        for f in library.posts.values_mut() {
            f.draft = Draft::new(f.title.clone());
            f.pages.clear();
            f.published = None;
            f.history.clear();
        }
    }
    let data = serde_json::to_vec(&Manifest {
        version: 1,
        full,
        library,
    })?;
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain backup entropy"))?;
    let path = dir.join(format!("export-{}.tar", hex(&random)));
    let result = (|| -> Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        let mut tar = tar::Builder::new(file);
        fn append(tar: &mut tar::Builder<File>, name: &str, data: &[u8]) -> Result<()> {
            let mut h = tar::Header::new_ustar();
            h.set_size(data.len() as u64);
            h.set_mode(0o600);
            h.set_cksum();
            tar.append_data(&mut h, name, Cursor::new(data))?;
            Ok(())
        }
        append(&mut tar, "manifest.json", &data)?;
        let mut total = data.len();
        if full {
            let hashes: BTreeSet<_> = lib
                .posts
                .values()
                .flat_map(|f| {
                    f.history
                        .iter()
                        .chain(f.pages.values().map(|p| &p.hash))
                        .chain(
                            f.published
                                .iter()
                                .flat_map(|p| p.pages.values().map(|p| &p.hash)),
                        )
                })
                .collect();
            for hash in hashes {
                let bytes = read(&package_path(dir, hash)?)?;
                total = total.checked_add(bytes.len()).context("Backup too large")?;
                if total > MAX_LIBRARY {
                    bail!("Backup exceeds 256 MiB")
                };
                append(&mut tar, &format!("catalogs/{hash}.json"), &bytes)?;
            }
        }
        tar.finish()?;
        tar.into_inner()?.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}
pub(super) fn import(
    dir: &Path,
    current: &Library,
    bytes: &[u8],
    password: &Password,
) -> Result<Library> {
    if bytes.len() > MAX_LIBRARY {
        bail!("Backup exceeds 256 MiB")
    }
    let mut entries = BTreeMap::new();
    let mut total = 0u64;
    for entry in tar::Archive::new(Cursor::new(bytes)).entries()? {
        let mut e = entry?;
        if !e.header().entry_type().is_file() {
            bail!("Backup may contain only regular files")
        };
        let name = e
            .path()?
            .to_str()
            .context("Invalid backup path")?
            .to_owned();
        let allowed = name == "manifest.json"
            || name
                .strip_prefix("catalogs/")
                .and_then(|p| p.strip_suffix(".json"))
                .is_some_and(valid_id);
        if !allowed || entries.contains_key(&name) {
            bail!("Unsafe, unknown or duplicate backup path")
        }
        total = total
            .checked_add(e.size())
            .context("Backup length overflow")?;
        if total > MAX_LIBRARY as u64 {
            bail!("Backup payload exceeds 256 MiB")
        };
        let mut data = vec![];
        e.by_ref()
            .take(MAX_LIBRARY as u64 + 1)
            .read_to_end(&mut data)?;
        entries.insert(name, data);
    }
    let manifest: Manifest = serde_json::from_slice(
        entries
            .remove("manifest.json")
            .context("Missing backup manifest")?
            .as_slice(),
    )?;
    if manifest.version != 1 {
        bail!("Unsupported backup version")
    };
    validate(&manifest.library)?;
    let vault = manifest
        .library
        .vault
        .as_ref()
        .context("Missing encrypted key")?;
    drop(vault.unlock(password)?);
    if current
        .vault
        .as_ref()
        .is_some_and(|v| v.public_key != vault.public_key)
    {
        bail!("A different key requires another data directory")
    }
    for (name, data) in &entries {
        let hash = name
            .strip_prefix("catalogs/")
            .and_then(|p| p.strip_suffix(".json"))
            .context("Invalid package")?;
        let pack: Package = serde_json::from_slice(data)?;
        let f = Feed::from_metainfo(&pack.metainfo)?;
        if hex(&f.infohash()) != hash {
            bail!("Backup catalog identity mismatch")
        };
        feedtorrent_posts::publishing::verify_payload(&pack.metainfo, &pack.files)?;
        let path = package_path(dir, hash)?;
        if path.exists() && read(&path)? != *data {
            bail!("Backup conflicts with an existing catalog")
        }
    }
    let mut candidate = current.clone();
    if candidate.vault.is_none() {
        candidate.vault = manifest.library.vault.clone()
    }
    for (id, mut f) in manifest.library.posts {
        if let Some(existing) = candidate.posts.get(&id) {
            if serde_json::to_vec(existing)? != serde_json::to_vec(&f)? {
                bail!("Backup conflicts with an existing post or draft")
            };
            continue;
        }
        if manifest.full {
            for hash in f
                .history
                .iter()
                .chain(f.pages.values().map(|p| &p.hash))
                .chain(
                    f.published
                        .iter()
                        .flat_map(|p| p.pages.values().map(|p| &p.hash)),
                )
            {
                if !entries.contains_key(&format!("catalogs/{hash}.json")) {
                    bail!("Backup is missing a catalog")
                }
            }
        }
        recover_published_sequence(&mut f)?;
        f.pending = None;
        f.active = false;
        f.state = "Restored; publishing disabled".into();
        f.error.clear();
        candidate.posts.insert(id, f);
    }
    validate(&candidate)?;
    // Commit immutable packages only after validating the entire archive. They
    // are harmless if the final atomic registry commit fails; no live data moves.
    for (name, data) in entries {
        let hash = name
            .strip_prefix("catalogs/")
            .and_then(|p| p.strip_suffix(".json"))
            .context("Invalid package path")?;
        let path = package_path(dir, hash)?;
        if !path.exists() {
            save(&path, &data)?
        }
    }
    persist(dir, &candidate)?;
    Ok(candidate)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn traversal_and_links_rejected() {
        let dir = std::env::temp_dir().join(format!("feedtorrent-backup-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut bytes = vec![];
        {
            let mut t = tar::Builder::new(&mut bytes);
            let mut h = tar::Header::new_ustar();
            h.set_size(0);
            h.set_mode(0o600);
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_link_name("outside").unwrap();
            h.set_cksum();
            t.append_data(&mut h, "manifest.json", Cursor::new([]))
                .unwrap();
            t.finish().unwrap();
        }
        assert!(import(&dir, &Library::default(), &bytes, &Password("x".into())).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
