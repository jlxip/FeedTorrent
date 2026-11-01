use super::{codec::*, *};
use crate::bep44::{Bep44Signer, MutableKey};
use bendy::value::Value;
use sha1::{Digest, Sha1};
use std::{
    borrow::Cow,
    cell::Cell,
    io::{self, Cursor, Read},
    rc::Rc,
};
fn blob(b: &[u8]) -> Value<'static> {
    Value::Bytes(Cow::Owned(b.to_vec()))
}
fn key(n: u8) -> MutableKey {
    MutableKey::new(Bep44Signer::from_seed(&[n; 32]).public_key(), vec![]).unwrap()
}
fn simple() -> BuiltFeed {
    let mut b = FeedBuilder::new("feed");
    b.entries
        .push(BuildEntry::file(vec!["a.torrent".into()], 5));
    b.build(|_| Ok(Cursor::new(b"hello"))).unwrap()
}
fn edit_info(feed: &Feed, f: impl FnOnce(&mut Dict)) -> Vec<u8> {
    let Value::Dict(mut d) = decode(feed.raw_info()).unwrap() else {
        panic!()
    };
    f(&mut d);
    encode(&Value::Dict(d)).unwrap()
}
#[test]
fn head_archive_and_revision_fields_follow_standard() {
    let mut b = FeedBuilder::new("catalog");
    b.entries.push(BuildEntry::file(vec!["item".into()], 1));
    b.fields = FeedFields {
        source: Some(key(7)),
        archive_next: Some(TorrentLink::new([1; 20])),
        archive: false,
        previous: Some(TorrentLink::new([2; 20])),
    };
    let made = b.build(|_| Ok(Cursor::new([42]))).unwrap();
    let read = Feed::from_info(made.feed.raw_info()).unwrap();
    assert_eq!(read.fields(), &b.fields);
    assert_eq!(read.fields().effective_source(Some(&key(8))), Some(&key(8)));
    assert_eq!(read.fields().effective_source(None), Some(&key(7)));
    assert_eq!(made.feed.raw_metainfo(), Some(made.metainfo.as_slice()));
    assert_eq!(read.infohash(), Sha1::digest(read.raw_info()).as_slice());
    assert!(read.verify_infohash(made.feed.infohash()).is_ok());
    assert_eq!(read.verify_infohash([0; 20]), Err(Error::IdentityMismatch));
    b.fields = FeedFields {
        archive: true,
        archive_next: Some(TorrentLink::new([3; 20])),
        ..Default::default()
    };
    let archive = b.build(|_| Ok(Cursor::new([42]))).unwrap();
    assert!(archive.feed.fields().archive);
    assert_eq!(archive.feed.fields(), &b.fields);
    for fields in [
        FeedFields {
            archive: true,
            source: Some(key(7)),
            ..Default::default()
        },
        FeedFields {
            archive: true,
            previous: Some(TorrentLink::new([2; 20])),
            ..Default::default()
        },
    ] {
        b.fields = fields;
        assert!(b.build(|_| Ok(Cursor::new([42]))).is_err());
    }
    let invalid = edit_info(&archive.feed, |info| {
        let Value::Dict(fields) = info.get_mut(b"bep49".as_slice()).unwrap() else {
            panic!()
        };
        fields.insert(
            Cow::Borrowed(b"prev"),
            blob(TorrentLink::new([4; 20]).uri().as_bytes()),
        );
    });
    assert!(Feed::from_info(&invalid).is_err());
}
#[test]
fn insertion_order_padding_and_hints_are_distinct_from_piece_integrity() {
    let mut b = FeedBuilder::new("catalog");
    b.entries = vec![
        BuildEntry::file(vec!["z".into()], 3),
        BuildEntry::file(vec!["a".into()], 2),
        BuildEntry::file(vec!["meta".into(), "notes".into()], 0),
    ];
    let buffers = [b"abc".as_slice(), b"de".as_slice(), b"".as_slice()];
    let made = b.build(|i| Ok(Cursor::new(buffers[i]))).unwrap();
    let f = &made.feed;
    assert_eq!(
        f.items().map(|e| e.path()[0].as_str()).collect::<Vec<_>>(),
        vec!["z", "a"]
    );
    assert_eq!(f.entries()[2].kind(), EntryKind::Metadata);
    let pad = f.entries().last().unwrap();
    assert_eq!(pad.kind(), EntryKind::Padding);
    assert_eq!(pad.length(), 16379);
    assert_eq!(
        f.entries()[0].sha1().unwrap(),
        Sha1::digest(b"abc").as_slice()
    );
    let mut payload = b"abcde".to_vec();
    payload.resize(16384, 0);
    assert_eq!(f.pieces(), Sha1::digest(&payload).as_slice());
    assert_eq!(
        f.entries()[0].check_sha1(Cursor::new(b"abc")).unwrap(),
        Some(true)
    );
    assert_eq!(
        f.entries()[0].check_sha1(Cursor::new(b"xyz")).unwrap(),
        Some(false)
    );
    assert!(f.entries()[0].check_sha1(Cursor::new(b"abcd")).is_err());
    let mut next = FeedBuilder::new("catalog");
    next.entries = f.entries().iter().map(BuildEntry::from_entry).collect();
    next.entries.push(BuildEntry::file(vec!["next".into()], 1));
    let newer = next
        .build(|i| Ok(Cursor::new(if i < 3 { buffers[i] } else { b"!" })))
        .unwrap();
    assert_eq!(&newer.feed.pieces()[..20], f.pieces());
    assert_eq!(newer.feed.entries()[3], f.entries()[3]);
    // Names are hints; duplicate root names remain separate ordered entries.
    b.entries[1].path = vec!["z".into()];
    let dup = b.build(|i| Ok(Cursor::new(buffers[i]))).unwrap();
    assert_eq!(dup.feed.items().count(), 2);
    assert_ne!(dup.feed.entries()[0].sha1(), dup.feed.entries()[1].sha1());
}
#[test]
fn full_child_bytes_and_outer_fields_survive_inspection() {
    let first = simple();
    let mut root = dict(&decode(&first.metainfo).unwrap()).unwrap().clone();
    root.insert(Cow::Borrowed(b"comment"), blob(b"outer extension"));
    let second = encode(&Value::Dict(root)).unwrap();
    let ItemContent::Torrent(a) = inspect_item(&first.metainfo) else {
        panic!()
    };
    let ItemContent::Torrent(b) = inspect_item(&second) else {
        panic!()
    };
    assert_eq!(a.infohash(), b.infohash());
    assert_eq!(a.info(), b.info());
    assert_ne!(Sha1::digest(a.metainfo()), Sha1::digest(b.metainfo()));
    assert_eq!(b.metainfo(), second.as_slice());
    assert!(a.is_feed());
    for data in [
        b"opaque text".as_slice(),
        b"de",
        b"",
        b"d4:infod4:name1:x12:meta versioni2eee",
    ] {
        assert!(matches!(inspect_item(data),ItemContent::Opaque(bytes)if bytes==data));
    }
    let raw = edit_info(&first.feed, |i| {
        i.remove(b"bep49".as_slice());
        i.insert(Cow::Borrowed(b"private"), Value::Integer(1));
        if let Some(Value::List(files)) = i.get_mut(b"files".as_slice()) {
            for f in files {
                if let Value::Dict(d) = f {
                    d.remove(b"sha1".as_slice());
                }
            }
        }
    });
    let mut root = Dict::new();
    root.insert(Cow::Borrowed(b"info"), decode(&raw).unwrap());
    let meta = encode(&Value::Dict(root)).unwrap();
    assert!(matches!(inspect_item(&meta),ItemContent::Torrent(t)if t.is_private()&&!t.is_feed()));
}
#[test]
fn malformed_bencode_lengths_paths_fields_and_limits_are_rejected() {
    for raw in [
        b"de".as_slice(),
        b"de0:",
        b"d1:bi0e1:ai0ee",
        b"d1:ai0e1:ai1ee",
        b"i-0e",
        b"d4:infodee",
    ] {
        assert!(Feed::from_metainfo(raw).is_err());
    }
    assert_eq!(
        Feed::from_info(&vec![0; MAX_METAINFO + 1]),
        Err(Error::TooLarge)
    );
    let made = simple();
    for change in 0..10 {
        let raw = edit_info(&made.feed, |i| match change {
            0 => {
                i.remove(b"bep49".as_slice());
            }
            1 => {
                i.insert(Cow::Borrowed(b"bep49"), Value::List(vec![]));
            }
            2 => {
                i.insert(Cow::Borrowed(b"piece length"), Value::Integer(0));
            }
            3 => {
                i.insert(Cow::Borrowed(b"pieces"), blob(b"wrong"));
            }
            4 => {
                i.insert(Cow::Borrowed(b"length"), Value::Integer(1));
            }
            5 => {
                i.insert(Cow::Borrowed(b"name"), blob(b"../bad"));
            }
            _ => {
                let Some(Value::List(files)) = i.get_mut(b"files".as_slice()) else {
                    panic!()
                };
                let Value::Dict(f) = &mut files[0] else {
                    panic!()
                };
                match change {
                    6 => {
                        f.remove(b"sha1".as_slice());
                    }
                    7 => {
                        f.insert(Cow::Borrowed(b"sha1"), blob(&[0; 19]));
                    }
                    8 => {
                        f.insert(Cow::Borrowed(b"length"), Value::Integer(-1));
                    }
                    _ => {
                        f.insert(
                            Cow::Borrowed(b"path"),
                            Value::List(vec![blob(b".."), blob(b"x")]),
                        );
                    }
                }
            }
        });
        assert!(Feed::from_info(&raw).is_err(), "{change}");
    }
    for path in ["", ".", "..", "/root", "a/b", "a\\b", "C:", "nul\0x"] {
        let mut b = FeedBuilder::new("safe");
        b.entries.push(BuildEntry::file(vec![path.into()], 0));
        assert!(b.build(|_| Ok(Cursor::new([]))).is_err());
    }
    let mut b = FeedBuilder::new("safe");
    b.piece_length = 0;
    assert!(b.build(|_| Ok(Cursor::new([]))).is_err());
    b.piece_length = 16385;
    assert!(b.build(|_| Ok(Cursor::new([]))).is_err());
    b.piece_length = 16384;
    b.entries = vec![BuildEntry::file(vec!["x".into()], u64::MAX)];
    assert!(b.build(|_| Ok(Cursor::new([]))).is_err());
    b.entries = vec![BuildEntry::file(vec!["x".into()], 1)];
    assert!(matches!(
        b.build(|_| Ok(Cursor::new([]))),
        Err(Error::LengthMismatch { index: 0 })
    ));
    assert!(matches!(
        b.build(|_| Ok(Cursor::new([0, 1]))),
        Err(Error::LengthMismatch { index: 0 })
    ));
    assert!(matches!(
        b.build(|_| Err::<Cursor<Vec<u8>>, _>(io::Error::other("source failed"))),
        Err(Error::Io(_))
    ));
}
#[test]
fn references_padding_without_paths_and_extension_fields() {
    let hash = [0xab; 20];
    assert_eq!(
        TorrentLink::parse(TorrentLink::new(hash).uri())
            .unwrap()
            .infohash(),
        hash
    );
    assert_eq!(
        TorrentLink::parse("magnet:?xt=urn:btih:K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP")
            .unwrap()
            .infohash(),
        [
            0x56, 0xf3, 0x1e, 0x2d, 0x48, 0x62, 0x09, 0, 0x34, 0x54, 0xe2, 0x45, 0xd1, 0x15, 0x61,
            0xcd, 0x25, 0x2b, 0xe3, 0x0f
        ]
    );
    for uri in ["magnet:?xs=urn:btpk:abc","magnet:?xt=urn:btih:bad","magnet:?xt=urn:btih:K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP&xt=urn:btih:K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP","magnet:?tr=%ZZ"]{assert!(TorrentLink::parse(uri).is_err());}
    let made = simple();
    let raw = edit_info(&made.feed, |i| {
        let Value::List(files) = i.get_mut(b"files".as_slice()).unwrap() else {
            panic!()
        };
        let Value::Dict(pad) = files.last_mut().unwrap() else {
            panic!()
        };
        pad.remove(b"path".as_slice());
        let Value::Dict(opts) = i.get_mut(b"bep49".as_slice()).unwrap() else {
            panic!()
        };
        opts.insert(
            Cow::Borrowed(b"unknown"),
            Value::List(vec![Value::Integer(42)]),
        );
    });
    let f = Feed::from_info(&raw).unwrap();
    assert_eq!(f.raw_info(), raw);
    assert!(f.entries().last().unwrap().path().is_empty());
    let depth = edit_info(&made.feed, |i| {
        let mut value = Value::Integer(1);
        for _ in 0..63 {
            value = Value::List(vec![value]);
        }
        i.insert(Cow::Borrowed(b"ext"), value);
    });
    assert!(Feed::from_info(&depth).is_ok());
    let mut too_deep = b"l".repeat(65);
    too_deep.extend(b"e".repeat(65));
    assert!(Feed::from_info(&too_deep).is_err());
}
#[test]
fn streaming_creation_is_bounded_and_zero_length_items_are_real() {
    struct Zeros {
        remaining: u64,
        max: Rc<Cell<usize>>,
    }
    impl Read for Zeros {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.max.set(self.max.get().max(b.len()));
            assert!(b.len() <= 32768);
            let n = self.remaining.min(b.len() as u64) as usize;
            b[..n].fill(0);
            self.remaining -= n as u64;
            Ok(n)
        }
    }
    let maximum = Rc::new(Cell::new(0));
    let mut b = FeedBuilder::new("large");
    b.entries
        .push(BuildEntry::file(vec!["opaque".into()], 5 * 1024 * 1024 + 3));
    let made = b
        .build(|_| {
            Ok(Zeros {
                remaining: 5 * 1024 * 1024 + 3,
                max: maximum.clone(),
            })
        })
        .unwrap();
    assert!(maximum.get() <= 32768);
    assert!(made.metainfo.len() < 20000);
    assert_eq!(made.feed.total_length() % 16384, 0);
    b.entries = vec![BuildEntry::file(vec!["empty".into()], 0)];
    let empty = b.build(|_| Ok(Cursor::new([]))).unwrap();
    assert_eq!(empty.feed.items().count(), 1);
    assert_eq!(empty.feed.entries().len(), 1);
    assert!(empty.feed.pieces().is_empty());
    assert_eq!(
        empty.feed.entries()[0].sha1().unwrap(),
        Sha1::digest([]).as_slice()
    );
    b.entries.clear();
    let empty_catalog = b.build(|_| Ok(Cursor::new([]))).unwrap();
    assert_eq!(empty_catalog.feed.entries().len(), 0);
    assert!(empty_catalog.feed.pieces().is_empty());
}

