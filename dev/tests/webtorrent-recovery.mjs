import assert from 'node:assert/strict';
import {createSocket} from 'node:dgram';
import {createHash} from 'node:crypto';
import bencode from 'bencode';
import {networkInterfaces} from 'node:os';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setDefaultCACertificates,getCACertificates} from 'node:tls';
import {temporary,startApp,seed,reference,wait,exact,hash,cleanup} from './helpers.mjs';
import {signaling} from './webtorrent-fixture.mjs';
import {evidencePath} from './runtime.mjs';

export async function recoveryRegression(){
  const root=await temporary(),oldCAs=getCACertificates('default');
  let tr,other,app,receiver,source,second;const occupied=[];
  const result={};
  try{
    const candidateAddress=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.'))?.address;
    assert(candidateAddress);
    tr=await signaling(join(root,'tracker'),{candidateAddress});
    other=await signaling(join(root,'other-tracker'),{candidateAddress});
    const ca=join(root,'ca-bundle.pem');await writeFile(ca,(await readFile(tr.ca,'utf8'))+(await readFile(other.ca,'utf8')));
    setDefaultCACertificates([...oldCAs,await readFile(tr.ca,'utf8'),await readFile(other.ca,'utf8')]);
    const env={...tr.env,SSL_CERT_FILE:ca};
    const fixtures=[];
    for(const [index,length] of [32769,32770].entries()){
      const ref=await seed(join(root,'prepare-'+index),[length]);
      fixtures.push({id:ref.id,bytes:ref.bytes,original:ref.originals[0]});
      const destination=join(root,'recovery','downloads',ref.id,'source');await mkdir(destination,{recursive:true});
      await cp(join(root,'prepare-'+index,'source'),destination,{recursive:true});await ref.stop();
    }
    app=await startApp(join(root,'recovery'),[],{env});
    await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:''}});
    for(const ref of fixtures){await app.command({type:'add_torrent',data:ref.bytes});await wait(async()=>(await app.api()).transfers.find(t=>t.id===ref.id)?.progress===1,'native seed ready');}
    const counts=()=>fixtures.map(ref=>tr.announces.filter(a=>a.hash===ref.id&&a.offers!==undefined).length);
    await wait(()=>counts().every(n=>n>0),'both signaling subscriptions announced');
    const nativePeers=new Set(tr.announces.filter(a=>fixtures.some(ref=>ref.id===a.hash)&&a.offers!==undefined).map(a=>a.peer));
    assert.equal(nativePeers.size,1,'one peer ID must own all torrents on a shared WSS socket');
    // The extra quiet interval puts the severance after the tracker ACK,
    // rather than testing the already-covered pending-request failure path.
    await new Promise(r=>setTimeout(r,1000));
    const before=counts(),clients=new Set(tr.tracker.ws.clients||[]);
    // This tracker disables ws clientTracking; get sockets from live swarm peers.
    for(const ref of fixtures){const swarm=await new Promise(r=>tr.tracker.getSwarm(ref.id,(_e,s)=>r(s)));for(const key of swarm.peers.keys){const peer=swarm.peers.peek(key);if(peer?.socket)clients.add(peer.socket);}}
    assert(clients.size>0);const lost=performance.now();for(const client of clients)client.terminate();
    await wait(()=>counts().every((n,i)=>n>before[i]),'every acknowledged torrent reannounces after WSS loss',30000);
    result.subscriptionRecoverySeconds=(performance.now()-lost)/1000;
    for(const ref of fixtures){
      receiver=await reference({tracker:{rtcConfig:{iceServers:[]}}});
      const wires=[],torrent=receiver.client.add('magnet:?xt=urn:btih:'+ref.id,{path:join(root,'receive-'+ref.id),announce:[tr.url]});torrent.on('wire',wire=>wires.push(wire.type));
      await wait(()=>torrent.done,'WebRTC bytes after signaling recovery',30000);
      assert.equal(hash(await readFile(join(root,'receive-'+ref.id,'source','file-0.bin'))),hash(ref.original));assert(wires.length&&wires.every(type=>type==='webrtc'));
      await receiver.stop();receiver=undefined;
    }
    await app.stop();app=undefined;
    console.log('PASS all acknowledged WSS subscriptions recover after socket loss and serve exact WebRTC bytes');

    // Exhaust the process's entire ICE range with sockets owned by the fixture.
    // Occupy both address families: a UDP4 bind leaves IPv6 capacity available.
    // Native generation and incoming offers must fail without aborting the app.
    for(const port of [56000,56001])for(const family of ['udp4','udp6']){const socket=createSocket(family==='udp6'?{type:family,ipv6Only:true}:family);occupied.push(socket);await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(port,family==='udp4'?'0.0.0.0':'::',resolve)});}
    source=await seed(join(root,'blocked-source'),[19001],{tracker:{rtcConfig:{iceServers:[]}},announce:[tr.url]});
    app=await startApp(join(root,'exhaustion'),[],{env:{...env,FEEDTORRENT_ICE_PORT_RANGE:'56000-56001'}});
    await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[tr.url],webtorrent_stun_server:''}});
    await app.command({type:'add_magnet',uri:'magnet:?xt=urn:btih:'+source.id});
    await wait(()=>tr.announces.some(a=>a.hash===source.id&&Buffer.from(a.peer,'hex').toString().startsWith('-LT')&&a.offers===0),'native survives exhausted ICE ports and completes its announce');
    assert.equal((await app.api()).transfers.find(t=>t.id===source.id).verified,0);
    for(const socket of occupied.splice(0))await new Promise(r=>socket.close(r));
    await source.stop();const expected=source.originals[0],id=source.id;source=undefined;
    second=await seed(join(root,'recovered-source'),[19001],{tracker:{rtcConfig:{iceServers:[]}},announce:[other.url]});assert.equal(second.id,id);
    await app.command({type:'configure',settings:{...(await app.api()).settings,webtorrent_trackers:[other.url]}});
    await exact(app,second);
    assert.equal(hash(await readFile(join((await app.api()).transfers.find(t=>t.id===id).save_path,'source','file-0.bin'))),hash(expected));
    const ports=[...tr.announces,...other.announces].filter(a=>a.hash===id&&Buffer.from(a.peer,'hex').toString().startsWith('-LT')).flatMap(a=>a.icePorts);
    assert(ports.length>0&&ports.every(port=>port>=56000&&port<=56001));result.exhaustionRecovery=true;result.icePorts=[...new Set(ports)];
    console.log('PASS exhausted ICE ports do not abort native; released capacity downloads exact bytes without restart');
    await writeFile(evidencePath('webtorrent-recovery.json'),JSON.stringify({status:'PASS',...result},null,2)+'\n');
  }catch(error){console.error('WebRTC recovery diagnostics',JSON.stringify({error:error.message,referenceErrors:receiver?.errors,result,appLogs:app?.logs,announces:tr?.announces.slice(-15),otherAnnounces:other?.announces.slice(-15)}));throw error;}
  finally{setDefaultCACertificates(oldCAs);for(const socket of occupied)socket.close();await cleanup(root,receiver,app,source,second,tr,other);}
}

