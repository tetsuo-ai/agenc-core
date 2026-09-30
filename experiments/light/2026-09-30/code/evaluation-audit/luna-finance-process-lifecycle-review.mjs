import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const source = readFileSync(new URL('../fair-confirmation/luna-finance-io-process-v1/owned-child.mjs', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '504e874796de5917156a8ed8fd22ff1e96abe12c3b7e10cc09906f2096c21f94');
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
