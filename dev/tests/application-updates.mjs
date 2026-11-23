import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,readFile,writeFile,mkdir,readdir,stat,chmod,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {temporary,startApp,cleanup,wait} from './helpers.mjs';
import {evidencePath} from './runtime.mjs';
import {releaseFixture,sha} from './application-updates-fixture.mjs';

const root=await temporary(),original=resolve(process.env.FEEDTORRENT_TEST_BINARY||'target/release/feedtorrent'),originalHash=sha(await readFile(original));
const selection=process.argv.find(s=>s.startsWith('--cases='))?.slice(8).split(',');
const enabled=id=>!selection||selection.includes(id);
const report={selection,cases:[],original,originalHash};let app,fixture;
const pass=name=>{report.cases.push(name);console.log('PASS '+name);};
async function check(){await app.api('/api/updates',{action:'check'});return wait(async()=>{const v=await app.api('/api/updates');return v.phase==='idle'&&v;},'release check');}
async function install(){const v=await check();assert(v.offer,v.check_error);const accepted=await app.api('/api/updates',{action:'install',offer:v.offer.id});return accepted.operation;}
try{
 fixture=await releaseFixture(join(root,'https'));await fixture.packageRelease();
 const executable=join(root,'feedtorrent');await copyFile(original,executable);
 const directory=join(root,'app');
 if(enabled('tls')){
 app=await startApp(directory,[],{binary:executable,env:{...fixture.env,FEEDTORRENT_UPDATE_TEST_CA:undefined}});
 await new Promise(r=>setTimeout(r,250));assert.equal(fixture.state.requests.length,0);
 assert.match((await check()).check_error,/certificate|connect|request/i);await app.stop();
 pass('isolated startup makes no automatic request and an untrusted HTTPS certificate fails');
 }
 if(enabled('rate')){
 app=await startApp(directory,[],{binary:executable,env:fixture.env});fixture.state.rate=true;
 const limited=await check();assert(limited.next_check>Date.now()/1000+3500,JSON.stringify(limited));assert(limited.check_error);assert.equal(limited.last_check,null);
 const rateCount=fixture.state.requests.length;await app.api('/api/updates',{action:'check'});await new Promise(r=>setTimeout(r,100));assert.equal(fixture.state.requests.length,rateCount);await app.stop();fixture.state.rate=false;
 pass('rate-limit errors remain distinct from up-to-date and manual checks honor Retry-After');
 }
 app=await startApp(directory,[],{binary:executable,env:{...fixture.env,FEEDTORRENT_UPDATE_SENTINEL:'preserved'},cwd:root});
 const before=await app.api('/api/updates');assert(before.supported);
 const {release}=await fixture.packageRelease('v99.0.0-rc10');
 fixture.state.releases=[...Array.from({length:100},(_,id)=>({id,tag_name:'v0.0.0',draft:false,prerelease:false,published_at:'2020',assets:[]})),{...release,id:999,tag_name:'v100.0.0',draft:true},
 {...release,id:1001,tag_name:'v101.0.0',prerelease:false,assets:[]},
 {...release,id:1002,tag_name:'v102.0.0',prerelease:false,assets:release.assets.map(a=>({...a,name:a.name.replace(release.tag_name,'v102.0.0').replace(fixture.target,'other-platform')}))},release];
 if(enabled('releases')){
 const selected=await check();assert.equal(selected.offer.version,'v99.0.0-rc10');assert(fixture.state.requests.some(p=>p.includes('page=2')));
 pass('paginated releases find prereleases beyond page one and ignore newer drafts and missing/incompatible packages');
 }
 if(enabled('coalesce')){
 const requests=fixture.state.requests.length;fixture.state.delay=200;
 await Promise.all(Array.from({length:5},()=>app.api('/api/updates',{action:'check'})));await wait(async()=>(await app.api('/api/updates')).phase==='idle');fixture.state.delay=0;
 assert.equal(fixture.state.requests.length-requests,2);
 pass('concurrent checks coalesce into one paginated request sequence');
 }
 if(enabled('api')){
 await assert.rejects(()=>app.api('/api/updates',{action:'install',offer:'client-supplied-url'}),/offer changed/i);
 assert.equal((await fetch(app.url+'/api/updates')).status,401);
 assert.equal((await fetch(app.url+'/api/updates',{method:'POST',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:'{"action":"check"}'})).status,403);
 const apiOffer=(await check()).offer.id;
 await assert.rejects(()=>app.api('/api/updates',{action:'install',offer:apiOffer,url:'https://evil.test'}),/deserialize|unknown|Invalid|Failed/i);
 pass('update API rejects foreign offers, missing session/Origin and extra path or URL fields');
 }
 if(enabled('packages')){
 for(const mode of ['checksum','traversal','link','wrong-version','probe-fail']){
  await fixture.packageRelease('v99.0.0',mode);const pid=app.child.pid;await install();
  const failed=await wait(async()=>{const v=await app.api('/api/updates');return v.phase==='idle'&&v.error&&v;},'reject '+mode);
  assert.equal(app.child.pid,pid);assert.equal(sha(await readFile(executable)),originalHash);assert.equal((await app.api()).ready,true);assert(failed.error);
  assert.deepEqual((await readdir(root)).filter(n=>n.startsWith('.feedtorrent-update-')),[]);
 }
 await assert.rejects(()=>stat(join(root,'escaped')),{code:'ENOENT'});
 pass('bad checksum, traversal, symlink, build version and startup probe preserve the executable and running data');
 }
 if(enabled('cancel')){
 await fixture.packageRelease();fixture.state.slow=true;const op=await install();
 await assert.rejects(()=>app.api('/api/updates',{action:'install',offer:(fixture.state.releases[0].id+'-901-902')}),/already running/);
 await app.api('/api/updates',{action:'cancel',operation:op});await wait(async()=>(await app.api('/api/updates')).phase==='idle');fixture.state.slow=false;
 assert.equal(sha(await readFile(executable)),originalHash);
 pass('only one installer runs and cancellation cleans private staging without stopping transfers');
 }
 if(enabled('space')&&process.platform==='linux'){
  const place=join(root,'full');await mkdir(place);const binary=join(place,'feedtorrent');await copyFile(original,binary);
  const flag=join(place,'full-active'),shim=join(place,'full.so');
  execFileSync('cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','dev/fixtures/application-update-enospc.c','-o',shim,'-ldl']);await writeFile(flag,'active');
  await fixture.packageRelease();let child;
  try{
   child=await startApp(join(place,'app'),[],{binary,env:{...fixture.env,LD_PRELOAD:shim,FEEDTORRENT_UPDATE_TEST_FULL:flag}});const pid=child.child.pid;
   const offer=async()=>{await child.api('/api/updates',{action:'check'});return wait(async()=>{const v=await child.api('/api/updates');return v.phase==='idle'&&v.offer;});};
   let selected=await offer();await child.api('/api/updates',{action:'install',offer:selected.id});
   const denied=await wait(async()=>{const v=await child.api('/api/updates');return v.phase==='idle'&&v.error&&v;},'ENOSPC while staging');
   assert.match(denied.error,/No space|os error 28/i);assert.equal(child.child.pid,pid);assert.equal((await child.api()).ready,true);assert.equal(sha(await readFile(binary)),originalHash);
   assert.deepEqual((await readdir(place)).filter(n=>n.startsWith('.feedtorrent-update-')),[]);
   await rm(flag);selected=await offer();const accepted=await child.api('/api/updates',{action:'install',offer:selected.id});
   await wait(async()=>{try{return (await child.api('/api/updates')).completed?.operation===accepted.operation;}catch{return false;}},'retry after disk space is restored');
   assert.equal(child.child.pid,pid);pass('ENOSPC staging preserves the executable and live data, cleans its files and permits a successful retry');
  }finally{if(child)await child.stop();}
 }
 if(enabled('readonly')&&process.getuid?.()===0)(report.skipped||=[]).push('readonly: root bypasses directory permissions');
 if(enabled('space')&&process.platform!=='linux')(report.skipped||=[]).push('space: Linux fault injection');
 if(enabled('readonly')&&process.getuid?.()!==0){
  await fixture.packageRelease();const mode=(await stat(root)).mode&0o777;
  try{
   await chmod(root,0o500);await install();
   const denied=await wait(async()=>{const v=await app.api('/api/updates');return v.phase==='idle'&&v.error&&v;},'unwritable executable directory');
   assert.match(denied.error,/not writable|denied|permission/i);assert.equal(sha(await readFile(executable)),originalHash);assert.equal((await app.api()).ready,true);
  }finally{await chmod(root,mode);}
  pass('unwritable executable directory fails before restart and preserves the running instance');
 }
 if(enabled('waiting')){
 const password='update integration backup password';await app.api('/api/publishing',{action:'create_key',password,confirmation:password});
 const backup=await app.api('/api/publishing/backup?prepare=true&full=true');
 const waiting=await install();await wait(async()=>{const v=await app.api('/api/updates');if(app.logs.includes('panicked'))throw Error(app.logs);if(v.phase==='idle'&&v.error)throw Error(v.error);return v.phase==='waiting';},'backup wait');
 await assert.rejects(()=>app.api('/api/publishing',{action:'create_post',title:'Blocked new sensitive work'}),/application update is waiting/);
 assert.equal((await app.api()).ready,true);
 await app.api('/api/updates',{action:'cancel',operation:waiting});await wait(async()=>(await app.api('/api/updates')).phase==='idle');
 await app.api('/api/publishing',{action:'create_post',title:'Allowed after cancel'});
 const body=await fetch(app.url+'/api/publishing/backup?token='+backup.token,{headers:{Cookie:app.cookie}});assert.equal(body.status,200);await body.arrayBuffer();
 pass('prepared backups delay restart, new sensitive work is rejected, and cancel resumes publication');
 }
 if(enabled('recovery')){
 await fixture.packageRelease('v99.0.0','exec-fail');const prior=await app.api('/api/updates');const recoverOperation=await install();
 const recovered=await wait(async()=>{try{const r=await fetch(app.url+'/');app.cookie=r.headers.get('set-cookie').split(';')[0];const r2=await fetch(app.url+'/api/updates',{headers:{Cookie:app.cookie}});const v=await r2.json();return v.instance!==prior.instance&&v.completed?.operation===recoverOperation&&v;}catch{return false;}},'restored binary after exec failure');
 assert.equal(recovered.completed.status,'recovered');assert.equal(sha(await readFile(executable)),originalHash);assert.equal(sha(await readFile(recovered.completed.recovery)),originalHash);assert.equal(app.child.exitCode,null);
 pass('exec failure restores and re-executes the verified old binary with the same PID');
 // Refresh the helper cookie after the intentional exec above.
 const cookie=app.cookie;app.api=async(path='/api/snapshot',body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:app.url,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 }
 if(enabled('success')){
 await fixture.packageRelease('v99.0.0');const pid=app.child.pid,successOperation=await install();
 const receipt=await wait(async()=>{try{return JSON.parse(await readFile(join(directory,'state/fixture-restarted.json'),'utf8'));}catch{return false;}},'independent future program started');
 assert.equal(receipt.pid,pid);assert.equal(receipt.cwd,root);assert.equal(receipt.sentinel,'preserved');assert(receipt.argv.includes('--no-open'));assert.equal(receipt.argv.at(-1),'--no-open');
 assert.equal(receipt.argv[receipt.argv.indexOf('--http-port')+1],new URL(app.url).port);
 const r=await fetch(app.url+'/api/updates');const final=await r.json();assert.equal(final.completed.operation,successOperation);assert.equal(final.current,'v99.0.0');
 assert.equal(sha(await readFile(final.completed.recovery)),originalHash);assert.notEqual(sha(await readFile(executable)),originalHash);
 pass('verified future program starts with the same PID, exact port, CWD, environment and arguments; backup survives');
 await app.stop();app=null;
 const journal=JSON.parse(await readFile(join(directory,'state/updates/install.json'),'utf8'));assert.equal(journal.status,'installed');
 }
 if(enabled('instances')){
  const place=join(root,'instances');await mkdir(place);const binary=join(place,'feedtorrent');await copyFile(original,binary);
  const servers=[],clients=[];
  try{
   const tags=['v99.0.0','v100.0.0'];
   for(let i=0;i<2;i++){
    const server=await releaseFixture(join(place,'https-'+i));servers.push(server);await server.packageRelease(tags[i]);
    clients.push(await startApp(join(place,'app-'+i),[],{binary,env:server.env}));
   }
   const select=async client=>{await client.api('/api/updates',{action:'check'});return wait(async()=>{const v=await client.api('/api/updates');return v.phase==='idle'&&v.offer;});};
   const offers=await Promise.all(clients.map(select));const pids=clients.map(c=>c.child.pid);
   const operations=await Promise.all(clients.map((c,i)=>c.api('/api/updates',{action:'install',offer:offers[i].id})));
   const states=await wait(async()=>{
    for(const c of clients)if(c.child.exitCode!==null||c.child.signalCode!==null)throw Error(c.logs);
    const values=await Promise.all(clients.map(c=>c.api('/api/updates').catch(()=>null)));
    return values.every((v,i)=>v&&(v.completed?.operation===operations[i].operation||v.phase==='idle'&&v.error))&&values;
   },'shared executable update coordination');
   const winner=states.findIndex((v,i)=>v.completed?.operation===operations[i].operation),loser=1-winner;
   assert(winner>=0);assert.equal(states[loser].current,before.current);assert.match(states[loser].error,/Another process|executable changed/i);
   assert.equal((await clients[loser].api()).ready,true);assert(clients.every(c=>c.child.exitCode===null));
   const installedHash=sha(await readFile(binary));
   // Reuse the exact winning package, served from the losing instance's own
   // trusted origin. It can restart into identical bytes already on disk.
   const won=servers[winner],lost=servers[loser];lost.state.releases=structuredClone(won.state.releases);
   for(const release of lost.state.releases)for(const asset of release.assets){
    const path=new URL(asset.browser_download_url).pathname;lost.state.assets.set(path,won.state.assets.get(path));asset.browser_download_url=lost.origin.slice(0,-1)+path;
   }
   const retry=await select(clients[loser]);const accepted=await clients[loser].api('/api/updates',{action:'install',offer:retry.id});
   await wait(async()=>{try{return (await clients[loser].api('/api/updates')).completed?.operation===accepted.operation;}catch{return false;}},'restart into the already installed identical executable');
   assert.equal(sha(await readFile(binary)),installedHash);assert.deepEqual(clients.map(c=>c.child.pid),pids);
   pass('two instances fence conflicting executable updates before stopping; identical installed bytes are reused with both PIDs preserved');
  }finally{
   for(const c of clients)await c.stop();for(const server of servers)await server.close();
  }
 }
 assert.equal(sha(await readFile(original)),originalHash);
 report.status='pass';
}catch(error){report.status='fail';report.error=String(error);throw error;}
finally{
 if(app)report.logs=app.logs;
 if(app)report.lastUpdate=await app.api('/api/updates').catch(e=>({error:String(e)}));
 try{await cleanup(root,app);}finally{if(fixture)await fixture.close();await writeFile(evidencePath('application-updates.json'),JSON.stringify(report,null,2)+'\n');}
}
