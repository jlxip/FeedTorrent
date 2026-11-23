//! Latest-only traversal and durable generation membership, independent of host I/O.
use super::*;
impl PostManager {
    pub(super) fn validate_latest(&self) -> Result<()> {
        for (post, latest) in &self.state.latest {
            if !self.state.posts.contains_key(post) {
                return Err(err("Latest mirror has unknown post"));
            }
            for id in latest
                .candidate
                .iter()
                .chain(latest.complete.iter())
                .chain(&latest.candidate_assets)
                .chain(&latest.retained)
            {
                hash(id)?;
            }
            if latest
                .complete
                .as_ref()
                .is_some_and(|h| !latest.retained.contains(h))
            {
                return Err(err("Latest mirror is missing its complete catalog"));
            }
        }
        for (post, ids) in &self.state.manual_downloads {
            if !self.state.posts.contains_key(post) {
                return Err(err("Manual reference has unknown post"));
            }
            for id in ids {
                hash(id)?;
            }
        }
        for (post, items) in &self.state.resolved_manual {
            let s = self
                .state
                .posts
                .get(post)
                .ok_or_else(|| err("Manual reference has unknown post"))?;
            if !items.is_subset(&s.manual_items) {
                return Err(err("Manual reference is not a requested item"));
            }
        }
        Ok(())
    }
    /// Only item edges from the signed current head. Never follows history links.
    pub(super) fn latest_assets(&self, post: &str) -> (BTreeSet<String>, bool) {
        let Some(head) = self.runtime.get(post).and_then(|r| r.head.as_ref()) else {
            return (BTreeSet::new(), false);
        };
        let mut assets = BTreeSet::new();
        let mut catalogs = BTreeSet::new();
        let mut todo = vec![head.clone()];
        let mut complete = true;
        while let Some(id) = todo.pop() {
            if !catalogs.insert(id.clone()) {
                continue;
            }
            assets.insert(id.clone());
            let Some(v) = self.visits.get(&(post.into(), id.clone())) else {
                complete = false;
                continue;
            };
            if !v.trusted
                || v.foreign.is_some()
                || !v.ready
                || !v.error.is_empty()
                || self.state.suppressed.contains(&id)
                || matches!(
                    v.state.as_str(),
                    "Paused" | "Paused or removed" | "Error" | "Awaiting approval"
                )
            {
                complete = false;
            }
            let Some(meta) = &v.meta else {
                complete = false;
                continue;
            };
            for item in meta.items() {
                let Some(row) = v.entries.get(&item.index()) else {
                    complete = false;
                    continue;
                };
                if v.reads.get(&item.index()) != Some(&true) || !row.error.is_empty() {
                    complete = false;
                }
                match row.kind.as_str() {
                    "catalog" => {
                        if let Some(child) = &row.infohash {
                            todo.push(child.clone());
                        } else {
                            complete = false;
                        }
                    }
                    "torrent" => {
                        if let Some(child) = &row.infohash {
                            assets.insert(child.clone());
                            if self.state.suppressed.contains(child)
                                || !self.transfer_states.get(child).is_some_and(|(s, ready)| {
                                    *ready
                                        && !matches!(
                                            s.as_str(),
                                            "Paused" | "Error" | "Awaiting approval"
                                        )
                                })
                            {
                                complete = false;
                            }
                        } else {
                            complete = false;
                        }
                    }
                    "file" | "external_post" => {}
                    _ => complete = false,
                }
            }
        }
        (assets, complete)
    }
    /// Old checkpoints know manual item indices but not their resolved hashes.
    /// Inspect only their authenticated ancestor path, without mirroring its siblings.
    pub(super) fn manual_path_needed(&self, post: &str, id: &str) -> bool {
        let s = &self.state.posts[post];
        for item in &s.manual_items {
            if self.manual_resolved(post, item) {
                continue;
            }
            let mut parent = item.0.clone();
            let mut seen = BTreeSet::new();
            while seen.insert(parent.clone()) {
                if parent == id {
                    return true;
                }
                match self
                    .state
                    .references
                    .get(post)
                    .and_then(|r| r.get(&parent))
                    .map(|r| &r.origin)
                {
                    Some(Origin::Item(next, _)) => parent = next.clone(),
                    _ => break,
                }
            }
        }
        false
    }
    pub(super) fn manual_resolved(&self, post: &str, item: &(String, usize)) -> bool {
        self.state
            .resolved_manual
            .get(post)
            .is_some_and(|items| items.contains(item))
    }
    fn manual_assets(&self, post: &str) -> (BTreeSet<String>, bool) {
        let s = &self.state.posts[post];
        let mut ids = self
            .state
            .manual_downloads
            .get(post)
            .cloned()
            .unwrap_or_default();
        ids.extend(s.manual_catalogs.iter().cloned());
        let mut resolved = true;
        for (parent, index) in &s.manual_items {
            match self
                .visits
                .get(&(post.into(), parent.clone()))
                .and_then(|v| v.entries.get(index))
                .and_then(|e| e.infohash.as_ref())
            {
                Some(id) => {
                    ids.insert(id.clone());
                }
                None if self.manual_resolved(post, &(parent.clone(), *index)) => {}
                None => resolved = false,
            }
        }
        (ids, resolved)
    }
    pub(super) fn content_wanted(&self, post: &str, id: &str) -> bool {
        match self.state.posts[post].config.mode {
            Mode::LatestRecursiveMirror => {
                self.latest_assets(post).0.contains(id)
                    || self
                        .state
                        .manual_downloads
                        .get(post)
                        .is_some_and(|ids| ids.contains(id))
            }
            Mode::MirrorAll => true,
            _ => self.state.approvals.contains(id),
        }
    }
    pub(super) fn update_latest(&mut self) {
        let before = self.state.latest.len();
        self.state.latest.retain(|post, _| {
            self.state
                .posts
                .get(post)
                .is_some_and(|s| s.followed && s.config.mode == Mode::LatestRecursiveMirror)
        });
        if before != self.state.latest.len() {
            self.dirty = true;
        }
        let posts: Vec<_> = self
            .state
            .posts
            .iter()
            .filter(|(_, s)| s.followed && s.config.mode == Mode::LatestRecursiveMirror)
            .map(|(id, _)| id.clone())
            .collect();
        for post in posts {
            let head = self.runtime.get(&post).and_then(|r| r.head.clone());
            let (assets, complete) = self.latest_assets(&post);
            let (_, manual_ready) = self.manual_assets(&post);
            let latest = self.state.latest.entry(post).or_default();
            let before = latest.clone();
            latest.candidate = head.clone();
            latest.candidate_assets.extend(assets.iter().cloned());
            if complete && manual_ready {
                latest.complete = head;
                latest.retained = assets.clone();
                latest.candidate_assets = assets;
            }
            if *latest != before {
                self.dirty = true;
            }
        }
    }
    /// Collection requires the checkpoint barrier and fresh whole-generation validation.
    pub fn latest_retention(&self) -> Vec<LatestRetention> {
        self.state
            .posts
            .iter()
            .filter(|(_, s)| s.followed && s.config.mode == Mode::LatestRecursiveMirror)
            .map(|(post, _)| {
                let (mut assets, complete) = self.latest_assets(post);
                let (manual, resolved) = self.manual_assets(post);
                let latest = self.state.latest.get(post);
                if let Some(latest) = latest {
                    assets.extend(latest.retained.iter().cloned());
                    assets.extend(latest.candidate_assets.iter().cloned());
                }
                let head = self.runtime.get(post).and_then(|r| r.head.as_ref());
                LatestRetention {
                    post: post.clone(),
                    assets,
                    manual,
                    collect: !self.dirty
                        && complete
                        && resolved
                        && head.is_some()
                        && latest.is_some_and(|l| l.complete.as_ref() == head),
                }
            })
            .collect()
    }
}
