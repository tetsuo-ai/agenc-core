import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcileAttempt} from './reconcile.mjs';
const policy='a'.repeat(64),request='b'.repeat(64);
const expected={run_id:'test',root_turn_id:'root',client:'pi',binding_profile_id:'pi-luna-v0731-shared-v1',
  protocol_id:'synthetic',channel_id:'channel',financial_policy_id:policy,
  observer_source_sha256:'c'.repeat(64),installed_adapter_sha256:'d'.repeat(64),
  binding_source_sha256:'e'.repeat(64),binding_contract_sha256:'f'.repeat(64)};
const common=n=>({id:`test:${n}`,run:'test',call:n,financial_schema:1,financial_policy_id:policy,
  price_id:'historical-luna-fixture-nanodollars-v1',request_sha256:request});
const admit=n=>({event:'admit',...common(n),reserve:0.01,reserve_nanos:'10000000'});
const known=n=>({event:'settle',...common(n),usage_missing:false,
  usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}},
  cost_usd:0.00002,budget_charge_usd:0.00002,charge_nanos:'20000',settlement_proof:'completed-full-usage-v1',
  error:null,input_tokens:100,output_tokens:20,cached_tokens:0,uncached_tokens:100});
const unknown=n=>({event:'settle',...common(n),usage_missing:true,usage:{},cost_usd:null,
  budget_charge_usd:0.01,charge_nanos:'10000000',error:{type:'unknown_terminal'}});
function ack(n){
  const {financial_policy_id,...fields}=expected;
  return {kind:'luna.capture.published.shared.v6',schema_version:1,...fields,
    admission_id:`test:${n}`,call_ordinal:n,publication_ordinal:n,receipt_sha256:'1'.repeat(64),
    request_body_sha256:request,response_bytes_sha256:'2'.repeat(64),response_byte_count:50};
}
const raw=rows=>Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join(''));
const run=(rows,acks,exp=expected)=>reconcileAttempt({ledgerBytes:raw(rows),expected:exp,acknowledgments:acks});

