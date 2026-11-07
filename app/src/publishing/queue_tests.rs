use super::*;
use feedtorrent_bep::bep44::DhtError;
use std::sync::OnceLock;
const PASSWORD: &str = "publication queue test password";
fn key() -> (Vault, [u8; 32]) {
    static KEY: OnceLock<(Vault, [u8; 32])> = OnceLock::new();
    KEY.get_or_init(|| {
        let vault = Vault::create(&Password(PASSWORD.into())).unwrap();
        let seed = *vault.unlock(&Password(PASSWORD.into())).unwrap();
        (vault, seed)
    })
    .clone()
}
fn root() -> PathBuf {
    super::super::tests::root()
}
fn fixture(count: usize) -> (PathBuf, Library, Vec<String>) {
    let dir = root();
    let publishing = dir.join("publishing");
    fs::create_dir_all(publishing.join("catalogs")).unwrap();
    let (vault, _) = key();
    let mut lib = Library {
        vault: Some(vault.clone()),
        ..Library::default()
    };
    let mut ids = vec![];
    for i in 0..count {
        let key = MutableKey::new(
            unhex(&vault.public_key).unwrap().try_into().unwrap(),
            vec![i as u8; 32],
        )
        .unwrap();
        let id = hex(&key.target());
        let mut draft = Draft::new(format!("Post {i}"));
        draft.pages[0].body = format!("snapshot {i}");
        lib.posts.insert(
            id.clone(),
            Owned {
                id: id.clone(),
                magnet: bep46::format_magnet(&key),
                title: format!("Post {i}"),
                draft,
                revision: 1,
                published_revision: 0,
                published_sequence: None,
                published: None,
                changed_at_us: 0,
                signed_revision: 0,
                pages: BTreeMap::new(),
                record: None,
                history: vec![],
                active: false,
                state: "Draft".into(),
                error: String::new(),
                pending: None,
            },
        );
        ids.push(id);
    }
    persist(&publishing, &lib).unwrap();
    (dir, lib, ids)
}
fn manager(dir: &Path, lib: Library) -> Manager {
    let (tx, _rx) = mpsc::sync_channel(32);
    let (native, _native_rx) = mpsc::sync_channel(32);
    let (views, _) = watch::channel(view(&lib, String::new()));
    Manager {
        dir: dir.join("publishing"),
        lib,
        disabled: None,
        error: String::new(),
        tx,
        native,
        views,
        running: BTreeMap::new(),
        secrets: BTreeMap::new(),
        handles: vec![],
        renewals: BTreeMap::new(),
        retry_delay: Duration::from_secs(30),
        stopping: false,
    }
}
fn enqueue(m: &mut Manager, id: &str) -> u64 {
    m.command(Command::Publish {
        id: id.into(),
        revision: m.lib.posts[id].revision,
        password: Password(PASSWORD.into()),
    })
    .unwrap()["operation"]
        .as_u64()
        .unwrap()
}
fn running(m: &mut Manager, id: &str, operation: u64) {
    m.running.insert(
        id.into(),
        Running {
            operation,
            cancel: Arc::new(AtomicBool::new(false)),
        },
    );
}
fn record(f: &Owned, sequence: i64, hash: u8) -> SignedRecord {
    let key = bep46::parse_magnet(&f.magnet).unwrap();
    let signer = Bep44Signer::from_seed(&key_seed());
    SignedRecord::from_record(
        TorrentPointer::sign(&signer, [hash; 20], sequence, key.salt().to_vec())
            .unwrap()
            .record(),
    )
}
fn key_seed() -> [u8; 32] {
    key().1
}
fn install_record(f: &mut Owned, sequence: i64) {
    f.record = Some(record(f, sequence, 9));
    f.signed_revision = 1;
    f.published_revision = 1;
    f.state = "Published".into();
}
#[test]
fn snapshots_are_durable_duplicate_guarded_and_secrets_are_not_serialized() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let operation = enqueue(&mut m, &ids[0]);
    let original = m.lib.posts[&ids[0]].pending.as_ref().unwrap().draft.clone();
    let mut draft = original.clone();
    draft.pages[0].body = "later edit".into();
    m.command(Command::SaveDraft {
        id: ids[0].clone(),
        revision: 1,
        draft,
    })
    .unwrap();
    let saved = load(&m.dir).unwrap();
    assert_eq!(
        saved.posts[&ids[0]].pending.as_ref().unwrap().draft,
        original
    );
    assert_eq!(saved.posts[&ids[0]].pending.as_ref().unwrap().id, operation);
    assert!(m
        .command(Command::Publish {
            id: ids[0].clone(),
            revision: 2,
            password: Password(PASSWORD.into())
        })
        .is_err());
    let json = fs::read_to_string(m.dir.join("library.json")).unwrap();
    assert!(!json.contains(PASSWORD));
    assert!(!json.contains("password"));
    assert!(!json.contains("seed"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn stale_callbacks_and_commands_cannot_replace_a_new_job() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let first = enqueue(&mut m, id);
    running(&mut m, id, first);
    let token = m.running[id].cancel.clone();
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: first,
    })
    .unwrap();
    assert!(token.load(Ordering::Acquire));
    assert!(!m.secrets.contains_key(&first));
    let second = enqueue(&mut m, id);
    assert!(second > first);
    assert!(m.phase(id, first, "Preparing".into()).is_err());
    assert!(m
        .signed(
            id,
            first,
            record(&m.lib.posts[id], 0, 3),
            BTreeMap::new(),
            vec![]
        )
        .is_err());
    m.finished(id.clone(), first, Ok(4));
    assert_eq!(m.lib.posts[id].pending.as_ref().unwrap().id, second);
    assert_eq!(m.lib.posts[id].published_revision, 0);
    assert!(m
        .command(Command::CancelPublication {
            id: id.clone(),
            operation: first
        })
        .is_err());
    assert!(m
        .command(Command::RetryPublication {
            id: id.clone(),
            operation: first
        })
        .is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn canceled_signed_record_is_retained_and_unsigned_restart_never_revives_it() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    let signed = record(&m.lib.posts[id], 7, 4);
    m.signed(id, op, signed.clone(), BTreeMap::new(), vec![])
        .unwrap();
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: op,
    })
    .unwrap();
    assert_eq!(
        m.lib.posts[id].record.as_ref().unwrap().signature,
        signed.signature
    );
    assert_eq!(m.lib.posts[id].published_revision, 0);
    m.finished(id.clone(), op, Ok(3));
    assert_eq!(m.lib.posts[id].state, "Canceled");
    enqueue(&mut m, id);
    let mut reloaded = load(&m.dir).unwrap();
    recover(&mut reloaded).unwrap();
    assert!(reloaded.posts[id].pending.is_none());
    assert!(!reloaded.posts[id].active);
    assert_eq!(reloaded.posts[id].record.as_ref().unwrap().sequence, 7);
    assert_eq!(reloaded.posts[id].state, "Canceled");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn old_record_is_not_a_signed_retry_for_a_new_snapshot() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 4);
    lib.posts.get_mut(id).unwrap().revision = 2;
    let mut m = manager(&dir, lib);
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    m.finished(
        id.clone(),
        op,
        Err(PublicationFailure::from(anyhow::Error::new(
            native::Failure::Dht(DhtError::Timeout),
        ))),
    );
    let f = &m.lib.posts[id];
    assert!(f.pending.as_ref().unwrap().signed.is_none());
    assert_eq!(f.record.as_ref().unwrap().sequence, 4);
    assert_eq!(f.pending.as_ref().unwrap().revision, 2);
    assert_eq!(f.pending.as_ref().unwrap().phase, "Retrying");
    m.command(Command::RetryPublication {
        id: id.clone(),
        operation: op,
    })
    .unwrap();
    assert_eq!(m.lib.posts[id].pending.as_ref().unwrap().retry_at, None);
    assert_eq!(m.lib.posts[id].pending.as_ref().unwrap().id, op);
    let mut recovered = load(&m.dir).unwrap();
    recover(&mut recovered).unwrap();
    assert!(!recovered.posts[id].active);
    assert!(recovered.posts[id].pending.is_none());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn migration_resumes_only_the_matching_signed_revision() {
    let (dir, mut lib, ids) = fixture(2);
    lib.version = 1;
    for id in &ids {
        install_record(lib.posts.get_mut(id).unwrap(), 4);
        let f = lib.posts.get_mut(id).unwrap();
        f.revision = 3;
        f.active = true;
    }
    lib.posts.get_mut(&ids[0]).unwrap().state = "Publication pending".into();
    lib.posts.get_mut(&ids[1]).unwrap().state = "Preparing".into();
    assert!(recover(&mut lib).unwrap());
    assert_eq!(lib.version, 2);
    assert_eq!(lib.posts[&ids[0]].pending.as_ref().unwrap().revision, 1);
    assert_eq!(
        lib.posts[&ids[0]]
            .pending
            .as_ref()
            .unwrap()
            .signed
            .as_ref()
            .unwrap()
            .sequence,
        4
    );
    assert!(lib.posts[&ids[1]].pending.is_none());
    assert_eq!(lib.posts[&ids[1]].state, "Canceled");
    validate(&lib).unwrap();
    persist(&dir.join("publishing"), &lib).unwrap();
    let mut again = load(&dir.join("publishing")).unwrap();
    let next = again.next_operation;
    recover(&mut again).unwrap();
    assert_eq!(again.next_operation, next);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn signed_recovery_and_failed_phase_commit_preserve_public_state() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    let signed = record(&m.lib.posts[id], 2, 3);
    m.signed(id, op, signed.clone(), BTreeMap::new(), vec![])
        .unwrap();
    let original = fs::read(m.dir.join("library.json")).unwrap();
    let path = m.dir.join("library.json");
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(m.phase(id, op, "Publishing".into()).is_err());
    assert_eq!(fs::read(path.with_extension("saved")).unwrap(), original);
    fs::remove_dir(&path).unwrap();
    fs::rename(path.with_extension("saved"), &path).unwrap();
    let mut again = load(&m.dir).unwrap();
    recover(&mut again).unwrap();
    assert_eq!(
        again.posts[id]
            .pending
            .as_ref()
            .unwrap()
            .signed
            .as_ref()
            .unwrap()
            .signature,
        signed.signature
    );
    assert_eq!(again.posts[id].pending.as_ref().unwrap().id, op);
    assert_eq!(again.posts[id].pending.as_ref().unwrap().phase, "Queued");
    fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn fifo_queue_limits_workers_and_cancel_frees_a_slot_without_waiting_for_network() {
    let (dir, _, ids) = fixture(4);
    let (native, rx) = mpsc::sync_channel::<NativeTask>(16);
    let (client, thread) = start(&dir, native, Duration::from_secs(30)).unwrap();
    let mut ops = vec![];
    for id in &ids {
        ops.push(
            client
                .call(Command::Publish {
                    id: id.clone(),
                    revision: 1,
                    password: Password(PASSWORD.into()),
                })
                .await
                .unwrap()["operation"]
                .as_u64()
                .unwrap(),
        );
    }
    super::super::tests::until(&client, |v| {
        v.posts.iter().filter(|f| f.phase == "Checking DHT").count() == 2
    })
    .await;
    let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let second = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(rx.try_recv().is_err());
    let target = |t: &NativeTask| match &t.command {
        Native::Lookup(k) => hex(&k.target()),
        _ => panic!("Unexpected command"),
    };
    assert_eq!(
        BTreeSet::from([target(&first), target(&second)]),
        BTreeSet::from([ids[0].clone(), ids[1].clone()])
    );
    client
        .call(Command::CancelPublication {
            id: ids[0].clone(),
            operation: ops[0],
        })
        .await
        .unwrap();
    let third = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(target(&third), ids[2]);
    assert!(first.cancel.load(Ordering::Acquire));
    let _ = first.reply.send(Ok(NativeReply::Record(None)));
    assert!(rx.try_recv().is_err());
    client.stop();
    thread.join().unwrap();
    let mut saved = load(&dir.join("publishing")).unwrap();
    recover(&mut saved).unwrap();
    assert!(saved.posts.values().all(|f| f.pending.is_none()));
    assert_eq!(saved.posts[&ids[3]].draft.pages[0].body, "snapshot 3");
    fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn unsigned_timeout_retries_the_snapshot_and_signs_above_canceled_sequence() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 7);
    lib.posts.get_mut(id).unwrap().revision = 2;
    persist(&dir.join("publishing"), &lib).unwrap();
    let (native, rx) = mpsc::sync_channel::<NativeTask>(16);
    let records = Arc::new(Mutex::new(vec![]));
    let observed = records.clone();
    let folder = dir.clone();
    let peer = std::thread::spawn(move || {
        let mut lookups = 0;
        for task in rx {
            let result = match task.command {
                Native::Lookup(_) => {
                    lookups += 1;
                    if lookups == 1 {
                        Err(native::Failure::Dht(DhtError::Timeout))
                    } else {
                        Ok(NativeReply::Record(None))
                    }
                }
                Native::Location(hash) => {
                    Ok(NativeReply::Location(folder.join("payload").join(hash)))
                }
                Native::Link { .. }
                | Native::Reserve { .. }
                | Native::Seed(_)
                | Native::Ready(_) => Ok(NativeReply::Ready),
                Native::Put(record) => {
                    observed.lock().unwrap().push(record);
                    Ok(NativeReply::Stored(1))
                }
            };
            let _ = task.reply.send(result);
        }
        assert_eq!(lookups, 2);
    });
    let (client, thread) = start(&dir, native, Duration::from_millis(10)).unwrap();
    client
        .call(Command::Publish {
            id: id.clone(),
            revision: 2,
            password: Password(PASSWORD.into()),
        })
        .await
        .unwrap();
    let mut later = lib.posts[id].draft.clone();
    later.pages[0].body = "later draft".into();
    client
        .call(Command::SaveDraft {
            id: id.clone(),
            revision: 2,
            draft: later,
        })
        .await
        .unwrap();
    super::super::tests::until(&client, |v| v.posts[0].state == "Published").await;
    let f = client.view.borrow().posts[0].clone();
    assert_eq!(f.published_revision, 2);
    assert_eq!(f.revision, 3);
    client.stop();
    thread.join().unwrap();
    drop(client);
    peer.join().unwrap();
    let records = records.lock().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].sequence(), 8);
    let saved = load(&dir.join("publishing")).unwrap();
    let hash = saved.posts[id].pages[&saved.posts[id].draft.root]
        .hash
        .clone();
    let package = package(&dir.join("publishing"), &hash).unwrap();
    assert!(package.files.iter().any(|(_, b)| b == b"snapshot 0"));
    assert!(!package.files.iter().any(|(_, b)| b == b"later draft"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn permanent_failure_does_not_resume_the_previous_record() {
    let (dir, mut lib, ids) = fixture(1);
    let id = &ids[0];
    install_record(lib.posts.get_mut(id).unwrap(), 4);
    let mut m = manager(&dir, lib);
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    m.finished(
        id.clone(),
        op,
        Err(PublicationFailure {
            message: "Incorrect password".into(),
            transient: false,
        }),
    );
    assert_eq!(m.lib.posts[id].state, "Error");
    assert!(!m.lib.posts[id].active);
    assert!(m.lib.posts[id].pending.is_none());
    assert!(!m.secrets.contains_key(&op));
    assert_eq!(m.lib.posts[id].record.as_ref().unwrap().sequence, 4);
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn cancellation_during_lookup_checking_and_put_ignores_late_native_results() {
    for stage in ["lookup", "checking", "put"] {
        let (dir, _, ids) = fixture(1);
        let (native, rx) = mpsc::sync_channel::<NativeTask>(16);
        let (observed, held) = mpsc::channel();
        let folder = dir.clone();
        let peer = std::thread::spawn(move || {
            let mut interrupted = false;
            for task in rx {
                let target = matches!(
                    (&task.command, stage),
                    (Native::Lookup(_), "lookup")
                        | (Native::Seed(_), "checking")
                        | (Native::Put(_), "put")
                );
                if target && !interrupted {
                    interrupted = true;
                    observed.send(task).unwrap();
                    continue;
                }
                let result = match task.command {
                    Native::Lookup(_) => NativeReply::Record(None),
                    Native::Location(hash) => {
                        NativeReply::Location(folder.join("payload").join(hash))
                    }
                    Native::Link { .. }
                    | Native::Reserve { .. }
                    | Native::Seed(_)
                    | Native::Ready(_) => NativeReply::Ready,
                    Native::Put(_) => NativeReply::Stored(1),
                };
                let _ = task.reply.send(Ok(result));
            }
        });
        let (client, thread) = start(&dir, native, Duration::from_secs(30)).unwrap();
        let id = &ids[0];
        let op = client
            .call(Command::Publish {
                id: id.clone(),
                revision: 1,
                password: Password(PASSWORD.into()),
            })
            .await
            .unwrap()["operation"]
            .as_u64()
            .unwrap();
        let late = held.recv_timeout(Duration::from_secs(10)).unwrap();
        client
            .call(Command::CancelPublication {
                id: id.clone(),
                operation: op,
            })
            .await
            .unwrap();
        assert!(late.cancel.load(Ordering::Acquire));
        assert_eq!(client.view.borrow().posts[0].published_revision, 0);
        let saved = load(&dir.join("publishing")).unwrap();
        assert_eq!(saved.posts[id].record.is_some(), stage == "put");
        let result = match late.command {
            Native::Lookup(_) => NativeReply::Record(None),
            Native::Link { .. } | Native::Reserve { .. } | Native::Seed(_) => NativeReply::Ready,
            Native::Put(_) => NativeReply::Stored(3),
            _ => panic!("Unexpected held command"),
        };
        let _ = late.reply.send(Ok(result));
        let next = client
            .call(Command::Publish {
                id: id.clone(),
                revision: 1,
                password: Password(PASSWORD.into()),
            })
            .await
            .unwrap()["operation"]
            .as_u64()
            .unwrap();
        assert!(next > op);
        super::super::tests::until(&client, |v| v.posts[0].state == "Published").await;
        let expected = if stage == "put" { "1" } else { "0" };
        assert_eq!(
            client.view.borrow().posts[0].sequence.as_deref(),
            Some(expected)
        );
        assert_eq!(client.view.borrow().posts[0].published_revision, 1);
        client.stop();
        thread.join().unwrap();
        drop(client);
        peer.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn removing_post_cancels_jobs_and_fences_late_callbacks_without_touching_other_data() {
    let (dir, lib, ids) = fixture(2);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let other = serde_json::to_vec(&m.lib.posts[&ids[1]]).unwrap();
    let vault = serde_json::to_vec(&m.lib.vault).unwrap();
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    let cancel = m.running[id].cancel.clone();
    let credentials = m.secrets[&op].clone();
    let signed = record(&m.lib.posts[id], 3, 9);
    m.renewals.insert(id.clone(), Instant::now());
    let package = m.dir.join("catalogs/keep.json");
    fs::write(&package, b"existing catalog").unwrap();
    m.command(Command::RemovePost { id: id.clone() }).unwrap();
    assert!(cancel.load(Ordering::Acquire));
    assert!(credentials.lock().unwrap().is_none());
    assert!(!m.secrets.contains_key(&op));
    assert!(!m.renewals.contains_key(id));
    assert!(!load(&m.dir).unwrap().posts.contains_key(id));
    assert_eq!(serde_json::to_vec(&m.lib.posts[&ids[1]]).unwrap(), other);
    assert_eq!(serde_json::to_vec(&m.lib.vault).unwrap(), vault);
    assert_eq!(fs::read(package).unwrap(), b"existing catalog");
    assert!(m.phase(id, op, "Publishing".into()).is_err());
    assert!(m.signed(id, op, signed, BTreeMap::new(), vec![]).is_err());
    m.finished(id.clone(), op, Ok(2));
    assert!(m
        .command(Command::SaveDraft {
            id: id.clone(),
            revision: 1,
            draft: Draft::new("late".into())
        })
        .is_err());
    assert!(m.command(Command::RemovePost { id: id.clone() }).is_err());
    m.pump().unwrap();
    assert!(!m.lib.posts.contains_key(id));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn failed_removal_preserves_persistent_draft_and_live_credentials() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    let cancel = m.running[id].cancel.clone();
    let path = m.dir.join("library.json");
    let before = fs::read(&path).unwrap();
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(m.command(Command::RemovePost { id: id.clone() }).is_err());
    assert!(!cancel.load(Ordering::Acquire));
    assert!(m.secrets[&op].lock().unwrap().is_some());
    assert_eq!(m.lib.posts[id].pending.as_ref().unwrap().id, op);
    assert_eq!(fs::read(path.with_extension("saved")).unwrap(), before);
    fs::remove_dir(&path).unwrap();
    fs::rename(path.with_extension("saved"), &path).unwrap();
    assert!(load(&m.dir).unwrap().posts.contains_key(id));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn removed_posts_are_absent_from_new_backups_and_old_backups_restore_explicitly() {
    let (dir, lib, ids) = fixture(3);
    let mut m = manager(&dir, lib);
    install_record(m.lib.posts.get_mut(&ids[1]).unwrap(), 5);
    m.lib.posts.get_mut(&ids[2]).unwrap().state = "Error".into();
    let backup = backup::export(&m.dir, &m.lib, false).unwrap();
    for id in &ids {
        m.command(Command::RemovePost { id: id.clone() }).unwrap();
    }
    let mut saved = load(&m.dir).unwrap();
    recover(&mut saved).unwrap();
    assert!(saved.posts.is_empty());
    assert!(saved.vault.is_some());
    let fresh = backup::export(&m.dir, &saved, false).unwrap();
    let fresh = backup::import(
        &m.dir,
        &Library::default(),
        &fs::read(fresh).unwrap(),
        &Password(PASSWORD.into()),
    )
    .unwrap();
    assert!(fresh.posts.is_empty());
    let restored = backup::import(
        &m.dir,
        &saved,
        &fs::read(backup).unwrap(),
        &Password(PASSWORD.into()),
    )
    .unwrap();
    assert_eq!(restored.posts.len(), 3);
    assert!(restored
        .posts
        .values()
        .all(|f| !f.active && f.pending.is_none()));
    assert_eq!(
        restored.vault.unwrap().public_key,
        saved.vault.unwrap().public_key
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn readers_keep_confirmed_dates_through_signed_retries_cancellation_and_backups() {
    let (dir, lib, ids) = fixture(1);
    let mut m = manager(&dir, lib);
    let id = &ids[0];
    let operation = enqueue(&mut m, id);
    let prepared = m.lib.posts[id]
        .pending
        .as_ref()
        .unwrap()
        .prepared_at
        .unwrap();
    let key = bep46::parse_magnet(&m.lib.posts[id].magnet).unwrap();
    let first = m.lib.posts[id]
        .draft
        .build(&key, &BTreeMap::new(), prepared)
        .unwrap();
    let pages = |built: &feedtorrent_posts::publishing::Publication| {
        built
            .pages
            .iter()
            .map(|(&id, p)| {
                (
                    id,
                    PageRef {
                        fingerprint: p.fingerprint.clone(),
                        hash: hex(&Feed::from_metainfo(&p.metainfo).unwrap().infohash()),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let sign = |root, seq| {
        SignedRecord::from_record(
            TorrentPointer::sign(
                &Bep44Signer::from_seed(&key_seed()),
                root,
                seq,
                key.salt().to_vec(),
            )
            .unwrap()
            .record(),
        )
    };
    for c in &first.catalogs {
        store_package(&m.dir, c).unwrap();
    }
    running(&mut m, id, operation);
    m.signed(
        id,
        operation,
        sign(first.root, 0),
        pages(&first),
        vec![hex(&first.root)],
    )
    .unwrap();
    let get = |m: &mut Manager| m.command(Command::GetPost { id: id.clone() }).unwrap();
    assert_eq!(get(&mut m)["published_dates"], serde_json::json!({}));
    m.finished(id.clone(), operation, Ok(1));
    let dates = get(&mut m)["published_dates"].clone();
    assert_eq!(dates["1"]["created_at"], prepared);
    assert_eq!(dates["1"]["updated_at"], prepared);
    assert_eq!(get(&mut m)["draft_differs"], false);
    let original = m.lib.posts[id].draft.clone();
    let mut draft = original.clone();
    draft.pages[0].body = "second published snapshot".into();
    m.command(Command::SaveDraft {
        id: id.clone(),
        revision: 1,
        draft: draft.clone(),
    })
    .unwrap();
    let second_operation = enqueue(&mut m, id);
    let second_clock = m.lib.posts[id].pending.as_ref().unwrap().prepared_at;
    let second = draft.build(&key, &first.pages, prepared + 100).unwrap();
    for c in &second.catalogs {
        store_package(&m.dir, c).unwrap();
    }
    running(&mut m, id, second_operation);
    m.signed(
        id,
        second_operation,
        sign(second.root, 1),
        pages(&second),
        vec![hex(&second.root)],
    )
    .unwrap();
    assert_eq!(get(&mut m)["published_dates"], dates);
    assert_eq!(get(&mut m)["draft_differs"], true);
    m.finished(
        id.clone(),
        second_operation,
        Err(PublicationFailure {
            message: "temporary DHT failure".into(),
            transient: true,
        }),
    );
    assert_eq!(
        m.lib.posts[id].pending.as_ref().unwrap().prepared_at,
        second_clock
    );
    let loaded = load(&m.dir).unwrap();
    assert_eq!(
        reader_dates(&m.dir, &loaded.posts[id])["published_dates"],
        dates
    );
    m.command(Command::CancelPublication {
        id: id.clone(),
        operation: second_operation,
    })
    .unwrap();
    assert_eq!(get(&mut m)["published_dates"], dates);
    // Returning to identical content removes the annotation, even at a newer draft revision.
    m.command(Command::SaveDraft {
        id: id.clone(),
        revision: 2,
        draft: original,
    })
    .unwrap();
    assert_eq!(get(&mut m)["draft_differs"], false);
    let before = fs::read(package_path(&m.dir, &hex(&first.root)).unwrap()).unwrap();
    for full in [false, true] {
        let archive = backup::export(&m.dir, &m.lib, full).unwrap();
        let restored_dir = dir.join(if full { "full" } else { "minimal" });
        fs::create_dir_all(restored_dir.join("catalogs")).unwrap();
        let restored = backup::import(
            &restored_dir,
            &Library::default(),
            &fs::read(archive).unwrap(),
            &Password(PASSWORD.into()),
        )
        .unwrap();
        if full {
            assert_eq!(
                reader_dates(&restored_dir, &restored.posts[id])["published_dates"],
                dates
            );
            assert_eq!(
                fs::read(package_path(&restored_dir, &hex(&first.root)).unwrap()).unwrap(),
                before
            );
        } else {
            assert!(restored.posts[id].published.is_none());
            assert!(confirmed(&restored.posts[id]).is_none());
        }
    }
    // Acknowledging the signed version advances only the published dates.
    m.command(Command::SaveDraft {
        id: id.clone(),
        revision: 3,
        draft,
    })
    .unwrap();
    let op = enqueue(&mut m, id);
    running(&mut m, id, op);
    m.signed(id, op, sign(second.root, 1), pages(&second), vec![])
        .unwrap();
    m.finished(id.clone(), op, Ok(2));
    let now = get(&mut m);
    assert_eq!(now["published_dates"]["1"]["created_at"], prepared);
    assert_eq!(now["published_dates"]["1"]["updated_at"], prepared + 100);
    assert_eq!(now["draft_differs"], false);
    fs::remove_dir_all(dir).unwrap();
}

#[path = "version_tests.rs"]
mod version_tests;
