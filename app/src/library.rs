//! Derived Library presentation. Never changes ownership, pins or transfers.
use super::*;
use feedtorrent_bep::{bep49::Feed, TorrentMetadataBackend};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize)]
pub(super) struct LibraryPost {
    pub post_kind: String,
    pub id: String,
    pub name: String,
    pub representative: Option<String>,
    pub catalog_ids: Vec<String>,
    pub state: String,
    pub error: String,
}

pub(super) fn project(view: &Snapshot) -> Vec<LibraryPost> {
    let local: BTreeSet<_> = view.transfers.iter().map(|t| t.id.as_str()).collect();
    let mut result = Vec::new();
    for p in &view.publishing.posts {
        // Publishing retention contains built catalogs only; entry torrents live
        // in the separate entries map. Never group the graph's transitive closure.
        let catalog_ids: Vec<_> = view
            .publishing
            .retention
            .get(&p.id)
            .into_iter()
            .flatten()
            .filter(|id| local.contains(id.as_str()))
            .cloned()
            .collect();
        if !catalog_ids.is_empty() {
            result.push(LibraryPost {
                post_kind: "own".into(),
                id: p.id.clone(),
                name: p.title.clone(),
                representative: view
                    .publishing
                    .published_roots
                    .get(&p.id)
                    .cloned()
                    .flatten(),
                catalog_ids,
                state: p.state.clone(),
                error: p.error.clone(),
            });
        }
    }
    for p in &view.posts {
        let catalog_ids: Vec<_> = p
            .catalogs
            .iter()
            .filter(|c| {
                c.confirmed_catalog && c.foreign_post.is_none() && local.contains(c.id.as_str())
            })
            .map(|c| c.id.clone())
            .collect();
        if !catalog_ids.is_empty() {
            result.push(LibraryPost {
                post_kind: "followed".into(),
                id: p.id.clone(),
                name: p.name.clone(),
                representative: p.available.clone().or_else(|| p.head.clone()).filter(|id| {
                    p.catalogs
                        .iter()
                        .any(|c| c.id == *id && c.confirmed_catalog && c.foreign_post.is_none())
                }),
                catalog_ids,
                state: p.state.clone(),
                error: p.error.clone(),
            });
        }
    }
    result
}

impl Engine {
    pub(super) fn read_post_history(&self, kind: &str, id: &str) -> Result<serde_json::Value> {
        if !valid_id(id) {
            bail!("Invalid post identifier")
        }
        let mut stack = Vec::new();
        let allowed: BTreeSet<String>;
        let followed = if kind == "followed" {
            Some(
                self.view
                    .posts
                    .iter()
                    .find(|p| p.id == id)
                    .context("Post unavailable")?,
            )
        } else {
            None
        };
        match kind {
            "own" => {
                if !self.view.publishing.posts.iter().any(|p| p.id == id) {
                    bail!("Post unavailable")
                }
                allowed = self
                    .view
                    .publishing
                    .retention
                    .get(id)
                    .cloned()
                    .unwrap_or_default();
                if let Some(root) = self
                    .view
                    .publishing
                    .published_roots
                    .get(id)
                    .cloned()
                    .flatten()
                {
                    stack.push((root, false));
                }
            }
            "followed" => {
                let p = followed.context("Post unavailable")?;
                allowed = p
                    .catalogs
                    .iter()
                    .filter(|c| c.confirmed_catalog && c.foreign_post.is_none())
                    .map(|c| c.id.clone())
                    .collect();
                if let Some(root) = &p.available {
                    stack.push((root.clone(), false));
                }
                if let Some(root) = &p.head {
                    stack.push((root.clone(), false));
                }
            }
            _ => bail!("Invalid post kind"),
        }
        let mut seen = BTreeSet::new();
        let mut versions = Vec::new();
        while let Some((hash, archive_hint)) = stack.pop() {
            if !allowed.contains(&hash) || !seen.insert(hash.clone()) {
                continue;
            }
            // Only root lineage, never every historical page. These calls happen
            // on demand in History, not during snapshot generation.
            let catalog = self
                .native
                .info_bytes(&hash)
                .ok()
                .flatten()
                .and_then(|info| Feed::from_info(&info).ok());
            let archive = archive_hint || catalog.as_ref().is_some_and(|c| c.fields().archive);
            let links = catalog
                .as_ref()
                .map(|c| {
                    (
                        c.fields()
                            .previous
                            .as_ref()
                            .map(|p| feedtorrent_posts::hex(&p.infohash())),
                        c.fields()
                            .archive_next
                            .as_ref()
                            .map(|p| feedtorrent_posts::hex(&p.infohash())),
                    )
                })
                .or_else(|| {
                    followed
                        .and_then(|p| p.catalogs.iter().find(|c| c.id == hash))
                        .map(|c| (c.previous.clone(), c.archive.clone()))
                });
            if let Some((previous, next)) = links {
                if let Some(h) = next {
                    stack.push((h, true));
                }
                if let Some(h) = previous {
                    stack.push((h, false));
                }
            }
            if archive {
                let mut offset = 0;
                while let Ok(page) = self.read_content(&hash, None, offset) {
                    let Some(entries) = page["entries"].as_array() else {
                        break;
                    };
                    for entry in entries.iter().rev().filter(|e| e["kind"] == "catalog") {
                        if let Some(h) = entry["infohash"].as_str() {
                            stack.push((h.to_owned(), false));
                        }
                    }
                    offset += entries.len();
                    if entries.is_empty() || offset >= page["count"].as_u64().unwrap_or(0) as usize
                    {
                        break;
                    }
                }
                continue;
            }
            if let Some(t) = self.view.transfers.iter().find(|t| t.id == hash) {
                let dates = self.catalog_dates(&hash);
                versions.push(serde_json::json!({"id":hash,"name":t.name,"total":t.total,
                    "created_at":dates.as_ref().and_then(|d| d.created_at),"updated_at":dates.map(|d| d.updated_at),
                    "state":t.state,"error":t.error,"ready":t.progress>=1.0 && t.error.is_empty() && t.state!="Checking", "pinned":t.pinned}));
            }
        }
        Ok(serde_json::json!({"post_kind":kind,"id":id,"versions":versions}))
    }
}
