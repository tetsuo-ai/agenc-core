// Reviewer vectors retained with only source path/pin changed; original inert
// repro SHA256 f20fb6187a7171ddc462cfdf8f003de3b59c93b0555e4096767dfe462066b883.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const source = readFileSync(new URL('./owned-child.mjs', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '51bdfa9d178a3b02169d33e01af64f640bf2922087725a56a80cfd3569fd0b77');
// Exact lifecycle implementation with only import/export and module URL syntax
// replaced. The fork and timers below are inert; no OS child or financial I/O.
const compile = new Function('fork','setTimeout','clearTimeout',source
  .replace("import { fork } from 'node:child_process';", '')
  .replaceAll('export function ', 'function ')
  .replace("new URL('./child.mjs', import.meta.url)", "new URL('file:///inert-review-child.mjs')")
  + '\nreturn {startOwned,assertSequenceSafe};');
function fixture() {
  const child = new EventEmitter(), timers=[], signals=[];let forks=0;
  child.pid=47123;child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdin.write=(_value,callback)=>{callback?.();return true;};
  child.kill=signal=>{signals.push(signal);return true;};
  const api=compile(()=>{forks++;return child;},callback=>{const t={callback,cleared:false};timers.push(t);return t;},timer=>{if(timer)timer.cleared=true;});
  const handle=api.startOwned({options:{root:'/inert-review'},mode:'normal'});
  const message=value=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));
  const ready=()=>{child.emit('spawn');message({type:'ready',pid:child.pid,mode:'normal'});};
  const result=()=>message({type:'result',pid:child.pid,state:'committed',exposure:'10000000',poisoned:false});
  const close=()=>{child.emit('disconnect');child.emit('exit',0,null);child.emit('close',0,null);};
  return {api,handle,child,timers,signals,ready,result,close,message,get forks(){return forks;}};
}

for(const [name,late] of [
  ['unexpected IPC',f=>f.child.emit('message',{type:'unexpected'})],
  ['stderr',f=>f.child.stderr.emit('data',Buffer.from('synthetic late error'))],
  ['duplicate exit',f=>f.child.emit('exit',1,null)],
  ['duplicate disconnect',f=>f.child.emit('disconnect')],
])test(`late ${name} cannot leave the overall sequence marked safe`,async()=>{
  const f=fixture();f.ready();f.result();f.close();
  const before=await f.handle.done;assert.equal(before.confirmed,true);assert.equal(before.invalid,false);
  late(f);
  // An already returned immutable result cannot be revoked. A sticky sequence
  // gate must make the later contradictory evidence observable instead.
  assert.throws(()=>f.api.assertSequenceSafe(),/Synthetic child sequence blocked/);
  assert.equal(f.signals.length,0);
});

test('control: normal exact owned closure is accepted without a signal',async()=>{
  const f=fixture();f.ready();f.result();f.close();
  const result=await f.handle.done;assert.equal(result.confirmed,true);assert.equal(result.invalid,false);
  f.api.assertSequenceSafe();assert.deepEqual(f.signals,[]);
});

test('control: unexpected evidence before close invalidates the terminal result',async()=>{
  const f=fixture();f.ready();f.result();f.child.emit('message',{});f.close();
  assert.equal((await f.handle.done).invalid,true);assert.deepEqual(f.signals,['SIGKILL']);
});

test('control: observed exit forbids later containment signalling',async()=>{
  const f=fixture();f.ready();f.result();f.child.emit('disconnect');f.child.emit('exit',0,null);
  const pending=f.handle.contain();f.child.emit('close',0,null);
  assert.equal((await pending).confirmed,true);assert.deepEqual(f.signals,[]);
});

test('control: unresolved deadline plus containment deadline latches all future launches',async()=>{
  const f=fixture();f.ready();f.timers[0].callback();f.timers[1].callback();
  assert.equal((await f.handle.done).confirmed,false);assert.deepEqual(f.signals,['SIGKILL']);
  assert.throws(()=>f.api.startOwned({options:{root:'/inert-review'},mode:'normal'}),/Synthetic child sequence blocked/);
  assert.equal(f.forks,1);
});

for(const [name,late] of [
  ['empty stdout',f=>f.child.stdout.emit('data',Buffer.alloc(0))],
  ['partial stdout without newline',f=>f.child.stdout.emit('data',Buffer.from('partial'))],
  ['child error',f=>f.child.emit('error',new Error('synthetic'))],
  ['stdin error',f=>f.child.stdin.emit('error',new Error('synthetic'))],
  ['stdout error',f=>f.child.stdout.emit('error',new Error('synthetic'))],
  ['stderr error',f=>f.child.stderr.emit('error',new Error('synthetic'))],
  ['duplicate spawn',f=>f.child.emit('spawn')],
  ['duplicate close',f=>f.child.emit('close',1,null)],
])test(`post-close ${name} blocks launch without revoking the immutable result or signalling`,async()=>{
  const f=fixture();f.ready();f.result();f.close();
  const before=await f.handle.done;
  assert.equal(before.invalid,false);assert.equal(Object.isFrozen(before),true);
  late(f);
  assert.throws(()=>f.api.assertSequenceSafe(),/Synthetic child sequence blocked/);
  assert.throws(()=>f.api.startOwned({options:{root:'/inert-review'},mode:'normal'}),/Synthetic child sequence blocked/);
  assert.equal(f.forks,1);assert.deepEqual(f.signals,[]);
  assert.equal(await f.handle.done,before);assert.equal(before.invalid,false);
  assert.equal(await f.handle.contain(),before);assert.deepEqual(f.signals,[]);
});

test('unexpected error after observed exit never signals or overwrites original exit identity',async()=>{
  const f=fixture();f.ready();f.result();f.child.emit('disconnect');f.child.emit('exit',0,null);
  f.child.emit('error',new Error('synthetic'));f.child.emit('exit',7,null);
  f.child.emit('close',0,null);
  const result=await f.handle.done;
  assert.equal(result.invalid,true);assert.equal(result.confirmed,true);
  assert.equal(result.code,0);assert.equal(result.signal,null);assert.deepEqual(f.signals,[]);
});
