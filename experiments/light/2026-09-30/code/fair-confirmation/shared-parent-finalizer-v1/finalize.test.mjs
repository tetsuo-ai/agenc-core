// UNEXECUTED DRAFT. Temporary synthetic files only; no child/client/provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {finalizeAttempt,PINS} from './finalize.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const encode=x=>Buffer.from(JSON.stringify(x)+'\n');
const ownId=filename=>{const st=fs.lstatSync(filename,{bigint:true});return {dev:String(st.dev),ino:String(st.ino)};};
const keep=[]; // Small synthetic roots intentionally retained for inspection.
function child(pid,ipc=true){return {pid,spawned:true,exit_observed:true,closed:true,ipc_disconnected:ipc?true:null,
  exit_code:0,exit_signal:null,close_code:0,close_signal:null,invalid:false,error:false,timed_out:false,kill_attempted:false,kill_failed:false};}
function fixture(client='pi',states=['known']){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shared-parent-finalizer-draft-')));keep.push(directory);
  const ledgerPath=path.join(directory,'synthetic-ledger.jsonl');
  const contract=encode({fixture:'independent synthetic contract; not a semantic binding proof'});
  fs.writeFileSync(path.join(directory,'contract.json'),contract,{flag:'wx',mode:0o600});
  const expected={run_id:'synthetic',root_turn_id:'root',client,
    binding_profile_id:client==='pi'?'pi-luna-v0731-shared-v1':'light-luna-44aed-source-base-v2',
    protocol_id:'fixture-protocol',channel_id:'fixture-channel',financial_policy_id:'a'.repeat(64),
    observer_source_sha256:PINS.observer,installed_adapter_sha256:PINS.adapter,binding_source_sha256:PINS.binding,
    binding_contract_sha256:sha(contract),task_prompt_sha256:'b'.repeat(64),parent_source_sha256:'c'.repeat(64),
    finalizer_source_sha256:sha(fs.readFileSync(path.join(HERE,'finalize.mjs'))),owner_pid:1234,
    task_pid:client==='light'?1235:null,daemon_identity_sha256:client==='light'?'d'.repeat(64):null};
  const lifecycle={schema_version:1,client,owner:child(1234),task:client==='light'?child(1235,false):null,
    daemon_identity_sha256:expected.daemon_identity_sha256,shutdown_acknowledged:client==='light'?true:null,
    pending_operations:false,journal_quiescent:true,sticky_invalid:false};
  const outcome={normal_exit:true,timed_out:false,budget_stopped:false,code_artifact_pass:true,planning_required:true};
  const rows=[],acks=[];
  states.forEach((state,i)=>{
    const n=i+1,suffix=String(n).padStart(3,'0'),request=encode({model:'synthetic',call:n,stream:true});
    const response=Buffer.from(state==='known'?'data: synthetic-placeholder\n\n':'');
    const common={id:`synthetic:${n}`,run:'synthetic',call:n,financial_schema:1,financial_policy_id:expected.financial_policy_id,
      price_id:'historical-luna-fixture-nanodollars-v1',request_sha256:sha(request)};
    rows.push({event:'admit',...common,reserve:0.01,reserve_nanos:'10000000'});
    if(state==='known')rows.push({event:'settle',...common,usage_missing:false,
      usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}},
      cost_usd:0.00002,budget_charge_usd:0.00002,charge_nanos:'20000',settlement_proof:'completed-full-usage-v1',
      error:null,input_tokens:100,output_tokens:20,cached_tokens:0,uncached_tokens:100});
    else if(state==='unknown')rows.push({event:'settle',...common,usage_missing:true,usage:{},cost_usd:null,
      budget_charge_usd:0.01,charge_nanos:'10000000',error:{type:'unknown_terminal'}});
    const receipt={client,binding_profile_id:expected.binding_profile_id,schema_version:2,
      protocol_id:expected.protocol_id,run_id:expected.run_id,root_turn_id:expected.root_turn_id,
      request_role:n===1?'root':'continuation',admission_id:common.id,call_ordinal:n,prior_root_generations:n-1,
      initial_request:n===1,route:'openai-direct',source:'provider_response_sse',request_body_sha256:sha(request),
      task_prompt_sha256:expected.task_prompt_sha256,response_bytes_sha256:sha(response),response_byte_count:response.length,
      http_status:200,response_content_type:'text/event-stream',requested_stream:true,
      transport_outcome:state==='known'?'eof':'aborted',downstream_delivery_failed:state!=='known',capture_write_complete:true,
      observer_source_sha256:PINS.observer,installed_adapter_sha256:PINS.adapter,binding_source_sha256:PINS.binding,
      binding_contract_sha256:expected.binding_contract_sha256,initial_binding_verified:n===1};
    const receiptRaw=encode(receipt);
    for(const [name,extension,raw]of [['receipt','json',receiptRaw],['request','json',request],['response','sse',response]])
      fs.writeFileSync(path.join(directory,`capture-${name}-${suffix}.${extension}`),raw,{flag:'wx',mode:0o600});
    acks.push({kind:'luna.capture.published.shared.v6',schema_version:1,
      ...Object.fromEntries(['channel_id','protocol_id','run_id','root_turn_id','observer_source_sha256','installed_adapter_sha256',
        'binding_source_sha256','binding_contract_sha256','client','binding_profile_id'].map(k=>[k,expected[k]])),
      admission_id:common.id,call_ordinal:n,publication_ordinal:n,receipt_sha256:sha(receiptRaw),request_body_sha256:sha(request),
      response_bytes_sha256:sha(response),response_byte_count:response.length});
  });
  fs.writeFileSync(ledgerPath,Buffer.concat(rows.map(encode)),{flag:'wx',mode:0o600});
  const args={directory,directoryIdentity:ownId(directory),ledgerPath,ledgerIdentity:ownId(ledgerPath),expected,
    acknowledgments:acks,outcome,observeLifecycle:()=>lifecycle};
  return {args,rows,lifecycle,acks,outcome,directory,ledgerPath,
    rewrite:()=>fs.writeFileSync(ledgerPath,Buffer.concat(rows.map(encode)))};
}
function run(f,io){const returned=finalizeAttempt(f.args,io?{io}:undefined);return {...returned,inventory:JSON.parse(returned.inventoryBytes)};}