test('two calls derive complete inventory from admissions, not acknowledgments',()=>{
  const out=run([admit(1),known(1),admit(2),known(2)],[ack(1),ack(2)]);
  assert.equal(out.admittedCalls,2);assert.equal(out.settledCalls,2);
  assert.equal(out.chargeTotalNanodollars,'40000');assert.equal(out.ackInventoryComplete,true);
  assert.deepEqual(out.tokenTotals,{input:'200',output:'40',cached:'0',uncached:'200'});
  assert.equal(out.finalizationAuthorized,false);
});
test('missing second acknowledgment never erases second admitted charge',()=>{
  const out=run([admit(1),known(1),admit(2),known(2)],[ack(1)]);
  assert.equal(out.chargeTotalNanodollars,'40000');assert.equal(out.admittedCalls,2);
  assert.equal(out.ackInventoryComplete,false);assert.deepEqual(out.ackErrors,['ack_admission_count_mismatch']);
});
test('unknown and unsettled preserve exposure and incomplete totals',()=>{
  const out=run([admit(1),known(1),admit(2),unknown(2),admit(3)],[ack(1),ack(2)]);
  assert.equal(out.unknownHoldCalls,1);assert.equal(out.unsettledCalls,1);
  assert.equal(out.unknownHoldNanodollars,'10000000');assert.equal(out.unsettledReserveNanodollars,'10000000');
  assert.equal(out.knownChargeSubtotalNanodollars,'20000');assert.equal(out.journalExposureNanodollars,'20020000');
  assert.equal(out.chargeTotalNanodollars,null);assert.equal(out.tokenTotals,null);
  assert.equal(out.knownTokenSubtotals.input,'100');
});
test('historical other-run hold remains in whole journal exposure',()=>{
  const rows=[{event:'admit',id:'historic:1',run:'historic',call:1,reserve:1},admit(1),known(1)];
  const out=run(rows,[ack(1)]);
  assert.equal(out.admittedCalls,1);assert.equal(out.journalExposureNanodollars,'1000020000');
});
test('zero-byte aborted acknowledgment may exist but cannot create known usage',()=>{
  const out=run([admit(1),unknown(1)],[{...ack(1),response_byte_count:0}]);
  assert.equal(out.ackInventoryComplete,true);assert.equal(out.completeUsage,false);
  assert.equal(out.chargeTotalNanodollars,null);
});
test('no calls does not become complete model usage or capture',()=>{
  const out=run([],[]);assert.equal(out.admittedCalls,0);
  assert.equal(out.completeUsage,false);assert.equal(out.ackInventoryComplete,false);
});
test('ack duplicates, missing, extra and reordering refuse completeness',()=>{
  const rows=[admit(1),known(1),admit(2),known(2)];
  for(const acks of [[ack(1),ack(1)],[ack(2),ack(1)],[ack(1),ack(2),ack(3)],[],null]){
    const out=run(rows,acks);assert.equal(out.ackInventoryComplete,false);
    assert.equal(out.chargeTotalNanodollars,'40000');
  }
});
test('ack arm, profile, channel, contract and request substitutions refuse',()=>{
  for(const [key,value] of [['client','light'],['binding_profile_id','light-luna-44aed-source-base-v2'],
    ['channel_id','wrong'],['binding_contract_sha256','0'.repeat(64)],['request_body_sha256','0'.repeat(64)],
    ['call_ordinal',true],['publication_ordinal',2],['response_byte_count',-1],['schema_version',true],['extra',true]]){
    const out=run([admit(1),known(1)],[{...ack(1),[key]:value}]);
    assert.equal(out.ackInventoryComplete,false,key);assert.equal(out.knownCalls,1);
  }
});
test('crossed trusted profile and unsupported expected fields refuse',()=>{
  assert.throws(()=>run([],[],{...expected,client:'light'}));
  assert.throws(()=>run([],[],{...expected,extra:true}));
});
test('settlement request mismatch cannot borrow another admitted request',()=>{
  assert.throws(()=>run([admit(1),{...known(1),request_sha256:'0'.repeat(64)}],[ack(1)]));
});
test('whole-journal duplicate, bad policy, skipped ordinal, underhold refuse',()=>{
  for(const rows of [[admit(1),admit(1)],
    [{...admit(1),financial_policy_id:'0'.repeat(64)}],[admit(2)],
    [admit(1),{...unknown(1),charge_nanos:'1',budget_charge_usd:0.000000001}],
    [{...admit(1),request_sha256:'bad'}]])assert.throws(()=>run(rows,[]));
});
test('strict duplicate JSON and partial trailing row refuse',()=>{
  for(const bytes of [Buffer.from('{"run":"test","run":"test"}\n'),raw([admit(1)]).subarray(0,-1)])
    assert.throws(()=>reconcileAttempt({ledgerBytes:bytes,expected,acknowledgments:[]}));
});
test('both arm identities share exact same accounting rules',()=>{
  const exp={...expected,client:'light',binding_profile_id:'light-luna-44aed-source-base-v2'};
  const publication={...ack(1),client:exp.client,binding_profile_id:exp.binding_profile_id};
  const out=run([admit(1),known(1)],[publication],exp);
  assert.equal(out.ackInventoryComplete,true);assert.equal(out.chargeTotalNanodollars,'20000');
});
test('accepted monetary lexeme conservatism survives every reported subtotal',()=>{
  const held=run([admit(1),{...unknown(1),charge_nanos:'9999999'}],[ack(1)]);
  assert.equal(held.unknownHoldNanodollars,'10000000');
  assert.equal(held.calls[0].chargeNanodollars,'10000000');
  assert.equal(held.calls[0].nominalChargeNanodollars,'9999999');
  const pending=run([{...admit(1),reserve:0.010000001}],[]);
  assert.equal(pending.unsettledReserveNanodollars,'10000001');
  assert.equal(pending.calls[0].reserveNanodollars,'10000001');
  assert.equal(pending.calls[0].nominalReserveNanodollars,'10000000');
  const charged=run([admit(1),{...known(1),budget_charge_usd:0.000020001}],[ack(1)]);
  assert.equal(charged.knownChargeSubtotalNanodollars,'20001');
  assert.equal(charged.chargeTotalNanodollars,'20001');
  assert.equal(charged.calls[0].nominalChargeNanodollars,'20000');
  for(const out of [held,pending,charged])assert.equal(
    BigInt(out.knownChargeSubtotalNanodollars)+BigInt(out.unknownHoldNanodollars)+BigInt(out.unsettledReserveNanodollars),
    BigInt(out.journalExposureNanodollars));
});
