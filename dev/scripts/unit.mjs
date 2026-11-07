// Cargo remains the runner. Detect an accidentally empty successful filter.
import '../tests/runtime.mjs';
import {spawn} from 'node:child_process';
const args=['test','--locked',...process.argv.slice(2)],child=spawn('cargo',args,{stdio:['inherit','pipe','inherit']});let output='';
child.stdout.on('data',b=>{output+=b;process.stdout.write(b)});
child.on('error',e=>{console.error(e.message);process.exitCode=1});
child.on('close',(code,signal)=>{
 if(code!==0||signal){process.exitCode=code||1;return}
 if(args.includes('--list')||args.includes('--help'))return;
 const passed=[...output.matchAll(/test result: ok\. (\d+) passed/g)].reduce((n,m)=>n+Number(m[1]),0);
 if(!passed){console.error('No Rust tests executed; check UNIT_ARGS.');process.exitCode=1}
});
