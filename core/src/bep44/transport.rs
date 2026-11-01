use super::{ImmutableItem, MutableKey, MutableRecord, Target, ValidationError};
use std::{fmt, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DhtRequestId(pub u64);
#[derive(Clone, Copy, Debug)]
pub struct DhtOptions {
    pub timeout: Duration,
}
impl Default for DhtOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
        }
    }
}
#[derive(Clone, Debug)]
pub enum DhtRequest {
    GetImmutable(Target),
    PutImmutable(ImmutableItem),
    GetMutable(MutableKey),
    PutMutable(MutableRecord),
}
impl DhtRequest {
    pub fn target(&self) -> Target {
        match self {
            Self::GetImmutable(t) => *t,
            Self::PutImmutable(i) => i.target(),
            Self::GetMutable(k) => k.target(),
            Self::PutMutable(i) => i.key().target(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DhtOutcome {
    Immutable(Option<ImmutableItem>),
    Mutable(Option<MutableRecord>),
    /// Acknowledgements observed during this publication, not durable availability.
    Stored {
        target: Target,
        acknowledged_nodes: u32,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DhtError {
    InvalidInput(String),
    InvalidRecord(ValidationError),
    Closed,
    NotReady,
    Busy,
    Timeout,
    NoAcknowledgements,
    Conflict,
    Backend(String),
}
impl fmt::Display for DhtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DHT: {self:?}")
    }
}
impl std::error::Error for DhtError {}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DhtEvent {
    pub id: DhtRequestId,
    pub result: Result<DhtOutcome, DhtError>,
}
/// Poll from the owning actor. Each accepted request has exactly one final event.
/// Operations on one target are serialized; different targets may run concurrently.
/// A timeout ends the request, but its target remains busy until native completion
/// or session shutdown. Polling does not wait for network responses.
/// Mutable results are the best valid record observed, not a global latest version.
pub trait DhtBackend {
    fn start_dht(
        &mut self,
        request: DhtRequest,
        options: DhtOptions,
    ) -> Result<DhtRequestId, DhtError>;
    fn poll_dht(&mut self) -> Vec<DhtEvent>;
}
