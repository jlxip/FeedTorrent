import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {assertPortsAvailable,needsPorts} from '../scripts/test-ports.mjs';

test('full validation checks ports while focused suites and standalone checks remain usable',()=>{
  for(const goals of [['check','test'],['check-native','test-native'],['test-ports']]) assert(needsPorts(goals,[]));
  assert(needsPorts(['test-integration'],['peers','http-ports']));
  assert(!needsPorts(['test-integration'],['peers']));
  assert(!needsPorts(['build','check-native','run'],['http-ports']));
});

async function reserve(port=0) {
  const server=createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(port,'127.0.0.1',resolve);
  });
  return server;
}
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));

test('available test ports are released after a successful check',async()=>{
  const initial=await reserve(),port=initial.address().port;await close(initial);
  await assertPortsAvailable([port]);
  const reused=await reserve(port);await close(reused);
});

test('all occupied ports are reported, existing listeners survive and partial reservations are released',async()=>{
  const first=await reserve(),second=await reserve(),free=await reserve();
  const ports=[first.address().port,free.address().port,second.address().port];
  await close(free);
  try {
    await assert.rejects(assertPortsAvailable(ports),error=>{
      assert.match(error.message,new RegExp(`127\\.0\\.0\\.1:${ports[0]}, 127\\.0\\.0\\.1:${ports[2]} already in use`));
      assert.match(error.message,/Close any open FeedTorrent instances/);
      assert.match(error.message,/8790, 8791 and 8792/);
      return true;
    });
    assert(first.listening);assert(second.listening);
    const reused=await reserve(ports[1]);await close(reused);
  } finally { await close(first);await close(second); }
});

test('other bind failures keep their cause instead of claiming a port is occupied',async()=>{
  await assert.rejects(assertPortsAvailable([-1]),error=>{
    assert.match(error.message,/Cannot check test port/);
    assert.match(error.message,/ERR_SOCKET_BAD_PORT/);
    assert.doesNotMatch(error.message,/already in use/);
    return true;
  });
});
