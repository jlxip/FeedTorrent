import assert from 'node:assert/strict';
import {createPrivateKey,createPublicKey,createHash,sign} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import bencode from 'bencode';
import {temporary,cleanup} from './helpers.mjs';
import {fixture,hex} from './dht-gateway-fixture.mjs';
import {evidencePath} from './runtime.mjs';
const root=await temporary();let f;const report={status:'running',checks:[]};
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
try{
 f=await fixture(root);
 const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,77)]),type:'pkcs8',format:'der'});
 const key=createPublicKey(privateKey).export({type:'spki',format:'der'}).subarray(-32),salt=Buffer.from('public-signed-test');
 const value={ih:Buffer.alloc(20,31)},sequence=9007199254740994;
 const bytes=Buffer.from(bencode.encode({salt,seq:sequence,v:value})).subarray(1,-1);
 const input={sequence:String(sequence),signature:hex(sign(null,bytes,privateKey)),value:hex(bencode.encode(value))};
 const path=f.url+'/dht/mutable/'+hex(key)+'?salt='+hex(salt),expected={key:hex(key),salt:hex(salt),...input};
 const put=async body=>fetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await put(input)).status,403);assert.equal((await fetch(path)).status,404);
 pass('legacy/default gateway refuses signed writes without storing a record');
 const previous=(await f.app.api()).settings;
 await f.app.command({type:'configure',settings:{...previous,dht_gateway:{...previous.dht_gateway,allow_publish:true}}});
 for(const body of [{...input,signature:'00'.repeat(64)},{...input,sequence:'01'},{...input,value:'ff'.repeat(1001)}, {...input,private_key:'never accepted'}])assert.equal((await put(body)).status,400);
 assert.equal((await put(' '.repeat(8193))).status,413);assert.equal((await fetch(path)).status,404);
 pass('bad signatures, sequence, payload, unknown fields and oversize body rejected before storage');
 const response=await put(input);assert.equal(response.status,200,await response.clone().text());
 const result=await response.json();assert(result.acknowledged_nodes>0);assert.equal(result.target,createHash('sha1').update(key).update(salt).digest('hex'));
 assert.deepEqual(await (await fetch(path)).json(),expected);
 assert.equal(response.headers.get('access-control-allow-origin'),'*');assert(response.headers.get('access-control-allow-methods').includes('PUT'));assert(!response.headers.has('set-cookie'));
 pass('HTTP signed PUT reaches real private DHT, receives ACK and returns exact large-sequence record');
 await f.app.command({type:'configure',settings:{...previous,dht_gateway:{...previous.dht_gateway,allow_publish:false}}});
 assert.equal((await put(input)).status,403);assert.deepEqual(await (await fetch(path)).json(),expected);
 const state=await f.app.api();assert.deepEqual(state.transfers,[]);assert.equal(state.settings.dht_gateway.allow_publish,false);
 pass('hot disable preserves reads, native app data and existing record');report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error);throw error;}
finally{await f?.app.stop();await f?.network.stop();await cleanup(root);await writeFile(evidencePath('dht-gateway-write.json'),JSON.stringify(report,null,2)+'\n');}
