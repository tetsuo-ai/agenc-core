import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { frozenControl } from './frozen_control.mjs';

class Child extends EventEmitter {
  constructor(pid = 123) {
    super(); this.pid = pid; this.exitCode = null; this.signalCode = null;
    this.connected = true; this.kills = [];
  }
  kill(signal) { this.kills.push(signal); return false; }
  exit(code = 0, signal = null) {
    this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal);
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(version) {
  const owner = new Child(), children = [], timers = new Map(), descriptors = new Set();
  const result = { arm: 'light', messages: [], tool: {
    has_send: false, connected: false, has_node_options: false, has_channel_fd: false } };
  const trace = []; let next = 0, now = 0;
  const bindings = {
    process: { execPath: '/synthetic/node' }, root: '/synthetic/root', env: {},
    cli: '/synthetic/agenc', arm: 'light', owner, result, messages: result.messages,
    disconnected: false, info: '/synthetic/daemon-runtime.json',
    join: (...parts) => parts.join('/'),
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, {fn, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    Date: { now: () => now },
    delay: async ms => { now += ms; trace.push('readiness-delay'); },
    spawn: () => { const child = children.length === 0 ? owner : new Child(123 + children.length);
      children.push(child); return child; },
    fs: {
      openSync: () => { descriptors.add(42); trace.push('open'); return 42; },
      closeSync: fd => { descriptors.delete(fd); trace.push('close-fd'); },
      readFileSync: () => 'synthetic status', existsSync: () => false,
      cpSync: () => trace.push('copy'),
    },
    write: () => trace.push('write-result'),
  };
  return { owner, children, timers, descriptors, result, trace, bindings,
    api: () => frozenControl(version, bindings) };
}

for (const version of ['v1', 'v2']) {
  const probeMessage = ordinal => ({kind:`offline-parent-probe-${version}`,
    pid:123, ordinal, connected:true});

  test(`${version}: normal synthetic owner finish and exact-child kill target`, async () => {
    const h=harness(version), api=h.api(), child=api.start([], 'owner', true);
    assert.equal(child,h.owner);assert.equal(h.descriptors.size,0);
    const pending=api.wait(child,10);
    child.exit(0);assert.equal((await pending).code,0);
    assert.deepEqual(child.kills,[]);assert.equal(h.timers.size,0);
  });

  test(`${version}: synchronous spawn throw leaks the already-opened log FD`, () => {
    const h=harness(version), failure=new Error('synthetic spawn throw');
    h.bindings.spawn=()=>{throw failure;};
    assert.throws(()=>h.api().start([], 'owner',true), error=>error===failure);
    assert.deepEqual([...h.descriptors],[42]);
  });

  test(`${version}: spawn error resolves finished without requiring close`, async () => {
    const h=harness(version), api=h.api(), child=api.start([], 'owner',true);
    let closed=false;child.on('close',()=>{closed=true;});
    child.emit('error',Object.assign(new Error('synthetic'),{code:'ENOENT'}));
    const result=await api.wait(child);
    assert.equal(result.error,'ENOENT');assert.equal(closed,false);
    assert.equal(h.timers.size,0);
  });

  test(`${version}: exit is treated as finished before stdio/channel close`, async () => {
    const h=harness(version), api=h.api(), child=api.start([], 'owner',true);
    child.exit(0);const result=await api.wait(child);
    assert.equal(result.code,0);assert.equal(child.connected,true);
    assert.equal(child.listenerCount('close'),0);
  });

  test(`${version}: failed timeout kill leaves an unbounded finished await`, async () => {
    const h=harness(version), api=h.api(), child=api.start([], 'owner',true);
    let settled=false;
    const pending=api.wait(child,10).then(value=>{settled=true;return value;});
    const expiry=[...h.timers.values()][0];expiry.fn();await flush();
    assert.deepEqual(child.kills,['SIGKILL']);assert.equal(settled,false);
    assert.equal(h.timers.size,0); // no second bound after kill failure
    child.exit(null,'SIGKILL');assert.equal((await pending).timeout,true);
  });

  test(`${version}: thrown kill callback does not settle the timeout promise`, async () => {
    const h=harness(version), api=h.api(), child=api.start([], 'owner',true);
    child.kill=()=>{throw new Error('synthetic kill failure');};
    let settled=false;
    const pending=api.wait(child,10).then(value=>{settled=true;return value;});
    assert.throws(()=>[...h.timers.values()][0].fn(),/synthetic kill failure/);
    await flush();assert.equal(settled,false);
    child.exit(1);await pending; // finish the synthetic promise without leaking work
  });

  test(`${version}: stop-command exception in finally skips waiting/cleaning owner`, async () => {
    const h=harness(version);let spawnCalls=0;
    const spawn=h.bindings.spawn;
    h.bindings.spawn=(...args)=>{if(++spawnCalls===2)throw new Error('stop spawn failure');return spawn(...args);};
    const api=h.api();api.start([], 'owner',true);
    await assert.rejects(api.cleanup(),/stop spawn failure/);
    assert.equal(h.owner.exitCode,null);assert.deepEqual(h.owner.kills,[]);
    assert.equal(h.result.owner_exit,undefined);assert.equal(h.timers.size,0);
  });

  test(`${version}: failed stop log read also bypasses owner cleanup`, async () => {
    const h=harness(version);const spawn=h.bindings.spawn;
    h.bindings.spawn=(...args)=>{const child=spawn(...args);
      if(h.children.length>1)queueMicrotask(()=>child.exit(0));return child;};
    h.bindings.fs.readFileSync=()=>{throw new Error('stop log read failure');};
    const api=h.api();api.start([], 'owner',true);
    await assert.rejects(api.cleanup(),/stop log read failure/);
    assert.deepEqual(h.owner.kills,[]);assert.equal(h.result.owner_exit,undefined);
  });

  test(`${version}: signal death does not terminate readiness poll via exitCode`, async () => {
    const h=harness(version);h.owner.exit(null,'SIGTERM');
    await h.api().readyLoop();
    assert.equal(h.trace.filter(x=>x==='readiness-delay').length,150);
  });

  test(`${version}: matching messages after disconnect are accepted by current predicate`, () => {
    const h=harness(version), api=h.api();api.attach();
    h.owner.emit('disconnect');
    for(let n=1;n<=(version==='v1'?1:2);n++)h.owner.emit('message',probeMessage(n));
    h.result.owner_exit={code:0,signal:null};h.result.stop_exit=0;
    assert.equal(api.valid(),true);
    // An impossible/inconsistent transport sequence must not mint future proof.
    // This synthetic injection is not a claim that normal Node IPC reorders it.
  });

  test(`${version}: extra or wrong-owner channel messages currently invalidate`, () => {
    const h=harness(version), api=h.api();api.attach();
    h.result.owner_exit={code:0,signal:null};h.result.stop_exit=0;
    for(let n=1;n<=(version==='v1'?1:2);n++)h.owner.emit('message',probeMessage(n));
    h.owner.emit('disconnect');assert.equal(api.valid(),true);
    h.result.messages[0].pid=456;assert.equal(api.valid(),false);
    h.result.messages[0].pid=123;h.owner.emit('message',probeMessage(99));
    assert.equal(api.valid(),false);
  });

  test(`${version}: result publication can leave an earlier valid file when copy fails`, () => {
    const h=harness(version);let written;
    h.result.valid=true;
    h.bindings.output='/synthetic/output';
    h.bindings.write=(_path,value)=>{written={...value};};
    h.bindings.fs.cpSync=()=>{throw new Error('partial output copy failure');};
    assert.throws(()=>h.api().publish(),/partial output copy failure/);
    assert.equal(written.valid,true);
    assert.equal(h.result.valid,true); // no durable external commit was produced
  });
}
