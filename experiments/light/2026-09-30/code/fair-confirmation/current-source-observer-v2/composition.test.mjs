import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runChild} from './parent.mjs';
import {canonical} from './seal.mjs';

test('contract codec retains Python ASCII/sorted-object convention without capture input',()=>{
 assert.equal(canonical({z:'é😀',a:[1,true,null]}).toString(),'{"a":[1,true,null],"z":"\\u00e9\\ud83d\\ude00"}');
 assert.throws(()=>canonical({x:'\ud800'}));assert.throws(()=>canonical({x:Infinity}));
});
for(const mode of ['normal','positive_cap'])test(mode+': current actual source→observer→financial admission→native→capture',async()=>{
 const v=await runChild(mode);console.log(JSON.stringify(v));
 assert.equal(v.confirmed,true);assert.equal(v.invalid,false);assert.equal(v.message.ok,true);
 const r=v.message.result;
 assert.equal(r.producers,19);assert.equal(r.dispatched,1);assert.equal(r.reconciled,1);assert.equal(r.heldUnknown,0);
 assert.equal(r.calls,1);assert.equal(r.validations,1);assert.equal(r.wireMatched,true);assert.equal(v.message.hooks.observerEntries,1);
 assert.deepEqual(r.chronology,['independent_assembly','sealed','canonical_user_event','selected','sqlite_dispatched','actual_provider','fakefetch','financial_admitted_before_native','wire_policy_accepted','sqlite_reconciled']);
 assert.equal(v.finance.length,2);assert.deepEqual(v.finance.map(x=>x.event),['admit','settle']);
 assert.equal(v.finance[1].usageMissing,false);assert.equal(v.finance[1].proof,'completed-full-usage-v1');
 assert.equal(v.ack.requestSha256,r.capturedDigest);assert.equal(v.ack.contractSha256,v.message.hooks.contractHash);
 assert.equal(v.ack.transportOutcome,'eof');
 assert.equal(fs.existsSync(v.root+'/financial/luna-api-stop.json'),false);
 const meta=JSON.parse(fs.readFileSync(v.root+'/metadata.json'));
 assert.equal(meta.financial.spend_policy.mode,mode==='normal'?'credit_exhaustion':'positive_cap');
});
for(const mode of ['completed_error','completed_cancel'])test(mode+': completed event without acceptable EOF never releases financial hold',async()=>{
 const v=await runChild(mode);console.log(JSON.stringify(v));
 assert.equal(v.confirmed,true);assert.equal(v.invalid,false);assert.equal(v.message.ok,true);
 const r=v.message.result;
 assert.equal(r.producers,19);assert.equal(r.calls,1);assert.equal(r.validations,1);assert.equal(r.dispatched,1);
 assert.equal(r.reconciled,0);assert.equal(r.heldUnknown,1);assert.equal(r.wireMatched,true);
 assert.deepEqual(v.finance.map(x=>x.event),['admit','settle']);
 assert.equal(v.finance[1].usageMissing,true);assert.equal(v.finance[1].proof,null);
 assert.equal(v.fullHold,true);assert.equal(v.stopExists,true);
 assert.equal(v.ack.requestSha256,r.capturedDigest);
 assert.equal(v.ack.transportOutcome,mode==='completed_error'?'cancelled':'aborted');
});
for(const mode of ['task','summary','contract_mismatch'])test(mode+': preserves distinct Core and financial refusal stages',async()=>{
 const v=await runChild(mode);console.log(JSON.stringify(v));
 assert.equal(v.confirmed,true);assert.equal(v.invalid,false);assert.equal(v.message.ok,true);
 const r=v.message.result;assert.equal(r.calls,0);assert.equal(v.finance.length,0);assert.equal(v.ack,null);
 if(mode==='task'){
  assert.equal(r.selectedRefused,true);assert.equal(r.dispatched,0);assert.equal(v.message.hooks.observerEntries,0);
 }else{
  assert.equal(r.selectedRefused,false);assert.equal(r.producers,19);assert.equal(r.dispatched,1);
  assert.equal(v.message.hooks.observerEntries,1);assert.equal(r.reconciled,0);assert.equal(r.heldUnknown,1);
 }
});
