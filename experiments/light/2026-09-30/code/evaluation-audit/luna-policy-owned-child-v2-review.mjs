// Inert successor review only; preserves original reviewer and candidate files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source='/private/tmp/light-takeover/fair-confirmation/luna-policy-v2/owned_child-v2.mjs';
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),'c4a9e77b4de27799507a55814d93db0a4a5b7ae336b670add852a4e5bac57a70');
const {awaitOwnedChild,createOwnedChildGate}=await import(source);
function child(){const c=new EventEmitter();c.pid=12345;return c;}
test('original post-spawn failure still waits for closed child',async()=>{
  const c=child();let kills=0,settled=false;c.kill=()=>{kills++;return false;};
  const p=awaitOwnedChild(c,{timeoutMs:100,closeMs:100}).finally(()=>{settled=true;});
  c.emit('spawn');c.emit('error',Error('synthetic'));await Promise.resolve();
  assert.equal(kills,1);assert.equal(settled,false);
  c.emit('close',2,null);await assert.rejects(p,e=>e.cleanupConfirmed===true);
});
test('observed exit prevents any subsequent timeout signal, even without close',async()=>{
  const c=child();let kills=0;c.kill=()=>{kills++;return true;};
  const p=awaitOwnedChild(c,{timeoutMs:2,closeMs:2});c.emit('exit',0,null);
  await assert.rejects(p,e=>e.cleanupConfirmed===false);assert.equal(kills,0);
  assert.doesNotThrow(()=>c.emit('error',Error('synthetic late error')));c.emit('close',0,null);
});
test('unconfirmed ownership permanently latches before future spawn, including after late close',async()=>{
  const gate=createOwnedChildGate();const c=child();let spawns=0;c.kill=()=>false;
  await assert.rejects(gate.run(()=>{spawns++;return c;},{timeoutMs:2,closeMs:2}),e=>e.cleanupConfirmed===false);
  for(const late of [false,true]){
    if(late)c.emit('close',null,'SIGKILL');
    await assert.rejects(gate.run(()=>{spawns++;return child();}),/gate closed/);
  }
  assert.equal(spawns,1);
});
test('concurrent spawn is rejected without disturbing current owned closure',async()=>{
  const gate=createOwnedChildGate();const c=child();c.kill=()=>true;let second=false;
  const p=gate.run(()=>c);await assert.rejects(gate.run(()=>{second=true;return child();}),/gate closed/);
  assert.equal(second,false);c.emit('exit',0,null);c.emit('close',0,null);await p;
});
