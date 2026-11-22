import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bumpVersion,workspaceVersion} from '../scripts/version.mjs';
import {verifyVersion} from '../ci/package.mjs';

async function fixture(run){
  const root=await realpath(await mkdtemp(join(tmpdir(),'feedtorrent-version-test-')));
  const env={...process.env};
  for(const name of execFileSync('git',['rev-parse','--local-env-vars'],{encoding:'utf8'}).trim().split('\n'))delete env[name];
  const git=args=>execFileSync('git',args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{
    git(['init','--quiet','--template=']);
    git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['config','commit.gpgsign','false']);
    await writeFile(join(root,'Cargo.toml'),'[workspace]\nmembers = []\n[workspace.package]\nversion = "0.0.5-alpha"\nedition = "2021"\n[profile.release]\nlto = true\n');
    await writeFile(join(root,'Cargo.lock'),'version = 4\n\n[[package]]\nname = "feedtorrent"\nversion = "0.0.5-alpha"\n\n[[package]]\nname = "feedtorrent-bep"\nversion = "0.0.5-alpha"\n\n[[package]]\nname = "external"\nversion = "0.0.5-alpha"\nsource = "registry+https://example.invalid"\n');
    git(['add','.']);git(['-c','core.hooksPath=/dev/null','commit','--quiet','-m','Fixture']);
    await run({root,git});
  }finally{await rm(root,{recursive:true,force:true})}
}
test('unreleased workspace version is preserved despite unrelated tags',async()=>fixture(async({root,git})=>{
  git(['tag','v0.0.99-alpha']);
  assert.deepEqual(await bumpVersion(root),{version:'0.0.5-alpha',changed:false,reason:'untagged'});
  assert.equal(git(['status','--porcelain']),'');
}));
test('lightweight and annotated tags increment patch without staging or changing dependencies',async()=>{
  for(const annotated of [false,true])await fixture(async({root,git})=>{
    git(annotated?['tag','-a','v0.0.5-alpha','-m','Fixture']:['tag','v0.0.5-alpha']);
    const before=git(['ls-files','-s']);
    assert.deepEqual(await bumpVersion(root),{version:'0.0.6-alpha',previous:'0.0.5-alpha',changed:true});
    assert.equal(await workspaceVersion(root),'0.0.6-alpha');assert.equal(git(['ls-files','-s']),before);
    const lock=await readFile(join(root,'Cargo.lock'),'utf8');assert.equal((lock.match(/version = "0.0.6-alpha"/g)||[]).length,2);
    assert.match(lock,/name = "external"\nversion = "0.0.5-alpha"/);
    assert.equal((await bumpVersion(root)).changed,false);
    git(['add','Cargo.toml','Cargo.lock']);git(['-c','core.hooksPath=/dev/null','commit','--quiet','-m','Bump']);
    assert.equal((await bumpVersion(root)).reason,'untagged');
  });
});
test('tags on earlier commits and consecutive tags select the first unreleased patch',async()=>fixture(async({root,git})=>{
  git(['tag','v0.0.5-alpha']);git(['tag','v0.0.6-alpha']);
  git(['-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','Later']);
  assert.equal((await bumpVersion(root)).version,'0.0.7-alpha');
}));
test('staged, unstaged, untracked and dirty submodule changes prevent a bump',async()=>{
  for(const dirty of ['staged','unstaged','untracked','submodule'])await fixture(async({root,git})=>{
    if(dirty==='submodule'){
      await mkdir(join(root,'child'));const local=args=>execFileSync('git',args,{cwd:join(root,'child'),stdio:'pipe'});
      local(['init','--quiet','--template=']);local(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','Child']);
      git(['add','child']);git(['-c','core.hooksPath=/dev/null','commit','--quiet','-m','Child']);
      await writeFile(join(root,'child','untracked'),'dirty');
    }else{
      const file=dirty==='untracked'?'new.txt':'Cargo.toml';
      await writeFile(join(root,file),dirty==='untracked'?'new':(await readFile(join(root,file),'utf8'))+'\n');
      if(dirty==='staged')git(['add',file]);
    }
    git(['tag','v0.0.5-alpha']);
    const before=await readFile(join(root,'Cargo.toml'),'utf8'),index=git(['ls-files','-s']);
    assert.equal((await bumpVersion(root)).reason,'dirty');
    assert.equal(await readFile(join(root,'Cargo.toml'),'utf8'),before);assert.equal(git(['ls-files','-s']),index);
  });
});
test('package verification rejects stale executables, mismatched tags and version side effects',async()=>fixture(async({root})=>{
  const binary=join(root,'feedtorrent');
  const script=async body=>writeFile(binary,`#!${process.execPath}\n${body}\n`,{mode:0o755});
  await script('console.log("feedtorrent v0.0.5-alpha")');
  assert.equal(await verifyVersion(binary,'0.0.5-alpha'),'v0.0.5-alpha');
  assert.equal(await verifyVersion(binary,'0.0.5-alpha','v0.0.5-alpha'),'v0.0.5-alpha');
  await assert.rejects(verifyVersion(binary,'0.0.5-alpha','v0.0.6-alpha'),/Release tag differs/);
  await assert.rejects(verifyVersion(binary,'0.0.6-alpha'),/Executable differs/);
  await script('require("node:fs").mkdirSync("user");console.log("feedtorrent v0.0.5-alpha")');
  await assert.rejects(verifyVersion(binary,'0.0.5-alpha'),/created application data/);
}));
