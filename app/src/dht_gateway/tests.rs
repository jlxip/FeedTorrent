use super::*;
use std::collections::BTreeSet;

#[derive(Default)]
struct Backend {
    requests: BTreeSet<u64>,
    started: usize,
    busy: bool,
    busy_target: Option<Target>,
    observation: Option<Result<MutableRecord, DhtError>>,
    shared: Option<Result<MutableRecord, DhtError>>,
}
impl DhtBackend for Backend {
    fn start_dht(&mut self, request: DhtRequest, _: DhtOptions) -> Result<DhtRequestId, DhtError> {
        assert!(matches!(
            request,
            DhtRequest::GetImmutable(_) | DhtRequest::GetMutable(_) | DhtRequest::PutMutable(_)
        ));
        if self.busy || self.busy_target == Some(request.target()) {
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
    fn mutable_observation(&self, _: DhtRequestId) -> Option<Result<MutableRecord, DhtError>> {
        self.observation.clone()
    }
    fn shared_mutable_observation(
        &self,
        _: &MutableKey,
    ) -> Option<Result<MutableRecord, DhtError>> {
        self.shared.clone()
    }
}
fn submit(g: &Gateway, key: u8) -> oneshot::Receiver<Result<Value, Failure>> {
    let (reply, result) = oneshot::channel();
    let (_, stopped) = watch::channel(false);
    g.tx.try_send(Job {
        request: DhtRequest::GetImmutable([key; 20]),
        reply,
        stopped,
        stream: None,
        observed: None,
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
    let mut result = submit(&g, 2);
    g.tick(&mut native);
    assert!(matches!(
        result.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(g.pending.is_empty());
    drop(result);
    native.busy = false;
    g.tick(&mut native);
    assert_eq!(native.started, 0);
}

#[tokio::test]
async fn http_waiter_limit_and_shutdown_release_responses() {
    let (jobs, rx) = mpsc::sync_channel(RESPONSES);
    let permits = Arc::new(Semaphore::new(RESPONSES));
    let (stop, stopped) = watch::channel(false);
    let state = HttpState {
        allow_publish: Arc::new(AtomicBool::new(false)),
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

#[tokio::test]
async fn verified_observations_do_not_finish_or_duplicate_native_work() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend::default();
    let signer = Bep44Signer::from_seed(&[19; 32]);
    let a = signer
        .sign(BencodedValue::bytestring(b"a").unwrap(), 41, vec![])
        .unwrap();
    let b = signer
        .sign(BencodedValue::bytestring(b"b").unwrap(), 42, vec![])
        .unwrap();
    let (reply, mut json) = oneshot::channel();
    let (updates, mut stream) = watch::channel(Update::Waiting);
    let (_, stopped) = watch::channel(false);
    g.tx.try_send(Job {
        request: DhtRequest::GetMutable(a.key().clone()),
        reply,
        stopped,
        stream: Some(updates),
        observed: None,
    })
    .unwrap();
    g.tick(&mut native);
    native.observation = Some(Ok(a));
    g.tick(&mut native);
    assert!(matches!(&*stream.borrow_and_update(), Update::Record(v) if v["sequence"]=="41"));
    assert!(matches!(
        json.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(!g.pending[&1].resolved);
    native.observation = Some(Ok(b.clone()));
    g.tick(&mut native);
    assert!(matches!(&*stream.borrow_and_update(), Update::Record(v) if v["sequence"]=="42"));
    assert_eq!(native.started, 1);
    assert!(g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Ok(DhtOutcome::Mutable(Some(b)))
    }));
    assert!(matches!(&*stream.borrow_and_update(), Update::Done(Ok(v)) if v["sequence"]=="42"));
    assert_eq!(json.await.unwrap().unwrap()["sequence"], "42");
    assert!(g.pending[&1].resolved);
    assert!(native.requests.contains(&1));
}
#[tokio::test]
async fn stream_body_holds_capacity_and_exposes_final_errors() {
    let (jobs, rx) = mpsc::sync_channel(RESPONSES);
    let permits = Arc::new(Semaphore::new(RESPONSES));
    let (_stop, stopped) = watch::channel(false);
    let state = HttpState {
        allow_publish: Arc::new(AtomicBool::new(false)),
        jobs,
        permits: permits.clone(),
        stopped,
    };
    let response = stream_lookup(state.clone(), DhtRequest::GetImmutable([1; 20])).await;
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let job = rx.try_recv().unwrap();
    assert_eq!(permits.available_permits(), RESPONSES - 1);
    job.stream
        .as_ref()
        .unwrap()
        .send_replace(Update::Done(Err(native_error(&DhtError::Conflict))));
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(text.contains("event: done"));
    assert!(text.contains("409"));
    assert_eq!(permits.available_permits(), RESPONSES);
    let response = stream_lookup(state, DhtRequest::GetImmutable([2; 20])).await;
    let job = rx.try_recv().unwrap();
    drop(response);
    assert!(job.stream.unwrap().is_closed());
    assert_eq!(permits.available_permits(), RESPONSES);
}
#[test]
fn event_stream_is_explicitly_negotiated() {
    for accept in [
        "application/json",
        "text/event-stream;q=0",
        "text/event-stream;q=0.0",
        "*/*",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, accept.parse().unwrap());
        assert!(!wants_stream(&headers));
    }
    for accept in [
        "text/event-stream",
        "application/json, text/event-stream;q=0.8",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, accept.parse().unwrap());
        assert!(wants_stream(&headers));
    }
}

#[tokio::test]
async fn queued_native_terminal_survives_tick_until_dispatch() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend::default();
    let (_stop, stopped) = watch::channel(false);
    let state = HttpState {
        allow_publish: Arc::new(AtomicBool::new(false)),
        jobs: g.tx.clone(),
        permits: g.permits.clone(),
        stopped: stopped.clone(),
    };
    let signer = Bep44Signer::from_seed(&[19; 32]);
    let record = signer
        .sign(BencodedValue::bytestring(b"valid").unwrap(), 42, vec![])
        .unwrap();
    let request = DhtRequest::GetMutable(record.key().clone());
    let response = stream_lookup(state, request.clone()).await;
    let (reply, json) = oneshot::channel();
    g.tx.try_send(Job {
        request,
        reply,
        stopped,
        stream: None,
        observed: None,
    })
    .unwrap();
    g.tick(&mut native);
    assert_eq!(native.started, 1);
    // Another start_dht can pump the native terminal after this actor's
    // poll_dht. The event remains queued until the next actor iteration.
    assert!(native.requests.remove(&1));
    g.tick(&mut native);
    let delivered = g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Ok(DhtOutcome::Mutable(Some(record))),
    });
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert!(delivered, "queued native terminal lost before dispatch");
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("\"error\":null"));
    assert!(text.contains("\"sequence\":\"42\""));
    assert_eq!(json.await.unwrap().unwrap()["sequence"], "42");
    g.tick(&mut native);
    assert!(g.pending.is_empty());
    assert_eq!(g.permits.available_permits(), RESPONSES);
}

#[tokio::test]
async fn foreign_native_work_defers_json_and_sse_until_the_target_is_free() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend {
        busy: true,
        ..Backend::default()
    };
    let (_stop, stopped) = watch::channel(false);
    let state = HttpState {
        allow_publish: Arc::new(AtomicBool::new(false)),
        jobs: g.tx.clone(),
        permits: g.permits.clone(),
        stopped: stopped.clone(),
    };
    let record = Bep44Signer::from_seed(&[19; 32])
        .sign(BencodedValue::bytestring(b"valid").unwrap(), 42, vec![])
        .unwrap();
    native.shared = Some(Ok(record.clone()));
    let request = DhtRequest::GetMutable(record.key().clone());
    let response = stream_lookup(state, request.clone()).await;
    let (reply, mut json) = oneshot::channel();
    g.tx.try_send(Job {
        request,
        reply,
        stopped,
        stream: None,
        observed: None,
    })
    .unwrap();
    g.tick(&mut native);
    assert!(
        matches!(json.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "foreign native work must not become a 503"
    );
    assert_eq!(native.started, 0);
    assert_eq!(g.permits.available_permits(), RESPONSES - 1);
    native.busy = false;
    g.tick(&mut native);
    assert_eq!(native.started, 1);
    assert!(g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Ok(DhtOutcome::Mutable(Some(record)))
    }));
    assert_eq!(json.await.unwrap().unwrap()["sequence"], "42");
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert!(String::from_utf8(body.to_vec())
        .unwrap()
        .contains("\"error\":null"));
    assert_eq!(g.permits.available_permits(), RESPONSES);
}

