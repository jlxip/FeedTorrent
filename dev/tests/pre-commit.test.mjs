import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,copyFile,access,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const hook=resolve('.githooks/pre-commit');
const localVariables=execFileSync('git',['rev-parse','--local-env-vars'],{encoding:'utf8'}).trim().split('\n');
async function fixture(run){
  const root=await realpath(await mkdtemp(join(tmpdir(),'feedtorrent-hook-')));
  const env={...process.env};for(const name of localVariables)delete env[name];
  const project=join(root,'project'),foreign=join(project,'.runtime/foreign'),gitDir=join(project,'.runtime/foreign.git');
  const git=(args,cwd=project,extra={})=>execFileSync('git',args,{cwd,env:{...env,...extra},encoding:'utf8',stdio:['pipe','pipe','pipe']});
  try{
    await mkdir(project);git(['init','--quiet','--template=']);
    await writeFile(join(project,'.gitignore'),'/.runtime/\n');await writeFile(join(project,'source.txt'),'original\n');
    // All index setup belongs to disposable fixtures, never the user's index.
    git(['add','--','.gitignore','source.txt']);
    await mkdir(join(project,'.runtime/bin'),{recursive:true});
    git(['init','--quiet','--template=','--separate-git-dir='+gitDir,foreign]);
    await writeFile(join(foreign,'foreign.txt'),'foreign\n');git(['add','--','foreign.txt'],foreign);
    const called=join(project,'.runtime/make-called');
    await writeFile(join(project,'.runtime/bin/make'),`#!${process.execPath}
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
assert.deepEqual(process.argv.slice(2),['check','test']);
// Real foreign Git operation: inherited .git/index fails because .git is a file.
cp.execFileSync('git',['-C','.runtime/foreign','diff','--exit-code'],{stdio:'pipe'});
assert.equal(cp.execFileSync('git',['-C','.runtime/foreign','rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim(),process.env.EXPECTED_FOREIGN_GIT_DIR);
for(const name of ${JSON.stringify(localVariables)})assert(!Object.hasOwn(process.env,name),'Leaked '+name);
fs.writeFileSync(process.env.HOOK_CALLED,'check test\\n');process.exit(Number(process.env.MAKE_RESULT||0));
`,{mode:0o755});
    const invoke=(extra={},viaGit=false)=>spawnSync(viaGit?'git':'sh',viaGit?['-c','core.hooksPath='+resolve('.githooks'),'hook','run','pre-commit']:[hook],{cwd:project,env:{...env,PATH:join(project,'.runtime/bin')+':'+env.PATH,HOOK_CALLED:called,EXPECTED_FOREIGN_GIT_DIR:gitDir,...extra},encoding:'utf8'});
    const wasCalled=async()=>access(called).then(()=>true,()=>false);
    await run({project,git,invoke,wasCalled});
  }finally{await rm(root,{recursive:true,force:true})}
}
test('real Git hook keeps its selected index for guards and clears repository context before make',async()=>{
  await fixture(async({project,invoke,wasCalled})=>{
    for(const index of ['.git/index','.runtime/selected-index']){
      if(index!=='.git/index')await copyFile(join(project,'.git/index'),join(project,index));
      const result=invoke({GIT_INDEX_FILE:index,GIT_DIR:'.git',GIT_WORK_TREE:project,GIT_PREFIX:''},true);
      assert.equal(result.status,0,result.stderr);assert(await wasCalled());
    }
  });
});
test('an alternate index mismatch is rejected before environment cleanup',async()=>{
  await fixture(async({project,git,invoke,wasCalled})=>{
    const index=join(project,'.runtime/selected-index');await copyFile(join(project,'.git/index'),index);
    await writeFile(join(project,'.runtime/other-content'),'different staged content\n');
    const blob=git(['hash-object','-w','.runtime/other-content']).trim();
    git(['update-index','--cacheinfo','100644',blob,'source.txt'],project,{GIT_INDEX_FILE:index});
    const result=invoke({GIT_INDEX_FILE:index});assert.equal(result.status,1);assert.match(result.stderr,/stage or stash unstaged/);assert.equal(await wasCalled(),false);
  });
});
test('unstaged and untracked sources still block the hook',async()=>{
  await fixture(async({project,invoke,wasCalled})=>{
    await writeFile(join(project,'source.txt'),'unstaged\n');let result=invoke({GIT_INDEX_FILE:'.git/index'});
    assert.equal(result.status,1);assert.match(result.stderr,/stage or stash unstaged/);
    await writeFile(join(project,'source.txt'),'original\n');await writeFile(join(project,'untracked.txt'),'new\n');result=invoke();
    assert.equal(result.status,1);assert.match(result.stderr,/untracked source/);assert.equal(await wasCalled(),false);
  });
});
test('the hook propagates a failed check without creating a commit',async()=>{
  await fixture(async({invoke,wasCalled})=>{
    const result=invoke({GIT_INDEX_FILE:'.git/index',MAKE_RESULT:'23'});assert.equal(result.status,23,result.stderr);assert(await wasCalled());
  });
});
