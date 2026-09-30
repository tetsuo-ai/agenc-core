import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {supervise,proveIdentity,spawnWithLog,daemonIdentityDigest} from './parent-lifecycle.mjs';
import {createHash} from 'node:crypto';

class Child extends EventEmitter {
  constructor(pid,ipc=false){super();this.pid=pid;this.connected=ipc;this.kills=[];this.exitCode=null;this.signalCode=null;}
  finish(code=0,signal=null){
    if(this.connected){this.connected=false;this.emit('disconnect');}
    this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);this.emit('close',code,signal);
  }
  kill(signal){this.kills.push(signal);queueMicrotask(()=>this.finish(null,signal));return true;}
}
const tuple=()=>({pid:101,instanceId:'instance-a',processStart:'linux:boot:1234',
  runtimeVersion:'synthetic',commit:'synthetic-commit',buildTime:'synthetic-build'});
function fixture(arm='light'){
  const owner=new Child(101,true),task=new Child(102),calls=[];let proofReads=0;
  const current=tuple();
  const input={arm,expectedMessages:1,expectedBuild:tuple(),
    readyMs:20,taskMs:10,stopMs:10,closeMs:10,killGraceMs:5,
    spawnOwner(register){register(owner);queueMicrotask(()=>{owner.emit('spawn');
      if(arm==='pi'){message();owner.finish();}});},
    spawnTask(register){calls.push('task');register(task);queueMicrotask(()=>{
      task.emit('spawn');message();task.finish();});},
    identityAdapter:{
      async readSidecar(){proofReads++;return {...current};},
      async readProcessStart(){return current.processStart;},
      async requestAuthenticatedIdentity(){return {...current};},
    },
    async requestShutdown(bound){calls.push('shutdown');assert.deepEqual(bound,tuple());
      owner.finish();return {shuttingDown:true,instanceId:bound.instanceId};},
    async publish(facts){calls.push('publish');assert.equal(facts.cleanup_complete,true);},
  };
  const message=()=>owner.emit('message',{kind:'lifecycle-probe-v5',pid:101,ordinal:1,connected:true});
  return {input,owner,task,calls,current,message,proofReads:()=>proofReads};
}
const has=(result,reason)=>assert(result.issues.includes(reason),JSON.stringify(result));

test('normal Light separately observes task, instance-bound shutdown and owner closure',async()=>{
  const f=fixture(),result=await supervise(f.input);
  assert.equal(result.valid,true);assert.equal(result.owner.closed,true);
  assert.equal(result.task.closed,true);assert.equal(result.owner.disconnected,true);
  assert.deepEqual(f.calls,['task','shutdown','publish']);assert.equal(f.proofReads(),6);
  assert.deepEqual(f.owner.kills,[]);assert.deepEqual(f.task.kills,[]);
});

