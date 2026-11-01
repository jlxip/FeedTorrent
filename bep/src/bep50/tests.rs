use super::*;
use crate::bep44::Bep44Signer;
fn record(seq: i64) -> MutableRecord {
    Bep44Signer::from_seed(&[7; 32])
        .sign(BencodedValue::bytestring(b"hello").unwrap(), seq, vec![1])
        .unwrap()
}
fn node(id: u8) -> PubSub {
    let mut n = PubSub::new([id; 20], [id; 32], Config::default()).unwrap();
    n.subscribe(record(1).key().clone(), None, 0).unwrap();
    n
}
#[test]
fn verified_retention_and_rollback() {
    let mut n = node(1);
    n.publish(record(2), 0).unwrap();
    assert!(n.publish(record(1), 0).is_err());
    assert_eq!(n.latest(record(1).key().target()).unwrap().sequence(), 2);
    n.subscribe(record(1).key().clone(), None, 0).unwrap();
    assert_eq!(n.latest(record(1).key().target()).unwrap().sequence(), 2);
}
#[test]
fn token_scope_and_rotation() {
    let mut n = node(1);
    let c = record(1).key().target();
    let a = "127.0.0.1:50".parse().unwrap();
    let token = n.token(c, a);
    assert!(n.valid_token(c, a, &token));
    assert!(!n.valid_token([0; 20], a, &token));
    assert!(!n.valid_token(c, "127.0.0.2:50".parse().unwrap(), &token));
    n.clock(300_000);
    assert!(n.valid_token(c, a, &token));
    n.clock(600_000);
    assert!(!n.valid_token(c, a, &token));
}
#[test]
fn bounded_queues_and_timeout() {
    let mut n = node(1);
    n.config.max_datagrams = 2;
    let c = record(1).key().target();
    n.discovered(
        PeerHints {
            topic: c,
            peers: (1..2000)
                .map(|p| SocketAddr::from(([127, 0, 0, 1], p)))
                .collect(),
        },
        0,
    );
    n.advance(0);
    assert!(n.queued_datagrams() <= 2);
    assert!(n.pending_count() <= 2);
    assert!(n.topics[&c].peers.len() <= 512);
    n.drain_datagrams();
    n.advance(6000);
    assert!(n
        .drain_events()
        .iter()
        .any(|e| matches!(e, Event::Failure { .. })));
}
#[test]
fn ignores_unknown_topic_and_wrong_transaction_endpoint() {
    let mut a = node(1);
    let c = record(1).key().target();
    let addr = "127.0.0.1:1".parse().unwrap();
    a.discovered(
        PeerHints {
            topic: c,
            peers: vec![addr],
        },
        0,
    );
    a.advance(0);
    let packets = a.drain_datagrams();
    let v = wire::decode(&packets[0].bytes).unwrap();
    let tx = raw(get(as_dict(&v).unwrap(), b"t").unwrap()).unwrap();
    let response = wire::encode(&dict(&[
        (b"c", bytes(&c)),
        (b"r", dict(&[(b"id", bytes(&[2; 20]))])),
        (b"t", bytes(tx)),
        (b"y", bytes(b"r")),
    ]))
    .unwrap();
    a.receive("127.0.0.1:2".parse().unwrap(), &response, 1);
    assert_eq!(a.pending_count(), 1);
    a.receive(addr, &response, 1);
    assert!(!a.contacts(c).is_empty());
    a.unsubscribe(c);
    a.receive(addr, &response, 2);
    assert!(a.contacts(c).is_empty());
    a.close();
    assert_eq!(a.publish(record(3), 3), Err(Error::Closed));
}
#[test]
fn value_depth_has_independent_envelope_budget() {
    let mut b = vec![b'l'; 64];
    b.extend_from_slice(b"0:");
    b.extend(vec![b'e'; 64]);
    let value = BencodedValue::parse(&b).unwrap();
    let r = Bep44Signer::from_seed(&[7; 32])
        .sign(value, 1, vec![1])
        .unwrap();
    let mut d = Dict::new();
    wire::add_record(&mut d, &r, true);
    let packet = dict(&[(b"a", V::Dict(d)), (b"c", bytes(&r.key().target()))]);
    let encoded = wire::encode(&packet).unwrap();
    assert!(wire::decode(&encoded).is_ok());
}

