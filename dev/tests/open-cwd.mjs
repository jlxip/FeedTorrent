import {evidencePath} from './runtime.mjs';
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, appendFile, cp, rm, stat, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { temporary, startApp, cleanup, wait } from "./helpers.mjs";
const repo = resolve("."),
  report = { time: new Date().toISOString(), checks: [], status: "running" };
const id = "56f31e2d486209003454e245d11561cd252be30f";
const base32 = "K3ZR4LKIMIEQANCU4JC5CFLBZUSSXYYP";
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
async function largeRegistry(root) {
  const home = join(root, "large-registry"), registry = join(home, "state/transfers.json");
  let local;
  try {
    local = await startApp(home);
    await local.command({ type: "add_magnet", uri: id });
    await local.command({ type: "pause", id });
    await local.stop();
    const original = await readFile(registry);
    const expected = JSON.parse(original);
    const source = join(home, "downloads", id + ".source");
    const originalSource = await readFile(source);
    // Valid JSON whitespace crosses the byte limit without creating thousands
    // of native torrents just to exercise registry loading.
    await appendFile(registry, " ".repeat(32 * 1024 * 1024));
    assert((await stat(registry)).size > 32 * 1024 * 1024);
    local = await startApp(home);
    const transfer = (await local.api()).transfers.find(t => t.id === id);
    assert.equal(transfer.active, false);
    assert.equal(transfer.pinned, true);
    assert.equal(transfer.error, "");
    await local.command({ type: "configure", settings: {
      ...(await local.api()).settings, seed_by_default: false,
    } });
    await local.stop();
    const saved = await readJson(registry);
    assert.deepEqual(saved.records, expected.records);
    assert.deepEqual(saved.retention, expected.retention);
    assert.equal(saved.settings.seed_by_default, false);
    assert.deepEqual(await readFile(source), originalSource);
    local = await startApp(home);
    assert.equal((await local.api()).transfers[0].active, false);
    assert.equal((await local.api()).transfers[0].pinned, true);
    assert.equal((await local.api()).settings.seed_by_default, false);
    await local.stop();
    pass("registry above 32 MiB starts, saves and restarts without losing transfers, Pin or pause");
    for (const padding of [0, 32 * 1024 * 1024]) {
      const malformed = Buffer.concat([original, Buffer.alloc(padding, 32), Buffer.from("!")]);
      await writeFile(registry, malformed);
      await assert.rejects(() => startApp(home), /Cannot read transfer registry; original data was preserved/);
      assert.deepEqual(await readFile(registry), malformed);
      assert.deepEqual(await readFile(source), originalSource);
    }
    pass("malformed registries below and above 32 MiB fail explicitly and preserve original files");
  } finally {
    if (local) await local.stop();
  }
}
let root, app;
try {
  root = await temporary();
  await largeRegistry(root);
  const portable = join(root, "portable"), portableHome = join(root, "portable-home");
  const oldState = join(portableHome, "Library/Application Support/FeedTorrent/transfers.json");
  await mkdir(portable);
  await mkdir(join(portableHome, "Library/Application Support/FeedTorrent"), {recursive:true});
  await writeFile(oldState, "old-state-must-stay-untouched");
  app = await startApp(root, [], {
    cwd: portable, defaultDownloads: true, defaultData: true,
    env: {...process.env, HOME: portableHome},
  });
  assert.equal((await app.api()).settings.download_dir, "user/downloads");
  await app.stop();
  app = undefined;
  await stat(join(portable, "user/transfers.json"));
  await stat(join(portable, "user/downloads"));
  assert.deepEqual(await readdir(portable), ["user"]);
  assert.equal(await readFile(oldState, "utf8"), "old-state-must-stay-untouched");
  pass("portable defaults write only under ./user and ignore old home state");
  const a = join(root, "working a"),
    b = join(root, "working b");
  await mkdir(a);
  await mkdir(b);
  app = await startApp(root, [], { cwd: a, defaultDownloads: true });
  assert.equal((await app.api()).settings.download_dir, "user/downloads");
  await app.command({ type: "add_magnet", uri: `  ${id.toUpperCase()}\n` });
  await app.command({type:'add_magnet',uri:base32.toLowerCase()});
  assert.equal((await app.api()).transfers.length,1);
  assert.equal((await app.api()).transfers[0].pinned,true);
  assert.equal(
    await readFile(join(a, "user/downloads", id + ".source"), "utf8"),
    `magnet:?xt=urn:btih:${id}`,
  );
  await app.command({ type: "pause", id });
  await app.stop();
  app = await startApp(root, [], { cwd: b, defaultDownloads: true });
  let s = await app.api();
  assert.equal(s.settings.download_dir, "user/downloads");
  assert.equal(s.transfers[0].save_path, join(a, "user/downloads", id));
  assert.equal(s.transfers[0].active, false);
  assert.notEqual(s.transfers[0].state, "Error");
  const second = "1".repeat(40);
  await app.command({ type: "add_magnet", uri: second });
  assert.equal(
    (await app.api()).transfers.find((t) => t.id === second).save_path,
    join(b, "user/downloads", second),
  );
  await app.command({
    type: "configure",
    settings: { download_dir: "custom", peer_port: 0 },
  });
  assert.equal((await app.api()).settings.download_dir, "custom");
  await app.stop();
  app = await startApp(root, ["--download-dir", "override"], { cwd: a });
  assert.equal((await app.api()).settings.download_dir, "override");
  await app.stop();
  app = await startApp(root, [], { cwd: b, defaultDownloads: true });
  assert.equal((await app.api()).settings.download_dir, "override");
  await app.stop();
  app = undefined;
  pass(
    "raw hashes, Base32 duplicates, canonical persistence, two CWDs and relative CLI/settings",
  );
  const legacy = join(root, "legacy");
  await mkdir(join(legacy, "state"), { recursive: true });
  const original = {
    version: 1,
    settings: {
      download_dir: join(homedir(), "Downloads/FeedTorrent"),
      peer_port: 0,
    },
    records: [],
  };
  await writeFile(
    join(legacy, "state/transfers.json"),
    JSON.stringify(original),
  );
  app = await startApp(legacy, [], { cwd: a, defaultDownloads: true });
  assert.equal((await app.api()).settings.download_dir, "user/downloads");
  assert.equal(
    (await readJson(join(legacy, "state/transfers.json"))).version,
    4,
  );
  await app.stop();
  app = undefined;
  const custom = join(root, "absolute-custom");
  let registry = await readJson(join(legacy, "state/transfers.json"));
  registry.version = 1;
  registry.settings.download_dir = custom;
  await writeFile(
    join(legacy, "state/transfers.json"),
    JSON.stringify(registry),
  );
  app = await startApp(legacy, [], { cwd: b, defaultDownloads: true });
  assert.equal((await app.api()).settings.download_dir, custom);
  await app.stop();
  app = undefined;
  pass("one-time v1 migration and preservation of absolute custom folders");
  const sandbox = join(root, "clean");
  await mkdir(sandbox);
  await cp(join(repo,".gitignore"),join(sandbox,".gitignore"));
  execFileSync("git",["init","--quiet"],{cwd:sandbox});
  execFileSync("git",["-c","core.excludesFile=/dev/null","check-ignore","--quiet","--no-index","user/probe"],{cwd:sandbox});
  await cp(join(repo, "Makefile"), join(sandbox, "Makefile"));
  await mkdir(join(sandbox, "app"));
  await mkdir(join(sandbox, "web"));
  for (const file of ["Cargo.toml", "app/Cargo.toml", "web/tsconfig.json"]) await writeFile(join(sandbox,file), "{}\n");
  await writeFile(join(sandbox,"app/Cargo.toml"), '[package]\nname = "feedtorrent"\n');
  for (const p of [
    "downloads",
    "user",
    "web/dist",
    "dist/pkg",
    ".tools/native",
    "dev/node_modules",
    "target",
    ".runtime/state",
  ]) {
    await mkdir(join(sandbox, p), { recursive: true });
    await writeFile(join(sandbox, p, "keep"), "fixture");
  }
  execFileSync("make", ["clean"], { cwd: sandbox });
  for (const p of ["downloads", "user", "dist/pkg", ".tools/native", "dev/node_modules", ".runtime/state"])
    assert.equal(await readFile(join(sandbox, p, "keep"), "utf8"), "fixture");
  for (const p of ["target", "web/dist"])
    await assert.rejects(() => stat(join(sandbox, p)), { code: "ENOENT" });
  pass(
    "gitignore and clean preserve downloads, state, dependencies and historical assets",
  );
  const runState = join(root, "make-run-state");
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const args = [
    "--no-open",
    "--isolated",
    "--data-dir",
    runState,
    "--download-dir",
    relative(repo, join(root, "make-downloads")),
    "--peer-port",
    "0",
    "--http-port",
    "0",
  ]
    .map(quote)
    .join(" ");
  const child = spawn(
    "make",
    ["run", `ARGS=${args}`],
    { cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  try {
    const url = await wait(
      () => {
        if (child.exitCode !== null) throw Error(log);
        return log.match(/FeedTorrent (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      },
      "make run",
      60000,
    );
    const response = await fetch(url),
      cookie = response.headers.get("set-cookie").split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: url,
      "Content-Type": "application/json",
    };
    const added = await fetch(url + "/api/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "add_magnet", uri: id }),
    });
    assert.equal(added.status, 200);
    const state = await (
      await fetch(url + "/api/snapshot", { headers })
    ).json();
    assert.equal(state.transfers[0].save_path, join(root, "make-downloads", id));
    pass(
      "make run from the repo uses explicit isolated state and relative download paths",
    );
  } finally {
    const exited = once(child, "exit");
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await exited;
    await wait(
      () => {
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      "make run process group exit",
      15000,
    );
  }
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  if (root) await cleanup(root, app);
  await mkdir(evidencePath(), { recursive: true });
  await writeFile(
    evidencePath("open-cwd.json"),
    JSON.stringify(report, null, 2),
  );
}