// New projection checks below consume the same records as the inherited tests.
const attachObservers=f=>{
  f.input.observeOutstandingOperations=()=>false;
  f.input.observeJournalQuiescence=()=>true;
  return f;
};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
test('live finalizer projection has exact schema and hashes only the proven daemon identity',async()=>{
  const f=attachObservers(fixture()),result=await supervise(f.input),live=result.observeLifecycle();
  assert.deepEqual(Object.keys(live).sort(),['schema_version','client','owner','task','daemon_identity_sha256',
    'shutdown_acknowledged','pending_operations','journal_quiescent','sticky_invalid'].sort());
  assert.deepEqual(Object.keys(live.owner).sort(),['pid','spawned','exit_observed','closed','ipc_disconnected',
    'exit_code','exit_signal','close_code','close_signal','invalid','error','timed_out','kill_attempted','kill_failed'].sort());
  assert.equal(live.owner.pid,101);assert.equal(live.task.pid,102);
  assert.equal(live.owner.exit_observed,true);assert.equal(live.owner.ipc_disconnected,true);
  assert.equal(live.task.ipc_disconnected,null);assert.equal(live.shutdown_acknowledged,true);
  assert.equal(live.pending_operations,false);assert.equal(live.journal_quiescent,true);assert.equal(live.sticky_invalid,false);
  const expected=createHash('sha256').update(JSON.stringify(tuple())).digest('hex');
  assert.equal(live.daemon_identity_sha256,expected);assert.equal(daemonIdentityDigest(tuple()),expected);
  assert(Object.isFrozen(live)&&Object.isFrozen(live.owner));
  f.current.instanceId='changed-after-proof';
  assert.equal(result.observeLifecycle().daemon_identity_sha256,expected,'bound detached identity, not mutable sidecar');
});
test('Pi projection does not invent a task, shutdown or daemon identity',async()=>{
  const f=attachObservers(fixture('pi')),result=await supervise(f.input),live=result.observeLifecycle();
  assert.equal(live.task,null);assert.equal(live.daemon_identity_sha256,null);assert.equal(live.shutdown_acknowledged,null);
  assert.equal(live.sticky_invalid,false);assert.equal(result.owner.pid,101);assert.equal(result.owner.channel_invalid,false);
});
for(const event of ['message','error','exit'])test(`post-supervise ${event} invalidates live view without mutating old result or signaling child`,async()=>{
  const f=attachObservers(fixture('pi')),result=await supervise(f.input),before=result.observeLifecycle();
  if(event==='message')f.message();
  if(event==='error')f.owner.emit('error',new Error('synthetic'));
  if(event==='exit')f.owner.emit('exit',9,null);
  const after=result.observeLifecycle();
  assert.equal(result.valid,true,'returned result is historical, not revocable');
  assert.equal(before.sticky_invalid,false);assert.equal(after.sticky_invalid,true);assert.equal(after.owner.invalid,true);
  assert.equal(after.owner.exit_code,0);assert.deepEqual(f.owner.kills,[]);
});
for(const operation of ['identity','shutdown','publication'])test(`${operation} timeout retains actual pending work until its promise settles`,async()=>{
  const f=attachObservers(fixture(operation==='publication'?'pi':'light'));let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  if(operation==='identity')f.input.identityAdapter.readSidecar=()=>pending;
  if(operation==='shutdown')f.input.requestShutdown=()=>pending;
  if(operation==='publication')f.input.publish=()=>pending;
  const result=await supervise(f.input);
  assert.equal(result.valid,false);assert.equal(result.cleanup_complete,true);
  assert.equal(result.observeLifecycle().pending_operations,true);
  finish(operation==='identity'?tuple():{shuttingDown:true,instanceId:'instance-a'});
  await nextTurn();
  assert.equal(result.observeLifecycle().pending_operations,false);
  assert.equal(result.observeLifecycle().sticky_invalid,true,'late completion never erases timeout');
});
test('adapter-owned hidden I/O remains pending after the callback race settles',async()=>{
  const f=attachObservers(fixture('pi'));let underlying=true;
  f.input.observeOutstandingOperations=()=>underlying;
  const result=await supervise(f.input);
  assert.equal(result.observeLifecycle().pending_operations,true);
  underlying=false;
  assert.equal(result.observeLifecycle().pending_operations,false);
});
test('journal quiescence comes from live observed writer state, never a default',async()=>{
  const f=attachObservers(fixture('pi'));let quiescent=false;
  f.input.observeJournalQuiescence=()=>quiescent;
  const result=await supervise(f.input);
  assert.equal(result.observeLifecycle().journal_quiescent,false);
  quiescent=true;assert.equal(result.observeLifecycle().journal_quiescent,true);
});
for(const key of ['observeOutstandingOperations','observeJournalQuiescence']){
  for(const kind of ['missing','throw','nonboolean','native_rejection','thenable'])test(`${key} ${kind} refuses live authority`,async()=>{
    const f=attachObservers(fixture('pi'));let touched=false;
    if(kind==='missing')delete f.input[key];
    else f.input[key]=()=>{
      if(kind==='throw')throw null;
      if(kind==='native_rejection')return Promise.reject(new Error('synthetic'));
      if(kind==='thenable')return {then(){touched=true;throw null;}};
      return null;
    };
    const result=await supervise(f.input),live=result.observeLifecycle();
    await nextTurn();
    assert.equal(live.pending_operations,true);assert.equal(live.journal_quiescent,false);
    assert.equal(live.sticky_invalid,true);assert.equal(touched,false);
  });
}
test('malformed observation stays sticky after a later valid return',async()=>{
  const f=attachObservers(fixture('pi'));let bad=true;
  f.input.observeOutstandingOperations=()=>bad?null:false;
  const result=await supervise(f.input);assert.equal(result.observeLifecycle().sticky_invalid,true);
  bad=false;assert.equal(result.observeLifecycle().pending_operations,false);
  assert.equal(result.observeLifecycle().sticky_invalid,true);
});
test('normal Pi directly owned without daemon shutdown or task sibling',async()=>{
  const f=fixture('pi'),result=await supervise(f.input);
  assert.equal(result.valid,true);assert.equal(result.task,null);
  assert.deepEqual(f.calls,['publish']);assert.equal(f.proofReads(),0);
});
test('spawn throws before creation are returned without cleanup of foreign processes',async()=>{
  const f=fixture();f.input.spawnOwner=()=>{throw new Error('private spawn details');};
  const result=await supervise(f.input);
  assert.equal(result.valid,false);assert.equal(result.owner,null);
  assert(!JSON.stringify(result).includes('private'));assert.deepEqual(f.owner.kills,[]);
});
test('registered owner is cleaned even if a subsequent spawn setup step throws',async()=>{
  const f=fixture();f.input.spawnOwner=register=>{register(f.owner);throw new Error('log-close');};
  const result=await supervise(f.input);
  assert.equal(result.valid,false);assert.equal(result.cleanup_complete,true);
  assert.deepEqual(f.owner.kills,['SIGKILL']);assert.deepEqual(f.calls,[]);
});
test('log FD closes on spawn exception; registration precedes fallible close',()=>{
  const trace=[];
  assert.throws(()=>spawnWithLog({openLog:()=>42,closeLog:fd=>trace.push(fd),
    spawn:()=>{throw new Error('spawn');},register:()=>assert.fail()}),/spawn/);
  assert.deepEqual(trace,[42]);
  const child=new Child(3);let registered;
  assert.throws(()=>spawnWithLog({openLog:()=>42,closeLog:()=>{throw new Error('close');},
    spawn:()=>child,register:value=>{registered=value;}}),/close/);
  assert.equal(registered,child);
});
test('owner spawn error interrupts readiness and missing close is separately bounded',async()=>{
  const f=fixture();let aborted=false;
  f.input.identityAdapter.readSidecar=signal=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve(tuple());});});
  f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>queueMicrotask(()=>f.owner.emit('error',new Error('synthetic'))));};
  f.owner.kill=()=>false;
  const result=await supervise(f.input);
  has(result,'owner_error');has(result,'owner_close_unconfirmed');
  assert.equal(result.cleanup_complete,false);assert.equal(aborted,false); // proof never starts before spawn
  assert(!f.calls.includes('task'));assert(!f.calls.includes('publish'));
});
test('owner signal exit before readiness blocks task and never signals an exited PID',async()=>{
  const f=fixture();f.input.identityAdapter.readSidecar=()=>new Promise(()=>{});
  f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>f.owner.finish(null,'SIGTERM'));};
  const result=await supervise(f.input);
  assert.equal(result.valid,false);assert.deepEqual(f.owner.kills,[]);
  assert(!f.calls.includes('task'));assert.equal(result.cleanup_complete,true);
});
test('task timeout kills only exact task child then still shuts down owned daemon',async()=>{
  const f=fixture();f.input.spawnTask=register=>{f.calls.push('task');register(f.task);};
  const result=await supervise(f.input);
  has(result,'task_timeout');assert.deepEqual(f.task.kills,['SIGKILL']);
  assert.deepEqual(f.owner.kills,[]);assert(f.calls.includes('shutdown'));
  assert(!f.calls.includes('publish'));assert.equal(result.cleanup_complete,true);
});
test('stop exception cannot skip exact owned-child fallback/join',async()=>{
  const f=fixture();f.input.requestShutdown=async()=>{throw new Error('stop/log failure');};
  const result=await supervise(f.input);
  has(result,'shutdown_error');assert.deepEqual(f.owner.kills,['SIGKILL']);
  assert.equal(result.owner.closed,true);assert.equal(result.valid,false);
});
test('stop timeout aborts callback and still attempts bounded owner cleanup',async()=>{
  const f=fixture();let aborted=false;
  f.input.requestShutdown=(_bound,signal)=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve({});});});
  const result=await supervise(f.input);
  has(result,'shutdown_timeout');assert.equal(aborted,true);
  assert.deepEqual(f.owner.kills,['SIGKILL']);assert.equal(result.cleanup_complete,true);
});
test('false and thrown kill failures remain bounded unconfirmed cleanup, not success',async()=>{
  for(const throws of [false,true]){
    const f=fixture();f.input.requestShutdown=async()=>{throw new Error('stop');};
    f.owner.kill=signal=>{f.owner.kills.push(signal);if(throws)throw new Error('private kill');return false;};
    const result=await supervise(f.input);
    has(result,'owner_kill_failed');has(result,'owner_close_unconfirmed');
    assert.equal(result.cleanup_complete,false);assert.equal(result.valid,false);
    assert.deepEqual(f.owner.kills,['SIGKILL']);
  }
});
test('exit without close cannot finalize and never kills a possibly reused PID',async()=>{
  const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
    f.owner.emit('spawn');f.message();f.owner.connected=false;f.owner.emit('disconnect');f.owner.emit('exit',0,null);
  });};
  const result=await supervise(f.input);
  has(result,'owner_close_unconfirmed');assert.deepEqual(f.owner.kills,[]);
  assert.equal(result.valid,false);assert.equal(result.owner.closed,false);
});
test('same PID different instance before task refuses launch and refuses unbound stop',async()=>{
  const f=fixture();let reads=0;
  f.input.identityAdapter.readSidecar=async()=>{if(++reads===3)f.current.instanceId='replacement';return {...f.current};};
  const result=await supervise(f.input);
  has(result,'owner_instance_changed');assert(!f.calls.includes('task'));
  assert(!f.calls.includes('shutdown'));assert.deepEqual(f.owner.kills,['SIGKILL']);
});
test('same PID different instance before cleanup never calls shutdown on replacement',async()=>{
  const f=fixture();f.input.spawnTask=register=>{register(f.task);queueMicrotask(()=>{
    f.message();f.current.instanceId='replacement';f.task.finish();});};
  const result=await supervise(f.input);
  has(result,'owner_instance_changed');assert(!f.calls.includes('shutdown'));
  assert.deepEqual(f.owner.kills,['SIGKILL']);
});
test('each canonical identity field mismatch or missing refuses proof',async()=>{
  for(const key of Object.keys(tuple())){
    const f=fixture();f.input.identityAdapter.requestAuthenticatedIdentity=async()=>({...tuple(),[key]:key==='pid'?999:'changed'});
    await assert.rejects(proveIdentity(f.input.identityAdapter,101,tuple()),/identity_authenticated_mismatch/);
    f.input.identityAdapter.readSidecar=async()=>{const value=tuple();delete value[key];return value;};
    await assert.rejects(proveIdentity(f.input.identityAdapter,101,tuple()));
  }
});
test('OS-start drift and sidecar drift during authenticated proof fail closed',async()=>{
  for(const drift of ['process','sidecar']){
    const f=fixture();let n=0;
    if(drift==='process')f.input.identityAdapter.readProcessStart=async()=>++n===1?tuple().processStart:'reused';
    else f.input.identityAdapter.readSidecar=async()=>({...tuple(),instanceId:++n===1?'instance-a':'instance-b'});
    await assert.rejects(proveIdentity(f.input.identityAdapter,101,tuple()),/identity_changed_during_proof/);
  }
});
test('wrong shutdown instance acknowledgment invalidates even if owner exits cleanly',async()=>{
  const f=fixture();f.input.requestShutdown=async()=>{f.owner.finish();return{shuttingDown:true,instanceId:'other'};};
  const result=await supervise(f.input);has(result,'shutdown_ack_mismatch');assert.equal(result.valid,false);
});
test('post-disconnect and task-channel messages are sticky failures',async()=>{
  for(const which of ['late','task']){
    const f=fixture();const original=f.input.requestShutdown;
    f.input.requestShutdown=async bound=>{const ack=await original(bound);
      (which==='late'?f.owner:f.task).emit('message',{kind:'lifecycle-probe-v5',pid:101,ordinal:2,connected:true});return ack;};
    const result=await supervise(f.input);has(result,'unexpected_channel_message');assert.equal(result.valid,false);
  }
});
test('wrong PID, duplicate, malformed and unexpected-kind owner messages invalidate',async()=>{
  for(const bad of [{pid:999},{ordinal:2},{kind:'other'},{extra:true}]){
    const f=fixture();f.input.spawnTask=register=>{register(f.task);queueMicrotask(()=>{
      f.owner.emit('message',{kind:'lifecycle-probe-v5',pid:101,ordinal:1,connected:true,...bad});f.task.finish();});};
    const result=await supervise(f.input);has(result,'invalid_owner_message');assert.equal(result.valid,false);
  }
});
test('publication failures occur only after cleanup and never grant success',async()=>{
  for(const hangs of [false,true]){
    const f=fixture();f.input.publish=facts=>{assert.equal(facts.cleanup_complete,true);
      if(hangs)return new Promise(()=>{});throw new Error('synthetic file publication failure');};
    const result=await supervise(f.input);has(result,'publication_failed');
    assert.equal(result.cleanup_complete,true);assert.equal(result.valid,false);
    assert.deepEqual(f.owner.kills,[]);
  }
});
test('unexpected message while publishing cannot reopen channel validity',async()=>{
  const f=fixture();f.input.publish=async()=>f.owner.emit('message',{});
  const result=await supervise(f.input);has(result,'unexpected_channel_message');assert.equal(result.valid,false);
});
test('owner missing spawn event never begins identity proof or task',async()=>{
  const f=fixture();f.input.spawnOwner=register=>register(f.owner);
  const result=await supervise(f.input);has(result,'owner_spawn_timeout');
  assert.equal(f.proofReads(),0);assert(!f.calls.includes('task'));
  assert.equal(result.cleanup_complete,true);
});
test('owner disconnect during pending authenticated readiness interrupts and aborts proof',async()=>{
  const f=fixture();let aborted=false;
  f.input.identityAdapter.readSidecar=signal=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve(tuple());});
    queueMicrotask(()=>{f.owner.connected=false;f.owner.emit('disconnect');});
  });
  const result=await supervise(f.input);
  assert.equal(aborted,true);assert(!f.calls.includes('task'));
  assert.equal(result.valid,false);assert.deepEqual(f.owner.kills,['SIGKILL']);
});
test('Pi kill failure is attempted once and does not restart deadline sequence in finally',async()=>{
  const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>f.owner.emit('spawn'));};
  f.owner.kill=signal=>{f.owner.kills.push(signal);return false;};
  const result=await supervise(f.input);has(result,'owner_close_unconfirmed');
  assert.deepEqual(f.owner.kills,['SIGKILL']);assert.equal(result.cleanup_complete,false);
});
test('readiness timeout aborts proof and cleans the exact owner without task launch',async()=>{
  const f=fixture();let aborted=false;
  f.input.identityAdapter.readSidecar=signal=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve(tuple());});});
  const result=await supervise(f.input);has(result,'readiness_timeout');
  assert.equal(aborted,true);assert(!f.calls.includes('task'));
  assert.deepEqual(f.owner.kills,['SIGKILL']);assert.equal(result.cleanup_complete,true);
});
test('registered task setup throw still cleans both children and never publishes',async()=>{
  const f=fixture();f.input.spawnTask=register=>{register(f.task);throw new Error('task log close');};
  const result=await supervise(f.input);
  assert.equal(result.valid,false);assert.equal(result.cleanup_complete,true);
  assert.deepEqual(f.task.kills,['SIGKILL']);assert(f.calls.includes('shutdown'));
  assert(!f.calls.includes('publish'));
});
test('close without exit and inconsistent exit/close status cannot become successful',async()=>{
  for(const mismatch of [false,true]){
    const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
      f.owner.emit('spawn');f.message();f.owner.connected=false;f.owner.emit('disconnect');
      if(mismatch)f.owner.emit('exit',3,null);
      f.owner.emit('close',0,null);
    });};
    const result=await supervise(f.input);assert.equal(result.valid,false);
    if(mismatch)has(result,'owner_exit_close_mismatch');else has(result,'owner_not_cleanly_closed');
  }
});
test('duplicate contradictory and identical exits preserve the first exit and invalidate',async()=>{
  for(const firstCode of [9,0]){
    const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
      f.owner.emit('spawn');f.message();f.owner.connected=false;f.owner.emit('disconnect');
      f.owner.emit('exit',firstCode,null);f.owner.emit('exit',0,null);f.owner.emit('close',0,null);
    });};
    const result=await supervise(f.input);has(result,'owner_duplicate_exit');
    assert.equal(result.valid,false);assert.equal(result.owner.code,firstCode);
    assert.equal(result.owner.close_code,0);assert.deepEqual(f.owner.kills,[]);
  }
});
test('close before exit stays invalid even when a matching exit arrives afterward',async()=>{
  const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
    f.owner.emit('spawn');f.message();f.owner.connected=false;f.owner.emit('disconnect');
    f.owner.emit('close',0,null);f.owner.emit('exit',0,null);
  });};
  const result=await supervise(f.input);has(result,'owner_close_before_exit');has(result,'owner_out_of_order_exit');
  assert.equal(result.valid,false);assert.equal(result.owner.exited,false);
  assert.equal(result.owner.code,null);assert.equal(result.owner.close_code,0);
  assert.equal(result.cleanup_complete,true);assert.deepEqual(f.owner.kills,[]);
});
test('late owner or task terminal events during publication cannot overwrite accepted facts',async()=>{
  for(const role of ['owner','task']){
    for(const event of ['exit','close']){
      const f=fixture();f.input.publish=async facts=>{
        assert.equal(facts.valid,true);await Promise.resolve();f[role].emit(event,9,null);
      };
      const result=await supervise(f.input);has(result,role+'_duplicate_'+event);
      assert.equal(result.valid,false);assert.equal(result[role].code,0);
      assert.equal(result[role].close_code,0);assert.equal(result[role].lifecycle_invalid,true);
    }
  }
});
test('duplicate spawn and post-close disconnect are sticky even during report await',async()=>{
  for(const event of ['spawn','disconnect']){
    const f=fixture();f.input.publish=async()=>{await Promise.resolve();f.owner.emit(event);};
    const result=await supervise(f.input);
    has(result,event==='spawn'?'owner_unexpected_spawn':'owner_duplicate_disconnect');
    assert.equal(result.valid,false);assert.equal(result.owner.code,0);
  }
});
test('first nonzero close observation is retained across later contradictory closes',async()=>{
  const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
    f.owner.emit('spawn');f.message();f.owner.connected=false;f.owner.emit('disconnect');
    f.owner.emit('exit',0,null);f.owner.emit('close',7,null);f.owner.emit('close',0,null);
  });};
  const result=await supervise(f.input);has(result,'owner_duplicate_close');has(result,'owner_exit_close_mismatch');
  assert.equal(result.owner.code,0);assert.equal(result.owner.close_code,7);assert.equal(result.valid,false);
});
test('exit observed before spawn forbids fallback signaling even without accepted exit facts',async()=>{
  const f=fixture('pi');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
    f.owner.emit('exit',0,null);f.owner.emit('spawn');
  });};
  const result=await supervise(f.input);has(result,'owner_out_of_order_exit');has(result,'owner_unexpected_spawn');
  assert.equal(result.valid,false);assert.equal(result.owner.exited,false);
  assert.deepEqual(f.owner.kills,[]);assert.equal(result.cleanup_complete,false);
});
test('null undefined and hostile thrown values return sanitized failures and still clean up',async()=>{
  const hostile={get safeReason(){throw new Error('private getter');}};
  for(const thrown of [null,undefined,'private text',{safeReason:'private text'},hostile]){
    const f=fixture();f.input.spawnOwner=register=>{register(f.owner);throw thrown;};
    const result=await supervise(f.input);has(result,'launch_or_task_error');
    assert.equal(result.valid,false);assert.equal(result.cleanup_complete,true);
    assert(!JSON.stringify(result).includes('private'));
    const g=fixture();g.input.requestShutdown=async()=>{throw thrown;};
    const stopped=await supervise(g.input);has(stopped,'shutdown_error');
    assert.equal(stopped.cleanup_complete,true);assert(!JSON.stringify(stopped).includes('private'));
  }
});
test('task duplicate exits and close-before-exit obey the same terminal contract',async()=>{
  for(const order of ['duplicate','close-first']){
    const f=fixture();f.input.spawnTask=register=>{register(f.task);queueMicrotask(()=>{
      f.task.emit('spawn');f.message();
      if(order==='duplicate'){
        f.task.emit('exit',9,null);f.task.emit('exit',0,null);f.task.emit('close',0,null);
      }else{f.task.emit('close',0,null);f.task.emit('exit',0,null);}
    });};
    const result=await supervise(f.input);
    has(result,order==='duplicate'?'task_duplicate_exit':'task_close_before_exit');
    assert.equal(result.valid,false);assert.equal(result.task.code,order==='duplicate'?9:null);
    assert.equal(result.owner.code,0);assert.equal(result.cleanup_complete,true);
    assert.deepEqual(f.task.kills,[]);assert(!f.calls.includes('publish'));
  }
});

