use super::{ffi, LibtorrentBackend};
use feedtorrent_bep::bep44::*;
use std::{
    collections::{BTreeMap, HashMap},
    time::Instant,
};

#[derive(Default)]
pub(super) struct DhtState {
    next: u64,
    closed: bool,
    requests: BTreeMap<u64, Pending>,
    targets: HashMap<Target, DhtRequestId>,
    events: Vec<DhtEvent>,
}
struct Pending {
    request: DhtRequest,
    deadline: Instant,
    reported: bool,
    best: Option<MutableRecord>,
    immutable: Option<ImmutableItem>,
    error: Option<DhtError>,
}
impl DhtState {
    fn shared_mutable_observation(
        &self,
        key: &MutableKey,
    ) -> Option<Result<MutableRecord, DhtError>> {
        if self.closed {
            return None;
        }
        let id = self.targets.get(&key.target())?;
        let pending = self.requests.get(&id.0)?;
        if pending.reported {
            return None;
        }
        let candidate = match &pending.request {
            DhtRequest::GetMutable(expected) if expected == key => pending.best.as_ref(),
            DhtRequest::PutMutable(record) if record.key() == key => Some(record),
            _ => return None,
        };
        if let Some(error) = &pending.error {
            return Some(Err(error.clone()));
        }
        candidate.cloned().map(Ok)
    }
}
impl Pending {
    fn update(&mut self, event: &ffi::NativeDhtEvent) -> Result<(), DhtError> {
        if event.conflict {
            return Err(DhtError::Conflict);
        }
        if !event.has_value {
            return Ok(());
        }
        let value = BencodedValue::parse(&event.value).map_err(DhtError::InvalidRecord)?;
        match &self.request {
            DhtRequest::GetImmutable(target) => {
                self.immutable =
                    Some(ImmutableItem::verify(*target, value).map_err(DhtError::InvalidRecord)?);
            }
            DhtRequest::GetMutable(expected) => {
                let pk = event
                    .key
                    .as_slice()
                    .try_into()
                    .map_err(|_| DhtError::InvalidRecord(ValidationError::InvalidKey))?;
                let sig = event
                    .signature
                    .as_slice()
                    .try_into()
                    .map_err(|_| DhtError::InvalidRecord(ValidationError::InvalidSignature))?;
                let key =
                    MutableKey::new(pk, event.salt.clone()).map_err(DhtError::InvalidRecord)?;
                let record = MutableRecord::verify(key, event.sequence, value, sig)
                    .map_err(DhtError::InvalidRecord)?;
                record
                    .verify_for(expected)
                    .map_err(DhtError::InvalidRecord)?;
                if self
                    .best
                    .as_ref()
                    .is_none_or(|b| record.sequence() >= b.sequence())
                {
                    self.best = Some(
                        select_mutable(self.best.as_ref(), record)
                            .map_err(|_| DhtError::Conflict)?,
                    );
                }
            }
            _ => return Err(DhtError::Backend("Unexpected lookup value".into())),
        }
        Ok(())
    }
    fn finish(&mut self, event: &ffi::NativeDhtEvent) -> Result<DhtOutcome, DhtError> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        match &self.request {
            DhtRequest::GetImmutable(_) => Ok(DhtOutcome::Immutable(self.immutable.take())),
            DhtRequest::GetMutable(_) => Ok(DhtOutcome::Mutable(self.best.take())),
            _ if event.acknowledged_nodes == 0 => Err(DhtError::NoAcknowledgements),
            _ => Ok(DhtOutcome::Stored {
                target: self.request.target(),
                acknowledged_nodes: event.acknowledged_nodes,
            }),
        }
    }
}
impl LibtorrentBackend {
    /// Includes native traversals still draining after a reported timeout.
    pub fn dht_request_pending(&self, id: DhtRequestId) -> bool {
        self.dht.requests.contains_key(&id.0)
    }
    /// Best authenticated observation so far; does not consume or complete a request.
    /// Only the owning actor may inspect it. `poll_dht` still emits one final event.
    pub fn dht_mutable_observation(
        &self,
        id: DhtRequestId,
    ) -> Option<Result<MutableRecord, DhtError>> {
        let pending = self.dht.requests.get(&id.0)?;
        if pending.reported || !matches!(pending.request, DhtRequest::GetMutable(_)) {
            return None;
        }
        if let Some(error) = &pending.error {
            return Some(Err(error.clone()));
        }
        pending.best.clone().map(Ok)
    }
    /// Signed candidate from another active operation on this exact key/salt.
    /// Reads expose only authenticated observations; puts expose their verified
    /// signed input, not an acknowledgement or a claim of network freshness.
    /// Does not pump, consume events, complete or cancel the owning operation.
    pub fn dht_shared_mutable_observation(
        &self,
        key: &MutableKey,
    ) -> Option<Result<MutableRecord, DhtError>> {
        self.dht.shared_mutable_observation(key)
    }
    fn pump_dht(&mut self) {
        if self.dht.closed {
            return;
        }
        match self.session.pin_mut().dht_poll() {
            Ok(events) => {
                for event in events {
                    if let Some(mut pending) = self.dht.requests.remove(&event.id) {
                        if !pending.reported {
                            if let Err(error) = pending.update(&event) {
                                pending.error = Some(error);
                            }
                        }
                        if event.terminal {
                            if !pending.reported {
                                self.dht.events.push(DhtEvent {
                                    id: DhtRequestId(event.id),
                                    result: pending.finish(&event),
                                });
                            }
                            self.dht.targets.remove(&pending.request.target());
                            self.session.pin_mut().dht_release(event.id);
                        } else {
                            self.dht.requests.insert(event.id, pending);
                        }
                    }
                }
            }
            Err(error) => {
                for (&id, pending) in &mut self.dht.requests {
                    if !pending.reported {
                        pending.reported = true;
                        self.dht.events.push(DhtEvent {
                            id: DhtRequestId(id),
                            result: Err(DhtError::Backend(error.to_string())),
                        });
                    }
                }
            }
        }
        let now = Instant::now();
        for (&id, pending) in &mut self.dht.requests {
            if !pending.reported && now >= pending.deadline {
                pending.reported = true;
                self.dht.events.push(DhtEvent {
                    id: DhtRequestId(id),
                    result: Err(DhtError::Timeout),
                });
            }
        }
    }
    pub(super) fn close_dht(&mut self) {
        if self.dht.closed {
            return;
        }
        self.dht.closed = true;
        for (id, pending) in std::mem::take(&mut self.dht.requests) {
            if !pending.reported {
                self.dht.events.push(DhtEvent {
                    id: DhtRequestId(id),
                    result: Err(DhtError::Closed),
                });
            }
            self.session.pin_mut().dht_release(id);
        }
        self.dht.targets.clear();
    }
}
impl DhtBackend for LibtorrentBackend {
    fn start_dht(
        &mut self,
        request: DhtRequest,
        options: DhtOptions,
    ) -> Result<DhtRequestId, DhtError> {
        self.pump_dht();
        if self.dht.closed {
            return Err(DhtError::Closed);
        }
        if options.timeout.is_zero() {
            return Err(DhtError::InvalidInput("Timeout must be positive".into()));
        }
        let deadline = Instant::now()
            .checked_add(options.timeout)
            .ok_or_else(|| DhtError::InvalidInput("Timeout too large".into()))?;
        if self.dht.targets.contains_key(&request.target()) {
            return Err(DhtError::Busy);
        }
        if !self.session.dht_ready() {
            return Err(DhtError::NotReady);
        }
        let next = self
            .dht
            .next
            .checked_add(1)
            .ok_or_else(|| DhtError::Backend("Request IDs exhausted".into()))?;
        let mut native = ffi::NativeDhtRequest {
            id: next,
            kind: 0,
            target: request.target().to_vec(),
            key: vec![],
            signature: vec![],
            salt: vec![],
            value: vec![],
            sequence: 0,
        };
        match &request {
            DhtRequest::GetImmutable(_) => {}
            DhtRequest::GetMutable(key) => {
                native.kind = 1;
                native.key = key.public_key().to_vec();
                native.salt = key.salt().to_vec();
            }
            DhtRequest::PutImmutable(item) => {
                native.kind = 2;
                native.value = item.value().as_bytes().to_vec();
            }
            DhtRequest::PutMutable(item) => {
                native.kind = 3;
                native.key = item.key().public_key().to_vec();
                native.salt = item.key().salt().to_vec();
                native.value = item.value().as_bytes().to_vec();
                native.signature = item.signature().to_vec();
                native.sequence = item.sequence();
            }
        }
        self.session
            .pin_mut()
            .dht_start(&native)
            .map_err(|e| DhtError::Backend(e.to_string()))?;
        self.dht.next = next;
        self.dht
            .targets
            .insert(request.target(), DhtRequestId(next));
        self.dht.requests.insert(
            next,
            Pending {
                request,
                deadline,
                reported: false,
                best: None,
                immutable: None,
                error: None,
            },
        );
        Ok(DhtRequestId(next))
    }
    fn poll_dht(&mut self) -> Vec<DhtEvent> {
        self.pump_dht();
        std::mem::take(&mut self.dht.events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn native(record: Option<&MutableRecord>, terminal: bool) -> ffi::NativeDhtEvent {
        ffi::NativeDhtEvent {
            id: 1,
            terminal,
            has_value: record.is_some(),
            value: record
                .map(|r| r.value().as_bytes().to_vec())
                .unwrap_or_default(),
            key: record
                .map(|r| r.key().public_key().to_vec())
                .unwrap_or_default(),
            signature: record.map(|r| r.signature().to_vec()).unwrap_or_default(),
            salt: record.map(|r| r.key().salt().to_vec()).unwrap_or_default(),
            sequence: record.map(|r| r.sequence()).unwrap_or_default(),
            acknowledged_nodes: 0,
            conflict: false,
        }
    }
    #[test]
    fn final_mutable_alert_cannot_discard_a_better_candidate() {
        let signer = Bep44Signer::from_seed(&[9; 32]);
        let value = BencodedValue::bytestring(b"one").unwrap();
        let high = signer.sign(value.clone(), 9, vec![]).unwrap();
        let low = signer.sign(value, 2, vec![]).unwrap();
        for final_record in [Some(&low), None] {
            let mut pending = Pending {
                request: DhtRequest::GetMutable(high.key().clone()),
                deadline: Instant::now(),
                reported: false,
                best: None,
                immutable: None,
                error: None,
            };
            pending.update(&native(Some(&high), false)).unwrap();
            let end = native(final_record, true);
            pending.update(&end).unwrap();
            assert_eq!(
                pending.finish(&end).unwrap(),
                DhtOutcome::Mutable(Some(high.clone()))
            );
        }
    }
    #[test]
    fn shared_get_and_put_candidates_keep_their_owner_and_exact_identity() {
        let signer = Bep44Signer::from_seed(&[9; 32]);
        let record = signer
            .sign(BencodedValue::bytestring(b"one").unwrap(), 9, vec![1])
            .unwrap();
        let wrong = MutableKey::new(signer.public_key(), vec![2]).unwrap();
        for put in [false, true] {
            let mut state = DhtState::default();
            state.targets.insert(record.key().target(), DhtRequestId(1));
            let mut pending = Pending {
                request: if put {
                    DhtRequest::PutMutable(record.clone())
                } else {
                    DhtRequest::GetMutable(record.key().clone())
                },
                deadline: Instant::now(),
                reported: false,
                best: None,
                immutable: None,
                error: None,
            };
            if !put {
                assert!(pending.best.is_none());
                pending.update(&native(Some(&record), false)).unwrap();
            }
            state.requests.insert(1, pending);
            state.events.push(DhtEvent {
                id: DhtRequestId(99),
                result: Err(DhtError::Busy),
            });
            for _ in 0..3 {
                assert_eq!(
                    state.shared_mutable_observation(record.key()),
                    Some(Ok(record.clone()))
                );
            }
            assert_eq!(state.events.len(), 1);
            assert_eq!(state.requests.len(), 1);
            // Even a forced target collision cannot cross the public-key/salt boundary.
            state.targets.insert(wrong.target(), DhtRequestId(1));
            assert_eq!(state.shared_mutable_observation(&wrong), None);
            state.requests.get_mut(&1).unwrap().error = Some(DhtError::Conflict);
            assert_eq!(
                state.shared_mutable_observation(record.key()),
                Some(Err(DhtError::Conflict))
            );
            state.requests.get_mut(&1).unwrap().reported = true;
            assert_eq!(state.shared_mutable_observation(record.key()), None);
            state.requests.get_mut(&1).unwrap().reported = false;
            state.closed = true;
            assert_eq!(state.shared_mutable_observation(record.key()), None);
        }
    }
    #[test]
    fn invalid_native_signature_is_never_a_shared_observation() {
        let record = Bep44Signer::from_seed(&[9; 32])
            .sign(BencodedValue::bytestring(b"one").unwrap(), 9, vec![])
            .unwrap();
        let mut pending = Pending {
            request: DhtRequest::GetMutable(record.key().clone()),
            deadline: Instant::now(),
            reported: false,
            best: None,
            immutable: None,
            error: None,
        };
        let mut forged = native(Some(&record), false);
        forged.signature[0] ^= 1;
        pending.error = Some(pending.update(&forged).unwrap_err());
        assert!(pending.best.is_none());
        let mut state = DhtState::default();
        state.targets.insert(record.key().target(), DhtRequestId(1));
        state.requests.insert(1, pending);
        assert!(matches!(
            state.shared_mutable_observation(record.key()),
            Some(Err(DhtError::InvalidRecord(_)))
        ));
    }
}
