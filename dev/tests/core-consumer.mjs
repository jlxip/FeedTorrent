import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const runtime = join(repo, ".runtime");
await mkdir(runtime, { recursive: true });
const root = await mkdtemp(join(runtime, "core-consumer-"));
const report = { time: new Date().toISOString(), status: "running", checks: [] };
try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "Cargo.toml"), `[package]
name = "feedtorrent-core-consumer"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
feedtorrent-core = { path = ${JSON.stringify(join(repo, "core"))} }
`);
  await writeFile(join(root, "src/main.rs"), `use feedtorrent_core::{normalize_magnet_input, BackendSnapshot, TorrentBackend};
fn main() {
  let host_backend: Option<&dyn TorrentBackend> = None;
  assert!(host_backend.is_none());
  assert!(BackendSnapshot::default().transfers.is_empty());
  assert_eq!(normalize_magnet_input(" 56F31E2D486209003454E245D11561CD252BE30F ").unwrap(), "magnet:?xt=urn:btih:56f31e2d486209003454e245d11561cd252be30f");
}
`);
  const options = { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") } };
  execFileSync("cargo", ["run", "--offline", "--quiet"], options);
  report.checks.push("standalone external Rust consumer executes core validation and imports backend contract");
  const graph = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--format-version", "1"], options));
  assert.deepEqual(graph.packages.map((p) => p.name).sort(), ["feedtorrent-core", "feedtorrent-core-consumer"]);
  report.checks.push("core has no native, web or third-party dependencies");
  execFileSync("cargo", ["check", "--locked", "--offline", "-p", "feedtorrent-core", "--target", "wasm32-unknown-unknown"], { ...options, cwd: repo });
  report.checks.push("core builds for wasm32-unknown-unknown independently of CXX and browser assets");
  report.status = "pass";
  for (const check of report.checks) console.log("PASS", check);
} catch (error) {
  report.status = "fail"; report.error = error.stack;
  console.error(error); process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(runtime, "evidence"), { recursive: true });
  await writeFile(join(runtime, "evidence/core-consumer.json"), JSON.stringify(report, null, 2) + "\n");
}
