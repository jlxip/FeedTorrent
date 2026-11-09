use super::*;
fn sign(m: &mut Manager, id: &str, operation: u64, sequence: i64) {
    running(m, id, operation);
    m.signed(
        id,
        operation,
        record(&m.lib.posts[id], sequence, 9),
        BTreeMap::new(),
        vec![],
    )
    .unwrap();
}
fn values(m: &Manager) -> serde_json::Value {
    serde_json::to_value(view(&m.lib, String::new()).posts[0].clone()).unwrap()
}
#[test]
fn version_zero_is_assigned_only_by_signing_and_confirmed_only_after_ack() {
    let (dir, lib, ids) = fixture(1);
    let id = &ids[0];
    let mut m = manager(&dir, lib);
    let op = enqueue(&mut m, id);
    assert!(values(&m)["sequence"].is_null());
    assert!(values(&m)["pending_sequence"].is_null());
    assert!(values(&m)["published_sequence"].is_null());
    sign(&mut m, id, op, 0);
    assert_eq!(values(&m)["sequence"], "0");
    assert_eq!(values(&m)["pending_sequence"], "0");
    assert!(values(&m)["published_sequence"].is_null());
    m.finished(id.clone(), op, Ok(1));
    assert_eq!(values(&m)["published_sequence"], "0");
    assert!(values(&m)["pending_sequence"].is_null());
    let unsigned = enqueue(&mut m, id);
    assert!(values(&m)["pending_sequence"].is_null());
    assert_eq!(values(&m)["published_sequence"], "0");
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: unsigned,
    })
    .unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn identical_catalog_and_draft_keep_confirmation_through_retry_cancel_restart_and_stale_callbacks()
{
    let (dir, lib, ids) = fixture(1);
    let id = &ids[0];
    let mut m = manager(&dir, lib);
    let first = enqueue(&mut m, id);
    sign(&mut m, id, first, 7);
    m.finished(id.clone(), first, Ok(1));
    let same = enqueue(&mut m, id);
    sign(&mut m, id, same, 8);
    assert_eq!(
        m.lib.posts[id].signed_revision,
        m.lib.posts[id].published_revision
    );
    assert_eq!(
        m.lib.posts[id].record.as_ref().unwrap().value,
        record(&m.lib.posts[id], 7, 9).value
    );
    assert_eq!(values(&m)["published_sequence"], "7");
    assert_eq!(values(&m)["pending_sequence"], "8");
    m.finished(
        id.clone(),
        same,
        Err(PublicationFailure {
            message: "No acknowledgements".into(),
            transient: true,
        }),
    );
    let record_before = serde_json::to_vec(&m.lib.posts[id].record).unwrap();
    let mut restored = load(&m.dir).unwrap();
    recover(&mut restored).unwrap();
    assert_eq!(restored.posts[id].published_sequence, Some(7));
    assert_eq!(
        serde_json::to_vec(&restored.posts[id].record).unwrap(),
        record_before
    );
    m = manager(&dir, restored);
    m.command(Command::RetryPublication {
        id: id.clone(),
        operation: same,
    })
    .unwrap();
    assert_eq!(values(&m)["pending_sequence"], "8");
    assert_eq!(values(&m)["published_sequence"], "7");
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: same,
    })
    .unwrap();
    assert_eq!(values(&m)["sequence"], "8");
    assert!(values(&m)["pending_sequence"].is_null());
    assert_eq!(values(&m)["published_sequence"], "7");
    let next = enqueue(&mut m, id);
    sign(&mut m, id, next, 9);
    m.finished(id.clone(), same, Ok(8));
    assert_eq!(values(&m)["published_sequence"], "7");
    assert_eq!(values(&m)["pending_sequence"], "9");
    m.finished(
        id.clone(),
        next,
        Err(PublicationFailure {
            message: "Permanent failure".into(),
            transient: false,
        }),
    );
    assert_eq!(values(&m)["published_sequence"], "7");
    assert!(values(&m)["pending_sequence"].is_null());
    let success = enqueue(&mut m, id);
    sign(&mut m, id, success, 10);
    m.finished(id.clone(), success, Ok(1));
    assert_eq!(values(&m)["published_sequence"], "10");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn legacy_confirmation_requires_unambiguous_success_before_recovery() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 0);
    assert!(!serde_json::to_string(&lib)
        .unwrap()
        .contains("published_sequence"));
    let mut known = lib.clone();
    assert!(recover(&mut known).unwrap());
    assert_eq!(known.posts[id].published_sequence, Some(0));
    assert!(!recover(&mut known).unwrap());
    for state in [
        "Canceled",
        "Error",
        "Queued",
        "Publication pending",
        "Restored; publishing disabled",
    ] {
        let mut unknown = lib.clone();
        unknown.posts.get_mut(id).unwrap().state = state.into();
        recover(&mut unknown).unwrap();
        assert_eq!(unknown.posts[id].published_sequence, None, "{state}");
    }
    let mut mismatch = lib.clone();
    mismatch.posts.get_mut(id).unwrap().signed_revision = 2;
    recover(&mut mismatch).unwrap();
    assert_eq!(mismatch.posts[id].published_sequence, None);
    let mut pending_lib = lib.clone();
    let op = allocate(&mut pending_lib).unwrap();
    pending_lib.posts.get_mut(id).unwrap().pending = Some(pending(&lib.posts[id], op, false));
    recover(&mut pending_lib).unwrap();
    assert_eq!(pending_lib.posts[id].published_sequence, None);
    lib.posts
        .get_mut(id)
        .unwrap()
        .record
        .as_mut()
        .unwrap()
        .signature[0] ^= 1;
    assert!(recover(&mut lib).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn exact_large_sequences_survive_json_and_durable_restart() {
    for sequence in [9_007_199_254_740_993, i64::MAX] {
        let (dir, lib, ids) = fixture(1);
        let id = &ids[0];
        let mut m = manager(&dir, lib);
        let op = enqueue(&mut m, id);
        sign(&mut m, id, op, sequence);
        assert_eq!(values(&m)["pending_sequence"], sequence.to_string());
        m.finished(id.clone(), op, Ok(1));
        let restored = load(&m.dir).unwrap();
        assert_eq!(restored.posts[id].published_sequence, Some(sequence));
        let m = manager(&dir, restored);
        assert_eq!(values(&m)["published_sequence"], sequence.to_string());
        fs::remove_dir_all(dir).unwrap();
    }
}
#[test]
fn both_backup_types_preserve_confirmed_sequence_below_canceled_highwater() {
    let (dir, lib, ids) = fixture(1);
    let id = &ids[0];
    let mut m = manager(&dir, lib);
    let first = enqueue(&mut m, id);
    sign(&mut m, id, first, 7);
    m.finished(id.clone(), first, Ok(1));
    let later = enqueue(&mut m, id);
    sign(&mut m, id, later, 8);
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: later,
    })
    .unwrap();
    for full in [false, true] {
        let path = backup::export(&m.dir, &m.lib, full).unwrap();
        let target = dir.join(if full { "full" } else { "keys" });
        fs::create_dir_all(target.join("published")).unwrap();
        let restored = backup::import(
            &target,
            &Library::default(),
            &fs::read(path).unwrap(),
            &Password(PASSWORD.into()),
        )
        .unwrap();
        assert_eq!(restored.posts[id].published_sequence, Some(7));
        assert_eq!(restored.posts[id].record.as_ref().unwrap().sequence, 8);
        assert!(!restored.posts[id].active);
        assert!(restored.posts[id].pending.is_none());
    }
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn impossible_confirmed_sequence_is_rejected_without_changing_signed_record() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 7);
    lib.posts.get_mut(id).unwrap().published_sequence = Some(8);
    assert!(validate(&lib).is_err());
    lib.posts.get_mut(id).unwrap().published_sequence = Some(-1);
    assert!(validate(&lib).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_backup_recovers_proven_confirmation_before_disabling_publication() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 7);
    for full in [false, true] {
        for proven in [false, true] {
            let mut old = lib.clone();
            if !proven {
                let f = old.posts.get_mut(id).unwrap();
                f.record = Some(record(f, 8, 9));
                f.state = "Canceled".into();
            }
            let archive = backup::export(&dir, &old, full).unwrap();
            let target = dir.join(format!("restored-{full}-{proven}"));
            fs::create_dir_all(target.join("published")).unwrap();
            let restored = backup::import(
                &target,
                &Library::default(),
                &fs::read(archive).unwrap(),
                &Password(PASSWORD.into()),
            )
            .unwrap();
            assert_eq!(
                restored.posts[id].published_sequence,
                if proven { Some(7) } else { None }
            );
            assert_eq!(
                restored.posts[id].record.as_ref().unwrap().sequence,
                if proven { 7 } else { 8 }
            );
            assert!(!restored.posts[id].active);
            assert_eq!(restored.posts[id].state, "Restored; publishing disabled");
        }
    }
    fs::remove_dir_all(dir).unwrap();
}
