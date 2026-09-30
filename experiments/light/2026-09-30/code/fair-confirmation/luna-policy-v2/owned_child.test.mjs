import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {awaitOwnedChild} from './owned_child.mjs';
function fixture(kill){const child=new EventEmitter();child.pid=123;child.kill=kill;return child;}
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
