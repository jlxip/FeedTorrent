import assert from "node:assert/strict";
import { runBep46 } from "./bep46.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import DHT from "bittorrent-dht";
import bencode from "bencode";
import { temporary, wait, cleanup, seed, tracker, reference } from "./helpers.mjs";
const report={time:new Date().toISOString(),checks:[],errors:[]};
const pass=(name)=>{report.checks.push(name);console.log("PASS",name)};
const peers=[],nodes=[];let root,tr,ref,reader;
const digest=b=>createHash("sha1").update(b).digest();
const hex=b=>Buffer.from(b).toString("hex");
const value=b=>hex(bencode.encode(b));
const spki=pk=>createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),pk]),format:"der",type:"spki"});
const checkSignature=(sig,message,pk)=>{try{return verify(null,message,spki(pk),sig)}catch{return false}};
const privateKey=seed=>createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
function signedBody(v,seq,salt){const fields={seq,v};if(salt?.length)fields.salt=salt;return bencode.encode(fields).subarray(1,-1)}
async function node(){const n=new DHT({bootstrap:false,host:"127.0.0.1",verify:checkSignature});n.on("error",()=>{});await new Promise(r=>n.listen(0,"127.0.0.1",r));nodes.push(n);return n}
const put=(n,opts)=>new Promise((yes,no)=>n.put(opts,(e,key,count)=>e?no(e):yes({key,count})));
const get=(n,key,salt)=>new Promise((yes,no)=>n.get(key,salt?.length?{salt}:{},(e,item)=>e?no(e):yes(item)));
async function connect(ns){for(const a of ns)for(const b of ns)if(a!==b)a.addNode({host:"127.0.0.1",port:b.address().port});await wait(()=>ns.every(n=>n.nodes.toArray().length>=ns.length-1),"DHT fixture routing")}
async function native(name,bootstrap){
  const state=join(root,name);await mkdir(state,{recursive:true});
  const child=spawn(resolve("target/release/examples/bep44-peer"),[state,bootstrap],{stdio:["pipe","pipe","pipe"]});
  const pending=new Map(),events=new Map(),counts=new Map();let next=0,errors="";
  child.stderr.on("data",b=>{errors=(errors+b).slice(-65536)});
  createInterface({input:child.stdout}).on("line",line=>{const q=JSON.parse(line);if(q.event!==undefined){counts.set(q.event,(counts.get(q.event)||0)+1);events.set(q.event,q)}else{const call=pending.get(q.id);if(call){pending.delete(q.id);q.error?call.reject(Error(q.error)):call.resolve(q.result)}}});
  child.on("exit",(code)=>{for(const p of pending.values())p.reject(Error(`Native peer ${name} exited ${code}: ${errors}`));pending.clear()});
  const call=(op,args={})=>{if(child.exitCode!==null)throw Error(errors);const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,...args})+"\n")})};
  const start=async(args)=>{const r=await call("start",args);return r.request};
  const done=id=>wait(()=>events.get(id),`native request ${id}`,45000);
  const perform=async(args)=>{const event=await done(await start(args));if(event.error)throw Error(event.error);return event.result};
  const stop=async()=>{if(child.exitCode!==null)return;const ended=once(child,"exit");child.stdin.write('{"op":"exit"}\n');const timer=setTimeout(()=>child.kill("SIGKILL"),8000);const [code]=await ended;clearTimeout(timer);assert.equal(code,0,errors)};
  const peer={call,start,done,perform,counts,stop};peers.push(peer);
  await wait(async()=>{const r=await call("info");return r.port>0&&r},"native DHT bind");
  return peer;
}
async function ready(peer){await wait(async()=>{try{const id=await peer.start({kind:"get_immutable",target:"00".repeat(20)});await peer.done(id);return true}catch(e){if(/NotReady/.test(e.message))return false;throw e}},"DHT ready")}
async function freshGet(bootstrap,key,salt){const n=await node();for(const other of bootstrap)n.addNode({host:"127.0.0.1",port:other.address().port});await wait(()=>n.nodes.toArray().length>0,"fresh DHT reader");return get(n,key,salt)}
try {
  root=await temporary();const routing=[await node(),await node(),await node()];await connect(routing);
  // Bootstrap routers are excluded from libtorrent storage targets. Keep ordinary nodes too.
  const bootstrap="127.0.0.1:"+routing[0].address().port;
  const storage=await native("native-storage",bootstrap);await ready(storage);await wait(async()=>(await storage.call("info")).nodes>0,"storage bootstrap");const port=(await storage.call("info")).port;
  for(const n of routing)n.addNode({host:"127.0.0.1",port});
  await wait(()=>routing.some(n=>n.nodes.toArray().some(p=>p.port===port)),"native storage routing advertisement");
  const client=await native("native-client",bootstrap);await ready(client);await wait(async()=>(await client.call("info")).nodes>0,"client bootstrap");
  const payload=Buffer.from([0,255,1,128,4]);const encoded=value(payload),target=digest(bencode.encode(payload));
  const stored=await client.perform({kind:"put_immutable",value:encoded});assert(stored.acknowledged_nodes>0);assert.equal(stored.target,hex(target));
  const independent=await freshGet(routing,target);assert.deepEqual(independent.v,payload);
  const fromNode=Buffer.from("independent immutable");const nodePut=await put(routing[0],{v:fromNode});assert(nodePut.count>0);
  const nativeRead=await client.perform({kind:"get_immutable",target:hex(nodePut.key)});assert.equal(nativeRead.item.value,value(fromNode));
  pass("immutable publication and lookup interoperate in both directions with independent Node DHT");
  const keySeed=Buffer.alloc(32,19),secret=privateKey(keySeed),pk=createPublicKey(secret).export({format:"der",type:"spki"}).subarray(-32);
  const salt=Buffer.from([0,255,3]),text=Buffer.from("signed by Rust");
  const signed=await client.call("sign",{seed:hex(keySeed),value:value(text),sequence:"1",salt:hex(salt)});
  assert.equal(signed.key,hex(pk));assert.equal(signed.signature,hex(sign(null,signedBody(text,1,salt),secret)));
  assert(checkSignature(Buffer.from(signed.signature,"hex"),signedBody(text,1,salt),pk));
  await client.perform({kind:"put_mutable",...signed});const mutableTarget=digest(Buffer.concat([pk,salt]));
  const received=await freshGet(routing,mutableTarget,salt);assert.equal(received.seq,1);assert.deepEqual(received.v,text);
  const update=Buffer.from("signed by Node");const updateSig=sign(null,signedBody(update,2,salt),secret);
  await put(routing[0],{k:pk,salt,seq:2,v:update,sig:updateSig});
  const current=(await client.perform({kind:"get_mutable",key:hex(pk),salt:hex(salt)})).item;
  assert.equal(current.sequence,"2");assert.equal(current.value,value(update));assert.equal(current.signature,hex(updateSig));
  await client.call("verify",current);
  await assert.rejects(()=>client.call("verify",{...current,signature:"00".repeat(64)}),/InvalidSignature/);
  pass("mutable identity, binary salt, exact Ed25519 cross-signing and version updates interoperate");
  const conflict=await client.call("sign",{seed:hex(keySeed),value:value(Buffer.from("conflict")),sequence:"2",salt:hex(salt)});
  await assert.rejects(()=>client.perform({kind:"put_mutable",...signed}),/Conflict/);
  await assert.rejects(()=>client.perform({kind:"put_mutable",...conflict}),/Conflict/);
  const republished=await client.perform({kind:"put_mutable",...current});assert(republished.acknowledged_nodes>0);
  assert.equal((await client.perform({kind:"get_mutable",key:hex(pk),salt:hex(salt)})).item.sequence,"2");
  pass("stale/equivocating publications report conflicts; existing signed records republish without a private key");
  for(const raw of ["i0e","le","de","li1e0:e","d1:ai2ee","996:"+"x".repeat(996),"l".repeat(4)+"i0e"+"e".repeat(4)]){
    const v=Buffer.from(raw);const t=digest(v);await client.perform({kind:"put_immutable",value:hex(v)});assert.equal((await client.perform({kind:"get_immutable",target:hex(t)})).item.value,hex(v));
  }
  const max=await client.call("sign",{seed:hex(keySeed),value:value(Buffer.alloc(996,42)),sequence:"9223372036854775807",salt:hex(Buffer.alloc(64,255))});
  await client.perform({kind:"put_mutable",...max});const maxRead=(await client.perform({kind:"get_mutable",key:max.key,salt:max.salt})).item;assert.equal(maxRead.sequence,max.sequence);
  pass("native peers handle compound values, size/salt boundaries and i64::MAX without JavaScript precision loss");
  const a=await client.start({kind:"get_immutable",target:hex(target)}),b=await client.start({kind:"get_mutable",key:hex(pk),salt:hex(salt)});assert.notEqual(a,b);assert(!(await client.done(a)).error);assert(!(await client.done(b)).error);
  await client.call("checkpoint");assert.equal(client.counts.get(a),1);assert.equal(client.counts.get(b),1);
  pass("different keys run concurrently; snapshot/checkpoint preserve exactly-once DHT results");
  const empty=await native("empty","");await ready(empty);
  assert.equal((await empty.perform({kind:"get_immutable",target:"ab".repeat(20)})).item,null);
  assert.equal((await empty.perform({kind:"get_mutable",key:hex(pk),salt:hex(salt)})).item,null);
  await assert.rejects(()=>empty.perform({kind:"put_immutable",value:value(Buffer.from("no route"))}),/NoAcknowledgements/);
  await assert.rejects(()=>empty.start({kind:"get_immutable",target:"cc".repeat(20),timeout_ms:0}),/InvalidInput/);
  pass("completed absent lookup, zero-ack publication and invalid request options are distinct outcomes");
  const fault=[await node(),await node()];await connect(fault);
  const faultData=Buffer.from("delayed response"),faultTarget=digest(bencode.encode(faultData));await put(fault[0],{v:faultData});
  const held=[];let hold=true;
  for(const n of fault){const original=n._onget.bind(n);n._onget=(q,p)=>{if(hold)held.push(()=>original(q,p));else original(q,p)}}
  const delayed=await native("delayed","127.0.0.1:"+fault[0].address().port);
  await wait(async()=>(await delayed.call("info")).nodes>0,"delayed bootstrap");
  const timed=await wait(async()=>{try{return await delayed.start({kind:"get_immutable",target:hex(faultTarget),timeout_ms:80})}catch(e){if(/NotReady/.test(e.message))return false;throw e}},"delayed DHT start");
  assert.match((await delayed.done(timed)).error,/Timeout/);
  await assert.rejects(()=>delayed.start({kind:"get_immutable",target:hex(faultTarget)}),/Busy/);
  hold=false;for(const resume of held)resume();
  const later=await wait(async()=>{try{return await delayed.start({kind:"get_immutable",target:hex(faultTarget)})}catch(e){if(/Busy/.test(e.message))return false;throw e}},"native completion releases timed-out key");
  assert.notEqual(later,timed);assert.equal((await delayed.done(later)).result.item.value,value(faultData));assert.equal(delayed.counts.get(timed),1);
  pass("timeout retains key reservation; late reply cannot complete a newer request or produce a second result");
  hold=true;const closing=await delayed.start({kind:"get_immutable",target:"ee".repeat(20)});await delayed.call("shutdown");assert.match((await delayed.done(closing)).error,/Closed/);assert.equal(delayed.counts.get(closing),1);
  await assert.rejects(()=>delayed.start({kind:"get_immutable",target:"dd".repeat(20)}),/Closed/);
  pass("shutdown completes pending DHT requests and rejects subsequent operations");
  tr=await tracker();ref=await seed(join(root,"coexist-seed"),[300019],{tracker:true,announce:[tr.http]});const save=join(root,"coexist-download");await mkdir(save);
  const added=await client.call("add",{torrent:hex(ref.bytes),path:save});
  const coexist=await client.start({kind:"get_mutable",key:hex(pk),salt:hex(salt)});await client.call("checkpoint");assert.equal((await client.done(coexist)).result.item.sequence,"2");
  await wait(async()=>{const t=(await client.call("info")).transfers.find(t=>t.id===added.id);return t?.state==="Seeding"},"coexisting torrent completes");
  assert.deepEqual(await readFile(join(save,ref.torrent.files[0].path)),ref.originals[0]);
  reader=await reference();const t=reader.client.add(Buffer.from(ref.bytes),{path:join(root,"reverse"),announce:[]});await new Promise(r=>t.once("infoHash",r));t.addPeer("127.0.0.1:"+(await client.call("info")).port);await wait(()=>t.done,"independent reverse transfer while DHT used");
  assert.deepEqual(await readFile(join(root,"reverse",ref.torrent.files[0].path)),ref.originals[0]);
  pass("same libtorrent session downloads and serves exact torrent content alongside BEP44 operations");
  await runBep46({client,routing,root,put,freshGet,pass});
} catch(error){report.errors.push(error.stack);console.error(error);process.exitCode=1}
finally {
  for(const peer of peers.reverse())try{await peer.stop()}catch(e){report.errors.push(e.stack);process.exitCode=1}
  for(const n of nodes)try{await new Promise(r=>n.destroy(r))}catch{}
  if(root)await cleanup(root,tr,ref,reader);
  report.status=report.errors.length?"fail":"pass";await mkdir(".runtime/evidence",{recursive:true});await writeFile(".runtime/evidence/bep44.json",JSON.stringify(report,null,2)+"\n");
}
