import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const dir='/private/tmp/light-takeover/fair-confirmation/luna-observer-v4';
const original=fs.readFileSync(path.join(dir,'observer.test.mjs'),'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'21959970852c02a26ceaaad071d0e31ec52ab96b0d18af0e0ac8aab4418d8c46');
// Reuse the pinned test's private synthetic-root/owned-child fixture, not its
// assertions. Only add a prelaunch artifact-setup callback. Candidate code,
// synthetic child, financial modules and prior evidence remain untouched.
let setup=original.slice(0,original.indexOf("\ntest('actual observer"));
setup=setup.replaceAll("from '../luna-policy-v2/owned_child-v2.mjs'",`from 'file://${dir}/../luna-policy-v2/owned_child-v2.mjs'`)
 .replaceAll("from '../luna-finance-mode-v2/journal.mjs'",`from 'file://${dir}/../luna-finance-mode-v2/journal.mjs'`)
 .replace('const here=path.dirname(fileURLToPath(import.meta.url)),fair=path.dirname(here);',`const here=${JSON.stringify(dir)},fair=path.dirname(here);`)
 .replace('async function run({mutate,','async function run({prepare,mutate,')
 .replace(' const acks=[];',' prepare?.(root);\n const acks=[];');
const {run}=await import('data:text/javascript;base64,'+Buffer.from(setup+'\nexport {run};').toString('base64'));
const read=(root,name)=>fs.readFileSync(path.join(root,name),'utf8');
const remember=(r)=>console.log(JSON.stringify({reviewRoot:r.root,calls:r.calls,events:r.rows.map(x=>x.event),ackOrdinals:r.acks.map(x=>x.call_ordinal)}));

for(const filename of ['capture-request-001.json','capture-response-001.sse'])test('optional '+filename+' collision cannot refund, retry or replace',async()=>{
 const sentinel='reviewer preserved artifact\n';
 const r=await run({prepare:root=>fs.writeFileSync(path.join(root,filename),sentinel,{flag:'wx',mode:0o600})});remember(r);
 assert.equal(r.calls,2);assert.deepEqual(r.errors,[null,null]);assert.deepEqual(r.rows.map(x=>x.event),['admit','settle','admit','settle']);
 assert.equal(read(r.root,filename),sentinel);
 assert.equal(r.rows[1].settlement_proof,'completed-full-usage-v1');assert.equal(r.rows[1].charge_nanos,'20000');
 const first=JSON.parse(read(r.root,'capture-receipt-001.json'));
 assert.equal(first.capture_write_complete,false);assert.equal(first.downstream_delivery_failed,false);assert.equal(first.transport_outcome,'eof');
 assert.deepEqual(r.acks.map(x=>x.call_ordinal),[1,2]);assert.equal(fs.existsSync(path.join(r.root,'luna-api-stop.json')),false);
});
test('preexisting receipt is not replaced; absent first publication cannot be repaired by second',async()=>{
 const sentinel='reviewer preserved receipt\n';
 const r=await run({prepare:root=>fs.writeFileSync(path.join(root,'capture-receipt-001.json'),sentinel,{flag:'wx',mode:0o600})});remember(r);
 assert.equal(r.calls,2);assert.deepEqual(r.errors,[null,null]);assert.equal(r.rows.length,4);
 assert.equal(read(r.root,'capture-receipt-001.json'),sentinel);assert.deepEqual(r.acks.map(x=>x.call_ordinal),[2]);
 assert.equal(r.rows[1].settlement_proof,'completed-full-usage-v1');assert.equal(r.rows[3].settlement_proof,'completed-full-usage-v1');
});
test('explicit fresh synthetic positive cap refusal precedes admission and artifacts',async()=>{
 const r=await run({first:true,spendPolicy:{mode:'positive_cap',capUsd:'0.000000001'}});remember(r);
 assert.equal(r.calls,0);assert.equal(r.rows.length,0);assert.deepEqual(r.errors,['refused']);assert.deepEqual(r.acks,[]);
 assert.equal(fs.existsSync(path.join(r.root,'capture-request-001.json')),false);
 assert.equal(fs.existsSync(path.join(r.root,'luna-api-stop.json')),true);
});
