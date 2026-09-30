// Independent offline reviewer probes. Only new temporary synthetic artifacts.
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {installBinding} from '../fair-confirmation/luna-capture-v5/synthetic_fixture.mjs';
const base='/private/tmp/light-takeover/fair-confirmation/luna-capture-v5';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(fs.readFileSync(path.join(base,'direct.mjs'))),'45843e8b17283c247eb9ded660a689b2952a659957d470da2589883edbd3f074');
const originalFetch=globalThis.fetch,originalSend=process.send,originalConnected=process.connected;
const names=['LUNA_LEDGER_ROOT','LUNA_RUN_DIR','LUNA_RUN_ID','LUNA_TASK_CALL_CAP','LUNA_ALLOW_ADAPTIVE','LUNA_ADAPTIVE_HIGH','LUNA_CAPTURE_METADATA','LUNA_CAPTURE_METADATA_SHA256'];
const saved=new Map(names.map(k=>[k,process.env[k]]));const roots=[];
afterEach(()=>{globalThis.fetch=originalFetch;if(originalSend===undefined)delete process.send;else process.send=originalSend;if(originalConnected===undefined)delete process.connected;else process.connected=originalConnected;for(const[k,v]of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}for(const root of roots.splice(0))fs.rmSync(root,{recursive:true});});
async function setup(prefix){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'luna-v5-independent-'));roots.push(root);
  const {fixture,binding}=installBinding(root,{run_id:'review',protocol_id:'review-offline'});
  const metadata={schema_version:5,contract:'prospective-output-capture-v5',protocol_id:'review-offline',run_id:'review',root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:fixture.expected.task_prompt_sha256,observer_source_sha256:sha(fs.readFileSync(path.join(base,'direct.mjs'))),installed_adapter_sha256:sha(fs.readFileSync(path.join(base,'../stream_adapters.py'))),installed_adapter_path:path.join(base,'../stream_adapters.py'),publication_channel_id:'review-only',binding};
  const raw=JSON.stringify(metadata);fs.writeFileSync(path.join(root,'metadata.json'),raw);
  if(prefix)fs.writeFileSync(path.join(root,'luna-api-ledger.jsonl'),prefix);
  for(const k of names)delete process.env[k];Object.assign(process.env,{LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'review',LUNA_TASK_CALL_CAP:'45',LUNA_CAPTURE_METADATA:path.join(root,'metadata.json'),LUNA_CAPTURE_METADATA_SHA256:sha(raw)});
  let sends=0;globalThis.fetch=async()=>{sends++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  process.send=(_m,cb)=>cb?.(null);process.connected=true;
  await import(path.join(base,'direct.mjs')+'?independent='+root);
  return {root,body:fixture.body,sends:()=>sends,send:body=>fetch('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify(body)})};
}
test('oversized initial raw request retains historical hold and creates no admission or capture',async()=>{
  const prefix=Buffer.from('{"event":"admit","id":"historical:1","run":"historical","call":1,"reserve":1}\n');
  const x=await setup(prefix);x.body.instructions='x'.repeat(1024*1024);
  await assert.rejects(x.send(x.body),/Invalid prospective capture metadata or initial request/);
  assert.equal(x.sends(),0);assert.deepEqual(fs.readFileSync(path.join(x.root,'luna-api-ledger.jsonl')),prefix);
  assert.equal(fs.existsSync(path.join(x.root,'luna-api-admission.lock')),false);
  assert.equal(fs.existsSync(path.join(x.root,'luna-api-stop.json')),false);
  assert.equal(fs.readdirSync(x.root).some(n=>n.startsWith('capture-')||n.startsWith('wire-')),false);
});
test('reused run is explicitly continuation: freshness is a parent obligation, not an inferred new root',async()=>{
  const prefix=Buffer.from('{"event":"admit","id":"review:1","run":"review","call":1,"reserve":1}\n{"event":"settle","id":"review:1","run":"review","call":1,"budget_charge_usd":0}\n');
  const x=await setup(prefix);x.body.input=[{type:'function_call_output',call_id:'synthetic',output:'continuation only'}];
  await(await x.send(x.body)).text();assert.equal(x.sends(),1);
  assert(fs.readFileSync(path.join(x.root,'luna-api-ledger.jsonl')).subarray(0,prefix.length).equals(prefix));
  const receipt=JSON.parse(fs.readFileSync(path.join(x.root,'capture-receipt-002.json')));
  assert.equal(receipt.call_ordinal,2);assert.equal(receipt.initial_request,false);assert.equal(receipt.initial_binding_verified,false);assert.equal(receipt.request_role,'continuation');
  assert.equal(fs.existsSync(path.join(x.root,'capture-receipt-001.json')),false);
});
