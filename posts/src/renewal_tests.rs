use super::*;
use feedtorrent_bep::{
    bep44::Bep44Signer,
    bep46::{format_magnet, TorrentPointer},
};
fn record(seed: u8, seq: i64) -> MutableRecord {
    TorrentPointer::sign(
        &Bep44Signer::from_seed(&[seed; 32]),
        [seq as u8; 20],
        seq,
        vec![0, 255],
    )
    .unwrap()
    .record()
    .clone()
}
fn actions(m: &mut PostManager) -> Vec<Action> {
    m.acknowledge_checkpoint();
    m.drain_actions()
}
fn setup() -> (PostManager, String, MutableRecord) {
    let record = record(30, 1);
    let mut m = PostManager::new();
    let id = m
        .follow(&format_magnet(record.key()), Config::default(), 0)
        .unwrap();
    let w = actions(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Lookup { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.lookup_result(w, Ok(Some(record.clone())), 10);
    (m, id, record)
}
fn query(m: &mut PostManager) -> WorkId {
    actions(m)
        .into_iter()
        .find_map(|a| {
            if let Action::RenewalLookup { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .expect("renewal lookup")
}
fn put(
    m: &mut PostManager,
    q: WorkId,
    result: std::result::Result<Option<MutableRecord>, RenewalError>,
    now: u64,
) -> (WorkId, MutableRecord) {
    m.renewal_lookup_result(q, result, now);
    actions(m)
        .into_iter()
        .find_map(|a| {
            if let Action::RenewalPut { work, record, .. } = a {
                Some((work, record))
            } else {
                None
            }
        })
        .expect("renewal put")
}
fn confirm(m: &mut PostManager, w: WorkId, r: &MutableRecord, now: u64) {
    m.renewal_result(
        w,
        Ok(RenewalConfirmation {
            target: r.key().target(),
            acknowledged_nodes: 1,
        }),
        now,
    );
}
#[test]
fn first_put_requires_fresh_query_and_durable_checkpoint() {
    let (mut m, id, r) = setup();
    assert!(m.drain_actions().is_empty());
    let q = query(&mut m);
    let newer = record(30, 2);
    m.renewal_lookup_result(q, Ok(Some(newer.clone())), 20);
    assert!(m.drain_actions().is_empty());
    let w = m
        .pending
        .iter()
        .find_map(|(w, p)| matches!(p, Work::RenewalPut(..)).then_some(*w))
        .unwrap();
    assert!(m.renewal_record(w).is_none());
    actions(&mut m);
    assert_eq!(m.renewal_record(w).unwrap(), newer);
    assert_eq!(m.known(&id).unwrap().unwrap().sequence(), 2);
    assert_eq!(r.sequence(), 1);
}
#[test]
fn periodic_jitter_duplicates_and_manual_refresh_do_not_reset_clock() {
    let (mut m, id, r) = setup();
    let q = query(&mut m);
    let (w, p) = put(&mut m, q, Ok(None), 20);
    assert_eq!(p, r);
    confirm(&mut m, w, &r, 30);
    let due = m.renewals[&id].next;
    assert!((INTERVAL + 30..=INTERVAL + 300_030).contains(&due));
    for now in [40, 100, 1000] {
        m.receive_record(&id, r.clone(), now).unwrap();
        m.refresh(&id, now).unwrap();
        for a in actions(&mut m) {
            if let Action::Lookup { work, .. } = a {
                m.lookup_result(work, Ok(None), now);
            }
        }
        assert_eq!(m.renewals[&id].next, due);
    }
    m.tick(due - 1);
    for a in actions(&mut m) {
        if let Action::Lookup { work, .. } = a {
            m.lookup_result(work, Ok(None), due - 1);
        }
    }
    assert!(!actions(&mut m)
        .iter()
        .any(|a| matches!(a, Action::RenewalLookup { .. })));
    m.tick(due);
    query(&mut m);
}
#[test]
fn restart_uses_only_verified_saved_public_record_without_migration() {
    let (m, id, r) = setup();
    let bytes = m.checkpoint().unwrap();
    let mut restored = PostManager::restore(&bytes).unwrap();
    restored.start(0);
    let q = query(&mut restored);
    let (_, p) = put(&mut restored, q, Ok(None), 10);
    assert_eq!(p, r);
    assert_eq!(restored.known(&id).unwrap().unwrap(), r);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["version"],
        2
    );
}
#[test]
fn failed_or_empty_query_preserves_local_record() {
    for result in [Ok(None), Err(RenewalError::Failed("offline".into()))] {
        let (mut m, _, r) = setup();
        let q = query(&mut m);
        let (_, p) = put(&mut m, q, result, 20);
        assert_eq!(p, r);
    }
}
#[test]
fn failed_confirmations_backoff_and_busy_are_retried_with_fresh_queries() {
    let (mut m, id, _) = setup();
    let mut q = query(&mut m);
    for attempt in 0..8 {
        let query_time = m.now + 1;
        let (w, r) = put(&mut m, q, Ok(None), query_time);
        let now = query_time + 1;
        if attempt == 0 {
            m.renewal_result(
                w,
                Ok(RenewalConfirmation {
                    target: r.key().target(),
                    acknowledged_nodes: 0,
                }),
                now,
            );
        } else if attempt == 1 {
            m.renewal_result(
                w,
                Ok(RenewalConfirmation {
                    target: [0; 20],
                    acknowledged_nodes: 1,
                }),
                now,
            );
        } else {
            m.fail(w, "Busy".into());
        }
        let expected = (30_000u64 << attempt.min(5)).min(POLL_MS);
        assert_eq!(m.renewals[&id].next, m.now + expected);
        assert_eq!(m.renewals[&id].failures, attempt + 1);
        let due = m.renewals[&id].next;
        m.tick(due);
        q = query(&mut m);
    }
}
#[test]
fn incompatible_highwater_never_republishes_old_pointer() {
    let (mut m, id, _) = setup();
    let q = query(&mut m);
    let signer = Bep44Signer::from_seed(&[30; 32]);
    let invalid = signer
        .sign(
            feedtorrent_bep::bep44::BencodedValue::parse(b"3:bad").unwrap(),
            9,
            vec![0, 255],
        )
        .unwrap();
    m.renewal_lookup_result(q, Ok(Some(invalid)), 20);
    assert_eq!(m.known(&id).unwrap().unwrap().sequence(), 9);
    assert!(!actions(&mut m)
        .iter()
        .any(|a| matches!(a, Action::RenewalPut { .. })));
}
#[test]
fn higher_push_fences_queued_put_and_late_confirmation() {
    let (mut m, id, r) = setup();
    let q = query(&mut m);
    let (w, _) = put(&mut m, q, Ok(None), 20);
    m.receive_record(&id, record(30, 2), 21).unwrap();
    actions(&mut m);
    assert!(m.renewal_record(w).is_none());
    confirm(&mut m, w, &r, 22);
    let q = query(&mut m);
    let (_, latest) = put(&mut m, q, Ok(None), 23);
    assert_eq!(latest.sequence(), 2);
}
#[test]
fn unfollow_refollow_fences_old_lookup_and_put_responses() {
    for during_put in [false, true] {
        let (mut m, id, r) = setup();
        let q = query(&mut m);
        let stale = if during_put {
            put(&mut m, q, Ok(None), 20).0
        } else {
            q
        };
        m.unfollow(&id).unwrap();
        m.follow(&format_magnet(r.key()), Config::default(), 30)
            .unwrap();
        let before = m.checkpoint().unwrap();
        m.renewal_lookup_result(stale, Ok(Some(record(30, 3))), 31);
        confirm(&mut m, stale, &r, 31);
        assert_eq!(m.checkpoint().unwrap(), before);
        assert_eq!(m.known(&id).unwrap().unwrap().sequence(), 1);
    }
}
#[test]
fn renewal_budget_is_four_fair_and_independent_of_mode_or_pause() {
    let mut m = PostManager::new();
    for seed in 1..=10 {
        let r = record(seed, 1);
        let id = m
            .follow(
                &format_magnet(r.key()),
                Config {
                    mode: match seed % 3 {
                        0 => Mode::MirrorAll,
                        1 => Mode::CurrentCatalog,
                        _ => Mode::MirrorCatalogs,
                    },
                    ..Default::default()
                },
                0,
            )
            .unwrap();
        for a in actions(&mut m) {
            if let Action::Lookup { work, .. } = a {
                m.lookup_result(work, Ok(None), 1);
            }
        }
        m.suppress(&hex(&[1; 20])).unwrap();
        m.receive_record(&id, r, 2).unwrap();
        actions(&mut m);
    }
    assert_eq!(m.renewals.values().filter(|r| r.active).count(), 4);
    let first: Vec<_> = m
        .pending
        .iter()
        .filter_map(|(w, p)| {
            if let Work::RenewalLookup(id) = p {
                Some((*w, id.clone()))
            } else {
                None
            }
        })
        .collect();
    for (w, id) in first {
        m.renewal_lookup_result(w, Ok(None), 3);
        let puts = actions(&mut m);
        for a in puts {
            if let Action::RenewalPut { work, record, .. } = a {
                confirm(&mut m, work, &record, 4);
            }
        }
        assert!(!m.renewals[&id].active);
    }
    assert!(m.renewals.values().filter(|r| r.active).count() <= 4);
    assert!(m.renewals.values().any(|r| r.active && r.next == 2));
}
#[test]
fn conflicts_never_invent_sequence_or_overwrite_local_record() {
    let (mut m, id, r) = setup();
    let q = query(&mut m);
    m.renewal_lookup_result(q, Err(RenewalError::Conflict), 20);
    assert_eq!(m.known(&id).unwrap().unwrap(), r);
    assert!(!actions(&mut m)
        .iter()
        .any(|a| matches!(a, Action::RenewalPut { .. })));
    m.tick(30_020);
    let q = query(&mut m);
    let (w, _) = put(&mut m, q, Ok(None), 30_021);
    m.renewal_result(w, Err(RenewalError::Conflict), 30_022);
}

#[test]
fn refollow_retained_identity_renews_when_dht_is_empty() {
    let (mut m, id, r) = setup();
    m.unfollow(&id).unwrap();
    m.follow(&format_magnet(r.key()), Config::default(), 100)
        .unwrap();
    let q = query(&mut m);
    let (_, renewed) = put(&mut m, q, Ok(None), 101);
    assert_eq!(renewed, r);
}
