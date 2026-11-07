import {evidencePath} from './runtime.mjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const runtime = join(repo, ".runtime");
await mkdir(runtime, { recursive: true });
const root = await mkdtemp(join(runtime, "bep-consumer-"));
const report = { time: new Date().toISOString(), status: "running", checks: [] };
try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "Cargo.toml"), `[package]
name = "feedtorrent-bep-consumer"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
feedtorrent-bep = { path = ${JSON.stringify(join(repo, "bep"))} }
`);
  await writeFile(join(root, "src/main.rs"), `use feedtorrent_bep::{normalize_magnet_input, BackendSnapshot, TorrentBackend};
use feedtorrent_bep::bep44::{Bep44Signer,BencodedValue,MutableRecord};
use feedtorrent_bep::bep46::{TorrentPointer,parse_magnet,format_magnet,resolve,Resolution};
use feedtorrent_bep::bep49::{FeedBuilder,BuildEntry,Feed,inspect_item,ItemContent};
fn main() {
  let host_backend: Option<&dyn TorrentBackend> = None;
  assert!(host_backend.is_none());
  let signer=Bep44Signer::from_seed(&[7;32]);
  let record=signer.sign(BencodedValue::bytestring(b"external consumer").unwrap(),1,vec![]).unwrap();
  MutableRecord::verify(record.key().clone(),record.sequence(),record.value().clone(),record.signature()).unwrap();
  let pointer=TorrentPointer::sign(&signer,[42;20],1,vec![0,255]).unwrap();
  let key=parse_magnet(&format_magnet(pointer.key())).unwrap();
  let Resolution::Found { pointer:current,.. }=resolve(&key,None,Ok(feedtorrent_bep::bep44::DhtOutcome::Mutable(Some(pointer.record().clone())))).unwrap() else {panic!()};
  assert_eq!(current.infohash(),[42;20]);
  assert_eq!(current.publication().target(),key.target());
  let mut pubsub=feedtorrent_bep::bep50::PubSub::new([1;20],[2;32],Default::default()).unwrap();
  pubsub.subscribe(key.clone(),Some(current.record().clone()),0).unwrap();
  pubsub.publish(current.record().clone(),1).unwrap();
  assert_eq!(pubsub.latest(key.target()).unwrap(),current.record());
  pubsub.unsubscribe(key.target());
  let mut builder=FeedBuilder::new("external");
  builder.entries.push(BuildEntry::file(vec!["note.txt".into()],5));
  let built=builder.build(|_|Ok(std::io::Cursor::new(b"hello"))).unwrap();
  let feed=Feed::from_metainfo(&built.metainfo).unwrap();
  feed.verify_infohash(built.feed.infohash()).unwrap();
  assert_eq!(feed.items().count(),1);
  assert!(matches!(inspect_item(&built.metainfo),ItemContent::Torrent(t)if t.is_feed()));
  let metadata_backend:Option<&dyn feedtorrent_bep::TorrentMetadataBackend>=None;
  assert!(metadata_backend.is_none());
  assert!(BackendSnapshot::default().transfers.is_empty());
  assert_eq!(normalize_magnet_input(" 56F31E2D486209003454E245D11561CD252BE30F ").unwrap(), "magnet:?xt=urn:btih:56f31e2d486209003454e245d11561cd252be30f");
}
`);
  const options = { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") } };
  execFileSync("cargo", ["run", "--offline", "--quiet"], options);
  report.checks.push("standalone external Rust consumer signs/verifies BEP44, resolves BEP46 and creates/parses BEP49 and hosts BEP50 through portable contracts");
  const graph = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--format-version", "1"], options));
  const packages=graph.packages.map((p)=>p.name);
  for(const forbidden of ["feedtorrent","feedtorrent-libtorrent","cxx","cxx-build","axum","tokio","feedtorrent-pubsub-udp","getrandom","socket2"]) assert(!packages.includes(forbidden),forbidden);
  for(const required of ["feedtorrent-bep","bendy","sha1","ed25519-dalek","hmac","zeroize"]) assert(packages.includes(required),required);
  const dalek=graph.resolve.nodes.find(n=>n.id.includes("ed25519-dalek@"));
  assert(dalek.features.includes("zeroize"));
  for(const forbidden of ["rand_core","hazmat","legacy_compatibility"]) assert(!dalek.features.includes(forbidden),forbidden);
  report.checks.push("BEP library permits Rust crypto dependencies without native or application dependencies");
  execFileSync("cargo", ["check", "--locked", "--offline", "-p", "feedtorrent-bep", "--target", "wasm32-unknown-unknown"], { ...options, cwd: repo });
  report.checks.push("BEP library builds for wasm32-unknown-unknown independently of CXX and browser assets");
  report.status = "pass";
  for (const check of report.checks) console.log("PASS", check);
} catch (error) {
  report.status = "fail"; report.error = error.stack;
  console.error(error); process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(evidencePath(), { recursive: true });
  await writeFile(evidencePath("bep-consumer.json"), JSON.stringify(report, null, 2) + "\n");
}
