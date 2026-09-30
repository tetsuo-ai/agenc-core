// Inert reviewer regression: no provider, client, filesystem mutation or ledger I/O.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = '/private/tmp/light-takeover/fair-confirmation/shared-attempt-v1/reconcile.mjs';
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  '0200630c27d92ae056d32f7157475a73ad0668adc8c5fe0649e422e834fb5775');
const { reconcileAttempt } = await import(source);
const policy = 'a'.repeat(64), request = 'b'.repeat(64);
const expected = {run_id:'test',root_turn_id:'root',client:'pi',binding_profile_id:'pi-luna-v0731-shared-v1',
  protocol_id:'synthetic',channel_id:'channel',financial_policy_id:policy,
  observer_source_sha256:'c'.repeat(64),installed_adapter_sha256:'d'.repeat(64),
  binding_source_sha256:'e'.repeat(64),binding_contract_sha256:'f'.repeat(64)};
const common = {id:'test:1',run:'test',call:1,financial_schema:1,financial_policy_id:policy,
  price_id:'historical-luna-fixture-nanodollars-v1',request_sha256:request};
const admit = {event:'admit',...common,reserve:0.01,reserve_nanos:'10000000'};
const unknown = {event:'settle',...common,usage_missing:true,usage:{},cost_usd:null,
  budget_charge_usd:0.01,charge_nanos:'10000000',error:{type:'unknown_terminal'}};
const known = {event:'settle',...common,usage_missing:false,
  usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}},
  cost_usd:0.00002,budget_charge_usd:0.00002,charge_nanos:'20000',settlement_proof:'completed-full-usage-v1',
  error:null,input_tokens:100,output_tokens:20,cached_tokens:0,uncached_tokens:100};
const run = rows => reconcileAttempt({ledgerBytes:Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join('')),
  expected, acknowledgments:[]});

test('control: canonical writer values agree with selected financial exposure',()=>{
  const out=run([admit,unknown]);
  assert.equal(out.unknownHoldNanodollars,out.journalExposureNanodollars);
  assert.equal(out.unknownHoldNanodollars,'10000000');
});
test('unknown hold must not be below the accepted ledger reserve',()=>{
  const out=run([admit,{...unknown,charge_nanos:'9999999'}]);
  // Accepted accounting keeps 10000000, but the candidate reports 9999999.
  assert.equal(out.unknownHoldNanodollars,out.journalExposureNanodollars);
});
test('unsettled reserve must retain accepted conservative numeric-lexeme exposure',()=>{
  const out=run([{...admit,reserve:0.010000001}]);
  assert.equal(out.unsettledReserveNanodollars,out.journalExposureNanodollars);
});
test('known recorded budget charge must not silently discard accepted one-nano excess',()=>{
  const out=run([admit,{...known,budget_charge_usd:0.000020001}]);
  assert.equal(out.chargeTotalNanodollars,out.journalExposureNanodollars);
});