#[test]
fn references_keep_discovery_parameters_and_readers_may_be_interrupted() {
    let mut b = FeedBuilder::new("catalog");
    b.entries.push(BuildEntry::file(vec!["note".into()], 1));
    let uri = format!(
        "{}&tr=https%3A%2F%2Fexample.org%2Fannounce",
        TorrentLink::new([1; 20]).uri()
    );
    b.fields.archive_next = Some(TorrentLink::parse(&uri).unwrap());
    struct Interrupted {
        data: Cursor<Vec<u8>>,
        interrupted: bool,
    }
    impl Read for Interrupted {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.data.position() == 1 && !self.interrupted {
                self.interrupted = true;
                return Err(io::ErrorKind::Interrupted.into());
            }
            self.data.read(buf)
        }
    }
    let made = b
        .build(|_| {
            Ok(Interrupted {
                data: Cursor::new(vec![42]),
                interrupted: false,
            })
        })
        .unwrap();
    assert_eq!(made.feed.fields().archive_next.as_ref().unwrap().uri(), uri);
    assert_eq!(
        made.feed.entries()[0]
            .check_sha1(Interrupted {
                data: Cursor::new(vec![42]),
                interrupted: false
            })
            .unwrap(),
        Some(true)
    );
    assert!(matches!(
        made.feed.entries()[0].check_sha1(Cursor::new([])),
        Err(Error::LengthMismatch { index: 0 })
    ));
}
