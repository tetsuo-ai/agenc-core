import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createIdentityAdapters} from './adapters.mjs';
import {loadCanonicalBridge} from './load-bridge.mjs';
import {SOURCE_REVISION,SOURCE_PINS} from './pins.mjs';
import {supervise} from '../real-parent-v5/lifecycle.mjs';

const tuple=()=>({pid:101,instanceId:'synthetic-instance',processStart:'linux:boot:123',
  runtimeVersion:'test',commit:SOURCE_REVISION,buildTime:'synthetic-build'});
const keys=Object.keys(tuple());
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(overrides={}) {
  const calls=[],current=tuple();
  const api={
    readDaemonRuntimeInfo(path){calls.push(['sidecar',path]);return {...current};},
    daemonInstanceIdentityFromRuntimeInfo(info){calls.push(['extract']);return info;},
    resolveAgenCDaemonRuntimeInfoPath(home){return home+'/daemon-runtime.json';},
    readAgenCDaemonProcessStart(...args){calls.push(['process',...args]);return current.processStart;},
    isAgenCDaemonInstanceIdentity(value){return value&&keys.every(key=>key==='pid'?Number.isSafeInteger(value[key])&&value[key]>1:typeof value[key]==='string'&&value[key].length>0);},
    sameAgenCDaemonInstanceIdentity(a,b){return keys.every(key=>a[key]===b[key]);},
    requestAgenCDaemonInstanceIdentity(host){calls.push(['authenticate',host]);return {...current};},
    requestAgenCDaemonShutdown(host,bound){calls.push(['shutdown',host,bound]);},
    resolveAgenCDaemonHome(env){return env.AGENC_HOME;},
    resolveAgenCDaemonRequestTimeoutMs(env){return Number(env.AGENC_DAEMON_REQUEST_TIMEOUT_MS);},
  };
  const input={api,ownedPid:101,daemonHome:'/synthetic/fresh',userHome:'/synthetic/home',
    expectedBuild:tuple(),platform:'linux',requestMs:10,operationMs:40,readyPollMs:1,maxReadyReads:3,...overrides};
  return {api,input,calls,current,make:()=>createIdentityAdapters(input)};
}

