// Private WSS tracker and browser harness; no public infrastructure is used.
// Select WebTorrent's built-in memory store on every browser: transport tests
// do not exercise OPFS (WebKit rejects that store on the private-CA origin).
// Override the StorageManager prototype so fresh wrappers keep that choice.
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import Tracker from 'bittorrent-tracker/server';

export async function signaling(root) {
  await mkdir(root,{recursive:true});
  const ca=join(root,'ca.pem'),key=join(root,'server.key'),cert=join(root,'server.pem');
  const openssl=args=>execFileSync('openssl',args,{stdio:['ignore','ignore','pipe']});
  await writeFile(join(root,'ca.conf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=WebRTC test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
  openssl(['req','-x509','-sha256','-config',join(root,'ca.conf'),'-newkey','rsa:2048','-nodes','-days','1','-keyout',join(root,'ca.key'),'-out',ca]);
  openssl(['req','-new','-sha256','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',join(root,'server.csr')]);
  await writeFile(join(root,'extensions'),'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509','-req','-sha256','-in',join(root,'server.csr'),'-CA',ca,'-CAkey',join(root,'ca.key'),'-CAserial',join(root,'ca.srl'),'-CAcreateserial','-days','1','-extfile',join(root,'extensions'),'-out',cert]);
  const bundle=await readFile('dev/node_modules/webtorrent/dist/webtorrent.min.js');
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
    res.setHeader('Content-Type',req.url==='/webtorrent.js'?'text/javascript':'text/html');
    res.end(req.url==='/webtorrent.js'?bundle:'<!doctype html><title>WebRTC interoperability fixture</title><script>Object.defineProperty(Object.getPrototypeOf(navigator.storage),"getDirectory",{value:undefined});</script><script type="module">import WebTorrent from "/webtorrent.js";window.WebTorrent=WebTorrent;</script>');
  });
  const sockets=new Set(),announces=[],tlsErrors=[];
  server.on('tlsClientError',error=>tlsErrors.push(error.message));
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const tracker=new Tracker({http:false,udp:false,ws:{noServer:true},stats:false,interval:2000});
  tracker.on('warning',()=>{});tracker.on('error',()=>{});
  server.on('upgrade',(req,socket,head)=>tracker.ws.handleUpgrade(req,socket,head,ws=>{
    ws.on('message',b=>{try{const m=JSON.parse(b);announces.push({action:m.action,event:m.event,hash:Buffer.from(m.info_hash||'','binary').toString('hex'),peer:Buffer.from(m.peer_id||'','binary').toString('hex'),offers:m.offers?.length,offer:!!m.offer,answer:!!m.answer});}catch{}});
    tracker.ws.emit('connection',ws,req);
  }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const env={...process.env,SSL_CERT_FILE:ca};
  if(process.platform==='openbsd') {
    const shim=join(root,'tls-ca.so');
    execFileSync('cc',['-shared','-fPIC','-std=c11','-Wall','-Wextra','-Werror','dev/fixtures/tls-ca.c','-lssl','-lcrypto','-o',shim]);
    env.LD_PRELOAD=[shim,env.LD_PRELOAD].filter(Boolean).join(':');env.FEEDTORRENT_TEST_CA=ca;
  }
  return {url:`wss://127.0.0.1:${port}/announce`,page:`https://127.0.0.1:${port}`,ca,env,announces,tracker,tlsErrors,
    stop:async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>tracker.close(r));await new Promise(r=>server.close(r));}};
}
