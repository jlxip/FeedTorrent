// Shared test artifacts; application state is always created below data/.
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const parent=resolve('.runtime/tests');mkdirSync(parent,{recursive:true});
export const runRoot=process.env.FEEDTORRENT_TEST_RUN_DIR?resolve(process.env.FEEDTORRENT_TEST_RUN_DIR):mkdtempSync(join(parent,'run-'));
mkdirSync(runRoot,{recursive:true});process.env.FEEDTORRENT_TEST_RUN_DIR=runRoot;
export function evidencePath(name=''){const dir=join(runRoot,'evidence');mkdirSync(dir,{recursive:true});return join(dir,name);}
export const isolatedUIFiles=['version.spec.ts','publication-status.spec.ts','dates.spec.ts'];
const started=performance.now(),sha=b=>createHash('sha256').update(b).digest('hex');
export function sourceHash(directory='.'){
 const base=resolve(directory),parent=resolve(base,'..');let files=[];
 // The managed mirror has no top-level .git. Its validated manifest is complete.
 if(existsSync(join(parent,'OWNER'))&&readFileSync(join(parent,'OWNER'),'utf8').startsWith('FeedTorrent reusable validation environment v1')&&existsSync(join(parent,'sources.json')))
  files=Object.keys(JSON.parse(readFileSync(join(parent,'sources.json'),'utf8')));
 else try{files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:base,encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean)}catch{}
 if(!files.length){
  // Small non-Git Make fixtures. Never traverse arbitrary workspace data.
  function walk(dir){for(const d of readdirSync(join(base,dir),{withFileTypes:true})){
   const p=join(dir,d.name);if(['.git','.runtime','.tools','target','node_modules','dist','test-results','__pycache__','downloads'].includes(d.name)||p==='backends/libtorrent/vendor')continue;
   if(d.isDirectory())walk(p);else if(d.isFile())files.push(p);
  }}
  for(const name of ['app','bep','posts','backends','dev','web'])if(existsSync(join(base,name)))walk(name);
  for(const name of ['Makefile','Cargo.toml','Cargo.lock','rust-toolchain.toml','.gitignore','.gitmodules','README.md'])if(existsSync(join(base,name)))files.push(name);
 }
 const entries=[...new Set(files)].filter(name=>!name.split('/').includes('__pycache__')&&existsSync(join(base,name))&&lstatSync(join(base,name)).isFile()).sort().map(name=>[name,sha(readFileSync(join(base,name)))]);
 return sha(JSON.stringify(entries));
}
const version=cmd=>{try{return execFileSync(cmd[0],cmd.slice(1),{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{return null}};
const record={command:process.argv,started_at:new Date().toISOString(),source_sha256:sourceHash(),node:process.version,rustc:version(['rustc','--version']),platform:process.platform,arch:process.arch,pid:process.pid,release_binary_sha256:existsSync('target/release/feedtorrent')?sha(readFileSync('target/release/feedtorrent')):null,state:'running'};
const output=join(runRoot,`process-${process.pid}.json`);writeFileSync(output,JSON.stringify(record,null,2)+'\n');
process.on('exit',code=>writeFileSync(output,JSON.stringify({...record,state:'finished',exit:code,seconds:(performance.now()-started)/1000},null,2)+'\n'));