test('exact canonical calls use immutable scoped host and canonical tuple extraction',async()=>{
  const f=fixture(),a=f.make();
  const sidecar=await a.identityAdapter.readSidecar();
  assert.deepEqual(sidecar,tuple());assert(Object.isFrozen(sidecar));
  assert.equal(await a.identityAdapter.readProcessStart(101),tuple().processStart);
  const auth=await a.identityAdapter.requestAuthenticatedIdentity();
  assert.deepEqual(await a.requestShutdown(auth),{shuttingDown:true,instanceId:auth.instanceId});
  assert.deepEqual(f.calls.map(call=>call[0]),['sidecar','extract','process','authenticate','shutdown']);
  assert.equal(f.calls[0][1],'/synthetic/fresh/daemon-runtime.json');
  assert.deepEqual(f.calls[2],['process',101]); // no override that could echo sidecar
  const host=f.calls[3][1];assert.equal(f.calls[4][1],host);
  assert(Object.isFrozen(host));assert(Object.isFrozen(host.env));
  assert.deepEqual(host.env,{AGENC_HOME:'/synthetic/fresh',HOME:'/synthetic/home',AGENC_DAEMON_REQUEST_TIMEOUT_MS:'10'});
  for(const name of ['spawnDetachedDaemon','terminatePid','isPidRunning','sleep'])assert.throws(()=>host[name](),/host_capability_denied/);
  assert.equal(a.state().outstanding,false);
});
test('build and home inputs are snapshotted before caller mutation',async()=>{
  const f=fixture(),a=f.make();f.input.expectedBuild.commit='other';f.input.daemonHome='/elsewhere';
  assert.equal((await a.identityAdapter.readSidecar()).commit,SOURCE_REVISION);
  assert.equal(f.calls[0][1],'/synthetic/fresh/daemon-runtime.json');
});
test('Linux-only, positive owned PID, exact revision and deadlines are prerequisites',()=>{
  for(const override of [{platform:'darwin'},{platform:'win32'},{ownedPid:1},
    {daemonHome:'relative'},{daemonHome:'/synthetic/../elsewhere'},{requestMs:40},
    {operationMs:0},{readyPollMs:0},{maxReadyReads:1001},{expectedBuild:{...tuple(),commit:'other'}}]){
    const f=fixture(override);assert.throws(f.make);assert.deepEqual(f.calls,[]);
  }
});
test('canonical home and timeout resolution cannot silently change selected scope',()=>{
  const f=fixture();f.api.resolveAgenCDaemonHome=()=>'/different';assert.throws(f.make,/home_resolution_mismatch/);
  const g=fixture();g.api.resolveAgenCDaemonRequestTimeoutMs=()=>5000;assert.throws(g.make,/request_timeout_mismatch/);
});
test('only initial absent sidecar may poll, bounded by read count; no socket retry',async()=>{
  const f=fixture();let reads=0;f.api.readDaemonRuntimeInfo=()=>++reads<3?null:tuple();
  const a=f.make();await a.identityAdapter.readSidecar();assert.equal(reads,3);
  f.api.readDaemonRuntimeInfo=()=>{reads++;return null;};
  await assert.rejects(a.identityAdapter.readSidecar(),/adapter_operation_failed/);
  assert.equal(reads,4);assert.equal(a.state().poisoned,true);
  assert(!f.calls.some(call=>call[0]==='authenticate'));
});
test('absent readiness exhausts reads without authentication',async()=>{
  const f=fixture();let reads=0;f.api.readDaemonRuntimeInfo=()=>{reads++;return null;};const a=f.make();
  await assert.rejects(a.identityAdapter.readSidecar());assert.equal(reads,3);
  assert.equal(a.state().outstanding,false);assert.equal(a.state().poisoned,true);
});
test('malformed, wrong owner and wrong build sidecars fail immediately',async()=>{
  for(const bad of [null,{...tuple(),pid:102},{...tuple(),commit:'other'},{...tuple(),instanceId:''}]){
    const f=fixture();let reads=0;f.api.readDaemonRuntimeInfo=()=>{reads++;return tuple();};
    f.api.daemonInstanceIdentityFromRuntimeInfo=()=>bad;const a=f.make();
    await assert.rejects(a.identityAdapter.readSidecar());assert.equal(reads,1);
    assert.equal(a.state().poisoned,true);
  }
});
test('sidecar alone never authorizes shutdown',async()=>{
  const f=fixture(),a=f.make();const sidecar=await a.identityAdapter.readSidecar();
  await assert.rejects(a.requestShutdown(sidecar));assert(!f.calls.some(call=>call[0]==='shutdown'));
});
test('wrong OS PID is refused before invoking canonical process read',async()=>{
  const f=fixture(),a=f.make();await assert.rejects(a.identityAdapter.readProcessStart(999));assert.deepEqual(f.calls,[]);
});
test('authenticated response must match preselected owner and build',async()=>{
  for(const field of ['pid','runtimeVersion','commit','buildTime']){
    const f=fixture();f.api.requestAgenCDaemonInstanceIdentity=()=>({...tuple(),[field]:field==='pid'?999:'other'});
    const a=f.make();await assert.rejects(a.identityAdapter.requestAuthenticatedIdentity());assert.equal(a.state().poisoned,true);
  }
});
test('shutdown forwards full authenticated expected tuple and canonical failure yields no ack or retry',async()=>{
  const f=fixture(),a=f.make();const bound=await a.identityAdapter.requestAuthenticatedIdentity();let count=0;
  f.api.requestAgenCDaemonShutdown=(_host,expected)=>{count++;assert.deepEqual(expected,tuple());throw new Error('secret-cookie');};
  await assert.rejects(a.requestShutdown(bound),error=>error.message==='adapter_operation_failed');
  await assert.rejects(a.requestShutdown(bound),/adapter_unavailable/);assert.equal(count,1);
});
test('changed instance is refused before shutdown and successful shutdown is once-only',async()=>{
  const f=fixture(),a=f.make();const bound=await a.identityAdapter.requestAuthenticatedIdentity();
  await assert.rejects(a.requestShutdown({...bound,instanceId:'replacement'}));assert(!f.calls.some(call=>call[0]==='shutdown'));
  const g=fixture(),b=g.make();const accepted=await b.identityAdapter.requestAuthenticatedIdentity();
  await b.requestShutdown(accepted);await assert.rejects(b.requestShutdown(accepted));
  assert.equal(g.calls.filter(call=>call[0]==='shutdown').length,1);
});
test('pre-aborted signal dispatches no operation and permanently poisons adapter',async()=>{
  const f=fixture(),a=f.make(),controller=new AbortController();controller.abort();
  await assert.rejects(a.identityAdapter.requestAuthenticatedIdentity(controller.signal),/operation_aborted/);
  assert.deepEqual(f.calls,[]);await assert.rejects(a.identityAdapter.readSidecar(),/adapter_unavailable/);
});
test('abort retains real in-flight slot; late identity cannot authenticate or enable shutdown',async()=>{
  const f=fixture(),pending=deferred();let count=0;
  f.api.requestAgenCDaemonInstanceIdentity=()=>{count++;return pending.promise;};
  const a=f.make(),controller=new AbortController();const request=a.identityAdapter.requestAuthenticatedIdentity(controller.signal);
  await turn();controller.abort();await assert.rejects(request,/adapter_operation_failed/);
  assert.equal(a.state().outstanding,true);
  await assert.rejects(a.identityAdapter.requestAuthenticatedIdentity(),/adapter_unavailable/);assert.equal(count,1);
  pending.resolve(tuple());await turn();assert.equal(a.state().outstanding,false);
  await assert.rejects(a.requestShutdown(tuple()),/adapter_unavailable/);assert(!f.calls.some(call=>call[0]==='shutdown'));
});
test('timeout keeps one pending operation; late rejection is consumed and cannot rearm',async()=>{
  const f=fixture({requestMs:1,operationMs:10}),pending=deferred();let count=0;
  f.api.readAgenCDaemonProcessStart=()=>{count++;return pending.promise;};const a=f.make();
  await assert.rejects(a.identityAdapter.readProcessStart(101));assert.equal(a.state().outstanding,true);
  await assert.rejects(a.identityAdapter.readProcessStart(101));assert.equal(count,1);
  pending.reject(new Error('private I/O detail'));await turn();assert.equal(a.state().outstanding,false);
  assert.equal(a.state().poisoned,true);
});
test('overlapping calls poison both work streams rather than queueing more requests',async()=>{
  const f=fixture(),pending=deferred();f.api.requestAgenCDaemonInstanceIdentity=()=>pending.promise;
  const a=f.make(),first=a.identityAdapter.requestAuthenticatedIdentity();await turn();
  await assert.rejects(a.identityAdapter.readSidecar(),/operation_overlap/);pending.resolve(tuple());
  await assert.rejects(first);assert(!f.calls.some(call=>call[0]==='sidecar'));
});
test('aborted pending shutdown produces no ack even when canonical shutdown later succeeds',async()=>{
  const f=fixture(),pending=deferred(),a=f.make();const bound=await a.identityAdapter.requestAuthenticatedIdentity();
  let count=0;f.api.requestAgenCDaemonShutdown=()=>{count++;return pending.promise;};
  const controller=new AbortController(),request=a.requestShutdown(bound,controller.signal);await turn();
  controller.abort();await assert.rejects(request);assert.equal(a.state().outstanding,true);
  pending.resolve();await turn();await assert.rejects(a.requestShutdown(bound));assert.equal(count,1);
});
test('close prevents new operations and invalidates pending completion',async()=>{
  const f=fixture(),pending=deferred();f.api.requestAgenCDaemonInstanceIdentity=()=>pending.promise;
  const a=f.make(),request=a.identityAdapter.requestAuthenticatedIdentity();await turn();a.close();
  pending.resolve(tuple());await assert.rejects(request);await assert.rejects(a.identityAdapter.readSidecar());
  assert.equal(a.state().closed,true);
});

