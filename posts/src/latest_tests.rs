use super::*;
use std::collections::BTreeSet;
fn load(
    m: &mut PostManager,
    id: &str,
    work: WorkId,
    b: &BuiltFeed,
    data: &[Vec<u8>],
) -> Vec<Action> {
    metadata(m, work, b, true);
    m.transfer(&hex(&b.feed.infohash()), "Completed".into(), true);
    m.tick(5);
    let mut result = vec![];
    for a in acts(m) {
        match a {
            Action::Read {
                work,
                catalog,
                index,
                ..
            } if catalog == hex(&b.feed.infohash()) => {
                m.item(work, data[index].clone(), None).unwrap();
            }
            Action::Approve { work, .. } => m.approved(work),
            a => result.push(a),
        }
    }
    m.tick(6);
    result.extend(acts(m));
    assert!(m.views().iter().any(|p| p.id == id));
    result
}
fn work_for(actions: &[Action], hash: &str) -> WorkId {
    actions
        .iter()
        .find_map(|a| match a {
            Action::Stage { work, id, .. } if id == hash => Some(*work),
            _ => None,
        })
        .unwrap_or_else(|| panic!("Missing stage for {hash}: {actions:?}"))
}
fn snapshot(m: &mut PostManager) -> LatestRetention {
    m.acknowledge_checkpoint();
    m.latest_retention().remove(0)
}
#[test]
fn latest_recurses_items_not_history_and_waits_for_verified_payload() {
    let payload = torrent();
    let child = catalog(std::slice::from_ref(&payload), Default::default());
    let root = catalog(
        std::slice::from_ref(&child.metainfo),
        FeedFields {
            previous: Some(TorrentLink::new([4; 20])),
            archive_next: Some(TorrentLink::new([5; 20])),
            ..Default::default()
        },
    );
    let (mut m, id) = setup(Mode::LatestRecursiveMirror, None);
    let w = stage(&mut m, &id, &root, 1);
    let a = load(&mut m, &id, w, &root, std::slice::from_ref(&child.metainfo));
    let hchild = hex(&child.feed.infohash());
    assert!(!a
        .iter()
        .any(|a| matches!(a,Action::Stage{id,..} if id == &hex(&[4;20]) || id == &hex(&[5;20]))));
    let w = work_for(&a, &hchild);
    let a = load(&mut m, &id, w, &child, std::slice::from_ref(&payload));
    let feedtorrent_bep::bep49::ItemContent::Torrent(t) =
        feedtorrent_bep::bep49::inspect_item(&payload)
    else {
        panic!()
    };
    let content = hex(&t.infohash());
    work_for(&a, &content);
    assert!(!snapshot(&mut m).collect);
    m.transfer(&content, "Paused".into(), true);
    m.tick(7);
    assert!(!snapshot(&mut m).collect);
    m.transfer(&content, "Completed".into(), true);
    m.tick(8);
    assert!(!m.latest_retention()[0].collect, "checkpoint barrier");
    let r = snapshot(&mut m);
    assert!(r.collect);
    assert_eq!(
        r.assets,
        [hex(&root.feed.infohash()), hchild, content]
            .into_iter()
            .collect()
    );
}
#[test]
fn incomplete_and_superseded_versions_keep_the_last_complete_generation() {
    let old_data = vec![b"old disk".to_vec()];
    let old = catalog(&old_data, Default::default());
    let (mut m, id) = setup(Mode::LatestRecursiveMirror, None);
    let w = stage(&mut m, &id, &old, 1);
    load(&mut m, &id, w, &old, &old_data);
    assert!(snapshot(&mut m).collect);
    let b_data = vec![b"intermediate".to_vec()];
    let b = catalog(&b_data, Default::default());
    let wb = stage(&mut m, &id, &b, 2);
    assert!(!snapshot(&mut m).collect);
    assert!(snapshot(&mut m).assets.contains(&hex(&old.feed.infohash())));
    let c_data = vec![b"new disk".to_vec()];
    let c = catalog(&c_data, Default::default());
    let wc = stage(&mut m, &id, &c, 3);
    load(&mut m, &id, wb, &b, &b_data);
    assert!(
        !snapshot(&mut m).collect,
        "late completion cannot commit an obsolete head"
    );
    load(&mut m, &id, wc, &c, &c_data);
    let r = snapshot(&mut m);
    assert!(r.collect);
    assert_eq!(r.assets, [hex(&c.feed.infohash())].into_iter().collect());
    m.receive_record(&id, record(c.feed.infohash(), 4), 9)
        .unwrap();
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a, Action::Stage { .. })));
    m.configure(&id, Config::default()).unwrap();
    assert!(m.latest_retention().is_empty());
}
#[test]
fn checkpoint_restore_revalidates_and_legacy_modes_keep_their_identifiers() {
    let data = vec![b"complete".to_vec()];
    let b = catalog(&data, Default::default());
    let (mut m, id) = setup(Mode::LatestRecursiveMirror, None);
    let w = stage(&mut m, &id, &b, 1);
    load(&mut m, &id, w, &b, &data);
    assert!(snapshot(&mut m).collect);
    let bytes = m.checkpoint().unwrap();
    let mut restored = PostManager::restore(&bytes).unwrap();
    restored.start(0);
    assert!(!snapshot(&mut restored).collect);
    let a = acts(&mut restored);
    let w = work_for(&a, &hex(&b.feed.infohash()));
    load(&mut restored, &id, w, &b, &data);
    assert!(snapshot(&mut restored).collect);
    for version in [1, 2] {
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["version"] = version.into();
        value["posts"][&id]["config"]["mode"] = "mirror_all".into();
        value.as_object_mut().unwrap().remove("latest");
        let legacy = PostManager::restore(&serde_json::to_vec(&value).unwrap()).unwrap();
        let checkpoint: serde_json::Value =
            serde_json::from_slice(&legacy.checkpoint().unwrap()).unwrap();
        assert_eq!(checkpoint["posts"][&id]["config"]["mode"], "mirror_all");
        assert!(legacy.dirty());
        assert_eq!(checkpoint["version"], 3);
    }
    assert_eq!(
        serde_json::to_string(&Mode::LatestRecursiveMirror).unwrap(),
        "\"latest_recursive_mirror\""
    );
}
#[test]
fn explicit_download_survives_parent_retirement_and_does_not_make_download_once_a_pin() {
    let payload = torrent();
    let b = catalog(std::slice::from_ref(&payload), Default::default());
    let (mut m, id) = setup(Mode::LatestRecursiveMirror, None);
    let w = stage(&mut m, &id, &b, 1);
    load(&mut m, &id, w, &b, std::slice::from_ref(&payload));
    let content = m.download_item(&id, &hex(&b.feed.infohash()), 0).unwrap();
    assert!(snapshot(&mut m).manual.contains(&content));
    m.removed(&hex(&b.feed.infohash()));
    let data = vec![b"replacement".to_vec()];
    let next = catalog(&data, Default::default());
    let w = stage(&mut m, &id, &next, 2);
    load(&mut m, &id, w, &next, &data);
    let r = snapshot(&mut m);
    assert!(r.collect);
    assert!(r.manual.contains(&content));
    let mut restored = PostManager::restore(&m.checkpoint().unwrap()).unwrap();
    restored.start(0);
    let actions = acts(&mut restored);
    let w = work_for(&actions, &hex(&next.feed.infohash()));
    load(&mut restored, &id, w, &next, &data);
    assert!(snapshot(&mut restored).collect);
    assert!(snapshot(&mut restored).manual.contains(&content));
    let random = hex(&[9; 20]);
    restored.approve_once(&random).unwrap();
    assert!(!snapshot(&mut restored).manual.contains(&random));
}
#[test]
fn foreign_identity_is_excluded_from_latest_completion_and_recursion() {
    let foreign = catalog(
        &[torrent()],
        FeedFields {
            source: Some(
                feedtorrent_bep::bep44::MutableKey::new(signer().public_key(), vec![9]).unwrap(),
            ),
            ..Default::default()
        },
    );
    let b = catalog(std::slice::from_ref(&foreign.metainfo), Default::default());
    let (mut m, id) = setup(Mode::LatestRecursiveMirror, None);
    let w = stage(&mut m, &id, &b, 1);
    let a = load(&mut m, &id, w, &b, std::slice::from_ref(&foreign.metainfo));
    assert!(!a.iter().any(|a| matches!(a, Action::Stage { .. })));
    assert!(snapshot(&mut m).collect);
    assert_eq!(
        snapshot(&mut m).assets,
        BTreeSet::from([hex(&b.feed.infohash())])
    );
}

