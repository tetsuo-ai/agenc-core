import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runCase} from './parent.mjs';
test('actual native read result continues to second policy-checked request; call1 visible plan scores',async()=>{
  const r=await runCase();
  assert.equal(r.closed,true);assert.equal(r.final.calls,2);assert.equal(r.final.cancels,0);
  assert.equal(r.final.stopReason,'stop');assert.equal(r.final.contentMatched,true);
  assert.equal(r.final.terminalEvents,1);assert.equal(r.final.turnEnds,2);assert.equal(r.final.disposed,true);
  assert.equal(r.final.toolStarts,1);assert.equal(r.final.toolEnds,1);
  assert.equal(r.final.nativeResultVerified,true);assert.equal(r.final.secondHistoryVerified,true);
  assert.equal(r.final.bridgeCalls,3);assert.equal(r.final.externalAttempts,0);assert.equal(r.stopped,false);
  assert.deepEqual(r.rows.map(x=>x.event),['admit','settle','admit','settle']);
  for(const n of [1,3]){
    assert.equal(r.rows[n].settlement_proof,'completed-full-usage-v1');
    assert.equal(r.rows[n].charge_nanos,'20000');assert.equal(r.rows[n].usage_missing,false);
  }
  assert.deepEqual(r.acks.map(x=>x.call_ordinal),[1,2]);
  assert.deepEqual(r.receipts.map(x=>x.initial_binding_verified),[true,false]);
  assert.deepEqual(r.receipts.map(x=>x.transport_outcome),['eof','eof']);
  assert.equal(r.score.binding_verified,true);assert.equal(r.score.capture_verified,true);
  assert.equal(r.score.adapter_capture_complete,true);assert.equal(r.score.visible_plan_format_pass,true);
  assert.equal(r.score.code_completion,null);assert.equal(r.score.plan_semantic_quality,null);
});
