// Independent test wire peer: Node UDP/bencode/Ed25519, no Rust codec/routing.
import dgram from 'node:dgram';
import {EventEmitter} from 'node:events';
import {randomBytes,createHash,createHmac,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import bencode from '../node_modules/bencode/index.js';
export const hex=b=>Buffer.from(b).toString('hex');
const buf=x=>Buffer.from(x);
export const target=(key,salt=Buffer.alloc(0))=>createHash('sha1').update(key).update(salt).digest();
export function signed(seed,seq,value,salt=Buffer.alloc(0)){
 const secret=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
 const k=createPublicKey(secret).export({format:'der',type:'spki'}).subarray(-32);
 const body={seq,v:value};if(salt.length)body.salt=salt;
 return {k,salt,seq,v:value,sig:sign(null,bencode.encode(body).subarray(1,-1),secret)};
}
export function valid(r,salt){
 try{const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),buf(r.k)]),format:'der',type:'spki'});const body={seq:r.seq,v:r.v};if(salt.length)body.salt=salt;return Number.isSafeInteger(r.seq)&&r.seq>=0&&bencode.encode(r.v).length<=1000&&verify(null,bencode.encode(body).subarray(1,-1),key,buf(r.sig));}catch{return false}
}
export function jsonRecord(r){return{key:hex(r.k),salt:hex(r.salt),sequence:String(r.seq),signature:hex(r.sig),value:hex(bencode.encode(r.v))};}
export class WirePeer extends EventEmitter{
 constructor(family='udp4'){
  super();this.family=family;this.host=family==='udp6'?'::1':'127.0.0.1';this.id=randomBytes(20);this.secret=randomBytes(32);this.topics=new Map();this.pending=new Map();this.trace=[];this.socket=dgram.createSocket(family);
  this.socket.on('message',(packet,source)=>{try{this.receive(bencode.decode(packet),source)}catch{}});
 }
 async listen(){await new Promise(r=>this.socket.bind(0,this.host,r));this.port=this.socket.address().port;return this;}
 subscribe(r){const c=target(r.k,r.salt);this.topics.set(hex(c),{key:buf(r.k),salt:buf(r.salt),record:null});return c;}
 token(c,host){return createHmac('sha1',this.secret).update(c).update(host).digest();}
 send(packet,peer){this.trace.push({direction:'out',q:packet.q?.toString(),y:packet.y.toString(),c:hex(packet.c),peer:peer.port});this.socket.send(bencode.encode(packet),peer.port,peer.host||peer.address);}
 receive(p,source){
  if(!p.c||p.c.length!==20||!p.t||!p.y)return;
  this.trace.push({direction:'in',q:(p.q&&buf(p.q).toString()),y:buf(p.y).toString(),c:hex(p.c),peer:source.port});
  const type=buf(p.y).toString(),tx=hex(p.t);
  if(type==='r'||type==='e'){const pending=this.pending.get(tx);if(!pending||pending.peer.port!==source.port||!buf(p.c).equals(pending.c))return;clearTimeout(pending.timer);this.pending.delete(tx);if(type==='e'){const error=Error(String(p.e?.[1]));error.remoteCode=p.e?.[0];pending.reject(error)}else pending.resolve(p.r);return;}
  const topic=this.topics.get(hex(p.c));if(!topic||type!=='q')return;
  let reply={id:this.id};const error=code=>this.send({c:p.c,t:p.t,y:'e',e:[code,Buffer.from('Rejected')]},source);
  const a=p.a,q=(p.q&&buf(p.q).toString());if(!a?.id||a.id.length!==20)return error(203);
  if(q==='ping'){}
  else if(q==='find_node'){reply[this.family==='udp6'?'nodes6':'nodes']=Buffer.alloc(0);}
  else if(q==='get'){
   if(!buf(a.target||[]).equals(p.c))return error(203);reply.token=this.token(p.c,source.address);
   if(topic.record){reply.seq=topic.record.seq;if(a.seq===undefined||a.seq<topic.record.seq){const r=topic.record;Object.assign(reply,{k:r.k,sig:r.sig,v:r.v});}}
   reply[this.family==='udp6'?'nodes6':'nodes']=Buffer.alloc(0);
  }else if(q==='put'){
   if(!buf(a.token||[]).equals(this.token(p.c,source.address)))return error(203);
   const salt=buf(a.salt||[]);if(!buf(a.k||[]).equals(topic.key)||!salt.equals(topic.salt))return error(203);
   if(!valid(a,salt))return error(206);
   const old=topic.record;
   if(a.cas!==undefined&&old&&a.cas!==old.seq)return error(301);
   if(old&&a.seq<old.seq)return error(302);
   if(old&&a.seq===old.seq&&!buf(bencode.encode(a.v)).equals(bencode.encode(old.v)))return error(201);
   if(!old||a.seq>old.seq){topic.record={k:buf(a.k),sig:buf(a.sig),salt,seq:a.seq,v:a.v};this.emit('update',topic.record);}
  }else return error(204);
  this.send({c:p.c,t:p.t,y:'r',r:reply},source);
 }
 rpc(c,peer,q,a={},timeout=2500){
  const t=randomBytes(8),id=hex(t);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Node UDP timeout '+q))},timeout);this.pending.set(id,{resolve,reject,timer,peer,c});this.send({c,t,y:'q',q,a:{id:this.id,...a}},peer);});
 }
 async publish(peer,r,extra={}){const c=target(r.k,r.salt),get=await this.rpc(c,peer,'get',{target:c});return this.rpc(c,peer,'put',{k:r.k,salt:r.salt,sig:r.sig,v:r.v,seq:r.seq,token:get.token,...extra});}
 async close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Closed'))}this.pending.clear();await new Promise(r=>this.socket.close(r));}
}
// Minimal independent BEP5 router used only to isolate IPv6 discovery. Topic
// PubSub packets are never handled here. Real libtorrent performs the lookup.
export class Router{
 constructor(family){this.family=family;this.host=family==='udp6'?'::1':'127.0.0.1';this.id=randomBytes(20);this.peers=new Map();this.routers=[];this.announces=[];this.socket=dgram.createSocket(family);this.socket.on('message',(packet,source)=>{try{this.receive(bencode.decode(packet),source)}catch{}});}
 async listen(){await new Promise(r=>this.socket.bind(0,this.host,r));this.port=this.socket.address().port;return this;}
 compact(){return Buffer.concat(this.routers.map(r=>Buffer.concat([r.id,r.family==='udp6'?Buffer.from('00000000000000000000000000000001','hex'):Buffer.from([127,0,0,1]),Buffer.from([r.port>>8,r.port&255])])));}
 receive(p,source){if(p.c||(p.y&&buf(p.y).toString())!=='q')return;const q=(p.q&&buf(p.q).toString()),a=p.a;let r={id:this.id};
  if(q==='find_node'||q==='get_peers'){r[this.family==='udp6'?'nodes6':'nodes']=this.compact();if(q==='get_peers'){r.token=Buffer.from('fixture-token');const peers=this.peers.get(hex(a.info_hash));if(peers?.length)r.values=peers;}}
  else if(q==='announce_peer'){const port=a.implied_port?source.port:a.port;const ip=this.family==='udp6'?Buffer.from('00000000000000000000000000000001','hex'):Buffer.from([127,0,0,1]);const contact=Buffer.concat([ip,Buffer.from([port>>8,port&255])]);const key=hex(a.info_hash);const peers=this.peers.get(key)||[];if(!peers.some(p=>p.equals(contact)))peers.push(contact);this.peers.set(key,peers);this.announces.push({target:key,port});}
  else if(q==='get'){r.token=Buffer.from('fixture-token');r[this.family==='udp6'?'nodes6':'nodes']=this.compact();}
  else if(q!=='ping')return;
  this.socket.send(bencode.encode({t:p.t,y:'r',r}),source.port,source.address);
 }
 async close(){await new Promise(r=>this.socket.close(r));}
}
