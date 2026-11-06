//! Real host adapter for the portable coordinator. Owns I/O, not protocol rules.
use super::*;
use feedtorrent_bep::{
    bep44::{DhtBackend, DhtOptions, DhtOutcome, DhtRequest},
    bep50, TorrentMetadataBackend,
};
use feedtorrent_posts::{Action, Description, FileDescription, PostManager, Role, Source, WorkId};
use feedtorrent_pubsub_udp::{Bind, UdpPubSub};
use std::collections::BTreeMap;

enum Pending {
    Metadata {
        target: String,
    },
    Read {
        catalog: String,
        index: usize,
        length: u64,
    },
}
pub(super) struct PostHost {
    pub manager: PostManager,
    pub error: String,
    udp: Option<UdpPubSub>,
    pending: BTreeMap<WorkId, Pending>,
    lookups: BTreeMap<u64, WorkId>,
    start: Instant,
    disabled: bool,
    recovered: bool,
    scan_after: WorkId,
}
fn description(d: feedtorrent_libtorrent::TorrentDescription) -> Description {
    Description {
        id: d.id,
        name: d.name,
        total: d.total,
        error: d.error,
        files: d
            .files
            .into_iter()
            .map(|f| FileDescription {
                name: f.name,
                length: f.length,
            })
            .collect(),
    }
}
fn inspect_description(data: &[u8]) -> Option<Description> {
    match LibtorrentBackend::describe_torrent(data) {
        Ok(d) => Some(description(d)),
        Err(error)
            if matches!(
                feedtorrent_bep::bep49::inspect_item(data),
                feedtorrent_bep::bep49::ItemContent::Torrent(_)
            ) =>
        {
            Some(Description {
                error: error.to_string(),
                ..Default::default()
            })
        }
        Err(_) => None,
    }
}
impl PostHost {
    pub fn new(dir: &Path, isolated: bool) -> Self {
        let path = dir.join("feeds.json");
        let mut error = String::new();
        let mut disabled = false;
        let mut recovered = false;
        let mut manager = if path.exists() {
            match read_limited(&path).and_then(|b| PostManager::restore(&b).map_err(Into::into)) {
                Ok(m) => m,
                Err(e) => {
                    error = format!("Post state: {e:#}");
                    match read_limited(&dir.join("feeds.previous.json"))
                        .and_then(|b| PostManager::restore(&b).map_err(Into::into))
                    {
                        Ok(m) => {
                            let stamp = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_nanos();
                            match fs::copy(&path, dir.join(format!("posts.rejected-{stamp}.json")))
                            {
                                Ok(_) => {
                                    recovered = true;
                                    error.push_str(
                                        "; recovered previous checkpoint; original preserved",
                                    );
                                }
                                Err(copy_error) => {
                                    disabled = true;
                                    error.push_str(&format!(
                                        "; cannot preserve corrupt checkpoint: {copy_error}"
                                    ));
                                }
                            }
                            m
                        }
                        Err(_) => {
                            disabled = true;
                            PostManager::new()
                        }
                    }
                }
            }
        } else {
            PostManager::new()
        };
        manager.start(0);
        let mut bind = Bind {
            ipv4: Some(if isolated {
                std::net::Ipv4Addr::LOCALHOST
            } else {
                std::net::Ipv4Addr::UNSPECIFIED
            }),
            ipv6: Some(if isolated {
                std::net::Ipv6Addr::LOCALHOST
            } else {
                std::net::Ipv6Addr::UNSPECIFIED
            }),
            port: 0,
            advertised_port: None,
        };
        let udp = match UdpPubSub::bind(bind, Default::default()) {
            Ok(u) => Some(u),
            Err(e) => {
                bind = Bind {
                    ipv4: Some(if isolated {
                        std::net::Ipv4Addr::LOCALHOST
                    } else {
                        std::net::Ipv4Addr::UNSPECIFIED
                    }),
                    ipv6: None,
                    port: 0,
                    advertised_port: None,
                };
                match UdpPubSub::bind(bind, Default::default()) {
                    Ok(u) => Some(u),
                    Err(_) => {
                        error =
                            format!("Live post updates: {e}; periodic DHT checks remain active");
                        None
                    }
                }
            }
        };
        Self {
            manager,
            error,
            udp,
            pending: BTreeMap::new(),
            lookups: BTreeMap::new(),
            start: Instant::now(),
            disabled,
            recovered,
            scan_after: WorkId(0),
        }
    }
    pub fn available(&self) -> bool {
        !self.disabled
    }
    pub fn now(&self) -> u64 {
        self.start.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    pub fn persist(&mut self, dir: &Path) -> Result<()> {
        if self.disabled {
            return Ok(());
        }
        if !self.manager.dirty() && !self.recovered {
            return Ok(());
        }
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
            .min(u64::MAX as u128) as u64;
        self.manager.observe_news(wall_ms)?;
        let bytes = self.manager.checkpoint()?;
        let path = dir.join("feeds.json");
        // Both copies must contain the acknowledged decisions. An older backup
        // could otherwise undo Unfollow/Remove after primary-file corruption.
        atomic(&path, &bytes)?;
        atomic(&dir.join("feeds.previous.json"), &bytes)?;
        self.manager.acknowledge_checkpoint();
        self.recovered = false;
        Ok(())
    }
    pub fn tick(&mut self, e: &mut Engine) {
        if self.disabled {
            return;
        }
        // Apply backpressure before consuming more records or file data when
        // the previous checkpoint could not be stored.
        if let Err(error) = self.persist(&e.dir) {
            self.error = format!("Post persistence: {error:#}");
            return;
        }
        if self.error.starts_with("Post persistence:") {
            self.error.clear();
        }
        let now = self.now();
        if let Some(udp) = &mut self.udp {
            udp.poll(&mut e.native);
            for event in udp.protocol_mut().drain_events() {
                match event {
                    bep50::Event::Updated { topic, record } => {
                        let id = feedtorrent_posts::hex(&topic);
                        if self.manager.followed(&id) {
                            if let Err(error) = self.manager.receive_record(&id, record, now) {
                                self.manager.notice(&id, error.to_string())
                            }
                        }
                    }
                    bep50::Event::Failure {
                        error: bep50::Error::Malformed,
                        ..
                    } => {}
                    bep50::Event::Failure { topic, error, .. } => {
                        let id = feedtorrent_posts::hex(&topic);
                        if self.manager.followed(&id) {
                            self.manager.notice(&id, format!("Live updates: {error}"));
                        }
                    }
                    _ => {}
                }
            }
            for f in self.manager.views() {
                if let Ok(target) = feedtorrent_posts::hash(&f.id) {
                    self.manager
                        .update_peers(&f.id, udp.protocol().contacts(target).len());
                }
            }
        }
        for event in e.native.poll_dht() {
            if e.publication_native
                .as_mut()
                .is_some_and(|bridge| bridge.event(&event, self))
            {
                continue;
            }
            if let Some(work) = self.lookups.remove(&event.id.0) {
                let result = match event.result {
                    Ok(DhtOutcome::Mutable(value)) => Ok(value),
                    Ok(_) => Err(feedtorrent_posts::Error("Unexpected DHT response".into())),
                    Err(error) => Err(feedtorrent_posts::Error(error.to_string())),
                };
                self.manager.lookup_result(work, result, now);
            }
        }
        for t in &e.view.transfers {
            self.manager.transfer(
                &t.id,
                t.state.clone(),
                !t.files.is_empty() && t.files.iter().all(|f| f.ready),
            );
        }
        let batch: Vec<_> = self
            .pending
            .keys()
            .filter(|id| **id > self.scan_after)
            .chain(self.pending.keys().filter(|id| **id <= self.scan_after))
            .take(32)
            .copied()
            .collect();
        for work in batch {
            self.scan_after = work;
            if !self.manager.work_is_current(work) {
                self.pending.remove(&work);
                continue;
            }
            let outcome: Option<Result<()>> = match &self.pending[&work] {
                Pending::Metadata { target } => match e.native.info_bytes(target) {
                    Ok(Some(info)) => Some((|| {
                        let d = e.native.description(target)?;
                        if !d.error.is_empty() {
                            bail!("{}", d.error)
                        }
                        let authorized = !e.record(target)?.held;
                        // Durable original bytes let a restart reconstruct pending
                        // references without depending on an online metadata peer.
                        atomic(&e.dir.join(format!("{target}.info")), &info)?;
                        self.manager
                            .metadata(work, description(d), info, authorized)?;
                        Ok(())
                    })()),
                    Ok(None) => {
                        if let Some(t) = e.view.transfers.iter().find(|t| t.id == *target) {
                            if !t.error.is_empty() {
                                Some(Err(anyhow!(t.error.clone())))
                            } else if !t.active {
                                Some(Err(anyhow!("Transfer is paused")))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    Err(error) => Some(Err(anyhow!(error.to_string()))),
                },
                Pending::Read {
                    catalog,
                    index,
                    length,
                } => {
                    let ready = e
                        .view
                        .transfers
                        .iter()
                        .find(|t| t.id == *catalog)
                        .is_some_and(|t| !t.files.is_empty() && t.files.iter().all(|f| f.ready));
                    if !ready {
                        match e.view.transfers.iter().find(|t| t.id == *catalog) {
                            Some(t) if t.error.is_empty() && t.active => None,
                            Some(t) => Some(Err(anyhow!(if t.error.is_empty() {
                                "Catalog transfer is paused"
                            } else {
                                &t.error
                            }
                            .to_string()))),
                            None => Some(Err(anyhow!("Catalog transfer was removed"))),
                        }
                    } else {
                        Some((|| {
                            let file = e.native.file_at(catalog, *index)?;
                            if file.length != *length || file.verified != file.length {
                                bail!("Catalog item not verified")
                            }
                            let path = e.verified_path(catalog, &file.name)?;
                            self.manager.item_from_reader(
                                work,
                                File::open(path)?,
                                inspect_description,
                            )?;
                            Ok(())
                        })())
                    }
                }
            };
            if let Some(result) = outcome {
                self.pending.remove(&work);
                if let Err(error) = result {
                    self.manager.fail(work, format!("{error:#}"));
                }
            }
        }
        self.manager.tick(now);
        if let Err(error) = self.persist(&e.dir) {
            self.error = format!("Post persistence: {error:#}");
            return;
        }
        for action in self.manager.drain_actions() {
            let result: Result<()> = match action {
                Action::Relay { post, record } => {
                    if let Some(udp) = &mut self.udp {
                        let now = udp.now();
                        if let Err(error) = udp.protocol_mut().publish(record, now) {
                            self.manager.notice(&post, format!("Live updates: {error}"));
                        }
                    }
                    Ok(())
                }
                Action::Watch { post, key, known } => {
                    if let Some(udp) = &mut self.udp {
                        let now = udp.now();
                        udp.protocol_mut()
                            .subscribe(key, known, now)
                            .map_err(|error| anyhow!(error))
                            .map(|_| ())
                    } else {
                        self.manager
                            .notice(&post, "Live updates unavailable; using DHT checks".into());
                        Ok(())
                    }
                }
                Action::Unwatch { key, .. } => {
                    if let Some(udp) = &mut self.udp {
                        udp.protocol_mut().unsubscribe(key.target());
                    }
                    Ok(())
                }
                Action::Lookup { work, post: _, key } => {
                    match e
                        .native
                        .start_dht(DhtRequest::GetMutable(key), DhtOptions::default())
                    {
                        Ok(id) => {
                            self.lookups.insert(id.0, work);
                            Ok(())
                        }
                        Err(error) => {
                            self.manager.fail(work, error.to_string());
                            Ok(())
                        }
                    }
                }
                Action::Stage {
                    work,
                    post,
                    id,
                    source,
                    role,
                } => {
                    if !self.manager.should_stage(&post, &id, role) {
                        self.manager.cancel(work);
                        continue;
                    }
                    match e.stage_post(&post, &id, source, role) {
                        Ok(()) => {
                            self.pending.insert(work, Pending::Metadata { target: id });
                        }
                        Err(error) => self.manager.fail(work, format!("{error:#}")),
                    }
                    Ok(())
                }
                Action::Read {
                    work,
                    post: _,
                    catalog,
                    index,
                    length,
                } => {
                    self.pending.insert(
                        work,
                        Pending::Read {
                            catalog,
                            index,
                            length,
                        },
                    );
                    Ok(())
                }
                Action::Approve { work, post, id } => {
                    if !self.manager.can_approve(&post, &id) {
                        self.manager.cancel(work);
                        Ok(())
                    } else {
                        let r = (|| {
                            let record = e
                                .store
                                .records
                                .iter_mut()
                                .find(|r| r.id == id)
                                .context("Transfer no longer exists")?;
                            if !record.active {
                                bail!("Transfer is paused")
                            };
                            let held = record.held;
                            record.held = false;
                            if let Err(error) = e.persist() {
                                e.store
                                    .records
                                    .iter_mut()
                                    .find(|r| r.id == id)
                                    .unwrap()
                                    .held = held;
                                return Err(error);
                            }

                            if held {
                                if let Err(error) = e.native.allow_download(&id) {
                                    if let Some(r) = e.store.records.iter_mut().find(|r| r.id == id)
                                    {
                                        r.held = true;
                                    }
                                    e.persist()?;
                                    return Err(anyhow!(error.to_string()));
                                }
                            }
                            Ok(())
                        })();
                        match r {
                            Ok(()) => self.manager.approved(work),
                            Err(error) => self.manager.fail(work, format!("{error:#}")),
                        }
                        Ok(())
                    }
                }
            };
            if let Err(error) = result {
                self.error = error.to_string();
            }
        }
    }
    pub fn publish_record(&mut self, record: feedtorrent_bep::bep44::MutableRecord) {
        if let Some(udp) = &mut self.udp {
            let now = udp.now();
            if udp
                .protocol_mut()
                .subscribe(record.key().clone(), Some(record.clone()), now)
                .is_ok()
            {
                let _ = udp.protocol_mut().publish(record, now);
            }
        }
    }
    pub fn close(&mut self) {
        if let Some(udp) = &mut self.udp {
            udp.close();
        }
    }
}
impl Engine {
    pub(super) fn verified_path(&self, id: &str, name: &str) -> Result<PathBuf> {
        let root = &self.record(id)?.path;
        let path = root.join(name);
        if path.strip_prefix(root).is_err() {
            bail!("Unsafe catalog file path")
        };
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(fs::canonicalize(root)?) {
            bail!("Unsafe catalog file path")
        };
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("Catalog file is a symlink")
        };
        Ok(canonical)
    }
    fn stage_post(&mut self, post: &str, id: &str, source: Source, role: Role) -> Result<()> {
        let (bytes, magnet) = match source {
            Source::Magnet(uri) => (uri.into_bytes(), true),
            Source::Torrent(data) => (data, false),
        };
        let actual = self
            .native
            .inspect(TorrentSource::from_bytes(&bytes, magnet)?)?;
        if actual != id {
            bail!("Post item infohash mismatch")
        }
        self.reserve_source(
            bytes,
            magnet,
            Some(lifecycle::SourceOrigin::Followed { id: post.into() }),
            if role == Role::Catalog {
                "catalog"
            } else {
                "content"
            },
            true,
            false,
        )?;
        Ok(())
    }
    pub(super) fn post_tick(&mut self) {
        if let Some(mut host) = self.posts.take() {
            host.tick(self);
            self.posts = Some(host);
        }
    }
    pub(super) fn persist_posts(&mut self) -> Result<()> {
        if let Some(host) = &mut self.posts {
            host.persist(&self.dir)?
        }
        Ok(())
    }
    fn approve_transfer(&mut self, id: &str) -> Result<()> {
        let d = self.native.description(id)?;
        if !d.error.is_empty() {
            bail!("{}", d.error)
        }
        if self.record(id)?.kind == "catalog" {
            let f = feedtorrent_bep::bep49::Feed::from_info(&d.info)?;
            f.verify_infohash(feedtorrent_posts::hash(id)?)?;
        }
        self.posts
            .as_mut()
            .context("Post service unavailable")?
            .manager
            .approve_once(id)?;
        self.persist_posts()?;
        let r = self
            .store
            .records
            .iter_mut()
            .find(|r| r.id == id)
            .context("Transfer not found")?;
        let previous = (r.held, r.active);
        r.held = false;
        r.active = true;
        if let Err(error) = self.persist() {
            let r = self.store.records.iter_mut().find(|r| r.id == id).unwrap();
            r.held = previous.0;
            r.active = previous.1;
            return Err(error);
        }
        if let Err(error) = self.native.allow_download(id) {
            let r = self.store.records.iter_mut().find(|r| r.id == id).unwrap();
            r.held = previous.0;
            r.active = previous.1;
            self.persist()?;
            return Err(anyhow!(error.to_string()));
        }
        Ok(())
    }
    pub(super) fn post_command(&mut self, command: Command) -> Result<()> {
        let host = self.posts.as_mut().context("Post service unavailable")?;
        if host.disabled {
            bail!("Post checkpoint is invalid; original files preserved")
        }
        let now = host.now();
        match command {
            Command::FollowPost { uri, config } => {
                host.manager.follow(&uri, config, now)?;
            }
            Command::ConfigurePost { id, config } => host.manager.configure(&id, config)?,
            Command::RefreshPost { id } => host.manager.refresh(&id, now)?,
            Command::OpenCatalog { post, id } => host.manager.open_catalog(&post, &id)?,
            Command::DownloadEntry {
                post,
                catalog,
                index,
            } => {
                let id = host.manager.download_item(&post, &catalog, index)?;
                self.persist_posts()?;
                if self.store.records.iter().any(|r| r.id == id) {
                    self.approve_transfer(&id)?;
                }
            }
            Command::ApproveTransfer { id } => {
                self.approve_transfer(&id)?;
            }
            Command::RevealEntry { catalog, index } => {
                let f = self.native.file_at(&catalog, index)?;
                if f.verified != f.length {
                    bail!("File not verified")
                };
                let path = self.verified_path(&catalog, &f.name)?;
                crate::desktop::reveal(&path)?;
            }
            _ => bail!("Invalid post command"),
        }
        self.persist_posts()?;
        self.post_tick();
        Ok(())
    }
}

impl Engine {
    pub(super) fn news_read(&mut self, post: &str, sequence: &str, read: bool) -> Result<()> {
        let host = self.posts.as_mut().context("Post service unavailable")?;
        if host.disabled {
            bail!("Post checkpoint is invalid; original files preserved")
        }
        let old = host.manager.set_news_read(post, sequence, read)?;
        if let Err(error) = host.persist(&self.dir) {
            host.manager.set_news_read(post, sequence, old)?;
            // Never acknowledge an unpersisted reading decision. Retry its rollback
            // through the ordinary checkpoint barrier if the disk remains unavailable.
            let _ = host.persist(&self.dir);
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn catalog_body(&self, post: &str, catalog: &str) -> Result<Option<PathBuf>> {
        let host = self.posts.as_ref().context("Post service unavailable")?;
        host.manager.page(post, catalog, 0)?;
        let info = self
            .native
            .info_bytes(catalog)?
            .context("Waiting for catalog metadata")?;
        let parsed = feedtorrent_bep::bep49::Feed::from_info(&info)?;
        let entries: Vec<_> = parsed
            .entries()
            .iter()
            .filter(|f| f.path() == ["metadata", "body.md"])
            .collect();
        if entries.len() > 1 {
            bail!("Catalog contains multiple Markdown bodies")
        }
        let Some(entry) = entries.first() else {
            return Ok(None);
        };
        if entry.length() > feedtorrent_posts::publishing::MAX_BODY as u64 {
            bail!("Markdown exceeds 1 MiB")
        }
        let t = self
            .view
            .transfers
            .iter()
            .find(|t| t.id == catalog)
            .context("Catalog unavailable")?;
        if t.state == "Checking" || !t.error.is_empty() {
            bail!("Catalog has not been verified")
        }
        let file = self.native.file_at(catalog, entry.index())?;
        if file.verified != file.length || file.length != entry.length() {
            bail!("Markdown is not downloaded and verified")
        }
        Ok(Some(self.verified_path(catalog, &file.name)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_write_failure_does_not_remove_the_payload_hold() {
        let dir =
            std::env::temp_dir().join(format!("feedtorrent-approval-fault-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let args = Args {
            data_dir: Some(dir.clone()),
            download_dir: None,
            http_port: 0,
            peer_port: Some(0),
            no_open: true,
            isolated: true,
            dht_bootstrap: None,
        };
        let mut store = default_store();
        store.settings.peer_port = 0;
        store.settings.download_dir = dir.join("downloads").display().to_string();
        let mut engine = Engine::new(&args, dir.clone(), store).unwrap();
        use feedtorrent_bep::bep49::{BuildEntry, FeedBuilder};
        let mut b = FeedBuilder::new("catalog");
        b.entries.push(BuildEntry::file(vec!["note".into()], 3));
        let built = b.build(|_| Ok(std::io::Cursor::new(b"abc"))).unwrap();
        let id = feedtorrent_posts::hex(&built.feed.infohash());
        engine
            .stage_post(
                "1111111111111111111111111111111111111111",
                &id,
                Source::Torrent(built.metainfo),
                Role::Catalog,
            )
            .unwrap();
        let registry = dir.join("transfers.json");
        fs::remove_file(&registry).unwrap();
        fs::create_dir(&registry).unwrap();
        let rejected = engine.approve_transfer(&id).is_err();
        let held = engine.record(&id).unwrap().held;
        fs::remove_dir(&registry).unwrap();
        engine.persist().unwrap();
        engine.native.shutdown().unwrap();
        if let Some(h) = &mut engine.posts {
            h.close();
        }
        fs::remove_dir_all(dir).unwrap();
        assert!(rejected);
        assert!(
            held,
            "a failed durable authorization must remain held in memory"
        );
    }

    #[test]
    fn backup_does_not_revert_a_completed_unfollow() {
        let dir =
            std::env::temp_dir().join(format!("feedtorrent-checkpoint-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut host = PostHost::new(&dir, true);
        let id=host.manager.follow("magnet:?xs=urn:btpk:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",Default::default(),0).unwrap();
        host.persist(&dir).unwrap();
        host.manager.unfollow(&id).unwrap();
        host.persist(&dir).unwrap();
        let backup =
            PostManager::restore(&fs::read(dir.join("feeds.previous.json")).unwrap()).unwrap();
        let followed = backup.followed(&id);
        host.close();
        fs::remove_dir_all(dir).unwrap();
        assert!(
            !followed,
            "a successfully saved Unfollow must survive primary-checkpoint corruption"
        );
    }

    #[test]
    fn news_write_failure_keeps_memory_and_recovery_unread() {
        let dir =
            std::env::temp_dir().join(format!("feedtorrent-news-fault-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let args = Args {
            data_dir: Some(dir.clone()),
            download_dir: Some(dir.join("downloads")),
            http_port: 0,
            peer_port: Some(0),
            no_open: true,
            isolated: true,
            dht_bootstrap: None,
        };
        let mut store = default_store();
        store.settings.peer_port = 0;
        store.settings.download_dir = dir.join("downloads").display().to_string();
        let mut engine = Engine::new(&args, dir.clone(), store).unwrap();
        let signer = feedtorrent_bep::bep44::Bep44Signer::from_seed(&[29; 32]);
        let pointer =
            feedtorrent_bep::bep46::TorrentPointer::sign(&signer, [8; 20], 1, vec![]).unwrap();
        let uri = feedtorrent_bep::bep46::format_magnet(pointer.record().key());
        let host = engine.posts.as_mut().unwrap();
        let id = host.manager.follow(&uri, Default::default(), 0).unwrap();
        host.manager
            .receive_record(&id, pointer.record().clone(), 0)
            .unwrap();
        host.persist(&dir).unwrap();
        // Block the backup's atomic temporary after the primary can be written.
        fs::create_dir(dir.join("feeds.previous.tmp")).unwrap();
        assert!(engine.news_read(&id, "1", true).is_err());
        assert_eq!(engine.posts.as_ref().unwrap().manager.news_unread(), 1);
        let primary = PostManager::restore(&fs::read(dir.join("feeds.json")).unwrap()).unwrap();
        let backup =
            PostManager::restore(&fs::read(dir.join("feeds.previous.json")).unwrap()).unwrap();
        assert_eq!(primary.news_unread(), 1);
        assert_eq!(backup.news_unread(), 1);
        fs::remove_dir(dir.join("feeds.previous.tmp")).unwrap();
        engine.news_read(&id, "1", true).unwrap();
        assert_eq!(engine.posts.as_ref().unwrap().manager.news_unread(), 0);
        engine.native.shutdown().unwrap();
        engine.posts.as_mut().unwrap().close();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opaque_files_and_unsupported_empty_catalogs_remain_distinct() {
        assert!(inspect_description(b"an opaque note").is_none());
        use feedtorrent_bep::bep49::{BuildEntry, FeedBuilder};
        let mut b = FeedBuilder::new("empty");
        b.entries.push(BuildEntry::file(vec!["empty".into()], 0));
        let built = b
            .build(|_| Ok(std::io::Cursor::new(Vec::<u8>::new())))
            .unwrap();
        assert!(!inspect_description(&built.metainfo)
            .unwrap()
            .error
            .is_empty());
    }

    #[test]
    fn udp_unavailable_keeps_native_dht_and_transfers_usable() {
        // Exercise a real bind failure, then the same optional-transport path
        // used by PostHost when both native socket attempts are unavailable.
        assert!(UdpPubSub::bind(
            Bind {
                ipv4: Some("192.0.2.1".parse().unwrap()),
                ipv6: None,
                port: 0,
                advertised_port: None
            },
            Default::default()
        )
        .is_err());
        let path = std::env::temp_dir().join(format!("feedtorrent-no-udp-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        let args = Args {
            data_dir: Some(path.clone()),
            download_dir: Some(path.join("downloads")),
            http_port: 0,
            peer_port: Some(0),
            no_open: true,
            isolated: true,
            dht_bootstrap: None,
        };
        let mut store = default_store();
        store.settings.peer_port = 0;
        store.settings.download_dir = path.join("downloads").display().to_string();
        let mut engine = Engine::new(&args, path.clone(), store).unwrap();
        let host = engine.posts.as_mut().unwrap();
        if let Some(mut udp) = host.udp.take() {
            udp.close();
        }
        host.manager.follow("magnet:?xs=urn:btpk:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",Default::default(),0).unwrap();
        // Give the native listener time to initialize; no network answers needed.
        for _ in 0..100 {
            engine.posts.as_mut().unwrap().start = Instant::now() - Duration::from_secs(40);
            engine.post_tick();
            if !engine.posts.as_ref().unwrap().lookups.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let host = engine.posts.as_ref().unwrap();
        assert!(host.udp.is_none());
        assert!(
            !host.lookups.is_empty(),
            "DHT query must still be accepted without UDP PubSub"
        );
        assert_eq!(host.manager.views().len(), 1);
        engine.refresh().unwrap();
        assert!(engine.view.ready);
        engine.native.shutdown().unwrap();
        fs::remove_dir_all(path).unwrap();
    }
}
