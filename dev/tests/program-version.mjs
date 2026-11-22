import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import bencode from 'bencode';
import {temporary,startApp,wait,cleanup} from './helpers.mjs';
import {workspaceVersion} from '../scripts/version.mjs';
import {verifyVersion} from '../ci/package.mjs';

const version=await workspaceVersion();
await verifyVersion(resolve('target/release/feedtorrent'),version);
console.log(`PASS --version reports v${version} outside Git with no PATH or application data`);
const root=await temporary();let app;
const agents=[];
const server=createServer((req,res)=>{
  agents.push(req.headers['user-agent']);
  res.end(bencode.encode({interval:1800,peers:Buffer.alloc(0)}));
});
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  app=await startApp(root);
  const metadata={announce:`http://127.0.0.1:${server.address().port}/announce`,info:{name:'version.bin',length:1,'piece length':16384,pieces:createHash('sha1').update(Buffer.from([0])).digest()}};
  await app.command({type:'add_torrent',data:Array.from(bencode.encode(metadata))});
  await wait(()=>agents.includes(`FeedTorrent/${version}`),'tracker receives current FeedTorrent version');
  assert(agents.every(agent=>agent===`FeedTorrent/${version}`));
  console.log(`PASS real HTTP tracker receives FeedTorrent/${version}`);
}finally{
  await cleanup(root,app);
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
}
