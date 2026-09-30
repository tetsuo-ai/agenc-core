import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runCase,containRegistered} from './control.mjs';
import {validateSelection} from './selection.mjs';
import {SOURCE_REVISION} from '../real-parent-adapters-v1/pins.mjs';
const tuple=()=>({pid:101,instanceId:'synthetic-owner',processStart:'linux:boot:42',
  runtimeVersion:'synthetic',commit:SOURCE_REVISION,buildTime:'synthetic-time'});
class Child extends EventEmitter {
  constructor(pid,ipc){super();this.pid=pid;this.connected=ipc;this.kills=[];}
  finish(code=0,signal=null){if(this.connected){this.connected=false;this.emit('disconnect');}this.emit('exit',code,signal);this.emit('close',code,signal);}
  kill(signal){this.kills.push(signal);queueMicrotask(()=>this.finish(null,signal));return true;}
}
function fixture(caseName='normal'){
  const owner=new Child(101,true),sentinel=new Child(102,false),calls=[];let cookieGood=true;
  const api={
    readDaemonRuntimeInfo(){calls.push('sidecar');return tuple();},
    daemonInstanceIdentityFromRuntimeInfo:info=>info,
    resolveAgenCDaemonRuntimeInfoPath:home=>home+'/daemon-runtime.json',
    readAgenCDaemonProcessStart:()=>tuple().processStart,
    isAgenCDaemonInstanceIdentity:value=>value&&Object.keys(tuple()).every(key=>typeof value[key]===typeof tuple()[key]),
    sameAgenCDaemonInstanceIdentity:(a,b)=>Object.keys(tuple()).every(key=>a[key]===b[key]),
    requestAgenCDaemonInstanceIdentity(){calls.push('identity');if(!cookieGood)throw new Error('daemon connection authentication failed');return tuple();},
    requestAgenCDaemonShutdown(_host,bound){assert.deepEqual(bound,tuple());calls.push('shutdown');owner.finish();},
    resolveAgenCDaemonHome:env=>env.AGENC_HOME,
    resolveAgenCDaemonRequestTimeoutMs:env=>Number(env.AGENC_DAEMON_REQUEST_TIMEOUT_MS),
  };
  const input={caseName,api,expectedBuild:tuple(),daemonHome:'/synthetic/fresh',userHome:'/synthetic/home',platform:'linux',
    readyMs:80,operationMs:60,requestMs:5,taskMs:10,stopMs:10,closeMs:10,killGraceMs:5,drainMs:15,
    spawnOwner(register){register(owner);queueMicrotask(()=>{owner.emit('spawn');if(caseName==='owner-exit-before-readiness')owner.finish(73);});},
    spawnSentinel(register){calls.push('sentinel');register(sentinel);queueMicrotask(()=>{sentinel.emit('spawn');sentinel.finish();});},
    corruptFreshCookie(){calls.push('corrupt');cookieGood=false;},
  };
  return {input,api,owner,sentinel,calls};
}
test('normal canonical seam proves readiness, runs no-op sentinel, and performs bound shutdown',async()=>{
  const f=fixture(),r=await runCase(f.input);
  assert.equal(r.case_pass,true);assert.equal(r.lifecycle.valid,true);assert.equal(r.contained,true);
  assert.equal(r.task_cli_calls,0);assert.equal(r.sentinel_starts,1);assert.equal(r.publication_calls,0);
  assert.equal(r.identity_successes,3);assert.equal(r.shutdown_attempts,1);
  assert.deepEqual(f.owner.kills,[]);assert.deepEqual(f.sentinel.kills,[]);
});
test('early owner exit is distinct expected negative case and launches neither sentinel nor authentication',async()=>{
  const f=fixture('owner-exit-before-readiness'),r=await runCase(f.input);
  assert.equal(r.case_pass,true);assert.equal(r.lifecycle.valid,false);assert.equal(r.lifecycle.owner.code,73);
  assert.equal(r.identity_attempts,0);assert.equal(r.sentinel_starts,0);assert.equal(r.contained,true);
  assert.deepEqual(f.owner.kills,[]);
});
test('cookie refusal invokes real injected canonical function and only kills exact owned child',async()=>{
  const f=fixture('authenticated-identity-refusal'),r=await runCase(f.input);
  assert.equal(r.case_pass,true);assert.equal(r.lifecycle.valid,false);assert.equal(r.refusal_injected,true);
  assert.equal(r.identity_attempts,1);assert.equal(r.identity_successes,0);assert.equal(r.shutdown_attempts,0);
  assert.equal(r.sentinel_starts,0);assert.deepEqual(f.owner.kills,['SIGKILL']);assert.deepEqual(f.sentinel.kills,[]);
  assert(f.calls.indexOf('sidecar')<f.calls.indexOf('corrupt'));assert(f.calls.indexOf('corrupt')<f.calls.indexOf('identity'));
});
test('normal case cannot relabel authentication failure as expected success',async()=>{
  const f=fixture();f.api.requestAgenCDaemonInstanceIdentity=()=>{throw new Error('private');};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.contained,true);
  assert(!JSON.stringify(r).includes('private'));assert.equal(r.refusal_injected,false);
});
test('refusal case cannot pass when the cookie change fails or authentication accepts it',async()=>{
  for(const kind of ['mutation','accepted']){
    const f=fixture('authenticated-identity-refusal');
    if(kind==='mutation')f.input.corruptFreshCookie=()=>{throw new Error('private-file-failure');};
    else f.api.requestAgenCDaemonInstanceIdentity=()=>tuple();
    const r=await runCase(f.input);assert.equal(r.case_pass,false);assert(!JSON.stringify(r).includes('private'));
  }
});
test('wrong early-exit code or later normal lifecycle does not satisfy early case',async()=>{
  const f=fixture('owner-exit-before-readiness');f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{f.owner.emit('spawn');f.owner.finish(74);});};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);
});
test('unrelated transport failure cannot masquerade as confirmed authentication refusal',async()=>{
  const f=fixture('authenticated-identity-refusal');
  f.api.requestAgenCDaemonInstanceIdentity=()=>{throw new Error('private socket failure');};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.identity_refusal_confirmed,false);
});
test('unexpected channel activity also invalidates expected negative cases',async()=>{
  const f=fixture('authenticated-identity-refusal'),original=f.api.requestAgenCDaemonInstanceIdentity;
  f.api.requestAgenCDaemonInstanceIdentity=()=>{f.owner.emit('message',{kind:'forbidden-provider-fetch'});return original();};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.identity_refusal_confirmed,true);
});
test('registered owner remains supervised if adapter construction fails',async()=>{
  const f=fixture();f.input.expectedBuild={...tuple(),commit:'wrong'};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.requires_container_teardown,true);
  assert.deepEqual(f.owner.kills,['SIGKILL']);assert.equal(r.lifecycle.cleanup_complete,true);
});
test('post-registration spawn failure cannot skip bounded owner cleanup',async()=>{
  const f=fixture();f.input.spawnOwner=register=>{register(f.owner);throw new Error('log close');};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.deepEqual(f.owner.kills,['SIGKILL']);
  assert.equal(r.lifecycle.cleanup_complete,true);
});
test('sentinel failure cannot claim normal readiness/shutdown success',async()=>{
  const f=fixture();f.input.spawnSentinel=register=>{register(f.sentinel);queueMicrotask(()=>{f.sentinel.emit('spawn');f.sentinel.finish(9);});};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.shutdown_attempts,1);
});
test('unexpected owner IPC message invalidates normal case',async()=>{
  const f=fixture(),original=f.api.requestAgenCDaemonShutdown;
  f.api.requestAgenCDaemonShutdown=(...args)=>{f.owner.emit('message',{kind:'forbidden-provider-fetch'});return original(...args);};
  const r=await runCase(f.input);assert.equal(r.case_pass,false);assert(r.lifecycle.issues.includes('invalid_owner_message'));
});
test('unsettled canonical operation after child closure requires container teardown',async()=>{
  const f=fixture();let resolve;
  f.api.requestAgenCDaemonInstanceIdentity=()=>{queueMicrotask(()=>{f.owner.connected=false;f.owner.emit('disconnect');});return new Promise(r=>{resolve=r;});};
  const result=await runCase(f.input);
  assert.equal(result.lifecycle.cleanup_complete,true);assert.equal(result.adapter.outstanding,true);
  assert.equal(result.case_pass,false);assert.equal(result.contained,false);assert.equal(result.requires_container_teardown,true);
  assert.equal(result.sentinel_starts,0);resolve(tuple());await new Promise(r=>setImmediate(r));
  assert.equal(result.case_pass,false);assert.equal(result.publication_calls,0);
});
test('failed owned kill/close stays uncontained',async()=>{
  const f=fixture('authenticated-identity-refusal');f.owner.kill=signal=>{f.owner.kills.push(signal);return false;};
  const result=await runCase(f.input);assert.equal(result.contained,false);assert.equal(result.case_pass,false);
  assert.equal(result.requires_container_teardown,true);assert.deepEqual(f.owner.kills,['SIGKILL']);
});
test('containment fallback waits boundedly and never signals exited or foreign children',async()=>{
  const a=new Child(1,false),b=new Child(2,false),foreign=new Child(3,false);
  const records=[{child:a,exited:false,closed:false},{child:b,exited:true,closed:false}];
  for(const r of records)r.child.on('close',()=>{r.closed=true;});
  assert.equal(await containRegistered(records,5),false);
  assert.deepEqual(a.kills,['SIGKILL']);assert.deepEqual(b.kills,[]);assert.deepEqual(foreign.kills,[]);
});
test('containment catches thrown kill and reports close uncertainty',async()=>{
  const child=new Child(1,false);child.kill=()=>{throw new Error('private');};
  assert.equal(await containRegistered([{child,exited:false,closed:false}],5),false);
});
test('invalid case/deadline refuses before any child creation',async()=>{
  for(const overrides of [{caseName:'all'},{drainMs:0},{closeMs:60001}]){
    const f=fixture();await assert.rejects(runCase({...f.input,...overrides}));assert.deepEqual(f.calls,[]);
  }
});
function selection(){return {version:2,source_revision:SOURCE_REVISION,core_root:'/frozen/core',node_path:'/bin/node',
  bridge:{path:'/frozen/bridge.mjs',sha256:'a'.repeat(64)},expected_build:tuple(),reviewed_full_closure:true,
  files:{'/bin/node':'b'.repeat(64),'/frozen/bridge.mjs':'a'.repeat(64),'/frozen/core/runtime/bin/agenc':'c'.repeat(64),'/frozen/core/runtime/dist/VERSION':'d'.repeat(64)}};}
