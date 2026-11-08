import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'feedtorrent-test-deps-'));
  try{
    for(const dir of ['dev/scripts','dev/node_modules/node-datachannel','dev/node_modules/.bin','bin'])await mkdir(join(root,dir),{recursive:true});
    await copyFile('dev/scripts/test-deps.sh',join(root,'dev/scripts/test-deps.sh'));
    const attempts=join(root,'attempts'),pauses=join(root,'pauses');
    await writeFile(join(root,'bin/uname'),'#!/bin/sh\necho Linux\n',{mode:0o755});
    await writeFile(join(root,'bin/sleep'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$PAUSES"\n',{mode:0o755});
    await writeFile(join(root,'dev/node_modules/.bin/prebuild-install'),`#!/bin/sh
set -eu
test "$*" = '-r napi --verbose'
count=0
if [ -f "$ATTEMPTS" ]; then count=$(cat "$ATTEMPTS"); fi
count=$((count + 1)); printf '%s\\n' "$count" > "$ATTEMPTS"
if [ "$count" -lt "$SUCCESS_AT" ]; then echo 'Request timed out' >&2; exit 17; fi
mkdir -p build/Release
printf binary > build/Release/node_datachannel.node
`,{mode:0o755});
    const invoke=(successAt=1)=>spawnSync('sh',['dev/scripts/test-deps.sh'],{cwd:root,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,ATTEMPTS:attempts,PAUSES:pauses,SUCCESS_AT:String(successAt)},encoding:'utf8',timeout:5000});
    const count=async()=>Number(await readFile(attempts,'utf8').catch(()=>0));
    const sleeps=async()=>(await readFile(pauses,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean);
    await run({root,invoke,count,sleeps});
  }finally{await rm(root,{recursive:true,force:true})}
}
test('a transient prebuild timeout recovers without repeating successful preparation',async()=>{
  await fixture(async({invoke,count,sleeps})=>{
    const result=invoke(2);assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Request timed out/);
    assert.equal(await count(),2);assert.deepEqual(await sleeps(),['5']);
    assert.equal(invoke(99).status,0);assert.equal(await count(),2);assert.deepEqual(await sleeps(),['5']);
  });
});
test('a permanent prebuild failure stops after three attempts and remains an error',async()=>{
  await fixture(async({invoke,count,sleeps})=>{
    const result=invoke(99);assert.equal(result.status,17,result.stderr);assert.equal(await count(),3);
    assert.deepEqual(await sleeps(),['5','5']);assert.match(result.stderr,/failed after 3 attempts/);
  });
});
test('an existing prebuild skips all download attempts and waits',async()=>{
  await fixture(async({root,invoke,count,sleeps})=>{
    const build=join(root,'dev/node_modules/node-datachannel/build/Release');await mkdir(build,{recursive:true});await writeFile(join(build,'node_datachannel.node'),'cached');
    assert.equal(invoke(99).status,0);assert.equal(await count(),0);assert.deepEqual(await sleeps(),[]);
  });
});
