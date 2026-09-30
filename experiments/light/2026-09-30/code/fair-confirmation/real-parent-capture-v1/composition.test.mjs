import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {supervise} from './lifecycle.mjs';
import {createDispatcher,DEPENDENCIES} from './dispatcher.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const expected={channel_id:'synthetic-owned-channel',protocol_id:'synthetic-protocol',run_id:'synthetic-run',root_turn_id:'root-1',
    observer_source_sha256:DEPENDENCIES.luna_observer_v5,installed_adapter_sha256:'a'.repeat(64),
    binding_source_sha256:DEPENDENCIES.binding_v2,binding_contract_sha256:'b'.repeat(64),publication_count:1};
  const {publication_count:_,...common}=expected;
  const ack={...common,kind:'luna.capture.published.v5',schema_version:1,call_ordinal:1,publication_ordinal:1,
    admission_id:'synthetic-run:1',receipt_sha256:'c'.repeat(64),request_body_sha256:'d'.repeat(64),
    response_bytes_sha256:'e'.repeat(64),response_byte_count:17};
  return {expected,ack};
}
const limits={readyMs:2000,taskMs:2000,stopMs:500,closeMs:1000,killGraceMs:500};
function launch(register,mode,ack) {
  const child=fork(path.join(here,'child.mjs'),[mode,JSON.stringify(ack)],
    {execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{}});
  register(child); // Immediate actual ChildProcess ownership, no event filtering.
  return child;
}
async function run(mode='normal',change={}) {
  const f=fixture(),dispatcher=createDispatcher(f.expected);
  const lifecycle=await supervise({arm:'pi',expectedMessages:1,...limits,
    spawnOwner:register=>launch(register,mode,f.ack),dispatchOwnerMessage:dispatcher.dispatch,...change});
  return {...f,lifecycle,inventory:dispatcher.finish(lifecycle)};
}

test('source pins and unchanged inherited lifecycle tests',()=>{
  for(const [name,relative] of Object.entries({lifecycle_v5:'real-parent-v5/lifecycle.mjs',
    lifecycle_tests_v5:'real-parent-v5/lifecycle.test.mjs',luna_observer_v5:'luna-capture-v5/direct.mjs',
    publication_gate_v5:'luna-capture-v5/publication_gate.py',old_parent_fixture_v5:'luna-capture-v5/parent_fixture.mjs',
    binding_v2:'prompt-binding-v2/prompt_binding.py'})) {
    assert.equal(sha(fs.readFileSync(path.join(here,'..',relative))),DEPENDENCIES[name]);
  }
  assert.equal(sha(fs.readFileSync(path.join(here,'lifecycle.test.mjs'))),DEPENDENCIES.lifecycle_tests_v5);
});
test('actual owned child composes lifecycle and exact Luna publication messages',async()=>{
  const result=await run();
  assert.equal(result.lifecycle.valid,true);assert.equal(result.lifecycle.message_count,1);
  assert.equal(result.inventory.composition_verified,true);assert.equal(result.inventory.finalization_authorized,false);
  assert.deepEqual(result.inventory.acknowledgments,[result.ack]);
  assert.equal(result.lifecycle.owner.disconnected,true);assert.equal(result.lifecycle.cleanup_complete,true);
});
for(const mode of ['unknown','malformed','wrong-channel','wrong-order','duplicate','nonzero','owner-exit']) {
  test(`actual child ${mode} never yields an accepted composition`,async()=>{
    const result=await run(mode);
    assert.equal(result.inventory.composition_verified,false);
    assert.equal(result.inventory.finalization_authorized,false);
    assert.equal(result.lifecycle.cleanup_complete,true);
    assert.equal(result.lifecycle.valid,false);
  });
}
test('optional capture failure leaves clean lifecycle but missing publication',async()=>{
  const result=await run('capture-failure');
  assert.equal(result.lifecycle.valid,true);assert.equal(result.inventory.composition_verified,false);
  assert.equal(result.inventory.acknowledgments.length,0);
  // No financial code is imported: this is NOT a settlement correctness proof.
});
test('dispatcher exceptions, promises and malformed return tags are sticky refusal',async()=>{
  for(const dispatch of [()=>{throw null;},()=>Promise.resolve({kind:'publication'}),
    ()=>({kind:'publication',extra:true}),()=>({get kind(){return 'publication';}}),()=>({kind:'unknown'})]) {
    const result=await run('normal',{dispatchOwnerMessage:dispatch});
    assert.equal(result.lifecycle.valid,false);assert(result.lifecycle.issues.includes('invalid_owner_dispatch'));
  }
});
test('Light sibling cannot publish on the owner channel; actual owner still contained',async()=>{
  const f=fixture(),dispatcher=createDispatcher(f.expected);let owner;
  const build={runtimeVersion:'synthetic',commit:'synthetic',buildTime:'synthetic'};
  const identity=()=>({pid:owner.pid,instanceId:'owned-instance',processStart:'synthetic-start',...build});
  const lifecycle=await supervise({arm:'light',expectedMessages:1,expectedBuild:build,...limits,
    spawnOwner:register=>{owner=launch(register,'light-wait',f.ack);},
    spawnTask:register=>launch(register,'wrong-owner-task',f.ack),dispatchOwnerMessage:dispatcher.dispatch,
    identityAdapter:{readSidecar:async()=>identity(),readProcessStart:async()=>identity().processStart,
      requestAuthenticatedIdentity:async()=>identity()},
    requestShutdown:async bound=>{owner.send('shutdown');return {shuttingDown:true,instanceId:bound.instanceId};}});
  assert.equal(lifecycle.valid,false);assert(lifecycle.issues.includes('unexpected_channel_message'));
  assert.equal(lifecycle.cleanup_complete,true);assert.equal(dispatcher.finish(lifecycle).composition_verified,false);
});
test('actual Light-shaped owner and no-op sibling compose publication before bound shutdown',async()=>{
  const f=fixture(),dispatcher=createDispatcher(f.expected);let owner,received;
  const publication=new Promise(resolve=>{received=resolve;});
  const build={runtimeVersion:'synthetic',commit:'synthetic',buildTime:'synthetic'};
  const identity=()=>({pid:owner.pid,instanceId:'owned-instance',processStart:'synthetic-start',...build});
  const lifecycle=await supervise({arm:'light',expectedMessages:1,expectedBuild:build,...limits,
    spawnOwner:register=>{owner=launch(register,'light-wait',f.ack);},
    spawnTask:register=>{owner.send('publish');return launch(register,'task-noop',f.ack);},
    dispatchOwnerMessage(message,context){const tag=dispatcher.dispatch(message,context);if(tag.kind==='publication')received();return tag;},
    identityAdapter:{readSidecar:async()=>identity(),readProcessStart:async()=>identity().processStart,
      requestAuthenticatedIdentity:async()=>identity()},
    requestShutdown:async bound=>{await publication;owner.send('shutdown');return {shuttingDown:true,instanceId:bound.instanceId};}});
  assert.equal(lifecycle.valid,true,JSON.stringify(lifecycle));assert.equal(lifecycle.cleanup_complete,true);
  assert.equal(lifecycle.shutdown,'acknowledged');assert.equal(lifecycle.task.code,0);
  const inventory=dispatcher.finish(lifecycle);
  assert.equal(inventory.composition_verified,true);assert.equal(inventory.finalization_authorized,false);
});

