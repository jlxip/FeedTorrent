// Real isolated native transfers and durable retention; never uses the user's data.
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat,access} from 'node:fs/promises';
import {join} from 'node:path';
import {temporary,startApp,cleanup,seed,tracker,wait,hash} from './helpers.mjs';
const root=await temporary();let app,tr,ref,other;
const password='retention fixture password';
try{
 tr=await tracker();ref=await seed(join(root,'source-a'),[4097],{tracker:true,announce:[tr.http]});other=await seed(join(root,'source-b'),[8003],{tracker:true,announce:[tr.http]});
 const appRoot=join(root,'app');app=await startApp(appRoot);
 const pub=c=>app.api('/api/publishing',c),command=c=>app.command(c);
 const snapshot=()=>app.api();
 const create=async title=>(await pub({action:'create_post',title})).id;
 const attach=async(id,source=ref)=>{const p=await pub({action:'get_post',id});p.draft.pages[0].entries.push({kind:'torrent',name:'payload.torrent',data:source.bytes});await pub({action:'save_draft',id,revision:p.revision,draft:p.draft});};
 const download=async(id,source=ref)=>{await command({type:'add_torrent',data:source.bytes,origin:{kind:'own',id}});await wait(async()=>{const t=(await snapshot()).transfers.find(t=>t.id===source.id);return t&&t.progress===1&&t.files.every(f=>f.ready);},'verified transfer',20000);return (await snapshot()).transfers.find(t=>t.id===source.id);};
 const preview=target=>command({type:'preview_removal',target});
 const removePost=async id=>{const p=await preview({kind:'post',post_kind:'own',id});return command({type:'delete_post',post_kind:'own',id,revision:p.revision});};
 const idle=()=>wait(async()=>(await snapshot()).cleanup.length===0,'cleanup finished',15000);
 const exists=async p=>{try{await access(p);return true;}catch{return false;}};
 await pub({action:'create_key',password,confirmation:password});
 const vault=JSON.parse(await readFile(join(appRoot,'state/publishing/library.json'),'utf8')).vault;
 const a=await create('A'),b=await create('B');await attach(a);const t=await download(a);
 assert.equal(t.pinned,false);assert.deepEqual(t.used_by,['own:'+a]);const payload=t.save_path;
 const stale=await preview({kind:'post',post_kind:'own',id:a});assert.deepEqual(stale.deleting,[ref.id]);
 await attach(b);await assert.rejects(command({type:'delete_post',post_kind:'own',id:a,revision:stale.revision}),/References changed/);
 await assert.rejects(command({type:'unfollow_feed',id:a}),/Reload/);
 await assert.rejects(pub({action:'remove_feed',id:a}),/reload/i);await assert.rejects(pub({action:'remove_post',id:a}),/reload/i);
 await assert.rejects(command({type:'remove',id:ref.id,delete_files:true}),/Reload|review/i);
 const shared=await preview({kind:'post',post_kind:'own',id:a});assert.equal(shared.deleting.length,0);assert.deepEqual(shared.shared,[ref.id]);
 await removePost(a);await idle();assert(await exists(payload));assert((await snapshot()).transfers.some(t=>t.id===ref.id));
 await command({type:'set_pin',id:ref.id,pinned:true});await assert.rejects(preview({kind:'torrent',id:ref.id,delete_files:true}),/Pin/);
 const protectedPreview=await preview({kind:'post',post_kind:'own',id:b});assert.deepEqual(protectedPreview.protected,[ref.id]);await removePost(b);await idle();
 const unpin=await preview({kind:'unpin',id:ref.id});assert.deepEqual(unpin.deleting,[ref.id]);assert(await exists(payload));
 await command({type:'set_pin',id:ref.id,pinned:true});await command({type:'set_pin',id:ref.id,pinned:false,revision:unpin.revision});await idle();
 assert.equal(await exists(payload),false);assert.equal((await snapshot()).transfers.length,0);assert.equal(await exists(join(appRoot,'state',ref.id+'.source')),false);
 console.log('PASS shared references, stale confirmation, obsolete mutations rejected, Pin guard, Unpin and physical cleanup');
 // Collection must not suppress a future legitimate download of the same hash.
 const d=await create('D');await attach(d);await download(d);await command({type:'pause',id:ref.id});
 await command({type:'add_torrent',data:ref.bytes});const reopened=(await snapshot()).transfers.find(t=>t.id===ref.id);
 assert.equal(reopened.pinned,true);assert.equal(reopened.active,false);assert.equal((await snapshot()).transfers.length,1);
 await removePost(d);await idle();const u=await preview({kind:'unpin',id:ref.id});await command({type:'set_pin',id:ref.id,pinned:false,revision:u.revision});await idle();
 console.log('PASS collection permits future downloads; Open existing pins without duplication or resume');
 const e=await create('E');await attach(e);const failedTransfer=await download(e);
 const before=await preview({kind:'post',post_kind:'own',id:e});const stateDir=join(appRoot,'state'),stateMode=(await stat(stateDir)).mode&0o777;
 await chmod(stateDir,0o500);
 try{await assert.rejects(command({type:'delete_post',post_kind:'own',id:e,revision:before.revision}));}finally{await chmod(stateDir,stateMode);}
 assert((await snapshot()).publishing.posts.some(p=>p.id===e));assert(await exists(failedTransfer.save_path));
 const blocked=join(failedTransfer.save_path,'source'),mode=(await stat(blocked)).mode&0o777;
 await chmod(blocked,0o500);let job;
 try{
  await removePost(e);await wait(async()=>{job=(await snapshot()).cleanup.find(j=>j.error);return job;},'visible failed cleanup',10000);
  assert.equal((await snapshot()).publishing.posts.some(p=>p.id===e),false);assert(await exists(join(blocked,'file-0.bin')));
  await app.stop();app=await startApp(appRoot);await wait(async()=>{job=(await snapshot()).cleanup.find(j=>j.error);return job;},'recovered pending cleanup');assert.equal((await snapshot()).publishing.posts.some(p=>p.id===e),false);assert(await exists(join(blocked,'file-0.bin')));
 }finally{await chmod(blocked,mode);}
 await command({type:'retry_cleanup',id:job.id});await idle();assert.equal(await exists(failedTransfer.save_path),false);
 console.log('PASS failed intent preserves post/files; committed file-deletion failure is visible and retryable');
 const f=await create('F'),g=await create('G');await attach(f);const rescued=await download(f);const blockedAgain=join(rescued.save_path,'source'),againMode=(await stat(blockedAgain)).mode&0o777;
 await chmod(blockedAgain,0o500);
 try{await removePost(f);await wait(async()=>{job=(await snapshot()).cleanup.find(j=>j.error);return job;},'pending collection',10000);}finally{await chmod(blockedAgain,againMode);}
 await attach(g);await command({type:'retry_cleanup',id:job.id});await idle();assert(await exists(join(blockedAgain,'file-0.bin')));
 await command({type:'resume',id:ref.id});await wait(async()=>{const t=(await snapshot()).transfers.find(t=>t.id===ref.id);return t?.files.every(f=>f.ready);},'rescued transfer recheck',15000);
 await removePost(g);await idle();
 console.log('PASS a new reference rescues pending cleanup and the retained copy can resume');
 const canceled=await create('Canceled publisher');const c=await pub({action:'get_post',id:canceled});
 await pub({action:'publish',id:canceled,revision:c.revision,password});await removePost(canceled);await idle();
 await new Promise(r=>setTimeout(r,400));assert.equal((await snapshot()).publishing.posts.some(p=>p.id===canceled),false);
 const packages=await (await import('node:fs/promises')).readdir(join(appRoot,'state/publishing/catalogs')).catch(()=>[]);assert.equal(packages.length,0);
 console.log('PASS removal fences in-flight publication; restart resumes retired-post cleanup without restoring its post');
 const h=await create('H');await attach(h);await download(h);await command({type:'add_torrent',data:other.bytes});await wait(async()=>(await snapshot()).transfers.some(t=>t.id===other.id&&t.progress===1),'manual download',20000);
 await app.stop();const registry=join(appRoot,'state/transfers.json'),library=join(appRoot,'state/publishing/library.json');
 const legacy=JSON.parse(await readFile(registry,'utf8'));legacy.version=3;delete legacy.retention;for(const r of legacy.records){r.feed=r.post;delete r.post;}await writeFile(registry,JSON.stringify(legacy));
 const oldOwn=JSON.parse(await readFile(library,'utf8'));oldOwn.feeds=oldOwn.posts;delete oldOwn.posts;await writeFile(library,JSON.stringify(oldOwn));
 const cpPath=join(appRoot,'state/feeds.json'),cp=JSON.parse(await readFile(cpPath,'utf8'));cp.feeds=cp.posts;delete cp.posts;await writeFile(cpPath,JSON.stringify(cp));await writeFile(join(appRoot,'state/feeds.previous.json'),JSON.stringify(cp));
 app=await startApp(appRoot);await wait(async()=>(await snapshot()).ready,'migrated startup');const migrated=await snapshot();
 assert.equal(migrated.transfers.length,2);assert.equal(migrated.transfers.find(t=>t.id===ref.id).pinned,false);assert.equal(migrated.transfers.find(t=>t.id===other.id).pinned,true);
 assert.equal(migrated.cleanup.length,0);const saved=JSON.parse(await readFile(registry,'utf8'));assert.equal(saved.version,4);assert.equal(saved.retention.initialized,true);
 assert.deepEqual(JSON.parse(await readFile(library,'utf8')).vault,vault);
 assert.equal(hash(await readFile(join(root,'source-a/source/file-0.bin'))),hash(ref.originals[0]));
 console.log('PASS legacy registry/post fields migrate without deletion; known ownership and ambiguous/manual Pin survive restart; key and source originals preserved');
}finally{await cleanup(root,tr,ref,other,app);}
