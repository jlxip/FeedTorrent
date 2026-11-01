// Runs inside the existing isolated DHT harness; never controls the review server.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bencode from "bencode";
import { seed, tracker, wait } from "./helpers.mjs";
const hex = b => Buffer.from(b).toString("hex");
export async function runBep46({ client, routing, root, put, freshGet, pass: outerPass }) {
  const report = { time: new Date().toISOString(), checks: [], errors: [] };
  const pass = name => { report.checks.push(name); outerPass("BEP46 " + name); };
  const resources = [];
  try {
    const tr = await tracker(); resources.push(tr);
    const a = await seed(join(root, "pointer-seed-a"), [17001, 49101, 0], { tracker: true, announce: [tr.http] }); resources.push(a);
    const b = await seed(join(root, "pointer-seed-b"), [20003, 33001, 0], { tracker: true, announce: [tr.http] }); resources.push(b);
    const keySeed = Buffer.alloc(32, 29);
    const secret = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), keySeed]), format: "der", type: "pkcs8" });
    const pk = createPublicKey(secret).export({ format: "der", type: "spki" }).subarray(-32);
    const salt = Buffer.from([0, 255, 128]);
    const magnet = `magnet:?dn=Sample+feed&xs=urn%3Abtpk%3A${hex(pk).toUpperCase()}&s=${hex(salt).toUpperCase()}`;
    const canonical = `magnet:?xs=urn:btpk:${hex(pk)}&s=${hex(salt)}`;
    const target = createHash("sha1").update(Buffer.concat([pk, salt])).digest();
    const identity = await client.call("parse_feed", { magnet });
    assert.equal(identity.target, hex(target)); assert.equal(identity.magnet, canonical);
    const publishNode = async (seq, ih) => {
      const v = { ih: Buffer.from(ih, "hex"), x: Buffer.from([0, 255]) };
      const signature = sign(null, bencode.encode({ salt, seq, v }).subarray(1, -1), secret);
      const stored = await put(routing[0], { k: pk, salt, seq, v, sig: signature });
      assert(stored.count > 0); assert.deepEqual(stored.key, target);
      return { value: hex(bencode.encode(v)), signature: hex(signature) };
    };
    const resolve = async previous => {
      const found = await client.perform({ kind: "get_pointer", magnet });
      return client.call("resolve_pointer", { magnet, item: found.item, previous });
    };
    const firstNode = await publishNode(1, a.torrent.infoHash);
    let current = await resolve();
    assert.equal(current.change, "initial"); assert.equal(current.pointer.infohash, a.torrent.infoHash);
    assert.equal(current.pointer.value, firstNode.value); assert.equal(current.pointer.signature, firstNode.signature);
    pass("Node publishes a signed pointer; Rust resolves a normalized feed magnet and preserves extension fields");

    const download = async (pointer, fixture, label) => {
      const folder = join(root, label); await mkdir(folder);
      const uri = `magnet:?xt=urn:btih:${pointer.infohash}&tr=${encodeURIComponent(tr.http)}`;
      const added = await client.call("add_magnet", { uri, path: folder }); assert.equal(added.id, pointer.infohash);
      await wait(async () => (await client.call("info")).transfers.find(t => t.id === added.id)?.state === "Seeding", "resolved torrent downloads");
      for (let i = 0; i < fixture.torrent.files.length; i++) assert.deepEqual(await readFile(join(folder, fixture.torrent.files[i].path)), fixture.originals[i]);
      return folder;
    };
    const originalFolder = await download(current.pointer, a, "pointer-download-a");
    pass("test host explicitly downloads the resolved torrent through its conventional magnet; all files match");

    const sameHash = await client.call("sign_pointer", { seed: hex(keySeed), infohash: a.torrent.infoHash, sequence: "2", salt: hex(salt) });
    const stored = await client.perform({ kind: "put_pointer", ...sameHash });
    assert.equal(await client.call("pointer_receipt", { ...sameHash, ...stored }), stored.acknowledged_nodes);
    const independent = await freshGet(routing, target, salt);
    assert.equal(independent.seq, 2); assert.deepEqual(independent.v.ih, Buffer.from(a.torrent.infoHash, "hex"));
    assert.equal(hex(independent.sig), hex(sign(null, bencode.encode({ salt, seq: 2, v: { ih: Buffer.from(a.torrent.infoHash, "hex") } }).subarray(1, -1), secret)));
    current = await resolve(current.pointer);
    assert.equal(current.change, "advanced"); assert.equal(current.infohash_changed, false); assert.equal(current.pointer.sequence, "2");
    const repeated = await resolve(current.pointer); assert.equal(repeated.change, "unchanged"); assert.equal(repeated.infohash_changed, false);
    pass("Rust publication interoperates with Node Ed25519; advancing the sequence with the same infohash does not request a download");

    const old = current.pointer;
    await publishNode(3, b.torrent.infoHash);
    current = await resolve(old); assert.equal(current.change, "advanced"); assert.equal(current.infohash_changed, true); assert.equal(current.pointer.infohash, b.torrent.infoHash);
    await download(current.pointer, b, "pointer-download-b");
    for (let i = 0; i < a.torrent.files.length; i++) assert.deepEqual(await readFile(join(originalFolder, a.torrent.files[i].path)), a.originals[i]);
    const transfers = (await client.call("info")).transfers;
    assert(transfers.some(t => t.id === a.torrent.infoHash && t.state === "Seeding")); assert(transfers.some(t => t.id === b.torrent.infoHash && t.state === "Seeding"));
    pass("a new infohash resolves and downloads exact updated content while the previous torrent remains intact and seeding");

    const republished = await client.perform({ kind: "put_pointer", ...current.pointer });
    assert(await client.call("pointer_receipt", { ...current.pointer, ...republished }) > 0);
    const again = await freshGet(routing, target, salt); assert.equal(again.seq, 3); assert.equal(hex(again.sig), current.pointer.signature);
    await assert.rejects(() => client.call("resolve_pointer", { magnet, item: old, previous: current.pointer }), /Rollback/);
    const conflict = await client.call("sign_pointer", { seed: hex(keySeed), infohash: b.torrent.infoHash, sequence: "3", salt: hex(salt) });
    await assert.rejects(() => client.call("resolve_pointer", { magnet, item: conflict, previous: current.pointer }), /Conflict/);
    await assert.rejects(() => client.call("resolve_pointer", { magnet, item: { ...current.pointer, signature: "00".repeat(64) } }), /InvalidSignature/);
    const wrongMagnet = canonical.replace(/&s=.*/, "&s=01");
    await assert.rejects(() => client.call("resolve_pointer", { magnet: wrongMagnet, item: current.pointer }), /IdentityMismatch/);
    pass("signed public pointers republish without a private key; rollback, extension-field equivocation, signature and identity failures remain distinct");

    const known = structuredClone(current.pointer);
    assert.equal((await client.call("resolve_pointer", { magnet, item: null, previous: known })).change, "not_found");
    const missingMagnet = canonical.replace(/&s=.*/, "&s=6d697373696e67");
    const missing = await client.perform({ kind: "get_pointer", magnet: missingMagnet });
    assert.equal((await client.call("resolve_pointer", { magnet: missingMagnet, item: missing.item })).change, "not_found");
    await publishNode(4, "ab".repeat(19));
    const malformed = await client.perform({ kind: "get_pointer", magnet });
    await assert.rejects(() => client.call("resolve_pointer", { magnet, item: malformed.item, previous: known }), /InvalidPayload/);
    assert.deepEqual(current.pointer, known);
    pass("absent records and signed incompatible payloads are rejected without replacing host-owned known state");
  } catch (error) { report.errors.push(error.stack); throw error; }
  finally {
    for (const resource of resources.reverse()) try { await resource.stop(); } catch (error) { report.errors.push(error.stack); }
    report.status = report.errors.length ? "fail" : "pass";
    await mkdir(".runtime/evidence", { recursive: true });
    await writeFile(".runtime/evidence/bep46.json", JSON.stringify(report, null, 2) + "\n");
    if (report.errors.length && !process.exitCode) process.exitCode = 1;
  }
}
