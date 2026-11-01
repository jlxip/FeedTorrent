//! Test-only JSON-lines host. Not part of the FeedTorrent executable.
use feedtorrent_core::{bep44::*, AddTransfer, TorrentBackend, TorrentSource};
use feedtorrent_libtorrent::LibtorrentBackend;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    sync::mpsc,
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn unhex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
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
fn run(b: &mut LibtorrentBackend, q: &Value) -> Result<Value> {
    match q["op"].as_str().unwrap_or("") {
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
        "start" => {
            let request = match q["kind"].as_str().ok_or("Missing kind")? {
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
        "add" => {
            let data = bytes(q, "torrent")?;
            let source = TorrentSource::Torrent(&data);
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
    let mut backend = LibtorrentBackend::new(
        args.get(1).ok_or("Missing state directory")?,
        0,
        args.get(2).map(String::as_str).unwrap_or(""),
        true,
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
                let response = match run(&mut backend, &q) {
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
        for event in backend.poll_dht() {
            println!("{}", event_json(event));
        }
    }
    Ok(())
}
