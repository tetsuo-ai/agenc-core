import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runCase} from './parent.mjs';
test('actual admitted Light FileRead continues to second request and call1 plan scores',async()=>{
  const r=await runCase(),out=r.final.result;
  assert.equal(r.closed,true);assert.equal(out.calls,2);assert.equal(out.validations,2);
  assert.equal(out.dispatched,2);assert.equal(out.reconciled,2);assert.equal(out.heldUnknown,0);
  assert.equal(out.producers,19);assert.equal(out.selectedRefused,false);assert.equal(out.wireRefused,false);
  assert.equal(out.wireMatched,true);assert.equal(out.toolStarts,1);assert.equal(out.toolEnds,1);
  assert.equal(out.toolDispatched,1);assert.equal(out.toolReconciled,1);
  assert.equal(out.nativeReadVerified,true);assert.equal(out.secondHistoryVerified,true);assert.equal(out.finalTextMatched,true);
  assert.equal(out.selectedIds.length,2);assert.equal(new Set(out.selectedIds).size,2);
  for(const id of out.selectedIds)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(out.chronology.indexOf('sealed')<out.chronology.indexOf('selected'));
  assert.equal(out.chronology.filter(x=>x==='sqlite_dispatched').length,2);
  assert.equal(r.final.hooks.observerEntries,2);assert.equal(r.stopped,false);
  assert.deepEqual(r.rows.map(x=>x.event),['admit','settle','admit','settle']);
  for(const n of [1,3]){assert.equal(r.rows[n].settlement_proof,'completed-full-usage-v1');assert.equal(r.rows[n].charge_nanos,'20000');assert.equal(r.rows[n].usage_missing,false);}
  assert.deepEqual(r.acks.map(x=>x.call_ordinal),[1,2]);
  assert.deepEqual(r.receipts.map(x=>x.initial_binding_verified),[true,false]);
  assert.equal(r.score.binding_verified,true);assert.equal(r.score.capture_verified,true);
  assert.equal(r.score.adapter_capture_complete,true);assert.equal(r.score.visible_plan_format_pass,true);
  assert.equal(r.score.code_completion,null);assert.equal(r.score.plan_semantic_quality,null);
});
