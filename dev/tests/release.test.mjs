import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const script=resolve('dev/ci/publish.sh');
async function scenario(tag,options={}){
  const root=await mkdtemp(join(tmpdir(),'feedtorrent-release-test-'));await mkdir(join(root,'bin'));
  try{
    const log=join(root,'calls');
    await writeFile(join(root,'bin/gh'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify(args)+'\\n');if(args[1]==='view'){console.log(process.env.EXISTING_DRAFT||'');process.exit(process.env.EXISTING_DRAFT?0:1)}if(args[1]==='upload'&&process.env.FAIL_UPLOAD)process.exit(9);\n`,{mode:0o755});
    // macOS lacks sha256sum; provide the same checksum verifier interface locally.
    await writeFile(join(root,'bin/sha256sum'),`#!${process.execPath}\nconst fs=require('node:fs'),c=require('node:crypto');for(const name of process.argv.slice(2).filter(a=>!a.startsWith('-'))){const [hash,file]=fs.readFileSync(name,'utf8').trim().split(/\\s+/);if(c.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)process.exit(1)}\n`,{mode:0o755});
    for(const target of ['macos-arm64','linux-amd64','openbsd-8.0-amd64'].slice(0,options.missing?2:3)){
      const file=`feedtorrent-${tag}-${target}.tar.gz`,bytes=Buffer.from(target);
      await writeFile(join(root,file),bytes);await writeFile(join(root,file+'.sha256'),`${options.corrupt?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')}  ${file}\n`);
    }
    let code=0;try{execFileSync('sh',[script],{cwd:root,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,RELEASE_TAG:tag,CALL_LOG:log,EXISTING_DRAFT:options.existing||'',FAIL_UPLOAD:options.uploadFail?'1':''},stdio:'pipe'})}catch(e){code=e.status}
    const calls=(await readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
    return {code,calls};
  }finally{await rm(root,{recursive:true,force:true})}
}
test('complete stable and prerelease payloads publish only after upload',async()=>{
  for(const tag of ['v1.0.0','v1.0.0-rc47']){
    const {code,calls}=await scenario(tag);assert.equal(code,0);assert.deepEqual(calls.map(a=>a[1]),['view','create','upload','edit']);
    assert(calls.at(-1).includes('--prerelease='+String(tag.includes('-'))));
  }
});
test('incomplete or corrupted payloads never contact GitHub',async()=>{
  for(const options of [{missing:true},{corrupt:true}]){const {code,calls}=await scenario('v1.0.0',options);assert.notEqual(code,0);assert.equal(calls.length,0)}
});
test('invalid release names never contact GitHub',async()=>{
  for(const tag of ['release1','v','v1$bad']){const {code,calls}=await scenario(tag);assert.notEqual(code,0);assert.equal(calls.length,0)}
});
test('failed uploads stay draft and published releases cannot be overwritten',async()=>{
  const failed=await scenario('v1.0.0',{uploadFail:true});assert.notEqual(failed.code,0);assert(!failed.calls.some(a=>a[1]==='edit'));
  const published=await scenario('v1.0.0',{existing:'false'});assert.notEqual(published.code,0);assert.equal(published.calls.length,1);
  const draft=await scenario('v1.0.0',{existing:'true'});assert.equal(draft.code,0);assert(!draft.calls.some(a=>a[1]==='create'));
});
