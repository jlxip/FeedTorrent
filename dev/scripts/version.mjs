import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const semantic=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
function declaration(text){
  const section=text.match(/^\[workspace\.package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const version=section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert(version&&semantic.test(version),'Missing or invalid workspace package version');
  return version;
}
export async function workspaceVersion(root='.'){
  return declaration(await readFile(join(root,'Cargo.toml'),'utf8'));
}

// Explicit task-start operation only. Builds, hooks and application startup never call it.
export async function bumpVersion(root='.'){
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  assert.equal(resolve(git(['rev-parse','--show-toplevel'])),resolve(root),'Run from the repository root');
  const manifestPath=join(root,'Cargo.toml'),lockPath=join(root,'Cargo.lock');
  const manifest=await readFile(manifestPath,'utf8'),current=declaration(manifest);
  if(git(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']))
    return {version:current,changed:false,reason:'dirty'};
  let version=current;
  for(;;){
    const tag=spawnSync('git',['show-ref','--verify','--quiet',`refs/tags/v${version}`],{cwd:root});
    if(tag.error)throw tag.error;
    if(tag.status===1)break;
    assert.equal(tag.status,0,'Cannot inspect local version tag');
    const [,major,minor,patch,suffix]=version.match(semantic);
    version=`${major}.${minor}.${BigInt(patch)+1n}${suffix}`;
  }
  if(version===current)return {version,changed:false,reason:'untagged'};
  const lock=await readFile(lockPath,'utf8');let packages=0;
  const updated=lock.replace(/(^\[\[package\]\]\n[\s\S]*?)(?=^\[\[package\]\]|$(?![\s\S]))/gm,block=>{
    if(!/^name = "feedtorrent(?:-[a-z0-9-]+)?"$/m.test(block)||/^source = /m.test(block))return block;
    assert(block.includes(`\nversion = "${current}"\n`),'Workspace lockfile version mismatch');
    packages++;
    return block.replace(`\nversion = "${current}"\n`,`\nversion = "${version}"\n`);
  });
  assert(packages>0,'Missing workspace packages in Cargo.lock');
  await writeFile(lockPath,updated);
  try{await writeFile(manifestPath,manifest.replace(/(^\[workspace\.package\]\s*\n[\s\S]*?^version\s*=\s*")[^"]+/m,`$1${version}`))}
  catch(error){await writeFile(lockPath,lock);throw error}
  return {version,previous:current,changed:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  assert.deepEqual(process.argv.slice(2),['--bump'],'Usage: node dev/scripts/version.mjs --bump');
  console.log(JSON.stringify(await bumpVersion()));
}
