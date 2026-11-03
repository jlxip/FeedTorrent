import { decryptAge, encryptAge } from "./age-fixture.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import DHT from "bittorrent-dht";
import bencode from "bencode";
import { temporary, startApp, wait, reference, cleanup } from "./helpers.mjs";
const report = { checks: [], status: "running" };
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const digest = (bytes) => createHash("sha1").update(bytes).digest();
const check = (sig, msg, key) => {
  try {
    return verify(
      null,
      msg,
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          key,
        ]),
        format: "der",
        type: "spki",
      }),
      sig,
    );
  } catch {
    return false;
  }
};
const root = await temporary(),
  nodes = [],
  resources = [];
let app, reader;
const pw = "publication test password with spaces";
try {
  for (let i = 0; i < 6; i++) {
    const n = new DHT({ bootstrap: false, host: "127.0.0.1", verify: check });
    n.on("error", () => {});
    await new Promise((r) => n.listen(0, "127.0.0.1", r));
    nodes.push(n);
  }
  for (const n of nodes)
    for (const other of nodes)
      if (n !== other)
        n.addNode({ host: "127.0.0.1", port: other.address().port });
  await wait(
    () => nodes.every((n) => n.nodes.toArray().length >= 5),
    "DHT fixture",
  );
  const args = ["--dht-bootstrap", `127.0.0.1:${nodes[0].address().port}`];
  app = await startApp(join(root, "publisher"), args);
  resources.push(app);
  const pub = (command) => app.api("/api/publishing", command);
  await pub({ action: "create_key", password: pw, confirmation: pw });
  const { id } = await pub({ action: "create_feed", title: "Field notes" });
  let { draft, revision } = await pub({ action: "get_feed", id });
  draft.pages[0].body =
    "# Field notes\n\n<script>bad()</script>\n\n![alt](https://no.invalid/a.svg)";
  draft.pages[0].entries.push({ kind: "page", page: 2 });
  draft.pages.push({
    id: 2,
    title: "Harbour",
    body: "# Harbour\n\nFirst revision.",
    entries: [],
  });
  revision = (await pub({ action: "save_draft", id, revision, draft }))
    .revision;
  await assert.rejects(
    () => pub({ action: "save_draft", id, revision: revision - 1, draft }),
    /another tab/,
  );
  const before = (await app.api()).settings;
  await app.command({
    type: "configure",
    settings: { ...before, seed_by_default: false },
  });
  const initialRevision = revision;
  await pub({ action: "publish", id, revision, password: pw });
  draft.pages[0].body += "\n\nUnpublished note.";
  revision = (await pub({ action: "save_draft", id, revision, draft }))
    .revision;
  const own = await wait(
    async () => {
      const s = await app.api(),
        f = s.publishing.feeds.find((f) => f.id === id);
      if (f?.error) throw Error(f.error);
      return f?.state === "Published" && f;
    },
    "first publication",
    90000,
  );
  let saved = JSON.parse(
    await readFile(join(root, "publisher/state/publishing/library.json")),
  );
  assert.equal(saved.feeds[id].record.sequence, 0);
  assert.equal(saved.feeds[id].published_revision, initialRevision);
  assert.equal(saved.feeds[id].revision, revision);
  assert(initialRevision < revision);
  assert.equal(
    (await stat(join(root, "publisher/state/publishing/library.json"))).mode &
      0o777,
    0o600,
  );
  const seedBytes = decryptAge(Buffer.from(saved.vault.ciphertext), pw);
  const independentKey = createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seedBytes,
      ]),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  assert.equal(independentKey.toString("hex"), saved.vault.public_key);
  pass(
    "independent Node age decoder verifies scrypt, header MAC, payload authentication and Ed25519 identity",
  );
  const signed = saved.feeds[id].record;
  const salt = Buffer.from(signed.salt),
    pk = Buffer.from(signed.key),
    target = digest(Buffer.concat([pk, salt]));
  const value = bencode.decode(Buffer.from(signed.value));
  const message = bencode
    .encode({ salt, seq: signed.sequence, v: value })
    .subarray(1, -1);
  assert(check(Buffer.from(signed.signature), message, pk));
  const remote = await new Promise((yes, no) =>
    nodes[1].get(target, { salt }, (e, v) => (e ? no(e) : yes(v))),
  );
  assert(remote);
  assert.equal(
    Buffer.from(remote.v.ih).toString("hex"),
    Buffer.from(value.ih).toString("hex"),
  );
  pass(
    "signed BEP46 record stored on independent Node DHT; native catalogs seed despite global seeding off",
  );
  const hash = Buffer.from(value.ih).toString("hex"),
    snapshot = await app.api(),
    rootTransfer = snapshot.transfers.find((t) => t.id === hash);
  assert.equal(rootTransfer.state, "Seeding");
  const pkg = JSON.parse(
    await readFile(
      join(root, "publisher/state/publishing/catalogs", hash + ".json"),
    ),
  );
  const metainfo = Buffer.from(pkg.metainfo),
    decoded = bencode.decode(metainfo);
  assert(decoded.info.bep49);
  assert.equal(digest(bencode.encode(decoded.info)).toString("hex"), hash);
  const independent = await reference();
  resources.push(independent);
  const download = independent.client.add(metainfo, {
    path: join(root, "independent"),
    announce: [],
  });
  download.on("error", () => {});
  await new Promise((r) => download.once("infoHash", r));
  download.addPeer(`127.0.0.1:${snapshot.listen_port}`);
  await wait(() => download.done, "WebTorrent reverse catalog download");
  for (const [path, bytes] of pkg.files) {
    const f = download.files.find(
      (f) =>
        f.path ===
        Buffer.from(decoded.info.name).toString() + "/" + path.join("/"),
    );
    assert(f);
    assert.deepEqual(Buffer.from(await f.arrayBuffer()), Buffer.from(bytes));
  }
  pass(
    "WebTorrent downloads generated catalogs byte-for-byte; canonical metainfo and independent Ed25519 checks",
  );
  reader = await startApp(join(root, "reader"), args);
  resources.push(reader);
  await reader.command({
    type: "follow_feed",
    uri: own.magnet,
    config: {
      name: "Independent reader",
      mode: "current_catalog",
      automatic_limit: 8 * 1024 * 1024,
    },
  });
  await wait(
    async () => {
      const f = (await reader.api()).feeds[0];
      return f?.catalogs.some((c) => c.id === hash && c.ready);
    },
    "feed magnet -> metadata -> catalog",
    90000,
  );
  const body = await reader.command({
    type: "read_catalog_body",
    feed: id,
    catalog: hash,
  });
  const rendered = JSON.stringify(body);
  assert(rendered.includes("<script>"));
  assert(!rendered.includes("Unpublished note"));
  assert(!rendered.includes("no.invalid"));
  assert(!rendered.includes("password"));
  pass(
    "second native instance resolves feed magnet, downloads catalog and returns inert Markdown",
  );
  await wait(
    async () => (await reader.api()).feeds[0]?.update_peers > 0,
    "own publisher BEP50 discovery",
    90000,
  );
  draft.pages[1].body = "# Harbour\n\nSecond revision.";
  revision = (await pub({ action: "save_draft", id, revision, draft }))
    .revision;
  await pub({ action: "publish", id, revision, password: pw });
  await wait(async () => {
    const f = (await app.api()).publishing.feeds[0];
    if (f.error) throw Error(f.error);
    return f.state === "Published" && f.sequence === "1";
  }, "nested revision");
  saved = JSON.parse(
    await readFile(join(root, "publisher/state/publishing/library.json")),
  );
  assert.equal(saved.feeds[id].history.length, 4);
  const next = Buffer.from(
    bencode.decode(Buffer.from(saved.feeds[id].record.value)).ih,
  ).toString("hex");
  assert.notEqual(next, hash);
  assert(
    (await app.api()).transfers.some(
      (t) => t.id === hash && t.state === "Seeding",
    ),
  );
  await wait(
    async () => {
      const f = (await reader.api()).feeds[0];
      return f?.head === next && f.available === next;
    },
    "reader update",
    90000,
  );
  pass(
    "BEP50 delivers nested revision without Refresh; ancestors rebuild and old seeding catalogs remain",
  );
  await pub({ action: "publish", id, revision, password: "wrong" });
  await wait(async () => {
    const f = (await app.api()).publishing.feeds[0];
    return !f.operation && /password/i.test(f.error);
  }, "incorrect password");
  for (const full of [false, true]) {
    const r = await fetch(app.url + `/api/publishing/backup?full=${full}`, {
      headers: { Cookie: app.cookie },
    });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    await writeFile(join(root, full ? "full.tar" : "keys.tar"), bytes);
    const restored = await startApp(
      join(root, full ? "full-restore" : "key-restore"),
      args,
    );
    resources.push(restored);
    const result = await fetch(restored.url + "/api/publishing/import", {
      method: "POST",
      headers: {
        Cookie: restored.cookie,
        Origin: restored.url,
        "Content-Type": "application/x-tar",
        "X-FeedTorrent-Password": Buffer.from(pw).toString("hex"),
      },
      body: bytes,
    });
    assert.equal(result.status, 200, await result.text());
    await wait(
      async () => (await restored.api()).publishing.feeds.length === 1,
      "restored feed",
    );
    const f = (await restored.api()).publishing.feeds[0];
    assert.equal(f.active, false);
    const restoredDraft = await restored.api("/api/publishing", {
      action: "get_feed",
      id,
    });
    assert.equal(restoredDraft.draft.pages.length, full ? 2 : 1);
  }
  pass(
    "minimal and complete backups import with encrypted seed and plaintext catalogs; imported publishing stays disabled",
  );
  await pub({
    action: "change_password",
    old: pw,
    password: "new test password",
    confirmation: "new test password",
  });
  assert(!app.logs.includes(pw));
  assert(!JSON.stringify(await app.api()).includes(pw));
  await app.command({ type: "pause", id: hash });
  await app.stop();
  const restoredLibrary = JSON.parse(
    await readFile(join(root, "publisher/state/publishing/library.json")),
  );
  restoredLibrary.vault.ciphertext = Array.from(
    encryptAge(seedBytes, "new test password"),
  );
  seedBytes.fill(0);
  await writeFile(
    join(root, "publisher/state/publishing/library.json"),
    JSON.stringify(restoredLibrary),
  );
  app = await startApp(join(root, "publisher"), args);
  resources.push(app);
  await wait(
    async () =>
      (await app.api()).transfers.find((t) => t.id === hash)?.state ===
      "Paused",
    "durable own pause",
  );
  const after = await app.api("/api/publishing", { action: "get_feed", id });
  assert.equal(after.draft.pages[1].body, draft.pages[1].body);
  await wait(
    async () =>
      (await app.api()).publishing.public_key ===
      own.magnet.match(/btpk:([a-f0-9]+)/)[1],
    "restored public key snapshot",
  );
  await app.api("/api/publishing", {
    action: "publish",
    id,
    revision: after.revision,
    password: "new test password",
  });
  await wait(async () => {
    const f = (await app.api()).publishing.feeds[0];
    return f.state === "Published" && f.sequence === "2";
  }, "Rust decrypts independent Node age key");
  pass(
    "independent Node age encryption is accepted by Rust; password change, durable drafts, restart, paused old seed and secret-free snapshots/logs",
  );
  report.status = "passed";
} finally {
  for (const n of nodes) await new Promise((r) => n.destroy(r));
  await cleanup(root, ...resources);
  await mkdir(".runtime/evidence", { recursive: true });
  await writeFile(
    ".runtime/evidence/publishing.json",
    JSON.stringify(report, null, 2),
  );
}
