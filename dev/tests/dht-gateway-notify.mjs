import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {postFixture} from './post-fixtures.mjs';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';
import {freePort} from './dht-gateway-fixture.mjs';
import {signed,jsonRecord,hex} from '../fixtures/bep50-node.mjs';
import {evidencePath} from './runtime.mjs';
const root=await temporary(),report={checks:[],status:'running'};let fx,gateway,receiver;
const renewed=new Set(),observers=[];
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
const post=async app=>(await app.api()).posts.find(p=>p.id===fx.postId);
try {
    fx=await postFixture(root);
    const initial=signed(Buffer.alloc(32,77),1,{ih:Buffer.from(fx.head.id,'hex')},Buffer.from([1,255]));
    // A first Follow also renews the signed record. Its lookup updates
    // last_checked_ms independently of the 15-minute polling interval.
    for(const node of fx.nodes){
        const observe=(query,peer)=>{
            const a=query.a;
            if(query.q?.toString()==='put'&&a?.k&&hex(a.k)===hex(initial.k)&&hex(a.salt||[])===hex(initial.salt))renewed.add(peer.port);
        };
        node._rpc.on('query',observe);observers.push([node._rpc,observe]);
    }
    const args=['--dht-bootstrap',fx.bootstrap];
    gateway=await startApp(join(root,'gateway'),args);
    receiver=await startApp(join(root,'receiver'),args);
    const port=await freePort(),url='http://127.0.0.1:'+port;
    await gateway.command({type:'configure',settings:{...(await gateway.api()).settings,dht_gateway:{enabled:true,allow_publish:true,listen:'127.0.0.1:'+port}}});
    const config={name:'Gateway notifications',mode:'mirror_all',automatic_limit:8*1024*1024};
    for(const app of [gateway,receiver])await app.command({type:'follow_post',uri:fx.postMagnet,config});
    await wait(async()=>{const a=await post(gateway),b=await post(receiver);return a?.sequence==='1'&&b?.sequence==='1'&&a.update_peers>0&&b.update_peers>0;},'initial records and real BEP50 contacts');
    const ports=[(await gateway.api()).listen_port,(await receiver.api()).listen_port];
    await wait(()=>ports.every(port=>renewed.has(port)),'both initial signed-record renewals reach independent DHT nodes');
    // A PUT on the wire can precede its terminal ACK. A setup refresh queues
    // behind that renewal; its completed lookup is the barrier before seq 2
    // exists. No refresh is issued during the live-update measurement below.
    for(const app of [gateway,receiver]){
        // The snapshot endpoint is cached. This read command publishes the
        // engine's current view, including the renewal lookup preceding its PUT.
        await app.command({type:'news_page',offset:0,hide_read:false});
        const before=(await post(app)).last_checked_ms;
        await app.command({type:'refresh_post',id:fx.postId});
        await wait(async()=>{const p=await post(app);return p?.last_checked_ms>before&&p.sequence==='1'&&!p.error;},'setup lookup completes after the initial renewal');
    }
    pass('both initial follower renewals and setup lookups complete before measuring live adoption');
    const next=await fx.catalog('Gateway update',[{path:['note.txt'],data:Buffer.from('Published through HTTP, delivered through BEP50')}]);
    const record=signed(Buffer.alloc(32,77),2,{ih:Buffer.from(next.id,'hex')},Buffer.from([1,255]));
    const put=async r=>{
        const body=jsonRecord(r),response=await fetch(url+'/dht/mutable/'+body.key+'?salt='+body.salt,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence:body.sequence,signature:body.signature,value:body.value})});
        const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert(result.acknowledged_nodes>0);return result;
    };
    const checked=[(await post(gateway)).last_checked_ms,(await post(receiver)).last_checked_ms];
    report.initial_renewal_ports=ports;report.checked_before=checked;
    const started=performance.now();await put(record);
    await wait(async()=>(await post(gateway))?.sequence==='2'&&(await post(receiver))?.sequence==='2','gateway and BEP50 receiver adopt without polling');
    report.adoption_ms=performance.now()-started;
    report.checked_after=[(await post(gateway)).last_checked_ms,(await post(receiver)).last_checked_ms];
    assert.deepEqual(report.checked_after,checked,'no periodic lookup or manual refresh may explain adoption');
    pass('HTTP signed PUT immediately updates followed gateway and remote BEP50 receiver without another DHT check');
    for(const app of [gateway,receiver])await wait(async()=>(await app.api()).transfers.some(t=>t.id===next.id&&t.state==='Seeding'),'new catalog replicated');
    pass('both followed nodes acquire and verify the newly announced catalog');
    await put(record);
    assert.equal((await post(gateway)).sequence,'2');assert.equal((await post(receiver)).sequence,'2');
    pass('idempotent PUT preserves the accepted version');
    await gateway.deletePost('followed',fx.postId);
    const unknown=signed(Buffer.alloc(32,78),1,{ih:Buffer.alloc(20,29)},Buffer.from('unfollowed'));
    await put(unknown);await put(record);
    const state=await gateway.api();assert.deepEqual(state.posts,[]);assert(!state.transfers.some(t=>t.id===hex(unknown.v.ih)));
    pass('unknown and unfollowed publications keep HTTP semantics without automatic follows or payload');
    report.status='PASS';
} catch(error) {report.status='FAIL';report.error=String(error.stack);throw error;}
finally {for(const [rpc,observe] of observers)rpc.off('query',observe);await receiver?.stop();await gateway?.stop();await fx?.stop();await cleanup(root);await writeFile(evidencePath('dht-gateway-notify.json'),JSON.stringify(report,null,2)+'\n');}
