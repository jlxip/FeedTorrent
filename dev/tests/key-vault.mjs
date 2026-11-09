// Current FTKV key storage; no protocol or live publishing operations.
import assert from 'node:assert/strict';
import {readFile,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {decryptVault} from './key-vault-fixture.mjs';
import {temporary,startApp,cleanup} from './helpers.mjs';
const root=await temporary();let app;
try{
 app=await startApp(join(root,'app'));const password='original vault test password',next='changed vault test password';
 const pub=c=>app.api('/api/publishing',c),file=join(root,'app/state/publishing.json');
 await pub({action:'create_key',password,confirmation:password});const {id}=await pub({action:'create_post',title:'Stable identity'});
 let library=JSON.parse(await readFile(file));const seed=decryptVault(library.vault,password),identity=library.vault.public_key,post=library.posts[id].magnet;
 const bytes=await readFile(file);
 await assert.rejects(pub({action:'change_password',old:'wrong',password:next,confirmation:next}),/Incorrect password/);assert.deepEqual(await readFile(file),bytes);
 await assert.rejects(pub({action:'change_password',old:password,password:next,confirmation:'different'}),/match/);assert.deepEqual(await readFile(file),bytes);
 const folder=join(root,'app/state'),mode=(await stat(folder)).mode & 0o777;
 await chmod(folder,0o500);
 try{await assert.rejects(pub({action:'change_password',old:password,password:next,confirmation:next}));}finally{await chmod(folder,mode);}
 assert.deepEqual(await readFile(file),bytes);
 await pub({action:'change_password',old:password,password:next,confirmation:next});library=JSON.parse(await readFile(file));assert.equal(library.vault.public_key,identity);assert.equal(library.posts[id].magnet,post);assert.deepEqual(decryptVault(library.vault,next),seed);assert.throws(()=>decryptVault(library.vault,password));
 assert.equal((await stat(file)).mode&0o777,0o600);
 await app.stop();app=await startApp(join(root,'app'));
 assert.equal((await app.api()).publishing.public_key,identity);assert.equal((await app.api()).publishing.posts[0].magnet,post);
 assert.deepEqual(decryptVault(JSON.parse(await readFile(file)).vault,next),seed);
 assert(!app.logs.includes(password));assert(!app.logs.includes(next));seed.fill(0);
 console.log('PASS: independent Node/Rust FTKV interoperability, atomic password change, permissions and restart preserve identity');
}finally{await cleanup(root,app);}
