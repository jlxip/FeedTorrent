// Thin adapter around Playwright: collect with its filters, then use its test lists.
// This partitions declared resource pools; it does not select tests by source changes.
import {runRoot,isolatedUIFiles} from '../tests/runtime.mjs';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
const cli='dev/node_modules/playwright/cli.js',base=['test','--config','dev/playwright.config.ts'],args=process.argv.slice(2);
// Pool sizing, artifacts and retry policy belong to the checked-in configuration.
for(const arg of args)if(/^--(workers|retries|config|output|reporter|pass-with-no-tests|test-list|test-list-invert|shard|last-failed|only-changed)(=|$)/.test(arg)||/^-[jc]/.test(arg))throw Error(`Managed UI option: ${arg}`);
const collection=spawnSync(process.execPath,[cli,...base,...args,'--list','--reporter=json'],{encoding:'utf8',maxBuffer:32*1024*1024});
if(collection.status!==0){process.stdout.write(collection.stdout||'');process.stderr.write(collection.stderr||'');process.exit(collection.status||1)}
const report=JSON.parse(collection.stdout);if(report.errors?.length)throw Error(JSON.stringify(report.errors));
const pools={isolated:[],serial:[]};
function visit(suites,titles=[]){for(const suite of suites||[]){
 const nested=suite.title===suite.file?titles:[...titles,suite.title];
 for(const spec of suite.specs||[])for(const test of spec.tests||[]){
  const file=spec.file||suite.file,line=`[${test.projectName}] › ${file} › ${[...nested,spec.title].join(' › ')}`;
  pools[isolatedUIFiles.includes(basename(file))?'isolated':'serial'].push(line);
 }visit(suite.suites,nested);
}}
visit(report.suites);
const selected=pools.isolated.length+pools.serial.length;if(!selected)throw Error('No UI tests selected; check UI_ARGS.');
if(args.includes('--list')){console.log([...pools.isolated,...pools.serial].join('\n'));process.exit(0)}
const summaries=[];
for(const pool of ['isolated','serial']){
 if(!pools[pool].length)continue;
 const list=join(runRoot,`${pool}-tests.txt`);writeFileSync(list,pools[pool].join('\n')+'\n');
 console.log(`Playwright ${pool}: ${pools[pool].length} selected; ${pool==='isolated'?2:1} workers; artifacts ${runRoot}`);
 const started=performance.now();
 const r=spawnSync(process.execPath,[cli,...base,...args,'--test-list',list],{stdio:'inherit',env:{...process.env,FEEDTORRENT_UI_POOL:pool}});
 const result=JSON.parse(readFileSync(join(runRoot,`${pool}-results.json`),'utf8'));
 summaries.push({pool,selected:pools[pool].length,seconds:(performance.now()-started)/1000,stats:result.stats});
 writeFileSync(join(runRoot,'ui-summary.json'),JSON.stringify(summaries,null,2)+'\n');
 const counted=['expected','unexpected','flaky','skipped'].reduce((n,k)=>n+result.stats[k],0);
 if(counted!==pools[pool].length){console.error('Playwright selection changed between collection and execution.');process.exitCode=1;break}
 if(r.status!==0||result.stats.expected===0||result.stats.unexpected||result.stats.flaky){process.exitCode=r.status||1;break}
}
