import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runCase} from './parent.mjs';

for(const mode of ['credit_exhaustion','positive_cap'])test('actual Pi healthy EOF: '+mode,async()=>{
  const r=await runCase('normal',mode);
  assert.equal(r.closed,true);assert.equal(r.final.calls,1);assert.equal(r.final.stopReason,'stop');
  assert.equal(r.final.contentMatched,true);assert.equal(r.final.terminalEvents,1);assert.equal(r.final.disposed,true);
  assert.equal(r.final.eof,true);assert.equal(r.final.cancels,0);assert.equal(r.final.bridgeCalls,2);
  assert.deepEqual(r.rows.map(x=>x.event),['admit','settle']);
  assert.equal(r.rows[1].settlement_proof,'completed-full-usage-v1');assert.equal(r.rows[1].charge_nanos,'20000');
  assert.equal(r.stopped,false);assert.equal(r.acks.length,1);
  assert.equal(r.receipt.transport_outcome,'eof');assert.equal(r.receipt.capture_write_complete,true);
  assert.equal(r.receipt.client,'pi');assert.equal(r.receipt.initial_binding_verified,true);
  assert.equal(r.acks[0].root_turn_id,r.final.rootTurnId);
});
test('ordinary public session.abort retains exact full unknown hold',async()=>{
  const r=await runCase('abort');
  assert.equal(r.closed,true);assert.equal(r.final.calls,1);assert.equal(r.final.stopReason,'aborted');
  assert.equal(r.final.terminalEvents,1);assert.equal(r.final.disposed,true);assert.equal(r.final.eof,false);
  assert.equal(r.final.cancels,1);assert.deepEqual(r.rows.map(x=>x.event),['admit','settle']);
  assert.equal(r.rows[1].usage_missing,true);assert.equal(r.rows[1].charge_nanos,r.rows[0].reserve_nanos);
  assert.equal(r.fullHold,true);assert.equal(r.stopped,true);assert.equal(r.acks.length,1);assert.notEqual(r.receipt.transport_outcome,'eof');
});
for(const name of ['task','policy'])test('unchanged seal refuses actual Pi '+name+' mutation',async()=>{
  const r=await runCase(name);
  assert.equal(r.closed,true);assert.equal(r.final.calls,0);assert.equal(r.final.stopReason,'error');
  assert.equal(r.final.terminalEvents,1);assert.equal(r.final.disposed,true);
  assert.equal(r.rows.length,0);assert.equal(r.acks.length,0);assert.equal(r.receipt,null);
});
