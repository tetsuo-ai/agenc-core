import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {HERE,selection,need,sha,verifySelection,TASK} from './fixture.mjs';
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
function validateReceipt(root,ack,caseName){
  for(const key of ['receipt_sha256','request_body_sha256','response_bytes_sha256','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'])need(digest(ack[key]),'invalid_ack_digest');
  need(uuid(ack.root_turn_id)&&Number.isSafeInteger(ack.response_byte_count)&&(caseName==='abort'?ack.response_byte_count>=0:ack.response_byte_count>0)&&ack.response_byte_count<=1024*1024,'invalid_ack_scalar');
  const raw=bytes(path.join(root,'capture-receipt-001.json'),32768),receipt=JSON.parse(raw);
  need(sha(raw)===ack.receipt_sha256,'receipt_hash_mismatch');
  need(receipt&&typeof receipt==='object'&&!Array.isArray(receipt)&&Object.keys(receipt).sort().join()===
    ['schema_version','protocol_id','run_id','root_turn_id','request_role','admission_id','call_ordinal','prior_root_generations','initial_request','route','source','request_body_sha256','task_prompt_sha256','response_bytes_sha256','response_byte_count','http_status','response_content_type','requested_stream','transport_outcome','downstream_delivery_failed','capture_write_complete','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id','initial_binding_verified'].sort().join(),'receipt_fields');
  for(const key of ['protocol_id','run_id','root_turn_id','admission_id','call_ordinal','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id'])need(receipt[key]===ack[key],'receipt_ack_mismatch');
  need(receipt.schema_version===2&&receipt.request_role==='root'&&receipt.prior_root_generations===0&&receipt.initial_request===true&&
    receipt.route==='openai-direct'&&receipt.source==='provider_response_sse'&&receipt.task_prompt_sha256===sha(TASK)&&
    receipt.http_status===200&&receipt.response_content_type==='text/event-stream'&&receipt.requested_stream===true&&
    receipt.initial_binding_verified===true&&receipt.capture_write_complete===true&&
    receipt.transport_outcome===(caseName==='abort'?'aborted':'eof')&&receipt.downstream_delivery_failed===(caseName==='abort'),'receipt_semantics');
  const request=bytes(path.join(root,'capture-request-001.json'),1024*1024),response=bytes(path.join(root,'capture-response-001.sse'),1024*1024);
  need(sha(request)===ack.request_body_sha256&&sha(response)===ack.response_bytes_sha256&&response.length===ack.response_byte_count,'capture_bytes_mismatch');
  need(sha(bytes(path.join(root,'contract.json'),256*1024))===ack.binding_contract_sha256,'contract_hash_mismatch');
  return receipt;
}
export async function runCase(caseName,mode='credit_exhaustion'){
  need(!active&&!sequenceBlocked,'sequence_blocked');
  need(['normal','abort','task','policy'].includes(caseName)&&['credit_exhaustion','positive_cap'].includes(mode),'unsupported_case');
  verifySelection();
  const {parseLedgerBytes,numericLexeme}=await import('../luna-finance-v1/ledger-json.mjs');
  need(!active&&!sequenceBlocked,'sequence_blocked');active=true;
  const root=fs.mkdtempSync('/private/tmp/pi-source-observer-v3-');fs.chmodSync(root,0o700);
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
      try{child=fork(path.join(HERE,'child.mjs'),[],{execPath:selection.node,execArgv:[],cwd:root,
        env:{HOME:root,PATH:'/usr/bin:/bin',TZ:'UTC',PI_SKIP_VERSION_CHECK:'1'},stdio:['ignore','pipe','pipe','ipc']});}
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
            need(Object.keys(message).sort().join()===['kind','schema_version','channel_id','protocol_id','run_id','root_turn_id','admission_id','call_ordinal','publication_ordinal','receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id'].sort().join(),'publication_fields');
            need(message.channel_id===channel&&message.client==='pi'&&message.binding_profile_id==='pi-luna-v0731-shared-v1'&&
              message.schema_version===1&&message.protocol_id==='pi-source-observer-v3'&&message.run_id==='synthetic'&&message.admission_id==='synthetic:1'&&message.call_ordinal===1&&message.publication_ordinal===1&&
              message.observer_source_sha256===selection.dependencies['luna-observer-v6/direct.mjs']&&state.acks.length===0,'bad_publication');
            need(message.binding_source_sha256===selection.dependencies['shared-luna-binding-v1/binding.py']&&
              message.installed_adapter_sha256===selection.dependencies['stream_adapters.py'],'publication_source_mismatch');
            validateReceipt(root,message,caseName);state.acks.push(message);
          }else{
            need(Object.keys(message).sort().join()===['kind','channel','case','calls','cancels','eof','terminalEvents','stopReason','contentMatched','bridgeCalls','externalAttempts','rootTurnId','disposed'].sort().join(),'final_fields');
            need(message.kind==='pi.source.observer.final.v3'&&message.channel===channel&&message.case===caseName&&message.disposed===true,'bad_final');
            for(const key of ['calls','cancels','terminalEvents','bridgeCalls','externalAttempts'])need(Number.isSafeInteger(message[key])&&message[key]>=0&&message[key]<=10,'final_count');
            need(typeof message.eof==='boolean'&&typeof message.contentMatched==='boolean'&&uuid(message.rootTurnId)&&
              ['stop','aborted','error'].includes(message.stopReason),'final_type');
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
    need(!state.invalid&&state.closed&&state.final.externalAttempts===0,'invalid_final');
    const rows=parseLedgerBytes(bytes(path.join(root,'luna-api-ledger.jsonl')));
    const receipt=state.acks.length?validateReceipt(root,state.acks[0],caseName):null;
    if(receipt){
      need(state.acks.length===1&&rows.length===2,'capture_inventory_mismatch');
      const ack=state.acks[0];
      need(ack.request_body_sha256===receipt.request_body_sha256&&receipt.request_body_sha256===rows[0].request_sha256&&
        ack.root_turn_id===state.final.rootTurnId&&ack.response_bytes_sha256===receipt.response_bytes_sha256&&
        ack.binding_source_sha256===selection.dependencies['shared-luna-binding-v1/binding.py']&&
        ack.installed_adapter_sha256===selection.dependencies['stream_adapters.py']&&
        ack.binding_contract_sha256===sha(bytes(path.join(root,'contract.json'),256*1024)),'capture_join_mismatch');
      need(rows.every(row=>row.request_sha256===ack.request_body_sha256&&row.run==='synthetic'&&numericLexeme(row.call)==='1'),'ledger_capture_join');
    }
    const stopped=fs.existsSync(path.join(root,'luna-api-stop.json'))&&bytes(path.join(root,'luna-api-stop.json'),32768).length>0;
    const fullHold=rows.length===2&&rows[0].event==='admit'&&rows[1].event==='settle'&&rows[1].usage_missing===true&&
      typeof rows[0].reserve_nanos==='string'&&/^[1-9][0-9]*$/.test(rows[0].reserve_nanos)&&rows[1].charge_nanos===rows[0].reserve_nanos&&
      typeof numericLexeme(rows[0].reserve)==='string'&&numericLexeme(rows[1].budget_charge_usd)===numericLexeme(rows[0].reserve);
    if(caseName==='abort')need(fullHold&&stopped,'unknown_full_hold_missing');
    return {root,closed:true,code:state.code,signal:state.signal,final:state.final,acks:state.acks,rows,receipt,
      stopped,fullHold};
  }catch(error){
    // Export only bounded state; private child logs are retained, never rendered.
    const safe=new Error('pi_fixture_failed');safe.root=root;safe.cleanupConfirmed=state.closed;throw safe;
  }finally{fs.closeSync(stdout);fs.closeSync(stderr);active=false;}
}
