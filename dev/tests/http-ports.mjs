import {evidencePath} from './runtime.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {writeFile,stat} from 'node:fs/promises';
import {temporary,startApp,cleanup} from './helpers.mjs';

const root=await temporary(),apps=[],servers=[],ports=[8790,8791,8792];
const report={checks:[],status:'running'};
const check=name=>{report.checks.push(name);console.log('PASS',name)};
const port=app=>Number(new URL(app.url).port);
async function start(name,extra=[],options={}){
 const app=await startApp(join(root,name),extra,{defaultHttp:true,...options});apps.push(app);return app;
}
async function reserve(port){
 const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});servers.push(server);return server;
}
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
try{
 // Fail rather than disturb any existing user listener in the normal range.
 for(const p of ports)await reserve(p);
 for(const s of servers)await close(s);
 let a=await start('a'),b=await start('b'),c=await start('c');
 assert.deepEqual([a,b,c].map(port),ports);
 await assert.rejects(()=>start('fourth'),/Web ports already in use: 8790, 8791, 8792/);
 await assert.rejects(()=>start('a'),/already running with this data directory/);
 await assert.rejects(()=>start('explicit-busy',['--http-port','8790']),/Web ports already in use: 8790(?!,)/);
 check('three ordered ports; fourth, shared data and explicit occupied port rejected');
 for(const target of [a,b,c]){
  const expected=`ft_session_${port(target)}=`;assert(target.cookie.startsWith(expected));
  assert.equal((await fetch(target.url+'/api/snapshot')).status,401);
  const foreign=[a,b,c].find(x=>x!==target);
  assert.equal((await fetch(target.url+'/api/snapshot',{headers:{Cookie:foreign.cookie}})).status,401);
  assert.equal((await fetch(target.url+'/api/snapshot',{headers:{Cookie:target.cookie,Origin:foreign.url}})).status,403);
  assert.equal((await fetch(target.url+'/api/snapshot',{headers:{Cookie:[a,b,c].map(x=>x.cookie).join('; ')}})).status,200);
 }
 check('port cookies authenticate independently and reject foreign cookies and Origin');
 await b.stop();b=await start('b');assert.equal(port(b),8791);
 for(const app of apps)await app.stop();
 check('released port is reused with the same data directory');
 const external=await reserve(8790);const explicit=await start('explicit',['--http-port','8792']);assert.equal(port(explicit),8792);
 const skipped=await start('skip');assert.equal(port(skipped),8791);
 await explicit.stop();await skipped.stop();await close(external);
 const simultaneous=await Promise.all(['race-a','race-b','race-c'].map(name=>start(name)));
 assert.deepEqual(simultaneous.map(port).sort(),ports);
 await assert.rejects(()=>start('race-fourth'),/8790, 8791, 8792/);
 check('foreign listener skipped, explicit selection honored and simultaneous binds unique');
 const ephemeral=await Promise.all(['ephemeral-a','ephemeral-b','ephemeral-c','ephemeral-d'].map(name=>start(name,[],{defaultHttp:false})));
 assert.equal(new Set(ephemeral.map(port)).size,4);assert(ephemeral.every(app=>!ports.includes(port(app))));
 check('four isolated ephemeral instances coexist while all normal ports are occupied');
 for(const value of ['0','8789','8793','65535']){
  const dir=join(root,'invalid-'+value);
  const child=spawn(resolve('target/release/feedtorrent'),['--no-open','--http-port',value,'--data-dir',dir],{stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',b=>error+=b);
  const [code]=await once(child,'exit');assert.notEqual(code,0);assert.match(error,/--http-port must be 8790, 8791 or 8792/);
  await assert.rejects(()=>stat(dir),{code:'ENOENT'});
 }
 check('invalid normal CLI ports fail before creating application data');
 report.status='pass';
}catch(error){report.status='fail';report.error=String(error);throw error}
finally{
 for(const s of servers)if(s.listening)await close(s);
 await cleanup(root,...apps);await writeFile(evidencePath('http-ports.json'),JSON.stringify(report,null,2)+'\n');
}
