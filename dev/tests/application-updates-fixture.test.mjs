import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseFixture} from './application-updates-fixture.mjs';

test('release fixture keeps certificate serial files inside its temporary directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feedtorrent-serial-'));
 let fixture;
 try{
  // LibreSSL derives an implicit serial path from the first period, including
  // one in a parent directory. Keep that failure inside this private sandbox.
  fixture=await releaseFixture(join(root,'.runtime','certificates'));
  assert.deepEqual(await readdir(root),['.runtime'],'Certificate generation wrote outside its fixture directory');
 }finally{
  try{await fixture?.close();}finally{await rm(root,{recursive:true,force:true});}
 }
});