class Child extends EventEmitter {
  constructor(pid,connected){super();this.pid=pid;this.connected=connected;this.kills=[];}
  finish(code=0,signal=null){if(this.connected){this.connected=false;this.emit('disconnect');}this.emit('exit',code,signal);this.emit('close',code,signal);}
  kill(signal){this.kills.push(signal);queueMicrotask(()=>this.finish(null,signal));return true;}
}
function lifecycle(f,a){
  const owner=new Child(101,true),task=new Child(102,false),calls=[];
  const input={arm:'light',expectedMessages:0,expectedBuild:tuple(),...a,
    readyMs:60,taskMs:30,stopMs:30,closeMs:10,killGraceMs:10,
    spawnOwner(register){register(owner);queueMicrotask(()=>owner.emit('spawn'));},
    spawnTask(register){calls.push('task');register(task);queueMicrotask(()=>{task.emit('spawn');task.finish();});},
    publish(){calls.push('publish');}};
  const shutdown=f.api.requestAgenCDaemonShutdown;
  f.api.requestAgenCDaemonShutdown=(...args)=>{shutdown(...args);owner.finish();};
  return {input,owner,task,calls};
}
test('real v5 helper drives canonical adapter sequence with authenticated shutdown',async()=>{
  const f=fixture(),a=f.make(),l=lifecycle(f,a);const result=await supervise(l.input);
  assert.equal(result.valid,true);assert.deepEqual(l.calls,['task','publish']);
  assert.equal(f.calls.filter(call=>call[0]==='authenticate').length,3);
  assert.equal(f.calls.filter(call=>call[0]==='process').length,6);
  assert.equal(f.calls.filter(call=>call[0]==='shutdown').length,1);
});
test('v5 prevents task/publication on process mismatch even with valid sidecar',async()=>{
  const f=fixture();f.api.readAgenCDaemonProcessStart=()=> 'linux:other:999';const a=f.make(),l=lifecycle(f,a);
  const result=await supervise(l.input);assert.equal(result.valid,false);assert.deepEqual(l.calls,[]);
  assert(!f.calls.some(call=>call[0]==='authenticate'));assert(!f.calls.some(call=>call[0]==='shutdown'));
});
test('v5 late authenticated result after owner disconnect cannot start task or publish',async()=>{
  const f=fixture(),pending=deferred(),a=f.make(),l=lifecycle(f,a);
  f.api.requestAgenCDaemonInstanceIdentity=()=>{queueMicrotask(()=>{l.owner.connected=false;l.owner.emit('disconnect');});return pending.promise;};
  const result=await supervise(l.input);assert.equal(result.valid,false);assert.deepEqual(l.calls,[]);
  assert.equal(a.state().poisoned,true);assert.equal(a.state().outstanding,true);
  pending.resolve(tuple());await turn();assert.equal(a.state().outstanding,false);assert.deepEqual(l.calls,[]);
});

