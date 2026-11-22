// Startup must restore a real desktop-sized library under inherited limits.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import bencode from 'bencode';
import {temporary,startApp,complete,wait,cleanup} from './helpers.mjs';
import {signaling} from './webtorrent-fixture.mjs';

function torrent(index){
  const bytes=Buffer.from([index]);
  const info={name:Buffer.from('file-'+index+'.bin'),length:bytes.length,'piece length':16384,pieces:createHash('sha1').update(bytes).digest()};
  return {id:createHash('sha1').update(bencode.encode(info)).digest('hex'),data:Array.from(bencode.encode({info})),bytes,name:'file-'+index+'.bin'};
}
async function install(app,dir,index){
 const t=torrent(index);await mkdir(join(dir,t.id),{recursive:true});await writeFile(join(dir,t.id,t.name),t.bytes);
 await app.command({type:'add_torrent',data:t.data});await complete(app,t.id);return t;
}
async function paths(){
 const root=await temporary();let app;
 try{
  const dir=join(root,'app');app=await startApp(dir,[],{cwd:root});const t=await install(app,join(dir,'downloads'),1);
  await app.command({type:'configure',settings:{...(await app.api()).settings,download_dir:'app/downloads',webtorrent_trackers:[],webtorrent_stun_server:''}});await app.stop();
  app=await startApp(dir,[],{cwd:root,defaultDownloads:true});await complete(app,t.id);
  assert.equal((await app.api()).warning,'');assert.deepEqual(await readFile(join(dir,'downloads',t.id,t.name)),t.bytes);
  console.log('PASS relative download root and absolute registry path restore the same torrent without a false conflict');
  await app.stop();const other=join(root,'separate-copy');await cp(join(dir,'downloads'),other,{recursive:true});
  const registry=join(dir,'state/transfers.json');const state=JSON.parse(await readFile(registry));state.records[0].path=join(other,t.id);await writeFile(registry,JSON.stringify(state));
  app=await startApp(dir,[],{cwd:root,defaultDownloads:true});await complete(app,t.id);assert.match((await app.api()).warning,/conflicts with the registry/);
  assert.deepEqual(await readFile(join(other,t.id,t.name)),t.bytes);assert.deepEqual(await readFile(join(dir,'downloads',t.id,t.name)),t.bytes);
  console.log('PASS genuinely separate existing directories still report a conflict and preserve both copies');
 }finally{await cleanup(root,app);}
}
async function descriptors(){
 const inherited=256;
 const root=await temporary();let app,tr;const held=[];
 try{
  const dir=join(root,'app');tr=await signaling(join(root,'tls'));app=await startApp(dir,[],{env:tr.env});
  await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[],webtorrent_stun_server:''}});
  for(let i=0;i<32;i++)await install(app,join(dir,'downloads'),i);
  await app.stop();const file=join(dir,'state/transfers.json');const state=JSON.parse(await readFile(file));state.settings.webtorrent_trackers=[tr.url];await writeFile(file,JSON.stringify(state));
  app=await startApp(dir,[],{env:tr.env,descriptorLimits:{soft:inherited,hard:4096}});assert.match(app.logs,/FD_LIMIT_BEFORE_EXEC 256 /);const snapshot=await wait(async()=>{const s=await app.api();return s.ready?s:false;},'restored library ready');
  assert.equal(snapshot.transfers.length,32);assert.equal(snapshot.warning,'');assert(snapshot.transfers.every(t=>!t.error&&t.active),JSON.stringify(snapshot.transfers.map(t=>({id:t.id,error:t.error,active:t.active}))));
  const descriptorCount=async()=>{
   if(process.platform==='linux')return (await readdir('/proc/'+app.child.pid+'/fd')).length;
   if(process.platform==='darwin')return execFileSync('lsof',['-a','-p',String(app.child.pid),'-F','f'],{encoding:'utf8'}).split('\n').filter(s=>/^f[0-9]+$/.test(s)).length;
   return execFileSync('fstat',['-p',String(app.child.pid)],{encoding:'utf8'}).split('\n').filter(s=>new RegExp('^\\S+\\s+\\S+\\s+'+app.child.pid+'\\s+[0-9]+\\*?\\s').test(s)).length;
  };
  // ICE admission is bounded independently of the restored library size.
  // Hold real HTTP connections to exercise the inherited descriptor limit
  // without depending on an unbounded number of unanswered ICE offers.
  const endpoint=new URL(app.url);
  for(let i=0;i<inherited+32;i++){
   const socket=createConnection({host:endpoint.hostname,port:Number(endpoint.port)});held.push(socket);
   await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
   socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  }
  const count=await wait(async()=>{const n=await descriptorCount();return n>inherited?n:false;},'native descriptors exceed inherited soft limit');
  const ready=await app.api();assert(ready.transfers.every(t=>!t.error&&t.active));assert.equal(ready.warning,'');
  console.log('PASS 32 restored WebRTC torrents retain activity beyond inherited descriptor limit',JSON.stringify({inherited,descriptors:count,offers:tr.announces.reduce((n,a)=>n+(a.offers||0),0)}));
 }finally{for(const socket of held)socket.destroy();await cleanup(root,app,tr);}
}
if(process.argv.includes('--descriptors-only'))await descriptors();
else if(process.argv.includes('--paths-only'))await paths();
else {await paths();await descriptors();}
