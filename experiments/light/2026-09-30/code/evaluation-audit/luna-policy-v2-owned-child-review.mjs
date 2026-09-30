// Inert child objects only. No OS child, observer, journal, or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source='/private/tmp/light-takeover/fair-confirmation/luna-policy-v2/owned_child.mjs';
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),'a45160d48b46c6f1b435c0225c5acd1b636c942fa095e669c273701bd7dce6d6');
const {awaitOwnedChild}=await import(source);
function child(){const c=new EventEmitter();c.pid=12345;return c;}
test('original post-spawn error now kills and awaits observed close',async()=>{
  const c=child();let kills=0,settled=false;
  c.kill=()=>{kills++;return true;};
  const pending=awaitOwnedChild(c,{timeoutMs:200,closeMs:100}).finally(()=>{settled=true;});
  c.emit('spawn');c.emit('error',Error('inert primary'));await Promise.resolve();
  assert.equal(kills,1);assert.equal(settled,false);
  c.emit('close',null,'SIGKILL');await assert.rejects(pending,e=>e.cleanupConfirmed===true);
});
test('original timeout kill false now waits for separate confirmation bound',async()=>{
  const c=child();let kills=0;c.kill=()=>{kills++;return false;};
  await assert.rejects(awaitOwnedChild(c,{timeoutMs:2,closeMs:2}),e=>e.cleanupConfirmed===false&&e.pid===12345);
  assert.equal(kills,1);assert.doesNotThrow(()=>c.emit('error',Error('inert late error')));
  c.emit('close',null,null);assert.equal(c.listenerCount('error'),0);
});
test('observed exit must forbid timeout signal while waiting for close',async()=>{
  const c=child();let kills=0;c.kill=()=>{kills++;setImmediate(()=>c.emit('close',0,null));return true;};
  const pending=awaitOwnedChild(c,{timeoutMs:2,closeMs:20});
  c.emit('spawn');c.emit('exit',0,null);
  await assert.rejects(pending);
  assert.equal(kills,0,'helper ignores observed exit and still invokes kill');
});
