import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setDefaultCACertificates,getCACertificates} from 'node:tls';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {temporary,startApp,seed,reference,wait,complete,hash,cleanup,tracker} from './helpers.mjs';
import {evidencePath} from './runtime.mjs';
import {signaling} from './webtorrent-fixture.mjs';
import WebSocketTracker from 'bittorrent-tracker/websocket-tracker';
export async function admissionRegression() {
  // Node's RTC adapter does not report host-only gathering completion. With
  // no STUN in this local fixture, send its gathered host candidates after 100ms
  // instead of the adapter's five-second fallback. Actual RTC/data stay real.
  const createPeer=WebSocketTracker.prototype._createPeer;
  WebSocketTracker.prototype._createPeer=function(opts){return createPeer.call(this,{...opts,iceCompleteTimeout:100});};
  const root=await temporary(),oldCAs=getCACertificates('default'),samples=[];
  let tr,http,source,app,receiver,nativeSocket,lastOffer,nativeAnnounces=0,answers=0,flooding=false;
  const rss=()=>Number(execFileSync('ps',['-o','rss=','-p',String(app.child.pid)],{encoding:'utf8'}).trim());
  try {
    tr=await signaling(join(root,'tls'),{ipv4Only:true});tr.setOfferer('browser');
    setDefaultCACertificates([...oldCAs,await readFile(tr.ca,'utf8')]);
    const request=tr.tracker._onWebSocketRequest.bind(tr.tracker);
    tr.tracker._onWebSocketRequest=(socket,opts,data)=>{
      const m=JSON.parse(data.toString());
      if(m.peer_id?.startsWith('-LT')) {nativeSocket=socket;if(m.offers)nativeAnnounces++;if(m.answer){answers++;if(flooding)return;}}
      return request(socket,opts,data);
    };
    tr.tracker.ws.on('connection',socket=>{const send=socket.send;socket.send=function(data,...args){
      const m=JSON.parse(data.toString());if(socket===nativeSocket&&m.offer)lastOffer=m;
      return send.call(this,data,...args);
    };});
    http=await tracker();source=await seed(join(root,'source'),[65537],{tracker:true,announce:[http.http]});
    app=await startApp(join(root,'app'),[],{env:tr.env});
    const configure=trackers=>app.command({type:'configure',settings:{...(settings),webtorrent_trackers:trackers,webtorrent_stun_server:''}});
    const settings=(await app.api()).settings;
    await configure([]);await app.command({type:'add_torrent',data:source.bytes});await complete(app,source.id);
    const id=source.id,expected=source.originals[0];await source.stop();source=undefined;await http.stop();http=undefined;
    await configure([tr.url]);await wait(()=>nativeAnnounces===1,'initial native announce');const generation=nativeAnnounces;
    async function download(label) {
      receiver=await reference({tracker:{rtcConfig:{iceServers:[]}}});const started=performance.now();
      const dest=join(root,label),torrent=receiver.client.add('magnet:?xt=urn:btih:'+id,{path:dest,announce:[tr.url],getAnnounceOpts:()=>({numwant:1})});
      await wait(()=>torrent.done,label+' exact WebRTC download',4000);
      const bytes=await readFile(join(dest,'source','file-0.bin'));assert.equal(hash(bytes),hash(expected));
      samples.push({label,ms:performance.now()-started,bytes:bytes.length,sha256:hash(bytes)});
      await receiver.stop();receiver=undefined;
    }
    for(let n=1;n<=24;n++) {await download('sequential-'+n);assert.equal(nativeAnnounces,generation,'no native reannounce may refill admission');}
    console.log('PASS 24 sequential exact WebRTC downloads without a native reannounce');
    assert(lastOffer&&nativeSocket);const duplicate=JSON.stringify(lastOffer),beforeDuplicates=answers;
    for(let i=0;i<1000;i++)nativeSocket.send(duplicate);
    await new Promise(r=>setTimeout(r,100));assert.equal(answers,beforeDuplicates,'duplicates must not create negotiations');
    await download('after-duplicate-flood');assert.equal(nativeAnnounces,generation);
    console.log('PASS 1000 duplicate offers spend no admission credits; fresh client still downloads');
    // Keep ghost answers at the hostile tracker instead of routing them to a
    // disconnected peer; all injected offers must reach the live native socket.
    flooding=true;
    const beforeFlood=answers,rssBefore=rss(),floodStart=performance.now();
    for(let i=0;i<1000;i++) {const bytes=Buffer.alloc(20);bytes.writeUInt32BE(i+10000);nativeSocket.send(JSON.stringify({...lastOffer,offer_id:bytes.toString('binary')}));}
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native offer backlog did not drain')),4000);nativeSocket.once('pong',()=>{clearTimeout(timer);resolve();});nativeSocket.ping('admission-barrier');});
    await wait(()=>answers>beforeFlood,'bounded hostile offers answered',4000);
    await new Promise(r=>setTimeout(r,500));const floodAnswers=answers-beforeFlood,rssAfter=rss();
    assert(floodAnswers<=10,'concurrent unanswered negotiations remain bounded by 10');
    assert(rssAfter-rssBefore<64*1024,'hostile burst must not allocate unbounded RTC state');
    // Remove this private pinned fixture, cancelling all pending negotiations.
    // Recreate the exact payload in the same application process, not after a
    // 120-second expiry or application restart.
    const preview=await app.command({type:'preview_removal',target:{kind:'unpin',id}});
    await app.command({type:'set_pin',id,pinned:false,revision:preview.revision});
    await wait(async()=>{const s=await app.api();return !s.transfers.some(t=>t.id===id)&&s.cleanup.length===0;},'transfer detached',4000);
    flooding=false;
    http=await tracker();source=await seed(join(root,'recovery-source'),[65537],{tracker:true,announce:[http.http]});
    assert.equal(source.id,id);await app.command({type:'add_torrent',data:source.bytes});await complete(app,id);
    await source.stop();source=undefined;await http.stop();http=undefined;
    await download('after-hostile-cancellation');
    await writeFile(evidencePath('webtorrent-admission.json'),JSON.stringify({status:'PASS',samples,nativeAnnouncesBeforeFlood:generation,floodAnswers,floodMs:performance.now()-floodStart,rssBeforeKiB:rssBefore,rssAfterKiB:rssAfter},null,2)+'\n');
    console.log('PASS 1000 fresh hostile offers retain concurrent/RSS bounds; cancellation/reattach recovers exact transfer');
  } catch(error) {console.error(JSON.stringify({error:error.message,referenceErrors:receiver?.errors,announces:tr?.announces.slice(-15),appLogs:app?.logs}));throw error;} finally {WebSocketTracker.prototype._createPeer=createPeer;setDefaultCACertificates(oldCAs);await cleanup(root,receiver,app,source,tr,http);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await admissionRegression();
