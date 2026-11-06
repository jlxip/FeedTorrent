//! Read-only presentation of registered torrents and verified references.
//! Opening a reader never stages a torrent or changes a post/checkpoint.
use super::*;
use feedtorrent_bep::bep49::{self, Feed, FeedEntry, ItemContent};
use feedtorrent_bep::TorrentMetadataBackend;
use feedtorrent_posts::EntryView;
use serde_json::{json, Value};

fn body_file(name: &str, title: &str) -> bool {
    name == "metadata/body.md"
        || name
            .strip_prefix(title)
            .is_some_and(|s| s == "/metadata/body.md")
}

pub(super) fn preview(data: &[u8]) -> Result<Value> {
    let ItemContent::Torrent(item) = bep49::inspect_item(data) else {
        bail!("Torrent reference unavailable")
    };
    let d = LibtorrentBackend::describe_torrent(data)?;
    let error = if item.is_private() {
        "Private torrents are not supported".into()
    } else {
        d.error
    };
    let has_body = d.files.iter().any(|f| body_file(&f.name, &d.name));
    let files: Vec<_> = d.files.iter().enumerate().filter(|(_, f)| !body_file(&f.name, &d.name))
        .map(|(index,f)| json!({"index":index,"name":f.name,"length":f.length,"verified":0,"ready":false})).collect();
    Ok(
        json!({"id":d.id,"name":d.name,"total":d.total,"kind":if item.is_feed(){"catalog"}else{"torrent"},
        "files":files,"entries":[],"count":0,"offset":0,"body":null,
        "body_state":if has_body{"pending"}else{"absent"},"body_error":"","error":error}),
    )
}

