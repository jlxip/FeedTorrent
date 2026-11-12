//! Local reading preferences and authenticated, read-only image resources.
use super::*;
use axum::extract::Query;
use feedtorrent_bep::TorrentMetadataBackend;
use feedtorrent_posts::publishing::{Draft, Entry};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Policy {
    Always,
    Ask,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Preferences {
    #[serde(default)]
    pub automatic: bool,
    #[serde(default)]
    pub posts: BTreeMap<String, Policy>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Update {
    Global { automatic: bool },
    Post { id: String, policy: Option<Policy> },
}
impl Preferences {
    pub fn update(&mut self, update: Update) -> Result<()> {
        match update {
            Update::Global { automatic } => self.automatic = automatic,
            Update::Post { id, policy } => {
                let id = id.to_ascii_lowercase();
                if !valid_id(&id) {
                    bail!("Invalid post identifier")
                }
                if let Some(policy) = policy {
                    self.posts.insert(id, policy);
                } else {
                    self.posts.remove(&id);
                }
            }
        }
        Ok(())
    }
}
fn relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains([':', '\\'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|p| matches!(p, "" | "." | ".."))
    {
        bail!("Invalid image attachment path")
    }
    Ok(())
}
fn source(path: &Path, length: u64, modified: Option<&str>) -> Result<Value> {
    let path = creation::source_path(path)?;
    let meta = fs::metadata(&path)?;
    let stamp = creation::stamp(&path)?;
    if !meta.is_file() || meta.len() != length || modified.is_some_and(|m| m != stamp) {
        bail!("Image attachment changed")
    }
    Ok(json!({"state":"ready","path":path,"length":length,"modified":stamp}))
}
pub(crate) fn draft_source(draft: &Draft, page: u64, path: &str) -> Result<Value> {
    relative(path)?;
    let page = draft
        .pages
        .iter()
        .find(|p| p.id == page)
        .context("Page unavailable")?;
    let mut found = page
        .entries
        .iter()
        .filter_map(|e| match e {
            Entry::Files {
                files,
                linked: false,
                ..
            } => Some(files),
            _ => None,
        })
        .flatten()
        .filter(|f| f.path.join("/") == path);
    let file = found.next().context("Image attachment not found")?;
    if found.next().is_some() {
        bail!("Ambiguous image attachment")
    }
    source(Path::new(&file.source), file.length, Some(&file.modified))
}
impl Engine {
    pub(super) fn image_source(&self, id: &str, path: &str) -> Result<Value> {
        relative(path)?;
        if !valid_id(id) {
            bail!("Invalid torrent identifier")
        }
        let Some(t) = self.view.transfers.iter().find(|t| t.id == id) else {
            return Ok(json!({"state":"pending"}));
        };
        let prefix = format!("{}/", t.name);
        let mut found = t
            .files
            .iter()
            .filter(|f| f.name.strip_prefix(&prefix).unwrap_or(&f.name) == path);
        let Some(file) = found.next() else {
            if t.files.is_empty() {
                return Ok(json!({"state":"pending"}));
            }
            bail!("Image attachment not found")
        };
        if found.next().is_some() {
            bail!("Ambiguous image attachment")
        }
        if t.state == "Checking" || !t.error.is_empty() || !file.ready {
            return Ok(json!({"state":"pending"}));
        }
        let logical = path;
        let path = self.verified_path(id, &file.name)?;
        let value = source(&path, file.length, None)?;
        if let Some(info) = self.native.info_bytes(id)? {
            if let Ok(catalog) = feedtorrent_bep::bep49::Feed::from_info(&info) {
                let entry = catalog
                    .entries()
                    .iter()
                    .find(|e| e.path().join("/") == logical)
                    .context("Image attachment unavailable")?;
                if entry.check_sha1(File::open(&path)?)? == Some(false) {
                    bail!("Image attachment SHA-1 mismatch")
                }
            }
        }
        Ok(value)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImageQuery {
    context: String,
    id: String,
    path: String,
    #[serde(default)]
    inspect: bool,
    page: Option<u64>,
    revision: Option<u64>,
}
fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..)
            .is_some_and(|b| b.chunks_exact(4).any(|b| b == b"avif" || b == b"avis"))
    {
        Some("image/avif")
    } else {
        None
    }
}
pub(crate) async fn resource(
    State(app): State<Arc<App>>,
    Query(query): Query<ImageQuery>,
) -> Response {
    let inspect = query.inspect;
    let resolved = match query.context.as_str() {
        "torrent" if query.page.is_none() && query.revision.is_none() => {
            engine_call(
                &app,
                Command::ReadImage {
                    id: query.id,
                    path: query.path,
                },
            )
            .await
        }
        "own" => {
            let (Some(page), Some(revision)) = (query.page, query.revision) else {
                return api_error(StatusCode::BAD_REQUEST, "Image context required");
            };
            app.publishing
                .call(publishing::Command::ReadImage {
                    id: query.id,
                    page,
                    revision,
                    path: query.path,
                })
                .await
        }
        _ => return api_error(StatusCode::BAD_REQUEST, "Invalid image context"),
    };
    let result=async {
        let value=resolved.map_err(anyhow::Error::msg)?;
        if value["state"]=="pending" {return Ok(if inspect{Json(value).into_response()}else{api_error(StatusCode::CONFLICT,"Image is not downloaded and verified")});}
        let path=value["path"].as_str().context("Image unavailable")?;
        let length=value["length"].as_u64().context("Image unavailable")?;
        let modified=value["modified"].as_str().context("Image unavailable")?;
        let safe=creation::source_path(Path::new(path))?;
        let mut file=tokio::fs::File::open(&safe).await?;
        let meta=file.metadata().await?;
        let stamp=meta.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_nanos().to_string();
        if !meta.is_file()||meta.len()!=length||stamp!=modified {bail!("Image attachment changed")}
        use tokio::io::{AsyncReadExt,AsyncSeekExt};
        let mut signature=[0;64];let n=file.read(&mut signature).await?;
        let Some(kind)=mime(&signature[..n]) else{return Ok(api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE,"Unsupported image format"));};
        if inspect{return Ok(Json(json!({"state":"ready"})).into_response())}
        file.rewind().await?;
        let stream=async_stream::stream!{let mut left=length;while left>0{let mut buffer=vec![0;left.min(65536) as usize];match file.read(&mut buffer).await{Ok(0)=>{yield Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));break;},Ok(n)=>{left-=n as u64;buffer.truncate(n);yield Ok::<_,std::io::Error>(axum::body::Bytes::from(buffer));},Err(e)=>{yield Err(e);break;}}}};
        Ok::<_,anyhow::Error>(Response::builder().header(header::CONTENT_TYPE,kind).header(header::CONTENT_LENGTH,length).body(Body::from_stream(stream))?)
    }.await;
    result.unwrap_or_else(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "Image attachment unavailable or changed",
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_preferences_are_partial_and_normalize_id() {
        let mut p = Preferences::default();
        assert!(!p.automatic);
        p.update(Update::Post {
            id: "A".repeat(40),
            policy: Some(Policy::Ask),
        })
        .unwrap();
        p.update(Update::Global { automatic: true }).unwrap();
        assert!(matches!(p.posts[&"a".repeat(40)], Policy::Ask));
        p.update(Update::Post {
            id: "a".repeat(40),
            policy: None,
        })
        .unwrap();
        assert!(p.posts.is_empty());
        assert!(p.automatic);
        assert!(p
            .update(Update::Post {
                id: "invalid".into(),
                policy: None
            })
            .is_err());
    }
    #[test]
    fn image_bytes_and_paths_are_restricted() {
        for path in ["../x", "/x", "a/../x", "a\\x", "http://x", "a//x"] {
            assert!(relative(path).is_err())
        }
        assert!(relative("photos/a b.png").is_ok());
        for data in [b"<svg></svg>".as_slice(), b"<html></html>", b"not an image"] {
            assert!(mime(data).is_none())
        }
        assert_eq!(mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
    }
}
