//! Local retention graph. Counts are derived from roots, never incremented blindly.
use super::*;
use std::collections::BTreeSet;
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Post {
        post_kind: String,
        id: String,
    },
    Unpin {
        id: String,
    },
    #[default]
    Nothing,
    Torrent {
        id: String,
        #[serde(default)]
        delete_files: bool,
    },
}
impl Target {
    pub fn root(&self) -> Option<String> {
        match self {
            Self::Post { post_kind, id } => Some(format!("{post_kind}:{id}")),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cleanup {
    pub id: u64,
    pub target: Target,
    pub detached: bool,
    pub remaining: BTreeSet<String>,
    pub error: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Graph {
    pub initialized: bool,
    pub revision: u64,
    pub next_job: u64,
    pub roots: BTreeMap<String, BTreeSet<String>>,
    pub edges: BTreeMap<String, BTreeSet<String>>,
    pub pins: BTreeSet<String>,
    pub assets: BTreeSet<String>,
    pub jobs: BTreeMap<u64, Cleanup>,
}
impl Default for Graph {
    fn default() -> Self {
        Self {
            initialized: false,
            revision: 1,
            next_job: 1,
            roots: BTreeMap::new(),
            edges: BTreeMap::new(),
            pins: BTreeSet::new(),
            assets: BTreeSet::new(),
            jobs: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub revision: String,
    pub target: Target,
    pub deleting: Vec<String>,
    pub shared: Vec<String>,
    pub protected: Vec<String>,
}
impl Graph {
    fn bump(&mut self) -> Result<()> {
        self.revision = self
            .revision
            .checked_add(1)
            .context("Reference revision exhausted")?;
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        if self.revision == 0 || self.next_job == 0 {
            bail!("Invalid reference registry")
        }
        for id in self
            .assets
            .iter()
            .chain(self.pins.iter())
            .chain(self.edges.keys())
            .chain(self.edges.values().flatten())
            .chain(self.roots.values().flatten())
        {
            if !valid_id(id) {
                bail!("Invalid reference identifier")
            }
        }
        for root in self.roots.keys() {
            Self::check_root(root)?;
        }
        for (id, j) in &self.jobs {
            if *id == 0
                || *id != j.id
                || *id >= self.next_job
                || j.remaining.iter().any(|h| !valid_id(h))
            {
                bail!("Invalid cleanup job")
            }
            match &j.target {
                Target::Post { post_kind, id } => Self::check_root(&format!("{post_kind}:{id}"))?,
                Target::Unpin { id } | Target::Torrent { id, .. } if valid_id(id) => {}
                _ => bail!("Invalid cleanup target"),
            }
        }
        Ok(())
    }
    fn check_root(root: &str) -> Result<()> {
        let (kind, id) = root.split_once(':').context("Invalid post root")?;
        if !matches!(kind, "own" | "followed") || !valid_id(id) {
            bail!("Invalid post root")
        };
        Ok(())
    }
    pub fn blocked(&self, root: &str) -> bool {
        self.jobs
            .values()
            .any(|j| j.target.root().as_deref() == Some(root))
    }
    pub fn ensure_root(&mut self, root: &str) -> Result<()> {
        Self::check_root(root)?;
        if self.blocked(root) {
            bail!("Post is being deleted")
        }
        if !self.roots.contains_key(root) {
            self.roots.insert(root.into(), BTreeSet::new());
            self.bump()?;
        }
        Ok(())
    }
    pub fn claim(&mut self, root: &str, id: &str, parent: Option<&str>) -> Result<()> {
        if !valid_id(id) || parent.is_some_and(|p| !valid_id(p)) {
            bail!("Invalid reference identifier")
        }
        self.ensure_root(root)?;
        let mut changed = self.assets.insert(id.into());
        changed |= self.roots.get_mut(root).unwrap().insert(id.into());
        if let Some(parent) = parent {
            changed |= self
                .edges
                .entry(parent.into())
                .or_default()
                .insert(id.into());
        }
        if changed {
            self.bump()?;
        }
        Ok(())
    }
    pub fn link(&mut self, parent: &str, id: &str) -> Result<()> {
        if !valid_id(parent) || !valid_id(id) {
            bail!("Invalid catalog reference")
        }
        let changed = self
            .edges
            .entry(parent.into())
            .or_default()
            .insert(id.into());
        if changed {
            self.bump()?;
        }
        Ok(())
    }
    pub fn register_asset(&mut self, id: &str) -> Result<()> {
        if !valid_id(id) {
            bail!("Invalid asset identifier")
        }
        if self.assets.insert(id.into()) {
            self.bump()?;
        }
        Ok(())
    }
    pub fn pin(&mut self, id: &str) -> Result<()> {
        if !valid_id(id) {
            bail!("Invalid pin identifier")
        }
        let changed = self.assets.insert(id.into()) | self.pins.insert(id.into());
        if changed {
            self.bump()?;
        }
        Ok(())
    }
    pub fn closure(&self, initial: impl IntoIterator<Item = String>) -> BTreeSet<String> {
        let mut todo: Vec<_> = initial.into_iter().collect();
        let mut seen = BTreeSet::new();
        while let Some(id) = todo.pop() {
            if seen.insert(id.clone()) {
                if let Some(children) = self.edges.get(&id) {
                    todo.extend(children.iter().cloned());
                }
            }
        }
        seen
    }
    fn reachable_without(&self, target: &Target) -> BTreeSet<String> {
        let root = target.root();
        let mut seeds = vec![];
        for (key, ids) in &self.roots {
            if Some(key) != root.as_ref() {
                seeds.extend(ids.iter().cloned());
            }
        }
        for id in &self.pins {
            if !matches!(target,Target::Unpin{id:excluded} if excluded==id) {
                seeds.push(id.clone());
            }
        }
        self.closure(seeds)
    }
    pub fn protected_by(&self, id: &str) -> Vec<String> {
        self.pins
            .iter()
            .filter(|p| self.closure([(*p).clone()]).contains(id))
            .cloned()
            .collect()
    }
    pub fn used_by(&self, id: &str) -> Vec<String> {
        self.roots
            .iter()
            .filter(|(_, ids)| self.closure(ids.iter().cloned()).contains(id))
            .map(|(root, _)| root.clone())
            .collect()
    }
    pub fn preview(&self, target: Target) -> Result<Preview> {
        let affected = match &target {
            Target::Post { .. } => {
                let root = target.root().unwrap();
                Self::check_root(&root)?;
                self.closure(
                    self.roots
                        .get(&root)
                        .context("Post unavailable")?
                        .iter()
                        .cloned(),
                )
            }
            Target::Unpin { id } => {
                if !self.pins.contains(id) {
                    bail!("Torrent does not have Pin")
                };
                self.closure([id.clone()])
            }
            Target::Torrent { id, .. } => {
                if !self.assets.contains(id) {
                    bail!("Torrent unavailable")
                };
                if !self.protected_by(id).is_empty() {
                    bail!("Remove Pin protection before deleting this torrent")
                };
                BTreeSet::from([id.clone()])
            }
            Target::Nothing => bail!("Invalid removal target"),
        };
        let live = self.reachable_without(&target);
        let mut out = Preview {
            revision: self.revision.to_string(),
            target: target.clone(),
            deleting: vec![],
            shared: vec![],
            protected: vec![],
        };
        for id in affected.intersection(&self.assets) {
            let pins = self
                .protected_by(id)
                .into_iter()
                .filter(|p| !matches!(&target,Target::Unpin{id} if id==p))
                .collect::<Vec<_>>();
            if !pins.is_empty() {
                out.protected.push(id.clone());
            } else if matches!(target, Target::Torrent { .. }) || !live.contains(id) {
                out.deleting.push(id.clone());
            } else {
                out.shared.push(id.clone());
            }
        }
        Ok(out)
    }
    pub fn begin(&mut self, target: Target, revision: &str) -> Result<u64> {
        if self.revision.to_string() != revision {
            bail!("References changed; review the updated deletion preview")
        }
        if self.jobs.values().any(|j| j.target == target) {
            bail!("Deletion already pending")
        }
        let preview = self.preview(target.clone())?;
        let id = self.next_job;
        self.next_job = self
            .next_job
            .checked_add(1)
            .context("Cleanup identifiers exhausted")?;
        self.jobs.insert(
            id,
            Cleanup {
                id,
                target,
                detached: false,
                remaining: preview
                    .deleting
                    .into_iter()
                    .chain(preview.shared)
                    .chain(preview.protected)
                    .collect(),
                error: String::new(),
            },
        );
        self.bump()?;
        Ok(id)
    }
    pub fn detach(&mut self, id: u64) -> Result<()> {
        let j = self.jobs.get(&id).context("Cleanup unavailable")?;
        if j.detached {
            return Ok(());
        }
        let target = j.target.clone();
        // Keep the full affected set, including copies currently shared or pinned.
        // Two confirmed removals may retire their roots before either collector runs.
        if !matches!(target, Target::Torrent { .. }) {
            let current = self.preview(target.clone())?;
            self.jobs.get_mut(&id).unwrap().remaining.extend(
                current
                    .deleting
                    .into_iter()
                    .chain(current.shared)
                    .chain(current.protected),
            );
        }
        match &target {
            Target::Post { .. } => {
                self.roots.remove(&target.root().unwrap());
            }
            Target::Unpin { id } => {
                self.pins.remove(id);
            }
            _ => {}
        }
        self.jobs.get_mut(&id).unwrap().detached = true;
        self.bump()?;
        Ok(())
    }
    pub fn abort(&mut self, id: u64) -> Result<()> {
        if self.jobs.get(&id).is_some_and(|j| j.detached) {
            bail!("Deletion already committed")
        };
        self.jobs.remove(&id);
        self.bump()
    }
    pub fn may_delete(&self, job: u64, id: &str) -> bool {
        let Some(j) = self.jobs.get(&job) else {
            return false;
        };
        j.detached
            && j.remaining.contains(id)
            && self.protected_by(id).is_empty()
            && (matches!(j.target, Target::Torrent { .. })
                || !self.reachable_without(&Target::Nothing).contains(id))
    }
    pub fn acknowledge(&mut self, job: u64, id: &str, deleted: bool) -> Result<()> {
        if deleted {
            self.assets.remove(id);
        }
        let j = self.jobs.get_mut(&job).context("Cleanup unavailable")?;
        j.remaining.remove(id);
        j.error.clear();
        if j.remaining.is_empty() {
            self.jobs.remove(&job);
        }
        self.bump()
    }
    pub fn finish_empty(&mut self, job: u64) -> Result<()> {
        if self
            .jobs
            .get(&job)
            .is_some_and(|j| j.detached && j.remaining.is_empty())
        {
            self.jobs.remove(&job);
            self.bump()?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn h(c: char) -> String {
        c.to_string().repeat(40)
    }
    fn root(c: char) -> String {
        format!("own:{}", h(c))
    }
    #[test]
    fn overlapping_confirmed_removals_collect_the_last_shared_copy() {
        let mut g = Graph::default();
        g.claim(&root('a'), &h('1'), None).unwrap();
        g.claim(&root('b'), &h('1'), None).unwrap();
        let pa = g
            .preview(Target::Post {
                post_kind: "own".into(),
                id: h('a'),
            })
            .unwrap();
        assert!(pa.deleting.is_empty());
        let ja = g.begin(pa.target, &pa.revision).unwrap();
        let pb = g
            .preview(Target::Post {
                post_kind: "own".into(),
                id: h('b'),
            })
            .unwrap();
        assert!(pb.deleting.is_empty());
        let jb = g.begin(pb.target, &pb.revision).unwrap();
        g.detach(ja).unwrap();
        assert!(!g.may_delete(ja, &h('1')));
        g.acknowledge(ja, &h('1'), false).unwrap();
        g.detach(jb).unwrap();
        assert!(g.may_delete(jb, &h('1')));
        g.acknowledge(jb, &h('1'), true).unwrap();
        assert!(!g.assets.contains(&h('1')));
    }
    #[test]
    fn shared_content_and_cycles_are_collected_by_reachability() {
        let mut g = Graph::default();
        g.claim(&root('a'), &h('1'), None).unwrap();
        g.assets.insert(h('2'));
        g.link(&h('1'), &h('2')).unwrap();
        g.link(&h('2'), &h('1')).unwrap();
        g.claim(&root('b'), &h('2'), None).unwrap();
        assert!(g
            .preview(Target::Post {
                post_kind: "own".into(),
                id: h('a')
            })
            .unwrap()
            .deleting
            .is_empty());
        g.roots.remove(&root('b'));
        let p = g
            .preview(Target::Post {
                post_kind: "own".into(),
                id: h('a'),
            })
            .unwrap();
        assert_eq!(p.deleting, vec![h('1'), h('2')]);
    }
    #[test]
    fn pins_inherit_and_unpin_collects_only_when_no_other_root_exists() {
        let mut g = Graph::default();
        g.claim(&root('a'), &h('1'), None).unwrap();
        g.assets.insert(h('2'));
        g.link(&h('1'), &h('2')).unwrap();
        g.pin(&h('1')).unwrap();
        assert_eq!(g.protected_by(&h('2')), vec![h('1')]);
        assert!(g
            .preview(Target::Torrent {
                id: h('2'),
                delete_files: true
            })
            .is_err());
        assert!(g
            .preview(Target::Unpin { id: h('1') })
            .unwrap()
            .deleting
            .is_empty());
        g.roots.clear();
        assert_eq!(
            g.preview(Target::Unpin { id: h('1') })
                .unwrap()
                .deleting
                .len(),
            2
        );
    }
    #[test]
    fn previews_are_fenced_and_new_references_rescue_pending_cleanup() {
        let mut g = Graph::default();
        g.claim(&root('a'), &h('1'), None).unwrap();
        let p = g
            .preview(Target::Post {
                post_kind: "own".into(),
                id: h('a'),
            })
            .unwrap();
        g.pin(&h('2')).unwrap();
        assert!(g.begin(p.target.clone(), &p.revision).is_err());
        let j = g.begin(p.target, &g.revision.to_string()).unwrap();
        g.detach(j).unwrap();
        assert!(g.may_delete(j, &h('1')));
        g.claim(&root('b'), &h('1'), None).unwrap();
        assert!(!g.may_delete(j, &h('1')));
        g.acknowledge(j, &h('1'), false).unwrap();
        assert!(g.assets.contains(&h('1')));
    }
    #[test]
    fn durable_intent_preserves_root_until_detached_and_rejects_late_claims() {
        let mut g = Graph::default();
        g.claim(&root('a'), &h('1'), None).unwrap();
        let j = g
            .begin(
                Target::Post {
                    post_kind: "own".into(),
                    id: h('a'),
                },
                &g.revision.to_string(),
            )
            .unwrap();
        assert!(g.roots.contains_key(&root('a')));
        assert!(!g.may_delete(j, &h('1')));
        assert!(g.claim(&root('a'), &h('2'), None).is_err());
        let bytes = serde_json::to_vec(&g).unwrap();
        let mut again: Graph = serde_json::from_slice(&bytes).unwrap();
        again.validate().unwrap();
        again.detach(j).unwrap();
        assert!(again.may_delete(j, &h('1')));
    }
    #[test]
    fn independent_open_is_idempotent_and_abort_keeps_retention() {
        let mut g = Graph::default();
        g.pin(&h('1')).unwrap();
        let rev = g.revision;
        g.pin(&h('1')).unwrap();
        assert_eq!(rev, g.revision);
        let j = g
            .begin(Target::Unpin { id: h('1') }, &rev.to_string())
            .unwrap();
        g.abort(j).unwrap();
        assert!(g.pins.contains(&h('1')));
    }
}

impl Engine {
    pub(crate) fn change_retention<T>(
        &mut self,
        change: impl FnOnce(&mut lifecycle::Graph) -> Result<T>,
    ) -> Result<T> {
        let mut next = self.store.clone();
        let result = change(&mut next.retention)?;
        next.retention.validate()?;
        atomic(
            &self.dir.join("transfers.json"),
            &serde_json::to_vec_pretty(&next)?,
        )?;
        self.store = next;
        for record in &self.store.records {
            storage::write_manifest(record, self.store.retention.pins.contains(&record.id))?;
        }
        Ok(result)
    }
    pub(super) fn sync_retention(&mut self) -> Result<()> {
        // Publication state is attached before the first externally visible snapshot.
        let Some(view) = self.publication_view.as_ref().map(|v| v.borrow().clone()) else {
            return Ok(());
        };
        if !view.error.is_empty() {
            if !self.store.retention.initialized {
                let ids: Vec<_> = self.store.records.iter().map(|r| r.id.clone()).collect();
                self.change_retention(|g| {
                    for id in ids {
                        g.pin(&id)?;
                    }
                    g.initialized = true;
                    g.bump()
                })?;
            }
            return Ok(());
        }
        let mut next = self.store.retention.clone();
        let before = serde_json::to_vec(&next)?;
        let followed = self
            .posts
            .as_ref()
            .map(|h| h.manager.views())
            .unwrap_or_default();
        for job in self.retention_recovery.clone() {
            let Some(pending) = next.jobs.get(&job).cloned() else {
                continue;
            };
            if pending.detached {
                next.jobs.get_mut(&job).unwrap().error.clear();
                continue;
            }
            let post_exists = match &pending.target {
                lifecycle::Target::Post { post_kind, id } if post_kind == "own" => {
                    view.posts.iter().any(|p| &p.id == id)
                }
                lifecycle::Target::Post { id, .. } => followed.iter().any(|p| &p.id == id),
                _ => false,
            };
            if !post_exists {
                next.detach(job)?;
            }
            // A confirmed intent whose post still exists is resumed by the
            // asynchronous coordinator, outside the native actor.
        }
        let record_ids: std::collections::BTreeSet<_> =
            self.store.records.iter().map(|r| r.id.clone()).collect();
        next.assets.extend(record_ids.iter().cloned());
        for p in &view.posts {
            let root = format!("own:{}", p.id);
            if next.blocked(&root) {
                continue;
            }
            next.ensure_root(&root)?;
            for hash in view.retention.get(&p.id).into_iter().flatten() {
                if record_ids.contains(hash) || self.dir.join("published").join(hash).is_dir() {
                    next.claim(&root, hash, None)?;
                }
            }
            for hash in view.entries.get(&p.id).into_iter().flatten() {
                if record_ids.contains(hash) {
                    next.claim(&root, hash, None)?;
                }
            }
        }
        for p in &followed {
            let root = format!("followed:{}", p.id);
            if !next.blocked(&root) {
                next.ensure_root(&root)?;
            }
        }
        if let Some(host) = &self.posts {
            for (parent, child) in host.manager.retention_edges() {
                next.link(&parent, &child)?;
            }
            for (post, id, parent) in host.manager.retention_references() {
                let root = format!("followed:{post}");
                if record_ids.contains(&id) && !next.blocked(&root) {
                    next.claim(&root, &id, parent.as_deref())?;
                }
            }
        }
        if !next.initialized {
            for record in &self.store.records {
                if record.kind.is_empty() || next.used_by(&record.id).is_empty() {
                    next.pin(&record.id)?;
                }
            }
            next.initialized = true;
            next.bump()?;
        }
        if serde_json::to_vec(&next)? != before {
            self.change_retention(|g| {
                *g = next;
                Ok(())
            })?;
        }
        self.retention_recovery.clear();
        Ok(())
    }
}

impl Engine {
    pub(super) fn removal_preview(
        &mut self,
        target: lifecycle::Target,
    ) -> Result<serde_json::Value> {
        self.sync_retention()?;
        self.scan_retention_catalogs()?;
        let p = self.store.retention.preview(target)?;
        let mut value = serde_json::to_value(&p)?;
        let bytes = p.deleting.iter().try_fold(0u64, |sum, id| {
            let amount = self
                .view
                .transfers
                .iter()
                .find(|t| &t.id == id)
                .map(|t| t.verified)
                .unwrap_or(0);
            sum.checked_add(amount).context("Deletion size overflow")
        })?;
        let names = |ids: &Vec<String>| {
            ids.iter()
                .map(|id| {
                    self.view
                        .transfers
                        .iter()
                        .find(|t| &t.id == id)
                        .map(|t| t.name.clone())
                        .unwrap_or_else(|| id.clone())
                })
                .collect::<Vec<_>>()
        };
        value["bytes"] = serde_json::json!(bytes);
        value["names"] = serde_json::json!(names(&p.deleting));
        value["shared_names"] = serde_json::json!(names(&p.shared));
        value["protected_names"] = serde_json::json!(names(&p.protected));
        if let lifecycle::Target::Torrent { id, .. } = &p.target {
            value["used_by"] = serde_json::json!(self.store.retention.used_by(id));
        }
        Ok(value)
    }
    pub(super) fn begin_removal(
        &mut self,
        target: lifecycle::Target,
        revision: &str,
    ) -> Result<serde_json::Value> {
        self.sync_retention()?;
        self.scan_retention_catalogs()?;
        let id = self.change_retention(|g| g.begin(target, revision))?;
        Ok(serde_json::json!({"job":id}))
    }
    pub(super) fn finish_post_removal(&mut self, job: u64) -> Result<serde_json::Value> {
        let pending = self
            .store
            .retention
            .jobs
            .get(&job)
            .context("Cleanup unavailable")?
            .clone();
        if let lifecycle::Target::Post { post_kind, id } = &pending.target {
            if !pending.detached && post_kind == "followed" {
                let host = self.posts.as_mut().context("Post service unavailable")?;
                if !host.available() {
                    bail!("Post state is invalid; files preserved")
                }
                let previous = host.manager.clone();
                host.manager.unfollow(id)?;
                if let Err(error) = host.persist(&self.dir) {
                    host.manager = previous;
                    let _ = host.persist(&self.dir);
                    return Err(error);
                }
            } else if !pending.detached
                && post_kind == "own"
                && self
                    .publication_view
                    .as_ref()
                    .is_some_and(|v| v.borrow().posts.iter().any(|p| p.id == *id))
            {
                bail!("Post deletion has not committed")
            }
        }
        if let lifecycle::Target::Torrent { id, .. } = &pending.target {
            if !pending.detached {
                if let Some(host) = &mut self.posts {
                    let previous = host.manager.clone();
                    host.manager.suppress(id)?;
                    host.manager.removed(id);
                    if let Err(error) = host.persist(&self.dir) {
                        host.manager = previous;
                        let _ = host.persist(&self.dir);
                        return Err(error);
                    }
                }
            }
        }
        self.change_retention(|g| g.detach(job))?;
        self.cleanup_tick();
        let pending = self.store.retention.jobs.contains_key(&job);
        Ok(serde_json::json!({"ok":true,"cleanup_pending":pending,"job":job}))
    }
    pub(super) fn cancel_removal(&mut self, job: u64) -> Result<serde_json::Value> {
        self.change_retention(|g| g.abort(job))?;
        Ok(serde_json::json!({"ok":true}))
    }
    pub(super) fn set_pin(
        &mut self,
        id: &str,
        pinned: bool,
        revision: Option<&str>,
    ) -> Result<serde_json::Value> {
        self.record(id)?;
        if pinned {
            self.change_retention(|g| g.pin(id))?;
            return Ok(serde_json::json!({"ok":true}));
        }
        let revision = revision.context("Review the Unpin preview before confirming")?;
        let target = lifecycle::Target::Unpin { id: id.into() };
        let job = self.begin_removal(target, revision)?["job"]
            .as_u64()
            .unwrap();
        self.finish_post_removal(job)
    }
    pub(super) fn remove_transfer(
        &mut self,
        id: &str,
        delete_files: bool,
        revision: Option<&str>,
    ) -> Result<()> {
        self.record(id)?;
        let target = lifecycle::Target::Torrent {
            id: id.into(),
            delete_files,
        };
        let revision = revision.context("Reload FeedTorrent and review the deletion preview")?;
        self.sync_retention()?;
        self.scan_retention_catalogs()?;
        if self.store.retention.revision.to_string() != revision {
            bail!("References changed; review the updated deletion preview")
        }
        let pending = self
            .store
            .retention
            .jobs
            .values()
            .find(|j| j.target == target)
            .map(|j| j.id);
        let job = if let Some(job) = pending {
            self.retry_cleanup(job)?;
            job
        } else {
            let job = self.begin_removal(target, revision)?["job"]
                .as_u64()
                .unwrap();
            if let Err(error) = self.finish_post_removal(job) {
                let _ = self.cancel_removal(job);
                return Err(error);
            }
            job
        };
        if let Some(pending) = self.store.retention.jobs.get(&job) {
            if !pending.error.is_empty() {
                bail!("{}", pending.error)
            }
        }
        Ok(())
    }
    pub(super) fn retry_cleanup(&mut self, job: u64) -> Result<()> {
        self.change_retention(|g| {
            let j = g.jobs.get_mut(&job).context("Cleanup unavailable")?;
            j.error.clear();
            Ok(())
        })?;
        if self
            .store
            .retention
            .jobs
            .get(&job)
            .is_some_and(|j| !j.detached)
        {
            self.finish_post_removal(job)?;
        } else {
            self.cleanup_tick();
        }
        Ok(())
    }
    pub(super) fn cleanup_tick(&mut self) {
        if self.store.retention.jobs.is_empty() {
            return;
        }
        if let Err(error) = self
            .sync_retention()
            .and_then(|()| self.scan_retention_catalogs())
        {
            self.view.warning = format!("Cleanup references: {error:#}");
            return;
        }
        let Some(job) = self
            .store
            .retention
            .jobs
            .values()
            .find(|j| j.detached && j.error.is_empty())
            .cloned()
        else {
            return;
        };
        if let lifecycle::Target::Post { post_kind, id } = &job.target {
            if post_kind == "own"
                && self
                    .publication_view
                    .as_ref()
                    .is_some_and(|v| v.borrow().busy.contains(id))
            {
                return;
            }
        }
        let Some(id) = job.remaining.iter().next().cloned() else {
            let _ = self.change_retention(|g| g.finish_empty(job.id));
            return;
        };
        // A confirmed removal waits for all writers that could still materialize
        // this catalog, including a manual removal during publication.
        if self.publication_view.as_ref().is_some_and(|v| {
            let view = v.borrow();
            self.store.retention.used_by(&id).iter().any(|root| {
                root.strip_prefix("own:")
                    .is_some_and(|post| view.busy.contains(post))
            })
        }) {
            return;
        }
        let result = (|| -> Result<()> {
            if !self.store.retention.may_delete(job.id, &id) {
                if self.store.records.iter().any(|r| r.id == id)
                    && !self
                        .store
                        .retention
                        .used_by(&id)
                        .iter()
                        .any(|root| root.starts_with("own:"))
                {
                    let download_root =
                        ensure_directory(Path::new(&self.store.settings.download_dir))?;
                    self.relocate_transfer(&id, &download_root)?;
                }
                self.change_retention(|g| g.acknowledge(job.id, &id, false))?;
                return Ok(());
            }
            let record = self.store.records.iter().find(|r| r.id == id).cloned();
            let delete_files = !matches!(
                job.target,
                lifecycle::Target::Torrent {
                    delete_files: false,
                    ..
                }
            );
            if let Some(record) = &record {
                if !valid_id(&id) || record.path.file_name().and_then(|s| s.to_str()) != Some(&id) {
                    bail!("Unsafe deletion path; files preserved")
                }
                if !self.failures.contains_key(&id) {
                    self.native.remove(&id)?;
                    self.failures.insert(id.clone(), "Cleanup pending".into());
                }
                if delete_files && record.path.exists() {
                    reject_symlinks(&record.path)?;
                    if fs::canonicalize(&record.path)? != record.path {
                        bail!("Deletion path changed; files preserved")
                    }
                    fs::remove_dir_all(&record.path).context("Cannot delete downloaded files")?;
                }
                for suffix in ["source", "resume", "info", "transfer.json", "external"] {
                    let file = storage::sidecar(record, suffix)?;
                    if file.exists() {
                        reject_symlinks(&file)?;
                        fs::remove_file(file)?;
                    }
                }
            }
            let mut next = self.store.clone();
            next.records.retain(|r| r.id != id);
            next.retention.acknowledge(job.id, &id, true)?;
            atomic(
                &self.dir.join("transfers.json"),
                &serde_json::to_vec_pretty(&next)?,
            )?;
            self.store = next;
            self.failures.remove(&id);
            if let Some(host) = &mut self.posts {
                host.manager.removed(&id);
            }
            Ok(())
        })();
        if let Err(error) = result {
            let message = format!("Cleanup pending: {error:#}");
            let _ = self.change_retention(|g| {
                g.jobs
                    .get_mut(&job.id)
                    .context("Cleanup unavailable")?
                    .error = message.clone();
                Ok(())
            });
            self.view.warning = message;
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceOrigin {
    Own {
        id: String,
    },
    Catalog {
        parent: String,
    },
    #[serde(skip)]
    Followed {
        id: String,
    },
    #[serde(skip)]
    Publication {
        id: String,
        operation: u64,
    },
}
impl Engine {
    fn relocate_transfer(&mut self, id: &str, root: &Path) -> Result<()> {
        let record = self.record(id)?.clone();
        if record.path.parent() == Some(root) {
            return Ok(());
        }
        if !self.failures.contains_key(id) {
            self.native.remove(id)?;
        }
        let moved = storage::move_record(&record, root)?;
        *self.store.records.iter_mut().find(|r| r.id == id).unwrap() = moved.clone();
        self.persist()?;
        let source = fs::read(storage::sidecar(&moved, "source")?)?;
        let transfer = AddTransfer {
            id,
            source: TorrentSource::from_bytes(&source, moved.magnet)?,
            save_path: moved.path.to_str().context("Non-UTF-8 transfer path")?,
            active: moved.active,
            restore: true,
        };
        let result = if moved.held {
            self.native.stage(transfer)
        } else {
            self.native.add(transfer)
        };
        if let Err(error) = result {
            self.failures.insert(id.into(), error.to_string());
            return Err(error.into());
        }
        self.failures.remove(id);
        Ok(())
    }

    pub(crate) fn reserve_source(
        &mut self,
        bytes: Vec<u8>,
        magnet: bool,
        origin: Option<SourceOrigin>,
        kind: &str,
        held: bool,
        publishing: bool,
    ) -> Result<String> {
        if bytes.len() > 8 * 1024 * 1024 {
            bail!("Torrent metadata exceeds 8 MiB")
        }
        let id = self
            .native
            .inspect(TorrentSource::from_bytes(&bytes, magnet)?)?;
        let root = match &origin {
            Some(SourceOrigin::Own { id: post }) => {
                let view = self
                    .publication_view
                    .as_ref()
                    .context("Publishing service unavailable")?
                    .borrow();
                if !view.posts.iter().any(|p| p.id == *post)
                    || !view.entries.get(post).is_some_and(|ids| ids.contains(&id))
                {
                    bail!("Torrent is not referenced by this post")
                }
                Some(format!("own:{post}"))
            }
            Some(SourceOrigin::Publication {
                id: post,
                operation,
            }) => {
                if self
                    .posts
                    .as_ref()
                    .is_some_and(|h| h.manager.suppressed(&id))
                {
                    bail!("Catalog is paused or removed; restore it explicitly before publishing")
                }
                let view = self
                    .publication_view
                    .as_ref()
                    .context("Publishing service unavailable")?
                    .borrow();
                if !view
                    .posts
                    .iter()
                    .any(|p| p.id == *post && p.operation == Some(*operation))
                {
                    bail!("Publication canceled or replaced")
                }
                Some(format!("own:{post}"))
            }
            Some(SourceOrigin::Followed { id: post }) => Some(format!("followed:{post}")),
            Some(SourceOrigin::Catalog { parent }) => {
                self.record(parent)?;
                if self
                    .store
                    .retention
                    .jobs
                    .values()
                    .any(|j| self.store.retention.may_delete(j.id, parent))
                {
                    bail!("Catalog is being deleted; Pin it before downloading")
                }
                self.content_reference(parent, &id)?;
                None
            }
            None => None,
        };
        let recovering = self.failures.contains_key(&id);
        if publishing && !recovering && self.store.records.iter().any(|r| r.id == id) {
            let published = ensure_directory(&storage::published(&self.dir))?;
            self.relocate_transfer(&id, &published)?;
        }
        let mut next = self.store.clone();
        next.retention.register_asset(&id)?;
        if let Some(root) = &root {
            next.retention.claim(root, &id, None)?;
        } else if let Some(SourceOrigin::Catalog { parent }) = &origin {
            next.retention.link(parent, &id)?;
        } else {
            next.retention.pin(&id)?;
        }
        let existing = next.records.iter().any(|r| r.id == id);
        let path = if existing {
            self.record(&id)?.path.clone()
        } else {
            let base = if publishing {
                ensure_directory(&storage::published(&self.dir))?
            } else {
                ensure_directory(Path::new(&next.settings.download_dir))?
            };
            let path = base.join(&id);
            if path.exists() {
                reject_symlinks(&path)?;
            }
            next.records.push(Record {
                id: id.clone(),
                magnet,
                path: path.clone(),
                active: true,
                seed: publishing || next.settings.seed_by_default,
                held,
                kind: kind.into(),
                post: root
                    .as_ref()
                    .and_then(|r| r.strip_prefix("followed:"))
                    .map(str::to_owned),
            });
            path
        };
        next.retention.validate()?;
        // The single registry reserves both ownership and the managed path before
        // payload/metadata writes or native download requests can start.
        atomic(
            &self.dir.join("transfers.json"),
            &serde_json::to_vec_pretty(&next)?,
        )?;
        self.store = next;
        if existing && !recovering {
            return Ok(id);
        }
        let result = (|| -> Result<()> {
            fs::create_dir_all(&path)?;
            reject_symlinks(&path)?;
            atomic(&storage::sidecar(self.record(&id)?, "source")?, &bytes)?;
            // A failed reservation has no native handle. Repair it with the
            // supplied source, preserving its pause and approval decisions.
            self.store
                .records
                .iter_mut()
                .find(|r| r.id == id)
                .unwrap()
                .magnet = magnet;
            storage::write_manifest(self.record(&id)?, self.store.retention.pins.contains(&id))?;
            if existing {
                if publishing {
                    let published = ensure_directory(&storage::published(&self.dir))?;
                    let moved = storage::move_record(self.record(&id)?, &published)?;
                    *self.store.records.iter_mut().find(|r| r.id == id).unwrap() = moved;
                }
                self.persist()?;
            }
            let record = self.record(&id)?.clone();
            let transfer = AddTransfer {
                id: &id,
                source: TorrentSource::from_bytes(&bytes, record.magnet)?,
                save_path: record.path.to_str().context("Non-UTF-8 transfer path")?,
                active: record.active,
                restore: existing,
            };
            if record.held {
                self.native.stage(transfer)?;
            } else {
                self.native.add(transfer)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.failures.insert(id.clone(), error.to_string());
            if let Some(record) = self.store.records.iter_mut().find(|r| r.id == id) {
                record.active = false;
            }
            self.persist()?;
            return Err(error);
        }
        self.failures.remove(&id);
        Ok(id)
    }
}

impl Engine {
    pub(super) fn record_catalog_edges(
        &mut self,
        parent: &str,
        value: &serde_json::Value,
    ) -> Result<()> {
        if !self.store.records.iter().any(|r| r.id == parent) {
            return Ok(());
        }
        let mut children = std::collections::BTreeSet::new();
        if let Some(entries) = value.get("entries").and_then(|v| v.as_array()) {
            for entry in entries {
                if let Some(id) = entry
                    .get("infohash")
                    .and_then(|v| v.as_str())
                    .filter(|s| valid_id(s))
                {
                    children.insert(id.to_owned());
                }
            }
        }
        for field in ["previous", "archive"] {
            if let Some(id) = value
                .get(field)
                .and_then(|v| v.as_str())
                .filter(|s| valid_id(s))
            {
                children.insert(id.to_owned());
            }
        }
        if children.iter().all(|c| {
            self.store
                .retention
                .edges
                .get(parent)
                .is_some_and(|e| e.contains(c))
        }) {
            return Ok(());
        }
        self.change_retention(|g| {
            for child in children {
                g.link(parent, &child)?;
            }
            Ok(())
        })
    }
    fn scan_retention_catalogs(&mut self) -> Result<()> {
        let ids: Vec<_> = self.store.records.iter().map(|r| r.id.clone()).collect();
        for id in ids {
            let mut offset = 0;
            loop {
                let Ok(value) = self.read_content(&id, None, offset) else {
                    break;
                };
                if value.get("kind").and_then(|v| v.as_str()) != Some("catalog") {
                    break;
                }
                self.record_catalog_edges(&id, &value)?;
                let count = value.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let shown = value
                    .get("entries")
                    .and_then(|v| v.as_array())
                    .map_or(0, Vec::len);
                if shown == 0 || offset.saturating_add(shown) >= count {
                    break;
                }
                offset += shown;
            }
        }
        Ok(())
    }
}