fn request(n: &mut PubSub, method: &[u8], a: V, now: u64) -> V {
    let topic = record(1).key().target();
    let p = wire::encode(&dict(&[
        (b"c", bytes(&topic)),
        (b"t", bytes(b"fixture")),
        (b"y", bytes(b"q")),
        (b"q", bytes(method)),
        (b"a", a),
    ]))
    .unwrap();
    n.receive("127.0.0.1:99".parse().unwrap(), &p, now);
    wire::decode(&n.drain_datagrams().pop().unwrap().bytes).unwrap()
}
fn put_args(n: &PubSub, r: &MutableRecord) -> Dict {
    let mut a = Dict::new();
    wire::add_record(&mut a, r, true);
    a.insert(b"id".to_vec().into(), bytes(&[2; 20]));
    a.insert(
        b"token".to_vec().into(),
        bytes(&n.token(r.key().target(), "127.0.0.1:99".parse().unwrap())),
    );
    a
}
fn code(v: &V) -> i64 {
    let V::List(e) = get(as_dict(v).unwrap(), b"e").unwrap() else {
        panic!()
    };
    int(&e[0]).unwrap()
}
#[test]
fn incoming_cas_duplicates_conflicts_and_full_value_bounds() {
    let mut n = node(1);
    let r = record(1);
    let a = put_args(&n, &r);
    assert!(as_dict(&request(&mut n, b"put", V::Dict(a.clone()), 0))
        .unwrap()
        .contains_key(b"r".as_slice()));
    n.drain_events();
    request(&mut n, b"put", V::Dict(a), 0);
    assert!(n.drain_events().is_empty());
    let mut next = put_args(&n, &record(2));
    next.insert(b"cas".to_vec().into(), V::Integer(0));
    assert_eq!(
        code(&request(&mut n, b"put", V::Dict(next.clone()), 0)),
        301
    );
    next.insert(b"cas".to_vec().into(), V::Integer(1));
    request(&mut n, b"put", V::Dict(next), 0);
    assert_eq!(n.latest(r.key().target()).unwrap().sequence(), 2);
    let old = put_args(&n, &r);
    assert_eq!(code(&request(&mut n, b"put", V::Dict(old), 0)), 302);
    let changed = Bep44Signer::from_seed(&[7; 32])
        .sign(BencodedValue::bytestring(b"different").unwrap(), 2, vec![1])
        .unwrap();
    let a = put_args(&n, &changed);
    assert_eq!(code(&request(&mut n, b"put", V::Dict(a), 0)), 201);
    let mut invalid = put_args(&n, &record(3));
    invalid.insert(b"sig".to_vec().into(), bytes(&[0; 64]));
    assert_eq!(code(&request(&mut n, b"put", V::Dict(invalid), 0)), 206);
    let mut oversized = put_args(&n, &record(3));
    oversized.insert(b"v".to_vec().into(), bytes(&vec![0; 1000]));
    assert_eq!(code(&request(&mut n, b"put", V::Dict(oversized), 0)), 205);
    assert_eq!(n.latest(r.key().target()).unwrap().sequence(), 2);
}
#[test]
fn get_omits_unchanged_value_and_uses_topic_salt() {
    let mut n = node(1);
    n.publish(record(5), 0).unwrap();
    n.drain_datagrams();
    let c = record(1).key().target();
    let a = dict(&[
        (b"id", bytes(&[2; 20])),
        (b"target", bytes(&c)),
        (b"seq", V::Integer(5)),
    ]);
    let v = request(&mut n, b"get", a, 0);
    let r = as_dict(get(as_dict(&v).unwrap(), b"r").unwrap()).unwrap();
    assert!(!r.contains_key(b"v".as_slice()));
    assert_eq!(int(get(r, b"seq").unwrap()).unwrap(), 5);
    let a = dict(&[(b"id", bytes(&[2; 20])), (b"target", bytes(&c))]);
    let v = request(&mut n, b"get", a, 0);
    let r = as_dict(get(as_dict(&v).unwrap(), b"r").unwrap()).unwrap();
    assert!(!r.contains_key(b"salt".as_slice()));
    assert_eq!(wire::record(r, record(1).key(), true).unwrap(), record(5));
}
#[test]
fn forbidden_queries_and_wrong_target() {
    let mut n = node(1);
    for method in [b"get_peers".as_slice(), b"announce_peer", b"unknown"] {
        assert_eq!(
            code(&request(
                &mut n,
                method,
                dict(&[(b"id", bytes(&[2; 20]))]),
                0
            )),
            204
        );
    }
    assert_eq!(
        code(&request(
            &mut n,
            b"get",
            dict(&[(b"id", bytes(&[2; 20])), (b"target", bytes(&[0; 20]))]),
            0
        )),
        203
    );
}
#[test]
fn malformed_packets_do_not_allocate_topics_or_change_state() {
    let mut n = node(1);
    n.publish(record(3), 0).unwrap();
    n.drain_datagrams();
    for p in [
        b"bad".to_vec(),
        vec![0; 4097],
        b"d1:ci00ee".to_vec(),
        b"degarbage".to_vec(),
    ] {
        n.receive("127.0.0.1:99".parse().unwrap(), &p, 0)
    }
    assert_eq!(n.topics.len(), 1);
    assert_eq!(n.latest(record(1).key().target()).unwrap().sequence(), 3);
    assert_eq!(n.queued_datagrams(), 0);
}
#[test]
fn compact_ipv6_and_ipv4_roundtrip_and_reject_truncation() {
    for addr in ["127.0.0.1:999", "[::1]:999"] {
        let addr: SocketAddr = addr.parse().unwrap();
        let b = wire::compact(std::iter::once(([8; 20], addr)));
        assert_eq!(
            wire::contacts(&bytes(&b), addr.is_ipv6()).unwrap(),
            vec![([8; 20], addr)]
        );
        assert!(wire::contacts(&bytes(&b[1..]), addr.is_ipv6()).is_err());
    }
}
#[test]
fn late_reply_cannot_replace_a_new_transaction() {
    let mut n = node(1);
    let c = record(1).key().target();
    let addr = "127.0.0.1:99".parse().unwrap();
    n.discovered(
        PeerHints {
            topic: c,
            peers: vec![addr],
        },
        0,
    );
    n.advance(0);
    let v = wire::decode(&n.drain_datagrams()[0].bytes).unwrap();
    let tx = raw(get(as_dict(&v).unwrap(), b"t").unwrap()).unwrap();
    n.advance(5001);
    let count = n.pending_count();
    let reply = wire::encode(&dict(&[
        (b"c", bytes(&c)),
        (b"t", bytes(tx)),
        (b"y", bytes(b"r")),
        (b"r", dict(&[(b"id", bytes(&[2; 20]))])),
    ]))
    .unwrap();
    n.receive(addr, &reply, 5002);
    assert_eq!(n.pending_count(), count);
    assert!(n.contacts(c).is_empty());
}
#[test]
fn empty_discovery_retries_and_cancel_discards_all_outputs() {
    let mut n = node(1);
    assert_eq!(n.drain_discovery().len(), 1);
    n.advance(0);
    n.drain_discovery();
    n.advance(4000);
    assert!(n.drain_discovery().is_empty());
    n.advance(6000);
    assert_eq!(n.drain_discovery().len(), 1);
    n.unsubscribe(record(1).key().target());
    assert_eq!(n.next_deadline(), None);
    assert!(n.drain_events().is_empty());
}
#[test]
fn independent_topics_never_share_records_or_transactions() {
    let mut n = node(1);
    let other = Bep44Signer::from_seed(&[8; 32])
        .sign(BencodedValue::bytestring(b"other").unwrap(), 9, vec![])
        .unwrap();
    n.subscribe(other.key().clone(), None, 0).unwrap();
    n.publish(record(1), 0).unwrap();
    assert!(n.latest(other.key().target()).is_none());
    n.publish(other.clone(), 0).unwrap();
    n.unsubscribe(record(1).key().target());
    assert_eq!(n.latest(other.key().target()), Some(&other));
}
#[test]
fn packet_loss_reordering_and_no_retransmission_of_transaction() {
    let mut a = node(1);
    let mut b = node(2);
    let c = record(1).key().target();
    let aa = "127.0.0.1:1".parse().unwrap();
    let ba = "127.0.0.1:2".parse().unwrap();
    a.discovered(
        PeerHints {
            topic: c,
            peers: vec![ba],
        },
        0,
    );
    a.publish(record(1), 0).unwrap();
    let dropped = a.drain_datagrams();
    let old = wire::decode(&dropped[0].bytes).unwrap();
    let oldtx = raw(get(as_dict(&old).unwrap(), b"t").unwrap())
        .unwrap()
        .to_vec();
    a.advance(5001);
    for step in 0..50 {
        let now = 5002 + step;
        let mut from_a = a.drain_datagrams();
        from_a.reverse();
        for d in from_a {
            let v = wire::decode(&d.bytes).unwrap();
            let map = as_dict(&v).unwrap();
            if raw(get(map, b"y").unwrap()).unwrap() == b"q" {
                assert_ne!(raw(get(map, b"t").unwrap()).unwrap(), oldtx);
            }
            b.receive(aa, &d.bytes, now);
        }
        let mut from_b = b.drain_datagrams();
        from_b.reverse();
        for d in from_b {
            a.receive(ba, &d.bytes, now);
        }
        a.advance(now);
        b.advance(now);
    }
    assert_eq!(b.latest(c), Some(&record(1)));
    assert_eq!(a.latest(c), Some(&record(1)));
    let updates = b
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, Event::Updated { .. }))
        .count();
    assert_eq!(updates, 1);
    assert!(a.queued_datagrams() + b.queued_datagrams() < 3);
    a.advance(1_000_000);
    assert!(a.drain_datagrams().iter().any(|d| {
        let v = wire::decode(&d.bytes).unwrap();
        as_dict(&v)
            .unwrap()
            .get(b"q".as_slice())
            .is_some_and(|q| raw(q) == Ok(b"ping"))
    }));
}
#[test]
fn maximum_value_is_carried_without_truncation() {
    let r = Bep44Signer::from_seed(&[7; 32])
        .sign(
            BencodedValue::bytestring(&vec![255; 996]).unwrap(),
            i64::MAX,
            vec![1],
        )
        .unwrap();
    assert_eq!(r.value().as_bytes().len(), 1000);
    let mut n = node(1);
    let a = put_args(&n, &r);
    request(&mut n, b"put", V::Dict(a), 0);
    assert_eq!(n.latest(r.key().target()), Some(&r));
}
#[test]
fn latest_survives_backpressure_and_error_flood() {
    let mut n = node(1);
    n.config.max_datagrams = 1;
    let c = record(1).key().target();
    for seq in 1..100 {
        n.publish(record(seq), 0).unwrap();
        n.transport_error(c, None, "fixture error".into());
    }
    for _ in 0..3000 {
        n.transport_error(c, None, "fixture error".into());
    }
    assert_eq!(n.latest(c).unwrap().sequence(), 99);
    assert!(n.events.len() <= 1024);
    assert_eq!(n.updates.len(), 1);
    assert!(n
        .drain_events()
        .iter()
        .any(|e| matches!(e,Event::Updated{record,..}if record.sequence()==99)));
}
#[test]
fn pending_deadlines_do_not_busy_loop_and_ids_are_not_reused() {
    let mut n = node(1);
    let c = record(1).key().target();
    n.discovered(
        PeerHints {
            topic: c,
            peers: vec!["127.0.0.1:99".parse().unwrap()],
        },
        0,
    );
    n.advance(0);
    n.drain_discovery();
    let old = n.drain_datagrams();
    assert_eq!(n.next_deadline(), Some(5000));
    n.unsubscribe(c);
    n.subscribe(record(1).key().clone(), None, 0).unwrap();
    n.discovered(
        PeerHints {
            topic: c,
            peers: vec!["127.0.0.1:99".parse().unwrap()],
        },
        0,
    );
    n.advance(0);
    let new = n.drain_datagrams();
    let old = wire::decode(&old[0].bytes).unwrap();
    let new = wire::decode(&new[0].bytes).unwrap();
    assert_ne!(
        get(as_dict(&old).unwrap(), b"t").unwrap(),
        get(as_dict(&new).unwrap(), b"t").unwrap()
    );
}