impl Engine {
    fn content_entry_data(&self, catalog: &str, entry: &FeedEntry) -> Result<Vec<u8>> {
        if entry.length() > 8 * 1024 * 1024 {
            bail!("Torrent metadata exceeds 8 MiB")
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
        if file.length != entry.length() || file.verified != file.length {
            bail!("Content metadata is not downloaded and verified")
        }
        let path = self.verified_path(catalog, &file.name)?;
        let data = read_limited(&path)?;
        if data.len() as u64 != entry.length()
            || entry.check_sha1(std::io::Cursor::new(&data))? == Some(false)
        {
            bail!("Catalog item SHA-1 mismatch")
        }
        Ok(data)
    }

    pub(super) fn content_reference(&self, parent: &str, id: &str) -> Result<Value> {
        self.record(parent)?;
        let info = self
            .native
            .info_bytes(parent)?
            .context("Waiting for catalog metadata")?;
        let catalog = Feed::from_info(&info)?;
        for link in [
            catalog.fields().previous.as_ref(),
            catalog.fields().archive_next.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if feedtorrent_posts::hex(&link.infohash()) == id {
                return Ok(
                    json!({"id":id,"name":"Catalog","total":null,"kind":"catalog","files":[],"entries":[],"count":0,"offset":0,"body":null,"body_state":"metadata","body_error":"","error":"","source_uri":link.uri()}),
                );
            }
        }
        for entry in catalog.items() {
            let Ok(data) = self.content_entry_data(parent, entry) else {
                continue;
            };
            if let ItemContent::Torrent(t) = bep49::inspect_item(&data) {
                if feedtorrent_posts::hex(&t.infohash()) == id {
                    let mut value = preview(&data)?;
                    value["source_index"] = json!(entry.index());
                    value["source"] = json!(data);
                    return Ok(value);
                }
            }
        }
        bail!("Torrent is not available from this catalog")
    }

    fn content_entry(&self, id: &str, catalog: &Feed, entry: &FeedEntry) -> EntryView {
        let source = entry.path().join("/");
        let mut row = EntryView {
            index: entry.index(),
            name: source.clone(),
            source_name: source,
            length: entry.length(),
            kind: "pending".into(),
            state: "Waiting for verified metadata".into(),
            ..Default::default()
        };
        let Ok(file) = self.native.file_at(id, entry.index()) else {
            return row;
        };
        if file.verified != file.length {
            return row;
        }
        if entry.length() > 8 * 1024 * 1024 {
            row.kind = "file".into();
            row.state = "Available".into();
            return row;
        }
        let data = match self.content_entry_data(id, entry) {
            Ok(data) => data,
            Err(e) => {
                row.error = format!("{e:#}");
                row.state = "Error".into();
                return row;
            }
        };
        row.kind = "file".into();
        row.state = "Available".into();
        if let ItemContent::Torrent(item) = bep49::inspect_item(&data) {
            row.infohash = Some(feedtorrent_posts::hex(&item.infohash()));
            row.kind = if item.is_feed() { "catalog" } else { "torrent" }.into();
            match LibtorrentBackend::describe_torrent(&data) {
                Ok(d) => {
                    row.name = d.name;
                    row.total = Some(d.total);
                    row.files = d
                        .files
                        .into_iter()
                        .map(|f| feedtorrent_posts::FileDescription {
                            name: f.name,
                            length: f.length,
                        })
                        .collect();
                    row.error = d.error;
                }
                Err(e) => row.error = e.to_string(),
            }
            if item.is_private() {
                row.error = "Private torrents are not supported".into();
            }
            if !row.error.is_empty() {
                row.kind = "unsupported".into();
            }
            if let Ok(nested) = Feed::from_metainfo(&data) {
                if let Some(source) = nested.fields().source.as_ref() {
                    if catalog.fields().source.as_ref() != Some(source) {
                        row.kind = "external_post".into();
                        row.post_magnet = Some(feedtorrent_bep::bep46::format_magnet(source));
                    }
                }
            }
        }
        row
    }

    pub(super) fn read_content(
        &self,
        id: &str,
        parent: Option<&str>,
        offset: usize,
    ) -> Result<Value> {
        if !valid_id(id) || parent.is_some_and(|p| !valid_id(p)) {
            bail!("Invalid torrent identifier")
        }
        let reference = parent
            .map(|parent| self.content_reference(parent, id))
            .transpose()?;
        let mut value = if let Some(value) = reference {
            value
        } else {
            json!({"id":id,"files":[],"entries":[],"count":0,"offset":offset,"body":null,"body_state":"metadata","body_error":"","error":""})
        };
        let Some(t) = self.view.transfers.iter().find(|t| t.id == id) else {
            if parent.is_none() {
                bail!("Torrent unavailable")
            };
            return Ok(value);
        };
        self.record(id)?;
        value["name"] = json!(t.name);
        value["total"] = if t.files.is_empty() {
            Value::Null
        } else {
            json!(t.total)
        };
        let info = self.native.info_bytes(id)?;
        let catalog = info.as_deref().and_then(|info| Feed::from_info(info).ok());
        value["kind"] = json!(if catalog.is_some() {
            "catalog"
        } else {
            "torrent"
        });
        value["files"]=json!(t.files.iter().enumerate().filter(|(_,f)|!body_file(&f.name,&t.name)).map(|(index,f)|json!({"index":index,"name":f.name,"length":f.length,"verified":f.verified,"ready":f.ready})).collect::<Vec<_>>());
        if let Some(catalog) = catalog.as_ref() {
            let items: Vec<_> = catalog.items().collect();
            value["count"] = json!(items.len());
            value["offset"] = json!(offset);
            value["entries"] = json!(items
                .iter()
                .skip(offset)
                .take(100)
                .map(|entry| self.content_entry(id, catalog, entry))
                .collect::<Vec<_>>());
            value["previous"] = json!(catalog
                .fields()
                .previous
                .as_ref()
                .map(|p| feedtorrent_posts::hex(&p.infohash())));
            value["archive"] = json!(catalog
                .fields()
                .archive_next
                .as_ref()
                .map(|p| feedtorrent_posts::hex(&p.infohash())));
        }
        let bodies: Vec<_> = t
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| body_file(&f.name, &t.name))
            .collect();
        value["body_state"] = json!(if info.is_none() {
            "metadata"
        } else if bodies.is_empty() {
            "absent"
        } else {
            "pending"
        });
        if bodies.len() > 1 {
            value["body_state"] = json!("error");
            value["body_error"] = json!("Torrent contains multiple Markdown bodies");
        } else if let Some((index, file)) = bodies.first() {
            if file.length > feedtorrent_posts::publishing::MAX_BODY as u64 {
                value["body_state"] = json!("error");
                value["body_error"] = json!("Markdown exceeds 1 MiB");
            } else if file.ready && t.state != "Checking" && t.error.is_empty() {
                let native = self.native.file_at(id, *index)?;
                if native.verified == native.length {
                    value["body_path"] = json!(self.verified_path(id, &native.name)?);
                    value["body_state"] = json!("ready");
                }
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::body_file;

    #[test]
    fn body_is_only_the_exact_metadata_convention() {
        assert!(body_file("metadata/body.md", "Archive"));
        assert!(body_file("Archive/metadata/body.md", "Archive"));
        for path in [
            "body.md",
            "Archive/body.md",
            "Other/metadata/body.md",
            "Archive/metadata/BODY.md",
            "Archive/metadata/body.md.txt",
            "ArchiveX/metadata/body.md",
        ] {
            assert!(!body_file(path, "Archive"), "{path}");
        }
    }
}
