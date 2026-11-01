//! BEP50 draft publish/subscribe, without sockets, system clocks or OS entropy.
//!
//! Times are monotonic milliseconds supplied by the host. Call `advance` and
//! drain outputs regularly. This overlay does not implicitly publish to BEP44's
//! Mainline store, interpret BEP46/49, or download torrents. Acceptance of a
//! publication is local, not delivery or durable availability.
//!
//! ```
//! use feedtorrent_bep::{bep44::{Bep44Signer,BencodedValue},bep50::{PubSub,Config}};
//! let signer = Bep44Signer::from_seed(&[7;32]);
//! let record = signer.sign(BencodedValue::bytestring(b"update")?,1,vec![])?;
//! // The host supplies independent secure node identity and protocol entropy.
//! let mut node = PubSub::new([1;20],[2;32],Config::default())?;
//! node.subscribe(record.key().clone(),None,0)?;
//! node.publish(record,0)?;
//! assert!(node.latest(signer.sign(BencodedValue::bytestring(b"update")?,1,vec![])?.key().target()).is_some());
//! # Ok::<(),Box<dyn std::error::Error>>(())
//! ```
mod routing;
mod wire;
use crate::bep44::{
    select_mutable, BencodedValue, MutableKey, MutableRecord, Target, ValidationError,
};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use std::{
    collections::{BTreeMap, VecDeque},
    net::{IpAddr, SocketAddr},
};
use wire::{array, as_dict, bytes, dict, get, int, raw, Dict, V};
use zeroize::Zeroizing;
pub const MAX_DATAGRAM: usize = 4096;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Malformed,
    InvalidRecord(ValidationError),
    NotSubscribed,
    Closed,
    Timeout,
    Capacity,
    InvalidConfig,
    Remote(i64),
    Transport(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BEP50: {self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Debug)]