test('both arms: admission-derived two-call inventory and unchanged journal bytes',()=>{
  for(const client of ['light','pi']){
    const f=fixture(client,['known','known']),before=fs.readFileSync(f.ledgerPath),out=run(f);
    assert.equal(out.cleanCommitSha256,sha(out.inventoryBytes));
    assert.equal(out.inventory.accounting.admittedCalls,2);assert.equal(out.inventory.accounting.chargeTotalNanodollars,'40000');
    assert.equal(out.inventory.accounting.finalizationAuthorized,false);
    assert.equal(out.inventory.terminal_accounting_complete,true);
    assert.deepEqual(fs.readFileSync(f.ledgerPath),before);
    assert.deepEqual(fs.readFileSync(path.join(f.directory,'parent-attempt-v1.json')),out.inventoryBytes);
  }
});
test('code-check failure is not fabricated capture or code success',()=>{
  const f=fixture();f.outcome.code_artifact_pass=false;const out=run(f);
  assert.equal(out.cleanCommitSha256,sha(out.inventoryBytes));assert.equal(out.inventory.outcome.code_artifact_pass,false);
});
test('missing first or later capture keeps both charges and never searches later success',()=>{
  for(const n of [1,2]){
    const f=fixture('pi',['known','known']);f.acks.splice(n-1,1);const out=run(f);
    assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.accounting.admittedCalls,2);
    assert.equal(out.inventory.accounting.chargeTotalNanodollars,'40000');assert.equal(out.inventory.artifacts[n-1].verified,false);
  }
});
test('unknown, unsettled, historical hold and zero admission remain explicit',()=>{
  const f=fixture('pi',['known','unknown','unsettled']);
  f.rows.unshift({event:'admit',id:'historical:1',run:'historical',call:1,reserve:1});f.rewrite();
  const out=run(f);assert.equal(out.cleanCommitSha256,null);
  assert.equal(out.inventory.accounting.journalExposureNanodollars,'1020020000');
  assert.equal(out.inventory.accounting.unknownHoldNanodollars,'10000000');
  assert.equal(out.inventory.accounting.unsettledReserveNanodollars,'10000000');
  assert.equal(out.inventory.accounting.chargeTotalNanodollars,null);assert.equal(out.inventory.terminal_accounting_complete,false);
  const zero=run(fixture('pi',[]));assert.equal(zero.inventory.accounting.admittedCalls,0);assert.equal(zero.cleanCommitSha256,null);
});
test('malformed whole history is unknown, not erased or reported as zero',()=>{
  const f=fixture();fs.appendFileSync(f.ledgerPath,'{"event":');const before=fs.readFileSync(f.ledgerPath),out=run(f);
  assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.accounting,null);
  assert.equal(out.inventory.ledger.sha256,sha(before));
  assert.ok(out.inventory.reasons.includes('accounting_snapshot_unknown'));assert.deepEqual(fs.readFileSync(f.ledgerPath),before);
});
test('duplicate, extra, cross-arm and hostile acknowledgment inventories retain financial facts',()=>{
  for(const change of [a=>a.push(a[0]),a=>{a[0].client='light';},a=>{a[0].extra='must not persist';},
    a=>{a[0]=new Proxy({}, {ownKeys(){throw new Error('no reflection');}}); }]){
    const f=fixture();change(f.acks);const out=run(f);
    assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.accounting.knownChargeSubtotalNanodollars,'20000');
    assert.equal(out.inventoryBytes.includes(Buffer.from('must not persist')),false);
  }
});
test('admission identity requires exact run colon ordinal, not arbitrary colon or reordered ordinal',()=>{
  for(const id of ['synthetic1','synthetic::1','synthetic:01','synthetic:2','other:1',':1','synthetic:1:extra']){
    const f=fixture();f.acks[0].admission_id=id;const out=run(f);
    assert.equal(out.cleanCommitSha256,null,id);assert.equal(out.inventory.accounting.knownChargeSubtotalNanodollars,'20000');
  }
  const f=fixture('pi',['known','known']);f.acks.reverse();const out=run(f);
  assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.accounting.admittedCalls,2);
});
test('closure, outstanding operation, identity and shutdown failures cannot authorize grading',()=>{
  for(const mutate of [c=>{c.owner.closed=false;},c=>{c.owner.ipc_disconnected=false;},c=>{c.pending_operations=true;},
    c=>{c.journal_quiescent=false;},c=>{c.sticky_invalid=true;},c=>{c.owner.close_code=1;},
    c=>{c.owner.exit_code=c.owner.close_code=null;},c=>{c.owner.pid++;},c=>{c.shutdown_acknowledged=false;}]){
    const f=fixture('light');mutate(f.lifecycle);const out=run(f);assert.equal(out.cleanCommitSha256,null);
    assert.equal(out.inventory.accounting.knownChargeSubtotalNanodollars,'20000');
  }
});
test('async lifecycle is refused and rejected native promise is observed without awaiting',async()=>{
  const f=fixture();f.args.observeLifecycle=()=>Promise.reject(new Error('synthetic'));
  const out=run(f);assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.lifecycle,null);
  await new Promise(resolve=>setImmediate(resolve));
});
test('changed lifecycle before publication records unknown completeness',()=>{
  const f=fixture();let count=0;
  f.args.observeLifecycle=()=>{if(++count===2)f.lifecycle.owner.error=true;return f.lifecycle;};
  const out=run(f);assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.terminal_accounting_complete,false);
  assert.ok(out.inventory.reasons.includes('lifecycle_changed'));
});
test('contract, capture tampering and symlink fail closed without changing journals',()=>{
  for(const target of ['contract.json','capture-response-001.sse','capture-receipt-001.json']){
    const f=fixture();fs.appendFileSync(path.join(f.directory,target),' ');assert.equal(run(f).cleanCommitSha256,null);
  }
  const f=fixture(),target=path.join(f.directory,'capture-response-001.sse');
  fs.renameSync(target,target+'.saved');fs.symlinkSync(target+'.saved',target);assert.equal(run(f).cleanCommitSha256,null);
});
test('journal change during verification cannot authorize old complete totals',()=>{
  const f=fixture();let reads=0;
  const io={...fs,readSync(fd,...rest){const count=fs.readSync(fd,...rest);
    if(fs.fstatSync(fd).ino===fs.statSync(f.ledgerPath).ino&&++reads===1)
      fs.appendFileSync(f.ledgerPath,encode({event:'admit',id:'other:1',run:'other',call:1,reserve:1}));
    return count;}};
  const out=run(f,io);assert.equal(out.cleanCommitSha256,null);
  assert.equal(out.inventory.terminal_accounting_complete,false);
});
test('growth/truncation during capture read is bounded by initial size plus one and refused',()=>{
  for(const change of ['growth','truncation']){
    const f=fixture(),filename=path.join(f.directory,'capture-response-001.sse'),before=fs.statSync(filename);
    let changed=false,bytes=0,maxBuffer=0;
    const io={...fs,readSync(fd,buffer,...args){
      const target=fs.fstatSync(fd).ino===before.ino;
      if(target&&!changed){changed=true;if(change==='growth')fs.appendFileSync(filename,Buffer.alloc(4096));else fs.truncateSync(filename,1);}
      const count=fs.readSync(fd,buffer,...args);if(target){bytes+=count;maxBuffer=Math.max(maxBuffer,buffer.length);}return count;
    }};
    const out=run(f,io);assert.equal(out.cleanCommitSha256,null);assert.equal(out.inventory.artifacts[0].verified,false);
    assert.ok(changed);assert.equal(maxBuffer,before.size+1);assert.ok(bytes<=before.size+1);
  }
});
test('full short-write loop succeeds; write/fsync/link faults never return authority',()=>{
  const f=fixture();let writes=0;
  const short={...fs,writeSync(fd,raw,offset,length){writes++;return fs.writeSync(fd,raw,offset,Math.min(7,length));}};
  assert.ok(run(f,short).cleanCommitSha256);assert.ok(writes>1);
  for(const operation of ['writeSync','fsyncSync','linkSync']){
    const failed=fixture(),before=fs.readFileSync(failed.ledgerPath),io={...fs,[operation](){throw new Error('synthetic I/O');}};
    assert.throws(()=>run(failed,io));assert.deepEqual(fs.readFileSync(failed.ledgerPath),before);
  }
  const stalled=fixture();assert.throws(()=>run(stalled,{...fs,writeSync(){return 0;}}),/inventory_write_failed/);
  for(const failAt of [1,2,3]){
    const failed=fixture();let syncs=0;
    const io={...fs,fsyncSync(fd){if(++syncs===failAt)throw new Error('selected fsync boundary');return fs.fsyncSync(fd);}};
    assert.throws(()=>run(failed,io));assert.equal(syncs,failAt);
  }
});
test('post-link sync failure can leave final file, but no successful return and no rescan API',()=>{
  const f=fixture();let linked=false;
  const io={...fs,linkSync(...args){fs.linkSync(...args);linked=true;},fsyncSync(fd){if(linked)throw new Error('after link');fs.fsyncSync(fd);}};
  assert.throws(()=>run(f,io));assert.equal(fs.existsSync(path.join(f.directory,'parent-attempt-v1.json')),true);
  assert.throws(()=>run(f)); // pending path is exclusive; no automatic restart/overwrite.
});
test('late lifecycle contradiction after durable link prevents returned capability',()=>{
  const f=fixture();let count=0;
  f.args.observeLifecycle=()=>{if(++count===3)f.lifecycle.sticky_invalid=true;return f.lifecycle;};
  assert.throws(()=>run(f),/postcommit_lifecycle_changed/);
  assert.equal(fs.existsSync(path.join(f.directory,'parent-attempt-v1.json')),true);
});
test('directory identity and expected source mismatch refuse before writes',()=>{
  const f=fixture();f.args.directoryIdentity.ino='0';assert.throws(()=>run(f),/attempt_directory_changed/);
  assert.equal(fs.existsSync(path.join(f.directory,'parent-attempt-v1.json.pending')),false);
  const other=fixture();other.args.expected.observer_source_sha256='0'.repeat(64);assert.throws(()=>run(other),/unsupported_current_sources/);
});
