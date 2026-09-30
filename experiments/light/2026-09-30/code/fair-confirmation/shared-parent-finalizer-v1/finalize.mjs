// DRAFT: no execution authorized yet. Trusted-parent terminal evidence only.
// No child launch, provider, financial append, stop clearing or retry lives here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
export const PINS=Object.freeze({
  reconcile:'dbc239d6d13f611143b473476a40ac2421eca0bb51277fb19375ea336a606dc9',
  parser:'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
  observer:'8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
  adapter:'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
  binding:'9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112',
  scorer:'73c3cf7ca4360a94f5ec334cf751573a15ee4af3863e3f1571ad5d84f549f780',
});
const MAX_LEDGER=16*1024*1024, MAX_RESPONSE=64*1024*1024, MAX_INVENTORY=16*1024*1024;
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const fail=reason=>{throw new Error(reason);};
const need=(ok,reason)=>{if(!ok)fail(reason);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,240}$/.test(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.toSorted().join();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const profiles={light:'light-luna-44aed-source-base-v2',pi:'pi-luna-v0731-shared-v1'};
const reconcileKeys=['run_id','root_turn_id','client','binding_profile_id','protocol_id','channel_id','financial_policy_id',
  'observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'];
const expectedKeys=[...reconcileKeys,'task_prompt_sha256','parent_source_sha256','finalizer_source_sha256','owner_pid','task_pid','daemon_identity_sha256'];
const ackKeys=['kind','schema_version','channel_id','protocol_id','run_id','root_turn_id','admission_id','call_ordinal','publication_ordinal',
  'receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256',
  'binding_source_sha256','binding_contract_sha256','client','binding_profile_id'];
const receiptKeys=['client','binding_profile_id','schema_version','protocol_id','run_id','root_turn_id','request_role','admission_id',
  'call_ordinal','prior_root_generations','initial_request','route','source','request_body_sha256','task_prompt_sha256','response_bytes_sha256',
  'response_byte_count','http_status','response_content_type','requested_stream','transport_outcome','downstream_delivery_failed',
  'capture_write_complete','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','initial_binding_verified'];
const childKeys=['pid','spawned','exit_observed','closed','ipc_disconnected','exit_code','exit_signal','close_code','close_signal',
  'invalid','error','timed_out','kill_attempted','kill_failed'];
const closureKeys=['schema_version','client','owner','task','daemon_identity_sha256','shutdown_acknowledged','pending_operations','journal_quiescent','sticky_invalid'];
const outcomeKeys=['normal_exit','timed_out','budget_stopped','code_artifact_pass','planning_required'];
const intrinsicThen=Promise.prototype.then;

// Copy only bounded plain data; no getters, proxy traps, toJSON or thenables.
// Trusted callbacks/intrinsics/species are not an adversarial JavaScript sandbox.
function snapshot(value){
  let nodes=0;
  const active=new Set();
  function copy(v,depth=0){
    need(++nodes<=200000&&depth<=24,'invalid_parent_data');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){
      need(v.length<=1024*1024&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v),'invalid_parent_data');return v;
    }
    if(typeof v==='number'){need(Number.isSafeInteger(v),'invalid_parent_data');return v;}
    need(v!==null&&typeof v==='object'&&!types.isProxy(v)&&!active.has(v),'invalid_parent_data');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'invalid_parent_data');
    const keys=Reflect.ownKeys(v);
    need(keys.every(k=>typeof k==='string'),'invalid_parent_data');
    active.add(v);
    let out;
    if(array){
      need(v.length<=10000&&keys.length===v.length+1,'invalid_parent_data');out=[];
      for(let i=0;i<v.length;i++){
        const d=Object.getOwnPropertyDescriptor(v,String(i));need(d&&d.enumerable&&'value'in d,'invalid_parent_data');out.push(copy(d.value,depth+1));
      }
    }else{
      out=Object.create(null);
      for(const k of keys.toSorted()){
        const d=Object.getOwnPropertyDescriptor(v,k);need(d&&d.enumerable&&'value'in d,'invalid_parent_data');out[k]=copy(d.value,depth+1);
      }
    }
    active.delete(v);return Object.freeze(out);
  }
  return copy(value);
}
function fileIdentity(st){return {dev:String(st.dev),ino:String(st.ino)};}
function validateFileIdentity(value){need(exact(value,['dev','ino'])&&['dev','ino'].every(k=>typeof value[k]==='string'&&/^[0-9]{1,32}$/.test(value[k])),'invalid_file_identity');}
function readRegular(io,filename,max){
  const fd=io.openSync(filename,io.constants.O_RDONLY|io.constants.O_NOFOLLOW);
  try{
    const before=io.fstatSync(fd,{bigint:true});
    need(before.isFile()&&before.size<=BigInt(max),'artifact_type_or_size');
    // The extra byte detects growth without ever allocating/reading an
    // unbounded changed file after the initial size check.
    const buffer=Buffer.allocUnsafe(Number(before.size)+1);let used=0;
    while(used<buffer.length){
      const count=io.readSync(fd,buffer,used,buffer.length-used,null);
      need(Number.isInteger(count)&&count>=0&&count<=buffer.length-used,'artifact_read_failed');
      if(count===0)break;used+=count;
    }
    const raw=buffer.subarray(0,used),after=io.fstatSync(fd,{bigint:true}),named=io.lstatSync(filename,{bigint:true});
    need(raw.length===Number(before.size)&&after.size===before.size&&after.mtimeNs===before.mtimeNs&&after.ctimeNs===before.ctimeNs&&
      after.dev===before.dev&&after.ino===before.ino&&named.isFile()&&named.dev===before.dev&&named.ino===before.ino&&
      named.size===before.size&&named.mtimeNs===before.mtimeNs&&named.ctimeNs===before.ctimeNs,'artifact_changed');
    return {raw,identity:fileIdentity(before),bytes:raw.length,sha256:sha(raw)};
  }finally{io.closeSync(fd);}
}
for(const [name,pin]of [['../shared-attempt-v1/reconcile.mjs',PINS.reconcile],['../luna-finance-v1/ledger-json.mjs',PINS.parser]]){
  need(readRegular(fs,path.resolve(HERE,name),256*1024).sha256===pin,'dependency_pin_mismatch');
}
// Imports are pinned but retain the existing immutable-path/closure assumption.
const {reconcileAttempt}=await import('../shared-attempt-v1/reconcile.mjs');
const {parseLedgerBytes,numericLexeme}=await import('../luna-finance-v1/ledger-json.mjs');
function parseReceipt(raw){
  // v6's pinned writer emits exactly one compact JSON object plus LF.
  const rows=parseLedgerBytes(raw);need(rows.length===1,'invalid_receipt_json');
  function unbox(v){
    const n=numericLexeme(v);
    if(n!==undefined){need(/^(0|[1-9][0-9]*)$/.test(n)&&Number.isSafeInteger(Number(n)),'invalid_receipt_number');return Number(n);}
    if(Array.isArray(v))return v.map(unbox);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,unbox(x)]));
    return v;
  }
  return snapshot(unbox(rows[0]));
}
function validateExpected(value){
  const e=snapshot(value);need(exact(e,expectedKeys),'invalid_parent_expected');
  for(const key of reconcileKeys)need(key.endsWith('sha256')||key==='financial_policy_id'?hash(e[key]):identity(e[key]),'invalid_parent_expected');
  need(Object.hasOwn(profiles,e.client)&&profiles[e.client]===e.binding_profile_id,'invalid_parent_arm');
  for(const key of ['task_prompt_sha256','parent_source_sha256','finalizer_source_sha256'])need(hash(e[key]),'invalid_parent_pin');
  need(e.observer_source_sha256===PINS.observer&&e.installed_adapter_sha256===PINS.adapter&&e.binding_source_sha256===PINS.binding,'unsupported_current_sources');
  need(Number.isSafeInteger(e.owner_pid)&&e.owner_pid>0,'invalid_owner_pid');
  need(e.client==='pi'?e.task_pid===null&&e.daemon_identity_sha256===null:
    Number.isSafeInteger(e.task_pid)&&e.task_pid>0&&e.task_pid!==e.owner_pid&&hash(e.daemon_identity_sha256),'invalid_owned_task');
  return e;
}
function childShape(c,pid,ipc){
  need(exact(c,childKeys)&&c.pid===pid,'invalid_owned_child');
  for(const key of ['spawned','exit_observed','closed','invalid','error','timed_out','kill_attempted','kill_failed'])need(typeof c[key]==='boolean','invalid_child_boolean');
  need(ipc?typeof c.ipc_disconnected==='boolean':c.ipc_disconnected===null,'invalid_child_ipc');
  for(const key of ['exit_code','close_code'])need(c[key]===null||Number.isInteger(c[key])&&c[key]>=0&&c[key]<=255,'invalid_child_code');
  for(const key of ['exit_signal','close_signal'])need(c[key]===null||typeof c[key]==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(c[key]),'invalid_child_signal');
}
function observe(reader,e){
  try{
    const raw=reader();
    if(types.isPromise(raw)){Reflect.apply(intrinsicThen,raw,[undefined,()=>{}]);fail('async_lifecycle_refused');}
    const c=snapshot(raw);need(exact(c,closureKeys)&&c.schema_version===1&&c.client===e.client,'invalid_closure');
    childShape(c.owner,e.owner_pid,true);
    if(e.client==='light')childShape(c.task,e.task_pid,false);else need(c.task===null,'invalid_task');
    need(c.daemon_identity_sha256===e.daemon_identity_sha256,'daemon_identity_mismatch');
    need(e.client==='light'?typeof c.shutdown_acknowledged==='boolean':c.shutdown_acknowledged===null,'invalid_shutdown');
    for(const key of ['pending_operations','journal_quiescent','sticky_invalid'])need(typeof c[key]==='boolean','invalid_closure_boolean');
    return c;
  }catch{return null;}
}
function childClosed(c){return c.spawned&&c.exit_observed&&c.closed&&
  (c.exit_code===null)!==(c.exit_signal===null)&&c.exit_code===c.close_code&&c.exit_signal===c.close_signal&&!c.invalid;}
