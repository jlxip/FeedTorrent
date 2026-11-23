import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {randomBytes,createHmac} from 'node:crypto';
import {readFile,stat,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import Wire from 'bittorrent-protocol';
import bencode from 'bencode';
import {temporary,startApp,seed,exact,wait,cleanup} from './helpers.mjs';

const directory=await temporary();let app,source,otherSource;const sockets=new Set();
async function identify(app,id,root,{version=1,size=0,watch=false,unsupported=false}={}) {
    const port=(await app.api()).listen_port,wire=new Wire(),socket=connect(port,'127.0.0.1');sockets.add(socket);
    let answer,handshake;const errors=[];socket.on('error',e=>errors.push(e));wire.on('error',e=>errors.push(e));
    class Replica {
        onExtendedHandshake(value){handshake=value;wire.extended('ft_replica',size?new Uint8Array(size):{v:version,root,...(watch?{watch:1}:{})});}
        onMessage(bytes){answer=bencode.decode(bytes);}
    }
    Replica.prototype.name='ft_replica';wire.use(Replica);
    socket.pipe(wire).pipe(socket);wire.handshake(id,randomBytes(20));
    await wait(()=>handshake||errors[0],'replica extension handshake');if(errors[0])throw errors[0];
    if(version!==1||size||unsupported){await new Promise(r=>setTimeout(r,200));assert.equal(answer,undefined);socket.destroy();wire.destroy();sockets.delete(socket);return;}
    await wait(()=>answer||errors[0],'replica scoped identity');if(errors[0])throw errors[0];
    assert.equal(answer.v,1);assert.deepEqual(Buffer.from(answer.root),root);assert.equal(answer.node.length,32);
    assert.equal(answer.parts,undefined,'arbitrary scopes must not expose other torrents');
    const node=Buffer.from(answer.node);socket.destroy();wire.destroy();sockets.delete(socket);return node;
}
try {
    source=await seed(join(directory,'source'),[32769]);
    otherSource=await seed(join(directory,'other-source'),[32770]);
    app=await startApp(join(directory,'receiver'));
    await app.command({type:'add_magnet',uri:`magnet:?xt=urn:btih:${source.id}&x.pe=127.0.0.1:${source.client.torrentPort}`});
    await exact(app,source);
    const root=Buffer.from(source.id,'hex'),first=await identify(app,source.id,root);
    assert.deepEqual(await identify(app,source.id,root),first);
    assert.deepEqual(await identify(app,source.id,root,{watch:true}),first);
    await app.command({type:'add_magnet',uri:`magnet:?xt=urn:btih:${otherSource.id}&x.pe=127.0.0.1:${otherSource.client.torrentPort}`});await exact(app,otherSource);
    assert.notDeepEqual(await identify(app,otherSource.id,Buffer.from(otherSource.id,'hex')),first);
    await identify(app,source.id,Buffer.alloc(20,18),{unsupported:true});
    await identify(app,source.id,root,{version:2});await identify(app,source.id,root,{size:129});
    await app.stop();app=await startApp(join(directory,'receiver'));
    assert.deepEqual(await identify(app,source.id,root),first);
    const keyPath=join(directory,'receiver','state','replica-id.key');
    const key=await readFile(keyPath);assert.equal(key.length,32);assert.equal((await stat(keyPath)).mode&0o777,0o600);
    assert.deepEqual(first,createHmac('sha256',key).update('FeedTorrent/ft_replica/v1\0').update(root).digest());
    await app.stop();app=await startApp(join(directory,'other'));
    await app.command({type:'add_magnet',uri:`magnet:?xt=urn:btih:${source.id}&x.pe=127.0.0.1:${source.client.torrentPort}`});await exact(app,source);
    assert.notDeepEqual(await identify(app,source.id,root),first);
    await app.stop();
    // A damaged key is never regenerated silently; payload transport still works.
    await writeFile(keyPath,Buffer.alloc(3));await chmod(keyPath,0o600);
    app=await startApp(join(directory,'receiver'));await wait(async()=>(await app.api()).warning.includes('Replica identification unavailable'),'invalid identity warning');
    assert.equal((await readFile(keyPath)).length,3);
    console.log('PASS replica identity: stable restart, publication scoping, distinct instances, HMAC, limits, permissions and damaged-key preservation');
}finally{for(const socket of sockets)socket.destroy();await app?.stop();await source?.stop();await otherSource?.stop();await cleanup(directory);}
