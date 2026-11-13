import assert from 'node:assert/strict';
import {join} from 'node:path';
import {stat,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import bencode from 'bencode';
import {temporary,startApp,seed,tracker,wait,reference,cleanup} from './helpers.mjs';

const root=await temporary();let app,tr,source,downloader;
try {
  tr=await tracker();source=await seed(join(root,'seed'),[16*1024*1024],{tracker:true,announce:[tr.http],uploadLimit:128*1024});
  // Keep the registered seed available, but prevent it discovering/dialing the app.
  // Both transfers then exercise the same real outgoing IP/port on reconnect.
  const advertiser=source.torrent.discovery.tracker;source.torrent.discovery.tracker=null;
  await new Promise(resolve=>advertiser.destroy(resolve));
  app=await startApp(join(root,'app'));
  await assert.rejects(()=>app.command({type:'read_peers',id:'invalid'}),/Invalid/);
  await assert.rejects(()=>app.command({type:'read_peers',id:'a'.repeat(40)}),/unavailable/i);
  await app.command({type:'add_torrent',data:source.bytes});
  const peers=()=>app.command({type:'read_peers',id:source.id});
  const receiving=await wait(async()=>{const p=await peers();return p.peers.find(p=>p.connected&&p.down>0);},'per-peer download payload');
  assert.equal(receiving.address,'127.0.0.1');assert.equal(receiving.country,null);assert(receiving.port>0);assert(receiving.up>=0);
  assert.equal(receiving.port,source.client.torrentPort);
  console.log('PASS real receiving peer and local country',receiving);
  await app.command({type:'pause',id:source.id});
  await wait(async()=>{const p=(await peers()).peers;return p.length&&p.every(p=>!p.connected&&p.down===0&&p.up===0);},'pause retains known peers without stale rates');
  await app.command({type:'resume',id:source.id});
  // peer_list.cpp enforces min_reconnect_time=60s after disconnection.
  // Leave room for its connection scheduler without changing production timers.
  const reconnected=await wait(async()=>(await peers()).peers.find(p=>p.connected&&p.down>0),'same source reconnects',90000);
  assert.equal(reconnected.address,receiving.address);assert.equal(reconnected.port,receiving.port);
  assert.equal((await peers()).peers.filter(p=>p.address===receiving.address&&p.port===receiving.port).length,1);
  console.log('PASS pause retains known endpoints and reconnect does not duplicate an endpoint');
  const abort=new AbortController(),response=await fetch(app.url+'/api/events',{headers:{Cookie:app.cookie},signal:abort.signal});
  let events=0;const reader=response.body.getReader();
  const listening=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;events+=(new TextDecoder().decode(value).match(/event: snapshot/g)||[]).length;}}catch(error){if(!abort.signal.aborted)throw error;}})();
  await wait(()=>events>0,'initial snapshot event');
  const metadata=join(root,'app','state','transfers.json'),before=(await stat(metadata)).mtimeMs;
  const started=Date.now(),initial=events;
  for(let i=0;i<20;i++)assert.equal((await peers()).id,source.id);
  assert(events-initial<=Math.ceil((Date.now()-started)/1000)+1,'peer reads caused extra snapshot events');
  assert.equal((await stat(metadata)).mtimeMs,before,'peer reads changed persistent state');
  abort.abort();await listening;
  console.log('PASS read-only peer calls do not write or force snapshots');
  await source.stop();source.stop=async()=>{};
  await wait(async()=>{const p=(await peers()).peers;return p.length&&p.every(p=>!p.connected&&p.down===0&&p.up===0);},'disconnection retains known peers without stale rates');
  assert.equal((await app.api()).transfers.find(t=>t.id===source.id).warning,'');
  console.log('PASS reset/disconnection is not a torrent warning');
  // A native seed serves a different independent client; use the completed piece
  // prefix while the original download is incomplete, then observe the idle wire.
  downloader=await reference({utPex:false});
  const snapshot=await app.api();
  const torrent=downloader.client.add(Buffer.from(source.bytes),{path:join(root,'receiver'),announce:[]});
  let connection; torrent.on('wire',wire=>{connection=wire;});
  await new Promise(resolve=>torrent.once('infoHash',resolve));
  torrent.addPeer(`127.0.0.1:${snapshot.listen_port}`);
  const wire=await wait(()=>connection,'independent downloader handshake');
  const sending=await wait(async()=>{const p=await peers();return p.peers.find(p=>p.connected&&p.up>0);},'per-peer upload payload');
  assert.equal(sending.country,null);console.log('PASS native peer uploading payload',sending);
  wire.uninterested();
  await wait(async()=>{const p=await peers();return p.peers.some(p=>p.connected&&p.down===0&&p.up===0);},'idle connected peer remains visible');
  await app.command({type:'pause',id:source.id});
  await wait(async()=>{const p=(await peers()).peers;return p.length&&p.every(p=>!p.connected&&p.down===0&&p.up===0);},'paused torrent keeps known endpoints, not stale connections');
  await app.command({type:'resume',id:source.id});
  console.log('PASS idle peer, pause and resume');
}finally{await cleanup(root,downloader,app,source,tr);}


