// Independent Node publisher. No Rust catalog codec or application test hooks.
import bencode from 'bencode';
import DHT from 'bittorrent-dht';
import {createHash, createPublicKey, verify} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {signed, target, WirePeer} from '../fixtures/bep50-node.mjs';
import {reference, wait, seed, tracker} from './helpers.mjs';
export const sha1 = b => createHash('sha1').update(b).digest();
const utf = b => Buffer.from(b).toString();
export const magnet = h => 'magnet:?xt=urn:btih:' + h;
export async function feedFixture(root) {
  const resources = [], nodes = [];
  const stop = async () => {
    for (const r of resources.reverse()) await r.stop();
  };
  try {
    const tr = await tracker();
    resources.push(tr);
    const verifySig = (sig, msg, pk) => {
      try {
        return verify(
            null, msg, createPublicKey({
              key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]),
              format: 'der',
              type: 'spki'
            }),
            sig)
      } catch {
        return false
      }
    };
    for (let i = 0; i < 3; i++) {
      const n = new DHT({bootstrap: false, host: '127.0.0.1', verify: verifySig});
      n.on('error', () => {});
      await new Promise(r => n.listen(0, '127.0.0.1', r));
      nodes.push(n);
      resources.push({stop: () => new Promise(r => n.destroy(r))});
    }
    for (const a of nodes)
      for (const b of nodes)
        if (a !== b) a.addNode({host: '127.0.0.1', port: b.address().port});
    await wait(
        () => nodes.every(n => n.nodes.toArray().length >= 2), 'publisher DHT routing');
    const bootstrap = nodes.map(n => ({host: '127.0.0.1', port: n.address().port}));
    const secret = Buffer.alloc(32, 77), salt = Buffer.from([1, 255]);
    let seq = 0;
    const identity = signed(secret, 0, {ih: Buffer.alloc(20)}, salt);
    const feedMagnet =
        `magnet:?xs=urn:btpk:${identity.k.toString('hex')}&s=${salt.toString('hex')}`;
    const feedId = target(identity.k, salt).toString('hex');
    const content = await seed(
        join(root, 'content'), [19001, 12021, 0], {tracker: true, announce: [tr.http]});
    resources.push(content);
    let contentRequests = 0;
    content.torrent.on('wire', w => w.on('request', () => contentRequests++));
    async function catalog(name, entries, fields = {}) {
      const files = entries.map((e) => ({
                                  length: e.data.length,
                                  path: e.path,
                                  sha1: e.sha1 || sha1(e.data),
                                  ...(e.attr ? {attr: e.attr} : {})
                                }));
      const payloads = entries.map(e => e.data);
      const total = payloads.reduce((n, b) => n + b.length, 0);
      const padding = (16384 - total % 16384) % 16384;
      if (padding) {
        files.push({length: padding, path: ['.pad', String(padding)], attr: 'p'});
        payloads.push(Buffer.alloc(padding));
      }
      const all = Buffer.concat(payloads), pieces = [];
      for (let at = 0; at < all.length; at += 16384)
        pieces.push(sha1(all.subarray(at, at + 16384)));
      const info = {
        name,
        files,
        'piece length': 16384,
        pieces: Buffer.concat(pieces),
        bep49: fields
      };
      const bytes = Buffer.from(
          bencode.encode({announce: tr.http, info, comment: 'Independent Node catalog'}));
      const id = sha1(bencode.encode(info)).toString('hex');
      const folder = join(root, 'publisher-' + id);
      for (let i = 0; i < files.length; i++) {
        const p = join(folder, name, ...files[i].path.map(utf));
        await mkdir(dirname(p), {recursive: true});
        await writeFile(p, payloads[i]);
      }
      const peer = await reference({tracker: true, dht: {bootstrap}});
      const close = peer.stop;
      let closed = false;
      peer.stop = async () => {
        if (closed) return;
        closed = true;
        await close();
      };
      resources.push(peer);
      const t = peer.client.add(bytes, {path: folder, announce: [tr.http]});
      let requests = 0;
      t.on('wire', w => w.on('request', () => requests++));
      await wait(() => t.done, 'Node catalog seed verifies pieces');
      await wait(
          () => peer.client.dht.nodes.toArray().length > 0, 'catalog seed DHT routing');
      for (const n of nodes)
        n.addNode({host: '127.0.0.1', port: peer.client.dht.address().port});
      await new Promise(
          (yes, no) => peer.client.dht.announce(
              Buffer.from(id, 'hex'), peer.client.torrentPort, e => e ? no(e) : yes()));
      await wait(
          () => new Promise(r => tr.server.getSwarm(id, (_e, s) => r(s?.complete > 0))),
          'catalog tracker advertised');
      return {
        id,
        bytes,
        info,
        payloads,
        entries,
        folder,
        torrent: t,
        stop: peer.stop,
        get requests() {
          return requests
        }
      };
    }
    async function publish(
        catalog, sequence = ++seq, value = {ih: Buffer.from(catalog.id, 'hex')}) {
      seq = Math.max(seq, sequence);
      const r = signed(secret, sequence, value, salt);
      await new Promise(
          (yes, no) => nodes[0].put(
              {k: r.k, sig: r.sig, salt: r.salt, seq: r.seq, v: r.v},
              (e, _key, count) => e ? no(e) :
                  count             ? yes() :
                                      no(Error('No DHT confirmations'))));
      return r;
    }
    const head = await catalog('Reading list', [
      {path: ['film.torrent'], data: Buffer.from(content.bytes)},
      {path: ['note.txt'], data: Buffer.from('An opaque catalog item')},
      {path: ['empty'], data: Buffer.alloc(0)}
    ]);
    await publish(head);
    return {
      head,
      content,
      tr,
      nodes,
      bootstrap: `127.0.0.1:${nodes[0].address().port}`,
      feedMagnet,
      feedId,
      catalog,
      publish,
      get contentRequests() {
        return contentRequests
      },
      stop,
      async push(app, record) {
        const peer = await new WirePeer().listen();
        resources.push({stop: () => peer.close()});
        peer.subscribe(record);
        const c = target(record.k, record.salt);
        const found = [];
        for (const n of nodes) {
          const listener = (p, h) => {
            if (Buffer.from(h).equals(c)) found.push(p)
          };
          n.on('peer', listener);
          await new Promise(r => n.lookup(c, () => r()));
          n.off('peer', listener);
        }
        const candidates =
            [...new Map(found.filter(p => p.port !== (app.listen_port || 0))
                            .map(p => [p.host + ':' + p.port, p]))
                 .values()];
        for (const endpoint of candidates) {
          try {
            await peer.rpc(c, endpoint, 'ping', {}, 750);
            await peer.publish(endpoint, record);
            return endpoint;
          } catch {
          }
        }
        throw Error(
            'No live PubSub announcement discovered among ' + JSON.stringify(candidates));
      }
    };
  } catch (e) {
    await stop();
    throw e
  }
}
