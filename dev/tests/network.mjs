import {evidencePath} from './runtime.mjs';
import {detachImage} from './disk-image.mjs';
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  readFile,
  writeFile,
  rm,
  chmod,
  mkdir,
  stat,
  open,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import bencode from "bencode";
import {
  temporary,
  startApp,
  seed,
  tracker,
  dhtNetwork,
  complete,
  exact,
  reverse,
  cleanup,
  wait,
  hash,
  reference,
} from "./helpers.mjs";
const report = {
  time: new Date().toISOString(),
  checks: [],
  status: "running",
};
const check = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log("PASS", name, JSON.stringify(details));
};
async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}
async function scenarios() {
  let root = await temporary(),
    tr,
    ref,
    app;
  try {
    tr = await tracker();
    ref = await seed(join(root, "seed"), [131073, 270001, 0], {
      tracker: true,
      announce: [tr.http],
    });
    app = await startApp(root);
    assert.equal((await fetch(app.url + "/api/snapshot")).status, 401);
    assert.equal(
      (
        await fetch(app.url + "/api/snapshot", {
          headers: { Cookie: app.cookie, Origin: "https://attacker.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.url + "/api/commands", {
          method: "POST",
          headers: { Cookie: app.cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(app.url + "/Cargo.toml")).status, 404);
    check("session, Origin and asset allowlist");
    await app.command({ type: "add_torrent", data: ref.bytes });
    let t = await exact(app, ref);
    check("HTTP tracker + TCP download, cross-file and zero-byte files");
    await app.command({type:'add_magnet',uri:ref.magnet});
    assert.equal((await app.api()).transfers.length,1);
    assert.equal((await app.api()).transfers[0].pinned,true);
    for (const uri of ["magnet:?xt=urn:btpk:abcd", "magnet:?xt=urn:btih:bad"])
      await rejects(
        () => app.command({ type: "add_magnet", uri }),
        /supported|hash|invalid/i,
      );
    const decoded = bencode.decode(Buffer.from(ref.bytes));
    decoded.info.private = 1;
    await rejects(
      () =>
        app.command({
          type: "add_torrent",
          data: Array.from(bencode.encode(decoded)),
        }),
      /Private/,
    );
    const v2 = bencode.encode({
      info: {
        name: "empty",
        "meta version": 2,
        "piece length": 16384,
        "file tree": { "empty.bin": { "": { length: 1, "pieces root": Buffer.alloc(32, 1) } } },
      },
    });
    await rejects(
      () => app.command({ type: "add_torrent", data: Array.from(v2) }),
      /v1|v2/,
    );
    check("Open duplicates preserve one pinned transfer; private/v2/post/invalid formats rejected");
    const other = spawn(app.child.spawnfile, app.child.spawnargs.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    other.stderr.on("data", (b) => (error += b));
    await new Promise((r) => other.once("exit", r));
    assert.match(error, /already running/);
    check("one native instance per data directory");
    await app.stop();
    app = undefined;
    const f = t.files.find((f) => f.length > 0);
    let bad = await readFile(join(t.save_path, f.name));
    bad[0] ^= 255;
    await writeFile(join(t.save_path, f.name), bad);
    await writeFile(join(root, "downloads", ref.id + ".resume"), "corrupt");
    app = await startApp(root);
    t = await exact(app, ref);
    check("corrupt resume and payload rebuilt; exact repair");
    await app.stop();
    app = undefined;
    await rm(join(t.save_path, t.files.find((f) => f.length > 200000).name));
    app = await startApp(root);
    t = await exact(app, ref);
    check("missing file rechecked and recovered");
    await app.command({ type: "pause", id: ref.id });
    await app.stop();
    app = undefined;
    app = await startApp(root);
    assert.equal((await app.api()).transfers[0].active, false);
    await app.command({ type: "resume", id: ref.id });
    await complete(app, ref.id);
    check("native restart restores pause and activity");
    await ref.stop();
    ref.stop = async () => {};
    await reverse(app, ref, root);
    check(
      "native BEP9/10 metadata and pieces served to independent TCP client",
    );
    await tr.stop();
    tr.stop = async () => {};
    await app.command({
      type: "add_magnet",
      uri:
        "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&tr=" +
        encodeURIComponent(tr.http),
    });
    await wait(
      async () => {
        const s = await app.api();
        return s.transfers.some((t) => t.warning);
      },
      "tracker failure",
      30000,
    );
    check("tracker failure visible without simulated progress");
  } finally {
    await cleanup(root, tr, ref, app);
  }
  root = await temporary();
  tr = undefined;
  ref = undefined;
  app = undefined;
  try {
    tr = await tracker();
    ref = await seed(join(root, "utp"), [900001], {
      utp: true,
      tracker: true,
      announce: [tr.udp],
    });
    assert.equal(ref.client.utp, true);
    const wires = [];
    ref.torrent.on("wire", (wire) => wires.push(wire.type));
    await new Promise((r) => ref.client._connPool.tcpServer.close(r));
    app = await startApp(root);
    await app.command({ type: "add_magnet", uri: ref.magnet });
    await exact(app, ref);
    assert(wires.some((type) => String(type).includes("utp")));
    check("UDP tracker + uTP-only seeder", { wires });
    await ref.stop();
    ref.stop = async () => {};
    await reverse(app, ref, root, { utp: true });
    check("uTP reverse transfer");
  } finally {
    await cleanup(root, tr, ref, app);
  }
  root = await temporary();
  ref = undefined;
  app = undefined;
  let dht;
  try {
    dht = await dhtNetwork();
    ref = await seed(join(root, "dht"), [555001], {
      dht: { bootstrap: dht.bootstrap, host: "127.0.0.1" },
    });
    await wait(
      () => dht.nodes.some((n) => n._peers.length || n._peers.size),
      "DHT announcement",
      20000,
    );
    app = await startApp(root, [
      "--dht-bootstrap",
      dht.bootstrap.map((n) => `${n.host}:${n.port}`).join(","),
    ]);
    await app.command({
      type: "add_magnet",
      uri: ref.id.toUpperCase(),
    });
    await exact(app, ref);
    const s = await app.api();
    assert(s.dht_nodes > 0);
    check(
      "bare magnet via isolated Mainline DHT, without tracker or manual peer",
      { nodes: s.dht_nodes },
    );
  } finally {
    await cleanup(root, dht, ref, app);
  }
}
async function memory() {
  const root = await temporary(),
    tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "memory"), [96 * 1024 * 1024 + 733], {
      tracker: true,
      announce: [tr.http],
      uploadLimit: 16 * 1024 * 1024,
    });
    app = await startApp(root);
    const exec = promisify(execFile);
    let peak = 0;
    const samples = [];
    const timer = setInterval(async () => {
      try {
        const { stdout } = await exec("ps", [
          "-o",
          "rss=",
          "-p",
          String(app.child.pid),
        ]);
        const rss = Number(stdout.trim()) * 1024;
        peak = Math.max(peak, rss);
        samples.push(rss);
      } catch {}
    }, 100);
    try {
      await app.command({ type: "add_torrent", data: ref.bytes });
      await exact(app, ref);
    } finally {
      clearInterval(timer);
    }
    check("large native disk download measured", {
      bytes: ref.originals[0].length,
      peakRss: peak,
      samples: samples.length,
    });
    assert(
      peak < 96 * 1024 * 1024,
      "RSS reached the full torrent size; investigate buffering",
    );
  } finally {
    await cleanup(root, tr, ref, app);
  }
}
async function quota() {
  const root = await temporary(),
    exec = promisify(execFile);
  let mounted = false,
    tr,
    ref,
    app;
  const image = join(root, "quota.dmg"),
    mount = join(root, "volume");
  await mkdir(mount);
  try {
    const injected = process.platform === "openbsd" || process.platform === "linux";
    const flag = join(root, "enospc-active"), shim = join(root, "enospc.so");
    if (injected) {
      await exec("cc", ["-shared", "-fPIC", "-std=c11", "-Wall", "-Wextra", "-Werror", "dev/fixtures/enospc.c", "-o", shim, ...(process.platform === "linux" ? ["-ldl"] : [])]);
      await writeFile(flag, "active");
    } else {
      await exec("hdiutil", [
        "create",
        "-size",
        "20m",
        "-fs",
        "HFS+",
        "-volname",
        "FeedTorrentQuota",
        "-quiet",
        image,
      ]);
      await exec("hdiutil", [
        "attach",
        "-nobrowse",
        "-mountpoint",
        mount,
        "-quiet",
        image,
      ]);
      mounted = true;
      const filler = join(mount, "filler");
      const handle = await open(filler, "w");
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        while (true) await handle.write(chunk);
      } catch (e) {
        if (e.code !== "ENOSPC") throw e;
      } finally {
        await handle.close();
      }
      // Release two MiB so metadata and a subset of pieces can be written.
      const size = (await stat(filler)).size;
      const fillerHandle = await open(filler, "r+");
      await fillerHandle.truncate(Math.max(0, size - 2 * 1024 * 1024));
      await fillerHandle.close();
    }
    tr = await tracker();
    ref = await seed(join(root, "quota-source"), [5 * 1024 * 1024], {
      tracker: true,
      announce: [tr.http],
    });
    const downloads = join(mount, "downloads");
    const options = injected ? { env: { ...process.env,
      LD_PRELOAD: [shim, process.env.LD_PRELOAD].filter(Boolean).join(":"),
      FEEDTORRENT_TEST_ENOSPC_ACTIVE: flag,
      FEEDTORRENT_TEST_ENOSPC_FILE: join(downloads, ref.id, "source/file-0.bin"),
    } } : {};
    app = await startApp(root, ["--download-dir", downloads], options);
    await app.command({ type: "add_torrent", data: ref.bytes });
    const failure = await wait(
      async () => {
        const s = await app.api();
        return s.transfers.find((t) => t.state === "Error");
      },
      "ENOSPC error",
      30000,
    );
    assert.match(failure.error, /space|disk|quota/i);
    check(injected ? "isolated native ENOSPC write injection" : "real filesystem full error", {
      error: failure.error,
      verified: failure.verified,
    });
    await rm(injected ? flag : join(mount, "filler"));
    await app.command({ type: "resume", id: ref.id });
    await exact(app, ref);
    check(injected ? "ENOSPC injection cleared; exact download resumes" : "space recovered, valid pieces retained and download resumed");
  } finally {
    if (app) await app.stop();
    if (ref) await ref.stop();
    if (tr) await tr.stop();
    if (mounted) await detachImage(mount);
    await rm(root, { recursive: true, force: true });
  }
}
report.errors = [];
for (const [name, run] of [
  ["network", scenarios],
  ["memory", memory],
  ["quota", quota],
]) {
  try {
    await run();
  } catch (error) {
    report.errors.push({ name, error: error.stack });
    console.error(name, error);
    process.exitCode = 1;
  }
}
report.status = report.errors.length ? "fail" : "pass";
await mkdir(evidencePath(), { recursive: true });
await writeFile(
  evidencePath("native-network.json"),
  JSON.stringify(report, null, 2),
);
