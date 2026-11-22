import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {completeNodeIce,ipv4Candidates} from './webtorrent-fixture.mjs';

function peer(state='new'){
  const p=new EventEmitter();p.destroyed=false;p.candidates=[];p.signals=[];
  p._pc={iceGatheringState:state,iceConnectionState:'new',onicecandidate:e=>p.signals.push({candidate:e.candidate,candidates:[...p.candidates]})};
  return p;
}
test('Node ICE completion waits for the real end and keeps late candidates',()=>{
  const p=completeNodeIce(peer());
  p._pc.iceGatheringState='gathering';p.candidates.push('first');p.emit('iceStateChange','new','gathering');
  assert.deepEqual(p.signals,[]);
  p.candidates.push('late');p._pc.iceGatheringState='complete';p.emit('iceStateChange','new','complete');p.emit('iceStateChange','connected','complete');
  assert.deepEqual(p.signals,[{candidate:null,candidates:['first','late']}]);assert.equal(p.listenerCount('iceStateChange'),0);
});
test('already complete and closed Node peers do not race or retain listeners',()=>{
  const done=completeNodeIce(peer('complete'));assert.equal(done.signals.length,1);assert.equal(done.listenerCount('iceStateChange'),0);
  const closed=completeNodeIce(peer());closed.destroyed=true;closed.emit('close');closed.emit('iceStateChange','closed','complete');assert.deepEqual(closed.signals,[]);assert.equal(closed.listenerCount('iceStateChange'),0);
});
test('same-IP SDP retains one chosen interface without rewriting candidates or other SDP',()=>{
  const lines=['v=0','a=ice-ufrag:keep','a=candidate:1 1 UDP 100 127.0.0.1 10000 typ host','a=candidate:2 1 UDP 200 10.0.134.26 10001 typ host','a=candidate:3 1 UDP 300 192.168.1.2 10002 typ host','a=candidate:4 1 UDP 400 ::1 10003 typ host','a=end-of-candidates',''];
  assert.equal(ipv4Candidates(lines.join('\r\n'),'10.0.134.26'),[lines[0],lines[1],lines[3],lines[6],lines[7]].join('\r\n'));
  assert.equal(ipv4Candidates(lines.join('\r\n')),[...lines.slice(0,5),...lines.slice(6)].join('\r\n'));
});
