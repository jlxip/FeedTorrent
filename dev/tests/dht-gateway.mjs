import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,rmdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {temporary,cleanup,startApp,wait} from './helpers.mjs';
import {fixture,freePort,reserve} from './dht-gateway-fixture.mjs';
import {evidencePath} from './runtime.mjs';
const root=await temporary(),report={checks:[],status:'running'};let f,app,occupied,registryFault=false;
const pass=name=>{report.checks.push(name);console.log('PASS',name)};
async function read(path,options){const r=await fetch(f.url+path,options);assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.equal(r.headers.get('cache-control'),'no-store');assert(!r.headers.has('set-cookie'));return r}
try{
 f=await fixture(root);app=f.app;
 const before=await app.api();assert.deepEqual(before.transfers,[]);assert(before.dht_gateway.running);
 const immutable='/dht/immutable/'+f.target;
 const mutable='/dht/mutable/'+f.mutable.key+'?salt='+f.mutable.salt;
 const first=await read(immutable);assert.equal(first.status,200);assert.deepEqual(await first.json(),{target:f.target,value:f.value});
 const results=await Promise.all(Array.from({length:12},()=>read(mutable)));
 for(const r of results){assert.equal(r.status,200);assert.deepEqual(await r.json(),f.mutable)}
 pass('independent DHT immutable and signed compound/binary mutable reads; concurrent identical clients');
 const updated=await f.publish(5,Buffer.from('updated'));
 const update=await read(mutable);assert.equal(update.status,200);assert.deepEqual(await update.json(),updated);
 const high=await f.publish(9007199254740994,Buffer.from('above JavaScript safe integer'));
 const highRead=await read(mutable);assert.equal(highRead.status,200);assert.deepEqual(await highRead.json(),high);assert.equal(high.sequence,'9007199254740994');
 const streams=await Promise.all(Array.from({length:6},()=>read(mutable,{headers:{Accept:'text/event-stream, application/json'}})));
 for(const response of streams){
  assert(response.headers.get('content-type').startsWith('text/event-stream'));assert.equal(response.headers.get('x-accel-buffering'),'no');
  const text=await response.text(),frames=text.split('\n\n').filter(f=>f.includes('event: done'));
  assert.equal(frames.length,1);const done=JSON.parse(frames[0].split('\n').find(l=>l.startsWith('data:')).slice(5));assert.equal(done.error,null);assert.deepEqual(done.record,high);
 }
 pass('opt-in SSE sends one explicit final signed result and keeps legacy JSON/CORS binary contracts');
 assert.equal((await read(immutable,{method:'HEAD'})).status,200);
 const preflight=await read(immutable,{method:'OPTIONS',headers:{Origin:'https://consumer.test','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'content-type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-headers'),'*');
 for(const method of ['POST','PUT','DELETE'])assert.equal((await read(immutable,{method})).status,405);
 for(const path of ['/api/snapshot','/api/commands','/api/publishing/backup','/','/index.html'])assert.equal((await read(path)).status,404);
 for(const path of ['/dht/immutable/abc','/dht/immutable/'+'zz'.repeat(20),'/dht/mutable/'+f.mutable.key+'?salt=0','/dht/mutable/'+f.mutable.key+'?salt='+'ff'.repeat(65),'/dht/mutable/'+'00'.repeat(32),mutable+'&salt=00'])assert.equal((await read(path)).status,400);
 assert.equal((await read('/dht/immutable/'+'ab'.repeat(20))).status,404);
 assert.equal((await app.api()).transfers.length,0);
 pass('fresh mutable update, HEAD/preflight, CORS errors, malformed input, absence and private API isolation');
 const previous=(await app.api()).settings,newPort=await freePort();occupied=await reserve(newPort);
 await assert.rejects(()=>app.command({type:'configure',settings:{...previous,dht_gateway:{enabled:true,listen:'127.0.0.1:'+newPort}}}),/Cannot open DHT gateway/);
 assert.deepEqual((await app.api()).settings,previous);assert.equal((await read(immutable)).status,200);await occupied.stop();occupied=null;
 const registry=join(root,'state/transfers.json'),backup=registry+'.before-gateway-fault';await rename(registry,backup);await mkdir(registry);registryFault=true;
 await assert.rejects(()=>app.command({type:'configure',settings:{...previous,dht_gateway:{enabled:true,listen:'127.0.0.1:'+newPort}}}),/Cannot save transfer registry/);
 assert.deepEqual((await app.api()).settings,previous);assert.equal((await read(immutable)).status,200);
 const free=await reserve(newPort);await free.stop();await rmdir(registry);await rename(backup,registry);registryFault=false;
 pass('occupied port and persistence failure preserve the old listener/settings and release prepared descriptors');
 await app.command({type:'configure',settings:{...previous,dht_gateway:{enabled:true,listen:'127.0.0.1:'+newPort}}});
 await wait(async()=>{try{const s=await reserve(Number(new URL(f.url).port));await s.stop();return true}catch{return false}},'old gateway closed');
 f.url='http://127.0.0.1:'+newPort;assert.equal((await read(immutable)).status,200);
 await app.stop();occupied=await reserve(newPort);app=await startApp(root,f.args);
 assert.equal((await app.api()).ready,true);assert.equal((await app.api()).dht_gateway.running,false);assert.match((await app.api()).dht_gateway.error,/Cannot open/);
 await occupied.stop();occupied=null;await app.command({type:'configure',settings:(await app.api()).settings});assert((await app.api()).dht_gateway.running);
 await app.stop();app=await startApp(root,f.args);assert((await app.api()).dht_gateway.running);assert.equal((await read(immutable)).status,200);
 await app.command({type:'configure',settings:{...(await app.api()).settings,dht_gateway:{enabled:false,listen:'127.0.0.1:'+newPort}}});
 await wait(async()=>{try{const s=await reserve(newPort);await s.stop();return true}catch{return false}},'disabled listener closed');
 assert.equal((await app.api()).dht_gateway.running,false);
 const saved=JSON.parse(await readFile(join(root,'state/transfers.json'),'utf8'));assert.equal(saved.settings.dht_gateway.enabled,false);assert.equal(saved.records.length,0);
 pass('hot rebinding, failed startup isolation, retry, persisted restart and disable leave application/data intact');
 await app.command({type:'configure',settings:{...(await app.api()).settings,dht_gateway:{enabled:true,listen:'127.0.0.1:'+newPort}}});
 const password='isolated gateway publication';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
 const {id}=await app.api('/api/publishing',{action:'create_post',title:'Gateway coexistence'});
 const {draft,revision}=await app.api('/api/publishing',{action:'get_post',id});draft.pages[0].body='Independent public reads do not consume publication events.';
 const savedDraft=await app.api('/api/publishing',{action:'save_draft',id,revision,draft});
 await app.api('/api/publishing',{action:'publish',id,revision:savedDraft.revision,password});
 const own=await wait(async()=>{
  assert.equal((await read(immutable)).status,200);
  const post=(await app.api()).publishing.posts.find(p=>p.id===id);if(post?.error)throw Error(post.error);return post?.state==='Published'&&post;
 },'publishing beside public DHT reads',90000);
 const magnet=new URL(own.magnet),key=magnet.searchParams.get('xs').slice('urn:btpk:'.length),salt=magnet.searchParams.get('s')||'';
 const published=await read('/dht/mutable/'+key+'?salt='+salt);assert.equal(published.status,200);assert.equal((await published.json()).sequence,'0');
 pass('signed publication completes and its record remains readable while public lookups share the native actor');
 // Hold two DHT responders behind a barrier. One authentic reply can be
 // observed early, but the followed post's native traversal cannot complete.
 const target=createHash('sha1').update(Buffer.from(key,'hex')).update(Buffer.from(salt,'hex')).digest();
 const held=[],restores=[];let released=false,reader,text='';
 for(const node of f.network.nodes.slice(1)){
  const original=node._rpc.response;
  node._rpc.response=function(peer,query,...args){
   if(!released&&query.q?.toString()==='get'&&Buffer.from(query.a?.target||[]).equals(target)){
    held.push(()=>original.call(this,peer,query,...args));return;
   }
   return original.call(this,peer,query,...args);
  };
  restores.push(()=>{node._rpc.response=original;});
 }
 const release=()=>{released=true;for(const restore of restores)restore();for(const send of held)send();};
 try{
  await app.command({type:'follow_post',uri:own.magnet,config:{name:'Shared native observation',mode:'current_catalog',automatic_limit:8388608}});
  const stream=await read('/dht/mutable/'+key+'?salt='+salt,{headers:{Accept:'text/event-stream'},signal:AbortSignal.timeout(30000)});
  reader=stream.body.getReader();const decoder=new TextDecoder();
  while(!text.includes('event: record')){const part=await reader.read();assert(!part.done,'stream ended before a shared record');text+=decoder.decode(part.value,{stream:true});}
  assert(held.length>0,'barrier did not hold the owning traversal');
  const followed=(await app.api()).posts.find(post=>post.magnet===own.magnet);
  assert(followed);assert.equal(followed.last_checked_ms,null,'shared observation waited for the owner to finish');
  release();
  for(;;){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});}
  const finals=text.split('\n\n').filter(frame=>frame.includes('event: done'));assert.equal(finals.length,1);
  const final=JSON.parse(finals[0].split('\n').find(line=>line.startsWith('data:')).slice(5));assert.equal(final.error,null);assert.equal(final.record.sequence,'0');
  await wait(async()=>{const snapshot=await app.api();assert.equal(snapshot.publishing.posts.find(post=>post.id===id).state,'Published');return snapshot.posts.find(post=>post.magnet===own.magnet)?.last_checked_ms!==null},'owning post receives its terminal result');
  pass('shared signed SSE precedes a barrier-held internal lookup; final JSON and owner publication remain intact');
 }finally{release();await reader?.cancel().catch(()=>{});reader?.releaseLock();}
 report.status='pass';
}catch(error){report.status='fail';report.error=String(error);if(app)console.error('Gateway diagnostics',JSON.stringify(await app.api()),app.logs);throw error}
finally{
 if(registryFault){await rmdir(join(root,'state/transfers.json'));await rename(join(root,'state/transfers.json.before-gateway-fault'),join(root,'state/transfers.json'));}
 await occupied?.stop();await app?.stop();await f?.network.stop();await cleanup(root);await writeFile(evidencePath('dht-gateway.json'),JSON.stringify(report,null,2)+'\n');
}