function childClean(c){return childClosed(c)&&c.exit_code===0&&c.exit_signal===null&&!c.error&&!c.timed_out&&!c.kill_attempted&&!c.kill_failed;}
function closed(c){return c!==null&&childClosed(c.owner)&&c.owner.ipc_disconnected&&
  (c.task===null||childClosed(c.task))&&!c.pending_operations&&c.journal_quiescent&&!c.sticky_invalid;}
function clean(c){return closed(c)&&childClean(c.owner)&&(c.task===null||childClean(c.task))&&
  (c.client==='pi'||c.shutdown_acknowledged===true);}
function safeAck(a){
  if(!exact(a,ackKeys)||a.kind!=='luna.capture.published.shared.v6'||a.schema_version!==1)return false;
  if(a.admission_id!==a.run_id+':'+a.call_ordinal)return false;
  for(const k of ackKeys){
    if(k.endsWith('sha256')){if(!hash(a[k]))return false;}
    else if(['call_ordinal','publication_ordinal','response_byte_count'].includes(k)){
      if(!Number.isSafeInteger(a[k])||a[k]<(k==='response_byte_count'?0:1)||a[k]>(k==='response_byte_count'?MAX_RESPONSE:10000))return false;
    }else if(!['kind','schema_version','admission_id'].includes(k)&&!identity(a[k]))return false;
  }
  return true;
}
function verifyCapture(io,directory,ack,e){
  const n=ack.call_ordinal,suffix=String(n).padStart(3,'0');
  const receipt=readRegular(io,path.join(directory,`capture-receipt-${suffix}.json`),32768);
  const request=readRegular(io,path.join(directory,`capture-request-${suffix}.json`),1024*1024);
  const response=readRegular(io,path.join(directory,`capture-response-${suffix}.sse`),MAX_RESPONSE);
  need(receipt.sha256===ack.receipt_sha256&&request.sha256===ack.request_body_sha256&&response.sha256===ack.response_bytes_sha256&&response.bytes===ack.response_byte_count,'capture_hash_mismatch');
  const r=parseReceipt(receipt.raw);need(exact(r,receiptKeys)&&r.schema_version===2,'invalid_receipt_schema');
  for(const k of ['client','binding_profile_id','protocol_id','run_id','root_turn_id','admission_id','call_ordinal','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'])need(r[k]===ack[k],'receipt_ack_mismatch');
  for(const k of ['client','binding_profile_id','protocol_id','run_id','root_turn_id','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'])need(r[k]===e[k],'receipt_expected_mismatch');
  need(r.task_prompt_sha256===e.task_prompt_sha256&&r.route==='openai-direct'&&r.source==='provider_response_sse'&&
    r.request_role===(n===1?'root':'continuation')&&r.prior_root_generations===n-1&&r.initial_request===(n===1)&&r.initial_binding_verified===(n===1),'receipt_role_mismatch');
  need(Number.isInteger(r.http_status)&&r.http_status>=100&&r.http_status<=599&&
    (r.response_content_type===null||typeof r.response_content_type==='string')&&typeof r.requested_stream==='boolean'&&
    ['eof','aborted','error'].includes(r.transport_outcome)&&typeof r.downstream_delivery_failed==='boolean'&&typeof r.capture_write_complete==='boolean','invalid_receipt_transport');
  const eof=r.http_status===200&&typeof r.response_content_type==='string'&&/^text\/event-stream(?:[ \t]*;[\x20-\x7e\t]*)?[ \t]*$(?![\s\S])/i.test(r.response_content_type)&&
    r.requested_stream&&r.transport_outcome==='eof'&&!r.downstream_delivery_failed&&r.capture_write_complete;
  return {ordinal:n,verified:true,clean:eof,reason:eof?null:'capture_not_clean',receipt_sha256:receipt.sha256,
    request_body_sha256:request.sha256,response_bytes_sha256:response.sha256,response_byte_count:response.bytes};
}
function syncDirectory(io,directory){const fd=io.openSync(directory,io.constants.O_RDONLY|io.constants.O_DIRECTORY|io.constants.O_NOFOLLOW);try{io.fsyncSync(fd);}finally{io.closeSync(fd);}}

