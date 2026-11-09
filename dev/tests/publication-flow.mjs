// Protocol/persistence coverage formerly repeated by every browser.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicKey,verify} from 'node:crypto';
import DHT from 'bittorrent-dht';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';
import {evidencePath} from './runtime.mjs';
export async function publicationFlow(){
 const root=await temporary(),nodes=[],report={checks:[]};let app,reader,rejectPuts=true;
 const pass=s=>{report.checks.push(s);console.log('PASS',s)},password='publication flow test password';
 try{
  for(let i=0;i<6;i++){
   const n=new DHT({bootstrap:false,host:'127.0.0.1',verify:(sig,msg,key)=>{try{return verify(null,msg,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]),format:'der',type:'spki'}),sig)}catch{return false}}});
   n.on('error',()=>{});const get=n._onget.bind(n),put=n._onput.bind(n);
   n._onget=(q,p)=>rejectPuts?n._rpc.response(p,q,{id:n.nodeId}):get(q,p);
   n._onput=(q,p)=>rejectPuts?n._rpc.error(p,q,[203,'test write unavailable']):put(q,p);
   await new Promise(r=>n.listen(0,'127.0.0.1',r));nodes.push(n);
  }
  for(const a of nodes)for(const b of nodes)if(a!==b)a.addNode({host:'127.0.0.1',port:b.address().port});
  await wait(()=>nodes.every(n=>n.nodes.toArray().length>=5),'publication flow routing');
  const args=['--dht-bootstrap',`127.0.0.1:${nodes[0].address().port}`];
  app=await startApp(join(root,'publisher'),args);const pub=body=>app.api('/api/publishing',body);
  await pub({action:'create_key',password,confirmation:password});const {id}=await pub({action:'create_post',title:'Publication flow'});
  let {draft,revision}=await pub({action:'get_post',id});draft.pages[0].body='This snapshot is published.';
  revision=(await pub({action:'save_draft',id,revision,draft})).revision;
  const own=async()=> (await app.api()).publishing.posts.find(p=>p.id===id);
  const saved=async()=>JSON.parse(await readFile(join(root,'publisher/state/publishing.json'),'utf8')).posts[id];
  await pub({action:'publish',id,revision,password});
  await wait(async()=>{const f=await own();return f?.pending_sequence==='0'&&f.next_retry_at!==null},'signed zero without acknowledgement',90000);
  const before=await saved(),operation=before.pending.id,preparedAt=before.pending.prepared_at;
  assert.deepEqual(before.pending.signed,before.record);assert(!JSON.stringify(before).includes(password));assert.equal(before.published_sequence,undefined);
  draft.pages[0].body='Edits remain unpublished.';revision=(await pub({action:'save_draft',id,revision,draft})).revision;
  rejectPuts=false;await pub({action:'retry_publication',id,operation});
  await wait(async()=> (await own()).state==='Published','retry acknowledges signed snapshot',90000);
  const after=await saved();assert.deepEqual(after.record,before.record);assert.equal(after.published_revision,before.pending.revision);assert(after.revision>after.published_revision);assert.equal(after.pending,null);assert.equal(after.published_sequence,0);
  const publishedDates=(await pub({action:'get_post',id})).published_dates;
  assert.deepEqual(publishedDates['1'],{created_at:preparedAt,updated_at:preparedAt});
  pass('zero requires ACK; signed snapshot, operation, secret-free persistence and retry signature survive a later draft edit');
  rejectPuts=true;await pub({action:'publish',id,revision,password});
  await wait(async()=>{const f=await own();return f.pending_sequence==='1'&&f.next_retry_at!==null},'new pending signature',90000);
  assert.equal((await own()).published_sequence,'0');assert.deepEqual((await pub({action:'get_post',id})).published_dates,publishedDates);
  rejectPuts=false;await pub({action:'retry_publication',id,operation:(await own()).operation});
  await wait(async()=> (await own()).published_sequence==='1','next confirmed version',90000);
  assert.equal((await pub({action:'get_post',id})).published_dates['1'].created_at,preparedAt);
  reader=await startApp(join(root,'reader'),args);const magnet=(await own()).magnet;
  await reader.command({type:'follow_post',uri:magnet,config:{name:'Publication flow reader',mode:'current_catalog',automatic_limit:8388608}});
  const catalog=await wait(async()=> (await reader.api()).posts[0]?.catalogs.find(c=>c.ready),'independent native reader catalog',90000);
  const read=await reader.command({type:'catalog_page',post:id,catalog:catalog.id,offset:0});assert.equal(read.created_at,preparedAt);assert.equal(typeof read.updated_at,'number');
  pass('confirmed dates remain unchanged while another signature is pending; independent follower verifies the published dates');
  await reader.stop();reader=null; // It must not acknowledge the deliberately rejected next publication.
  const transfers=(await app.api()).transfers.map(t=>t.id).sort();draft.pages[0].body='Must not be seeded with an incorrect password.';
  revision=(await pub({action:'save_draft',id,revision,draft})).revision;await pub({action:'publish',id,revision,password:'incorrect password'});
  await wait(async()=> (await own()).state==='Error','incorrect password background failure');assert.match((await own()).error,/password/i);assert.deepEqual((await app.api()).transfers.map(t=>t.id).sort(),transfers);
  draft.pages[0].entries.push({kind:'page',page:2});draft.pages.push({id:2,title:'Nested',body:'Nested content',entries:[]});revision=(await pub({action:'save_draft',id,revision,draft})).revision;
  rejectPuts=true;await pub({action:'publish',id,revision,password});
  await wait(async()=>{const f=await own();return f.pending_sequence==='2'&&f.next_retry_at!==null},'nested signed operation',90000);
  const signed=await saved();await pub({action:'cancel_publication',id,operation:signed.pending.id});
  const canceled=await wait(async()=>{const f=await own();return f?.state==='Canceled'&&f},'cancellation snapshot');assert.equal(canceled.state,'Canceled');assert.equal(canceled.operation,null);assert.equal(canceled.sequence,'2');assert.equal(canceled.published_sequence,'1');assert.equal(canceled.pending_sequence,null);
  assert.equal((await pub({action:'get_post',id})).draft.pages[1].body,'Nested content');
  await assert.rejects(()=>pub({action:'cancel_publication',id,operation}),/operation|current|pending|publication/i);assert((await app.api()).transfers.every(t=>t.active));
  await app.stop();app=await startApp(join(root,'publisher'),args);
  await wait(async()=> (await own())?.state==='Canceled','canceled publication after restart');assert.equal((await own()).published_sequence,'1');assert.equal((await saved()).record.sequence,2);
  pass('wrong password seeds nothing; nested cancellation fences stale callbacks, keeps downloads active and preserves signed/confirmed sequences after restart');
  report.status='pass';
 }finally{
  if(reader)await reader.stop();await cleanup(root,app);await Promise.all(nodes.map(n=>new Promise(r=>n.destroy(r))));
  await writeFile(evidencePath('publication-flow.json'),JSON.stringify(report,null,2)+'\n');
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await publicationFlow();
