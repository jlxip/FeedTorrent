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
        version: 2,
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
                let pack = package(dir, hash)?;
                for (name, bytes) in std::iter::once(("source".to_owned(), &pack.metainfo)).chain(
                    pack.files
                        .iter()
                        .enumerate()
                        .map(|(i, (_, data))| (format!("file-{i}"), data)),
                ) {
                    total = total.checked_add(bytes.len()).context("Backup too large")?;
                    if total > MAX_LIBRARY {
                        bail!("Backup exceeds 256 MiB")
                    }
                    append(&mut tar, &format!("catalogs/{hash}/{name}"), bytes)?;
                }
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
            || name.strip_prefix("catalogs/").is_some_and(|rest| {
                rest.split_once('/').is_some_and(|(hash, file)| {
                    valid_id(hash)
                        && (file == "source"
                            || file.strip_prefix("file-").is_some_and(|n| {
                                !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
                            }))
                })
            });
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
    if manifest.version != 2 {
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
    let hashes: BTreeSet<_> = entries
        .keys()
        .filter_map(|name| {
            name.strip_prefix("catalogs/")
                .and_then(|rest| rest.split_once('/').map(|(hash, _)| hash.to_owned()))
        })
        .collect();
    let mut packages = BTreeMap::new();
    for hash in &hashes {
        let metainfo = entries
            .get(&format!("catalogs/{hash}/source"))
            .context("Backup catalog source missing")?
            .clone();
        let feed = Feed::from_metainfo(&metainfo)?;
        if hex(&feed.infohash()) != *hash {
            bail!("Backup catalog identity mismatch")
        }
        let mut files = vec![];
        for (index, entry) in feed
            .entries()
            .iter()
            .filter(|entry| entry.kind() != EntryKind::Padding)
            .enumerate()
        {
            let data = entries
                .get(&format!("catalogs/{hash}/file-{index}"))
                .context("Backup catalog payload missing")?
                .clone();
            files.push((entry.path().to_vec(), data));
        }
        if entries
            .keys()
            .filter(|name| name.starts_with(&format!("catalogs/{hash}/")))
            .count()
            != files.len() + 1
        {
            bail!("Backup has unexpected catalog files")
        }
        feedtorrent_posts::publishing::verify_payload(&metainfo, &files)?;
        let root = package_path(dir, hash)?;
        if root.exists() {
            let current = package(dir, hash)?;
            if current.metainfo != metainfo || current.files != files {
                bail!("Backup conflicts with an existing catalog")
            }
        } else if dir
            .join("published")
            .join(format!("{hash}.source"))
            .exists()
            || dir
                .join("published")
                .join(format!("{hash}.transfer.json"))
                .exists()
        {
            bail!("Backup conflicts with existing catalog metadata")
        }
        packages.insert(hash.clone(), CatalogData { metainfo, files });
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
                if !packages.contains_key(hash) {
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
    // Catalogs are immutable. Validate the complete archive before writing any.
    for (hash, pack) in packages {
        let root = package_path(dir, &hash)?;
        if root.exists() {
            continue;
        }
        fs::create_dir_all(&root)?;
        let feed = Feed::from_metainfo(&pack.metainfo)?;
        save(
            &dir.join("published").join(format!("{hash}.source")),
            &pack.metainfo,
        )?;
        let manifest = serde_json::json!({"version":1,"magnet":false,"active":true,"seed":true,"held":false,"kind":"owned_catalog","post":null,"pinned":false});
        save(
            &dir.join("published").join(format!("{hash}.transfer.json")),
            &serde_json::to_vec(&manifest)?,
        )?;
        for (parts, data) in pack.files {
            let target = parts.iter().fold(root.join(feed.name()), |p, n| p.join(n));
            fs::create_dir_all(target.parent().context("Missing catalog directory")?)?;
            save(&target, &data)?;
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
