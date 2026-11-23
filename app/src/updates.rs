//! Published application releases. This is independent of the torrent transport.
pub mod gate;
mod install;
use crate::*;
use reqwest::{Client, Url};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};

const REPOSITORY: &str = "https://api.github.com/repos/jlxip/FeedTorrent/releases";
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
#[derive(Clone, Serialize)]
pub struct Offer {
    pub id: String,
    pub version: String,
    pub target: String,
    pub size: u64,
    #[serde(skip)]
    archive: String,
    #[serde(skip)]
    checksum: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Completed {
    pub operation: String,
    pub version: String,
    pub status: String,
    pub recovery: String,
}
#[derive(Clone, Serialize)]
pub struct View {
    pub current: String,
    pub instance: String,
    pub supported: bool,
    pub phase: String,
    pub offer: Option<Offer>,
    pub last_check: Option<u64>,
    pub next_check: u64,
    pub error: String,
    pub check_error: String,
    pub operation: Option<String>,
    pub done: u64,
    pub total: u64,
    pub recovery: String,
    pub completed: Option<Completed>,
}
#[derive(Deserialize)]
struct Release {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    browser_download_url: String,
    size: u64,
}
pub struct Service {
    pub view: watch::Receiver<View>,
    tx: watch::Sender<View>,
    client: Client,
    probe_client: Client,
    api: String,
    fixture_origin: Option<Url>,
    current: semver::Version,
    target: Option<String>,
    context: Result<install::Context, String>,
    actions: Mutex<()>,
    checking: AtomicBool,
    installing: AtomicBool,
    stopped: AtomicBool,
    cancel: watch::Sender<bool>,
    restart: watch::Sender<bool>,
    prepared: Mutex<Option<install::Prepared>>,
    pub gate: Arc<gate::Gate>,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random_id() -> Result<String> {
    let mut b = [0; 16];
    getrandom::fill(&mut b).map_err(|e| anyhow!("Update entropy: {e}"))?;
    Ok(feedtorrent_posts::hex(&b))
}
fn version(tag: &str) -> Result<semver::Version> {
    let raw = tag.strip_prefix('v').unwrap_or(tag);
    let normalized = if let Some((base, pre)) = raw.split_once('-') {
        let mut s = None;
        for prefix in ["alpha", "beta", "rc"] {
            if let Some(n) = pre.strip_prefix(prefix) {
                if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) {
                    s = Some(format!("{base}-{prefix}.{}", n.parse::<u64>()?));
                }
            }
        }
        s.unwrap_or_else(|| raw.into())
    } else {
        raw.into()
    };
    let mut result = semver::Version::parse(&normalized)?;
    result.build = semver::BuildMetadata::EMPTY;
    Ok(result)
}
fn newer(current: &semver::Version, tag: &str, prerelease: bool) -> Option<semver::Version> {
    let candidate = version(tag).ok()?;
    if candidate <= *current || current.pre.is_empty() && (prerelease || !candidate.pre.is_empty())
    {
        None
    } else {
        Some(candidate)
    }
}
fn platform() -> Option<String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-arm64".into()),
        ("linux", "x86_64") => Some("linux-amd64".into()),
        ("openbsd", "x86_64") => {
            let output = std::process::Command::new("uname")
                .arg("-r")
                .output()
                .ok()?;
            (output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "8.0")
                .then(|| "openbsd-8.0-amd64".into())
        }
        _ => None,
    }
}
fn official(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "api.github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}
fn permitted(url: &Url, fixture: Option<&Url>) -> bool {
    fixture.map_or_else(
        || official(url),
        |o| {
            url.scheme() == "https"
                && url.origin() == o.origin()
                && url.username().is_empty()
                && url.password().is_none()
        },
    )
}
impl Service {
    pub fn new(dir: &Path, isolated: bool, port: u16) -> Result<Arc<Self>> {
        let fixture = if isolated {
            std::env::var("FEEDTORRENT_UPDATE_TEST_ORIGIN")
                .ok()
                .map(|s| -> Result<Url> {
                    let u = Url::parse(&s)?;
                    if u.scheme() != "https"
                        || !u
                            .host_str()
                            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                            .is_some_and(|a| a.is_loopback())
                        || u.path() != "/"
                        || u.query().is_some()
                        || u.fragment().is_some()
                        || !u.username().is_empty()
                        || u.password().is_some()
                    {
                        bail!("Update fixture must be a loopback HTTPS origin");
                    }
                    Ok(u)
                })
                .transpose()?
        } else {
            None
        };
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if fixture.is_some() {
            if let Some(path) = std::env::var_os("FEEDTORRENT_UPDATE_TEST_CA") {
                let bytes = fs::read(path)?;
                use rustls::pki_types::pem::PemObject;
                let cert = rustls::pki_types::CertificateDer::from_pem_slice(&bytes)?;
                // reqwest's root addition is applied to the preconfigured Rustls
                // config below via its DER representation, not a TLS bypass.
                roots.add(cert)?;
            }
        }
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let redirect_origin = fixture.clone();
        let client = Client::builder()
            .tls_backend_preconfigured(tls.clone())
            .user_agent(concat!("FeedTorrent/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::custom(move |a| {
                if a.previous().len() >= 5 || !permitted(a.url(), redirect_origin.as_ref()) {
                    a.error("Untrusted release redirect")
                } else {
                    a.follow()
                }
            }))
            .build()?;
        let probe_client = Client::builder()
            .tls_backend_preconfigured(tls)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        let current = version(env!("CARGO_PKG_VERSION"))?;
        let target = platform();
        let context = install::Context::new(dir, port).map_err(|e| format!("{e:#}"));
        let completed = context
            .as_ref()
            .ok()
            .and_then(|c| c.completed().ok())
            .flatten();
        let (tx, view) = watch::channel(View {
            current: format!("v{}", env!("CARGO_PKG_VERSION")),
            instance: random_id()?,
            supported: target.is_some(),
            phase: "idle".into(),
            offer: None,
            last_check: None,
            next_check: 0,
            error: String::new(),
            check_error: String::new(),
            operation: None,
            done: 0,
            total: 0,
            recovery: String::new(),
            completed,
        });
        let (cancel, _) = watch::channel(false);
        let (restart, _) = watch::channel(false);
        Ok(Arc::new(Self {
            view,
            tx,
            client,
            probe_client,
            api: fixture
                .as_ref()
                .map(|u| format!("{}releases", u.as_str()))
                .unwrap_or_else(|| REPOSITORY.into()),
            fixture_origin: fixture,
            current,
            target,
            context,
            actions: Mutex::new(()),
            checking: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            cancel,
            restart,
            prepared: Mutex::new(None),
            gate: Arc::default(),
        }))
    }
    fn change(&self, f: impl FnOnce(&mut View)) {
        self.tx.send_modify(f);
    }
    pub fn start(self: &Arc<Self>, isolated: bool) {
        if isolated {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(s) = weak.upgrade() else {
                    return;
                };
                if s.stopped.load(Ordering::SeqCst) {
                    return;
                }
                s.check();
                drop(s);
                tokio::time::sleep(INTERVAL).await;
            }
        });
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.cancel.send_replace(true);
    }
    pub fn restart(&self) -> watch::Receiver<bool> {
        self.restart.subscribe()
    }
    pub fn take_prepared(&self) -> Option<install::Prepared> {
        self.prepared.lock().unwrap().take()
    }
    pub fn sensitive(&self) -> bool {
        self.gate.sensitive()
    }
    fn check(self: &Arc<Self>) {
        let _actions = self.actions.lock().unwrap();
        if self.view.borrow().next_check > now()
            || self.installing.load(Ordering::SeqCst)
            || self.checking.swap(true, Ordering::SeqCst)
            || self.stopped.load(Ordering::SeqCst)
        {
            return;
        }
        self.change(|v| {
            v.phase = "checking".into();
            v.check_error.clear();
        });
        let s = self.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(120), s.discover())
                .await
                .context("Release check timed out")
                .and_then(|r| r);
            s.change(|v| {
                v.phase = "idle".into();
                match result {
                    Ok(offer) => {
                        v.offer = offer;
                        v.last_check = Some(now());
                        v.check_error.clear();
                    }
                    Err(e) => v.check_error = format!("{e:#}"),
                }
            });
            s.checking.store(false, Ordering::SeqCst);
        });
    }
    async fn discover(&self) -> Result<Option<Offer>> {
        let Some(target) = &self.target else {
            return Ok(None);
        };
        let mut best: Option<(semver::Version, Offer)> = None;
        for page in 1..=100 {
            let url = format!("{}?per_page=100&page={page}", self.api);
            let response = self
                .client
                .get(url)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await?;
            if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
                let reset = response
                    .headers()
                    .get("x-ratelimit-reset")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let retry = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|n| now() + n);
                self.change(|v| v.next_check = reset.or(retry).unwrap_or_else(|| now() + 3600));
            }
            let bytes = bounded(response.error_for_status()?, 8 * 1024 * 1024, |_, _| {}).await?;
            let releases: Vec<Release> = serde_json::from_slice(&bytes)?;
            let count = releases.len();
            for release in releases {
                if release.draft || release.published_at.is_none() {
                    continue;
                }
                let Some(v) = newer(&self.current, &release.tag_name, release.prerelease) else {
                    continue;
                };
                if best.as_ref().is_some_and(|(b, _)| &v <= b) {
                    continue;
                }
                if !release
                    .tag_name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
                {
                    continue;
                }
                let name = format!("feedtorrent-{}-{target}.tar.gz", release.tag_name);
                let asset = release.assets.iter().find(|a| a.name == name);
                let sha = release
                    .assets
                    .iter()
                    .find(|a| a.name == format!("{name}.sha256"));
                let (Some(asset), Some(sha)) = (asset, sha) else {
                    continue;
                };
                if asset.size == 0 || asset.size > install::MAX_ARCHIVE || sha.size > 4096 {
                    continue;
                }
                self.asset_url(&asset.browser_download_url, &release.tag_name, &asset.name)?;
                self.asset_url(&sha.browser_download_url, &release.tag_name, &sha.name)?;
                best = Some((
                    v,
                    Offer {
                        id: format!("{}-{}-{}", release.id, asset.id, sha.id),
                        version: release.tag_name,
                        target: target.clone(),
                        size: asset.size,
                        archive: asset.browser_download_url.clone(),
                        checksum: sha.browser_download_url.clone(),
                    },
                ));
            }
            if count < 100 {
                return Ok(best.map(|(_, o)| o));
            }
        }
        bail!("Release history exceeds the supported pagination limit")
    }
    fn asset_url(&self, s: &str, tag: &str, name: &str) -> Result<()> {
        let u = Url::parse(s)?;
        if !permitted(&u, self.fixture_origin.as_ref())
            || u.query().is_some()
            || u.fragment().is_some()
        {
            bail!("Invalid release asset URL");
        }
        if self.fixture_origin.is_none()
            && (u.host_str() != Some("github.com")
                || u.path() != format!("/jlxip/FeedTorrent/releases/download/{tag}/{name}"))
        {
            bail!("Asset is not from the official release");
        }
        Ok(())
    }
    fn install(self: &Arc<Self>, app: Arc<App>, id: &str) -> Result<String> {
        let _actions = self.actions.lock().unwrap();
        if self.stopped.load(Ordering::SeqCst) {
            bail!("FeedTorrent is stopping");
        }
        if self.checking.load(Ordering::SeqCst) {
            bail!("Wait for the release check");
        }
        let offer = self
            .view
            .borrow()
            .offer
            .clone()
            .filter(|o| o.id == id)
            .context("Release offer changed; check again")?;
        if self.installing.swap(true, Ordering::SeqCst) {
            bail!("An application update is already running");
        }
        if self.context.is_err() {
            self.installing.store(false, Ordering::SeqCst);
            bail!("{}", self.context.as_ref().err().unwrap());
        }
        let operation = match random_id() {
            Ok(id) => id,
            Err(e) => {
                self.installing.store(false, Ordering::SeqCst);
                return Err(e);
            }
        };
        self.gate.reset();
        self.cancel.send_replace(false);
        self.change(|v| {
            v.operation = Some(operation.clone());
            v.phase = "downloading".into();
            v.error.clear();
            v.done = 0;
            v.total = offer.size;
            v.recovery.clear();
        });
        let s = self.clone();
        let op = operation.clone();
        let mut cancelled = self.cancel.subscribe();
        tokio::spawn(async move {
            let result = tokio::select! { biased; _=cancelled.changed()=>Err(anyhow!("Application update cancelled")),r=s.prepare(&app,&offer,&op)=>r };
            match result {
                Ok(prepared) => {
                    s.change(|v| {
                        v.phase = "restarting".into();
                        v.recovery = prepared.recovery();
                    });
                    *s.prepared.lock().unwrap() = Some(prepared);
                    s.restart.send_replace(true);
                }
                Err(e) => {
                    let _ = app.publishing.pause_renewals(false).await;
                    s.gate.reset();
                    s.change(|v| {
                        v.phase = "idle".into();
                        v.error = format!("{e:#}");
                    });
                    s.installing.store(false, Ordering::SeqCst);
                }
            }
        });
        Ok(operation)
    }
    async fn prepare(&self, app: &App, offer: &Offer, op: &str) -> Result<install::Prepared> {
        let context = self.context.as_ref().map_err(|e| anyhow!(e.clone()))?;
        let stage = context.stage()?;
        let response = self
            .client
            .get(&offer.checksum)
            .send()
            .await?
            .error_for_status()?;
        let sha = bounded(response, 4096, |_, _| {}).await?;
        let checksum = String::from_utf8(sha)?;
        let name = format!("feedtorrent-{}-{}.tar.gz", offer.version, offer.target);
        let mut fields = checksum.split_whitespace();
        let digest = fields.next().context("Missing package checksum")?;
        if digest.len() != 64
            || !digest.bytes().all(|c| c.is_ascii_hexdigit())
            || fields.next() != Some(name.as_str())
            || fields.next().is_some()
        {
            bail!("Invalid package checksum file");
        }
        let response = self
            .client
            .get(&offer.archive)
            .send()
            .await?
            .error_for_status()?;
        let archive = bounded(response, install::MAX_ARCHIVE, |done, total| {
            self.change(|v| {
                v.done = done;
                v.total = total.unwrap_or(offer.size);
            })
        })
        .await?;
        if archive.len() as u64 != offer.size
            || install::hash_bytes(&archive) != digest.to_ascii_lowercase()
        {
            bail!("Release package checksum or size mismatch");
        }
        self.change(|v| v.phase = "verifying".into());
        let offer = offer.clone();
        let bytes = archive;
        let unpacked =
            tokio::task::spawn_blocking(move || install::unpack(stage, bytes, &offer)).await??;
        self.change(|v| v.phase = "probing".into());
        install::probe(&unpacked, &self.probe_client).await?;
        self.gate.waiting(true);
        app.publishing
            .pause_renewals(true)
            .await
            .map_err(anyhow::Error::msg)?;
        self.change(|v| v.phase = "waiting".into());
        loop {
            let publication_idle = {
                let v = app.publishing.view.borrow();
                v.busy.is_empty() && v.posts.iter().all(|p| p.operation.is_none())
            };
            if app.creation.idle()
                && app.creation.backups_idle()
                && app.imports.idle()
                && publication_idle
                && self.gate.begin_apply()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        self.change(|v| v.phase = "preparing".into());
        context.prepare(unpacked, op).await
    }
}
async fn bounded(
    mut r: reqwest::Response,
    max: u64,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>> {
    let total = r.content_length();
    if total.is_some_and(|n| n > max) {
        bail!("Release response exceeds size limit");
    }
    let mut data = Vec::new();
    while let Some(chunk) = r.chunk().await? {
        if data.len() as u64 + chunk.len() as u64 > max {
            bail!("Release response exceeds size limit");
        }
        data.extend_from_slice(&chunk);
        progress(data.len() as u64, total);
    }
    Ok(data)
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Check,
    Install { offer: String },
    Cancel { operation: String },
}
pub async fn view(State(app): State<Arc<App>>) -> Json<View> {
    Json(app.updates.view.borrow().clone())
}
pub async fn command(State(app): State<Arc<App>>, Json(action): Json<Action>) -> Response {
    let s = &app.updates;
    let result = match action {
        Action::Check => {
            s.check();
            Ok(json!({"ok":true}))
        }
        Action::Install { offer } => s
            .install(app.clone(), &offer)
            .map(|operation| json!({"operation":operation})),
        Action::Cancel { operation } => {
            let _actions = s.actions.lock().unwrap();
            let v = s.view.borrow();
            if v.operation.as_deref() != Some(&operation)
                || !s.installing.load(Ordering::SeqCst)
                || !matches!(
                    v.phase.as_str(),
                    "downloading" | "verifying" | "probing" | "waiting"
                )
                || !s.gate.cancel()
            {
                Err(anyhow!("This update cannot be cancelled"))
            } else {
                s.cancel.send_replace(true);
                Ok(json!({"ok":true}))
            }
        }
    };
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::CONFLICT, format!("{e:#}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_order_and_channels() {
        assert!(version("v1.0.0-rc10").unwrap() > version("1.0.0-rc9").unwrap());
        assert!(version("1.0.0-beta2").unwrap() > version("1.0.0-alpha99").unwrap());
        let stable = version("1.0.0").unwrap();
        assert!(newer(&stable, "v2.0.0-rc10", true).is_none());
        assert!(newer(&stable, "v2.0.0", true).is_none());
        assert!(newer(&stable, "v1.0.0+newbuild", false).is_none());
        assert!(newer(&stable, "v0.9.9", false).is_none());
        assert!(newer(&stable, "v1.0.1", false).is_some());
        let alpha = version("1.0.0-alpha").unwrap();
        assert!(newer(&alpha, "1.0.0-rc1", true).is_some());
        assert!(newer(&alpha, "1.0.0", false).is_some());
        assert!(version("../../bad").is_err());
    }
    #[test]
    fn release_authority_is_fixed() {
        for s in [
            "http://github.com/x",
            "https://github.com.evil/x",
            "https://user@github.com/x",
            "https://github.com:444/x",
            "https://127.0.0.1/x",
        ] {
            assert!(!official(&Url::parse(s).unwrap()), "{s}");
        }
        assert!(official(
            &Url::parse("https://release-assets.githubusercontent.com/x").unwrap()
        ));
    }
}
