import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function needsPorts(goals,suites) {
  return goals.some(goal=>['test','test-native','test-ports'].includes(goal)) ||
    (goals.includes('test-integration') && suites.includes('http-ports'));
}

export async function assertPortsAvailable(ports = [8790,8791,8792]) {
  const reserved=[],occupied=[];
  try {
    for (const port of ports) {
      const server=createServer();
      try {
        await new Promise((resolve,reject)=>{
          server.once('error',reject);
          server.listen({host:'127.0.0.1',port,exclusive:true},resolve);
        });
        reserved.push(server);
      } catch (error) {
        if (error.code==='EADDRINUSE') occupied.push(port);
        else throw new Error(`Cannot check test port 127.0.0.1:${port}: ${error.code||error.message}`,{cause:error});
      }
    }
    if (occupied.length) throw new Error(
      `Cannot run port tests: ${occupied.map(p=>`127.0.0.1:${p}`).join(', ')} already in use.\n`+
      'Close any open FeedTorrent instances (or other programs using these ports), then retry.\n'+
      'Port tests require 127.0.0.1:8790, 8791 and 8792 to be free.'
    );
  } finally {
    await Promise.all(reserved.map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),words=flag=>(args[args.indexOf(flag)+1]||'').trim().split(/\s+/);
  try { if (!args.length || needsPorts(words('--goals'),words('--native-suites'))) await assertPortsAvailable(); }
  catch (error) { console.error(error.message);process.exitCode=1; }
}
