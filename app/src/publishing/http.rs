use super::*;
use axum::{body::Bytes, extract::Query};
#[derive(Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    full: bool,
}
pub async fn command(
    State(app): State<Arc<App>>,
    payload: std::result::Result<Json<Command>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(command) = match payload {
        Ok(c) => c,
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "Invalid publishing request; reload FeedTorrent to update this client",
            )
        }
    };
    if matches!(command, Command::RemovePost { .. }) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Reload FeedTorrent and use Delete post with a deletion preview",
        );
    }
    match app.publishing.call(command).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}
pub async fn export(State(app): State<Arc<App>>, Query(query): Query<ExportQuery>) -> Response {
    let path = match app.publishing.export(query.full).await {
        Ok(p) => p,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    let file = tokio::fs::File::open(&path).await;
    let _ = tokio::fs::remove_file(&path).await;
    let mut file = match file {
        Ok(f) => f,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    let stream = async_stream::stream! {use tokio::io::AsyncReadExt;loop{let mut buf=vec![0;65536];match file.read(&mut buf).await{Ok(0)=>break,Ok(size)=>{buf.truncate(size);yield Ok::<_,std::io::Error>(Bytes::from(buf));},Err(error)=>{yield Err(error);break}}}};
    let name = if query.full {
        "feedtorrent-publishing.tar"
    } else {
        "feedtorrent-keys.tar"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-tar")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\" "),
        )
        .body(Body::from_stream(stream))
        .unwrap()
}
pub async fn import(State(app): State<Arc<App>>, headers: HeaderMap, bytes: Bytes) -> Response {
    let password = (|| -> Result<Password> {
        let encoded = headers
            .get("x-feedtorrent-password")
            .context("Backup password required")?
            .to_str()?;
        if encoded.len() > 8192 {
            bail!("Password too long")
        };
        Ok(Password(String::from_utf8(unhex(encoded)?)?))
    })();
    let password = match password {
        Ok(p) => p,
        Err(_) => return api_error(StatusCode::BAD_REQUEST, "Backup password required"),
    };
    match app.publishing.import(bytes.to_vec(), password).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}