/**
 * Called by a trusted parent, after its registered process/lifecycle accounting.
 * observeLifecycle is a synchronous live snapshot of THAT parent's own facts.
 * This API cannot authenticate a caller who fabricates ownership or facts.
 * io is a trusted test-only fault-injection dependency, never untrusted input.
 */
export function finalizeAttempt({directory,directoryIdentity,ledgerPath,ledgerIdentity,expected,acknowledgments,outcome,observeLifecycle},{io=fs}={}){
  const e=validateExpected(expected),dirId=snapshot(directoryIdentity),ledgerId=snapshot(ledgerIdentity);
  validateFileIdentity(dirId);validateFileIdentity(ledgerId);
  need(typeof directory==='string'&&path.isAbsolute(directory)&&io.realpathSync(directory)===directory,'invalid_attempt_directory');
  need(typeof ledgerPath==='string'&&path.isAbsolute(ledgerPath)&&typeof observeLifecycle==='function','invalid_finalizer_input');
  const checkDirectory=()=>{const st=io.lstatSync(directory,{bigint:true});need(st.isDirectory()&&same(fileIdentity(st),dirId),'attempt_directory_changed');};
  checkDirectory();
  need(readRegular(io,path.join(HERE,'finalize.mjs'),256*1024).sha256===e.finalizer_source_sha256,'finalizer_pin_mismatch');
  const original=snapshot(outcome);need(exact(original,outcomeKeys),'invalid_outcome');
  for(const k of outcomeKeys)need(k==='planning_required'?typeof original[k]==='boolean':original[k]===null||typeof original[k]==='boolean','invalid_outcome');
  let acks=null;
  try{const a=snapshot(acknowledgments);if(Array.isArray(a))acks=a.map(x=>safeAck(x)?x:null);}catch{/* malformed inventory remains unknown, never arbitrary logged content */}
  const first=observe(observeLifecycle,e),reasons=[];
  if(!clean(first))reasons.push('owned_lifecycle_not_clean');
  if(original.normal_exit!==true||original.timed_out!==false||original.budget_stopped!==false)reasons.push('attempt_outcome_not_clean');
  let ledger=null,accounting=null;
  try{
    const found=readRegular(io,ledgerPath,MAX_LEDGER);need(same(found.identity,ledgerId),'ledger_identity_changed');
    ledger={...found.identity,byte_count:found.bytes,sha256:found.sha256};
    accounting=reconcileAttempt({ledgerBytes:found.raw,expected:Object.fromEntries(reconcileKeys.map(k=>[k,e[k]])),acknowledgments:acks});
  }catch{reasons.push('accounting_snapshot_unknown');}
  if(accounting!==null){
    if(!accounting.completeUsage)reasons.push('usage_incomplete');
    if(!accounting.ackInventoryComplete)reasons.push('ack_inventory_incomplete');
  }
  let contractOkay=false;
  try{contractOkay=readRegular(io,path.join(directory,'contract.json'),2*1024*1024).sha256===e.binding_contract_sha256;}catch{/* no artifact authority */}
  if(!contractOkay)reasons.push('contract_unverified');
  const artifacts=[];
  if(accounting!==null){
    for(const call of accounting.calls){
      const ack=acks?.[call.ordinal-1];
      try{
        need(ack!==null&&ack!==undefined&&ack.call_ordinal===call.ordinal&&ack.admission_id===call.admissionId&&ack.request_body_sha256===call.requestSha256,'missing_capture_ack');
        artifacts.push(verifyCapture(io,directory,ack,e));
      }catch{artifacts.push({ordinal:call.ordinal,verified:false,clean:false,reason:'capture_unverified'});}
    }
  }
  if(artifacts.some(a=>!a.clean))reasons.push('capture_inventory_not_clean');
  // Recheck the same named journal snapshot; no lock theft/cleanup or financial writes.
  if(ledger!==null){
    try{const again=readRegular(io,ledgerPath,MAX_LEDGER);need(same(again.identity,ledgerId)&&again.sha256===ledger.sha256,'ledger_changed');}
    catch{reasons.push('ledger_snapshot_changed');}
  }
  const second=observe(observeLifecycle,e);
  if(!same(first,second))reasons.push('lifecycle_changed');
  checkDirectory();
  const inventory={schema_version:1,kind:'shared-parent-attempt-v1',expected:e,
    source_pins:{finalizer:e.finalizer_source_sha256,parent:e.parent_source_sha256,reconcile:PINS.reconcile,scorer:PINS.scorer},
    artifact_directory_identity:dirId,outcome:original,lifecycle:second,ledger,accounting,acknowledgments:acks,artifacts,
    terminal_accounting_complete:closed(second)&&same(first,second)&&accounting?.completeUsage===true&&!reasons.includes('ledger_snapshot_changed'),
    clean_publication_candidate:reasons.length===0,reasons};
  const raw=Buffer.from(JSON.stringify(inventory)+'\n');need(raw.length<=MAX_INVENTORY,'attempt_inventory_oversized');
  const pending=path.join(directory,'parent-attempt-v1.json.pending'),final=path.join(directory,'parent-attempt-v1.json');
  const fd=io.openSync(pending,io.constants.O_WRONLY|io.constants.O_CREAT|io.constants.O_EXCL|io.constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<raw.length){const count=io.writeSync(fd,raw,offset,raw.length-offset);need(count>0,'inventory_write_failed');offset+=count;}io.fsyncSync(fd);}finally{io.closeSync(fd);}
  syncDirectory(io,directory);checkDirectory();io.linkSync(pending,final);syncDirectory(io,directory);checkDirectory();
  need(same(second,observe(observeLifecycle,e)),'postcommit_lifecycle_changed');
  // A failed write/link/sync/check never returns either digest, even if files survive.
  return Object.freeze({inventoryBytes:raw,attemptCommitSha256:sha(raw),cleanCommitSha256:inventory.clean_publication_candidate?sha(raw):null});
}
