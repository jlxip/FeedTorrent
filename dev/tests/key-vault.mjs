// Key storage / migration only; no protocol or live publishing operations.
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {decryptVault,encryptVault} from './key-vault-fixture.mjs';
import {encryptAge} from './age-fixture.mjs';
import {temporary,startApp,cleanup} from './helpers.mjs';
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
execFileSync('python3',['dev/tests/key-migration.py'],{env,stdio:'inherit'});
const root=await temporary();let app;
try{
 app=await startApp(join(root,'app'));const password='original vault test password',next='changed vault test password';
 const pub=c=>app.api('/api/publishing',c),file=join(root,'app/state/publishing/library.json');
 await pub({action:'create_key',password,confirmation:password});const {id}=await pub({action:'create_post',title:'Stable identity'});
 let library=JSON.parse(await readFile(file));const seed=decryptVault(library.vault,password),identity=library.vault.public_key,post=library.posts[id].magnet;
 let bytes=await readFile(file);
 await assert.rejects(pub({action:'change_password',old:'wrong',password:next,confirmation:next}),/Incorrect password/);assert.deepEqual(await readFile(file),bytes);
 await assert.rejects(pub({action:'change_password',old:password,password:next,confirmation:'different'}),/match/);assert.deepEqual(await readFile(file),bytes);
 const folder=join(root,'app/state/publishing'),mode=(await stat(folder)).mode & 0o777;
 await chmod(folder,0o500);
 try{await assert.rejects(pub({action:'change_password',old:password,password:next,confirmation:next}));}finally{await chmod(folder,mode);}
 assert.deepEqual(await readFile(file),bytes);
 await pub({action:'change_password',old:password,password:next,confirmation:next});library=JSON.parse(await readFile(file));assert.equal(library.vault.public_key,identity);assert.equal(library.posts[id].magnet,post);assert.deepEqual(decryptVault(library.vault,next),seed);assert.throws(()=>decryptVault(library.vault,password));
 const legacy=structuredClone(library);legacy.vault.ciphertext=Array.from(encryptAge(seed,next));
 const archive=execFileSync('python3',['-c',"import io,json,sys,tarfile; data=json.dumps({'version':1,'full':False,'library':json.load(sys.stdin)}).encode(); stream=io.BytesIO(); t=tarfile.open(fileobj=stream,mode='w'); h=tarfile.TarInfo('manifest.json'); h.size=len(data); t.addfile(h,io.BytesIO(data)); t.close(); sys.stdout.buffer.write(stream.getvalue())"],{input:JSON.stringify(legacy)});
 bytes=await readFile(file);
 const imported=await fetch(app.url+'/api/publishing/import',{method:'POST',headers:{Cookie:app.cookie,Origin:app.url,'Content-Type':'application/x-tar','X-FeedTorrent-Password':Buffer.from(next).toString('hex')},body:archive});assert.equal(imported.status,400);assert.match(await imported.text(),/Legacy age\/scrypt/);assert.deepEqual(await readFile(file),bytes);
 await app.stop();await writeFile(file,JSON.stringify(legacy));const legacyBytes=await readFile(file);app=await startApp(join(root,'app'));assert.match((await app.api()).publishing.error,/Legacy age\/scrypt/);await assert.rejects(pub({action:'create_key',password,confirmation:password}),/Legacy age\/scrypt/);assert.deepEqual(await readFile(file),legacyBytes);
 assert.throws(()=>execFileSync('python3',['dev/scripts/migrate-publishing-key.py','--data-dir',join(root,'app/state')],{env,stdio:['ignore','pipe','pipe']}),e=>{assert.match(e.stderr.toString(),/Stop FeedTorrent/);return true;});assert.deepEqual(await readFile(file),legacyBytes);await app.stop();assert.deepEqual(await readFile(file),legacyBytes);
 execFileSync('python3',['-c',"import importlib.util,json,sys; s=importlib.util.spec_from_file_location('migration','dev/scripts/migrate-publishing-key.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=json.load(sys.stdin); m.migrate(v['path'],lambda:v['password'])"],{env,input:JSON.stringify({path:join(root,'app/state'),password:next})});
 const migrated=JSON.parse(await readFile(file));assert.deepEqual(decryptVault(migrated.vault,next),seed);const compare=structuredClone(migrated);compare.vault.ciphertext=legacy.vault.ciphertext;assert.deepEqual(compare,legacy);assert.equal((await stat(file)).mode&0o777,0o600);
 bytes=await readFile(file);const timestamp=(await stat(file)).mtimeMs;assert.match(execFileSync('python3',['dev/scripts/migrate-publishing-key.py','--data-dir',join(root,'app/state')],{env,encoding:'utf8'}),/Already Argon2id/);assert.deepEqual(await readFile(file),bytes);assert.equal((await stat(file)).mtimeMs,timestamp);
 app=await startApp(join(root,'app'));assert.equal((await app.api()).publishing.public_key,identity);assert.equal((await app.api()).publishing.posts[0].magnet,post);assert(!app.logs.includes(password));assert(!app.logs.includes(next));seed.fill(0);
 console.log('PASS: Node/Rust/Python interoperability, atomic password change, legacy rejection, live lock and one-off migration');
}finally{await cleanup(root,app);}
