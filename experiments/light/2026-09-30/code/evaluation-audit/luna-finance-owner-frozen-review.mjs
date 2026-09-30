import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';

const source=readFileSync(new URL('../fair-confirmation/luna-finance-owner-v1/owner.mjs',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'c3a34d821ed725f3dd6b8ee996dbbccd0b6023af275cb50d6992847bc4a2ad3d');
// Execute the exact owner body with inert journal/terminal dependencies. No
// actual root, provider, filesystem journal, or process is created by a case.
const compile=new Function('createHash','createFinancialJournal','requestReserve','PRICE_ID','TERMINAL_PROOF','createResponsesTerminal',
  source.replace(/^import .+;\n/gm,'').replace('export function createFinancialOwner','function createFinancialOwner')+'\nreturn createFinancialOwner;');
const known=()=>({state:'known',chargeNanos:'100',input:1,output:0,cached:0,proof:'synthetic-proof',responseIdSha256:'a'.repeat(64)});
function fixture(factory,commitHook=()=>{}){
  const rows=[];let stopped=false;
  const journal={commit(raw){const row=JSON.parse(raw.toString());commitHook(row);rows.push(row);if(row.event==='settle'&&row.usage_missing)stopped=true;
    return {exposureNanodollars:'1000',stopPresent:stopped,stopRequired:stopped};}};
  const create=compile(createHash,()=>journal,()=>1000n,'fixture','fixture',factory);
  const owner=create({runId:'review',taskCallCap:5,root:'/inert',inventory:{},policyId:'inert',capUsd:'1'});
  return {owner,rows,call:()=>owner.admit(Uint8Array.of(1),1)};
}

test('terminal finish exception latches uncertain one-attempt state instead of returning null',()=>{
  const marker={},f=fixture(()=>({push(){},finish(){throw marker;}})),call=f.call();call.headers(200,'text/event-stream');
  assert.throws(()=>call.finish('eof'),error=>error===marker);
  assert.equal(f.owner.isBlocked(),true);
  assert.throws(()=>call.finish('eof'));assert.equal(f.rows.length,1);
});

test('terminal result conversion exception also blocks all later admissions and retries',()=>{
  const f=fixture(()=>({push(){},finish(){return {...known(),chargeNanos:'invalid'};}})),call=f.call();call.headers(200,'text/event-stream');
  assert.throws(()=>call.finish('eof'));assert.equal(f.owner.isBlocked(),true);
  assert.throws(()=>f.call());assert.throws(()=>call.finish('eof'));assert.equal(f.rows.length,1);
});

test('terminal push exception cannot be followed by a known settlement after caller catches it',()=>{
  let pushes=0;const f=fixture(()=>({push(){if(++pushes===1)throw new Error('synthetic evidence failure');},
    finish(outcome){return outcome==='eof'?known():{state:'unknown'};}}));
  const call=f.call();call.headers(200,'text/event-stream');assert.throws(()=>call.push(Uint8Array.of(1)));
  call.push(Uint8Array.of(2));const result=call.finish('eof');
  assert.equal(result.state,'unknown_hold_committed');assert.equal(result.chargeNanodollars,'1000');
  assert.equal(f.owner.isBlocked(),true);assert.equal(f.rows[1].usage_missing,true);
});

test('terminal construction exception cannot be erased by a second headers attempt',()=>{
  let constructions=0;const f=fixture(()=>{
    if(++constructions===1)throw new Error('synthetic construction failure');
    return {push(){},finish(outcome){return outcome==='eof'?known():{state:'unknown'};}};
  });
  const call=f.call();assert.throws(()=>call.headers(200,'text/event-stream'));
  call.headers(200,'text/event-stream');const result=call.finish('eof');
  assert.equal(result.state,'unknown_hold_committed');assert.equal(f.owner.isBlocked(),true);
});

test('control: prior reservations can settle independently after one known unknown hold stops new admissions',()=>{
  const f=fixture(()=>({push(){},finish(outcome){return outcome==='eof'?known():{state:'unknown'};}}));
  const first=f.call(),second=f.call();assert.equal(first.finish('fetch_error').state,'unknown_hold_committed');
  second.headers(200,'text/event-stream');assert.equal(second.finish('eof').state,'known_charge_committed');
  assert.equal(f.owner.isBlocked(),true);assert.throws(()=>f.call());
  assert.deepEqual(f.rows.map(row=>[row.event,row.call]),[['admit',1],['admit',2],['settle',1],['settle',2]]);
});

test('control: a poisoned shared journal never causes retries of either outstanding settlement',()=>{
  let settlements=0;const f=fixture(()=>({push(){},finish(){return known();}}),row=>{if(row.event==='settle'){settlements++;throw new Error('synthetic journal uncertain');}});
  const first=f.call(),second=f.call();for(const call of [first,second]){call.headers(200,'text/event-stream');assert.throws(()=>call.finish('eof'));assert.throws(()=>call.finish('eof'));}
  assert.equal(settlements,2);assert.equal(f.rows.length,2);assert.equal(f.owner.isBlocked(),true);assert.throws(()=>f.call());
});
