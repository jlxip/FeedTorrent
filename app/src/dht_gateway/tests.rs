use super::*;
use std::collections::BTreeSet;

#[derive(Default)]
struct Backend {
    requests: BTreeSet<u64>,
    started: usize,
    busy: bool,
}
impl DhtBackend for Backend {
    fn start_dht(&mut self, request: DhtRequest, _: DhtOptions) -> Result<DhtRequestId, DhtError> {
        assert!(matches!(
            request,
            DhtRequest::GetImmutable(_) | DhtRequest::GetMutable(_)
        ));
        if self.busy {
            return Err(DhtError::Busy);
        }
        self.started += 1;
        let id = self.started as u64;
        self.requests.insert(id);
        Ok(DhtRequestId(id))
    }
    fn poll_dht(&mut self) -> Vec<DhtEvent> {
        panic!("gateway must never poll native events")
    }
}
impl Native for Backend {
    fn request_pending(&self, id: DhtRequestId) -> bool {
        self.requests.contains(&id.0)
    }
}
fn submit(g: &Gateway, key: u8) -> oneshot::Receiver<Result<Value, Failure>> {
    let (reply, result) = oneshot::channel();
    let (_, stopped) = watch::channel(false);
    g.tx.try_send(Job {
        request: DhtRequest::GetImmutable([key; 20]),
        reply,
        stopped,
    })
    .unwrap();
    result
}
#[test]
fn addresses_and_binary_contract() {
    assert!(!Config::default().enabled);
    for address in ["127.0.0.1:8793", "0.0.0.0:65535", "[::1]:1", "[::]:8793"] {
        assert!(Config {
            listen: address.into(),
            ..Config::default()
        }
        .address()
        .is_ok());
    }
    for address in [
        "localhost:8793",
        "127.0.0.1:0",
        "http://127.0.0.1:1",
        "[::1]",
        "127.0.0.1:65536",
    ] {
        assert!(Config {
            listen: address.into(),
            ..Config::default()
        }
        .address()
        .is_err());
    }
    assert_eq!(bytes("00FF80", Some(3)).unwrap(), [0, 255, 128]);
    assert!(bytes("f", None).is_err());
    assert!(bytes("é", None).is_err());
    assert!(bytes(&"00".repeat(65), None).is_err());
    let signer = Bep44Signer::from_seed(&[17; 32]);
    let value = BencodedValue::parse(b"d1:ali1e0:ee").unwrap();
    let record = signer.sign(value, i64::MAX, vec![0, 255]).unwrap();
    let result = result_json(&Ok(DhtOutcome::Mutable(Some(record.clone())))).unwrap();
    assert_eq!(result["sequence"], i64::MAX.to_string());
    assert_eq!(result["salt"], "00ff");
    assert_eq!(result["value"], hex(record.value().as_bytes()));
    assert_eq!(
        native_error(&DhtError::InvalidRecord(ValidationError::InvalidSignature)).0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(native_error(&DhtError::Conflict).0, StatusCode::CONFLICT);
    assert_eq!(
        result_json(&Ok(DhtOutcome::Immutable(None))).unwrap_err().0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        native_error(&DhtError::Timeout).0,
        StatusCode::GATEWAY_TIMEOUT
    );
}
#[tokio::test]
async fn coalescing_timeout_slots_backpressure_and_internal_events() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend::default();
    let a = submit(&g, 1);
    let b = submit(&g, 1);
    g.tick(&mut native);
    assert_eq!(native.started, 1);
    assert!(!g.event(&DhtEvent {
        id: DhtRequestId(100),
        result: Err(DhtError::Busy)
    }));
    assert!(g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Err(DhtError::Timeout)
    }));
    assert_eq!(a.await.unwrap().unwrap_err().0, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(b.await.unwrap().unwrap_err().0, StatusCode::GATEWAY_TIMEOUT);
    for key in 2..=8 {
        let result = submit(&g, key);
        g.tick(&mut native);
        drop(result);
    }
    assert_eq!(native.started, 8);
    let excess = submit(&g, 9);
    g.tick(&mut native);
    assert_eq!(
        excess.await.unwrap().unwrap_err().0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let same = submit(&g, 1);
    g.tick(&mut native);
    assert_eq!(
        same.await.unwrap().unwrap_err().0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    native.requests.remove(&1);
    let next = submit(&g, 9);
    g.tick(&mut native);
    assert_eq!(native.started, 9);
    native.requests.remove(&9);
    g.event(&DhtEvent {
        id: DhtRequestId(9),
        result: Ok(DhtOutcome::Immutable(None)),
    });
    assert_eq!(next.await.unwrap().unwrap_err().0, StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn closed_clients_and_native_busy_do_not_start_work() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend::default();
    drop(submit(&g, 1));
    g.tick(&mut native);
    assert_eq!(native.started, 0);
    native.busy = true;
    let result = submit(&g, 2);
    g.tick(&mut native);
    assert_eq!(
        result.await.unwrap().unwrap_err().0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(g.pending.is_empty());
}

#[tokio::test]
async fn http_waiter_limit_and_shutdown_release_responses() {
    let (jobs, rx) = mpsc::sync_channel(RESPONSES);
    let permits = Arc::new(Semaphore::new(RESPONSES));
    let (stop, stopped) = watch::channel(false);
    let state = HttpState {
        jobs,
        permits: permits.clone(),
        stopped,
    };
    let reserved = permits
        .clone()
        .acquire_many_owned(RESPONSES as u32)
        .await
        .unwrap();
    let response = lookup(state.clone(), DhtRequest::GetImmutable([1; 20])).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(rx.try_recv().is_err());
    drop(reserved);
    let task = tokio::spawn(lookup(state, DhtRequest::GetImmutable([1; 20])));
    let job = loop {
        if let Ok(job) = rx.try_recv() {
            break job;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(permits.available_permits(), RESPONSES - 1);
    stop.send_replace(true);
    assert_eq!(
        task.await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(permits.available_permits(), RESPONSES);
    assert!(job.reply.is_closed());
}

#[test]
fn legacy_settings_leave_the_gateway_disabled() {
    let mut value = serde_json::to_value(crate::default_store()).unwrap();
    value["settings"]
        .as_object_mut()
        .unwrap()
        .remove("dht_gateway");
    let store: crate::Store = serde_json::from_value(value).unwrap();
    assert_eq!(store.settings.dht_gateway, Config::default());
    assert!(bytes("+1", Some(1)).is_err());
}
