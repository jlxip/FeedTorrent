import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, cp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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
let root, app;
try {
  root = await temporary();
  const a = join(root, "working a"),
    b = join(root, "working b");
  await mkdir(a);
  await mkdir(b);
  app = await startApp(root, [], { cwd: a, defaultDownloads: true });
  assert.equal((await app.api()).settings.download_dir, "downloads");
  await app.command({ type: "add_magnet", uri: `  ${id.toUpperCase()}\n` });
  await assert.rejects(
    () => app.command({ type: "add_magnet", uri: base32.toLowerCase() }),
    /already exists/,
  );
  assert.equal(
    await readFile(join(root, "state", id + ".source"), "utf8"),
    `magnet:?xt=urn:btih:${id}`,
  );
  await app.command({ type: "pause", id });
  await app.stop();
  app = await startApp(root, [], { cwd: b, defaultDownloads: true });
  let s = await app.api();
  assert.equal(s.settings.download_dir, "downloads");
  assert.equal(s.transfers[0].save_path, join(a, "downloads", id));
  assert.equal(s.transfers[0].active, false);
  assert.notEqual(s.transfers[0].state, "Error");
  const second = "1".repeat(40);
  await app.command({ type: "add_magnet", uri: second });
  assert.equal(
    (await app.api()).transfers.find((t) => t.id === second).save_path,
    join(b, "downloads", second),
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
  assert.equal((await app.api()).settings.download_dir, "downloads");
  assert.equal(
    (await readJson(join(legacy, "state/transfers.json"))).version,
    3,
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
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", "downloads/probe"],
    { cwd: repo },
  );
  const sandbox = join(root, "clean");
  await mkdir(sandbox);
  await cp(join(repo, "Makefile"), join(sandbox, "Makefile"));
  for (const p of [
    "downloads",
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
  execFileSync("make", ["-f", join(sandbox, "Makefile"), "clean"], { cwd: a });
  for (const p of ["downloads", "dist/pkg", ".tools/native", "dev/node_modules", ".runtime/state"])
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
    "--peer-port",
    "0",
    "--http-port",
    "0",
  ]
    .map(quote)
    .join(" ");
  const child = spawn(
    "make",
    ["-f", join(repo, "Makefile"), "run", `ARGS=${args}`],
    { cwd: a, detached: true, stdio: ["ignore", "pipe", "pipe"] },
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
    assert.equal(state.transfers[0].save_path, join(a, "downloads", id));
    pass(
      "make -f from another CWD builds in repo and runs in the caller directory",
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
  await mkdir(".runtime/evidence", { recursive: true });
  await writeFile(
    ".runtime/evidence/open-cwd.json",
    JSON.stringify(report, null, 2),
  );
}
