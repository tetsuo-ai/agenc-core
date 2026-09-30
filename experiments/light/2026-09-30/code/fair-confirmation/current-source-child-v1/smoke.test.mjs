import test from 'node:test';
import assert from 'node:assert/strict';
import {runChild} from './parent.mjs';

test('owned standalone source child: independent assembly, selected19, actual SQLite/provider/fake fetch',async()=>{
 const value=await runChild();
 console.log(JSON.stringify(value));
 assert.equal(value.confirmed,true);assert.equal(value.invalid,false);
 const r=value.message.result;
 assert.equal(value.message.ok,true);assert.equal(r.calls,1);assert.equal(r.validations,1);
 assert.equal(r.producers,19);assert.equal(r.dispatched,1);assert.equal(r.reconciled,1);
 assert.equal(r.wireMatched,true);assert.equal(r.selectedRefused,false);
 assert.deepEqual(r.chronology,['independent_assembly','sealed','canonical_user_event','selected','sqlite_dispatched','actual_provider','fakefetch','wire_policy_accepted','sqlite_reconciled']);
 assert.ok(value.message.loader.sourceModules>0);assert.ok(value.message.loader.markdownModules>0);
});

test('actual task mutation refuses selected preparation before SQLite dispatch and provider',async()=>{
 const value=await runChild('task');
 console.log(JSON.stringify(value));
 assert.equal(value.confirmed,true);assert.equal(value.invalid,false);
 const r=value.message.result;
 assert.equal(r.selectedRefused,true);assert.equal(r.calls,0);assert.equal(r.dispatched,0);assert.equal(r.reconciled,0);
});

for(const mode of ['early_exit','unexpected_ipc','timeout'])test('owned child '+mode+' is invalid only after confirmed containment',async()=>{
 const value=await runChild(mode);console.log(JSON.stringify(value));
 assert.equal(value.confirmed,true);assert.equal(value.invalid,true);assert.equal(value.networkAttempts,0);
 assert.equal(value.message,null);
 if(mode==='early_exit'){assert.equal(value.code,73);assert.equal(value.signal,null);}
 else assert.equal(value.signal,'SIGKILL');
});
