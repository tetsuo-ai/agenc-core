import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {awaitOwnedChild,createOwnedChildGate} from './owned_child-v2.mjs';
function fixture(kill){const child=new EventEmitter();child.pid=123;child.kill=kill;return child;}
test('exit before delayed close prevents any timeout signal',async()=>{
 let kills=0;const c=fixture(()=>{kills++;return true;});
 const p=awaitOwnedChild(c,{timeoutMs:5,closeMs:100});c.emit('exit',0,null);
 setTimeout(()=>c.emit('close',0,null),15);
 await assert.rejects(p,e=>e.cleanupConfirmed===true);assert.equal(kills,0);
});
test('exit without close stays explicitly unconfirmed and unsignaled',async()=>{
 let kills=0;const c=fixture(()=>{kills++;return false;});
 const p=awaitOwnedChild(c,{timeoutMs:5,closeMs:5});c.emit('exit',0,null);
 await assert.rejects(p,e=>e.cleanupConfirmed===false);assert.equal(kills,0);c.emit('close',0,null);
});
test('suite latch refuses a subsequent spawn after unconfirmed cleanup',async()=>{
 const gate=createOwnedChildGate();let spawns=0;const c=fixture(()=>false);
 await assert.rejects(gate.run(()=>{spawns++;return c;},{timeoutMs:5,closeMs:5}),e=>e.cleanupConfirmed===false);
 await assert.rejects(gate.run(()=>{spawns++;return fixture(()=>true);}),/gate closed/);
 assert.equal(spawns,1);c.emit('close',null,'SIGKILL');
});
test('suite gate permits next independent case only after confirmed close',async()=>{
 const gate=createOwnedChildGate();
 for(let i=0;i<2;i++){const c=fixture(()=>true);const p=gate.run(()=>c);c.emit('exit',0,null);c.emit('close',0,null);await p;}
});
test('suite gate refuses concurrent spawn while first ownership is live',async()=>{
 const gate=createOwnedChildGate();const c=fixture(()=>true);let spawned=false;
 const first=gate.run(()=>c);
 await assert.rejects(gate.run(()=>{spawned=true;return c;}),/gate closed/);assert.equal(spawned,false);
 c.emit('close',0,null);await first;
});
test('normal close completes ownership',async()=>{const c=fixture(()=>true);const p=awaitOwnedChild(c);c.emit('close',0,null);await p;});
test('post-spawn error waits for signaled close rather than rejecting early',async()=>{
 let kills=0;const c=fixture(()=>{kills++;setImmediate(()=>c.emit('close',null,'SIGKILL'));return true;});
 const p=awaitOwnedChild(c);c.emit('error',Error('private'));assert.equal(kills,1);
 await assert.rejects(p,e=>e.cleanupConfirmed===true&&e.message==='Fixture child error');
});
test('timeout kills and waits for close',async()=>{
 const c=fixture(()=>{setImmediate(()=>c.emit('close',null,'SIGKILL'));return true;});
 await assert.rejects(awaitOwnedChild(c,{timeoutMs:5}),e=>e.cleanupConfirmed===true&&e.message==='Fixture child timeout');
});
for(const mode of ['false','throw'])test(`kill ${mode} never masquerades as confirmed cleanup`,async()=>{
 const c=fixture(()=>{if(mode==='throw')throw Error('private');return false;});
 await assert.rejects(awaitOwnedChild(c,{timeoutMs:5,closeMs:5}),e=>e.cleanupConfirmed===false&&e.pid===123&&e.message==='Fixture child close unconfirmed');
});
test('kill failure followed by close remains confirmed terminal failure',async()=>{
 const c=fixture(()=>{setImmediate(()=>c.emit('close',2,null));throw Error('private');});
 const p=awaitOwnedChild(c);c.emit('error',Error('private'));
 await assert.rejects(p,e=>e.cleanupConfirmed===true&&e.code===2);
});
