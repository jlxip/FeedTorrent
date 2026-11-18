import {createServer as netServer} from 'node:net';
import {createServer as httpsServer} from 'node:https';
import {request} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import bencode from 'bencode';
import {dhtNetwork,startApp,wait} from './helpers.mjs';
export const hex=b=>Buffer.from(b).toString('hex');
const spki=pk=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk]),format:'der',type:'spki'});
export function checkSignature(sig,message,pk){try{return verify(null,message,spki(pk),sig)}catch{return false}}
export async function freePort(){const s=netServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p}
export async function reserve(port){const s=netServer();await new Promise((r,j)=>{s.once('error',j);s.listen(port,'127.0.0.1',r)});return {stop:()=>new Promise(r=>s.close(r))}}
export async function fixture(root){
 const network=await dhtNetwork({verify:checkSignature});let app;
 try{
  await wait(()=>network.nodes.every(n=>n.nodes.toArray().length===2),'controlled DHT routing');
  const value=Buffer.from([0,255,128,4]),encoded=Buffer.from(bencode.encode(value));
  const target=await new Promise((r,j)=>network.nodes[0].put({v:value},(e,key,count)=>e?j(e):count?r(hex(key)):j(Error('no DHT stores'))));
  const secret=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,31)]),format:'der',type:'pkcs8'});
  const key=createPublicKey(secret).export({format:'der',type:'spki'}).subarray(-32),salt=Buffer.from([0,255,3]);
  async function publish(sequence,v){const signed=Buffer.from(bencode.encode({salt,seq:sequence,v})).subarray(1,-1),signature=sign(null,signed,secret);
   await new Promise((r,j)=>network.nodes[0].put({k:key,salt,seq:sequence,v,sig:signature},(e,_k,count)=>e?j(e):count?r():j(Error('no mutable stores'))));
   return {key:hex(key),salt:hex(salt),sequence:String(sequence),signature:hex(signature),value:hex(bencode.encode(v))};
  }
  const mutable=await publish(4,{a:[1,Buffer.from([0,255])]});
  const args=['--dht-bootstrap',network.bootstrap.map(n=>n.host+':'+n.port).join(',')];
  app=await startApp(root,args);
  const port=await freePort(),listen='127.0.0.1:'+port;
  await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[],webtorrent_stun_server:'',dht_gateway:{enabled:true,listen}}});
  return {network,app,args,listen,url:'http://'+listen,target,value:hex(encoded),mutable,publish};
 }catch(error){await app?.stop();await network.stop();throw error}
}
export async function proxy(root,target){
 await mkdir(root,{recursive:true});const key=join(root,'key.pem'),cert=join(root,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:['ignore','ignore','pipe']});
 const server=httpsServer({key:await readFile(key),cert:await readFile(cert)},(incoming,outgoing)=>{
  if(incoming.url==='/consumer'){outgoing.writeHead(200,{'Content-Type':'text/html'});outgoing.end('<!doctype html><title>DHT consumer</title>');return}
  const forward=request(new URL(incoming.url,target),{method:incoming.method,headers:incoming.headers},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing)});
  forward.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end()});incoming.pipe(forward);
 });
 server.requestTimeout=130000;await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 return {url:'https://127.0.0.1:'+port,page:'https://localhost:'+port+'/consumer',stop:()=>new Promise(r=>{server.close(r);server.closeAllConnections()})};
}
