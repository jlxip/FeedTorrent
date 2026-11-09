//! Local navigation metadata. Never encoded into torrents or publishing backups.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub key: String,
    pub parent: Option<String>,
    pub archived: bool,
    restore_parent: Option<String>,
}
#[derive(Clone, Default, Debug, Serialize)]
pub struct View {
    pub revision: String,
    pub nodes: Vec<Node>,
    pub error: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Organization {
    version: u32,
    revision: u64,
    nodes: Vec<Node>,
    stamps: BTreeMap<String, String>,
}
impl Default for Organization {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            nodes: vec![],
            stamps: BTreeMap::new(),
        }
    }
}
pub struct Input {
    pub key: String,
    pub stamp: String,
    pub changed_at: u64,
}
impl Organization {
    pub fn load(dir: &Path) -> Result<Self> {
        Ok(crate::post_state::load(dir)?.organization)
    }
    pub fn view(&self, error: String) -> View {
        View {
            revision: self.revision.to_string(),
            nodes: self.nodes.clone(),
            error,
        }
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if self.version != 1 || self.nodes.len() > 1024 {
            bail!("Invalid post organization");
        }
        let keys: BTreeSet<_> = self.nodes.iter().map(|n| n.key.as_str()).collect();
        if keys.len() != self.nodes.len() {
            bail!("Duplicate navigation entry");
        }
        for n in &self.nodes {
            let (kind, id) = n.key.split_once(':').context("Invalid post key")?;
            if !matches!(kind, "own" | "followed") || !valid_id(id) {
                bail!("Invalid post key");
            }
            let mut parent = n.parent.as_deref();
            let mut seen = BTreeSet::from([n.key.as_str()]);
            while let Some(key) = parent {
                if !seen.insert(key) || seen.len() > 64 {
                    bail!("Post cycle or nesting beyond 64 levels");
                }
                let p = self
                    .nodes
                    .iter()
                    .find(|p| p.key == key)
                    .context("Unknown parent")?;
                if p.archived != n.archived {
                    bail!("Parent belongs to another archive");
                }
                parent = p.parent.as_deref();
            }
        }
        Ok(())
    }
    fn commit(&mut self, dir: &Path, mut next: Self) -> Result<()> {
        next.revision = self
            .revision
            .checked_add(1)
            .context("Organization revision exhausted")?;
        next.validate()?;
        let mut state = crate::post_state::load(dir)?;
        state.organization = next.clone();
        state.save(dir)?;
        *self = next;
        Ok(())
    }
    fn first(&mut self, key: &str) {
        let index = self.nodes.iter().position(|n| n.key == key).unwrap();
        let node = self.nodes.remove(index);
        let index = self
            .nodes
            .iter()
            .position(|n| n.parent == node.parent && n.archived == node.archived)
            .unwrap_or(self.nodes.len());
        self.nodes.insert(index, node);
    }
    fn remove(&mut self, key: &str) {
        let i = self.nodes.iter().position(|n| n.key == key).unwrap();
        let old = self.nodes[i].clone();
        let before = self.nodes[i + 1..]
            .iter()
            .find(|n| n.parent == old.parent && n.archived == old.archived)
            .map(|n| n.key.clone());
        self.nodes.remove(i);
        let children: Vec<_> = self
            .nodes
            .iter()
            .filter(|n| n.parent.as_deref() == Some(key))
            .cloned()
            .collect();
        self.nodes.retain(|n| n.parent.as_deref() != Some(key));
        let index = before
            .and_then(|key| self.nodes.iter().position(|n| n.key == key))
            .unwrap_or(self.nodes.len());
        for (offset, mut n) in children.into_iter().enumerate() {
            n.parent = old.parent.clone();
            self.nodes.insert(index + offset, n);
        }
        self.stamps.remove(key);
    }
    pub fn sync(&mut self, dir: &Path, input: Vec<Input>) -> Result<()> {
        let mut next = self.clone();
        let initial = self.revision == 0;
        let missing: Vec<_> = next
            .nodes
            .iter()
            .filter(|n| !input.iter().any(|i| i.key == n.key))
            .map(|n| n.key.clone())
            .collect();
        for key in missing {
            next.remove(&key);
        }
        let mut changed = Vec::new();
        for i in input {
            if !next.nodes.iter().any(|n| n.key == i.key) {
                next.nodes.push(Node {
                    key: i.key.clone(),
                    parent: None,
                    archived: false,
                    restore_parent: None,
                });
                if !initial {
                    changed.push((i.changed_at, i.key.clone()));
                }
            } else if !i.stamp.is_empty() && next.stamps.get(&i.key) != Some(&i.stamp) {
                changed.push((i.changed_at, i.key.clone()));
            }
            // A transient unresolved head must not erase the last observed version.
            if !i.stamp.is_empty() {
                next.stamps.insert(i.key, i.stamp);
            }
        }
        changed.sort();
        for (_, key) in changed {
            next.first(&key);
        }
        if next.nodes != self.nodes || next.stamps != self.stamps || initial {
            self.commit(dir, next)?;
        }
        Ok(())
    }
    fn branch(&self, key: &str) -> BTreeSet<String> {
        let mut keys = BTreeSet::from([key.to_string()]);
        loop {
            let old = keys.len();
            for n in &self.nodes {
                if n.parent.as_ref().is_some_and(|p| keys.contains(p)) {
                    keys.insert(n.key.clone());
                }
            }
            if old == keys.len() {
                return keys;
            }
        }
    }
    pub fn change(
        &mut self,
        dir: &Path,
        revision: &str,
        key: &str,
        action: &str,
        parent: Option<String>,
        before: Option<String>,
    ) -> Result<()> {
        if revision != self.revision.to_string() {
            bail!("Post organization changed in another tab; try again");
        }
        let mut next = self.clone();
        let i = next
            .nodes
            .iter()
            .position(|n| n.key == key)
            .context("Post no longer exists")?;
        let branch = next.branch(key);
        match action {
            "move" => {
                if parent.as_ref().is_some_and(|p| branch.contains(p)) {
                    bail!("Cannot move a post inside itself");
                }
                if let Some(p) = &parent {
                    let p = next
                        .nodes
                        .iter()
                        .find(|n| &n.key == p)
                        .context("Unknown parent")?;
                    if p.archived != next.nodes[i].archived {
                        bail!("Use Archive or Restore to change archive");
                    }
                }
                let mut node = next.nodes.remove(i);
                node.parent = parent;
                let index = if let Some(key) = before {
                    next.nodes
                        .iter()
                        .position(|n| {
                            n.key == key && n.parent == node.parent && n.archived == node.archived
                        })
                        .context("Destination changed; try again")?
                } else {
                    next.nodes.len()
                };
                next.nodes.insert(index, node);
            }
            "archive" => {
                if next.nodes[i].archived {
                    bail!("Post is already archived");
                }
                next.nodes[i].restore_parent = next.nodes[i].parent.take();
                for n in &mut next.nodes {
                    if branch.contains(&n.key) {
                        n.archived = true;
                    }
                }
                next.first(key);
            }
            "restore" => {
                if !next.nodes[i].archived {
                    bail!("Post is not archived");
                }
                let target = next.nodes[i]
                    .restore_parent
                    .take()
                    .or_else(|| next.nodes[i].parent.clone());
                next.nodes[i].parent =
                    target.filter(|p| next.nodes.iter().any(|n| &n.key == p && !n.archived));
                for n in &mut next.nodes {
                    if branch.contains(&n.key) {
                        n.archived = false;
                    }
                }
                next.first(key);
            }
            _ => bail!("Unknown organization action"),
        }
        self.commit(dir, next)
    }
}

