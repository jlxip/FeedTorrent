import { WirePeer,signed as signNodeRecord,jsonRecord } from "../fixtures/bep50-node.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import bencode from "bencode";
import { seed, tracker, reference, wait } from "./helpers.mjs";
const utf8 = b => Buffer.from(b).toString("utf8");
const hex = b => Buffer.from(b).toString("hex");
const sha1 = b => createHash("sha1").update(b).digest();
const magnet = h => `magnet:?xt=urn:btih:${h}`;
export async function runBep49({ client, root, native, pass: outerPass }) {
  const report = { time: new Date().toISOString(), checks: [], errors: [] };
  const resources = [];
  const pass = text => { report.checks.push(text); outerPass("BEP49 " + text); };
  try {
    const tr = await tracker(); resources.push(tr);
    const push=await new WirePeer().listen();resources.push({stop:()=>push.close()});
    const child = await seed(join(root, "catalog-content"), [17001, 12007, 0], { tracker: true, announce: [tr.http] }); resources.push(child);
    const childBytes = Buffer.from(child.bytes);
    const changedOuter = bencode.decode(childBytes); changedOuter.comment = "Independent outer extension";
    const variant = Buffer.from(bencode.encode(changedOuter));
    const identity = await client.call("sign_pointer", { seed: "1f".repeat(32), infohash: "00".repeat(20), sequence: "1", salt: "01" });
    await client.call("subscribe",identity);
    const embedded = await client.call("sign_pointer", { seed: "20".repeat(32), infohash: "00".repeat(20), sequence: "1" });
    const inputs = [
      { path: ["z-first.torrent"], data: hex(childBytes) },
      { path: ["a-second.torrent"], data: hex(variant) },
      { path: ["notice.txt"], data: hex(Buffer.from("opaque feed item")) },
      { path: ["empty"], data: "" },
      { path: ["meta", "readme.txt"], data: hex(Buffer.from("feed metadata")) },
    ];
    function independentlyCheck(meta, entries) {
      const decoded = bencode.decode(meta), info = decoded.info;
      assert(info.bep49 && Array.isArray(info.files));
      assert(!Object.hasOwn(info, "length")); assert(!Object.hasOwn(decoded, "creation date"));
      const payloads = info.files.map((file, i) => {
        const attr = Buffer.from(file.attr || []).toString();
        if (attr.includes("p")) return Buffer.alloc(Number(file.length));
        const bytes = Buffer.from(entries[i].data, "hex");
        assert.equal(bytes.length, Number(file.length)); assert.deepEqual(sha1(bytes), Buffer.from(file.sha1));
        assert.deepEqual(file.path.map(p => Buffer.from(p).toString()), entries[i].path);
        return bytes;
      });
      const all = Buffer.concat(payloads); assert.equal(all.length % Number(info["piece length"]), 0);
      const pieces = []; for (let at = 0; at < all.length; at += Number(info["piece length"])) pieces.push(sha1(all.subarray(at, at + Number(info["piece length"]))));
      assert.deepEqual(Buffer.concat(pieces), Buffer.from(info.pieces));
      return { decoded, payloads, id: hex(sha1(bencode.encode(info))), info: hex(bencode.encode(info)) };
    }
    const build = async (name, entries, fields = {}) => {
      const out = await client.call("build_catalog", { name, entries, announce: tr.http, ...fields });
      const checked = independentlyCheck(Buffer.from(out.metainfo, "hex"), entries);
      assert.equal(out.infohash, checked.id); assert.equal(out.info, checked.info);
      return { ...out, ...checked, entries };
    };
    const head = await build("catalog", inputs, { source: embedded.magnet });
    assert.equal(utf8(head.decoded.info.files[0].path[0]), "z-first.torrent");
    pass("Rust creates canonical multifile HEAD with ordered items, exact file SHA1 and independently checked piece hashes/padding");

    async function seedMetainfo(catalog, name) {
      const folder = join(root, name); await mkdir(folder, { recursive: true });
      const info = catalog.decoded.info;
      for (let i = 0; i < info.files.length; i++) {
        const path = join(folder, utf8(info.name), ...info.files[i].path.map(utf8));
        await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, catalog.payloads[i]);
      }
      const peer = await reference({ tracker: true }); resources.push(peer);
      const torrent = peer.client.add(Buffer.from(catalog.metainfo, "hex"), { path: folder, announce: [tr.http] });
      await wait(() => torrent.done, "independent catalog seeder verifies existing pieces");
      await new Promise((yes, no) => { const timer = setTimeout(() => no(Error("Catalog tracker announce")), 10000); torrent.once("trackerAnnounce", () => { clearTimeout(timer); yes(); }); torrent.discovery.tracker.update(); });
      await wait(() => new Promise(resolve => tr.server.getSwarm(catalog.id, (_e, swarm) => resolve(swarm?.complete > 0))), "catalog advertised by independent seeder");
      return peer;
    }
    await seedMetainfo(head, "head-publisher");
    await assert.rejects(() => client.call("metadata", { transfer: "ab".repeat(20) }), /Unknown transfer/);
    const pending = await client.call("add_magnet", { uri: magnet("cd".repeat(20)), path: join(root, "pending-catalog") });
    assert.equal((await client.call("metadata", { transfer: pending.id })).info, null);
    await client.call("remove", { transfer: pending.id });
    await assert.rejects(() => client.call("metadata", { transfer: pending.id }), /Unknown transfer/);
    pass("metadata capability distinguishes unknown, pending and removed transfers without changing transfer contracts");

    const publish = async (catalog, seq) => {
      const signed = await client.call("sign_pointer", { seed: "1f".repeat(32), salt: "01", infohash: catalog.id, sequence: String(seq) });
      assert((await client.perform({ kind: "put_pointer", ...signed })).acknowledged_nodes > 0);
      const item = (await client.perform({ kind: "get_pointer", magnet: identity.magnet })).item;
      const resolved = await client.call("resolve_pointer", { magnet: identity.magnet, item });
      assert.equal(resolved.pointer.infohash, catalog.id);
      // Independent Node publishes the same BEP46 record via BEP50. The host
      // explicitly interprets the push before choosing the following download.
      const pushed=signNodeRecord(Buffer.alloc(32,31),seq,{ih:Buffer.from(catalog.id,"hex")},Buffer.from([1]));
      push.subscribe(pushed);
      await push.publish({host:"127.0.0.1",port:(await client.call("pubsub_info")).port},pushed);
      const received=await wait(async()=>{const r=await client.call("latest",identity);return r?.sequence===String(seq)&&r},"BEP50 pointer delivery");
      const fromPush=await client.call("resolve_pointer",{magnet:identity.magnet,item:received});
      assert.equal(fromPush.pointer.infohash,catalog.id);
      assert.deepEqual(jsonRecord(pushed),received);
      return fromPush.pointer;
    };
    const download = async (peer, catalog, name) => {
      const folder = join(root, name); await mkdir(folder);
      const transfer = await peer.call("add_magnet", { uri: magnet(catalog.id) + "&tr=" + encodeURIComponent(tr.http), path: folder });
      assert.equal(transfer.id, catalog.id);
      const raw = await wait(async () => (await peer.call("metadata", { transfer: transfer.id })).info, "BEP9/10 delivers original info");
      assert.equal(raw, catalog.info); assert.equal(hex(sha1(Buffer.from(raw, "hex"))), catalog.id);
      const parsed = await peer.call("inspect_catalog", { info: raw, expected: catalog.id, resolved_source: identity.magnet });
      await wait(async () => (await peer.call("info")).transfers.find(t => t.id === transfer.id)?.state === "Seeding", "feed files downloaded and verified");
      for (let i = 0; i < catalog.decoded.info.files.length; i++) {
        const file = catalog.decoded.info.files[i]; if (Buffer.from(file.attr || []).includes(112)) continue;
        assert.deepEqual(await readFile(join(folder, utf8(catalog.decoded.info.name), ...file.path.map(utf8))), catalog.payloads[i]);
      }
      return { folder, parsed };
    };
    await publish(head, 1);
    const concurrent = client.perform({ kind: "get_pointer", magnet: identity.magnet });
    const initial = await download(client, head, "native-head"); assert.equal((await concurrent).item.sequence, "1");
    assert.equal(initial.parsed.source, embedded.magnet); assert.equal(initial.parsed.effective_source, identity.magnet);
    await assert.rejects(() => client.call("inspect_catalog", { info: head.info, expected: "00".repeat(20) }), /IdentityMismatch/);
    pass("feed magnet resolves over real DHT; native BEP9/10 exports exact info and downloads the catalog while preserving the resolved identity");

    const first = await client.call("inspect_item", { data: hex(await readFile(join(initial.folder, "catalog", "z-first.torrent"))) });
    const second = await client.call("inspect_item", { data: hex(await readFile(join(initial.folder, "catalog", "a-second.torrent"))) });
    assert.equal(first.infohash, child.id); assert.equal(first.infohash, second.infohash); assert.notEqual(first.bytes, second.bytes);
    assert.equal(first.bytes, hex(childBytes)); assert.equal(second.bytes, hex(variant));
    assert.equal((await client.call("inspect_item", { data: inputs[2].data })).kind, "opaque");
    const selectedFolder = join(root, "selected-content"); await mkdir(selectedFolder);
    const selected = await client.call("add", { torrent: first.bytes, path: selectedFolder }); assert.equal(selected.id, child.id);
    await wait(async () => (await client.call("info")).transfers.find(t => t.id === child.id)?.state === "Seeding", "explicit selected item downloads");
    for (let i = 0; i < child.torrent.files.length; i++) assert.deepEqual(await readFile(join(selectedFolder, child.torrent.files[i].path)), child.originals[i]);
    pass("catalog items retain full outer dictionaries; same infohash/different file hashes and opaque items coexist; selected content downloads exactly");

    const reverse = await reference(); resources.push(reverse);
    const received = reverse.client.add(Buffer.from(head.metainfo, "hex"), { path: join(root, "catalog-reverse"), announce: [] });
    await new Promise(r => received.once("infoHash", r)); received.addPeer("127.0.0.1:" + (await client.call("info")).port);
    await wait(() => received.done, "independent client receives Rust feed from libtorrent");
    for (let i = 0; i < head.decoded.info.files.length; i++) {
      const file = head.decoded.info.files[i]; if (Buffer.from(file.attr || []).includes(112)) continue;
      const path = utf8(head.decoded.info.name) + "/" + file.path.map(utf8).join("/");
      const actual = received.files.find(f => f.path === path); assert(actual, path); assert.deepEqual(Buffer.from(await actual.arrayBuffer()), head.payloads[i]);
    }
    pass("libtorrent serves Rust-generated feed payload and synthetic padding to independent WebTorrent over TCP");

    // Independent Node producer, not a roundtrip through the Rust builder.
    const oldFiles = [{ path: ["old.torrent"], data: hex(variant) }];
    const oldPayload = Buffer.from(variant), padLength = (16384 - oldPayload.length % 16384) % 16384;
    const oldInfo = { name: "old-archive", "piece length": 16384, bep49: { archive: 1, extension: "retained" }, files: [{ path: ["old.torrent"], length: oldPayload.length, sha1: sha1(oldPayload) }] };
    if (padLength) oldInfo.files.push({ path: [".pad", String(padLength)], length: padLength, attr: "p" });
    const oldData = Buffer.concat([oldPayload, Buffer.alloc(padLength)]); const oldPieces = []; for (let i = 0; i < oldData.length; i += 16384) oldPieces.push(sha1(oldData.subarray(i, i + 16384))); oldInfo.pieces = Buffer.concat(oldPieces);
    const oldMeta = Buffer.from(bencode.encode({ announce: tr.http, info: oldInfo }));
    const old = { ...independentlyCheck(oldMeta, oldFiles), metainfo: hex(oldMeta), entries: oldFiles };
    const oldParsed = await client.call("inspect_catalog", { metainfo: old.metainfo }); assert(oldParsed.archive); assert.equal(oldParsed.infohash, old.id);
    await seedMetainfo(old, "old-archive-publisher");
    const archive = await build("archive", [inputs[0]], { archive: true, archive_next: magnet(old.id) }); await seedMetainfo(archive, "archive-publisher");
    const revision = await build("catalog", [...inputs.slice(1), { path: ["new.txt"], data: hex(Buffer.from("new version")) }], { source: embedded.magnet, archive_next: magnet(archive.id), previous: magnet(head.id) }); await seedMetainfo(revision, "revision-publisher");
    await publish(revision, 2); const latest = await download(client, revision, "native-revision");
    assert.equal(latest.parsed.previous, magnet(head.id)); assert.equal(latest.parsed.archive_next, magnet(archive.id));
    const history = await native("history-reader", "");
    const archived = await download(history, archive, "native-archive"); assert(archived.parsed.archive); assert.equal(archived.parsed.source, null); assert.equal(archived.parsed.previous, null);
    const older = await download(history, old, "native-old-archive"); assert(older.parsed.archive); assert.equal(older.parsed.info, old.info);
    await download(history, head, "native-previous");
    assert.deepEqual(await readFile(join(initial.folder, "catalog", "z-first.torrent")), childBytes);
    await history.call("shutdown"); await assert.rejects(() => history.call("metadata", { transfer: head.id }), /Backend closed/);
    pass("BEP50 Node pushes signed BEP46 revisions; host resolves and explicitly downloads BEP49/content while preserving previous data");
    pass("revisions, prev and chained archives interoperate with an independent Node producer; explicit history retrieval preserves previous content and close errors");
  } catch (error) { report.errors.push(error.stack); throw error; }
  finally {
    for (const resource of resources.reverse()) try { await resource.stop(); } catch (error) { report.errors.push(error.stack); }
    report.status = report.errors.length ? "fail" : "pass";
    await mkdir(".runtime/evidence", { recursive: true }); await writeFile(".runtime/evidence/bep49.json", JSON.stringify(report, null, 2) + "\n");
    if (report.errors.length) process.exitCode = 1;
  }
}
