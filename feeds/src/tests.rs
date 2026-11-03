use super::*;
use feedtorrent_bep::{
    bep44::{BencodedValue, Bep44Signer},
    bep46::{format_magnet, TorrentPointer},
    bep49::{BuildEntry, BuiltFeed, FeedBuilder, FeedFields, TorrentLink},
};
use sha1::Digest;
use std::io::{Cursor, Read};
fn signer() -> Bep44Signer {
    Bep44Signer::from_seed(&[31; 32])
}
fn key() -> feedtorrent_bep::bep44::MutableKey {
    feedtorrent_bep::bep44::MutableKey::new(signer().public_key(), vec![2]).unwrap()
}
fn record(h: [u8; 20], seq: i64) -> feedtorrent_bep::bep44::MutableRecord {
    TorrentPointer::sign(&signer(), h, seq, vec![2])
        .unwrap()
        .record()
        .clone()
}
fn acts(m: &mut FeedManager) -> Vec<Action> {
    m.acknowledge_checkpoint();
    m.drain_actions()
}
fn catalog(data: &[Vec<u8>], fields: FeedFields) -> BuiltFeed {
    let mut b = FeedBuilder::new("catalog");
    b.fields = fields;
    for d in data {
        b.entries
            .push(BuildEntry::file(vec!["item".into()], d.len() as u64));
    }
    b.build(|i| Ok(Cursor::new(&data[i]))).unwrap()
}
fn torrent() -> Vec<u8> {
    let mut v = b"d4:infod6:lengthi3e4:name1:x12:piece lengthi16384e6:pieces20:".to_vec();
    v.extend_from_slice(&sha1::Sha1::digest(b"abc"));
    v.extend_from_slice(b"ee");
    v
}
fn setup(mode: Mode, limit: Option<u64>) -> (FeedManager, String) {
    let mut m = FeedManager::new();
    let id = m
        .follow(
            &format_magnet(&key()),
            Config {
                mode,
                automatic_limit: limit,
                ..Default::default()
            },
            0,
        )
        .unwrap();
    acts(&mut m);
    (m, id)
}
fn stage(m: &mut FeedManager, id: &str, b: &BuiltFeed, seq: i64) -> WorkId {
    m.receive_record(id, record(b.feed.infohash(), seq), 1)
        .unwrap();
    assert!(m.drain_actions().is_empty());
    acts(m)
        .into_iter()
        .find_map(|a| {
            if let Action::Stage { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap()
}
fn metadata(m: &mut FeedManager, w: WorkId, b: &BuiltFeed, authorized: bool) {
    m.metadata(
        w,
        Description {
            id: hex(&b.feed.infohash()),
            total: b.feed.total_length(),
            ..Default::default()
        },
        b.feed.raw_info().to_vec(),
        authorized,
    )
    .unwrap();
}
fn ready(m: &mut FeedManager, id: &str, b: &BuiltFeed) {
    let h = hex(&b.feed.infohash());
    m.transfer(&h, "Seeding".into(), true);
    m.tick(2);
    let reads = acts(m);
    for a in reads {
        if let Action::Approve { work, .. } = a {
            m.approved(work)
        }
    }
    m.tick(3);
    assert!(m.views().iter().any(|v| v.id == id));
}
#[test]
fn checkpoint_barrier_and_limit_include_padding() {
    let b = catalog(&[b"a".to_vec()], Default::default());
    assert!(b.feed.total_length() > 1);
    let (mut m, id) = setup(Mode::CurrentCatalog, Some(b.feed.total_length() - 1));
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, false);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
    assert_eq!(m.views()[0].catalogs[0].state, "Awaiting approval");
    m.configure(
        &id,
        Config {
            automatic_limit: Some(b.feed.total_length()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(m.drain_actions().is_empty());
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
}
#[test]
fn download_once_does_not_change_limit_and_suppression_is_durable() {
    let b = catalog(&[b"a".to_vec()], Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, Some(1));
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, false);
    acts(&mut m);
    let h = hex(&b.feed.infohash());
    m.approve_once(&h).unwrap();
    assert_eq!(m.views()[0].automatic_limit, Some(1));
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
    m.suppress(&h).unwrap();
    m.removed(&h);
    m.tick(5000);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. } | Action::Approve { .. })));
    let mut r = FeedManager::restore(&m.checkpoint().unwrap()).unwrap();
    r.start(0);
    assert!(!acts(&mut r)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. } | Action::Approve { .. })));
}
#[test]
fn highwater_survives_incompatible_update_and_restore() {
    let b = catalog(&[b"ok".to_vec()], Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    ready(&mut m, &id, &b);
    let bad = signer()
        .sign(
            BencodedValue::bytestring(b"not pointer").unwrap(),
            9,
            vec![2],
        )
        .unwrap();
    m.receive_record(&id, bad, 10).unwrap();
    assert_eq!(m.views()[0].sequence.as_deref(), Some("9"));
    assert_eq!(m.views()[0].available, Some(hex(&b.feed.infohash())));
    assert!(m.receive_record(&id, record([3; 20], 8), 11).is_err());
    let mut r = FeedManager::restore(&m.checkpoint().unwrap()).unwrap();
    r.start(0);
    assert!(r.receive_record(&id, record([3; 20], 8), 1).is_err());
    assert!(r.views()[0].error.contains("Unsupported"));
}
#[test]
fn same_hash_update_has_no_new_stage_and_conflicts_are_rejected() {
    let b = catalog(&[vec![1]], Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    acts(&mut m);
    m.receive_record(&id, record(b.feed.infohash(), 2), 4)
        .unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. })));
    assert!(m.receive_record(&id, record([9; 20], 2), 5).is_err());
}
#[test]
fn foreign_nested_catalog_is_visible_but_not_downloaded() {
    let nested = catalog(
        &[vec![1]],
        FeedFields {
            source: Some(
                feedtorrent_bep::bep44::MutableKey::new(signer().public_key(), vec![3]).unwrap(),
            ),
            ..Default::default()
        },
    );
    let b = catalog(std::slice::from_ref(&nested.metainfo), Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.transfer(&hex(&b.feed.infohash()), "Seeding".into(), true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.item(w, nested.metainfo.clone(), None).unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. } | Action::Approve { .. })));
    let page = m.page(&id, &hex(&b.feed.infohash()), 0).unwrap();
    assert_eq!(page.entries[0].kind, "external_feed");
    assert!(page.entries[0].feed_magnet.is_some());
}
#[test]
fn current_catalog_does_not_fetch_history_mirror_does() {
    let prev = [4; 20];
    let b = catalog(
        &[vec![1]],
        FeedFields {
            previous: Some(TorrentLink::new(prev)),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.tick(2);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. })));
    m.configure(
        &id,
        Config {
            mode: Mode::MirrorCatalogs,
            automatic_limit: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a,Action::Stage{id,..}if id==&hex(&prev))));
}
#[test]
fn duplicate_names_preserve_original_indices_and_page_bound() {
    let data = vec![vec![1]; 105];
    let b = catalog(&data, Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    ready(&mut m, &id, &b);
    let page = m.page(&id, &hex(&b.feed.infohash()), 0).unwrap();
    assert_eq!(page.entries.len(), 100);
    assert_eq!(page.total, 105);
    assert_ne!(page.entries[0].index, page.entries[1].index);
    assert_eq!(page.entries[0].name, page.entries[1].name);
    assert_eq!(
        m.page(&id, &hex(&b.feed.infohash()), 100)
            .unwrap()
            .entries
            .len(),
        5
    );
    assert!(m.drain_actions().len() <= 32);
}
#[test]
fn mirror_all_stages_exact_embedded_metainfo_without_authorizing_payload() {
    let data = torrent();
    let b = catalog(std::slice::from_ref(&data), Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, Some(1));
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.transfer(&hex(&b.feed.infohash()), "Seeding".into(), true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    let tid = if let feedtorrent_bep::bep49::ItemContent::Torrent(t) =
        feedtorrent_bep::bep49::inspect_item(&data)
    {
        hex(&t.infohash())
    } else {
        panic!()
    };
    m.item(
        w,
        data.clone(),
        Some(Description {
            id: tid.clone(),
            total: 3,
            ..Default::default()
        }),
    )
    .unwrap();
    let actions = acts(&mut m);
    let w = actions
        .into_iter()
        .find_map(|a| {
            if let Action::Stage {
                work,
                source: Source::Torrent(bytes),
                role: Role::Content,
                ..
            } = a
            {
                assert_eq!(bytes, data);
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.metadata(
        w,
        Description {
            id: tid.clone(),
            total: 3,
            ..Default::default()
        },
        vec![],
        false,
    )
    .unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
    m.transfer(&tid, "Awaiting approval".into(), false);
    assert_eq!(m.views()[0].mirror_status, "Incomplete");
    m.configure(
        &id,
        Config {
            mode: Mode::CurrentCatalog,
            automatic_limit: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
}
#[test]
fn large_opaque_reader_is_bounded_and_checks_auxiliary_hash() {
    let n = MAX_METAINFO as u64 + 123;
    let mut b = FeedBuilder::new("large");
    b.entries.push(BuildEntry::file(vec!["blob".into()], n));
    let b = b.build(|_| Ok(std::io::repeat(42).take(n))).unwrap();
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.transfer(&hex(&b.feed.infohash()), "Seeding".into(), true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.item_from_reader(w, std::io::repeat(42).take(n), |_| {
        panic!("large files must not be buffered")
    })
    .unwrap();
    assert_eq!(
        m.page(&id, &hex(&b.feed.infohash()), 0).unwrap().entries[0].kind,
        "file"
    );
}
#[test]
fn corrupt_checkpoint_and_signature_rejected_unfollow_cancels_actions() {
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    m.receive_record(&id, record([1; 20], 1), 1).unwrap();
    let mut state: serde_json::Value = serde_json::from_slice(&m.checkpoint().unwrap()).unwrap();
    state["feeds"][&id]["records"][0]["signature"][0] = serde_json::json!(0);
    assert!(FeedManager::restore(&serde_json::to_vec(&state).unwrap()).is_err());
    m.unfollow(&id).unwrap();
    assert!(!acts(&mut m).iter().any(|a| matches!(
        a,
        Action::Stage { .. } | Action::Approve { .. } | Action::Lookup { .. }
    )));
    assert!(m.receive_record(&id, record([2; 20], 2), 2).is_err());
}
#[test]
fn explicit_foreign_history_stops_before_pieces_and_recursion() {
    let foreign = catalog(
        &[vec![1]],
        FeedFields {
            source: Some(
                feedtorrent_bep::bep44::MutableKey::new(signer().public_key(), vec![3]).unwrap(),
            ),
            previous: Some(TorrentLink::new([8; 20])),
            ..Default::default()
        },
    );
    let head = catalog(
        &[vec![2]],
        FeedFields {
            previous: Some(TorrentLink::new(foreign.feed.infohash())),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &head, 1);
    metadata(&mut m, w, &head, true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Stage { work, id, .. } = a {
                (id == hex(&foreign.feed.infohash())).then_some(work)
            } else {
                None
            }
        })
        .unwrap();
    metadata(&mut m, w, &foreign, false);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. } | Action::Stage { .. })));
    assert!(!m.can_approve(&id, &hex(&foreign.feed.infohash())));
    assert_eq!(m.views()[0].catalogs.len(), 2);
}
#[test]
fn root_signed_identity_overrides_embedded_source() {
    let b = catalog(
        &[vec![1]],
        FeedFields {
            source: Some(
                feedtorrent_bep::bep44::MutableKey::new(
                    Bep44Signer::from_seed(&[5; 32]).public_key(),
                    vec![3],
                )
                .unwrap(),
            ),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, false);
    assert!(m.can_approve(&id, &hex(&b.feed.infohash())));
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
}
#[test]
fn nested_manual_open_in_current_mode_retains_source_and_identity() {
    let nested = catalog(&[vec![7]], Default::default());
    let head = catalog(std::slice::from_ref(&nested.metainfo), Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &head, 1);
    metadata(&mut m, w, &head, true);
    m.transfer(&hex(&head.feed.infohash()), "Seeding".into(), true);
    m.tick(2);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.item(w, nested.metainfo.clone(), None).unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. })));
    assert_eq!(
        m.download_item(&id, &hex(&head.feed.infohash()), 0)
            .unwrap(),
        hex(&nested.feed.infohash())
    );
    acts(&mut m);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.item(w, nested.metainfo.clone(), None).unwrap();
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Stage {
                work,
                role: Role::Catalog,
                ..
            } = a
            {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    metadata(&mut m, w, &nested, false);
    assert!(m.can_approve(&id, &hex(&nested.feed.infohash())));
}
#[test]
fn absence_or_invalid_record_never_removes_known_catalog() {
    let b = catalog(&[vec![1]], Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.refresh(&id, POLL_MS + 1).unwrap();
    let w = acts(&mut m).into_iter().find_map(|a| {
        if let Action::Lookup { work, .. } = a {
            Some(work)
        } else {
            None
        }
    });
    if let Some(w) = w {
        m.lookup_result(w, Ok(None), POLL_MS + 2);
    }
    assert_eq!(m.views()[0].head, Some(hex(&b.feed.infohash())));
    let wrong =
        TorrentPointer::sign(&Bep44Signer::from_seed(&[9; 32]), [3; 20], 2, vec![2]).unwrap();
    assert!(m
        .receive_record(&id, wrong.record().clone(), POLL_MS + 3)
        .is_err());
    assert_eq!(m.views()[0].sequence.as_deref(), Some("1"));
}
#[test]
fn failed_read_is_not_retried_until_refresh_and_auxiliary_corruption_is_visible() {
    let b = catalog(&[vec![4]], Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.transfer(&hex(&b.feed.infohash()), "Seeding".into(), true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    assert!(m
        .item_from_reader(w, Cursor::new(vec![5]), |_| None)
        .is_err());
    m.fail(w, "SHA-1 mismatch".into());
    m.tick(4);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Read { .. })));
    assert!(m.page(&id, &hex(&b.feed.infohash()), 0).unwrap().entries[0]
        .error
        .contains("SHA-1"));
    m.refresh(&id, 5).unwrap();
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Read { .. })));
}
#[test]
fn mode_downgrade_revokes_queued_automatic_permission() {
    let b = catalog(
        &[vec![1]],
        FeedFields {
            previous: Some(TorrentLink::new([4; 20])),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.tick(4);
    let actions = acts(&mut m);
    m.configure(&id, Config::default()).unwrap();
    for a in actions {
        if let Action::Stage {
            id: target, role, ..
        } = a
        {
            assert!(!m.should_stage(&id, &target, role));
        }
    }
}
#[test]
fn restored_references_are_pending_and_require_fresh_parent_validation() {
    let prev = [4; 20];
    let b = catalog(
        &[vec![1]],
        FeedFields {
            previous: Some(TorrentLink::new(prev)),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::MirrorCatalogs, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    let bytes = m.checkpoint().unwrap();
    let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(raw["references"][&id][hex(&prev)].is_object());
    let mut r = FeedManager::restore(&bytes).unwrap();
    r.start(0);
    let actions = acts(&mut r);
    assert!(!actions
        .iter()
        .any(|a| matches!(a,Action::Stage{id,..}if id==&hex(&prev))));
    assert!(!r.can_approve(&id, &hex(&prev)));
}
#[test]
fn a_signed_head_can_authorize_a_previously_external_catalog() {
    let external = catalog(
        &[vec![3]],
        FeedFields {
            source: Some(
                feedtorrent_bep::bep44::MutableKey::new(signer().public_key(), vec![3]).unwrap(),
            ),
            ..Default::default()
        },
    );
    let b = catalog(
        &[vec![1]],
        FeedFields {
            previous: Some(TorrentLink::new(external.feed.infohash())),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::MirrorCatalogs, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    m.tick(2);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Stage { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    metadata(&mut m, w, &external, false);
    assert!(!m.can_approve(&id, &hex(&external.feed.infohash())));
    let w = stage(&mut m, &id, &external, 2);
    metadata(&mut m, w, &external, false);
    assert!(m.can_approve(&id, &hex(&external.feed.infohash())));
}
#[test]
fn accepted_record_events_obey_the_checkpoint_barrier_and_are_bounded() {
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    m.receive_record(&id, record([1; 20], 1), 1).unwrap();
    assert!(m.drain_events().is_empty());
    m.acknowledge_checkpoint();
    assert!(m
        .drain_events()
        .iter()
        .any(|e| matches!(e, Event::RecordAccepted { sequence: 1, .. })));
    for _ in 0..1000 {
        m.notice(&id, "a remote warning".into());
    }
    assert_eq!(m.drain_events().len(), 128);
}
#[test]
fn unavailable_metadata_swarms_cannot_exhaust_the_short_work_budget() {
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    for seq in 1..80 {
        m.receive_record(&id, record([seq as u8; 20], seq), seq as u64)
            .unwrap();
        assert!(
            acts(&mut m)
                .iter()
                .any(|a| matches!(a, Action::Stage { .. })),
            "metadata wait starved revision {seq}"
        );
    }
}

#[test]
fn invalid_manual_decisions_do_not_poison_the_checkpoint() {
    let (mut m, _) = setup(Mode::CurrentCatalog, None);
    let old = m.checkpoint().unwrap();
    assert!(m.suppress("../not-a-hash").is_err());
    assert!(m.approve_once("no").is_err());
    assert_eq!(m.checkpoint().unwrap(), old);
    assert!(FeedManager::restore(&old).is_ok());
}

#[test]
fn explicit_download_retries_a_failed_content_stage() {
    let data = torrent();
    let b = catalog(std::slice::from_ref(&data), Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &b, 1);
    metadata(&mut m, w, &b, true);
    let parent = hex(&b.feed.infohash());
    m.transfer(&parent, "Seeding".into(), true);
    m.tick(3);
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Read { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.item(w, data, None).unwrap();
    let w = acts(&mut m)
        .into_iter()
        .find_map(|a| {
            if let Action::Stage { work, .. } = a {
                Some(work)
            } else {
                None
            }
        })
        .unwrap();
    m.fail(w, "Temporary storage error".into());
    m.tick(4);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Read { .. })));
    m.download_item(&id, &parent, 0).unwrap();
    assert!(acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Read { .. })));
}

#[test]
fn incompatible_backend_metadata_is_never_approved() {
    let b = catalog(&[vec![1]], Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &b, 1);
    assert!(m
        .metadata(
            w,
            Description {
                id: hex(&b.feed.infohash()),
                error: "Unsupported format".into(),
                ..Default::default()
            },
            b.feed.raw_info().to_vec(),
            false
        )
        .is_err());
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Approve { .. })));
}
