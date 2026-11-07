import {evidencePath} from './runtime.mjs';
// Real isolated Mainline DHT renewal, with an independent Node publisher/reader.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import bencode from 'bencode';
import {createPublicKey,verify} from 'node:crypto';
import {postFixture,sha1} from './post-fixtures.mjs';
import {valid} from '../fixtures/bep50-node.mjs';
import {temporary,startApp,wait,cleanup,reference,hash} from './helpers.mjs';
const root=await temporary();let app,fx,reader;
const report={time:new Date().toISOString(),checks:[]};
const pass=s=>{report.checks.push(s);console.log('PASS',s)};
try {
 fx=await postFixture(root);
 let accepting=false;const delayed=[];
 for(const node of [...fx.nodes,fx.head.torrent.client.dht]){const put=node._onput;node._onput=function(query,peer){
   if(!accepting && query.a?.k){delayed.push(()=>{if(!this.destroyed)put.call(this,query,peer)});return;}
   return put.call(this,query,peer);
 };}

 const args=['--dht-bootstrap',fx.bootstrap];
 app=await startApp(join(root,'follower'),args);
 await app.command({type:'follow_post',uri:fx.postMagnet,config:{name:'Renewal',mode:'current_catalog',automatic_limit:null}});
 await wait(async()=> (await app.api()).transfers.find(t=>t.id===fx.head.id && t.progress===1),'follower catalog verified');
 const original=fx.nodes.map(n=>n._values.get(fx.postId)).find(Boolean);
 assert(original);assert(valid(original,Buffer.from([1,255])));
 await fx.head.stop(); // No catalog publisher/seed remains available.
 const clear=()=>{for(const n of fx.nodes)n._values.remove(fx.postId);assert(fx.nodes.every(n=>!n._values.get(fx.postId)))};
 const restored=()=>fx.nodes.map(n=>n._values.get(fx.postId)).find(Boolean);
 // Hold initial put replies until the catalog is verified and the publisher is offline.
 clear();accepting=true;for(const deliver of delayed.splice(0))deliver();
 await wait(()=>restored(),'follower replenishes expired DHT record',360000);
 let replenished=restored();
 for(const field of ['k','sig'])assert.deepEqual(Buffer.from(replenished[field]),Buffer.from(original[field]));
 assert.equal(replenished.seq,original.seq);assert.deepEqual(bencode.encode(replenished.v),bencode.encode(original.v));
 pass('author offline: follower restores expired signed record byte-for-byte with binary salt and no private key');
 const snapshot=await app.api();
 await app.command({type:'organize_post',key:'followed:'+fx.postId,revision:snapshot.organization.revision,action:'archive',parent:null,before:null});
 await app.command({type:'pause',id:fx.head.id});
 await app.stop();clear();
 app=await startApp(join(root,'follower'),args);
 await wait(()=>restored(),'restart renews saved signed record while archived and paused',360000);
 const state=await app.api();
 assert(state.organization.nodes.find(n=>n.key==='followed:'+fx.postId).archived);
 assert.equal(state.transfers.find(t=>t.id===fx.head.id).state,'Paused');
 assert.equal(state.transfers.find(t=>t.id===fx.head.id).pinned,false);
 assert.equal(state.posts.find(p=>p.id===fx.postId).mode,'current_catalog');
 assert(!state.publishing.has_key);
 pass('restart uses only persisted public state; Archive/Pause and no Mirror/Pin do not inhibit DHT renewal or resume downloads');
 await app.command({type:'resume',id:fx.head.id});
 await wait(async()=> (await app.api()).transfers.find(t=>t.id===fx.head.id && t.progress===1 && t.state!=='Paused'),'follower seeding');
 reader=await reference({dht:{bootstrap:fx.nodes.map(n=>({host:'127.0.0.1',port:n.address().port}))}});
 await wait(()=>reader.client.dht.nodes.toArray().length>0,'independent reader DHT routing');
 const uri=new URL(fx.postMagnet);
 const publicKey=Buffer.from(uri.searchParams.get('xs').slice('urn:btpk:'.length),'hex');
 const salt=Buffer.from(uri.searchParams.get('s')||'','hex');
 const identity=sha1(Buffer.concat([publicKey,salt]));
 const signed=await new Promise((yes,no)=>reader.client.dht.get(identity,{salt,verify:(sig,msg,pk)=>verify(null,msg,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk]),format:'der',type:'spki'}),sig)},(e,r)=>e?no(e):yes(r)));
 assert(signed);assert(valid(signed,salt));assert.deepEqual(Buffer.from(signed.k),publicKey);
 const id=Buffer.from(signed.v.ih).toString('hex');assert.equal(id,fx.head.id);
 const torrent=reader.client.add('magnet:?xt=urn:btih:'+id,{path:join(root,'fresh-reader')});
 await wait(()=>torrent.infoHash,'independent reader parses magnet');
 await wait(()=>torrent.done,'independent reader downloads from follower',360000);
 assert.equal(sha1(torrent.infoBuffer).toString('hex'),fx.head.id);
 for(let i=0;i<fx.head.entries.length;i++)assert.equal(hash(await readFile(join(root,'fresh-reader',fx.head.info.name,...fx.head.entries[i].path))),hash(fx.head.entries[i].data));
 pass('fresh Node reader starts only with the post magnet, resolves via DHT and downloads exact catalog from follower without tracker/manual peer');
 await reader.stop();reader=null;
 await app.deletePost('followed',fx.postId);await app.stop();clear();
 app=await startApp(join(root,'follower'),args);
 await wait(async()=> (await app.api()).ready,'deleted follower restart');
 await new Promise(r=>setTimeout(r,1200));assert(!restored());assert.equal((await app.api()).posts.length,0);
 pass('deletion is durable and does not recreate or renew the removed identity on restart');
 report.status='pass';
} catch(e) {report.status='fail';report.error=e.stack;if(app){try{report.snapshot=await app.api();report.logs=app.logs}catch{}}console.error(e);process.exitCode=1;}
finally {if(reader)await reader.stop();if(app)await app.stop();if(fx)await fx.stop();await mkdir(evidencePath(),{recursive:true});await writeFile(evidencePath("post-renewal.json"),JSON.stringify(report,null,2)+'\n');await cleanup(root);}
