//! Test-only JSON-lines host. Not part of the FeedTorrent executable.
use feedtorrent_bep::bep46::{self, PointerChange, Resolution, TorrentPointer};
use feedtorrent_bep::{
    bep44::*,
    bep49::{self, BuildEntry, Feed, FeedBuilder, FeedFields, ItemContent, TorrentLink},
    AddTransfer, TorrentBackend, TorrentMetadataBackend, TorrentSource,
};
use feedtorrent_libtorrent::LibtorrentBackend;
use feedtorrent_pubsub_udp::{Bind, UdpPubSub};
mod bep50_support;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    sync::mpsc,
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn unhex(s: &str) -> Result<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return Err("Odd hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}
fn bytes(q: &Value, name: &str) -> Result<Vec<u8>> {
    unhex(q[name].as_str().unwrap_or(""))
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn sequence(q: &Value) -> Result<i64> {
    Ok(q["sequence"].as_str().unwrap_or("0").parse()?)
}
fn record_json(r: &MutableRecord) -> Value {
    json!({"key":hex(&r.key().public_key()),"salt":hex(r.key().salt()),"signature":hex(&r.signature()),"value":hex(r.value().as_bytes()),"sequence":r.sequence().to_string()})
}
fn record(q: &Value) -> Result<MutableRecord> {
    Ok(MutableRecord::verify(
        MutableKey::new(
            bytes(q, "key")?
                .try_into()
                .map_err(|_| "Invalid key size")?,
            bytes(q, "salt")?,
        )?,
        sequence(q)?,
        BencodedValue::parse(&bytes(q, "value")?)?,
        bytes(q, "signature")?
            .try_into()
            .map_err(|_| "Invalid signature size")?,
    )?)
}
fn pointer_json(p: &TorrentPointer) -> Value {
    let mut out = record_json(p.record());
    out["infohash"] = json!(hex(&p.infohash()));
    out["magnet"] = json!(bep46::format_magnet(p.key()));
    out
}
fn feed_key(q: &Value) -> Result<MutableKey> {
    Ok(bep46::parse_magnet(
        q["magnet"].as_str().ok_or("Missing feed magnet")?,
    )?)
}
fn catalog_json(feed: &Feed) -> Value {
    json!({"infohash":hex(&feed.infohash()),"info":hex(feed.raw_info()),"name":feed.name(),"piece_length":feed.piece_length(),"total":feed.total_length(),"pieces":hex(feed.pieces()),"archive":feed.fields().archive,"source":feed.fields().source.as_ref().map(bep46::format_magnet),"archive_next":feed.fields().archive_next.as_ref().map(|l|l.uri()),"previous":feed.fields().previous.as_ref().map(|l|l.uri()),"entries":feed.entries().iter().map(|e|json!({"index":e.index(),"path":e.path(),"length":e.length(),"attr":hex(e.attributes()),"sha1":e.sha1().map(|h|hex(&h)),"kind":format!("{:?}",e.kind())})).collect::<Vec<_>>()})
}
fn bendy_value_bytes(bytes: &[u8]) -> feedtorrent_bep::bep49::OuterValue<'static> {
    feedtorrent_bep::bep49::OuterValue::Bytes(std::borrow::Cow::Owned(bytes.to_vec()))
}
fn optional_link(q: &Value, field: &str) -> Result<Option<TorrentLink>> {
    q[field]
        .as_str()
        .map(TorrentLink::parse)
        .transpose()
        .map_err(Into::into)
}
fn run(b: &mut LibtorrentBackend, q: &Value) -> Result<Value> {
    match q["op"].as_str().unwrap_or("") {
        "metadata" => Ok(
            json!({"info":b.info_bytes(q["transfer"].as_str().ok_or("Missing transfer")?)?.map(|data|hex(&data))}),
        ),
        "remove" => {
            b.remove(q["transfer"].as_str().ok_or("Missing transfer")?)?;
            Ok(json!(true))
        }
        "build_catalog" => {
            let mut builder = FeedBuilder::new(q["name"].as_str().ok_or("Missing name")?);
            builder.fields = FeedFields {
                source: q["source"].as_str().map(bep46::parse_magnet).transpose()?,
                archive_next: optional_link(q, "archive_next")?,
                previous: optional_link(q, "previous")?,
                archive: q["archive"].as_bool().unwrap_or(false),
            };
            if let Some(size) = q["piece_length"].as_u64() {
                builder.piece_length = u32::try_from(size)?;
            }
            if let Some(uri) = q["announce"].as_str() {
                builder.outer.insert(
                    std::borrow::Cow::Borrowed(b"announce"),
                    bendy_value_bytes(uri.as_bytes()),
                );
            }
            let entries = q["entries"].as_array().ok_or("Missing entries")?;
            let data = entries
                .iter()
                .map(|e| bytes(e, "data"))
                .collect::<Result<Vec<_>>>()?;
            for (i, e) in entries.iter().enumerate() {
                let path = e["path"]
                    .as_array()
                    .ok_or("Missing path")?
                    .iter()
                    .map(|s| s.as_str().map(str::to_owned).ok_or("Invalid path"))
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let mut entry =
                    BuildEntry::file(path, e["length"].as_u64().unwrap_or(data[i].len() as u64));
                entry.attributes = bytes(e, "attr")?;
                builder.entries.push(entry);
            }
            let built = builder.build(|i| Ok(std::io::Cursor::new(data[i].as_slice())))?;
            let mut out = catalog_json(&built.feed);
            out["metainfo"] = json!(hex(&built.metainfo));
            Ok(out)
        }
        "inspect_catalog" => {
            let info = bytes(q, "info")?;
            let meta = bytes(q, "metainfo")?;
            let feed = if q["info"].is_string() {
                Feed::from_info(&info)?
            } else {
                Feed::from_metainfo(&meta)?
            };
            if q["expected"].is_string() {
                feed.verify_infohash(
                    bytes(q, "expected")?
                        .try_into()
                        .map_err(|_| "Invalid hash")?,
                )?;
            }
            let mut out = catalog_json(&feed);
            if let Some(uri) = q["resolved_source"].as_str() {
                let key = bep46::parse_magnet(uri)?;
                out["effective_source"] = json!(feed
                    .fields()
                    .effective_source(Some(&key))
                    .map(bep46::format_magnet));
            }
            Ok(out)
        }
        "inspect_item" => {
            let data = bytes(q, "data")?;
            match bep49::inspect_item(&data) {
                ItemContent::Opaque(raw) => Ok(json!({"kind":"opaque","bytes":hex(raw)})),
                ItemContent::Torrent(t) => Ok(
                    json!({"kind":"torrent","bytes":hex(t.metainfo()),"info":hex(t.info()),"infohash":hex(&t.infohash()),"private":t.is_private(),"feed":t.is_feed()}),
                ),
            }
        }
        "info" => {
            let s = b.snapshot()?;
            Ok(
                json!({"port":s.listen_port,"nodes":s.dht_nodes,"transfers":s.transfers.iter().map(|t|json!({"id":t.id,"state":t.state,"verified":t.verified,"total":t.total})).collect::<Vec<_>>()}),
            )
        }
        "sign" => {
            let seed = bytes(q, "seed")?
                .try_into()
                .map_err(|_| "Invalid seed size")?;
            let signer = Bep44Signer::from_seed(&seed);
            Ok(record_json(&signer.sign(
                BencodedValue::parse(&bytes(q, "value")?)?,
                sequence(q)?,
                bytes(q, "salt")?,
            )?))
        }
        "verify" => Ok(record_json(&record(q)?)),
        "parse_feed" => {
            let key = feed_key(q)?;
            Ok(
                json!({"magnet":bep46::format_magnet(&key),"key":hex(&key.public_key()),"salt":hex(key.salt()),"target":hex(&key.target())}),
            )
        }
        "sign_pointer" => {
            let seed = bytes(q, "seed")?
                .try_into()
                .map_err(|_| "Invalid seed size")?;
            let ih = bytes(q, "infohash")?
                .try_into()
                .map_err(|_| "Invalid infohash size")?;
            Ok(pointer_json(&TorrentPointer::sign(
                &Bep44Signer::from_seed(&seed),
                ih,
                sequence(q)?,
                bytes(q, "salt")?,
            )?))
        }
        "resolve_pointer" => {
            let key = feed_key(q)?;
            let previous = if q["previous"].is_object() {
                Some(TorrentPointer::from_record(&key, record(&q["previous"])?)?)
            } else {
                None
            };
            let item = if q["item"].is_null() {
                None
            } else {
                Some(record(&q["item"])?)
            };
            match bep46::resolve(&key, previous.as_ref(), Ok(DhtOutcome::Mutable(item)))? {
                Resolution::NotFound => Ok(json!({"pointer":null,"change":"not_found"})),
                Resolution::Found { pointer, change } => {
                    let (kind, changed) = match change {
                        PointerChange::Initial => ("initial", true),
                        PointerChange::Unchanged => ("unchanged", false),
                        PointerChange::Advanced { infohash_changed } => {
                            ("advanced", infohash_changed)
                        }
                    };
                    Ok(
                        json!({"pointer":pointer_json(&pointer),"change":kind,"infohash_changed":changed}),
                    )
                }
            }
        }
        "pointer_receipt" => {
            let pointer = TorrentPointer::from_record(&feed_key(q)?, record(q)?)?;
            let target = bytes(q, "target")?
                .try_into()
                .map_err(|_| "Invalid target size")?;
            let count = u32::try_from(q["acknowledged_nodes"].as_u64().ok_or("Missing count")?)?;
            Ok(json!(bep46::publication_result(
                &pointer,
                Ok(DhtOutcome::Stored {
                    target,
                    acknowledged_nodes: count
                })
            )?))
        }
        "start" => {
            let request = match q["kind"].as_str().ok_or("Missing kind")? {
                "get_pointer" => bep46::lookup(&feed_key(q)?),
                "put_pointer" => {
                    TorrentPointer::from_record(&feed_key(q)?, record(q)?)?.publication()
                }
                "get_immutable" => DhtRequest::GetImmutable(
                    bytes(q, "target")?
                        .try_into()
                        .map_err(|_| "Invalid target size")?,
                ),
                "put_immutable" => DhtRequest::PutImmutable(ImmutableItem::new(
                    BencodedValue::parse(&bytes(q, "value")?)?,
                )),
                "get_mutable" => DhtRequest::GetMutable(MutableKey::new(
                    bytes(q, "key")?
                        .try_into()
                        .map_err(|_| "Invalid key size")?,
                    bytes(q, "salt")?,
                )?),
                "put_mutable" => DhtRequest::PutMutable(record(q)?),
                _ => return Err("Unknown kind".into()),
            };
            let id = b.start_dht(
                request,
                DhtOptions {
                    timeout: Duration::from_millis(q["timeout_ms"].as_u64().unwrap_or(30000)),
                },
            )?;
            Ok(json!({"request":id.0}))
        }
        "checkpoint" => {
            b.checkpoint()?;
            Ok(json!(true))
        }
        "shutdown" => {
            b.shutdown()?;
            Ok(json!(true))
        }
        "add" | "add_magnet" => {
            let data = bytes(q, "torrent")?;
            let source = if q["op"] == "add_magnet" {
                TorrentSource::Magnet(q["uri"].as_str().ok_or("Missing magnet")?)
            } else {
                TorrentSource::Torrent(&data)
            };
            let id = b.inspect(source)?;
            b.add(AddTransfer {
                id: &id,
                source,
                save_path: q["path"].as_str().ok_or("Missing path")?,
                active: true,
                restore: false,
            })?;
            Ok(json!({"id":id}))
        }
        _ => Err("Unknown op".into()),
    }
}
fn event_json(event: DhtEvent) -> Value {
    let mut out = json!({"event":event.id.0});
    match event.result {
        Err(error) => out["error"] = json!(error.to_string()),
        Ok(DhtOutcome::Immutable(item)) => {
            out["result"] = json!({"kind":"immutable","item":item.map(|i|json!({"target":hex(&i.target()),"value":hex(i.value().as_bytes())}))})
        }
        Ok(DhtOutcome::Mutable(item)) => {
            out["result"] = json!({"kind":"mutable","item":item.as_ref().map(record_json)})
        }
        Ok(DhtOutcome::Stored {
            target,
            acknowledged_nodes,
        }) => {
            out["result"] = json!({"kind":"stored","target":hex(&target),"acknowledged_nodes":acknowledged_nodes})
        }
    }
    out
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let state = args.get(1).ok_or("Missing state directory")?;
    let port = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let bootstrap = args.get(2).map(String::as_str).unwrap_or("");
    let mut backend = if args.get(4).is_some_and(|s| s == "ipv6") {
        LibtorrentBackend::new_isolated_ipv6(state, port, bootstrap)?
    } else {
        LibtorrentBackend::new(state, port, bootstrap, true)?
    };
    let mut pubsub = UdpPubSub::bind(
        Bind {
            ipv4: Some(std::net::Ipv4Addr::LOCALHOST),
            ipv6: Some(std::net::Ipv6Addr::LOCALHOST),
            port: 0,
            advertised_port: None,
        },
        feedtorrent_bep::bep50::Config::default(),
    )?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    loop {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => {
                let q: Value = serde_json::from_str(&line)?;
                if q["op"] == "exit" {
                    backend.shutdown()?;
                    break;
                }
                let is_pubsub = matches!(
                    q["op"].as_str(),
                    Some(
                        "pubsub_info"
                            | "subscribe"
                            | "unsubscribe"
                            | "publish"
                            | "hint"
                            | "latest"
                            | "pubsub_events"
                            | "pubsub_close"
                    )
                );
                let result = if is_pubsub {
                    bep50_support::run(&mut pubsub, &q)
                } else {
                    run(&mut backend, &q)
                };
                let response = match result {
                    Ok(result) => json!({"id":q["id"],"result":result}),
                    Err(error) => json!({"id":q["id"],"error":error.to_string()}),
                };
                println!("{response}");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                backend.shutdown()?;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        pubsub.poll(&mut backend);
        for event in backend.poll_dht() {
            println!("{}", event_json(event));
        }
    }
    Ok(())
}
