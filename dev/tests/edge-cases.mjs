import {evidencePath} from './runtime.mjs';
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  mkdir,
  writeFile,
  readFile,
  symlink,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import bencode from "bencode";
import {
  temporary,
  startApp,
  seed,
  tracker,
  reference,
  complete,
  exact,
  cleanup,
  wait,
  hash,
} from "./helpers.mjs";
const report = { time: new Date().toISOString(), checks: [], errors: [] };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
async function partial() {
  const root = await temporary(),
    tr = await tracker();
  let app, ref, reader;
  try {
    ref = await seed(join(root, "partial"), [2 * 1024 * 1024 + 91], {
      tracker: true,
      announce: [tr.http],
      uploadLimit: 65536,
    });
    app = await startApp(root);
    assert.equal((await app.api()).settings.seed_by_default, true);
    await app.command({ type: "configure", settings: {
      ...(await app.api()).settings, seed_by_default: false,
    } });
    await app.command({ type: "add_torrent", data: ref.bytes });
    const before = await wait(async () => {
      const s = await app.api();
      return s.transfers.find((t) => t.verified > 0 && t.verified < t.total);
    }, "partial verified download");
    await app.command({ type: "pause", id: ref.id });
    await app.stop();
    app = await startApp(root);
    assert.equal((await app.api()).transfers[0].active, false);
    await app.command({ type: "resume", id: ref.id });
    await wait(async () => {
      const s = await app.api();
      return s.transfers[0].verified >= before.verified;
    }, "valid pieces retained");
    reader = await reference();
    const received = reader.client.add(Buffer.from(ref.bytes), {
      path: join(root, "partial-reader"),
    });
    await new Promise((r) => received.once("infoHash", r));
    received.addPeer("127.0.0.1:" + (await app.api()).listen_port);
    await wait(() => received.downloaded > 0, "verified partial pieces served");
    assert((await app.api()).transfers[0].progress < 1);
    await reader.stop();
    reader = undefined;
    ref.client.throttleUpload(-1);
    const finished = await wait(async () => {
      const t = (await app.api()).transfers[0];
      return t.state === "Completed" && t.progress === 1 && t.active && t;
    }, "enabled completion without seeding");
    assert.equal(hash(await readFile(join(finished.save_path, finished.files[0].name))), hash(ref.originals[0]));
    assert.equal((await app.api()).transfers[0].active, true);
    await app.stop();
    app = await startApp(root);
    assert.equal((await app.api()).settings.seed_by_default, false);
    await wait(async () => (await app.api()).transfers[0].state === "Completed", "enabled completion restored after recheck");
    assert.equal((await app.api()).transfers[0].active, true);
    reader = await reference();
    const blocked = reader.client.add(Buffer.from(ref.bytes), { path: join(root, "no-seed-reader"), announce: [], private: true });
    await new Promise((r) => blocked.once("infoHash", r));
    blocked.addPeer("127.0.0.1:" + (await app.api()).listen_port);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(blocked.downloaded, 0);
    await reader.stop(); reader = undefined;
    await app.command({ type: "pause", id: ref.id });
    assert.equal((await app.api()).transfers[0].active, false);
    await app.command({ type: "resume", id: ref.id });
    await wait(async () => (await app.api()).transfers[0].state === "Completed", "Resume retains no-seed completion");
    assert.equal((await app.api()).transfers[0].active, true);
    pass("seed default off: partial sharing, enabled Completed without upload, restart/recheck and pause/resume retain policy");
  } finally {
    await cleanup(root, tr, ref, app, reader);
  }
}
async function custom(root, bytes, files, tr) {
  await mkdir(root, { recursive: true });
  for (const [name, data] of Object.entries(files))
    await writeFile(join(root, name), data);
  const ref = await reference({ tracker: true });
  const torrent = await new Promise((yes, no) => {
    ref.client.once("error", no);
    ref.client.add(bytes, { path: root }, yes);
  });
  await wait(() => torrent.done, "independent custom seeder");
  torrent.discovery.tracker.update();
  await wait(
    () =>
      new Promise((r) =>
        tr.server.getSwarm(torrent.infoHash, (_e, s) => r(s?.complete > 0)),
      ),
    "custom tracker announce",
  );
  return {
    ...ref,
    torrent,
    id: torrent.infoHash,
    bytes: Array.from(bytes),
    originals: Object.values(files),
  };
}
async function hybrid() {
  const root = await temporary(),
    tr = await tracker();
  let ref, app;
  try {
    const data = Buffer.from("FeedTorrent hybrid v1 interoperability\n");
    const digest = (a) => createHash(a).update(data).digest();
    const info = {
      name: "file-0.bin",
      length: data.length,
      "piece length": 16384,
      pieces: digest("sha1"),
      "meta version": 2,
      "file tree": {
        "file-0.bin": {
          "": { length: data.length, "pieces root": digest("sha256") },
        },
      },
    };
    const bytes = bencode.encode({ announce: tr.http, info });
    ref = await custom(join(root, "hybrid"), bytes, { "file-0.bin": data }, tr);
    app = await startApp(root);
    await app.command({ type: "add_torrent", data: ref.bytes });
    const t = await exact(app, ref);
    assert.equal(
      t.id,
      createHash("sha1").update(bencode.encode(info)).digest("hex"),
    );
    pass("hybrid accepted and transfers with a v1-only independent client");
  } finally {
    await cleanup(root, tr, ref, app);
  }
}
async function privateMetadata() {
  const root = await temporary(),
    tr = await tracker();
  let ref, app;
  try {
    const data = Buffer.from("private fixture");
    const bytes = bencode.encode({
      announce: tr.http,
      info: {
        name: "file-0.bin",
        length: data.length,
        "piece length": 16384,
        pieces: createHash("sha1").update(data).digest(),
        private: 1,
      },
    });
    ref = await custom(
      join(root, "private"),
      bytes,
      { "file-0.bin": data },
      tr,
    );
    app = await startApp(root);
    await app.command({
      type: "add_magnet",
      uri: `magnet:?xt=urn:btih:${ref.id}&tr=${encodeURIComponent(tr.http)}`,
    });
    const rejected = await wait(async () => {
      const s = await app.api();
      return s.transfers.find((t) => t.error.includes("Private"));
    }, "private magnet metadata rejected");
    assert.equal(rejected.verified, 0);
    assert.equal(rejected.active, false);
    await assert.rejects(
      () => app.command({ type: "resume", id: ref.id }),
      /Private/,
    );
    assert.equal((await app.api()).transfers[0].verified, 0);
    pass(
      "private metadata blocked before payload; Resume cannot bypass validation",
    );
  } finally {
    await cleanup(root, tr, ref, app);
  }
}
async function paths() {
  const root = await temporary(),
    tr = await tracker();
  let ref, app;
  try {
    ref = await seed(join(root, "paths"), [32001], {
      tracker: true,
      announce: [tr.http],
    });
    app = await startApp(root);
    const victim = join(root, "outside");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "preserve");
    const folder = join(root, "downloads", ref.id);
    await symlink(victim, folder);
    await assert.rejects(
      () => app.command({ type: "add_torrent", data: ref.bytes }),
      /Symlink/,
    );
    assert.equal((await app.api()).transfers.length, 0);
    assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "preserve");
    await rm(folder);
    await app.command({ type: "add_torrent", data: ref.bytes });
    await complete(app, ref.id);
    await symlink(victim, join(folder, "external"));
    const unpin=await app.command({type:'preview_removal',target:{kind:'unpin',id:ref.id}});
    await app.command({type:'set_pin',id:ref.id,pinned:false,revision:unpin.revision});
    await wait(async()=>(await app.api()).cleanup.some(j=>j.error.includes('Symlink')),'unsafe deletion rejected');
    assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "preserve");
    pass("symlink paths cannot redirect writes or deletion outside a transfer");
  } finally {
    await cleanup(root, tr, ref, app);
  }
}
async function failedAdd() {
  const root = await temporary(), tr = await tracker();
  let app, ref;
  try {
    ref = await seed(join(root, "retry-source"), [32769], {
      tracker: true, announce: [tr.http],
    });
    for (const failure of ["payload", "source", "manifest"]) {
      const home = join(root, failure), downloads = join(home, "downloads");
      await mkdir(downloads, { recursive: true });
      const path = join(downloads, ref.id), source = path + ".source";
      const blocked = failure === "payload" ? path
        : failure === "source" ? source : path + ".transfer.tmp";
      if (failure === "payload") await writeFile(blocked, "occupied");
      else await mkdir(blocked);
      app = await startApp(home);
      const add = () => app.command({ type: "add_magnet", uri: ref.magnet });
      await assert.rejects(add, undefined, failure + " initial add fails");
      await assert.rejects(add, undefined, failure + " retry must report the unresolved failure");
      const registry = join(home, "state", "transfers.json");
      let saved = JSON.parse(await readFile(registry, "utf8"));
      assert.equal(saved.records.length, 1);
      assert.equal(saved.records[0].active, false);
      assert.equal(saved.retention.pins.includes(ref.id), true);
      if (failure !== "manifest") await app.stop();
      if (failure === "source") {
        // Simulate a persisted metadata-only approval decision before restart.
        saved.records[0].held = true;
        saved.records[0].seed = false;
        await writeFile(registry, JSON.stringify(saved));
      }
      await rm(blocked, { recursive: true });
      if (failure !== "manifest") app = await startApp(home);
      const settings = (await app.api()).settings;
      await app.command({ type: "configure", settings: { ...settings, seed_by_default: false } });
      await app.command({ type: "add_torrent", data: ref.bytes });
      saved = JSON.parse(await readFile(registry, "utf8"));
      const record = saved.records[0];
      assert.equal(record.active, false, "repair preserves paused state");
      assert.equal(record.held, failure === "source");
      assert.equal(record.seed, failure !== "source", "repair preserves the original seeding decision");
      assert.equal(record.magnet, false, "replacement source format is durable");
      assert.deepEqual(await readFile(source), Buffer.from(ref.bytes));
      const transfer = (await app.api()).transfers.find(t => t.id === ref.id);
      assert.equal(transfer.error, "");
      assert.equal(transfer.active, false);
      assert.equal(transfer.held, failure === "source");
      assert.equal(transfer.pinned, true);
      assert.equal(transfer.verified, 0);
      if (failure === "source") {
        await assert.rejects(() => app.command({ type: "resume", id: ref.id }), /approval/i);
      } else {
        await app.command({ type: "resume", id: ref.id });
        await exact(app, ref);
        await app.command({ type: "pause", id: ref.id });
      }
      const before = await readFile(source);
      await app.command({ type: "add_magnet", uri: ref.magnet });
      assert.deepEqual(await readFile(source), before, "healthy duplicate preserves its source");
      assert.equal((await app.api()).transfers[0].active, false);
      await app.stop();
      app = await startApp(home);
      const restored = (await app.api()).transfers[0];
      assert.equal(restored.error, "");
      assert.equal(restored.active, false);
      assert.equal(restored.held, failure === "source");
      assert.equal(restored.pinned, true);
      await app.stop();
      pass(failure + " failure retries honestly, repairs and preserves pause/approval across restart");
    }
  } finally {
    await cleanup(root, tr, ref, app);
  }
}
for (const [name, run] of [
  ["failed add", failedAdd],
  ["partial", partial],
  ["hybrid", hybrid],
  ["private metadata", privateMetadata],
  ["paths", paths],
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
  evidencePath("native-edges.json"),
  JSON.stringify(report, null, 2),
);
