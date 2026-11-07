import {runRoot,evidencePath} from './runtime.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import dgram from 'node:dgram';
import {WirePeer,Router,signed,jsonRecord,target,hex,valid} from '../fixtures/bep50-node.mjs';
import bencode from 'bencode';
const wait=async(f,name,ms=15000)=>{const until=Date.now()+ms;while(Date.now()<until){const r=await f();if(r)return r;await new Promise(r=>setTimeout(r,30))}throw Error('Timeout: '+name)};
const runtime=join(runRoot,'data');await mkdir(runtime,{recursive:true});const root=await mkdtemp(join(runtime,'bep50-'));
const peers=[],wires=[],routers=[];const report={time:new Date().toISOString(),checks:[]};
const pass=s=>{report.checks.push(s);console.log('PASS',s)};
async function native(name,bootstrap=null,port=0,family="udp4"){
 const exe=resolve('target/release/examples/'+(bootstrap===null?'bep50-peer':'bep44-peer'));
 const state=join(root,name);await mkdir(state);const child=spawn(exe,bootstrap===null?[]:[state,bootstrap,String(port),family==="udp6"?"ipv6":"ipv4"],{stdio:['pipe','pipe','pipe']});let seq=0,stderr='';const calls=new Map();
 child.stderr.on('data',b=>stderr=(stderr+b).slice(-8192));
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined){const p=calls.get(m.id);if(p){calls.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.result)}}});
 child.on('exit',code=>{for(const p of calls.values()){clearTimeout(p.timer);p.reject(Error(name+' exited '+code+': '+stderr))}calls.clear()});
 const call=(op,args={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{calls.delete(id);reject(Error('Fixture command timeout '+op))},8000);calls.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,op,...args})+'\n')});
 const stop=async()=>{if(child.exitCode!==null)return;const done=once(child,'exit');child.stdin.write('{"op":"exit"}\n');const timer=setTimeout(()=>child.kill('SIGKILL'),8000);const[code]=await done;clearTimeout(timer);assert.equal(code,0,stderr)};
 const peer={call,stop};peers.push(peer);peer.port=(await call('pubsub_info')).port;return peer;
}
const subscribe=(p,r)=>p.call('subscribe',jsonRecord(r));
const latest=(p,r)=>p.call('latest',jsonRecord(r));
const seed=Buffer.alloc(32,53),salt=Buffer.from([0,255,1]);
let revision=signed(seed,1,Buffer.from('first'),salt);
try{
 for(const family of ['udp4','udp6']){
  const rust=await native(family),node=await new WirePeer(family).listen();wires.push(node);const c=node.subscribe(revision);await subscribe(rust,revision);
  const destination={host:node.host,port:rust.port};await node.publish(destination,revision);await wait(async()=>(await latest(rust,revision))?.sequence==='1','Node -> Rust '+family);
  const r2=signed(seed,2,Buffer.from([0,255,128]),salt);await rust.call('publish',jsonRecord(r2));await wait(()=>node.topics.get(hex(c)).record?.seq===2,'Rust -> Node '+family);assert(valid(node.topics.get(hex(c)).record,salt));
  const same=await node.rpc(c,destination,'get',{target:c,seq:2});assert.equal(same.seq,2);assert.equal(same.v,undefined);
  await assert.rejects(()=>node.publish(destination,revision),e=>e.remoteCode===302);
  const conflict=signed(seed,2,Buffer.from('equivocation'),salt);await assert.rejects(()=>node.publish(destination,conflict),e=>e.remoteCode===201);
  const r3=signed(seed,3,Buffer.from('CAS'),salt);await assert.rejects(()=>node.publish(destination,r3,{cas:0}),e=>e.remoteCode===301);
  const invalid={...r3,sig:Buffer.alloc(64)};await assert.rejects(()=>node.publish(destination,invalid),e=>e.remoteCode===206);
  await assert.rejects(()=>node.rpc(c,destination,'get_peers',{info_hash:c}),e=>e.remoteCode===204);
  await assert.rejects(()=>node.rpc(c,destination,'get',{target:Buffer.alloc(20)}),e=>e.remoteCode===203);
  await assert.rejects(()=>node.publish(destination,r3,{token:Buffer.from('wrong')}),e=>e.remoteCode===203);
  assert.equal((await latest(rust,revision)).sequence,'2');
  await node.publish(destination,r3,{cas:2});await wait(async()=>(await latest(rust,revision)).sequence==='3','CAS success');
  assert(node.trace.every(t=>t.c===hex(c)));assert((await rust.call('pubsub_info')).contacts.some(p=>p.address.includes(String(node.port))));
  pass(family+': independent Node <-> Rust signatures, updates, seq GET, token/signature/identity checks, CAS, rollback/conflict and prohibited methods');
  await rust.stop();await node.close();wires.pop();
 }
 // Real relay topology: forwarding through B is mandatory. A/C cannot reach
 // each other because UDP relays expose only their configured adjacent links.
 const a=await native('A'),b=await native('B'),c=await native('C');
 for(const p of [a,b,c])await subscribe(p,revision);
 // A line with two independent UDP proxies prevents direct A/C endpoints from
 // ever appearing in routing replies. Each direction preserves the proxy source.
 async function edge(left,right){
  const l=dgram.createSocket('udp4'),r=dgram.createSocket('udp4');await new Promise(y=>l.bind(0,'127.0.0.1',y));await new Promise(y=>r.bind(0,'127.0.0.1',y));let messages=0;
  l.on('message',packet=>{messages++;r.send(packet,right.port,'127.0.0.1')});r.on('message',packet=>{messages++;l.send(packet,left.port,'127.0.0.1')});
  routers.push({close:async()=>{l.close();r.close()}});return{left:l.address().port,right:r.address().port,count:()=>messages};
 }
 const ab=await edge(a,b),bc=await edge(b,c);
 await a.call('hint',{...jsonRecord(revision),peers:['127.0.0.1:'+ab.left]});await b.call('hint',{...jsonRecord(revision),peers:['127.0.0.1:'+ab.right,'127.0.0.1:'+bc.left]});await c.call('hint',{...jsonRecord(revision),peers:['127.0.0.1:'+bc.right]});
 await wait(async()=>(await a.call('pubsub_info')).contacts.length>0&&(await c.call('pubsub_info')).contacts.length>0,'relay links');
 await a.call('publish',jsonRecord(revision));await wait(async()=>(await latest(c,revision))?.sequence==='1','A -> B -> C');assert(ab.count()>0&&bc.count()>0);
 const count=ab.count()+bc.count();await new Promise(r=>setTimeout(r,400));assert(ab.count()+bc.count()-count<12,'no forwarding loop');
 await a.stop();const late=await native('late');await subscribe(late,revision);await late.call('hint',{...jsonRecord(revision),peers:['127.0.0.1:'+b.port]});await wait(async()=>(await latest(late,revision))?.sequence==='1','late cached value after publisher exit');
 await late.call('unsubscribe',jsonRecord(revision));assert.equal(await latest(late,revision),null);
 await late.call('pubsub_close');await assert.rejects(()=>subscribe(late,revision),/Closed/);
 pass('real UDP multi-hop relay, duplicate quiescence, late join after publisher exit, unsubscribe and close');
 // Mainline discovery in each family. Routers provide only BEP5; libtorrent
 // announces actual PubSub ports, then peers join without manual PubSub hints.
 for(const family of ['udp4','udp6']){
  const rs=[];for(let i=0;i<4;i++){const r=await new Router(family).listen();routers.push(r);rs.push(r)}for(const r of rs)r.routers=rs.filter(p=>p!==r);
  const bootstrap=family==='udp6'?'[::1]:'+rs[0].port:'127.0.0.1:'+rs[0].port;
  const p=await native('discovery-'+family+'-p',bootstrap,0,family),q=await native('discovery-'+family+'-q',bootstrap,0,family);
  const item=signed(Buffer.alloc(32,family==='udp6'?77:78),1,Buffer.from(family));
  await subscribe(p,item);await p.call('publish',jsonRecord(item));
  await wait(()=>rs.some(r=>r.announces.some(a=>a.target===hex(target(item.k,item.salt))&&a.port===p.port)),'announced actual pubsub port '+family,30000);
  await subscribe(q,item);
  await wait(async()=>{await q.call('checkpoint');await q.call('info');return (await latest(q,item))?.sequence==='1'},'DHT discovered PubSub '+family,40000);
  assert((await q.call('pubsub_info')).contacts.some(c=>family==='udp6'?c.address.startsWith('[::1]'):c.address.startsWith('127.0.0.1')));
  await q.call('pubsub_close');assert((await q.call('info')).port>0,'closing PubSub preserves torrent session');
  pass(family+': isolated Mainline discovery/announce through real libtorrent, correct UDP port and shared dispatcher/checkpoint coexistence');
 }
 report.status='pass';
}catch(error){report.status='fail';report.error=error.stack;console.error(error);process.exitCode=1}
finally{
 for(const p of peers.reverse())try{await p.stop()}catch(e){console.error(e);process.exitCode=1}
 for(const w of wires)await w.close();for(const r of routers)await r.close();await rm(root,{recursive:true,force:true});
 await mkdir(evidencePath(),{recursive:true});await writeFile(evidencePath('bep50-summary.json'),JSON.stringify(report,null,2)+'\n');
}
