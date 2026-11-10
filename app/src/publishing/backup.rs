use super::*;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    full: bool,
    library: Library,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    creation: Option<serde_json::Value>,
}
struct Scratch(PathBuf);
struct Install {
    created: Vec<PathBuf>,
    creation: Option<(PathBuf, Option<PathBuf>)>,
    committed: bool,
}
impl Drop for Install {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Some((target, backup)) = &self.creation {
            let _ = fs::remove_file(target);
            if let Some(backup) = backup {
                let _ = fs::rename(backup, target);
            }
        }
        for p in self.created.iter().rev() {
            if p.is_dir() {
                let _ = fs::remove_dir_all(p);
            } else {
                let _ = fs::remove_file(p);
            }
        }
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn scratch(dir: &Path) -> Result<Scratch> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain backup entropy"))?;
    let path = dir.join(format!(".restore-{}", hex(&random)));
    fs::create_dir(&path)?;
    Ok(Scratch(path))
}
fn asset_refs(
    value: &mut serde_json::Value,
    assets: &mut BTreeMap<String, feedtorrent_posts::publishing::SourceFile>,
) -> Result<()> {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("source")
            && object.contains_key("path")
            && object.contains_key("modified")
            && object.contains_key("length")
        {
            let f: feedtorrent_posts::publishing::SourceFile =
                serde_json::from_value(serde_json::Value::Object(object.clone()))?;
            crate::creation::verify_source(&f)?;
            let token = if let Some((token, _)) = assets.iter().find(|(_, old)| {
                old.source == f.source && old.modified == f.modified && old.length == f.length
            }) {
                token.clone()
            } else {
                let mut random = [0; 20];
                getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain asset entropy"))?;
                let token = hex(&random);
                assets.insert(token.clone(), f);
                token
            };
            object.insert(
                "source".into(),
                serde_json::json!(format!("archive:{token}")),
            );
            return Ok(());
        }
        for child in object.values_mut() {
            asset_refs(child, assets)?;
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            asset_refs(child, assets)?;
        }
    }
    Ok(())
}
fn restore_refs(
    value: &mut serde_json::Value,
    dir: &Path,
    assets: &BTreeMap<String, PathBuf>,
) -> Result<()> {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("source")
            && object.contains_key("path")
            && object.contains_key("modified")
            && object.contains_key("length")
        {
            let token = object["source"]
                .as_str()
                .and_then(|s| s.strip_prefix("archive:"))
                .context("Backup file reference is not self-contained")?;
            let input = assets
                .get(token)
                .context("Backup is missing a draft asset")?;
            let target = dir.join("publishing-assets").join(token);
            if fs::metadata(input)?.len()
                != object["length"].as_u64().context("Invalid asset length")?
            {
                bail!("Draft asset length mismatch");
            }
            object.insert("source".into(), serde_json::json!(target));
            object.insert(
                "modified".into(),
                serde_json::json!(crate::creation::stamp(if target.exists() {
                    &target
                } else {
                    input
                })?),
            );
            return Ok(());
        }
        if object.get("kind").and_then(|v| v.as_str()) == Some("files") {
            object.insert("copy".into(), serde_json::json!(true));
        }
        for child in object.values_mut() {
            restore_refs(child, dir, assets)?;
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            restore_refs(child, dir, assets)?;
        }
    }
    Ok(())
}
fn append<R: Read>(tar: &mut tar::Builder<File>, name: &str, size: u64, input: R) -> Result<()> {
    let mut h = tar::Header::new_ustar();
    h.set_size(size);
    h.set_mode(0o600);
    h.set_cksum();
    tar.append_data(&mut h, name, input)?;
    Ok(())
}
pub(super) fn export(dir: &Path, lib: &Library, full: bool) -> Result<PathBuf> {
    if lib.vault.is_none() {
        bail!("No publishing key to export");
    }
    let mut library = lib.clone();
    for f in library.posts.values_mut() {
        f.pending = None;
        if !full {
            f.draft = Draft::new(f.title.clone());
            f.pages.clear();
            f.published = None;
            f.history.clear();
        }
    }
    let mut assets = BTreeMap::new();
    let mut value = serde_json::to_value(&library)?;
    let mut creation = if full && dir.join("creation.json").exists() {
        Some(serde_json::from_slice::<serde_json::Value>(&read(
            &dir.join("creation.json"),
        )?)?)
    } else {
        None
    };
    if let Some(c) = &mut creation {
        if let Some(drafts) = c["drafts"].as_object_mut() {
            drafts.retain(|_, d| d.get("result").is_none_or(serde_json::Value::is_null));
        }
    }
    if full {
        asset_refs(&mut value, &mut assets)?;
        if let Some(c) = &mut creation {
            asset_refs(c, &mut assets)?;
        }
        library = serde_json::from_value(value)?;
    }
    let data = serde_json::to_vec(&Manifest {
        version: if assets.is_empty() && creation.is_none() {
            2
        } else {
            3
        },
        full,
        library,
        creation,
    })?;
    if data.len() > MAX_LIBRARY {
        bail!("Backup manifest exceeds 256 MiB");
    }
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| anyhow!("Cannot obtain backup entropy"))?;
    let path = dir.join(format!("export-{}.tar", hex(&random)));
    let result = (|| {
        use std::os::unix::fs::OpenOptionsExt;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        let mut tar = tar::Builder::new(file);
        append(
            &mut tar,
            "manifest.json",
            data.len() as u64,
            Cursor::new(data),
        )?;
        if full {
            let mut hashes: BTreeSet<String> = lib
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
                .cloned()
                .collect();
            let mut included = BTreeSet::new();
            while let Some(hash) = hashes.iter().find(|h| !included.contains(*h)).cloned() {
                let pack = files::paths(dir, &hash)?;
                files::verify(&pack)?;
                included.insert(hash.clone());
                append(
                    &mut tar,
                    &format!("catalogs/{hash}/source"),
                    pack.metainfo.len() as u64,
                    Cursor::new(&pack.metainfo),
                )?;
                for (i, (parts, path)) in pack.files.iter().enumerate() {
                    let length = fs::metadata(path)?.len();
                    append(
                        &mut tar,
                        &format!("catalogs/{hash}/file-{i}"),
                        length,
                        File::open(path)?,
                    )?;
                    if length <= 8 * 1024 * 1024
                        && parts.last().is_some_and(|p| p.ends_with(".torrent"))
                    {
                        if let feedtorrent_bep::bep49::ItemContent::Torrent(t) =
                            feedtorrent_bep::bep49::inspect_item(&fs::read(path)?)
                        {
                            let child = hex(&t.infohash());
                            if dir
                                .join("published")
                                .join(format!("{child}.source"))
                                .exists()
                            {
                                hashes.insert(child);
                            }
                        }
                    }
                }
                files::verify(&pack)?;
            }
            for (token, file) in &assets {
                crate::creation::verify_source(file)?;
                append(
                    &mut tar,
                    &format!("assets/{token}"),
                    file.length,
                    File::open(&file.source)?,
                )?;
                crate::creation::verify_source(file)?;
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
#[cfg(test)]
pub(super) fn import(
    dir: &Path,
    current: &Library,
    bytes: &[u8],
    password: &Password,
) -> Result<Library> {
    import_reader(dir, current, Cursor::new(bytes), password)
}
pub(super) fn import_reader(
    dir: &Path,
    current: &Library,
    input: impl Read,
    password: &Password,
) -> Result<Library> {
    let staging = scratch(dir)?;
    let mut entries = BTreeMap::new();
    for entry in tar::Archive::new(input).entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            bail!("Backup may contain only regular files");
        }
        let name = entry
            .path()?
            .to_str()
            .context("Invalid backup path")?
            .to_owned();
        let allowed = name == "manifest.json"
            || name.strip_prefix("assets/").is_some_and(valid_id)
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
            bail!("Unsafe, unknown or duplicate backup path");
        }
        if name == "manifest.json" && entry.size() > MAX_LIBRARY as u64
            || name.ends_with("/source") && entry.size() > 8 * 1024 * 1024
        {
            bail!("Backup metadata exceeds limit");
        }
        let path = staging.0.join(entries.len().to_string());
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        std::io::copy(&mut entry, &mut output)?;
        output.sync_all()?;
        entries.insert(name, path);
    }
    let manifest_path = entries
        .remove("manifest.json")
        .context("Missing backup manifest")?;
    let mut manifest: Manifest = serde_json::from_slice(&read(&manifest_path)?)?;
    if !matches!(manifest.version, 2 | 3) {
        bail!("Unsupported backup version");
    }
    if manifest.version == 2
        && manifest.library.posts.values().any(|f| {
            f.draft.pages.iter().any(|p| {
                p.entries
                    .iter()
                    .any(|e| matches!(e, feedtorrent_posts::publishing::Entry::Files { .. }))
            })
        })
    {
        bail!("Legacy backup contains unsupported host file references");
    }
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
        bail!("A different key requires another data directory");
    }
    let assets: BTreeMap<_, _> = entries
        .iter()
        .filter_map(|(name, path)| {
            name.strip_prefix("assets/")
                .map(|token| (token.to_owned(), path.clone()))
        })
        .collect();
    if !manifest.full && (!entries.is_empty() || manifest.creation.is_some()) {
        bail!("Key backup contains unexpected payloads");
    }
    let mut hashes: BTreeSet<String> = entries
        .keys()
        .filter_map(|name| {
            name.strip_prefix("catalogs/")
                .and_then(|rest| rest.split_once('/').map(|(h, _)| h.to_owned()))
        })
        .collect();
    let mut packages = BTreeMap::new();
    for hash in &hashes {
        let source = entries
            .get(&format!("catalogs/{hash}/source"))
            .context("Backup catalog source missing")?;
        let metainfo = fs::read(source)?;
        let desc = LibtorrentBackend::describe_torrent(&metainfo)?;
        if desc.id != *hash {
            bail!("Backup catalog identity mismatch");
        }
        let mut payload = vec![];
        for (i, file) in desc.files.iter().enumerate() {
            let path = entries
                .get(&format!("catalogs/{hash}/file-{i}"))
                .context("Backup catalog payload missing")?;
            let parts = file
                .name
                .strip_prefix(&format!("{}/", desc.name))
                .unwrap_or(&file.name)
                .split('/')
                .map(str::to_owned)
                .collect();
            payload.push((parts, path.clone()));
        }
        if entries
            .keys()
            .filter(|n| n.starts_with(&format!("catalogs/{hash}/")))
            .count()
            != payload.len() + 1
        {
            bail!("Backup has unexpected catalog files");
        }
        let pack = files::Package {
            metainfo,
            files: payload,
        };
        files::verify(&pack)?;
        let root = package_path(dir, hash)?;
        if root.exists() {
            let old = files::paths(dir, hash)?;
            if old.metainfo != pack.metainfo || old.files.len() != pack.files.len() {
                bail!("Backup conflicts with an existing catalog");
            }
            for ((a, x), (b, y)) in old.files.iter().zip(&pack.files) {
                if a != b || !files::equal(x, y)? {
                    bail!("Backup conflicts with an existing catalog");
                }
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
            bail!("Backup conflicts with existing catalog metadata");
        }
        packages.insert(hash.clone(), pack);
    }
    // Check all content and conflicts before installing files. Archive paths never
    // become filesystem paths; only validated metainfo and local asset tokens do.
    for (token, path) in &assets {
        let target = dir.join("publishing-assets").join(token);
        if target.exists() {
            crate::creation::source_path(&target)?;
            if !files::equal(path, &target)? {
                bail!("Backup draft asset conflicts with existing data");
            }
        }
    }
    if manifest.version == 3 {
        let mut value = serde_json::to_value(&manifest.library)?;
        restore_refs(&mut value, dir, &assets)?;
        manifest.library = serde_json::from_value(value)?;
        if let Some(c) = &mut manifest.creation {
            restore_refs(c, dir, &assets)?;
        }
    } else if !assets.is_empty() {
        bail!("Legacy backup contains unknown assets");
    }
    let creation = if let Some(mut incoming) = manifest.creation {
        crate::creation::validate_backup(&incoming)?;
        let current_file = dir.join("creation.json");
        if current_file.exists() {
            let existing: serde_json::Value = serde_json::from_slice(&read(&current_file)?)?;
            for (id, draft) in existing["drafts"]
                .as_object()
                .context("Invalid current creation drafts")?
            {
                let drafts = incoming["drafts"]
                    .as_object_mut()
                    .context("Invalid backup drafts")?;
                if drafts.get(id).is_some_and(|old| old != draft) {
                    bail!("Backup conflicts with an existing creation draft");
                }
                drafts.insert(id.clone(), draft.clone());
            }
        }
        Some(incoming)
    } else {
        None
    };
    let mut candidate = current.clone();
    if candidate.vault.is_none() {
        candidate.vault = manifest.library.vault.clone();
    }
    for (id, mut f) in manifest.library.posts {
        if let Some(old) = candidate.posts.get(&id) {
            if serde_json::to_vec(old)? != serde_json::to_vec(&f)? {
                bail!("Backup conflicts with an existing post or draft");
            }
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
                if !hashes.contains(hash) {
                    bail!("Backup is missing a catalog");
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
    let mut install = Install {
        created: vec![],
        creation: None,
        committed: false,
    };
    for (token, path) in &assets {
        let target = dir.join("publishing-assets").join(token);
        if !target.exists() {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::rename(path, &target)?;
            install.created.push(target);
        }
    }
    for (hash, pack) in packages {
        let root = package_path(dir, &hash)?;
        if root.exists() {
            continue;
        }
        fs::create_dir_all(&root)?;
        install.created.push(root.clone());
        let desc = LibtorrentBackend::describe_torrent(&pack.metainfo)?;
        for ((_, source), file) in pack.files.iter().zip(&desc.files) {
            let target = root.join(&file.name);
            fs::create_dir_all(target.parent().context("Missing payload parent")?)?;
            fs::rename(source, target)?;
        }
        let source = dir.join("published").join(format!("{hash}.source"));
        install.created.push(source.clone());
        save(&source, &pack.metainfo)?;
        let metadata = dir.join("published").join(format!("{hash}.transfer.json"));
        install.created.push(metadata.clone());
        save(
            &metadata,
            &serde_json::to_vec(
                &serde_json::json!({"version":1,"magnet":false,"active":true,"seed":true,"held":false,"kind":"owned_catalog","post":null,"pinned":false}),
            )?,
        )?;
    }
    if let Some(creation) = creation {
        let path = dir.join("creation.json");
        let backup = if path.exists() {
            let backup = staging.0.join("creation.previous.json");
            fs::rename(&path, &backup)?;
            Some(backup)
        } else {
            None
        };
        install.creation = Some((path.clone(), backup));
        save(&path, &serde_json::to_vec(&creation)?)?;
    }
    persist(dir, &candidate)?;
    install.committed = true;
    hashes.clear();
    Ok(candidate)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_metadata_commit_rolls_back_restored_assets_and_creation_drafts() {
        let dir = super::super::tests::root();
        let source = dir.join("original.bin");
        fs::write(&source, b"original bytes").unwrap();
        let source = fs::canonicalize(source).unwrap();
        let mut draft = Draft::new("Unfinished torrent".into());
        draft.pages[0]
            .entries
            .push(feedtorrent_posts::publishing::Entry::Files {
                name: "original.bin".into(),
                linked: false,
                copy: false,
                files: vec![feedtorrent_posts::publishing::SourceFile {
                    path: vec!["original.bin".into()],
                    source: source.to_str().unwrap().into(),
                    length: 14,
                    modified: crate::creation::stamp(&source).unwrap(),
                }],
            });
        let id = "01".repeat(20);
        let d = crate::creation::DraftView {
            id: id.clone(),
            revision: 1,
            post: false,
            copy_files: false,
            draft,
            phase: "Draft".into(),
            error: String::new(),
            done: 0,
            total: 14,
            operation: 0,
            result: None,
        };
        let drafts: BTreeMap<_, _> = std::iter::once((id, d)).collect();
        fs::write(
            dir.join("creation.json"),
            serde_json::to_vec(&serde_json::json!({"drafts":drafts})).unwrap(),
        )
        .unwrap();
        let password = Password("restore rollback test password".into());
        let lib = Library {
            vault: Some(Vault::create(&password).unwrap()),
            ..Library::default()
        };
        let archive = export(&dir, &lib, true).unwrap();
        let target = dir.join("target");
        fs::create_dir(&target).unwrap();
        let prior = br#"{"drafts":{}}"#;
        fs::write(target.join("creation.json"), prior).unwrap();
        fs::create_dir(target.join("publishing.json")).unwrap();
        assert!(import_reader(
            &target,
            &Library::default(),
            File::open(archive).unwrap(),
            &password
        )
        .is_err());
        assert_eq!(fs::read(target.join("creation.json")).unwrap(), prior);
        assert_eq!(fs::read(&source).unwrap(), b"original bytes");
        assert!(target.join("publishing.json").is_dir());
        if target.join("publishing-assets").exists() {
            assert_eq!(
                fs::read_dir(target.join("publishing-assets"))
                    .unwrap()
                    .count(),
                0
            );
        }
        assert!(!fs::read_dir(&target).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_str()
            .unwrap()
            .starts_with(".restore-")));
        fs::remove_dir_all(dir).unwrap();
    }
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
