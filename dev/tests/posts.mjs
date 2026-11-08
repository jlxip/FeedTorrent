import {evidencePath} from './runtime.mjs';
import assert from 'node:assert/strict';
import {mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {postFixture, magnet} from './post-fixtures.mjs';
import {cleanup, hash, startApp, temporary, wait} from './helpers.mjs';

const report = {
  time: new Date().toISOString(),
  checks: []
};
const pass = s => {
  report.checks.push(s);
  console.log('PASS', s)
};
let app, fx;
const root = await temporary();
const config = (mode = 'current_catalog', automatic_limit = 8 * 1024 * 1024) =>
    ({name: 'Reading list', mode, automatic_limit});
const post = async () => (await app.api()).posts.find(f => f.id === fx.postId);
const indexed = async (catalog) => wait(async () => {
  let p;
  try {
    p = await app.command(
        {type: 'catalog_page', post: fx.postId, catalog: catalog.id, offset: 0})
  } catch (e) {
    if (/Catalog not found/.test(e.message)) return false;
    throw e
  }
  return p.entries.length === catalog.entries.length &&
      p.entries.every(e => e.kind !== 'pending' || e.error) && p
}, 'indexed catalog');
try {
  fx = await postFixture(root);
  const args = ['--dht-bootstrap', fx.bootstrap];
  app = await startApp(join(root, 'app'), args);
  assert.equal(
      (await app.command({type: 'inspect_source', uri: fx.postMagnet})).kind, 'post');
  await app.command(
      {type: 'follow_post', uri: fx.postMagnet, config: config('current_catalog', 1)});
  let t = await wait(
      async () => (await app.api())
                      .transfers.find(
                          t => t.id === fx.head.id && t.state === 'Awaiting approval'),
      'DHT post resolution/metadata');
  assert.equal(t.verified, 0);
  assert(t.held);
  assert.equal(fx.head.requests, 0);
  assert.equal(fx.contentRequests, 0);
  await assert.rejects(() => app.command({type: 'resume', id: t.id}), /approval/);
  await app.stop();
  app = await startApp(join(root, 'app'), args);
  await wait(
      async () => (await app.api())
                      .transfers.some(
                          t => t.id === fx.head.id && t.state === 'Awaiting approval'),
      'held restoration');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(fx.head.requests, 0);
  pass(
      'real DHT → BEP46 → BEP9/10; metadata hold survives restart and Resume without a single payload request');
  const removedCatalog = await app.command({type:'preview_removal',target:{kind:'torrent',id:t.id,delete_files:true}});
  await app.command({type:'remove',id:t.id,delete_files:true,revision:removedCatalog.revision});
  await wait(async()=>!(await app.api()).transfers.some(x=>x.id===t.id)&&!(await app.api()).cleanup.length,'removed catalog');
  await app.command({type:'open_catalog',post:fx.postId,id:t.id});
  await wait(async()=>(await app.api()).transfers.some(x=>x.id===t.id&&x.state==='Awaiting approval'&&x.held),'Download retries removed catalog');
  await app.command({type:'pause',id:t.id});
  await app.deletePost('followed',fx.postId);
  await wait(async()=>!(await app.api()).transfers.length&&!(await app.api()).cleanup.length,'delete paused post');
  await app.stop();
  app = await startApp(join(root, 'app'), args);
  await app.command({type:'follow_post',uri:fx.postMagnet,config:config('current_catalog',1)});
  t = await wait(async()=>(await app.api()).transfers.find(x=>x.id===fx.head.id&&x.state==='Awaiting approval'&&x.held),'refollow retries removed head');
  assert.equal(fx.head.requests,0);
  assert.equal(fx.contentRequests,0);
  pass('Download after Remove and refollow after deleting a paused post restore metadata without bypassing the size limit, including restart');
  await app.stop();
  await rm(t.save_path, {recursive: true, force: true});
  await writeFile(t.save_path, 'blocked directory');
  app = await startApp(join(root, 'app'), args);
  const failed = await wait(
      async () =>
          (await app.api()).transfers.find(x => x.id === t.id && x.state === 'Error'),
      'held restore failure');
  assert(failed.held);
  await rm(t.save_path);
  await app.command({type: 'resume', id: t.id});
  await wait(
      async () =>
          (await app.api())
              .transfers.some(x => x.id === t.id && x.state === 'Awaiting approval'),
      'held restore repaired');
  assert.equal(fx.head.requests, 0);
  pass(
      'per-transfer disk-path failure recovers through Resume without releasing the metadata hold');
  await app.command({type: 'approve_transfer', id: t.id});
  let page = await indexed(fx.head);
  assert.equal((await post()).automatic_limit, 1);
  assert.equal(page.entries[0].kind, 'torrent');
  assert.equal(page.entries[1].kind, 'file');
  assert.equal(page.entries[2].kind, 'file');
  assert.equal((await app.api()).transfers.length, 1);
  assert.equal(fx.contentRequests, 0);
  const transfer = (await app.api()).transfers.find(t => t.id === fx.head.id);
  for (let i = 0; i < fx.head.entries.length; i++)
    assert.equal(
        hash(await readFile(
            join(transfer.save_path, fx.head.info.name, ...fx.head.entries[i].path))),
        hash(fx.head.entries[i].data));
  pass(
      'Download once preserves cap; current catalog indexes exact embedded torrents, opaque and empty items without fetching content');
  await app.command(
      {type: 'configure_post', id: fx.postId, config: config('mirror_all', 1)});
  t = await wait(
      async () => (await app.api())
                      .transfers.find(
                          t => t.id === fx.content.id && t.state === 'Awaiting approval'),
      'Mirror content size gate');
  assert.equal(fx.contentRequests, 0);
  await wait(
      async () => (await post()).mirror_status === 'Incomplete',
      'mirror approval status');
  await app.command(
      {type: 'download_entry', post: fx.postId, catalog: fx.head.id, index: 0});
  await wait(
      async () => (await app.api())
                      .transfers.some(t => t.id === fx.content.id && t.progress === 1),
      'explicit content download');
  const content = (await app.api()).transfers.find(t => t.id === fx.content.id);
  for (let i = 0; i < fx.content.originals.length; i++)
    assert.equal(
        hash(await readFile(join(content.save_path, 'source', `file-${i}.bin`))),
        hash(fx.content.originals[i]));
  await app.command({type: 'pause', id: fx.content.id});
  await app.command({type: 'refresh_post', id: fx.postId});
  assert.equal(
      (await app.api()).transfers.find(t => t.id === fx.content.id).state, 'Paused');
  const removal=await app.command({type:'preview_removal',target:{kind:'torrent',id:fx.content.id,delete_files:false}});
  await app.command({type:'remove',id:fx.content.id,delete_files:false,revision:removal.revision});
  await app.stop();
  app = await startApp(join(root, 'app'), args);
  await indexed(fx.head);
  assert(!(await app.api()).transfers.some(t => t.id === fx.content.id));
  pass(
      'Mirror all cap and exact content download; pause/remove override Mirror across process restart');
  const external = await fx.catalog(
      'External', [{path: ['foreign.torrent'], data: Buffer.from(fx.content.bytes)}], {
        'bep46 source': 'magnet:?xs=urn:btpk:' +
            'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
      });
  const history = await fx.catalog(
      'History', [{path: ['old.txt'], data: Buffer.from('retained history')}],
      {archive: 1});
  const next = await fx.catalog(
      'Revision',
      [
        {path: ['external.torrent'], data: external.bytes},
        {path: ['content.torrent'], data: Buffer.from(fx.content.bytes)}
      ],
      {prev: magnet(fx.head.id), 'archive next': magnet(history.id)});
  await fx.publish(next);
  await app.command(
      {type: 'configure_post', id: fx.postId, config: config('mirror_catalogs', null)});
  await app.command({type: 'refresh_post', id: fx.postId});
  page = await indexed(next);
  await indexed(history);
  assert.equal(page.entries[0].kind, 'external_post');
  assert.equal(external.requests, 0);
  assert(!(await app.api()).transfers.some(t => t.id === external.id));
  assert((await app.api()).transfers.some(t => t.id === fx.head.id));
  assert(!(await app.api()).transfers.some(t => t.id === fx.content.id));
  pass(
      'new signed revision traverses own history; foreign source stops nested download; previous data and manual removal retained');
  const live = await fx.catalog(
      'Live revision', [{path: ['live.txt'], data: Buffer.from('BEP50 live update')}],
      {prev: magnet(next.id)});
  const pushed = await fx.publish(live, 3);
  await fx.push(await app.api(), pushed);
  await indexed(live);
  await wait(async () => (await post()).update_peers > 0, 'live update contact');
  assert((await app.api()).transfers.some(t => t.id === next.id));
  pass(
      'independent Node BEP50 discovery delivers a signed live revision without Refresh, retaining previous catalogs');
  const liveTransfer = (await app.api()).transfers.find(t => t.id === live.id);
  await app.stop();
  const damagedPath = join(liveTransfer.save_path, 'Live revision', 'live.txt');
  const originalStat = await stat(damagedPath);
  await writeFile(damagedPath, Buffer.alloc(live.entries[0].data.length, 204));
  await utimes(damagedPath, originalStat.atime, originalStat.mtime);
  app = await startApp(join(root, 'app'), args);
  await indexed(live);
  await wait(
      async () => hash(await readFile(
                      join(liveTransfer.save_path, 'Live revision', 'live.txt'))) ===
          hash(live.entries[0].data),
      'native repairs corrupted catalog');
  pass('saved catalog is rechecked and repaired before inspection after restart');
  await app.stop();
  await live.stop();
  await rm(join(root, 'app/state', live.id + '.resume'), {force: true});
  app = await startApp(join(root, 'app'), args);
  await indexed(live);
  pass(
      'durable original metadata restores an offline catalog without resume data or its publisher');
  const absent = fx.postMagnet.replace(/&s=.*$/, '&s=001122');
  const absentId = (await app.command({type: 'inspect_source', uri: absent})).id;
  await app.command({type: 'follow_post', uri: absent, config: config()});
  await wait(
      async () => (await app.api())
                      .posts.find(f => f.id === absentId)
                      ?.error.includes('Waiting for a published catalog'),
      'publisher absent');
  await app.deletePost('followed',absentId);
  const auxiliary = await fx.catalog(
      'Bad auxiliary hash',
      [
        {
          path: ['bad.torrent'],
          data: Buffer.from(fx.content.bytes),
          sha1: Buffer.alloc(20)
        },
        {path: ['good.txt'], data: Buffer.from('other branch remains readable')}
      ],
      {prev: magnet(live.id)});
  await fx.publish(auxiliary, 4);
  await app.command({type: 'refresh_post', id: fx.postId});
  const invalid = await indexed(auxiliary);
  assert.match(invalid.entries[0].error, /SHA-1 mismatch/);
  assert.equal(invalid.entries[1].kind, 'file');
  assert(!(await app.api()).transfers.some(t => t.id === fx.content.id));
  pass(
      'absent publisher remains explicit; auxiliary corruption blocks one item without blocking other branches');
  await fx.publish(auxiliary, 99, Buffer.from('incompatible signed value'));
  await app.command({type: 'refresh_post', id: fx.postId});
  await wait(async () => (await post()).sequence === '99', 'incompatible highwater');
  assert.equal((await post()).available, auxiliary.id);
  assert.match((await post()).error, /Unsupported/);
  await app.stop();
  app = await startApp(join(root, 'app'), args);
  await indexed(auxiliary);
  assert.equal((await post()).sequence, '99');
  await app.deletePost('followed',fx.postId);
  assert.equal((await app.api()).posts.length, 0);
  await wait(async()=>!(await app.api()).cleanup.length,'post cleanup');
  assert.equal((await app.api()).transfers.length,0);
  pass(
      'incompatible signed highwater is durable; readable catalog retained; Delete post collects its exclusively owned downloads');
  const state = join(root, 'app/state/feeds.json');
  await writeFile(state, 'corrupt current');
  await app.stop();
  app = await startApp(join(root, 'app'), args);
  await wait(async () => (await app.api()).ready, 'restore');
  assert.match((await app.api()).post_error, /recovered previous checkpoint/);
  assert.equal(
      (await app.api()).posts.length, 0,
      'checkpoint recovery must preserve the completed Unfollow');
  pass('corrupt checkpoint recovers verified previous state and reports recovery');
  report.status = 'pass';
} catch (e) {
  report.status = 'fail';
  report.error = e.stack;
  if (app) {
    try {
      report.snapshot = await app.api();
      report.logs = app.logs;
    } catch {
    }
  }
  console.error(e);
  process.exitCode = 1;
} finally {
  if (app) await app.stop();
  if (fx) await fx.stop();
  await mkdir(evidencePath(), {recursive: true});
  await writeFile(evidencePath("posts.json"), JSON.stringify(report, null, 2) + '\n');
  await cleanup(root);
}

// Keep the independent author-offline renewal regression in the native suite.
if (!process.exitCode) await import('./post-renewal.mjs');
