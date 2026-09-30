// Terminal read-only accounting inventory, not a writer, finalizer or spend gate.
import fs from 'node:fs';
import crypto from 'node:crypto';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw new Error('terminal_attempt_evidence_refused');};
const need=x=>{if(!x)fail();};
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const identity=x=>typeof x==='string'&&/^[A-Za-z0-9_.-]{1,240}$/.test(x);
const profiles={light:'light-luna-44aed-source-base-v2',pi:'pi-luna-v0731-shared-v1'};
// Trusted fixed sources. Hash verification does not make mutable import paths
// race-free; the future parent must select an immutable dependency closure.
for(const [name,pin] of [
  ['ledger-json.mjs','f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750'],
  ['accounting.mjs','b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e'],
]){
  const fd=fs.openSync(new URL('../luna-finance-v1/'+name,import.meta.url),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);need(st.isFile()&&st.size<=256*1024);const raw=fs.readFileSync(fd);need(raw.length===st.size&&sha(raw)===pin);}
  finally{fs.closeSync(fd);}
}
const {parseLedgerBytes,numericLexeme}=await import('../luna-finance-v1/ledger-json.mjs');
const {ledgerExposure,usageCharge,legacyUsdNanodollars,TERMINAL_PROOF}=await import('../luna-finance-v1/accounting.mjs');
const expectedKeys=['run_id','root_turn_id','client','binding_profile_id','protocol_id','channel_id',
  'financial_policy_id','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'];
const ackKeys=['kind','schema_version','channel_id','protocol_id','run_id','root_turn_id','admission_id',
  'call_ordinal','publication_ordinal','receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count',
  'observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256','client','binding_profile_id'];
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.toSorted().join();

export function reconcileAttempt({ledgerBytes,expected,acknowledgments}){
  need(exact(expected,expectedKeys));
  for(const key of expectedKeys){
    if(key.endsWith('sha256')||key==='financial_policy_id')need(digest(expected[key]));
    else need(identity(expected[key]));
  }
  need(Object.hasOwn(profiles,expected.client)&&profiles[expected.client]===expected.binding_profile_id);
  const rows=parseLedgerBytes(ledgerBytes);
  const journal=ledgerExposure(rows,{policyId:expected.financial_policy_id});
  const selected=rows.filter(r=>r.run===expected.run_id);
  const admissions=selected.filter(r=>r.event==='admit');
  const settlements=new Map(selected.filter(r=>r.event==='settle').map(r=>[r.id,r]));
  let knownCharge=0n,unknownHold=0n,unsettledReserve=0n,input=0n,output=0n,cached=0n;
  const calls=admissions.map((admit,index)=>{
    const ordinal=index+1;
    need(numericLexeme(admit.financial_schema)==='1'&&numericLexeme(admit.call)===String(ordinal)&&digest(admit.request_sha256));
    const settle=settlements.get(admit.id);
    if(settle)need(settle.request_sha256===admit.request_sha256);
    const reserve=legacyUsdNanodollars(admit.reserve);
    let state,charge=null;
    if(!settle){state='unsettled';unsettledReserve+=reserve;}
    else if(settle.usage_missing){
      state='unknown_hold';charge=String(legacyUsdNanodollars(settle.budget_charge_usd));unknownHold+=BigInt(charge);
    }else if(settle.settlement_proof===TERMINAL_PROOF){
      state='known';charge=String(legacyUsdNanodollars(settle.budget_charge_usd));knownCharge+=BigInt(charge);
      const usage=usageCharge(settle.usage);input+=BigInt(usage.input);output+=BigInt(usage.output);cached+=BigInt(usage.cached);
    }else fail(); // No selected legacy/unproven row silently becomes current proof.
    return {ordinal,admissionId:admit.id,requestSha256:admit.request_sha256,state,
      reserveNanodollars:String(reserve),chargeNanodollars:charge,
      nominalReserveNanodollars:admit.reserve_nanos,nominalChargeNanodollars:settle?.charge_nanos??null};
  });
  const ackErrors=[];
  const complain=reason=>{if(!ackErrors.includes(reason))ackErrors.push(reason);};
  if(!Array.isArray(acknowledgments)||acknowledgments.length>10000)complain('invalid_ack_inventory');
  else{
    if(acknowledgments.length!==calls.length)complain('ack_admission_count_mismatch');
    for(let i=0;i<acknowledgments.length;i++){
      const ack=acknowledgments[i],call=calls[i];
      if(!exact(ack,ackKeys)){complain('invalid_ack_fields');continue;}
      if(!call){complain('extra_ack');continue;}
      if(ack.kind!=='luna.capture.published.shared.v6'||ack.schema_version!==1)complain('invalid_ack_version');
      for(const key of expectedKeys.filter(k=>k!=='financial_policy_id'))if(ack[key]!==expected[key])complain('ack_identity_mismatch');
      if(ack.call_ordinal!==call.ordinal||ack.publication_ordinal!==call.ordinal||ack.admission_id!==call.admissionId)complain('ack_order_mismatch');
      if(ack.request_body_sha256!==call.requestSha256)complain('ack_request_mismatch');
      if(!['receipt_sha256','request_body_sha256','response_bytes_sha256'].every(k=>digest(ack[k]))||
        !Number.isSafeInteger(ack.response_byte_count)||ack.response_byte_count<0)complain('invalid_ack_artifact_fields');
    }
  }
  const complete=calls.length>0&&calls.every(c=>c.state==='known');
  // Monetary units remain exact decimal strings. Partial counters are explicit;
  // missing/unknown usage never contributes zero to a claimed complete total.
  return Object.freeze({schemaVersion:1,runId:expected.run_id,ledgerSha256:sha(ledgerBytes),
    calls,admittedCalls:calls.length,settledCalls:settlements.size,
    knownCalls:calls.filter(c=>c.state==='known').length,
    unknownHoldCalls:calls.filter(c=>c.state==='unknown_hold').length,
    unsettledCalls:calls.filter(c=>c.state==='unsettled').length,
    knownChargeSubtotalNanodollars:String(knownCharge),unknownHoldNanodollars:String(unknownHold),
    unsettledReserveNanodollars:String(unsettledReserve),journalExposureNanodollars:String(journal.exposure),
    completeUsage:complete,chargeTotalNanodollars:complete?String(knownCharge):null,
    knownTokenSubtotals:{input:String(input),output:String(output),cached:String(cached),uncached:String(input-cached)},
    tokenTotals:complete?{input:String(input),output:String(output),cached:String(cached),uncached:String(input-cached)}:null,
    ackInventoryComplete:ackErrors.length===0&&calls.length>0,ackErrors,
    finalizationAuthorized:false});
}
