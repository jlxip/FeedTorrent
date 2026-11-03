use super::*;
use feedtorrent_bep::bep44::{DhtBackend, DhtError, DhtEvent, DhtOptions, DhtOutcome, DhtRequest};
// Public-network traversals include discovery and both address families.
// These are application policy; the portable BEP44 default stays unchanged.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(120);
const PUT_TIMEOUT: Duration = Duration::from_secs(180);
#[derive(Debug)]
pub enum Failure {
    Dht(DhtError),
    Other(String),
    Unavailable(String),
}
impl Failure {
    pub fn transient(&self) -> bool {
        matches!(
            self,
            Self::Unavailable(_)
                | Self::Dht(
                    DhtError::Closed
                        | DhtError::Busy
                        | DhtError::NotReady
                        | DhtError::Timeout
                        | DhtError::NoAcknowledgements
                        | DhtError::Backend(_)
                )
        )
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Dht(e) => write!(f, "{e}"),
            Self::Other(e) | Self::Unavailable(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for Failure {}
impl From<String> for Failure {
    fn from(s: String) -> Self {
        Self::Other(s)
    }
}
impl From<&str> for Failure {
    fn from(s: &str) -> Self {
        Self::Other(s.into())
    }
}
pub struct Seed {
    pub id: String,
    pub metainfo: Vec<u8>,
    pub path: PathBuf,
}
pub enum Native {
    Lookup(MutableKey),
    Put(MutableRecord),
    Seed(Vec<Seed>),
    Ready(Vec<String>),
    Location(String),
}
pub enum NativeReply {
    Record(Option<SignedRecord>),
    Stored(u32),
    Ready,
    Location(PathBuf),
}
pub struct NativeTask {
    pub command: Native,
    pub reply: mpsc::Sender<std::result::Result<NativeReply, Failure>>,
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}
type NativeSender = mpsc::Sender<std::result::Result<NativeReply, Failure>>;
type DhtPending = (
    Option<MutableRecord>,
    NativeSender,
    Arc<std::sync::atomic::AtomicBool>,
);
struct Checking {
    cancel: Arc<std::sync::atomic::AtomicBool>,
    after_refresh: u64,
    ids: Vec<String>,
    deadline: Instant,
    reply: mpsc::Sender<std::result::Result<NativeReply, Failure>>,
}
pub struct Bridge {
    rx: mpsc::Receiver<NativeTask>,
    dht: BTreeMap<u64, DhtPending>,
    checking: Vec<Checking>,
}
impl Bridge {
    pub fn new(rx: mpsc::Receiver<NativeTask>) -> Self {
        Self {
            rx,
            dht: BTreeMap::new(),
            checking: vec![],
        }
    }
    pub fn event(&mut self, event: &DhtEvent, host: &mut feeds::FeedHost) -> bool {
        let Some((record, reply, cancel)) = self.dht.remove(&event.id.0) else {
            return false;
        };
        if cancel.load(Ordering::Acquire) {
            return true;
        }
        let result = match &event.result {
            Ok(DhtOutcome::Mutable(record)) => Ok(NativeReply::Record(
                record.as_ref().map(SignedRecord::from_record),
            )),
            Ok(DhtOutcome::Stored {
                acknowledged_nodes, ..
            }) if *acknowledged_nodes > 0 => {
                if let Some(record) = record {
                    host.publish_record(record);
                }
                Ok(NativeReply::Stored(*acknowledged_nodes))
            }
            Ok(_) => Err(Failure::Dht(DhtError::NoAcknowledgements)),
            Err(e) => Err(Failure::Dht(e.clone())),
        };
        let _ = reply.send(result);
        true
    }
    pub fn tick(&mut self, e: &mut Engine) {
        for _ in 0..8 {
            let Ok(task) = self.rx.try_recv() else { break };
            if task.cancel.load(Ordering::Acquire) {
                continue;
            }
            let reply = task.reply;
            let cancel = task.cancel;
            match task.command {
                Native::Lookup(key) => match e.native.start_dht(
                    DhtRequest::GetMutable(key),
                    DhtOptions {
                        timeout: LOOKUP_TIMEOUT,
                    },
                ) {
                    Ok(id) => {
                        self.dht.insert(id.0, (None, reply, cancel));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(Failure::Dht(err)));
                    }
                },
                Native::Put(record) => match e.native.start_dht(
                    DhtRequest::PutMutable(record.clone()),
                    DhtOptions {
                        timeout: PUT_TIMEOUT,
                    },
                ) {
                    Ok(id) => {
                        self.dht.insert(id.0, (Some(record), reply, cancel));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(Failure::Dht(err)));
                    }
                },
                Native::Location(id) => {
                    let result = if let Ok(r) = e.record(&id) {
                        Ok(r.path.clone())
                    } else {
                        payload_path(&e.store.settings.download_dir, &id)
                    };
                    let _ = reply.send(
                        result
                            .map(NativeReply::Location)
                            .map_err(|err| Failure::Other(err.to_string())),
                    );
                }
                Native::Seed(seeds) => {
                    let result = (|| -> Result<Vec<String>> {
                        let mut ids = vec![];
                        for s in seeds {
                            if e.native.inspect(TorrentSource::Torrent(&s.metainfo))? != s.id {
                                bail!("Catalog identity mismatch")
                            }
                            if let Ok(existing) = e.record(&s.id) {
                                if !existing.active {
                                    bail!("Catalog is paused; resume it before publishing")
                                };
                                e.native.remove(&s.id)?;
                            }
                            atomic(&e.dir.join(format!("{}.source", s.id)), &s.metainfo)?;
                            e.native.add(AddTransfer {
                                id: &s.id,
                                source: TorrentSource::Torrent(&s.metainfo),
                                save_path: s.path.to_str().context("Non-UTF-8 catalog path")?,
                                active: true,
                                restore: true,
                            })?;
                            if let Some(record) = e.store.records.iter_mut().find(|r| r.id == s.id)
                            {
                                record.seed = true;
                                record.held = false;
                            } else {
                                e.store.records.push(Record {
                                    id: s.id.clone(),
                                    magnet: false,
                                    path: s.path,
                                    active: true,
                                    seed: true,
                                    held: false,
                                    kind: "owned_catalog".into(),
                                    feed: None,
                                })
                            }
                            e.persist()?;
                            ids.push(s.id);
                        }
                        Ok(ids)
                    })();
                    match result {
                        Ok(ids) => self.checking.push(Checking {
                            cancel,
                            ids,
                            deadline: Instant::now() + Duration::from_secs(120),
                            after_refresh: e.refresh_serial.wrapping_add(1),
                            reply,
                        }),
                        Err(err) => {
                            let _ = reply.send(Err(Failure::Other(err.to_string())));
                        }
                    }
                }
                Native::Ready(ids) => self.checking.push(Checking {
                    cancel,
                    ids,
                    deadline: Instant::now() + Duration::from_secs(120),
                    after_refresh: e.refresh_serial.wrapping_add(1),
                    reply,
                }),
            }
        }
        let mut pending = vec![];
        for c in self.checking.drain(..) {
            if c.cancel.load(Ordering::Acquire) {
                continue;
            }
            if e.refresh_serial < c.after_refresh && Instant::now() < c.deadline {
                pending.push(c);
                continue;
            }
            let mut complete = true;
            let mut error = None;
            for id in &c.ids {
                match e.view.transfers.iter().find(|t| t.id == *id) {
                    Some(t) if !t.active || !t.error.is_empty() => {
                        error = Some(if t.error.is_empty() {
                            "Published catalog is paused".into()
                        } else {
                            t.error.clone()
                        });
                        break;
                    }
                    Some(t)
                        if t.progress == 1.0
                            && t.state != "Checking"
                            && t.files.iter().all(|f| f.ready) => {}
                    Some(_) => complete = false,
                    None if e.store.records.iter().any(|r| r.id == *id) => complete = false,
                    None => {
                        error = Some("Published catalog transfer was removed".into());
                        break;
                    }
                }
            }
            if error.is_none() && Instant::now() > c.deadline {
                error = Some("Catalog verification timed out".into())
            }
            if let Some(err) = error {
                let _ = c.reply.send(Err(Failure::Other(err)));
            } else if complete {
                let _ = c.reply.send(Ok(NativeReply::Ready));
            } else {
                pending.push(c)
            }
        }
        self.checking = pending;
    }
}