// Match the publisher's four components and three global trackers while the
// receiving library already contains unavailable metadata. Idle proposals
// must not prevent new native peers from discovering one another.
export async function libraryRegression({magnets=true}={}){
  const root=await temporary(),oldCAs=getCACertificates('default'),trackers=[];
  let source,receiver;const result={};
  try{
    for(let i=0;i<3;i++)trackers.push(await signaling(join(root,'tracker-'+i)));
    const pem=await Promise.all(trackers.map(t=>readFile(t.ca,'utf8'))),ca=join(root,'ca.pem');await writeFile(ca,pem.join(''));
    setDefaultCACertificates([...oldCAs,...pem]);const settings={webtorrent_trackers:trackers.map(t=>t.url),webtorrent_stun_server:''};
    const fixtures=[];
    for(let i=0;i<4;i++){
      const data=Buffer.alloc(1048576+i,31+i),pieces=[];
      for(let j=0;j<data.length;j+=16384)pieces.push(createHash('sha1').update(data.subarray(j,j+16384)).digest());
      const info={name:'part-'+i+'.bin',length:data.length,'piece length':16384,pieces:Buffer.concat(pieces)},id=createHash('sha1').update(bencode.encode(info)).digest('hex');
      fixtures.push({id,name:info.name,data,bytes:Array.from(bencode.encode({info}))});const dir=join(root,'source/downloads',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,info.name),data);
    }
    source=await startApp(join(root,'source'),[],{env:{...process.env,SSL_CERT_FILE:ca,FEEDTORRENT_ICE_PORT_RANGE:'58000-58199'}});
    await source.command({type:'configure',settings:{...(await source.api()).settings,...settings}});
    for(const f of fixtures){await source.command({type:'add_torrent',data:f.bytes});await wait(async()=>(await source.api()).transfers.find(t=>t.id===f.id)?.progress===1,'native library source ready');}
    await new Promise(r=>setTimeout(r,1000));
    receiver=await startApp(join(root,'receiver'),[],{env:{...process.env,SSL_CERT_FILE:ca,FEEDTORRENT_ICE_PORT_RANGE:'60000-60199'}});
    await receiver.command({type:'configure',settings:{...(await receiver.api()).settings,...settings}});
    for(let i=0;i<32;i++)await receiver.command({type:'add_magnet',uri:'magnet:?xt=urn:btih:'+createHash('sha1').update('unavailable-'+i).digest('hex')});
    await new Promise(r=>setTimeout(r,1000));const begin=performance.now();
    await Promise.all(fixtures.map(f=>receiver.command(magnets?{type:'add_magnet',uri:'magnet:?xt=urn:btih:'+f.id}:{type:'add_torrent',data:f.bytes})));
    await wait(async()=>{const x=await receiver.api();return fixtures.every(f=>x.transfers.find(t=>t.id===f.id)?.progress===1);},'four native components through three WSS trackers despite idle library offers',30000);
    result.seconds=(performance.now()-begin)/1000;
    for(const f of fixtures){const t=(await receiver.api()).transfers.find(t=>t.id===f.id);assert.equal(hash(await readFile(join(t.save_path,f.name))),hash(f.data));}
    console.log('PASS four native components '+(magnets?'fetch metadata and transfer':'transfer')+' exact bytes through three WSS trackers despite idle library offers');
    await writeFile(evidencePath(magnets?'webtorrent-library.json':'webtorrent-library-metainfo.json'),JSON.stringify({status:'PASS',unavailableTorrents:32,components:4,trackers:3,input:magnets?'magnets':'metainfo',...result},null,2)+'\n');
  }catch(error){console.error('Native library diagnostics',JSON.stringify({error:error.message,result,sourceState:await source?.api(),receiverState:await receiver?.api(),sourceLogs:source?.logs,receiverLogs:receiver?.logs,announces:trackers.map(t=>t.announces)}));throw error;}
  finally{setDefaultCACertificates(oldCAs);await cleanup(root,source,receiver,...trackers);}
}