test('pre-spawn messages cannot be admitted or repaired by later spawn/termination',async()=>{
  for(const order of [
    ['message','spawn','disconnect','exit','close'],
    ['message','spawn','exit','disconnect','close'],
    ['message','disconnect','spawn','exit','close'],
  ]){
    const f=fixture('pi');
    f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
      for(const event of order){
        if(event==='message')f.message();
        else if(event==='disconnect'){f.owner.connected=false;f.owner.emit(event);}
        else if(event==='exit'||event==='close')f.owner.emit(event,0,null);
        else f.owner.emit(event);
      }
    });};
    const result=await supervise(f.input);
    assert.equal(result.valid,false);has(result,'unexpected_channel_message');
    assert.equal(result.message_count,0);assert(!f.calls.includes('publish'));
    assert.equal(result.cleanup_complete,true);assert.deepEqual(f.owner.kills,[]);
  }
});
test('spawn after a pre-spawn disconnect cannot repair owner lifecycle',async()=>{
  const f=fixture('pi');f.input.expectedMessages=0;
  f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
    f.owner.connected=false;f.owner.emit('disconnect');f.owner.emit('spawn');
    f.owner.emit('exit',0,null);f.owner.emit('close',0,null);
  });};
  const result=await supervise(f.input);
  assert.equal(result.valid,false);has(result,'owner_unexpected_spawn');
  assert.equal(result.owner.spawned,false);assert.equal(result.owner.lifecycle_invalid,true);
  assert(!f.calls.includes('publish'));assert.deepEqual(f.owner.kills,[]);
});
test('spawn-first message then disconnect/exit in either order remains valid',async()=>{
  for(const ending of [['disconnect','exit'],['exit','disconnect']]){
    const f=fixture('pi');
    f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{
      f.owner.emit('spawn');f.message();
      for(const event of ending){
        if(event==='disconnect'){f.owner.connected=false;f.owner.emit(event);}
        else f.owner.emit(event,0,null);
      }
      f.owner.emit('close',0,null);
    });};
    const result=await supervise(f.input);
    assert.equal(result.valid,true);assert.equal(result.message_count,1);
    assert.deepEqual(f.calls,['publish']);assert.deepEqual(f.owner.kills,[]);
  }
});
