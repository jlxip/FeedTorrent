//! Public, read-only BEP44 HTTP gateway. The host actor owns all native work.
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use feedtorrent_bep::bep44::*;
use feedtorrent_libtorrent::LibtorrentBackend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{SocketAddr, TcpListener},
    sync::{mpsc, Arc},
    time::Duration,
};
use tokio::{
    runtime::Handle,
    sync::{oneshot, watch, Semaphore},
};

const LOOKUPS: usize = 8;
const RESPONSES: usize = 32;
const TIMEOUT: Duration = Duration::from_secs(120);
type Reply = oneshot::Sender<Result<Value, Failure>>;
#[derive(Clone, Debug)]
enum Update {
    Waiting,
    Record(Value),
    Done(Result<Value, Failure>),
}
type Updates = watch::Sender<Update>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub listen: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            listen: "127.0.0.1:8793".into(),
        }
    }
}
impl Config {
    pub fn address(&self) -> anyhow::Result<SocketAddr> {
        let address: SocketAddr = self.listen.parse().map_err(|_| {
            anyhow::anyhow!(
                "Enter an IP address and port, for example 127.0.0.1:8793 or [::1]:8793"
            )
        })?;
        anyhow::ensure!(
            address.port() != 0,
            "DHT gateway port must be between 1 and 65535"
        );
        Ok(address)
    }
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct View {
    pub running: bool,
    pub listen: String,
    pub error: String,
}
#[derive(Clone, Debug)]
struct Failure(StatusCode, &'static str);
fn failure(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        failure(self.0, self.1)
    }
}
fn unavailable() -> Failure {
    Failure(StatusCode::SERVICE_UNAVAILABLE, "DHT gateway unavailable")
}
fn overloaded() -> Failure {
    Failure(StatusCode::TOO_MANY_REQUESTS, "DHT gateway limit reached")
}
fn timed_out() -> Failure {
    Failure(StatusCode::GATEWAY_TIMEOUT, "DHT lookup timed out")
}
fn native_error(error: &DhtError) -> Failure {
    match error {
        DhtError::Conflict => Failure(StatusCode::CONFLICT, "Conflicting DHT records"),
        DhtError::Timeout => timed_out(),
        DhtError::Busy | DhtError::NotReady | DhtError::Closed => unavailable(),
        _ => Failure(StatusCode::BAD_GATEWAY, "DHT lookup failed"),
    }
}
fn bytes(text: &str, length: Option<usize>) -> Result<Vec<u8>, Failure> {
    if text.len() > 128
        || !text.bytes().all(|b| b.is_ascii_hexdigit())
        || !text.len().is_multiple_of(2)
        || length.is_some_and(|n| text.len() != n * 2)
    {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Invalid hexadecimal DHT key or salt",
        ));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| {
                Failure(
                    StatusCode::BAD_REQUEST,
                    "Invalid hexadecimal DHT key or salt",
                )
            })
        })
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn request_id(request: &DhtRequest) -> String {
    match request {
        DhtRequest::GetImmutable(target) => format!("i:{}", hex(target)),
        DhtRequest::GetMutable(key) => format!("m:{}:{}", hex(&key.public_key()), hex(key.salt())),
        _ => unreachable!("gateway only constructs reads"),
    }
}
fn result_json(result: &Result<DhtOutcome, DhtError>) -> Result<Value, Failure> {
    match result {
        Ok(DhtOutcome::Immutable(Some(item))) => {
            Ok(json!({"target":hex(&item.target()),"value":hex(item.value().as_bytes())}))
        }
        Ok(DhtOutcome::Mutable(Some(record))) => Ok(
            json!({"key":hex(&record.key().public_key()),"salt":hex(record.key().salt()),"sequence":record.sequence().to_string(),"signature":hex(&record.signature()),"value":hex(record.value().as_bytes())}),
        ),
        Ok(DhtOutcome::Immutable(None) | DhtOutcome::Mutable(None)) => {
            Err(Failure(StatusCode::NOT_FOUND, "DHT item not found"))
        }
        Err(error) => Err(native_error(error)),
        _ => Err(Failure(StatusCode::BAD_GATEWAY, "Unexpected DHT result")),
    }
}
struct Job {
    request: DhtRequest,
    reply: Reply,
    stopped: watch::Receiver<bool>,
    stream: Option<Updates>,
    observed: Option<Value>,
}
#[derive(Clone)]
struct HttpState {
    jobs: mpsc::SyncSender<Job>,
    permits: Arc<Semaphore>,
    stopped: watch::Receiver<bool>,
}
async fn lookup(state: HttpState, request: DhtRequest) -> Response {
    let Ok(_permit) = state.permits.try_acquire() else {
        return overloaded().into_response();
    };
    let mut stopped = state.stopped.clone();
    if *stopped.borrow() {
        return unavailable().into_response();
    }
    let (reply, result) = oneshot::channel();
    if let Err(error) = state.jobs.try_send(Job {
        request,
        reply,
        stopped: stopped.clone(),
        stream: None,
        observed: None,
    }) {
        return match error {
            mpsc::TrySendError::Full(_) => overloaded(),
            mpsc::TrySendError::Disconnected(_) => unavailable(),
        }
        .into_response();
    }
    tokio::select! {
        biased;
        _ = stopped.changed() => unavailable().into_response(),
        result = result => match result {
            Ok(Ok(value)) => Json(value).into_response(),
            Ok(Err(error)) => error.into_response(),
            Err(_) => unavailable().into_response(),
        },
        _ = tokio::time::sleep(TIMEOUT) => timed_out().into_response(),
    }
}
// SSE carries authenticated candidates, followed by exactly one response-terminal
// `done`. An interrupted stream has no final result. Slow readers see the latest
// candidate (watch coalesces), not an unbounded queue of historical observations.
async fn stream_lookup(state: HttpState, request: DhtRequest) -> Response {
    let Ok(permit) = state.permits.clone().try_acquire_owned() else {
        return overloaded().into_response();
    };
    let mut stopped = state.stopped.clone();
    if *stopped.borrow() {
        return unavailable().into_response();
    }
    let (updates, mut received) = watch::channel(Update::Waiting);
    let (reply, _unused) = oneshot::channel();
    if let Err(error) = state.jobs.try_send(Job {
        request,
        reply,
        stopped: stopped.clone(),
        stream: Some(updates),
        observed: None,
    }) {
        return match error {
            mpsc::TrySendError::Full(_) => overloaded(),
            mpsc::TrySendError::Disconnected(_) => unavailable(),
        }
        .into_response();
    }
    let events = async_stream::stream! {
        let _permit = permit;
        let deadline = tokio::time::sleep(TIMEOUT);
        tokio::pin!(deadline);
        loop {
            let update = received.borrow_and_update().clone();
            match update {
                Update::Waiting => {},
                Update::Record(record) => {
                    yield Ok::<Event, std::convert::Infallible>(Event::default().event("record").json_data(record).expect("JSON value"));
                },
                Update::Done(result) => {
                    let value = match result {
                        Ok(record) => json!({"record":record,"error":null}),
                        Err(Failure(status, message)) => json!({"record":null,"error":{"status":status.as_u16(),"message":message}}),
                    };
                    yield Ok(Event::default().event("done").json_data(value).expect("JSON value"));
                    break;
                }
            }
            let error = tokio::select! {
                biased;
                _ = stopped.changed() => Some(unavailable()),
                _ = &mut deadline => Some(timed_out()),
                result = received.changed() => if result.is_err() { Some(unavailable()) } else { None },
            };
            if let Some(Failure(status, message)) = error {
                yield Ok(Event::default().event("done").json_data(json!({"record":null,"error":{"status":status.as_u16(),"message":message}})).expect("JSON value"));
                break;
            }
        }
    };
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
fn wants_stream(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|text| {
            text.split(',').any(|range| {
                let mut parts = range.split(';');
                parts
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
                    && parts.all(|parameter| {
                        parameter
                            .trim()
                            .strip_prefix("q=")
                            .is_none_or(|q| q.parse::<f32>().is_ok_and(|q| q > 0.0 && q <= 1.0))
                    })
            })
        })
}
async fn immutable(State(state): State<HttpState>, Path(target): Path<String>) -> Response {
    match bytes(&target, Some(20)) {
        Ok(target) => lookup(state, DhtRequest::GetImmutable(target.try_into().unwrap())).await,
        Err(error) => error.into_response(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Salt {
    #[serde(default)]
    salt: String,
}
async fn mutable(
    State(state): State<HttpState>,
    Path(key): Path<String>,
    Query(query): Query<Salt>,
    headers: HeaderMap,
) -> Response {
    let key = (|| {
        MutableKey::new(
            bytes(&key, Some(32))?.try_into().unwrap(),
            bytes(&query.salt, None)?,
        )
        .map_err(|_| Failure(StatusCode::BAD_REQUEST, "Invalid mutable DHT key or salt"))
    })();
    match key {
        Ok(key) => {
            if wants_stream(&headers) {
                stream_lookup(state, DhtRequest::GetMutable(key)).await
            } else {
                lookup(state, DhtRequest::GetMutable(key)).await
            }
        }
        Err(error) => error.into_response(),
    }
}
async fn headers(request: Request<Body>, next: Next) -> Response {
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let h = response.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, "*".parse().unwrap());
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, HEAD, OPTIONS".parse().unwrap(),
    );
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
fn router(state: HttpState) -> Router {
    Router::new()
        .route("/dht/immutable/{target}", get(immutable))
        .route("/dht/mutable/{key}", get(mutable))
        .fallback(|| async { failure(StatusCode::NOT_FOUND, "Unknown gateway route") })
        .layer(middleware::from_fn(headers))
        .with_state(state)
}
struct Running {
    stopped: watch::Sender<bool>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stopped.send_replace(true);
    }
}
pub enum Prepared {
    Keep,
    Stop,
    Listen(TcpListener, String),
}
struct Pending {
    identity: String,
    replies: Vec<Reply>,
    resolved: bool,
    streams: Vec<Updates>,
    observation: Option<Value>,
}
pub(super) trait Native: DhtBackend {
    fn request_pending(&self, id: DhtRequestId) -> bool;
    fn mutable_observation(&self, _id: DhtRequestId) -> Option<Result<MutableRecord, DhtError>> {
        None
    }
    fn shared_mutable_observation(
        &self,
        _key: &MutableKey,
    ) -> Option<Result<MutableRecord, DhtError>> {
        None
    }
}
impl Native for LibtorrentBackend {
    fn request_pending(&self, id: DhtRequestId) -> bool {
        self.dht_request_pending(id)
    }
    fn mutable_observation(&self, id: DhtRequestId) -> Option<Result<MutableRecord, DhtError>> {
        self.dht_mutable_observation(id)
    }
    fn shared_mutable_observation(
        &self,
        key: &MutableKey,
    ) -> Option<Result<MutableRecord, DhtError>> {
        self.dht_shared_mutable_observation(key)
    }
}
pub struct Gateway {
    runtime: Handle,
    tx: mpsc::SyncSender<Job>,
    rx: mpsc::Receiver<Job>,
    permits: Arc<Semaphore>,
    running: Option<Running>,
    pub view: View,
    pending: BTreeMap<u64, Pending>,
}
impl Gateway {
    pub fn new(runtime: Handle) -> Self {
        let (tx, rx) = mpsc::sync_channel(RESPONSES);
        Self {
            runtime,
            tx,
            rx,
            permits: Arc::new(Semaphore::new(RESPONSES)),
            running: None,
            view: View::default(),
            pending: BTreeMap::new(),
        }
    }
    pub fn prepare(&self, config: &Config) -> anyhow::Result<Prepared> {
        let address = config.address()?;
        if !config.enabled {
            return Ok(Prepared::Stop);
        }
        if self.running.is_some() && self.view.listen == address.to_string() {
            return Ok(Prepared::Keep);
        }
        let listener = TcpListener::bind(address)
            .map_err(|e| anyhow::anyhow!("Cannot open DHT gateway at {address}: {e}"))?;
        listener.set_nonblocking(true)?;
        Ok(Prepared::Listen(listener, address.to_string()))
    }
    pub fn apply(&mut self, prepared: Prepared) {
        if matches!(prepared, Prepared::Keep) {
            return;
        }
        self.running.take();
        self.view = View::default();
        if let Prepared::Listen(listener, listen) = prepared {
            let (stopped, mut stop) = watch::channel(false);
            let state = HttpState {
                jobs: self.tx.clone(),
                permits: self.permits.clone(),
                stopped: stop.clone(),
            };
            // The descriptor was bound before persistence; conversion/serving
            // takes place on the runtime, never on the native owner thread.
            self.runtime.spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener)
                    .expect("prepared nonblocking gateway listener");
                let _ = axum::serve(listener, router(state))
                    .with_graceful_shutdown(async move {
                        if !*stop.borrow() {
                            let _ = stop.changed().await;
                        }
                    })
                    .await;
            });
            self.running = Some(Running { stopped });
            self.view = View {
                running: true,
                listen,
                error: String::new(),
            };
        }
    }
    pub fn start(&mut self, config: &Config) {
        match self.prepare(config) {
            Ok(prepared) => self.apply(prepared),
            Err(error) => self.view.error = error.to_string(),
        }
    }
    pub fn stop(&mut self) {
        self.apply(Prepared::Stop);
    }
    pub fn event(&mut self, event: &DhtEvent) -> bool {
        let Some(pending) = self.pending.get_mut(&event.id.0) else {
            return false;
        };
        let result = result_json(&event.result);
        pending.resolved = true;
        for stream in pending.streams.drain(..) {
            stream.send_replace(Update::Done(result.clone()));
        }
        for reply in pending.replies.drain(..) {
            let _ = reply.send(result.clone());
        }
        true
    }
    pub(super) fn tick(&mut self, native: &mut impl Native) {
        // A native pump may consume the terminal before this actor dispatches
        // its queued event. Keep unresolved recipients until that dispatch.
        // Reported timeouts still reserve their slot while native work drains.
        self.pending
            .retain(|id, pending| !pending.resolved || native.request_pending(DhtRequestId(*id)));
        let mut deferred = Vec::new();
        for _ in 0..RESPONSES {
            let Ok(mut job) = self.rx.try_recv() else {
                break;
            };
            if (job.reply.is_closed() && job.stream.as_ref().is_none_or(Updates::is_closed))
                || *job.stopped.borrow()
            {
                continue;
            }
            let identity = request_id(&job.request);
            if let Some(pending) = self.pending.values_mut().find(|p| p.identity == identity) {
                if pending.resolved {
                    if let Some(stream) = job.stream {
                        stream.send_replace(Update::Done(Err(unavailable())));
                    }
                    let _ = job.reply.send(Err(unavailable()));
                } else {
                    pending.replies.retain(|r| !r.is_closed());
                    pending.replies.push(job.reply);
                    pending.streams.retain(|s| !s.is_closed());
                    if let Some(stream) = job.stream {
                        if let Some(record) = &pending.observation {
                            stream.send_replace(Update::Record(record.clone()));
                        }
                        pending.streams.push(stream);
                    }
                }
                continue;
            }
            if self.pending.len() >= LOOKUPS {
                if let Some(stream) = job.stream {
                    stream.send_replace(Update::Done(Err(overloaded())));
                }
                let _ = job.reply.send(Err(overloaded()));
                continue;
            }
            match native.start_dht(job.request.clone(), DhtOptions { timeout: TIMEOUT }) {
                Ok(id) => {
                    self.pending.insert(
                        id.0,
                        Pending {
                            identity,
                            replies: vec![job.reply],
                            resolved: false,
                            streams: job.stream.into_iter().collect(),
                            observation: job.observed,
                        },
                    );
                }
                // Internal post checks/renewals also own native targets. Wait
                // in the existing bounded HTTP queue, without starting work or
                // changing each handler's original timeout/cancellation.
                Err(DhtError::Busy) => {
                    // Sharing is provisional and SSE-only. The other operation
                    // retains its final result; our fresh lookup still follows.
                    if let (DhtRequest::GetMutable(key), Some(stream)) = (&job.request, &job.stream)
                    {
                        if let Some(Ok(record)) = native.shared_mutable_observation(key) {
                            if record.verify_for(key).is_ok() {
                                let value = result_json(&Ok(DhtOutcome::Mutable(Some(record))))
                                    .expect("signed shared observation");
                                if job.observed.as_ref() != Some(&value) {
                                    stream.send_replace(Update::Record(value.clone()));
                                    job.observed = Some(value);
                                }
                            }
                        }
                    }
                    deferred.push(job);
                }
                Err(error) => {
                    if let Some(stream) = job.stream {
                        stream.send_replace(Update::Done(Err(native_error(&error))));
                    }
                    let _ = job.reply.send(Err(native_error(&error)));
                }
            }
        }
        // Retry at most once per actor pass; one occupied target must not spin
        // or prevent unrelated queued identities from making progress.
        for job in deferred {
            if (job.reply.is_closed() && job.stream.as_ref().is_none_or(Updates::is_closed))
                || *job.stopped.borrow()
            {
                continue;
            }
            if let Err(error) = self.tx.try_send(job) {
                let (job, failure) = match error {
                    mpsc::TrySendError::Full(job) => (job, overloaded()),
                    mpsc::TrySendError::Disconnected(job) => (job, unavailable()),
                };
                if let Some(stream) = job.stream {
                    stream.send_replace(Update::Done(Err(failure.clone())));
                }
                let _ = job.reply.send(Err(failure));
            }
        }
        for (id, pending) in &mut self.pending {
            pending.streams.retain(|s| !s.is_closed());
            if pending.resolved || pending.streams.is_empty() {
                continue;
            }
            match native.mutable_observation(DhtRequestId(*id)) {
                Some(Ok(record)) => {
                    let value = result_json(&Ok(DhtOutcome::Mutable(Some(record))))
                        .expect("mutable observation");
                    if pending.observation.as_ref() != Some(&value) {
                        for stream in &pending.streams {
                            stream.send_replace(Update::Record(value.clone()));
                        }
                        pending.observation = Some(value);
                    }
                }
                Some(Err(error)) => {
                    for stream in pending.streams.drain(..) {
                        stream.send_replace(Update::Done(Err(native_error(&error))));
                    }
                }
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
