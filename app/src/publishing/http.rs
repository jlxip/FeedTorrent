use super::*;
use axum::{body::Bytes, extract::Query};
#[derive(Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    full: bool,
    #[serde(default)]
    prepare: bool,
    token: Option<String>,
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
    let _serial = app.creation.gate.lock().await;
    let path = match if let Some(token) = query.token {
        app.creation
            .take_export(&token)
            .map_err(|e| format!("{e:#}"))
    } else {
        app.publishing.export(query.full).await
    } {
        Ok(p) => p,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    if query.prepare {
        return match app.creation.prepare_export(path) {
            Ok(token) => Json(serde_json::json!({"token":token})).into_response(),
            Err(e) => api_error(StatusCode::BAD_REQUEST, e),
        };
    }
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
pub async fn import(State(app): State<Arc<App>>, headers: HeaderMap, mut body: Body) -> Response {
    let _serial = app.creation.gate.lock().await;
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
    if !app.creation.idle() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Wait for torrent creation before importing",
        );
    }
    let mut random = [0; 16];
    if getrandom::fill(&mut random).is_err() {
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot obtain import entropy",
        );
    }
    let path = app
        .creation
        .directory()
        .join(format!(".incoming-{}.tar", hex(&random)));
    struct Incoming(PathBuf);
    impl Drop for Incoming {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let incoming = Incoming(path.clone());
    let result = async {
        use axum::body::HttpBody;
        use tokio::io::AsyncWriteExt;
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(frame) =
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)).await
        {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Ok(bytes) = frame.into_data() {
                output.write_all(&bytes).await.map_err(|e| e.to_string())?;
            }
        }
        output.sync_all().await.map_err(|e| e.to_string())?;
        drop(output);
        let value = app.publishing.import_file(path, password).await?;
        app.creation.reload().map_err(|e| format!("{e:#}"))?;
        Ok::<_, String>(value)
    }
    .await;
    drop(incoming);
    match result {
        Ok(value) => Json(value).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}