pub struct Config {
    pub rpc_timeout_ms: u64,
    pub maintenance_ms: u64,
    pub discovery_ms: u64,
    pub retry_ms: u64,
    pub token_period_ms: u64,
    pub max_transactions: usize,
    pub max_topic_transactions: usize,
    pub max_datagrams: usize,
    pub batch: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            rpc_timeout_ms: 5000,
            maintenance_ms: 900_000,
            discovery_ms: 600_000,
            retry_ms: 5000,
            token_period_ms: 300_000,
            max_transactions: 1024,
            max_topic_transactions: 64,
            max_datagrams: 1024,
            batch: 64,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Updated {
        topic: Target,
        record: MutableRecord,
    },
    Failure {
        topic: Target,
        peer: Option<SocketAddr>,
        error: Error,
    },
    Acknowledged {
        topic: Target,
        peer: SocketAddr,
        sequence: i64,
    },
}
#[derive(Clone, Debug)]
pub struct Datagram {
    pub topic: Target,
    pub destination: SocketAddr,
    /// Only queries expire; responses are best-effort and have no local RPC.
    pub deadline_ms: Option<u64>,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct DiscoveryAction {
    pub topic: Target,
}
/// Mainline discovery produces hints, not verified PubSub participants. Native
/// libtorrent exposes neither completion nor acknowledgement counts here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerHints {
    pub topic: Target,
    pub peers: Vec<SocketAddr>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoveryError {
    InvalidInput,
    Closed,
    NotReady,
    Backend(String),
}
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Discovery: {self:?}")
    }
}
impl std::error::Error for DiscoveryError {}
pub trait DhtPeerDiscoveryBackend {
    fn discover_peers(&mut self, topic: Target) -> Result<(), DiscoveryError>;
    fn announce_peer(&mut self, topic: Target, udp_port: u16) -> Result<(), DiscoveryError>;
    fn poll_peer_hints(&mut self) -> Result<Vec<PeerHints>, DiscoveryError>;
}
struct Peer {
    find_due: u64,
    token: Option<Vec<u8>>,
    next: u64,
    sent: i64,
    failures: u8,
}
struct Topic {
    key: MutableKey,
    latest: Option<MutableRecord>,
    v4: routing::Routing,
    v6: routing::Routing,
    peers: BTreeMap<SocketAddr, Peer>,
    discovery_due: u64,
    discovery_pending: bool,
    retry: u64,
}
impl Topic {
    fn route(&self, addr: SocketAddr) -> &routing::Routing {
        if addr.is_ipv4() {
            &self.v4
        } else {
            &self.v6
        }
    }
    fn route_mut(&mut self, addr: SocketAddr) -> &mut routing::Routing {
        if addr.is_ipv4() {
            &mut self.v4
        } else {
            &mut self.v6
        }
    }
    fn hint(&mut self, addr: SocketAddr, now: u64) {
        if usable(addr) && self.peers.len() < 512 {
            self.peers.entry(addr).or_insert(Peer {
                find_due: now,
                token: None,
                next: now,
                sent: -1,
                failures: 0,
            });
        }
    }
}
#[derive(Clone)]
enum Kind {
    Get,
    Put(i64),
    Ping,
    Find,
}
struct Pending {
    topic: Target,
    peer: SocketAddr,
    deadline: u64,
    kind: Kind,
}
/// Owns secret protocol entropy (not author keys); deliberately no Debug/Clone.
pub struct PubSub {
    id: Target,
    secret: Zeroizing<[u8; 32]>,
    config: Config,
    now: u64,
    counter: u64,
    closed: bool,
    topics: BTreeMap<Target, Topic>,
    pending: BTreeMap<Vec<u8>, Pending>,
    out: VecDeque<Datagram>,
    updates: BTreeMap<Target, MutableRecord>,
    events: VecDeque<Event>,
}
pub(super) fn usable(a: SocketAddr) -> bool {
    a.port() != 0
        && !a.ip().is_unspecified()
        && !a.ip().is_multicast()
        && !matches!(a.ip(),IpAddr::V4(ip)if ip.is_broadcast())
}
impl PubSub {
    pub fn new(id: Target, entropy: [u8; 32], config: Config) -> Result<Self, Error> {
        if config.rpc_timeout_ms == 0
            || config.maintenance_ms == 0
            || config.discovery_ms == 0
            || config.retry_ms == 0
            || config.token_period_ms == 0
            || config.max_transactions == 0
            || config.max_topic_transactions == 0
            || config.max_datagrams == 0
            || config.batch == 0
        {
            return Err(Error::InvalidConfig);
        }
        Ok(Self {
            id,
            secret: Zeroizing::new(entropy),
            config,
            now: 0,
            counter: 0,
            closed: false,
            topics: BTreeMap::new(),
            pending: BTreeMap::new(),
            out: VecDeque::new(),
            updates: BTreeMap::new(),
            events: VecDeque::new(),
        })
    }
    fn clock(&mut self, now: u64) {
        self.now = self.now.max(now);
    }
    pub fn subscribe(
        &mut self,
        key: MutableKey,
        known: Option<MutableRecord>,
        now: u64,
    ) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        self.clock(now);
        let target = key.target();
        if let Some(r) = &known {
            r.verify_for(&key).map_err(Error::InvalidRecord)?
        }
        if self.topics.contains_key(&target) {
            return Ok(());
        }
        self.topics.insert(
            target,
            Topic {
                key,
                latest: known,
                v4: routing::Routing::new(self.id),
                v6: routing::Routing::new(self.id),
                peers: BTreeMap::new(),
                discovery_due: self.now,
                discovery_pending: true,
                retry: self.config.retry_ms,
            },
        );
        Ok(())
    }
    pub fn unsubscribe(&mut self, topic: Target) {
        self.topics.remove(&topic);
        self.pending.retain(|_, p| p.topic != topic);
        self.out.retain(|d| d.topic != topic);
        self.updates.remove(&topic);
        self.events.retain(|e| match e {
            Event::Updated { topic: t, .. }
            | Event::Failure { topic: t, .. }
            | Event::Acknowledged { topic: t, .. } => *t != topic,
        });
    }
    pub fn latest(&self, topic: Target) -> Option<&MutableRecord> {
        self.topics.get(&topic)?.latest.as_ref()
    }
    pub fn publish(&mut self, record: MutableRecord, now: u64) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        self.clock(now);
        let topic = record.key().target();
        self.accept(topic, record)?;
        self.advance(now);
        Ok(())
    }
    fn accept(&mut self, topic: Target, record: MutableRecord) -> Result<(), Error> {
        let t = self.topics.get_mut(&topic).ok_or(Error::NotSubscribed)?;
        record.verify_for(&t.key).map_err(Error::InvalidRecord)?;
        let record = select_mutable(t.latest.as_ref(), record).map_err(Error::InvalidRecord)?;
        let changed = t
            .latest
            .as_ref()
            .is_none_or(|r| r.sequence() < record.sequence());
        if changed {
            t.latest = Some(record.clone());
            self.updates.insert(topic, record);
        }
        Ok(())
    }
    pub fn discovered(&mut self, hints: PeerHints, now: u64) {
        self.clock(now);
        if let Some(t) = self.topics.get_mut(&hints.topic) {
            for addr in hints.peers.into_iter().take(512) {
                t.hint(addr, self.now);
            }
            if !t.peers.is_empty() {
                t.retry = self.config.retry_ms;
                t.discovery_due = self.now.saturating_add(self.config.discovery_ms);
            }
        }
    }
    pub fn drain_discovery(&mut self) -> Vec<DiscoveryAction> {
        self.topics
            .iter_mut()
            .filter_map(|(topic, t)| {
                if std::mem::take(&mut t.discovery_pending) {
                    Some(DiscoveryAction { topic: *topic })
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn drain_datagrams(&mut self) -> Vec<Datagram> {
        self.out
            .drain(..)
            .filter(|d| d.deadline_ms.is_none_or(|until| until > self.now))
            .collect()
    }
    pub fn drain_events(&mut self) -> Vec<Event> {
        let mut out: Vec<_> = std::mem::take(&mut self.updates)
            .into_iter()
            .map(|(topic, record)| Event::Updated { topic, record })
            .collect();
        out.extend(self.events.drain(..));
        out
    }
    fn event(&mut self, e: Event) {
        if self.events.len() < 1024 {
            self.events.push_back(e);
        }
    }
    pub fn transport_error(&mut self, topic: Target, peer: Option<SocketAddr>, message: String) {
        if self.topics.contains_key(&topic) {
            self.event(Event::Failure {
                topic,
                peer,
                error: Error::Transport(message),
            });
        }
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.topics.clear();
        self.pending.clear();
        self.out.clear();
        self.events.clear();
        self.updates.clear();
    }
    pub fn is_subscribed(&self, topic: Target) -> bool {
        self.topics.contains_key(&topic)
    }
    pub fn topics(&self) -> Vec<Target> {
        self.topics.keys().copied().collect()
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn queued_datagrams(&self) -> usize {
        self.out.len()
    }
    pub fn contacts(&self, topic: Target) -> Vec<(Target, SocketAddr)> {
        self.topics
            .get(&topic)
            .map(|t| {
                t.v4.contacts()
                    .chain(t.v6.contacts())
                    .map(|c| (c.id, c.addr))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// Call after draining outputs. Pending peers contribute their RPC deadline,
    /// never an already-consumed probe deadline that would spin the host.
    pub fn next_deadline(&self) -> Option<u64> {
        let mut next = self.pending.values().map(|p| p.deadline).min();
        for (topic, t) in &self.topics {
            let due = if t.discovery_pending {
                self.now
            } else {
                t.discovery_due
            };
            next = Some(next.map_or(due, |n| n.min(due)));
            for (addr, p) in &t.peers {
                if self
                    .pending
                    .values()
                    .any(|q| q.topic == *topic && q.peer == *addr)
                {
                    continue;
                }
                let newer = t.latest.as_ref().is_some_and(|r| r.sequence() > p.sent);
                let due = if newer && p.token.is_some() && t.route(*addr).contains(*addr) {
                    self.now
                } else {
                    p.next
                };
                next = Some(next.unwrap().min(due));
            }
        }
        next
    }
    fn mac(&self, label: &[u8], data: &[u8]) -> Vec<u8> {
        let mut m = Hmac::<Sha1>::new_from_slice(self.secret.as_ref()).expect("HMAC seed");
        m.update(label);
        m.update(data);
        m.finalize().into_bytes().to_vec()
    }
    fn token_data(&self, topic: Target, peer: SocketAddr, epoch: u64) -> Vec<u8> {
        let mut d = topic.to_vec();
        match peer.ip() {
            IpAddr::V4(ip) => {
                d.push(4);
                d.extend_from_slice(&ip.octets())
            }
            IpAddr::V6(ip) => {
                d.push(6);
                d.extend_from_slice(&ip.octets())
            }
        }
        d.extend_from_slice(&epoch.to_be_bytes());
        d
    }
    fn token(&self, topic: Target, peer: SocketAddr) -> Vec<u8> {
        self.mac(
            b"token",
            &self.token_data(topic, peer, self.now / self.config.token_period_ms),
        )
    }
    fn valid_token(&self, topic: Target, peer: SocketAddr, token: &[u8]) -> bool {
        let epoch = self.now / self.config.token_period_ms;
        [Some(epoch), epoch.checked_sub(1)]
            .into_iter()
            .flatten()
            .any(|e| {
                let mut m = Hmac::<Sha1>::new_from_slice(self.secret.as_ref()).expect("HMAC seed");
                m.update(b"token");
                m.update(&self.token_data(topic, peer, e));
                m.verify_slice(token).is_ok()
            })
    }
    fn send(&mut self, topic: Target, peer: SocketAddr, v: V) -> Result<(), Error> {
        if self.out.len() >= self.config.max_datagrams {
            return Err(Error::Capacity);
        }
        self.out.push_back(Datagram {
            topic,
            destination: peer,
            deadline_ms: None,
            bytes: wire::encode(&v)?,
        });
        Ok(())
    }
    fn query(&mut self, topic: Target, peer: SocketAddr, kind: Kind) -> Result<(), Error> {
        if self.pending.len() >= self.config.max_transactions
            || self.pending.values().filter(|p| p.topic == topic).count()
                >= self.config.max_topic_transactions
        {
            return Err(Error::Capacity);
        }
        self.counter = self.counter.checked_add(1).ok_or(Error::Capacity)?;
        // Unpredictable MAC prefix plus a monotonic suffix: no transaction reuse
        // across timeout, unsubscribe or resubscribe within this instance.
        let mut tx = self.mac(b"transaction", &self.counter.to_be_bytes());
        tx.extend_from_slice(&self.counter.to_be_bytes());
        let t = self.topics.get(&topic).ok_or(Error::NotSubscribed)?;
        let mut a = as_dict(&dict(&[(b"id", bytes(&self.id))]))?.clone();
        let method = match kind {
            Kind::Get => {
                a.insert(b"target".to_vec().into(), bytes(&topic));
                if let Some(r) = &t.latest {
                    a.insert(b"seq".to_vec().into(), V::Integer(r.sequence()));
                }
                b"get".as_slice()
            }
            Kind::Put(_) => {
                wire::add_record(&mut a, t.latest.as_ref().ok_or(Error::Malformed)?, true);
                a.insert(
                    b"token".to_vec().into(),
                    bytes(
                        t.peers
                            .get(&peer)
                            .and_then(|p| p.token.as_deref())
                            .ok_or(Error::Malformed)?,
                    ),
                );
                b"put"
            }
            Kind::Find => {
                let random: Target = self.mac(b"refresh", &tx).try_into().expect("SHA1 output");
                let target = t.route(peer).refresh_target(peer, random);
                a.insert(b"target".to_vec().into(), bytes(&target));
                a.insert(
                    b"want".to_vec().into(),
                    V::List(vec![bytes(b"n4"), bytes(b"n6")]),
                );
                b"find_node"
            }
            Kind::Ping => b"ping",
        };
        self.send(
            topic,
            peer,
            dict(&[
                (b"a", V::Dict(a)),
                (b"c", bytes(&topic)),
                (b"q", bytes(method)),
                (b"t", bytes(&tx)),
                (b"y", bytes(b"q")),
            ]),
        )?;
        if let Some(d) = self.out.back_mut() {
            d.deadline_ms = Some(self.now.saturating_add(self.config.rpc_timeout_ms));
        }
        self.pending.insert(
            tx,
            Pending {
                topic,
                peer,
                kind,
                deadline: self.now.saturating_add(self.config.rpc_timeout_ms),
            },
        );
        Ok(())
    }
    /// Advances protocol work without blocking. Unsent latest values remain
    /// coalesced in topic state when queues are full and are retried next poll.
    pub fn advance(&mut self, now: u64) {
        if self.closed {
            return;
        }
        self.clock(now);
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.deadline <= self.now)
            .map(|(tx, _)| tx.clone())
            .collect();
        for tx in expired {
            let p = self.pending.remove(&tx).unwrap();
            if let Some(t) = self.topics.get_mut(&p.topic) {
                t.route_mut(p.peer).failed(p.peer);
                if let Some(peer) = t.peers.get_mut(&p.peer) {
                    peer.failures += 1;
                    peer.token = None;
                    peer.next = self.now;
                }
                if t.peers.get(&p.peer).is_some_and(|p| p.failures >= 2) {
                    t.peers.remove(&p.peer);
                }
            }
            self.event(Event::Failure {
                topic: p.topic,
                peer: Some(p.peer),
                error: Error::Timeout,
            });
        }
        let mut work = vec![];
        for (topic, t) in &mut self.topics {
            if t.discovery_due <= self.now {
                t.discovery_pending = true;
                let wait = if t.peers.is_empty() {
                    let wait = t.retry;
                    t.retry = t.retry.saturating_mul(2).min(self.config.discovery_ms);
                    wait
                } else {
                    self.config.discovery_ms
                };
                // Stable per-node jitter, not wall clock or global RNG.
                t.discovery_due = self
                    .now
                    .saturating_add(wait)
                    .saturating_add((self.id[0] as u64 * wait) / 2560);
            }
            for (&addr, p) in &t.peers {
                if work.len() >= self.config.batch {
                    break;
                }
                if self
                    .pending
                    .values()
                    .any(|q| q.topic == *topic && q.peer == addr)
                {
                    continue;
                }
                let confirmed = t.route(addr).contains(addr);
                let stale = t
                    .route(addr)
                    .contacts()
                    .find(|c| c.addr == addr)
                    .is_some_and(|c| self.now.saturating_sub(c.seen) >= self.config.maintenance_ms);
                let latest = t.latest.as_ref().map_or(-1, |r| r.sequence());
                let kind = if confirmed && latest > p.sent && p.token.is_some() {
                    Some(Kind::Put(latest))
                } else if p.next <= self.now {
                    Some(if confirmed {
                        if stale {
                            Kind::Ping
                        } else if p.find_due <= self.now {
                            Kind::Find
                        } else {
                            Kind::Get
                        }
                    } else {
                        Kind::Ping
                    })
                } else {
                    None
                };
                if let Some(kind) = kind {
                    work.push((*topic, addr, kind));
                }
            }
        }
        for (topic, peer, kind) in work {
            if let Err(error) = self.query(topic, peer, kind) {
                self.event(Event::Failure {
                    topic,
                    peer: Some(peer),
                    error,
                });
                break;
            }
        }
    }
    pub fn receive(&mut self, peer: SocketAddr, packet: &[u8], now: u64) {
        if self.closed || !usable(peer) {
            return;
        }
        self.clock(now);
        let Ok(v) = wire::decode(packet) else { return };
        let Ok(d) = as_dict(&v) else { return };
        let Ok(topic) = get(d, b"c").and_then(array::<20>) else {
            return;
        };
        if !self.topics.contains_key(&topic) {
            return;
        }
        let Ok(tx) = get(d, b"t").and_then(raw) else {
            return;
        };
        if tx.is_empty() || tx.len() > 32 {
            return;
        }
        let Ok(y) = get(d, b"y").and_then(raw) else {
            return;
        };
        if y == b"q" {
            let result = self.request(topic, peer, d);
            let reply = match result {
                Ok(r) => dict(&[
                    (b"c", bytes(&topic)),
                    (b"r", r),
                    (b"t", bytes(tx)),
                    (b"y", bytes(b"r")),
                ]),
                Err(error) => {
                    let code = match &error {
                        Error::Remote(code) => *code,
                        Error::InvalidRecord(ValidationError::Rollback) => 302,
                        Error::InvalidRecord(ValidationError::Conflict) => 201,
                        Error::InvalidRecord(ValidationError::InvalidSignature) => 206,
                        Error::InvalidRecord(ValidationError::InvalidSalt) => 207,
                        Error::InvalidRecord(ValidationError::ValueTooLarge) => 205,
                        _ => 203,
                    };
                    self.event(Event::Failure {
                        topic,
                        peer: Some(peer),
                        error,
                    });
                    dict(&[
                        (b"c", bytes(&topic)),
                        (
                            b"e",
                            V::List(vec![V::Integer(code), bytes(b"Invalid PubSub request")]),
                        ),
                        (b"t", bytes(tx)),
                        (b"y", bytes(b"e")),
                    ])
                }
            };
            if let Err(error) = self.send(topic, peer, reply) {
                self.event(Event::Failure {
                    topic,
                    peer: Some(peer),
                    error,
                });
            }
        } else if y == b"r" || y == b"e" {
            if !self
                .pending
                .get(tx)
                .is_some_and(|p| p.topic == topic && p.peer == peer && p.deadline > self.now)
            {
                return;
            }
            if y == b"e" {
                if let Some(V::List(e)) = d.get(b"e".as_slice()) {
                    if let Some(V::Integer(code)) = e.first() {
                        self.pending.remove(tx);
                        if let Some(p) = self
                            .topics
                            .get_mut(&topic)
                            .and_then(|t| t.peers.get_mut(&peer))
                        {
                            p.token = None;
                            p.next = self.now.saturating_add(self.config.rpc_timeout_ms);
                        }
                        self.event(Event::Failure {
                            topic,
                            peer: Some(peer),
                            error: Error::Remote(*code),
                        });
                    }
                }
                return;
            }
            if let Ok(r) = get(d, b"r").and_then(as_dict) {
                if let Err(error) = self.response(topic, peer, tx, r) {
                    self.event(Event::Failure {
                        topic,
                        peer: Some(peer),
                        error,
                    });
                }
            }
        }
    }
    fn request(&mut self, topic: Target, peer: SocketAddr, d: &Dict) -> Result<V, Error> {
        let a = as_dict(get(d, b"a")?)?;
        let id = array::<20>(get(a, b"id")?)?;
        let method = raw(get(d, b"q")?)?;
        let mut r = as_dict(&dict(&[(b"id", bytes(&self.id))]))?.clone();
        match method {
            b"ping" => {}
            b"find_node" => {
                let target = array(get(a, b"target")?)?;
                self.add_nodes(topic, peer, target, a, &mut r);
            }
            b"get" => {
                if array::<20>(get(a, b"target")?)? != topic {
                    return Err(Error::Malformed);
                }
                let seq = a.get(b"seq".as_slice()).map(int).transpose()?;
                if seq.is_some_and(|s| s < 0) {
                    return Err(Error::Malformed);
                }
                r.insert(b"token".to_vec().into(), bytes(&self.token(topic, peer)));
                if let Some(record) = &self.topics[&topic].latest {
                    if seq.is_none_or(|s| s < record.sequence()) {
                        wire::add_record(&mut r, record, false)
                    } else {
                        r.insert(b"seq".to_vec().into(), V::Integer(record.sequence()));
                    }
                }
                self.add_nodes(topic, peer, topic, a, &mut r);
            }
            b"put" => {
                if !self.valid_token(topic, peer, raw(get(a, b"token")?)?) {
                    return Err(Error::Malformed);
                }
                let t = &self.topics[&topic];
                let record = wire::record(a, &t.key, false)?;
                if let (Some(v), Some(known)) = (a.get(b"cas".as_slice()), t.latest.as_ref()) {
                    if int(v)? != known.sequence() {
                        return Err(Error::Remote(301));
                    }
                }
                self.accept(topic, record)?;
            }
            _ => return Err(Error::Remote(204)),
        }
        if id != self.id {
            self.topics.get_mut(&topic).unwrap().hint(peer, self.now);
        }
        Ok(V::Dict(r))
    }
    fn add_nodes(&self, topic: Target, peer: SocketAddr, target: Target, a: &Dict, r: &mut Dict) {
        let want =
            a.get(b"want".as_slice())
                .and_then(|v| if let V::List(l) = v { Some(l) } else { None });
        for (v6, name, flag) in [
            (false, b"nodes".as_slice(), b"n4".as_slice()),
            (true, b"nodes6".as_slice(), b"n6".as_slice()),
        ] {
            if want.map_or(peer.is_ipv6() == v6, |l| {
                l.iter().any(|v| raw(v) == Ok(flag))
            }) {
                let t = &self.topics[&topic];
                let table = if v6 { &t.v6 } else { &t.v4 };
                r.insert(
                    name.to_vec().into(),
                    bytes(&wire::compact(table.closest(target).into_iter())),
                );
            }
        }
    }
    fn response(
        &mut self,
        topic: Target,
        peer: SocketAddr,
        tx: &[u8],
        r: &Dict,
    ) -> Result<(), Error> {
        let id = array::<20>(get(r, b"id")?)?;
        if id == self.id {
            return Err(Error::Malformed);
        }
        let mut hints = vec![];
        for (k, v6) in [(b"nodes".as_slice(), false), (b"nodes6".as_slice(), true)] {
            if let Some(v) = r.get(k) {
                hints.extend(wire::contacts(v, v6)?);
            }
        }
        let record = if r.contains_key(b"v".as_slice()) {
            Some(wire::record(r, &self.topics[&topic].key, true)?)
        } else {
            None
        };
        if let Some(v) = r.get(b"seq".as_slice()) {
            if int(v)? < 0 {
                return Err(Error::Malformed);
            }
        }
        if !r.contains_key(b"v".as_slice())
            && (r.contains_key(b"sig".as_slice()) || r.contains_key(b"k".as_slice()))
        {
            return Err(Error::Malformed);
        }
        let token = r.get(b"token".as_slice()).map(raw).transpose()?;
        if token.is_some_and(|t| t.is_empty() || t.len() > 128) {
            return Err(Error::Malformed);
        }
        if matches!(self.pending[tx].kind, Kind::Get) && token.is_none() {
            return Err(Error::Malformed);
        }
        if let Some(record) = record {
            if let Err(error) = self.accept(topic, record) {
                self.event(Event::Failure {
                    topic,
                    peer: Some(peer),
                    error,
                });
            }
        }
        let p = self.pending.remove(tx).unwrap();
        let t = self.topics.get_mut(&topic).unwrap();
        let admitted = t.route_mut(peer).confirm(id, peer, self.now);
        let known: Vec<_> =
            t.v4.contacts()
                .chain(t.v6.contacts())
                .map(|c| c.addr)
                .collect();
        // Drop displaced contacts' token/candidate state, bounding it separately.
        if t.peers.len() >= 512 {
            t.peers.retain(|a, _| known.contains(a));
        }
        if let Some(state) = t.peers.get_mut(&peer) {
            state.failures = 0;
            if let Some(token) = token {
                state.token = Some(token.to_vec());
            }
            state.next = self.now.saturating_add(self.config.maintenance_ms);
            match p.kind {
                Kind::Put(seq) => {
                    state.sent = state.sent.max(seq);
                    self.event(Event::Acknowledged {
                        topic,
                        peer,
                        sequence: seq,
                    });
                }
                Kind::Ping => {
                    state.next = self.now;
                }
                Kind::Find => {
                    state.find_due = self.now.saturating_add(self.config.maintenance_ms);
                    state.next = self.now;
                }
                Kind::Get if state.token.is_none() => {
                    state.next = self.now.saturating_add(self.config.rpc_timeout_ms);
                }
                _ => {}
            }
        }
        let t = self.topics.get_mut(&topic).unwrap();
        for (node, addr) in hints {
            if node != self.id {
                t.hint(addr, self.now);
            }
        }
        if admitted && matches!(p.kind, Kind::Ping) {
            self.query(topic, peer, Kind::Find)?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests;
