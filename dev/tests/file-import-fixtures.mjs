import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,mkdir,stat,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import bencode from 'bencode';
import {startApp,temporary,cleanup,wait} from './helpers.mjs';
export async function checkFileImports() {
 const root=await temporary();let app,restored;
 const raw=async(path,method='POST',body)=>{
  const r=await fetch(app.url+'/api/file-imports'+path,{method,headers:{Origin:app.url,Cookie:app.cookie,...(body instanceof Uint8Array?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)});
  const value=await r.json();if(!r.ok)throw Error(value.error||String(r.status));return value;
 };
 const get=id=>app.api('/api/creation',{action:'get_draft',id});
 const save=(d,post=d.post)=>app.api('/api/creation',{action:'save_draft',id:d.id,revision:d.revision,post,copy_files:true,draft:d.draft});
 const begin=(d,files)=>raw('','POST',{owner:{kind:'creation',id:d.id},page:1,revision:d.revision,files:files.map(([path,bytes])=>({path,size:bytes.length}))});
 const upload=async(d,files)=>{const batch=await begin(d,files);for(let i=0;i<files.length;i++)await raw(`/${batch.id}/${i}`,'PUT',files[i][1]);return {batch,...await raw('/'+batch.id+'/commit')};};
 try {
  app=await startApp(join(root,'app'));let d=await app.api('/api/creation',{action:'create_draft'});d.draft.pages[0].title='Originals';d=await save(d,false);
  const data=Buffer.from('abc'),meta=Buffer.from(bencode.encode({info:{name:'payload.txt',length:3,'piece length':16384,pieces:createHash('sha1').update(data).digest()}}));
  const files=[[['folder','nested','valid.TORRENT'],meta],[['folder','note.txt'],data],[['bad.torrent'],Buffer.from('not metainfo')]];
  const first=await upload(d,files);d=await get(d.id);assert.equal(d.revision,first.revision);assert(d.draft.pages[0].entries.every(e=>e.kind==='files'));
  const previous=structuredClone(d);await assert.rejects(()=>save(d,true),/Invalid .torrent/);assert.deepEqual(await get(d.id),previous);
  d.draft.pages[0].entries=d.draft.pages[0].entries.filter(e=>e.name!=='bad.torrent');d=await save(d,true);
  const torrent=d.draft.pages[0].entries.find(e=>e.kind==='torrent');assert.deepEqual(torrent.original.path,['folder','nested','valid.TORRENT']);assert.deepEqual(Buffer.from(torrent.data),meta);assert.deepEqual(await readFile(torrent.original.source),meta);
  await app.stop();app=await startApp(join(root,'app'));d=await get(d.id);assert.deepEqual(d.draft.pages[0].entries.find(e=>e.kind==='torrent').original.path,torrent.original.path);
  await assert.rejects(()=>upload(d,[[['folder','note.txt'],data]]),/already selected/);
  await assert.rejects(()=>begin(d,[[['dup'],data],[['dup'],data]]),/duplicate/);
  await assert.rejects(()=>begin(d,[[['..','escape'],data]]),/Invalid/);
  const short=await begin(d,[[['short'],data]]);await assert.rejects(()=>raw('/'+short.id+'/0','PUT',Buffer.from('ab')),/Incomplete/);await assert.rejects(()=>raw('/'+short.id+'/commit'),/missing/);await raw('/'+short.id,'DELETE');
  const conflict=await begin(d,[[['conflict'],data]]);await raw('/'+conflict.id+'/0','PUT',data);d.draft.pages[0].body='Concurrent edit';d=await save(d);const baseline=structuredClone(d);await assert.rejects(()=>raw('/'+conflict.id+'/commit'),/changed/);assert.deepEqual(await get(d.id),baseline);await raw('/'+conflict.id,'DELETE');
  const fault=await begin(d,[[['disk-fault'],data]]);await raw('/'+fault.id+'/0','PUT',data);await rename(join(root,'app','state','creation.json'),join(root,'app','state','creation-prior.json'));await mkdir(join(root,'app','state','creation.json'));
  await assert.rejects(()=>raw('/'+fault.id+'/commit'));await rm(join(root,'app','state','creation.json'),{recursive:true});await rename(join(root,'app','state','creation-prior.json'),join(root,'app','state','creation.json'));assert.deepEqual(await get(d.id),baseline);await raw('/'+fault.id,'DELETE');
  const canceled=await begin(d,[[['cancel'],data]]);await raw('/'+canceled.id+'/0','PUT',data);await raw('/'+canceled.id,'DELETE');await assert.rejects(()=>raw('/'+canceled.id+'/commit'),/expired|cancelled/);assert.deepEqual(await get(d.id),baseline);
  const limit=await begin(d,[[['large.torrent'],Buffer.alloc(8*1024*1024+1)]]);await raw('/'+limit.id+'/0','PUT',Buffer.alloc(8*1024*1024+1));await assert.rejects(()=>raw('/'+limit.id+'/commit'),/8 MiB/);assert.deepEqual(await get(d.id),baseline);await raw('/'+limit.id,'DELETE');
  const unfinished=await begin(d,[[['interrupted'],data]]);await raw('/'+unfinished.id+'/0','PUT',data);const unfinishedPath=join(root,'app','state','publishing-assets','import-'+unfinished.id);await stat(unfinishedPath);
  await app.stop();app=await startApp(join(root,'app'));await assert.rejects(()=>stat(unfinishedPath),/ENOENT/);assert.deepEqual(await get(d.id),baseline);
  const padded=Buffer.from(bencode.encode({comment:Buffer.alloc(7*1024*1024,65),info:{name:'payload.txt',length:3,'piece length':16384,pieces:createHash('sha1').update(data).digest()}}));
  const aggregate=await begin(d,Array.from({length:5},(_,i)=>[[`large-${i}.torrent`],padded]));for(let i=0;i<5;i++)await raw('/'+aggregate.id+'/'+i,'PUT',padded);
  await assert.rejects(()=>raw('/'+aggregate.id+'/commit'),/32 MiB/);assert.deepEqual(await get(d.id),baseline);await raw('/'+aggregate.id,'DELETE');
  const password='native-import-backup-password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
  const backup=await fetch(app.url+'/api/publishing/backup?full=true',{headers:{Cookie:app.cookie}});assert(backup.ok);const archive=Buffer.from(await backup.arrayBuffer());
  restored=await startApp(join(root,'restored'));const r=await fetch(restored.url+'/api/publishing/import',{method:'POST',headers:{Cookie:restored.cookie,Origin:restored.url,'X-FeedTorrent-Password':Buffer.from(password).toString('hex')},body:archive});assert(r.ok,await r.text());
  const recovered=await restored.api('/api/creation',{action:'get_draft',id:d.id});const original=recovered.draft.pages[0].entries.find(e=>e.kind==='torrent').original;assert.deepEqual(original.path,['folder','nested','valid.TORRENT']);assert.deepEqual(await readFile(original.source),meta);assert(original.source.startsWith(join(root,'restored','state','publishing-assets')));
  await restored.stop();restored=undefined;
  // Raw bodies larger than the JSON limit stay streaming, then durable.
  const large=Buffer.alloc(40*1024*1024,39);const imported=await upload(d,[[['large.bin'],large]]);d=await get(d.id);assert.equal(imported.revision,d.revision);const f=d.draft.pages[0].entries.find(e=>e.name==='large.bin').files[0];assert.equal((await stat(f.source)).size,large.length);
  d=await save(d,false);await app.api('/api/creation',{action:'create_torrent',id:d.id,revision:d.revision});
  const generated=await wait(async()=>{const v=await get(d.id);if(v.error)throw Error(v.error);return v.result&&v;},'regular torrent keeps original metainfo');
  const transfer=await wait(async()=> (await app.api()).transfers.find(t=>t.id===generated.result&&t.state==='Seeding'),'original files seeding');
  const importedPath=transfer.files.find(f=>f.name.endsWith('/folder/nested/valid.TORRENT'));assert(importedPath);assert.deepEqual(await readFile(join(transfer.save_path,importedPath.name)),meta);
  // A manifest from another data directory and an unowned directory are never collected.
  const assets=join(root,'app','state','publishing-assets');await mkdir(join(assets,'unowned'));await writeFile(join(assets,'unowned','keep'),'keep');
  const fake=join(assets,'import-'+'f'.repeat(40));await mkdir(fake);await writeFile(join(fake,'import.json'),JSON.stringify({directory:'/other',committed:false}));
  await app.stop();app=await startApp(join(root,'app'));assert.equal(await readFile(join(assets,'unowned','keep'),'utf8'),'keep');await stat(fake);
  console.log('PASS native file imports: mixed nested files, atomic type conversion, bytes and paths, 40 MiB streaming, duplicates, 8/32 MiB limits, cancellation, disk rollback, revision conflict, backup/restore, restart and ownership-safe cleanup');
 } finally {await cleanup(root,app,restored);}
}
