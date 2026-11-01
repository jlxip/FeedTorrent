use super::{ffi, LibtorrentBackend};
use feedtorrent_core::bep44::*;
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
}
