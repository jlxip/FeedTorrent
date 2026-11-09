// Manual root copies restore transfers without the central registry or private key.
import assert from 'node:assert/strict';
import {cp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {temporary, startApp, seed, tracker, wait, cleanup, hash} from './helpers.mjs';

const root = await temporary();
let app, source, tr;
try {
  tr = await tracker();
  source = await seed(join(root, 'source'), [4096], {tracker:true, announce:[tr.http]});
  const original = join(root, 'original');
  app = await startApp(original);
  await app.command({type:'add_torrent', data:source.bytes});
  await wait(async()=> (await app.api()).transfers.some(t=>t.id===source.id&&t.progress===1), 'complete original torrent');
  const originalTransfer = (await app.api()).transfers[0];
  const payloadHash = hash(await readFile(join(originalTransfer.save_path, originalTransfer.files[0].name)));
  await app.stop(); app = undefined;
  const downloadRoot = join(original, 'downloads');
  await stat(join(downloadRoot, source.id+'.source'));
  await stat(join(downloadRoot, source.id+'.transfer.json'));

  const restoredDownload = join(root, 'download-copy');
  await cp(downloadRoot, join(restoredDownload, 'downloads'), {recursive:true});
  app = await startApp(restoredDownload);
  await wait(async()=> (await app.api()).transfers.some(t=>t.id===source.id&&t.progress===1), 'download root restore');
  assert.equal((await app.api()).transfers[0].pinned, true);
  assert.equal(hash(await readFile(join((await app.api()).transfers[0].save_path, originalTransfer.files[0].name))), payloadHash);
  await app.stop(); app = undefined;
  console.log('PASS downloads root restores transfer and exact payload without transfers.json');

  const restoredPublished = join(root, 'published-copy');
  await mkdir(join(restoredPublished, 'state'), {recursive:true});
  await cp(downloadRoot, join(restoredPublished, 'state/published'), {recursive:true});
  const publishedManifest = join(restoredPublished, 'state/published', source.id+'.transfer.json');
  const owned = JSON.parse(await readFile(publishedManifest));
  owned.kind = 'owned_catalog'; owned.pinned = false;
  await writeFile(publishedManifest, JSON.stringify(owned));
  app = await startApp(restoredPublished);
  await wait(async()=> (await app.api()).transfers.some(t=>t.id===source.id&&t.progress===1), 'published root restore');
  assert.equal((await app.api()).transfers[0].pinned, false);
  assert.equal((await app.api()).publishing.has_key, false);
  assert.equal(hash(await readFile(join((await app.api()).transfers[0].save_path, originalTransfer.files[0].name))), payloadHash);
  await app.command({type:'set_pin',id:source.id,pinned:true});
  assert.equal(JSON.parse(await readFile(publishedManifest)).pinned, true);
  await app.stop(); app = undefined;
  console.log('PASS published root restores and shares exact payload without publishing.json');

  const incomplete = join(root, 'incomplete');
  await cp(downloadRoot, join(incomplete, 'downloads'), {recursive:true});
  await rm(join(incomplete, 'downloads', source.id+'.source'));
  app = await startApp(incomplete);
  assert.equal((await app.api()).transfers.length, 0);
  assert.match((await app.api()).warning, /Incomplete transfer backup/);
  await stat(join(incomplete, 'downloads', source.id));
  await app.stop(); app = undefined;

  const duplicate = join(root, 'duplicate');
  await mkdir(join(duplicate, 'state'), {recursive:true});
  await cp(downloadRoot, join(duplicate, 'downloads'), {recursive:true});
  await cp(downloadRoot, join(duplicate, 'state/published'), {recursive:true});
  app = await startApp(duplicate);
  assert.equal((await app.api()).transfers.length, 0);
  assert.match((await app.api()).warning, /both roots/);
  await stat(join(duplicate, 'downloads', source.id));
  await stat(join(duplicate, 'state/published', source.id));
  await app.stop(); app = undefined;
  console.log('PASS incomplete and conflicting backups remain intact with visible errors');
} finally {
  await cleanup(root, app, source, tr);
}
