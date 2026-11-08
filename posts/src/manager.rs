use crate::model::*;
use feedtorrent_bep::{
    bep44::{select_mutable, MutableKey, MutableRecord},
    bep46::{self, TorrentPointer},
    bep49::{self, EntryKind, Feed, ItemContent},
};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, VecDeque};
#[path = "news.rs"]
mod news;
#[path = "renewal.rs"]
mod renewal;
use renewal::Renewal;
const MAX_WORK: usize = 32;
#[derive(Clone)]
struct Visit {
    origin: Origin,
    head: bool,
    trusted: bool,
    meta: Option<Feed>,
    ready: bool,
    state: String,
    error: String,
    foreign: Option<String>,
    entries: BTreeMap<usize, EntryView>,
    reads: BTreeMap<usize, bool>,
    stage: bool,
    approve: bool,
    approved: bool,
}
impl Visit {
    fn new(origin: Origin, head: bool) -> Self {
        Self {
            origin,
            head,
            trusted: true,
            meta: None,
            ready: false,
            state: "Waiting for metadata".into(),
            error: String::new(),
            foreign: None,
            entries: BTreeMap::new(),
            reads: BTreeMap::new(),
            stage: false,
            approve: false,
            approved: false,
        }
    }
}
#[derive(Clone)]
enum Work {
    Lookup(String),
    RenewalLookup(String),
    RenewalPut(String, MutableRecord),
    Stage(String, String, Role),
    Read(String, String, usize),
    Approve(String, String),
}
#[derive(Clone, Default)]
struct Runtime {
    head: Option<String>,
    error: String,
    next_check: u64,
    checking: bool,
    failures: u32,
    peers: usize,
    last_checked: Option<u64>,
}
#[derive(Clone)]
pub struct PostManager {
    state: Checkpoint,
    renewals: BTreeMap<String, Renewal>,
    visits: BTreeMap<(String, String), Visit>,
    runtime: BTreeMap<String, Runtime>,
    pending: BTreeMap<WorkId, Work>,
    out: VecDeque<Action>,
    events: VecDeque<Event>,
    next: u64,
    dirty: bool,
    now: u64,
    transfer_states: BTreeMap<String, (String, bool)>,
    content_totals: BTreeMap<(String, String), u64>,
    content_failures: BTreeMap<(String, String), String>,
    authorized: std::collections::BTreeSet<String>,
}
impl Default for PostManager {
    fn default() -> Self {
        Self::new()
    }
}
impl PostManager {
    pub fn new() -> Self {
        Self {
            state: Checkpoint::default(),
            renewals: BTreeMap::new(),
            visits: BTreeMap::new(),
            runtime: BTreeMap::new(),
            pending: BTreeMap::new(),
            out: VecDeque::new(),
            events: VecDeque::new(),
            next: 0,
            dirty: false,
            now: 0,
            transfer_states: BTreeMap::new(),
            content_totals: BTreeMap::new(),
            content_failures: BTreeMap::new(),
            authorized: Default::default(),
        }
    }
    pub fn restore(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(err("Post checkpoint exceeds 32 MiB"));
        }
        let state: Checkpoint = serde_json::from_slice(bytes).map_err(err)?;
        let legacy = state.version == 1;
        if !matches!(state.version, 1 | 2) {
            return Err(err("Unsupported post checkpoint version"));
        }
        for (id, s) in &state.posts {
            s.config.validate()?;
            let key = identity(&s.magnet)?;
            if hex(&key.target()) != *id {
                return Err(err("Post identity mismatch"));
            }
            let mut known = None;
            for record in &s.records {
                known = Some(select_mutable(known.as_ref(), record.verify(&key)?).map_err(err)?);
            }
            for h in &s.manual_catalogs {
                hash(h)?;
            }
            for (h, _) in &s.manual_items {
                hash(h)?;
            }
        }
        for h in state.suppressed.iter().chain(&state.approvals) {
            hash(h)?;
        }
        let mut m = Self::new();
        for (post, refs) in &state.references {
            if !state.posts.contains_key(post) {
                return Err(err("Reference has unknown post"));
            }
            for (id, r) in refs {
                hash(id)?;
                match &r.origin {
                    Origin::Link(uri) => {
                        let link = bep49::TorrentLink::parse(uri).map_err(err)?;
                        if hex(&link.infohash()) != *id {
                            return Err(err("Reference infohash mismatch"));
                        }
                    }
                    Origin::Item(parent, index) => {
                        hash(parent)?;
                        if *index > MAX_METAINFO {
                            return Err(err("Invalid catalog index"));
                        }
                    }
                }
                let mut v = Visit::new(r.origin.clone(), false);
                v.trusted = false;
                v.state = if r.pending {
                    "Pending reference validation"
                } else {
                    "Checking reference"
                }
                .into();
                m.visits.insert((post.clone(), id.clone()), v);
            }
        }
        m.state = state;
        m.initialize_news(legacy)?;
        Ok(m)
    }
    pub fn checkpoint(&self) -> Result<Vec<u8>> {
        let mut state = self.state.clone();
        for ((post, id), v) in &self.visits {
            if let Some(r) = state.references.get_mut(post).and_then(|r| r.get_mut(id)) {
                r.pending = !v.ready;
            }
        }
        let bytes = serde_json::to_vec(&state).map_err(err)?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(err("Post checkpoint exceeds 32 MiB"));
        }
        Ok(bytes)
    }
    pub fn dirty(&self) -> bool {
        self.dirty
    }
    pub fn acknowledge_checkpoint(&mut self) {
        self.dirty = false;
    }
    pub fn drain_actions(&mut self) -> Vec<Action> {
        if self.dirty {
            return vec![];
        }
        let count = self.out.len().min(MAX_WORK);
        self.out.drain(..count).collect()
    }
    pub fn drain_events(&mut self) -> Vec<Event> {
        if self.dirty {
            vec![]
        } else {
            self.events.drain(..).collect()
        }
    }
    fn event(&mut self, event: Event) {
        if self.events.len() == 128 {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
    fn key(&self, id: &str) -> Result<MutableKey> {
        identity(
            &self
                .state
                .posts
                .get(id)
                .ok_or_else(|| err("Post not found"))?
                .magnet,
        )
    }
    fn known(&self, id: &str) -> Result<Option<MutableRecord>> {
        let s = self
            .state
            .posts
            .get(id)
            .ok_or_else(|| err("Post not found"))?;
        let key = identity(&s.magnet)?;
        s.records.last().map(|r| r.verify(&key)).transpose()
    }
    // Metadata staging starts an ordinary long-lived transfer. Waiting for a
    // missing swarm must not occupy the short-operation budget indefinitely.
    fn work_load(&self) -> usize {
        self.pending
            .values()
            .filter(|w| !matches!(w, Work::Stage(..)))
            .count()
    }
    fn new_work(&mut self, work: Work) -> Option<WorkId> {
        if self.work_load() >= MAX_WORK || self.out.len() >= MAX_WORK {
            return None;
        }
        self.next = self.next.checked_add(1)?;
        let id = WorkId(self.next);
        self.pending.insert(id, work);
        Some(id)
    }
    pub fn retention_edges(&self) -> Vec<(String, String)> {
        let mut out = vec![];
        for ((_, parent), v) in &self.visits {
            for entry in v.entries.values() {
                if let Some(child) = &entry.infohash {
                    out.push((parent.clone(), child.clone()));
                }
            }
            if let Some(meta) = &v.meta {
                for link in [
                    meta.fields().previous.as_ref(),
                    meta.fields().archive_next.as_ref(),
                ]
                .into_iter()
                .flatten()
                {
                    out.push((parent.clone(), hex(&link.infohash())));
                }
            }
        }
        out
    }
    /// Retention metadata, never authority to start a download.
    pub fn retention_references(&self) -> Vec<(String, String, Option<String>)> {
        self.state
            .references
            .iter()
            .filter(|(post, _)| self.followed(post))
            .flat_map(|(post, refs)| {
                refs.iter().map(move |(id, r)| {
                    let parent = match &r.origin {
                        Origin::Item(parent, _) => Some(parent.clone()),
                        Origin::Link(_) => None,
                    };
                    (post.clone(), id.clone(), parent)
                })
            })
            .collect()
    }
    fn visit(&mut self, post: &str, id: &str, origin: Origin, head: bool) {
        let refs = self.state.references.entry(post.into()).or_default();
        if refs.get(id).is_none_or(|r| r.origin != origin) {
            refs.insert(
                id.into(),
                Reference {
                    origin: origin.clone(),
                    pending: true,
                },
            );
            self.dirty = true;
        }
        let v = self
            .visits
            .entry((post.into(), id.into()))
            .or_insert_with(|| Visit::new(origin.clone(), head));
        v.origin = origin;
        if head && !v.head {
            v.meta = None;
            v.foreign = None;
            v.stage = false;
            v.error.clear();
        }
        v.head |= head;
        v.trusted = true;
    }
    pub fn start(&mut self, now: u64) {
        self.now = now;
        for id in self.state.posts.keys().cloned().collect::<Vec<_>>() {
            self.runtime.insert(id.clone(), Runtime::default());
            if self.state.posts[&id].followed {
                if let Ok(key) = self.key(&id) {
                    self.out.push_back(Action::Watch {
                        post: id.clone(),
                        key,
                        known: self.known(&id).ok().flatten(),
                    });
                }
                if self.known(&id).ok().flatten().is_some() {
                    self.renewals.insert(id.clone(), Renewal::due(now));
                }
                let records = self.state.posts[&id].records.clone();
                for r in records {
                    if let Ok(record) = r.verify(&self.key(&id).unwrap()) {
                        self.remember_pointer(&id, record);
                    }
                }
            }
        }
        self.tick(now);
    }
    pub fn follow(&mut self, uri: &str, config: Config, now: u64) -> Result<String> {
        config.validate()?;
        let key = identity(uri)?;
        let id = hex(&key.target());
        let refollow = self.state.posts.get(&id).is_some_and(|s| !s.followed);
        self.now = now;
        let s = self
            .state
            .posts
            .entry(id.clone())
            .or_insert_with(|| Subscription {
                magnet: bep46::format_magnet(&key),
                config: config.clone(),
                followed: true,
                records: vec![],
                manual_catalogs: Default::default(),
                manual_items: Default::default(),
            });
        s.followed = true;
        s.config = config;
        if refollow {
            // A new subscription retries its current catalog, while unrelated
            // manually stopped torrents keep their durable suppression.
            if let Some(record) = self.known(&id)? {
                self.remember_pointer(&id, record);
                if let Some(head) = self.runtime.get(&id).and_then(|r| r.head.clone()) {
                    self.retry_catalog(&id, &head);
                }
            }
        }
        self.runtime.entry(id.clone()).or_default().next_check = now;
        if self.known(&id)?.is_some() {
            self.renewals
                .entry(id.clone())
                .or_insert_with(|| Renewal::due(now));
        }
        self.dirty = true;
        self.out.push_back(Action::Watch {
            post: id.clone(),
            key,
            known: self.known(&id)?,
        });
        self.tick(now);
        Ok(id)
    }
    pub fn configure(&mut self, id: &str, config: Config) -> Result<()> {
        config.validate()?;
        self.state
            .posts
            .get_mut(id)
            .ok_or_else(|| err("Post not found"))?
            .config = config;
        self.dirty = true;
        self.tick(self.now);
        Ok(())
    }
    pub fn unfollow(&mut self, id: &str) -> Result<()> {
        let key = self.key(id)?;
        self.state.posts.get_mut(id).unwrap().followed = false;
        self.renewals.remove(id);
        if let Some(r) = self.runtime.get_mut(id) {
            r.checking = false;
        }
        self.dirty = true;
        self.out.retain(|a| action_post(a) != id);
        self.pending.retain(|_, w| work_post(w) != id);
        self.out.push_back(Action::Unwatch {
            post: id.into(),
            key,
        });
        Ok(())
    }
    pub fn refresh(&mut self, id: &str, now: u64) -> Result<()> {
        if !self.state.posts.get(id).is_some_and(|s| s.followed) {
            return Err(err("Post not followed"));
        }
        self.runtime.entry(id.into()).or_default().next_check = now;
        self.content_failures.retain(|(f, _), _| f != id);
        for ((owner, _), v) in &mut self.visits {
            if owner == id {
                v.error.clear();
                for (index, entry) in &mut v.entries {
                    if !entry.error.is_empty() {
                        entry.error.clear();
                        v.reads.remove(index);
                    }
                }
            }
        }
        self.tick(now);
        Ok(())
    }
    pub fn notice(&mut self, id: &str, message: String) {
        self.event(Event::Attention {
            post: id.into(),
            message: message.clone(),
        });
        if let Some(r) = self.runtime.get_mut(id) {
            r.error = message;
        }
    }
    pub fn update_peers(&mut self, id: &str, count: usize) {
        if let Some(r) = self.runtime.get_mut(id) {
            r.peers = count;
        }
    }
    pub fn receive_record(&mut self, id: &str, record: MutableRecord, now: u64) -> Result<()> {
        self.now = now;
        if !self.followed(id) {
            return Err(err("Post not followed"));
        }
        let key = self.key(id)?;
        record.verify_for(&key).map_err(err)?;
        let old = self.known(id)?;
        let r = select_mutable(old.as_ref(), record).map_err(err)?;
        if old.as_ref().is_none_or(|o| r.sequence() > o.sequence()) {
            self.state
                .posts
                .get_mut(id)
                .unwrap()
                .records
                .push(SignedRecord::from_record(&r));
            self.dirty = true;
            self.event(Event::RecordAccepted {
                post: id.into(),
                sequence: r.sequence(),
                infohash: bep46::decode_payload(r.value()).ok(),
            });
            self.out
                .retain(|a| !matches!(a,Action::Relay{post,..}if post==id));
            self.out.push_back(Action::Relay {
                post: id.into(),
                record: r.clone(),
            });
        }
        self.renewals
            .entry(id.into())
            .or_insert_with(|| Renewal::due(now));
        self.remember_pointer(id, r);
        self.tick(now);
        Ok(())
    }
    fn remember_pointer(&mut self, id: &str, record: MutableRecord) {
        let key = self.key(id).unwrap();
        match TorrentPointer::from_record(&key, record) {
            Ok(p) => {
                let hash = hex(&p.infohash());
                let r = self.runtime.entry(id.into()).or_default();
                r.head = Some(hash.clone());
                r.error.clear();
                self.visit(id, &hash, Origin::Link(target_uri(&hash)), true);
            }
            Err(e) => self.notice(id, format!("Unsupported post update: {e}")),
        }
    }
    pub fn lookup_result(&mut self, work: WorkId, result: Result<Option<MutableRecord>>, now: u64) {
        let Some(Work::Lookup(id)) = self.pending.remove(&work) else {
            return;
        };
        let r = self.runtime.entry(id.clone()).or_default();
        r.checking = false;
        r.last_checked = Some(now);
        match result {
            Ok(Some(record)) => {
                self.runtime.get_mut(&id).unwrap().failures = 0;
                if let Err(e) = self.receive_record(&id, record, now) {
                    self.notice(&id, e.to_string())
                }
            }
            Ok(None) => {
                if self.runtime[&id].head.is_none() {
                    self.notice(&id, "Waiting for a published catalog".into());
                }
            }
            Err(e) => {
                self.notice(&id, e.to_string());
                let r = self.runtime.get_mut(&id).unwrap();
                r.failures = r.failures.saturating_add(1);
                r.next_check = now.saturating_add(
                    (30_000u64 << r.failures.min(5).saturating_sub(1)).min(POLL_MS),
                );
            }
        }
    }
    fn desired(&self, post: &str, id: &str) -> bool {
        let Some(s) = self.state.posts.get(post) else {
            return false;
        };
        s.followed
            && (s.config.mode != Mode::CurrentCatalog
                || self.state.approvals.contains(id)
                || self
                    .runtime
                    .get(post)
                    .is_some_and(|r| r.head.as_deref() == Some(id))
                || s.manual_catalogs.contains(id))
    }
    fn allowed(&self, post: &str, id: &str, size: u64) -> bool {
        !self.state.suppressed.contains(id)
            && (self.state.approvals.contains(id)
                || self.state.posts[post]
                    .config
                    .automatic_limit
                    .is_none_or(|max| size <= max))
    }
    pub fn suppressed(&self, id: &str) -> bool {
        self.state.suppressed.contains(id)
    }
    pub fn suppress(&mut self, id: &str) -> Result<()> {
        hash(id)?;
        self.state.suppressed.insert(id.into());
        self.state.approvals.remove(id);
        self.dirty = true;
        self.pending
            .retain(|_, w| !matches!(w,Work::Stage(_,t,_)|Work::Approve(_,t)if t==id));
        self.out
            .retain(|a| !matches!(a,Action::Stage{id:t,..}|Action::Approve{id:t,..}if t==id));
        for ((_, target), v) in &mut self.visits {
            if target == id {
                v.stage = false;
                v.approve = false;
                v.state = "Paused or removed".into();
            }
        }
        Ok(())
    }
    pub fn approve_once(&mut self, id: &str) -> Result<()> {
        hash(id)?;
        self.state.suppressed.remove(id);
        self.state.approvals.insert(id.into());
        self.content_failures.retain(|(_, h), _| h != id);
        self.dirty = true;
        for ((_, target), v) in &mut self.visits {
            if target == id {
                v.stage = false;
                v.approve = false;
                v.error.clear();
            }
            for (index, row) in &mut v.entries {
                if row.infohash.as_deref() == Some(id) && !row.error.is_empty() {
                    row.error.clear();
                    v.reads.remove(index);
                }
            }
        }
        self.tick(self.now);
        Ok(())
    }
    pub fn open_catalog(&mut self, post: &str, id: &str) -> Result<()> {
        if !self
            .visits
            .get(&(post.into(), id.into()))
            .is_some_and(|v| v.trusted)
        {
            return Err(err("Catalog is not referenced by this post"));
        }
        self.state
            .posts
            .get_mut(post)
            .ok_or_else(|| err("Post not found"))?
            .manual_catalogs
            .insert(id.into());
        self.retry_catalog(post, id);
        self.dirty = true;
        self.tick(self.now);
        Ok(())
    }
    fn retry_catalog(&mut self, post: &str, id: &str) {
        // Retry metadata under the configured size limit, without granting
        // Download once permission to the payload.
        self.state.suppressed.remove(id);
        if let Some(v) = self.visits.get_mut(&(post.into(), id.into())) {
            v.error.clear();
            if v.meta.is_none() && !self.transfer_states.contains_key(id) {
                v.state = "Waiting for metadata".into();
            }
        }
    }
    pub fn download_item(&mut self, post: &str, catalog: &str, index: usize) -> Result<String> {
        let v = self
            .visits
            .get(&(post.into(), catalog.into()))
            .ok_or_else(|| err("Catalog not found"))?;
        if !v.ready || !v.trusted {
            return Err(err("Catalog files are not available"));
        }
        let item = v.entries.get(&index).ok_or_else(|| err("Item not found"))?;
        if !matches!(item.kind.as_str(), "torrent" | "catalog") {
            return Err(err("Item is not a downloadable torrent"));
        }
        let id = item
            .infohash
            .clone()
            .ok_or_else(|| err("Item metadata pending"))?;
        if item.kind == "catalog" {
            self.visit(post, &id, Origin::Item(catalog.into(), index), false);
            self.state
                .posts
                .get_mut(post)
                .unwrap()
                .manual_catalogs
                .insert(id.clone());
        }
        self.state
            .posts
            .get_mut(post)
            .unwrap()
            .manual_items
            .insert((catalog.into(), index));
        self.dirty = true;
        self.approve_once(&id)?;
        Ok(id)
    }
    pub fn transfer(&mut self, id: &str, state: String, ready: bool) {
        self.transfer_states
            .insert(id.into(), (state.clone(), ready));
        for ((_, h), v) in &mut self.visits {
            if h == id {
                if v.ready != ready {
                    self.dirty = true;
                }
                v.ready = ready;
                if v.meta.is_some() && !v.approved && state != "Paused" && state != "Error" {
                    if state != "Waiting for metadata" {
                        v.state = if ready {
                            state.clone()
                        } else {
                            v.state.clone()
                        };
                    }
                } else {
                    v.state = state.clone();
                }
            }
        }
    }
    pub fn metadata(
        &mut self,
        work: WorkId,
        description: Description,
        info: Vec<u8>,
        already_authorized: bool,
    ) -> Result<()> {
        if !description.error.is_empty() && self.pending.contains_key(&work) {
            self.fail(work, description.error.clone());
            return Err(err(description.error));
        }
        let Some(Work::Stage(post, id, role)) = self.pending.remove(&work) else {
            return Ok(());
        };
        if description.id != id {
            return self.metadata_failure(&post, &id, "Metadata infohash mismatch");
        }
        if role == Role::Content {
            return self.content_metadata(&post, &id, description.total, already_authorized);
        }
        let result: Result<Feed> = (|| {
            let catalog = Feed::from_info(&info).map_err(err)?;
            catalog.verify_infohash(hash(&id)?).map_err(err)?;
            Ok(catalog)
        })();
        let catalog = match result {
            Ok(c) => c,
            Err(e) => return self.metadata_failure(&post, &id, &e.to_string()),
        };
        let key = self.key(&post)?;
        let own = self.visits[&(post.clone(), id.clone())].head;
        let foreign = if !own {
            catalog
                .fields()
                .source
                .as_ref()
                .filter(|k| *k != &key)
                .map(bep46::format_magnet)
        } else {
            None
        };
        let links = [
            catalog.fields().previous.clone(),
            catalog.fields().archive_next.clone(),
        ];
        let total = catalog.total_length();
        let v = self.visits.get_mut(&(post.clone(), id.clone())).unwrap();
        v.meta = Some(catalog);
        v.foreign = foreign.clone();
        v.approved = already_authorized;
        v.stage = true;
        v.error.clear();
        v.state = if foreign.is_some() {
            "External post"
        } else if self.state.suppressed.contains(&id) {
            "Paused or removed"
        } else if already_authorized {
            "Downloading"
        } else {
            "Awaiting approval"
        }
        .into();
        if foreign.is_none() {
            for link in links.into_iter().flatten() {
                let next = hex(&link.infohash());
                self.visit(&post, &next, Origin::Link(link.uri().into()), false);
            }
            if !already_authorized && self.desired(&post, &id) && self.allowed(&post, &id, total) {
                self.queue_approval(&post, &id);
            }
        }
        Ok(())
    }
    fn metadata_failure(&mut self, post: &str, id: &str, message: &str) -> Result<()> {
        if let Some(v) = self.visits.get_mut(&(post.into(), id.into())) {
            v.error = message.into();
            v.state = "Error".into();
            v.stage = false;
        }
        Err(err(message))
    }
    fn content_metadata(&mut self, post: &str, id: &str, total: u64, approved: bool) -> Result<()> {
        self.content_totals.insert((post.into(), id.into()), total);
        if approved {
            self.authorized.insert(id.into());
        }
        if !approved && self.can_approve(post, id) {
            self.queue_approval(post, id);
        }
        Ok(())
    }
    pub fn can_approve(&self, post: &str, id: &str) -> bool {
        let Some(s) = self.state.posts.get(post) else {
            return false;
        };
        if !s.followed {
            return false;
        }
        if let Some(v) = self.visits.get(&(post.into(), id.into())) {
            return v.trusted
                && v.foreign.is_none()
                && self.desired(post, id)
                && v.meta
                    .as_ref()
                    .is_some_and(|m| self.allowed(post, id, m.total_length()));
        }
        let wanted = s.config.mode == Mode::MirrorAll || self.state.approvals.contains(id);
        wanted
            && !self
                .content_failures
                .contains_key(&(post.into(), id.into()))
            && self
                .content_totals
                .get(&(post.into(), id.into()))
                .is_some_and(|size| self.allowed(post, id, *size))
    }
    pub fn removed(&mut self, id: &str) {
        self.transfer_states.remove(id);
        self.authorized.remove(id);
        self.content_totals.retain(|(_, h), _| h != id);
        for ((_, h), v) in &mut self.visits {
            if h == id {
                v.ready = false;
                v.stage = false;
                v.approve = false;
                v.approved = false;
                v.meta = None;
                v.entries.clear();
                v.reads.clear();
            }
        }
    }
    fn queue_approval(&mut self, post: &str, id: &str) {
        if self
            .pending
            .values()
            .any(|w| matches!(w,Work::Approve(_,h)if h==id))
        {
            return;
        }
        if let Some(work) = self.new_work(Work::Approve(post.into(), id.into())) {
            if let Some(v) = self.visits.get_mut(&(post.into(), id.into())) {
                v.approve = true;
            }
            self.out.push_back(Action::Approve {
                work,
                post: post.into(),
                id: id.into(),
            });
        }
    }
    pub fn approved(&mut self, work: WorkId) {
        if let Some(Work::Approve(post, id)) = self.pending.remove(&work) {
            self.authorized.insert(id.clone());
            if let Some(v) = self.visits.get_mut(&(post, id)) {
                v.approve = false;
                v.approved = true;
                v.state = "Downloading".into();
            }
        }
    }
    pub fn fail(&mut self, work: WorkId, message: String) {
        if let Some(Work::RenewalLookup(post) | Work::RenewalPut(post, _)) =
            self.pending.get(&work).cloned()
        {
            self.pending.remove(&work);
            self.renewal_failed(&post, message, self.now);
            return;
        }
        if let Some(w) = self.pending.remove(&work) {
            self.event(Event::WorkFailed {
                work,
                message: message.clone(),
            });
            match w {
                Work::RenewalLookup(_) | Work::RenewalPut(_, _) => unreachable!(),
                Work::Lookup(post) => {
                    let r = self.runtime.entry(post).or_default();
                    r.checking = false;
                    r.error = message;
                    r.next_check = self.now.saturating_add(30_000);
                }
                Work::Stage(post, id, _) | Work::Approve(post, id) => {
                    self.content_failures
                        .insert((post.clone(), id.clone()), message.clone());
                    for ((owner, _), v) in &mut self.visits {
                        if owner == &post {
                            for e in v.entries.values_mut() {
                                if e.infohash.as_deref() == Some(&id) {
                                    e.error = message.clone();
                                    e.state = "Error".into();
                                }
                            }
                        }
                    }
                    if let Some(v) = self.visits.get_mut(&(post.clone(), id)) {
                        v.error = message.clone();
                        v.stage = false;
                        v.approve = false;
                        v.state = "Error".into();
                    }
                    self.notice(&post, message);
                }
                Work::Read(post, catalog, index) => {
                    if let Some(v) = self.visits.get_mut(&(post, catalog)) {
                        v.reads.insert(index, true);
                        if let Some(e) = v.entries.get_mut(&index) {
                            e.error = message;
                            e.state = "Error".into();
                        }
                    }
                }
            }
        }
    }
    /// Inspect a verified catalog entry through a host-supplied reader. Large
    /// opaque files are hashed in fixed buffers, never accumulated in memory.
    pub fn item_from_reader<R: std::io::Read, F: FnOnce(&[u8]) -> Option<Description>>(
        &mut self,
        work: WorkId,
        mut reader: R,
        describe: F,
    ) -> Result<()> {
        let Some(Work::Read(post, catalog, index)) = self.pending.get(&work).cloned() else {
            return Ok(());
        };
        let entry = self.visits[&(post.clone(), catalog.clone())]
            .meta
            .as_ref()
            .and_then(|m| m.entries().get(index))
            .ok_or_else(|| err("Unknown catalog item"))?;
        let length = entry.length();
        let expected = entry.sha1();
        let mut digest = Sha1::new();
        let mut count = 0u64;
        let mut data = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = reader.read(&mut buffer).map_err(err)?;
            if n == 0 {
                break;
            }
            count = count
                .checked_add(n as u64)
                .ok_or_else(|| err("Item length overflow"))?;
            if count > length {
                return Err(err("Catalog item length mismatch"));
            }
            digest.update(&buffer[..n]);
            if length <= MAX_METAINFO as u64 {
                data.extend_from_slice(&buffer[..n]);
            }
        }
        if count != length || expected.is_some_and(|h| <[u8; 20]>::from(digest.finalize()) != h) {
            return Err(err("Catalog item SHA-1 mismatch"));
        }
        if length <= MAX_METAINFO as u64 {
            let d = describe(&data);
            self.item(work, data, d)
        } else {
            self.pending.remove(&work);
            let v = self.visits.get_mut(&(post, catalog)).unwrap();
            v.reads.insert(index, true);
            let row = v.entries.get_mut(&index).unwrap();
            row.kind = "file".into();
            row.state = "Available".into();
            row.error.clear();
            Ok(())
        }
    }
    pub fn item(
        &mut self,
        work: WorkId,
        data: Vec<u8>,
        description: Option<Description>,
    ) -> Result<()> {
        let Some(Work::Read(post, catalog, index)) = self.pending.remove(&work) else {
            return Ok(());
        };
        let key = (post.clone(), catalog.clone());
        let file = self.visits[&key]
            .meta
            .as_ref()
            .and_then(|f| f.entries().get(index))
            .cloned()
            .ok_or_else(|| err("Unknown catalog item"))?;
        let result = (|| {
            if data.len() as u64 != file.length()
                || file
                    .sha1()
                    .is_some_and(|h| <[u8; 20]>::from(Sha1::digest(&data)) != h)
            {
                return Err(err("Catalog item SHA-1 mismatch"));
            }
            Ok(())
        })();
        if let Err(e) = result {
            let v = self.visits.get_mut(&key).unwrap();
            v.reads.insert(index, true);
            if let Some(row) = v.entries.get_mut(&index) {
                row.error = e.to_string();
                row.state = "Error".into();
            }
            return Err(e);
        }
        let mut row = self.visits[&key].entries[&index].clone();
        row.state = "Available".into();
        row.error.clear();
        let mut stage = None;
        match bep49::inspect_item(&data) {
            ItemContent::Opaque(_) => {
                row.kind = if description.as_ref().is_some_and(|d| !d.error.is_empty()) {
                    "unsupported"
                } else {
                    "file"
                }
                .into();
                if let Some(d) = description {
                    row.error = d.error;
                }
            }
            ItemContent::Torrent(t) => {
                let id = hex(&t.infohash());
                row.infohash = Some(id.clone());
                row.kind = if t.is_feed() { "catalog" } else { "torrent" }.into();
                if let Some(d) = description {
                    row.total = Some(d.total);
                    row.files = d.files;
                    if !d.name.is_empty() {
                        row.name = d.name;
                    }
                    if !d.error.is_empty() {
                        row.kind = "unsupported".into();
                        row.error = d.error;
                    }
                }
                if t.is_private() {
                    row.kind = "unsupported".into();
                    row.error = "Private torrents are not supported".into();
                }
                if t.is_feed() {
                    match Feed::from_metainfo(&data) {
                        Ok(nested) => {
                            if let Some(source) = nested.fields().source.as_ref() {
                                if source != &self.key(&post)? {
                                    row.kind = "external_post".into();
                                    row.post_magnet = Some(bep46::format_magnet(source));
                                }
                            }
                        }
                        Err(e) => {
                            row.kind = "unsupported".into();
                            row.error = e.to_string();
                        }
                    }
                }
                let s = &self.state.posts[&post];
                let manual = s.manual_items.contains(&(catalog.clone(), index));
                let automatic = match row.kind.as_str() {
                    "catalog" => s.config.mode != Mode::CurrentCatalog,
                    "torrent" => s.config.mode == Mode::MirrorAll,
                    _ => false,
                };
                if matches!(row.kind.as_str(), "catalog" | "torrent")
                    && (manual || automatic)
                    && s.followed
                    && !self.state.suppressed.contains(&id)
                {
                    let role = if row.kind == "catalog" {
                        Role::Catalog
                    } else {
                        Role::Content
                    };
                    if role == Role::Catalog {
                        self.visit(&post, &id, Origin::Item(catalog.clone(), index), false);
                    }
                    let loaded = if role == Role::Catalog {
                        self.visits
                            .get(&(post.clone(), id.clone()))
                            .is_some_and(|v| v.meta.is_some() || v.stage)
                    } else {
                        self.content_totals
                            .contains_key(&(post.clone(), id.clone()))
                    };
                    if !loaded
                        && !self
                            .pending
                            .values()
                            .any(|w| matches!(w,Work::Stage(f,h,_)if f==&post && h==&id))
                    {
                        stage = Some((id, role));
                    }
                }
            }
        }
        let v = self.visits.get_mut(&key).unwrap();
        v.entries.insert(index, row);
        v.reads.insert(index, true);
        if let Some((id, role)) = stage {
            if let Some(work) = self.new_work(Work::Stage(post.clone(), id.clone(), role)) {
                if let Some(v) = self.visits.get_mut(&(post.clone(), id.clone())) {
                    v.stage = true;
                }
                self.out.push_back(Action::Stage {
                    work,
                    post,
                    id,
                    source: Source::Torrent(data),
                    role,
                });
            }
        }
        Ok(())
    }
    pub fn tick(&mut self, now: u64) {
        self.now = self.now.max(now);
        self.schedule_renewals();
        for post in self.state.posts.keys().cloned().collect::<Vec<_>>() {
            if !self.state.posts[&post].followed {
                continue;
            }
            let r = self.runtime.entry(post.clone()).or_default();
            if !r.checking
                && r.next_check <= self.now
                && !self.renewals.get(&post).is_some_and(|r| r.active)
            {
                if let Some(work) = self.new_work(Work::Lookup(post.clone())) {
                    let key = self.key(&post).unwrap();
                    let r = self.runtime.get_mut(&post).unwrap();
                    r.checking = true;
                    r.next_check = self.now.saturating_add(POLL_MS);
                    self.out.push_back(Action::Lookup { work, post, key });
                }
            }
        }
        for (post, id) in self.content_totals.keys().cloned().collect::<Vec<_>>() {
            if !self.authorized.contains(&id) && self.can_approve(&post, &id) {
                self.queue_approval(&post, &id);
            }
        }
        for (post, id) in self.visits.keys().cloned().collect::<Vec<_>>() {
            if !self.followed(&post) {
                continue;
            }
            if self.work_load() >= MAX_WORK || self.out.len() >= MAX_WORK {
                break;
            }
            let key = (post.clone(), id.clone());
            let desired = self.desired(&post, &id);
            let s = &self.state.posts[&post];
            let mode = s.config.mode;
            let v = &self.visits[&key];
            if !v.trusted || v.foreign.is_some() || !v.error.is_empty() {
                continue;
            }
            if (desired || self.transfer_states.contains_key(&id))
                && v.meta.is_none()
                && !v.stage
                && !self.state.suppressed.contains(&id)
            {
                if let Origin::Item(parent, index) = v.origin.clone() {
                    if let Some(p) = self.visits.get_mut(&(post.clone(), parent)) {
                        p.reads.remove(&index);
                    }
                }
                if let Origin::Link(uri) = self.visits[&key].origin.clone() {
                    if let Some(work) =
                        self.new_work(Work::Stage(post.clone(), id.clone(), Role::Catalog))
                    {
                        self.visits.get_mut(&key).unwrap().stage = true;
                        self.out.push_back(Action::Stage {
                            work,
                            post: post.clone(),
                            id: id.clone(),
                            source: Source::Magnet(uri),
                            role: Role::Catalog,
                        });
                    }
                }
            }
            let v = &self.visits[&key];
            if let Some(meta) = &v.meta {
                if desired
                    && !v.approved
                    && !v.approve
                    && self.allowed(&post, &id, meta.total_length())
                {
                    self.queue_approval(&post, &id);
                }
            }
            let v = self.visits.get_mut(&key).unwrap();
            if !v.ready {
                continue;
            }
            let Some(meta) = &v.meta else { continue };
            for entry in meta
                .entries()
                .iter()
                .filter(|e| e.kind() == EntryKind::Item)
            {
                v.entries.entry(entry.index()).or_insert_with(|| EntryView {
                    index: entry.index(),
                    name: entry.path().join("/"),
                    source_name: entry.path().join("/"),
                    length: entry.length(),
                    kind: "pending".into(),
                    state: "Reading metadata".into(),
                    ..Default::default()
                });
            }
            let indices = v.entries.keys().copied().collect::<Vec<_>>();
            for index in indices {
                if self.work_load() >= MAX_WORK || self.out.len() >= MAX_WORK {
                    break;
                }
                let v = &self.visits[&key];
                if v.reads.get(&index) == Some(&false) {
                    continue;
                }
                let row = &v.entries[&index];
                let manual = self.state.posts[&post]
                    .manual_items
                    .contains(&(id.clone(), index));
                let wanted = manual
                    || match row.kind.as_str() {
                        "catalog" => mode != Mode::CurrentCatalog,
                        "torrent" => mode == Mode::MirrorAll,
                        _ => false,
                    };
                let existing = row.infohash.as_ref().is_some_and(|h| {
                    (self.transfer_states.contains_key(h)
                        && (row.kind == "catalog"
                            || self.content_totals.contains_key(&(post.clone(), h.clone()))))
                        || self.state.suppressed.contains(h)
                        || self
                            .pending
                            .values()
                            .any(|w| matches!(w,Work::Stage(_,target,_)if target==h))
                });
                let needed =
                    !v.reads.contains_key(&index) || (wanted && !existing && row.error.is_empty());
                if needed {
                    let length = v.entries[&index].length;
                    if let Some(work) = self.new_work(Work::Read(post.clone(), id.clone(), index)) {
                        self.visits
                            .get_mut(&key)
                            .unwrap()
                            .reads
                            .insert(index, false);
                        self.out.push_back(Action::Read {
                            work,
                            post: post.clone(),
                            catalog: id.clone(),
                            index,
                            length,
                        });
                    }
                }
            }
        }
    }
    pub fn cancel(&mut self, work: WorkId) {
        if let Some(w) = self.pending.remove(&work) {
            match w {
                Work::Stage(f, h, _) => {
                    if let Some(v) = self.visits.get_mut(&(f, h)) {
                        v.stage = false;
                    }
                }
                Work::Approve(f, h) => {
                    if let Some(v) = self.visits.get_mut(&(f, h)) {
                        v.approve = false;
                    }
                }
                Work::Read(f, h, i) => {
                    if let Some(v) = self.visits.get_mut(&(f, h)) {
                        v.reads.remove(&i);
                    }
                }
                Work::RenewalLookup(f) | Work::RenewalPut(f, _) => {
                    if let Some(r) = self.renewals.get_mut(&f) {
                        r.active = false;
                        r.ready = false;
                    }
                    if let Some(r) = self.runtime.get_mut(&f) {
                        r.checking = false;
                    }
                }
                Work::Lookup(f) => {
                    if let Some(r) = self.runtime.get_mut(&f) {
                        r.checking = false;
                    }
                }
            }
        }
    }
    pub fn should_stage(&self, post: &str, id: &str, role: Role) -> bool {
        self.followed(post)
            && !self.state.suppressed.contains(id)
            && match role {
                Role::Catalog => {
                    self.visits
                        .get(&(post.into(), id.into()))
                        .is_some_and(|v| v.trusted)
                        && (self.desired(post, id) || self.transfer_states.contains_key(id))
                }
                Role::Content => {
                    self.state.posts[post].config.mode == Mode::MirrorAll
                        || self.state.approvals.contains(id)
                }
            }
    }
    pub fn work_is_current(&self, id: WorkId) -> bool {
        self.pending.contains_key(&id)
    }
    fn catalog_view(&self, _post: &str, id: &str, v: &Visit) -> CatalogView {
        let (name, total, previous, archive, count) = if let Some(m) = &v.meta {
            (
                m.name().to_string(),
                m.total_length(),
                m.fields().previous.as_ref().map(|l| hex(&l.infohash())),
                m.fields().archive_next.as_ref().map(|l| hex(&l.infohash())),
                m.items().count(),
            )
        } else {
            (id.into(), 0, None, None, 0)
        };
        CatalogView {
            id: id.into(),
            name,
            total,
            state: v.state.clone(),
            error: v.error.clone(),
            ready: v.ready,
            previous,
            archive,
            foreign_post: v.foreign.clone(),
            count,
            indexed: v.reads.values().filter(|done| **done).count(),
        }
    }
    pub fn page(&self, post: &str, catalog: &str, offset: usize) -> Result<Page> {
        let v = self
            .visits
            .get(&(post.into(), catalog.into()))
            .ok_or_else(|| err("Catalog not found"))?;
        let mut entries: Vec<_> = v.entries.values().skip(offset).take(100).cloned().collect();
        for e in &mut entries {
            if let Some(id) = &e.infohash {
                e.state = self
                    .transfer_states
                    .get(id)
                    .map(|(s, _)| s.clone())
                    .unwrap_or_else(|| {
                        if self.state.suppressed.contains(id) {
                            "Paused or removed".into()
                        } else if e.kind == "torrent" || e.kind == "catalog" {
                            "Not downloaded".into()
                        } else {
                            e.state.clone()
                        }
                    });
            }
        }
        Ok(Page {
            catalog: self.catalog_view(post, catalog, v),
            total: v.entries.len(),
            entries,
            offset,
        })
    }
    pub fn views(&self) -> Vec<PostView> {
        self.state
            .posts
            .iter()
            .filter(|(_, s)| s.followed)
            .map(|(id, s)| {
                let r = self.runtime.get(id);
                let mut catalogs: Vec<_> = self
                    .visits
                    .iter()
                    .filter(|((owner, _), _)| owner == id)
                    .map(|((_, h), v)| self.catalog_view(id, h, v))
                    .collect();
                catalogs.sort_by(|a, b| a.id.cmp(&b.id));
                let head = r.and_then(|r| r.head.clone());
                let available = head
                    .as_ref()
                    .filter(|h| {
                        self.visits
                            .get(&(id.clone(), (*h).clone()))
                            .is_some_and(|v| v.ready)
                    })
                    .cloned()
                    .or_else(|| {
                        s.records
                            .iter()
                            .rev()
                            .filter_map(|d| d.verify(&identity(&s.magnet).ok()?).ok())
                            .filter_map(|r| bep46::decode_payload(r.value()).ok())
                            .map(|h| hex(&h))
                            .find(|h| {
                                self.visits
                                    .get(&(id.clone(), h.clone()))
                                    .is_some_and(|v| v.ready)
                            })
                    });
                let relevant: Vec<_> = catalogs
                    .iter()
                    .filter(|c| self.desired(id, &c.id) && c.foreign_post.is_none())
                    .collect();
                let ready = available.is_some();
                let mut needs = relevant.iter().any(|c| {
                    !c.error.is_empty()
                        || c.state == "Awaiting approval"
                        || c.state == "Paused"
                        || c.state == "Paused or removed"
                        || c.state == "Error"
                });
                let mut running =
                    head.is_none() || relevant.iter().any(|c| !c.ready || c.indexed < c.count);
                for ((owner, h), v) in &self.visits {
                    if owner != id || !self.desired(id, h) || v.foreign.is_some() || !v.ready {
                        continue;
                    }
                    for e in v.entries.values() {
                        if !e.error.is_empty() {
                            needs = true;
                        }
                        if s.config.mode == Mode::MirrorAll && e.kind == "torrent" {
                            match e
                                .infohash
                                .as_ref()
                                .and_then(|h| self.transfer_states.get(h))
                            {
                                Some((state, true)) if state != "Paused" => {}
                                Some((state, _))
                                    if matches!(
                                        state.as_str(),
                                        "Awaiting approval" | "Paused" | "Error"
                                    ) =>
                                {
                                    needs = true
                                }
                                _ if e
                                    .infohash
                                    .as_ref()
                                    .is_some_and(|h| self.state.suppressed.contains(h)) =>
                                {
                                    needs = true
                                }
                                _ => running = true,
                            }
                        }
                    }
                }
                let state = if needs {
                    "Needs attention"
                } else if ready {
                    "Ready"
                } else if head.is_some() {
                    "Syncing catalog"
                } else {
                    "Resolving post"
                };
                let mirror_status = if needs {
                    "Incomplete"
                } else if running {
                    "Syncing observed catalogs"
                } else {
                    "Observed catalogs up to date"
                };
                PostView {
                    local_name: s.config.name.clone(),
                    id: id.clone(),
                    name: if !s.config.name.is_empty() {
                        s.config.name.clone()
                    } else {
                        head.as_ref()
                            .and_then(|h| self.visits.get(&(id.clone(), h.clone())))
                            .and_then(|v| v.meta.as_ref())
                            .map(|m| m.name().to_string())
                            .unwrap_or_else(|| format!("{}…", &id[..12]))
                    },
                    magnet: s.magnet.clone(),
                    mode: s.config.mode,
                    automatic_limit: s.config.automatic_limit,
                    sequence: s.records.last().map(|r| r.sequence.to_string()),
                    head,
                    available,
                    state: state.into(),
                    error: r.map(|r| r.error.clone()).unwrap_or_default(),
                    update_peers: r.map_or(0, |r| r.peers),
                    last_checked_ms: r.and_then(|r| r.last_checked),
                    catalogs,
                    mirror_status: mirror_status.into(),
                }
            })
            .collect()
    }
    pub fn approval_size(&self, id: &str) -> Option<u64> {
        self.visits
            .iter()
            .find_map(|((_, h), v)| {
                (h == id)
                    .then_some(v.meta.as_ref())
                    .flatten()
                    .map(|m| m.total_length())
            })
            .or_else(|| {
                self.content_totals
                    .iter()
                    .find_map(|((_, h), n)| (h == id).then_some(*n))
            })
    }
    pub fn validation_error(&self, id: &str) -> Option<&str> {
        self.visits
            .iter()
            .find_map(|((_, h), v)| (h == id && !v.error.is_empty()).then_some(v.error.as_str()))
    }
    pub fn followed(&self, id: &str) -> bool {
        self.state.posts.get(id).is_some_and(|s| s.followed)
    }
}
fn action_post(a: &Action) -> &str {
    match a {
        Action::Relay { post, .. }
        | Action::Watch { post, .. }
        | Action::Unwatch { post, .. }
        | Action::Lookup { post, .. }
        | Action::RenewalLookup { post, .. }
        | Action::RenewalPut { post, .. }
        | Action::Stage { post, .. }
        | Action::Read { post, .. }
        | Action::Approve { post, .. } => post,
    }
}
fn work_post(w: &Work) -> &str {
    match w {
        Work::Lookup(f)
        | Work::RenewalLookup(f)
        | Work::RenewalPut(f, _)
        | Work::Stage(f, _, _)
        | Work::Read(f, _, _)
        | Work::Approve(f, _) => f,
    }
}
