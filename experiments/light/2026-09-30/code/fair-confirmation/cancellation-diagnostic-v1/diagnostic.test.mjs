import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runChild} from './parent.mjs';

for(const mode of ['normal','completed_cancel','whole_turn_cancel'])test(mode+': actual source cancellation/cleanup diagnostic',async()=>{
 const result=await runChild(mode);
 const stages=fs.readFileSync(result.root+'/stages.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line).stage);
 console.log(JSON.stringify({mode,...result,stages}));
 assert.equal(result.confirmed,true);assert.equal(result.invalid,false);assert.equal(result.message.ok,true);
 assert.equal(result.message.result.calls,1);assert.equal(result.message.result.producers,19);
 assert.ok(stages.includes('turn_returned'));assert.ok(stages.includes('cleanup_operations_finished'));
 if(mode==='normal'){
  assert.equal(result.message.result.reconciled,1);assert.equal(result.finance[1].usageMissing,false);
  assert.equal(result.ack.transportOutcome,'eof');assert.equal(result.stopExists,false);
 }else{
  assert.equal(result.message.result.reconciled,0);assert.equal(result.message.result.heldUnknown,1);
  assert.equal(result.finance[1].usageMissing,true);assert.equal(result.fullHold,true);assert.equal(result.stopExists,true);
  assert.equal(result.ack.transportOutcome,'aborted');
 }
});
