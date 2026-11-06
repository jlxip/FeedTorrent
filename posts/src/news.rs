use super::*;

impl PostManager {
    pub(super) fn initialize_news(&mut self, legacy: bool) -> Result<()> {
        if legacy {
            self.state.news = NewsState::default();
            // Existing history is a baseline, not a stream of new posts.
            for (id, s) in self.state.posts.clone() {
                if let Some(r) = s.records.last() {
                    self.state.news.observed.insert(id.clone(), r.sequence);
                    if s.followed {
                        if let Ok(h) =
                            bep46::decode_payload(r.verify(&identity(&s.magnet)?)?.value())
                        {
                            self.push_news(&id, r.sequence, hex(&h), None)?;
                        }
                    }
                }
            }
            self.state.version = 2;
            self.dirty = true;
        }
        let mut last = 0;
        let mut identities = std::collections::BTreeSet::new();
        for n in &self.state.news.entries {
            let s = self
                .state
                .posts
                .get(&n.post)
                .ok_or_else(|| err("Unknown news post"))?;
            let record = s
                .records
                .iter()
                .find(|r| r.sequence == n.sequence)
                .ok_or_else(|| err("News entry has no signed record"))?;
            let h = bep46::decode_payload(record.verify(&identity(&s.magnet)?)?.value())
                .map_err(err)?;
            if hex(&h) != n.catalog
                || n.order <= last
                || n.order > self.state.news.next_order
                || !identities.insert((n.post.clone(), n.sequence))
            {
                return Err(err("Invalid news identity or order"));
            }
            last = n.order;
            if self
                .state
                .news
                .observed
                .get(&n.post)
                .is_none_or(|s| *s < n.sequence)
            {
                return Err(err("News entry exceeds its observed sequence"));
            }
        }
        for (id, seq) in &self.state.news.observed {
            if !self
                .state
                .posts
                .get(id)
                .is_some_and(|s| s.records.iter().any(|r| r.sequence == *seq))
            {
                return Err(err("Invalid news baseline"));
            }
        }
        Ok(())
    }
    fn push_news(
        &mut self,
        post: &str,
        sequence: i64,
        catalog: String,
        detected_ms: Option<u64>,
    ) -> Result<()> {
        self.state.news.next_order = self
            .state
            .news
            .next_order
            .checked_add(1)
            .ok_or_else(|| err("News order exhausted"))?;
        self.state.news.entries.push(NewsRecord {
            post: post.into(),
            sequence,
            catalog,
            detected_ms,
            order: self.state.news.next_order,
            read: false,
        });
        self.news_changed();
        Ok(())
    }
    fn news_changed(&mut self) {
        self.state.news.revision = self.state.news.revision.wrapping_add(1);
        self.dirty = true;
    }
    /// Reconcile authoritative signed history, never the bounded event queue.
    /// The host supplies civil time, separately from the network's monotonic time.
    pub fn observe_news(&mut self, wall_ms: u64) -> Result<()> {
        for n in &mut self.state.news.entries {
            if n.detected_ms.is_none() {
                n.detected_ms = Some(wall_ms);
                self.dirty = true;
            }
        }
        for (id, s) in self.state.posts.clone() {
            if !s.followed {
                continue;
            }
            let key = identity(&s.magnet)?;
            let baseline = self.state.news.observed.get(&id).copied();
            let mut previous = s
                .records
                .iter()
                .rev()
                .filter(|r| baseline.is_some_and(|b| r.sequence <= b))
                .find_map(|r| bep46::decode_payload(r.verify(&key).ok()?.value()).ok())
                .map(|h| hex(&h));
            for r in s
                .records
                .iter()
                .filter(|r| baseline.is_none_or(|b| r.sequence > b))
            {
                if let Ok(h) = bep46::decode_payload(r.verify(&key)?.value()) {
                    let catalog = hex(&h);
                    if previous.as_ref() != Some(&catalog) {
                        self.push_news(&id, r.sequence, catalog.clone(), Some(wall_ms))?;
                    }
                    previous = Some(catalog);
                }
                self.state.news.observed.insert(id.clone(), r.sequence);
                self.dirty = true;
            }
            // A formerly unfollowed legacy subscription has no initial entry.
            if !self.state.news.entries.iter().any(|n| n.post == id) {
                if let Some(r) = s.records.last() {
                    if let Ok(h) = bep46::decode_payload(r.verify(&key)?.value()) {
                        self.push_news(&id, r.sequence, hex(&h), Some(wall_ms))?;
                    }
                }
            }
        }
        Ok(())
    }
    pub fn news_revision(&self) -> String {
        self.state.news.revision.to_string()
    }
    pub fn news_unread(&self) -> usize {
        self.state
            .news
            .entries
            .iter()
            .filter(|n| !n.read && self.followed(&n.post))
            .count()
    }
    /// An anchor freezes membership while paging; later posts stay outside it.
    pub fn news_page(&self, offset: usize, anchor: Option<&str>) -> Result<NewsPage> {
        let anchor = match anchor {
            Some(a) => a.parse::<u64>().map_err(|_| err("Invalid news anchor"))?,
            None => self.state.news.next_order,
        };
        let rows: Vec<_> = self
            .state
            .news
            .entries
            .iter()
            .rev()
            .filter(|n| n.order <= anchor && self.followed(&n.post))
            .collect();
        let posts = self.views();
        let entries = rows
            .iter()
            .skip(offset)
            .take(100)
            .map(|n| {
                let f = posts.iter().find(|f| f.id == n.post).unwrap();
                let c = f.catalogs.iter().find(|c| c.id == n.catalog);
                NewsEntry {
                    post: n.post.clone(),
                    sequence: n.sequence.to_string(),
                    catalog: n.catalog.clone(),
                    post_name: f.name.clone(),
                    name: c
                        .map(|c| c.name.clone())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| f.name.clone()),
                    detected_ms: n.detected_ms,
                    read: n.read,
                    ready: c.is_some_and(|c| c.ready),
                    state: c
                        .map(|c| c.state.clone())
                        .unwrap_or_else(|| "Waiting for metadata".into()),
                    error: c.map(|c| c.error.clone()).unwrap_or_default(),
                }
            })
            .collect();
        Ok(NewsPage {
            entries,
            offset,
            total: rows.len(),
            anchor: anchor.to_string(),
        })
    }
    /// Mutates local state only. The host must persist before confirming success.
    pub fn set_news_read(&mut self, post: &str, sequence: &str, read: bool) -> Result<bool> {
        if !self.followed(post) {
            return Err(err("Post not followed"));
        }
        let seq = sequence
            .parse::<i64>()
            .map_err(|_| err("Invalid news sequence"))?;
        let n = self
            .state
            .news
            .entries
            .iter_mut()
            .find(|n| n.post == post && n.sequence == seq)
            .ok_or_else(|| err("News entry not found"))?;
        let old = n.read;
        if old != read {
            n.read = read;
            self.news_changed();
        }
        Ok(old)
    }
    pub fn news_for_catalog(
        &self,
        post: &str,
        catalog: &str,
        sequence: Option<&str>,
    ) -> Option<String> {
        // A new signature for unchanged content belongs to its existing entry.
        self.state
            .news
            .entries
            .iter()
            .rev()
            .find(|n| {
                n.post == post
                    && n.catalog == catalog
                    && sequence.is_none_or(|s| n.sequence.to_string() == s)
            })
            .map(|n| n.sequence.to_string())
    }
}
