import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CORE,NODE,sha} from './selection.mjs';
import {PYTHON,FAIR,pins,OBSERVER_PIN,verifyObserverSelection} from './observer-selection.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const selection={node:NODE,python:PYTHON,dependencies:{...pins,'luna-observer-v6/direct.mjs':OBSERVER_PIN}};
const verifySelection=verifyObserverSelection;
const need=(ok,reason)=>{if(!ok)throw new Error(reason);};
const TASK='Before using tools, write a 2–5-line checklist. Read owned.txt once with FileRead, then report its exact value without more tools.';
let active=false,sequenceBlocked=false;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
function bytes(filename,max=2*1024*1024){
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const st=fs.fstatSync(fd);need(st.isFile()&&st.size<=max,'artifact_type_or_size');
    const raw=fs.readFileSync(fd);need(raw.length===st.size&&raw.length<=max,'artifact_size_changed');return raw;
  }finally{fs.closeSync(fd);}
}
function validateReceipt(root,ack){
  for(const key of ['receipt_sha256','request_body_sha256','response_bytes_sha256','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'])need(digest(ack[key]),'invalid_ack_digest');
  const ordinal=ack.call_ordinal,suffix=String(ordinal).padStart(3,'0');need(ordinal===1||ordinal===2,'unsupported_call');
  need(ack.root_turn_id==='root-turn-1'&&Number.isSafeInteger(ack.response_byte_count)&&ack.response_byte_count>0&&ack.response_byte_count<=1024*1024,'invalid_ack_scalar');
  const raw=bytes(path.join(root,`capture-receipt-${suffix}.json`),32768),receipt=JSON.parse(raw);
  need(sha(raw)===ack.receipt_sha256,'receipt_hash_mismatch');
  need(receipt&&typeof receipt==='object'&&!Array.isArray(receipt)&&Object.keys(receipt).sort().join()===
    ['schema_version','protocol_id','run_id','root_turn_id','request_role','admission_id','call_ordinal','prior_root_generations','initial_request','route','source','request_body_sha256','task_prompt_sha256','response_bytes_sha256','response_byte_count','http_status','response_content_type','requested_stream','transport_outcome','downstream_delivery_failed','capture_write_complete','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id','initial_binding_verified'].sort().join(),'receipt_fields');
  for(const key of ['protocol_id','run_id','root_turn_id','admission_id','call_ordinal','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id'])need(receipt[key]===ack[key],'receipt_ack_mismatch');
  need(receipt.schema_version===2&&receipt.request_role===(ordinal===1?'root':'continuation')&&receipt.prior_root_generations===ordinal-1&&receipt.initial_request===(ordinal===1)&&
    receipt.route==='openai-direct'&&receipt.source==='provider_response_sse'&&receipt.task_prompt_sha256===sha(TASK)&&
    receipt.http_status===200&&receipt.response_content_type==='text/event-stream'&&receipt.requested_stream===true&&
    receipt.initial_binding_verified===(ordinal===1)&&receipt.capture_write_complete===true&&
    receipt.transport_outcome==='eof'&&receipt.downstream_delivery_failed===false,'receipt_semantics');
  const request=bytes(path.join(root,`capture-request-${suffix}.json`),1024*1024),response=bytes(path.join(root,`capture-response-${suffix}.sse`),1024*1024);
  need(sha(request)===ack.request_body_sha256&&sha(response)===ack.response_bytes_sha256&&response.length===ack.response_byte_count,'capture_bytes_mismatch');
  need(sha(bytes(path.join(root,'contract.json'),256*1024))===ack.binding_contract_sha256,'contract_hash_mismatch');
  return receipt;
}
export async function runCase(caseName='read',mode='credit_exhaustion'){
  need(!active&&!sequenceBlocked,'sequence_blocked');
  need(caseName==='read'&&mode==='credit_exhaustion','unsupported_case');
  verifySelection();
  const {parseLedgerBytes,numericLexeme}=await import('../luna-finance-v1/ledger-json.mjs');
  need(!active&&!sequenceBlocked,'sequence_blocked');active=true;
  const root=fs.mkdtempSync('/private/tmp/light-tool-continuation-v1-');fs.chmodSync(root,0o700);
  fs.mkdirSync(path.join(root,'network-attempts'));fs.mkdirSync(path.join(root,'launch-home'));
  const channel=crypto.randomUUID();
  fs.writeFileSync(path.join(root,'case.json'),JSON.stringify({case:caseName,mode,channel}),{flag:'wx',mode:0o600});
  const state={spawned:false,exited:false,closed:false,disconnected:false,invalid:false,code:null,signal:null,acks:[],final:null};
  const stdout=fs.openSync(path.join(root,'stdout.private.log'),'wx',0o600),stderr=fs.openSync(path.join(root,'stderr.private.log'),'wx',0o600);
  let child,timer,closeTimer;
  try{
    await new Promise((resolve,reject)=>{
      let ended=false,stopping=false;
      const finish=ok=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(closeTimer);ok?resolve():reject(new Error('owned_child_failed'));};
      const stop=()=>{
        state.invalid=true;if(state.closed){sequenceBlocked=true;return;}if(stopping)return;stopping=true;
        closeTimer=setTimeout(()=>{sequenceBlocked=true;finish(false);},2000);
        if(!state.exited){try{child.kill('SIGKILL');}catch{sequenceBlocked=true;}}
      };
      try{child=fork(path.join(HERE,'child.mjs'),['read',channel],{execPath:selection.node,execArgv:['--require',CORE+'/tests/helpers/network-tripwire.cjs'],cwd:root,
        env:{HOME:path.join(root,'launch-home'),PATH:'/usr/bin:/bin',TZ:'UTC',SOURCE_CHILD_ROOT:root,AGENC_TEST_HERMETIC_RUN_ROOT:root,AGENC_TEST_NETWORK_ATTEMPT_LEDGER:path.join(root,'network-attempts')},stdio:['ignore','pipe','pipe','ipc']});}
      catch{sequenceBlocked=true;finish(false);return;}
      timer=setTimeout(stop,45000);
      for(const [stream,fd]of [[child.stdout,stdout],[child.stderr,stderr]]){
        let count=0;stream.on('data',data=>{count+=data.length;if(count>65536){stop();return;}try{fs.writeSync(fd,data);}catch{stop();}});
        stream.on('error',stop);
      }
      child.on('spawn',()=>{if(state.spawned||state.exited||state.closed||state.disconnected)stop();else state.spawned=true;});
      child.on('error',()=>{if(state.closed||state.exited){state.invalid=true;sequenceBlocked=true;}else stop();});
      child.on('message',message=>{
        try{
          need(state.spawned&&!state.exited&&!state.closed&&!state.disconnected&&!state.final,'late_message');
          need(message&&typeof message==='object'&&!Array.isArray(message),'bad_message');
          if(message.kind==='luna.capture.published.shared.v6'){
            const ordinal=state.acks.length+1;
            need(Object.keys(message).sort().join()===['kind','schema_version','channel_id','protocol_id','run_id','root_turn_id','admission_id','call_ordinal','publication_ordinal','receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id'].sort().join(),'publication_fields');
            need(message.channel_id===channel&&message.client==='light'&&message.binding_profile_id==='light-luna-44aed-source-base-v2'&&
              message.schema_version===1&&message.protocol_id==='light-tool-continuation-v1'&&message.run_id==='preflight-root'&&message.admission_id===`preflight-root:${ordinal}`&&message.call_ordinal===ordinal&&message.publication_ordinal===ordinal&&
              message.observer_source_sha256===selection.dependencies['luna-observer-v6/direct.mjs']&&ordinal<=2,'bad_publication');
            need(message.binding_source_sha256===selection.dependencies['shared-luna-binding-v1/binding.py']&&
              message.installed_adapter_sha256===selection.dependencies['stream_adapters.py'],'publication_source_mismatch');
            validateReceipt(root,message);state.acks.push(message);
          }else{
            need(message.kind==='light-tool-continuation-v1.complete'&&message.pid===child.pid&&message.ok===true,'bad_final');
            need(Object.keys(message).sort().join()===['kind','pid','ok','result','loader','hooks'].sort().join(),'final_fields');
            const out=message.result;
            need(out&&typeof out==='object'&&out.nativeReadVerified===true&&out.secondHistoryVerified===true&&out.finalTextMatched===true,'native_result_missing');
            for(const key of ['calls','validations','toolStarts','toolEnds','dispatched','reconciled','toolDispatched','toolReconciled','producers'])need(Number.isSafeInteger(out[key])&&out[key]>=0&&out[key]<=100,'final_count');
            state.final=message;
          }
        }catch{stop();}
      });
      child.on('disconnect',()=>{if(!state.spawned||state.disconnected||state.closed)stop();state.disconnected=true;});
      child.on('exit',(code,signal)=>{if(!state.spawned||state.exited||state.closed){state.invalid=true;sequenceBlocked=true;return;}state.exited=true;state.code=code;state.signal=signal;});
      child.on('close',(code,signal)=>{
        if(state.closed){state.invalid=true;sequenceBlocked=true;return;}
        state.closed=true;
        if(!state.exited||code!==state.code||signal!==state.signal)state.invalid=true;
        finish(!state.invalid&&state.disconnected&&state.final!==null&&code===0&&signal===null);
      });
    });
    need(!state.invalid&&state.closed&&fs.readdirSync(path.join(root,'network-attempts')).length===0,'invalid_final');
    fs.writeFileSync(path.join(root,'all-acks.json'),JSON.stringify(state.acks),{flag:'wx',mode:0o600});
    const rows=parseLedgerBytes(bytes(path.join(root,'financial/luna-api-ledger.jsonl')));
    need(state.acks.length===2&&rows.length===4,'capture_inventory_mismatch');
    const receipts=state.acks.map(ack=>validateReceipt(root,ack));
    for(let i=0;i<2;i++){
      const ack=state.acks[i],receipt=receipts[i],callRows=rows.slice(i*2,i*2+2);
      need(ack.request_body_sha256===receipt.request_body_sha256&&receipt.request_body_sha256===callRows[0].request_sha256&&
        ack.root_turn_id==='root-turn-1'&&ack.response_bytes_sha256===receipt.response_bytes_sha256&&
        ack.binding_source_sha256===selection.dependencies['shared-luna-binding-v1/binding.py']&&
        ack.installed_adapter_sha256===selection.dependencies['stream_adapters.py']&&
        ack.binding_contract_sha256===sha(bytes(path.join(root,'contract.json'),256*1024)),'capture_join_mismatch');
      need(callRows.every(row=>row.request_sha256===ack.request_body_sha256&&row.run==='preflight-root'&&numericLexeme(row.call)===String(i+1)),'ledger_capture_join');
    }
    const stopped=fs.existsSync(path.join(root,'financial/luna-api-stop.json'))&&bytes(path.join(root,'financial/luna-api-stop.json'),32768).length>0;
    fs.writeFileSync(path.join(root,'score-input.json'),JSON.stringify({normal_exit:true,first_ack:state.acks[0]}),{flag:'wx',mode:0o600});
    const scored=spawnSync(selection.python,['-I','-S','-B',path.join(HERE,'score.py'),root],{env:{LANG:'C.UTF-8'},timeout:5000,maxBuffer:8192,encoding:'utf8'});
    need(scored.status===0&&scored.signal===null&&!scored.error&&scored.stderr.length===0,'offline_score_failed');
    const score=JSON.parse(scored.stdout);
    fs.writeFileSync(path.join(root,'score.json'),JSON.stringify(score),{flag:'wx',mode:0o600});
    return {root,closed:true,code:state.code,signal:state.signal,final:state.final,acks:state.acks,rows,receipts,stopped,score};
  }catch(error){
    // Export only bounded state; private child logs are retained, never rendered.
    const safe=new Error('light_fixture_failed');safe.root=root;safe.cleanupConfirmed=state.closed;throw safe;
  }finally{fs.closeSync(stdout);fs.closeSync(stderr);active=false;}
}
