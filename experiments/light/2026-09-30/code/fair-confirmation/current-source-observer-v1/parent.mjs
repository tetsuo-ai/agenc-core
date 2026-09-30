import {fork} from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {CORE,sha} from './selection.mjs';
import {pins,OBSERVER_PIN,verifyObserverSelection} from './observer-selection.mjs';
let blocked=false,active=false;
const need=ok=>{if(!ok)throw new Error('Owned observer evidence refused');};
const keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.sort().join();
function bytes(path,max=2*1024*1024){
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);need(st.isFile()&&st.size<=max);const raw=fs.readFileSync(fd);need(raw.length<=max);return raw;}finally{fs.closeSync(fd);}
}
function publication(root,channel,msg){
 const names=['kind','schema_version','channel_id','protocol_id','run_id','root_turn_id','admission_id','call_ordinal','publication_ordinal','receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'];
 need(keys(msg,names));
 need(msg.kind==='luna.capture.published.current.v4'&&msg.schema_version===1&&msg.channel_id===channel&&msg.protocol_id==='current-source-observer-v1'&&msg.run_id==='preflight-root'&&msg.root_turn_id==='root-turn-1'&&msg.admission_id==='preflight-root:1'&&msg.call_ordinal===1&&msg.publication_ordinal===1);
 need(msg.observer_source_sha256===OBSERVER_PIN&&msg.installed_adapter_sha256===pins['stream_adapters.py']&&msg.binding_source_sha256===pins['current-base-binding-v1/binding.py']);
 for(const k of ['receipt_sha256','request_body_sha256','response_bytes_sha256','binding_contract_sha256'])need(typeof msg[k]==='string'&&/^[a-f0-9]{64}$/.test(msg[k]));
 need(Number.isSafeInteger(msg.response_byte_count)&&msg.response_byte_count>0&&msg.response_byte_count<=1024*1024);
 const raw=bytes(root+'/capture-receipt-001.json',32768),receipt=JSON.parse(raw);
 need(sha(raw)===msg.receipt_sha256&&sha(bytes(root+'/contract.json'))===msg.binding_contract_sha256);
 for(const k of ['protocol_id','run_id','root_turn_id','admission_id','call_ordinal','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'])need(receipt[k]===msg[k]);
 need(receipt.http_status===200&&receipt.response_content_type==='text/event-stream'&&receipt.transport_outcome==='eof'&&receipt.capture_write_complete===true&&receipt.downstream_delivery_failed===false&&receipt.initial_binding_verified===true);
 const response=bytes(root+'/capture-response-001.sse');need(response.length===msg.response_byte_count&&sha(response)===msg.response_bytes_sha256);
 need(sha(bytes(root+'/capture-request-001.json'))===msg.request_body_sha256);
 return Object.freeze({receiptSha256:msg.receipt_sha256,requestSha256:msg.request_body_sha256,responseSha256:msg.response_bytes_sha256,contractSha256:msg.binding_contract_sha256});
}
export async function runChild(mode='normal'){
 need(!active&&!blocked&&['normal','positive_cap','task','summary','contract_mismatch'].includes(mode));verifyObserverSelection();active=true;
 const root=fs.realpathSync(fs.mkdtempSync('/private/tmp/current-source-observer-v1-')),channel=crypto.randomUUID();
 fs.mkdirSync(root+'/network-attempts');fs.mkdirSync(root+'/launch-home');
 let child;try{child=fork(new URL('./child.mjs',import.meta.url),[mode,channel],{
  execPath:'/opt/homebrew/bin/node',execArgv:['--require',CORE+'/tests/helpers/network-tripwire.cjs'],cwd:root,
  env:{HOME:root+'/launch-home',PATH:'/usr/bin:/bin',SOURCE_CHILD_ROOT:root,AGENC_TEST_HERMETIC_RUN_ROOT:root,AGENC_TEST_NETWORK_ATTEMPT_LEDGER:root+'/network-attempts'},
  stdio:['ignore','pipe','pipe','ipc'],serialization:'json'});
 }catch{blocked=true;active=false;throw new Error('Owned observer spawn refused');}
 return await new Promise(resolve=>{
  let spawned=false,disconnected=false,exit=null,closed=false,invalid=false,killed=false,pid,settled=false,message=null,ack=null,outputBytes=0,killTimer;
  const finish=result=>{if(settled)return;settled=true;active=false;resolve(Object.freeze(result));};
  const kill=()=>{if(closed||exit||killed)return;killed=true;if(!spawned||child.pid!==pid){blocked=true;return;}try{if(!child.kill('SIGKILL'))blocked=true;}catch{blocked=true;}};
  const bad=()=>{invalid=true;if(closed)blocked=true;else kill();};
  const deadline=setTimeout(()=>{bad();killTimer=setTimeout(()=>{if(!closed){blocked=true;finish({root,confirmed:false,invalid:true});}},2000);},60000);
  child.on('spawn',()=>{if(spawned||disconnected||exit||closed||!Number.isSafeInteger(child.pid))return bad();spawned=true;pid=child.pid;if(invalid)kill();});
  child.on('error',bad);child.stdout.on('error',bad);child.stderr.on('error',bad);
  const count=b=>{outputBytes+=b.length;if(closed||outputBytes>16384)bad();};child.stdout.on('data',count);child.stderr.on('data',count);
  child.on('message',value=>{
   if(!spawned||disconnected||exit||closed||message||JSON.stringify(value).length>8192)return bad();
   try{
    if(value?.kind==='luna.capture.published.current.v4'){need(ack===null);ack=publication(root,channel,value);return;}
    need(value?.kind==='current-source-observer-v1.complete'&&value.pid===pid&&typeof value.ok==='boolean');
    need(keys(value,value.ok?['kind','pid','ok','result','loader','hooks']:['kind','pid','ok','reason','stage']));
    message=Object.freeze(value);
   }catch{bad();}
  });
  child.on('disconnect',()=>{if(!spawned||disconnected||closed)bad();disconnected=true;});
  child.on('exit',(code,signal)=>{if(!spawned||exit||closed)return bad();exit=Object.freeze({code,signal});});
  child.on('close',(code,signal)=>{
   if(closed)return bad();closed=true;clearTimeout(deadline);clearTimeout(killTimer);
   const confirmed=spawned&&disconnected&&exit!==null&&exit.code===code&&exit.signal===signal;if(!confirmed)blocked=true;
   if(!message||code!==0||signal!==null)invalid=true;
   let rows=[],networkAttempts=null;
   try{networkAttempts=fs.readdirSync(root+'/network-attempts').length;need(networkAttempts===0);
    const raw=bytes(root+'/financial/luna-api-ledger.jsonl');rows=raw.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    // Only scalar row identity summaries leave parent; no monetary arithmetic
    // or adjudication is delegated to JSON.parse here.
    if(ack){need(rows.length===2&&rows[0].event==='admit'&&rows[1].event==='settle');need(rows.every(r=>r.request_sha256===ack.requestSha256&&r.run==='preflight-root'&&r.call===1));}
   }catch{invalid=true;}
   finish({root,confirmed,invalid,pid,code,signal,outputBytes,networkAttempts,message,ack,
    finance:rows.map(r=>({event:r.event,usageMissing:r.usage_missing??null,requestSha256:r.request_sha256,proof:r.settlement_proof??null}))});
  });
 });
}