class InjectedChild extends EventEmitter {
  constructor(){super();this.pid=12345;this.connected=true;}
  kill(){throw new Error('must not kill a closed child');}
  close(){this.connected=false;this.emit('disconnect');this.emit('exit',0,null);this.emit('close',0,null);}
}
test('pre-spawn and post-disconnect/exit/close publication messages refuse before dispatcher',async()=>{
  for(const stage of ['pre-spawn','disconnect','exit','close']) {
    const f=fixture(),dispatcher=createDispatcher(f.expected),child=new InjectedChild();
    const lifecycle=await supervise({arm:'pi',expectedMessages:0,...limits,dispatchOwnerMessage:dispatcher.dispatch,
      spawnOwner(register){register(child);queueMicrotask(()=>{
        if(stage==='pre-spawn')child.emit('message',f.ack);
        child.emit('spawn');
        child.connected=false;child.emit('disconnect');
        if(stage==='disconnect')child.emit('message',f.ack);
        child.emit('exit',0,null);
        if(stage==='exit')child.emit('message',f.ack);
        child.emit('close',0,null);
        if(stage==='close')child.emit('message',f.ack);
      });}});
    assert.equal(lifecycle.valid,false);assert.equal(dispatcher.finish(lifecycle).acknowledgments.length,0);
  }
});
test('late publication during parent report persistence cannot become final success',async()=>{
  const f=fixture(),dispatcher=createDispatcher(f.expected),child=new InjectedChild();
  const lifecycle=await supervise({arm:'pi',expectedMessages:0,...limits,dispatchOwnerMessage:dispatcher.dispatch,
    spawnOwner(register){register(child);queueMicrotask(()=>{child.emit('spawn');child.emit('message',f.ack);child.close();});},
    async publish(){child.emit('message',f.ack);}});
  assert.equal(lifecycle.valid,false);assert.equal(dispatcher.finish(lifecycle).composition_verified,false);
});
test('dispatcher sealed snapshot cannot accept subsequent traffic',()=>{
  const f=fixture(),d=createDispatcher(f.expected);d.dispatch(f.ack,{pid:12});
  assert.equal(d.finish({valid:true,cleanup_complete:true}).composition_verified,true);
  assert.throws(()=>d.dispatch(f.ack,{pid:12}));
  assert.equal(d.finish({valid:true,cleanup_complete:true}).composition_verified,false);
});
test('frozen Python gate validates ack inventory but refuses new parent identity',async()=>{
  const result=await run();
  const expected={...result.expected,parent_source_sha256:DEPENDENCIES.publication_gate_v5,
    ipc_parent_source_sha256:sha(fs.readFileSync(path.join(here,'dispatcher.mjs')))};
  const program=`import json,runpy,sys\ng=runpy.run_path(sys.argv[1])\nx=json.loads(sys.stdin.read())\ng['validate_acks'](x['acks'],x['expected'])\ntry:\n g['finalize_parent_inventory'](directory='UNUSED-NO-WRITES',acks=x['acks'],expected=x['expected'],child_exit_code=0,ipc_closed=True)\nexcept g['PublicationUnknown'] as e:\n assert str(e)=='ipc_parent_source_pin_mismatch',str(e)\n print('new_parent_refused')\nelse:\n raise AssertionError('unexpected finalization')\n`;
  const python=spawnSync('python3',['-I','-S','-B','-c',program,path.join(here,'../luna-capture-v5/publication_gate.py')],
    {input:JSON.stringify({acks:result.inventory.acknowledgments,expected}),encoding:'utf8',timeout:3000,maxBuffer:4096,env:{}});
  assert.equal(python.status,0,python.stderr);assert.equal(python.stdout.trim(),'new_parent_refused');
});