// A real tracker advertises duplicate, unreachable and handshaking endpoints.
// No mock commands or extra connection attempts are added to the application.
{
  const root=await temporary(),sockets=new Set();let app,other,source,stalled,tr;
  const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const compact=port=>{const p=Buffer.from([127,0,0,1,0,0]);p.writeUInt16BE(port,4);return p;};
  try {
    stalled=createServer(socket=>{sockets.add(socket);socket.resume();socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});await listen(stalled);
    const refused=createServer();await listen(refused);const refusedPort=refused.address().port;await close(refused);
    const stalledPort=stalled.address().port;let advertised=Buffer.concat([compact(stalledPort),compact(stalledPort),compact(refusedPort)]),announces=0;
    tr=httpServer((_request,response)=>{announces++;response.end(bencode.encode({interval:1,'min interval':1,peers:advertised}));});await listen(tr);
    source=await seed(join(root,'seed'),[4097],{announce:[`http://127.0.0.1:${tr.address().port}/announce`]});
    const appRoot=join(root,'app');app=await startApp(appRoot);
    await app.command({type:'add_torrent',data:source.bytes});
    const peers=()=>app.command({type:'read_peers',id:source.id});
    await wait(async()=>{const p=(await peers()).peers;return p.length===2&&p.every(p=>!p.connected&&p.down===0&&p.up===0);},'tracker discoveries before handshake, including refused endpoint');
    await wait(()=>sockets.size>0,'real TCP connection waiting for handshake');
    for(let i=0;i<10;i++)assert.equal((await peers()).peers.length,2,'duplicate discovery changed endpoint identity');
    await app.command({type:'pause',id:source.id});
    await wait(async()=>!(await peers()).peers.some(p=>p.connected),'pause clears connection flags');
    assert.equal((await peers()).peers.length,2);
    other=await startApp(join(root,'other'));
    assert.deepEqual((await other.api()).transfers,[],'known endpoints leaked to another session');
    const isolated=await seed(join(root,'isolated'),[8197]);await app.command({type:'add_torrent',data:isolated.bytes});await isolated.stop();
    assert.deepEqual((await app.command({type:'read_peers',id:isolated.id})).peers,[],'known endpoints leaked to another torrent');
    console.log('PASS tracker discovery, deduplication, handshaking/refused peers and torrent/session isolation');
    await app.stop();
    const resumePath=join(appRoot,'downloads',source.id+'.resume');
    const resume=bencode.decode(await readFile(resumePath));resume.peers=compact(stalledPort);await writeFile(resumePath,bencode.encode(resume));
    app=await startApp(appRoot);
    const restored=await wait(async()=>{const p=(await peers()).peers;return p.some(p=>p.port===stalledPort)&&p;},'existing resume hints available on paused startup');
    assert(restored.every(p=>!p.connected&&p.down===0&&p.up===0));
    await app.stop();await rm(resumePath,{force:true});app=await startApp(appRoot);
    assert.deepEqual((await peers()).peers,[],'session-only registry was persisted outside existing resume hints');
    // Re-populate, remove, and re-add the same identity with an empty tracker.
    await app.command({type:'resume',id:source.id});await wait(async()=>(await peers()).peers.length===2,'discovery after resume');
    const preview=await app.command({type:'preview_removal',target:{kind:'unpin',id:source.id}});
    await app.command({type:'set_pin',id:source.id,pinned:false,revision:preview.revision});
    await wait(async()=>!(await app.api()).transfers.some(t=>t.id===source.id),'torrent detached');
    advertised=Buffer.alloc(0);const before=announces;await app.command({type:'add_torrent',data:source.bytes});
    await wait(()=>announces>before,'fresh empty tracker response');
    assert.deepEqual((await peers()).peers,[],'removed torrent retained its previous discovery registry');
    console.log('PASS resume hints, application restart and removal/re-add clean the session registry');
  } finally {
    try { await cleanup(root,app,other,source); }
    finally {
      // Stop producers before destroying sockets, including late accepts.
      for(const socket of sockets)socket.destroy();
      if(tr?.listening)await close(tr);if(stalled?.listening)await close(stalled);
    }
  }
}