#[test]
fn switching_to_latest_does_not_recreate_previously_approved_history() {
    let data = vec![b"previous".to_vec()];
    let old = catalog(&data, Default::default());
    let (mut m, id) = setup(Mode::CurrentCatalog, None);
    let w = stage(&mut m, &id, &old, 1);
    load(&mut m, &id, w, &old, &data);
    let previous = hex(&old.feed.infohash());
    m.approve_once(&previous).unwrap();
    acts(&mut m);
    let data = vec![b"latest".to_vec()];
    let new = catalog(
        &data,
        FeedFields {
            previous: Some(TorrentLink::new(old.feed.infohash())),
            ..Default::default()
        },
    );
    let w = stage(&mut m, &id, &new, 2);
    load(&mut m, &id, w, &new, &data);
    m.configure(
        &id,
        Config {
            mode: Mode::LatestRecursiveMirror,
            automatic_limit: None,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(snapshot(&mut m).collect);
    acts(&mut m);
    m.removed(&previous);
    m.tick(10);
    assert!(!acts(&mut m)
        .iter()
        .any(|a| matches!(a,Action::Stage{id,..} if id==&previous)));
    assert!(!snapshot(&mut m).assets.contains(&previous));
}

#[test]
fn legacy_manual_download_in_a_historical_nested_catalog_is_resolved_before_collection() {
    let payload = torrent();
    let nested = catalog(std::slice::from_ref(&payload), Default::default());
    let old = catalog(std::slice::from_ref(&nested.metainfo), Default::default());
    let (mut m, id) = setup(Mode::MirrorAll, None);
    let w = stage(&mut m, &id, &old, 1);
    let a = load(&mut m, &id, w, &old, std::slice::from_ref(&nested.metainfo));
    let w = work_for(&a, &hex(&nested.feed.infohash()));
    load(&mut m, &id, w, &nested, std::slice::from_ref(&payload));
    let content = m
        .download_item(&id, &hex(&nested.feed.infohash()), 0)
        .unwrap();
    m.transfer(&content, "Completed".into(), true);
    acts(&mut m);
    let data = vec![b"latest without old disk".to_vec()];
    let new = catalog(
        &data,
        FeedFields {
            previous: Some(TorrentLink::new(old.feed.infohash())),
            ..Default::default()
        },
    );
    let w = stage(&mut m, &id, &new, 2);
    load(&mut m, &id, w, &new, &data);
    m.configure(
        &id,
        Config {
            mode: Mode::LatestRecursiveMirror,
            automatic_limit: None,
            ..Default::default()
        },
    )
    .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&m.checkpoint().unwrap()).unwrap();
    value["version"] = 2.into();
    for field in ["latest", "manual_downloads", "resolved_manual"] {
        value.as_object_mut().unwrap().remove(field);
    }
    let mut m = PostManager::restore(&serde_json::to_vec(&value).unwrap()).unwrap();
    m.start(0);
    let a = acts(&mut m);
    let old_work = work_for(&a, &hex(&old.feed.infohash()));
    let new_work = work_for(&a, &hex(&new.feed.infohash()));
    load(&mut m, &id, new_work, &new, &data);
    assert!(
        !snapshot(&mut m).collect,
        "old manual index must be resolved before collection"
    );
    let a = load(
        &mut m,
        &id,
        old_work,
        &old,
        std::slice::from_ref(&nested.metainfo),
    );
    let w = work_for(&a, &hex(&nested.feed.infohash()));
    load(&mut m, &id, w, &nested, std::slice::from_ref(&payload));
    let r = snapshot(&mut m);
    assert!(r.collect);
    assert!(r.manual.contains(&content));
    assert_eq!(r.assets, BTreeSet::from([hex(&new.feed.infohash())]));
}