function bridgeFixture(){
  const bytes=Buffer.from('synthetic reviewed bundle'),f=fixture(),calls=[];
  const module={SOURCE_REVISION,SOURCE_PINS,api:f.api};
  return {module,calls,selection:{path:'/trusted/bridge.mjs',sha256:createHash('sha256').update(bytes).digest('hex')},
    deps:{async readArtifact(path){calls.push(['read',path]);return bytes;},async importModule(url){calls.push(['import',url]);return module;}}};
}
test('bridge loader binds explicit artifact digest, exact source pins and API inventory',async()=>{
  const f=bridgeFixture(),api=await loadCanonicalBridge(f.selection,f.deps);
  assert.equal(api.readDaemonRuntimeInfo,f.module.api.readDaemonRuntimeInfo);assert(Object.isFrozen(api));
  assert.deepEqual(f.calls.map(call=>call[0]),['read','import','read']);
});
test('wrong bridge digest prevents import; changed artifact or metadata refuses API',async()=>{
  const bad=bridgeFixture();await assert.rejects(loadCanonicalBridge({...bad.selection,sha256:'0'.repeat(64)},bad.deps));
  assert.deepEqual(bad.calls.map(call=>call[0]),['read']);
  for(const mutation of ['bytes','revision','pins','api']){
    const f=bridgeFixture();let reads=0;
    if(mutation==='bytes'){const read=f.deps.readArtifact;f.deps.readArtifact=path=>++reads===1?read(path):Buffer.from('changed');}
    if(mutation==='revision')f.module.SOURCE_REVISION='other';
    if(mutation==='pins')f.module.SOURCE_PINS={...SOURCE_PINS,extra:'0'.repeat(64)};
    if(mutation==='api')delete f.module.api.requestAgenCDaemonShutdown;
    await assert.rejects(loadCanonicalBridge(f.selection,f.deps),/bridge_verification_failed/);
  }
});
test('bridge selection is absolute explicit mjs, no fallback package discovery',async()=>{
  for(const path of ['relative.mjs','/trusted/../other.mjs','/trusted/bridge.js']){
    const f=bridgeFixture();await assert.rejects(loadCanonicalBridge({...f.selection,path},f.deps),/bridge_selection_invalid/);
    assert.deepEqual(f.calls,[]);
  }
});
test('post-import refusal is not rollback of module initialization',async()=>{
  const f=bridgeFixture();let initialized=0;
  f.deps.importModule=async()=>{initialized++;return {...f.module,SOURCE_REVISION:'wrong'};};
  await assert.rejects(loadCanonicalBridge(f.selection,f.deps),/bridge_verification_failed/);
  assert.equal(initialized,1); // Requires trusted immutable import closure BEFORE loading.
});
test('uncancellable pre-socket I/O may remain pending but no second operation is admitted',async()=>{
  const f=fixture({requestMs:1,operationMs:5});let calls=0;
  f.api.requestAgenCDaemonInstanceIdentity=()=>{calls++;return new Promise(()=>{});};
  const a=f.make();await assert.rejects(a.identityAdapter.requestAuthenticatedIdentity());
  assert.deepEqual(a.state(),{poisoned:true,closed:false,outstanding:true,shutdown_started:false});
  await assert.rejects(a.identityAdapter.readSidecar());await assert.rejects(a.requestShutdown(tuple()));
  assert.equal(calls,1);a.close();assert.equal(a.state().outstanding,true);
});