pub fn now_us() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u64::MAX as u128 - 1) as u64;
    let previous = LAST
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |old| {
            Some(now.max(old.saturating_add(1)))
        })
        .unwrap();
    now.max(previous.saturating_add(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "post-organization-{}-{}",
                std::process::id(),
                now_us()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn key(n: u64) -> String {
        format!(
            "{}:{n:040x}",
            if n.is_multiple_of(2) {
                "own"
            } else {
                "followed"
            }
        )
    }
    fn input(n: u64, stamp: u64) -> Input {
        Input {
            key: key(n),
            stamp: stamp.to_string(),
            changed_at: stamp,
        }
    }
    fn sync(o: &mut Organization, p: &Path, values: &[(u64, u64)]) {
        o.sync(p, values.iter().map(|&(n, s)| input(n, s)).collect())
            .unwrap();
    }
    fn change(
        o: &mut Organization,
        p: &Path,
        n: u64,
        action: &str,
        parent: Option<u64>,
        before: Option<u64>,
    ) -> Result<()> {
        o.change(
            p,
            &o.revision.to_string(),
            &key(n),
            action,
            parent.map(key),
            before.map(key),
        )
    }
    fn siblings(o: &Organization, parent: Option<u64>, archived: bool) -> Vec<String> {
        o.nodes
            .iter()
            .filter(|n| n.parent == parent.map(key) && n.archived == archived)
            .map(|n| n.key.clone())
            .collect()
    }
    #[test]
    fn migration_manual_order_activity_and_restart() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::load(p).unwrap();
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1)]);
        assert_eq!(siblings(&o, None, false), vec![key(1), key(2), key(3)]);
        change(&mut o, p, 3, "move", None, Some(1)).unwrap();
        let revision = o.revision;
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1)]);
        assert_eq!(o.revision, revision);
        assert_eq!(siblings(&o, None, false), vec![key(3), key(1), key(2)]);
        sync(&mut o, p, &[(1, 1), (2, 2), (3, 1)]);
        assert_eq!(siblings(&o, None, false), vec![key(2), key(3), key(1)]);
        let restored = Organization::load(p).unwrap();
        assert_eq!(restored.nodes, o.nodes);
        assert_eq!(restored.revision, o.revision);
        sync(&mut o, p, &[(1, 1), (2, 2), (3, 1), (4, 3)]);
        assert_eq!(siblings(&o, None, false)[0], key(4));
    }
    #[test]
    fn child_activity_does_not_bump_ancestors_and_rejects_cycles() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::default();
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1), (4, 1)]);
        change(&mut o, p, 3, "move", Some(2), None).unwrap();
        change(&mut o, p, 4, "move", Some(2), Some(3)).unwrap();
        let roots = siblings(&o, None, false);
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 2), (4, 1)]);
        assert_eq!(siblings(&o, Some(2), false), vec![key(3), key(4)]);
        assert_eq!(siblings(&o, None, false), roots);
        assert!(change(&mut o, p, 2, "move", Some(3), None).is_err());
        assert!(change(&mut o, p, 2, "move", Some(2), None).is_err());
        assert!(change(&mut o, p, 2, "move", Some(999), None).is_err());
    }
    #[test]
    fn archive_activity_restore_and_parent_removal() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::default();
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1), (4, 1)]);
        change(&mut o, p, 2, "move", Some(1), None).unwrap();
        change(&mut o, p, 3, "move", Some(2), None).unwrap();
        change(&mut o, p, 2, "archive", None, None).unwrap();
        assert!(o.nodes.iter().find(|n| n.key == key(3)).unwrap().archived);
        sync(&mut o, p, &[(1, 1), (2, 2), (3, 2), (4, 1)]);
        assert_eq!(siblings(&o, None, true), vec![key(2)]);
        change(&mut o, p, 2, "restore", None, None).unwrap();
        assert_eq!(siblings(&o, Some(1), false), vec![key(2)]);
        change(&mut o, p, 2, "archive", None, None).unwrap();
        change(&mut o, p, 1, "archive", None, None).unwrap();
        change(&mut o, p, 2, "restore", None, None).unwrap();
        assert_eq!(siblings(&o, None, false)[0], key(2));
        sync(&mut o, p, &[(1, 1), (3, 2), (4, 1)]);
        assert!(o
            .nodes
            .iter()
            .find(|n| n.key == key(3))
            .unwrap()
            .parent
            .is_none());
        assert!(!o.nodes.iter().find(|n| n.key == key(3)).unwrap().archived);
    }
    #[test]
    fn promotion_preserves_order_and_optimistic_conflicts_are_atomic() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::default();
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1), (4, 1)]);
        change(&mut o, p, 2, "move", Some(1), None).unwrap();
        change(&mut o, p, 3, "move", Some(1), None).unwrap();
        let stale = o.revision.to_string();
        change(&mut o, p, 4, "move", None, Some(1)).unwrap();
        let before = o.nodes.clone();
        assert!(o.change(p, &stale, &key(1), "archive", None, None).is_err());
        assert_eq!(o.nodes, before);
        sync(&mut o, p, &[(2, 1), (3, 1), (4, 1)]);
        assert_eq!(siblings(&o, None, false), vec![key(4), key(2), key(3)]);
        let bad = p.join("file");
        fs::write(&bad, b"blocked").unwrap();
        let revision = o.revision;
        assert!(change(&mut o, &bad, 3, "archive", None, None).is_err());
        assert_eq!(o.revision, revision);
    }
    #[test]
    fn promotion_keeps_the_parent_slot_after_moving_whole_branches() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::default();
        sync(&mut o, p, &[(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)]);
        change(&mut o, p, 3, "move", Some(1), None).unwrap();
        change(&mut o, p, 5, "move", Some(1), None).unwrap();
        change(&mut o, p, 1, "move", None, None).unwrap();
        change(&mut o, p, 4, "move", None, None).unwrap();
        assert_eq!(siblings(&o, None, false), vec![key(2), key(1), key(4)]);
        sync(&mut o, p, &[(2, 1), (3, 1), (4, 1), (5, 1)]);
        assert_eq!(
            siblings(&o, None, false),
            vec![key(2), key(3), key(5), key(4)]
        );
    }
    #[test]
    fn depth_limit_and_corrupt_state_are_rejected() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization {
            nodes: (1..=65)
                .map(|n| Node {
                    key: key(n),
                    parent: if n == 1 { None } else { Some(key(n - 1)) },
                    archived: false,
                    restore_parent: None,
                })
                .collect(),
            ..Organization::default()
        };
        assert!(o.validate().is_err());
        o.nodes.pop();
        o.validate().unwrap();
        fs::write(p.join("posts.json"), b"broken").unwrap();
        assert!(Organization::load(p).is_err());
        assert_eq!(fs::read(p.join("posts.json")).unwrap(), b"broken");
    }
    #[test]
    fn transient_unresolved_versions_and_mixed_identical_identities() {
        let t = Temp::new();
        let p = &t.0;
        let mut o = Organization::default();
        let id = format!("{:040x}", 1);
        o.sync(
            p,
            vec![
                input(1, 1),
                Input {
                    key: format!("own:{id}"),
                    stamp: "1".into(),
                    changed_at: 1,
                },
            ],
        )
        .unwrap();
        assert_eq!(o.nodes.len(), 2);
        let rev = o.revision;
        o.sync(
            p,
            vec![
                Input {
                    key: key(1),
                    stamp: String::new(),
                    changed_at: 2,
                },
                Input {
                    key: format!("own:{id}"),
                    stamp: "1".into(),
                    changed_at: 1,
                },
            ],
        )
        .unwrap();
        assert_eq!(o.revision, rev);
    }
}