#[tokio::test]
async fn deferred_http_clients_remain_bounded_and_cancellation_drops_their_work() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend {
        busy: true,
        ..Backend::default()
    };
    let (_stop, stopped) = watch::channel(false);
    let state = HttpState {
        allow_publish: Arc::new(AtomicBool::new(false)),
        jobs: g.tx.clone(),
        permits: g.permits.clone(),
        stopped,
    };
    let mut responses = vec![];
    for key in 0..RESPONSES {
        responses
            .push(stream_lookup(state.clone(), DhtRequest::GetImmutable([key as u8; 20])).await);
    }
    assert_eq!(
        stream_lookup(state, DhtRequest::GetImmutable([255; 20]))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    g.tick(&mut native);
    assert_eq!(native.started, 0);
    assert!(g.pending.is_empty());
    assert_eq!(g.permits.available_permits(), 0);
    drop(responses);
    assert_eq!(g.permits.available_permits(), RESPONSES);
    native.busy = false;
    g.tick(&mut native);
    assert_eq!(native.started, 0);
}

#[tokio::test]
async fn deferred_target_does_not_block_other_identities() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend {
        busy_target: Some([1; 20]),
        ..Backend::default()
    };
    let mut waiting = submit(&g, 1);
    let ready = submit(&g, 2);
    g.tick(&mut native);
    assert_eq!(native.started, 1);
    assert!(matches!(
        waiting.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Ok(DhtOutcome::Immutable(None)),
    });
    assert_eq!(ready.await.unwrap().unwrap_err().0, StatusCode::NOT_FOUND);
    native.busy_target = None;
    g.tick(&mut native);
    assert_eq!(native.started, 2);
    g.event(&DhtEvent {
        id: DhtRequestId(2),
        result: Ok(DhtOutcome::Immutable(None)),
    });
    assert_eq!(waiting.await.unwrap().unwrap_err().0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn shared_signed_candidates_stream_while_foreign_work_is_busy_without_stealing_finals() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend {
        busy: true,
        ..Backend::default()
    };
    let a = Bep44Signer::from_seed(&[19; 32])
        .sign(BencodedValue::bytestring(b"a").unwrap(), 41, vec![1])
        .unwrap();
    let b = Bep44Signer::from_seed(&[19; 32])
        .sign(BencodedValue::bytestring(b"b").unwrap(), 42, vec![1])
        .unwrap();
    let (updates, mut stream) = watch::channel(Update::Waiting);
    let (reply, mut json) = oneshot::channel();
    let (_stop, stopped) = watch::channel(false);
    g.tx.try_send(Job {
        request: DhtRequest::GetMutable(a.key().clone()),
        reply,
        stopped,
        stream: Some(updates),
        observed: None,
    })
    .unwrap();
    native.shared = Some(Ok(a.clone()));
    g.tick(&mut native);
    assert!(
        matches!(&*stream.borrow_and_update(), Update::Record(v) if v["sequence"] == "41"),
        "signed observation waited for foreign traversal/renewal"
    );
    for _ in 0..200 {
        g.tick(&mut native);
    }
    assert!(
        !stream.has_changed().unwrap(),
        "duplicate candidates exhaust the client's event budget"
    );
    assert_eq!(native.started, 0);
    assert!(matches!(
        json.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(!g.event(&DhtEvent {
        id: DhtRequestId(100),
        result: Ok(DhtOutcome::Mutable(Some(a)))
    }));
    native.shared = Some(Ok(b.clone()));
    g.tick(&mut native);
    assert!(matches!(&*stream.borrow_and_update(), Update::Record(v) if v["sequence"] == "42"));
    native.busy = false;
    native.observation = Some(Ok(b.clone()));
    g.tick(&mut native);
    assert_eq!(native.started, 1);
    assert!(!stream.has_changed().unwrap());
    assert!(matches!(
        json.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Ok(DhtOutcome::Mutable(Some(b))),
    });
    assert_eq!(json.await.unwrap().unwrap()["sequence"], "42");
    assert!(matches!(&*stream.borrow_and_update(), Update::Done(Ok(v)) if v["sequence"] == "42"));
}

#[tokio::test]
async fn shared_wrong_identity_or_foreign_errors_do_not_publish_or_complete_a_read() {
    let mut g = Gateway::new(Handle::current());
    let mut native = Backend {
        busy: true,
        ..Backend::default()
    };
    let signer = Bep44Signer::from_seed(&[19; 32]);
    let record = signer
        .sign(BencodedValue::bytestring(b"value").unwrap(), 42, vec![1])
        .unwrap();
    let other = signer.sign(record.value().clone(), 42, vec![2]).unwrap();
    let (updates, mut stream) = watch::channel(Update::Waiting);
    let (reply, mut json) = oneshot::channel();
    let (_stop, stopped) = watch::channel(false);
    g.tx.try_send(Job {
        request: DhtRequest::GetMutable(record.key().clone()),
        reply,
        stopped,
        stream: Some(updates),
        observed: None,
    })
    .unwrap();
    native.shared = Some(Ok(other));
    g.tick(&mut native);
    assert!(matches!(&*stream.borrow_and_update(), Update::Waiting));
    native.shared = Some(Err(DhtError::Conflict));
    g.tick(&mut native);
    assert!(!stream.has_changed().unwrap());
    assert!(matches!(
        json.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    native.busy = false;
    g.tick(&mut native);
    g.event(&DhtEvent {
        id: DhtRequestId(1),
        result: Err(DhtError::Conflict),
    });
    assert_eq!(json.await.unwrap().unwrap_err().0, StatusCode::CONFLICT);
    assert!(matches!(
        &*stream.borrow_and_update(),
        Update::Done(Err(Failure(StatusCode::CONFLICT, _)))
    ));
}

#[test]
fn signed_write_validation_and_request_identity() {
    assert!(!Config::default().allow_publish);
    let signer = Bep44Signer::from_seed(&[23; 32]);
    let record = signer
        .sign(
            BencodedValue::bytestring(b"payload").unwrap(),
            i64::MAX,
            vec![0, 255],
        )
        .unwrap();
    let input = || SignedInput {
        sequence: record.sequence().to_string(),
        signature: hex(&record.signature()),
        value: hex(record.value().as_bytes()),
    };
    assert_eq!(
        signed_input(&hex(&record.key().public_key()), "00ff", input()).unwrap(),
        record
    );
    for seq in ["-1", "01", "1.0", "9223372036854775808", ""] {
        let mut bad = input();
        bad.sequence = seq.into();
        assert_eq!(
            signed_input(&hex(&record.key().public_key()), "00ff", bad)
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut bad = input();
    bad.signature = "00".repeat(64);
    assert!(signed_input(&hex(&record.key().public_key()), "00ff", bad).is_err());
    let mut bad = input();
    bad.value = "00".repeat(1001);
    assert!(signed_input(&hex(&record.key().public_key()), "00ff", bad).is_err());
    let mut bad = input();
    bad.value = "xx".into();
    assert!(signed_input(&hex(&record.key().public_key()), "00ff", bad).is_err());
    assert!(signed_input(&hex(&record.key().public_key()), "", input()).is_err());
    let other = signer
        .sign(
            BencodedValue::bytestring(b"other").unwrap(),
            i64::MAX,
            vec![0, 255],
        )
        .unwrap();
    let put = DhtRequest::PutMutable(record.clone());
    assert_ne!(
        request_id(&put),
        request_id(&DhtRequest::GetMutable(record.key().clone()))
    );
    assert_ne!(request_id(&put), request_id(&DhtRequest::PutMutable(other)));
    assert_eq!(
        result_json(&Ok(DhtOutcome::Stored {
            target: put.target(),
            acknowledged_nodes: 3
        }))
        .unwrap()["acknowledged_nodes"],
        3
    );
}
#[tokio::test]
async fn signed_write_http_limits_and_disable_during_queue() {
    let (jobs, rx) = mpsc::sync_channel(RESPONSES);
    let (_stop, stopped) = watch::channel(false);
    let allow = Arc::new(AtomicBool::new(false));
    let state = HttpState {
        jobs,
        permits: Arc::new(Semaphore::new(RESPONSES)),
        stopped,
        allow_publish: allow.clone(),
    };
    let signer = Bep44Signer::from_seed(&[29; 32]);
    let r = signer
        .sign(BencodedValue::bytestring(b"p").unwrap(), 7, vec![])
        .unwrap();
    let path = || Path(hex(&r.key().public_key()));
    let query = || {
        Query(Salt {
            salt: String::new(),
        })
    };
    let body = serde_json::to_vec(
        &json!({"sequence":"7","signature":hex(&r.signature()),"value":hex(r.value().as_bytes())}),
    )
    .unwrap();
    let request = |b: Vec<u8>| {
        Request::builder()
            .method("PUT")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b))
            .unwrap()
    };
    assert_eq!(
        publish(State(state.clone()), path(), query(), request(body.clone()))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert!(rx.try_recv().is_err());
    allow.store(true, Ordering::Release);
    assert_eq!(
        publish(
            State(state.clone()),
            path(),
            query(),
            request(vec![b' '; 8193])
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        publish(
            State(state.clone()),
            path(),
            query(),
            request(b"{}".to_vec())
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let task = tokio::spawn(publish(State(state), path(), query(), request(body)));
    let job = loop {
        if let Ok(job) = rx.try_recv() {
            break job;
        }
        tokio::task::yield_now().await;
    };
    assert!(matches!(job.request, DhtRequest::PutMutable(_)));
    job.reply
        .send(Ok(
            json!({"target":hex(&r.key().target()),"acknowledged_nodes":2}),
        ))
        .unwrap();
    assert_eq!(task.await.unwrap().status(), StatusCode::OK);
    let mut gateway = Gateway::new(Handle::current());
    let mut native = Backend::default();
    let (reply, result) = oneshot::channel();
    let (_, stopped) = watch::channel(false);
    gateway
        .tx
        .try_send(Job {
            request: DhtRequest::PutMutable(r),
            reply,
            stopped,
            stream: None,
            observed: None,
        })
        .unwrap();
    gateway.tick(&mut native);
    assert_eq!(native.started, 0);
    assert_eq!(result.await.unwrap().unwrap_err().0, StatusCode::FORBIDDEN);
}