test('root selection requires exact source/build, explicit node/launcher/VERSION/bridge pins',()=>{
  const original=selection(),s=validateSelection(original);assert(Object.isFrozen(s));assert(Object.isFrozen(s.files));
  original.files['/bin/node']='e'.repeat(64);assert.equal(s.files['/bin/node'],'b'.repeat(64));
  for(const key of Object.keys(selection().files)){const value=selection();delete value.files[key];assert.throws(()=>validateSelection(value));}
});
test('unknown revision, unreviewed closure, missing bridge hash and relative paths refuse selection',()=>{
  for(const change of [{source_revision:'other'},{reviewed_full_closure:false},{node_path:'node'},
    {bridge:{path:'/frozen/bridge.mjs'}},{expected_build:{...tuple(),commit:'other'}}])
    assert.throws(()=>validateSelection({...selection(),...change}));
});
test('well-shaped v5 IPC cannot pass either expected negative case',async()=>{
  for(const caseName of ['owner-exit-before-readiness','authenticated-identity-refusal']){
    const f=fixture(caseName);
    const message=()=>f.owner.emit('message',{kind:'lifecycle-probe-v5',pid:101,ordinal:1,connected:true});
    if(caseName==='owner-exit-before-readiness')f.input.spawnOwner=register=>{register(f.owner);queueMicrotask(()=>{f.owner.emit('spawn');message();f.owner.finish(73);});};
    else {const original=f.api.requestAgenCDaemonInstanceIdentity;f.api.requestAgenCDaemonInstanceIdentity=()=>{message();return original();};}
    const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.lifecycle.message_count,1);
    assert(r.lifecycle.issues.includes('message_count_mismatch'));
  }
});
test('exit/close mismatch cannot pass either expected negative case',async()=>{
  for(const caseName of ['owner-exit-before-readiness','authenticated-identity-refusal']){
    const f=fixture(caseName);
    f.owner.finish=(code=0,signal=null)=>{
      if(f.owner.connected){f.owner.connected=false;f.owner.emit('disconnect');}
      f.owner.emit('exit',code,signal);f.owner.emit('close',0,null);
    };
    const r=await runCase(f.input);assert.equal(r.case_pass,false);assert.equal(r.lifecycle.owner.lifecycle_invalid,true);
    assert(r.lifecycle.issues.includes('owner_exit_close_mismatch'));
  }
});
test('owner errors and contradictory duplicate terminal events invalidate negative cases',async()=>{
  for(const caseName of ['owner-exit-before-readiness','authenticated-identity-refusal']){
    for(const fault of ['error','duplicate']){
      const f=fixture(caseName),finish=f.owner.finish.bind(f.owner);
      f.owner.finish=(code=0,signal=null)=>{finish(code,signal);
        if(fault==='error')f.owner.emit('error',new Error('private'));
        else f.owner.emit('exit',code,signal);
      };
      const r=await runCase(f.input);assert.equal(r.case_pass,false);
      assert.equal(r.lifecycle.owner.lifecycle_invalid,true);
    }
  }
});
test('v1 selection is never silently adopted by v2',()=>{
  assert.throws(()=>validateSelection({...selection(),version:1}),/selection_invalid/);
});
