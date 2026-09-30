// Synthetic current-profile recipe, not executed Core/Pi provenance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOwnedChildGate} from '../luna-policy-v2/owned_child-v2.mjs';
import {financialPolicyId} from '../luna-finance-mode-v2/journal.mjs';
const childGate=createOwnedChildGate();
const here=path.dirname(fileURLToPath(import.meta.url)),fair=path.dirname(here);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const read=p=>fs.readFileSync(p);
const pins={
 'luna-observer-v5/direct.mjs':'61e6d38bccdac0f03ce6999c794297a5fee284ee8baa4c8f024941f21947a6f9',
 'luna-observer-v5/child.test-fixture.mjs':'79d6ded3fc918b1f1cddbd24238255360d9be76503a479923ab56765b0f85e74',
 'luna-finance-mode-v2/journal.mjs':'7031279770cebb0d2223a61c7a7bc4146fa97dc6ac52b7da5c3f78b4dc313215',
 'luna-finance-mode-v2/owner.mjs':'e137831bca7811cad554d2245466208ce85962108dd4a824aa4bce1744a2a9c9',
 'luna-finance-v1/accounting.mjs':'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
 'luna-finance-v1/ledger-json.mjs':'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
 'luna-terminal-v1/terminal.mjs':'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70',
 'luna-financial-transport-v1/transport.mjs':'0ead80c608376b2e70d1b2b8dfd9cba51314a7529f11b4f572683a8a7fa4dd04',
 'luna-policy-v2/policy_guard.mjs':'56d6ae59ffdbe405d2a3bd0d1aab2b0798876bb016211fe284cae9f785375b9a',
 'luna-policy-v2/policy_bridge.py':'ac8620d8fd34b2d1e22761c7034a5a1d4ca972df9ca6536395ca47ba1695b590',
 'luna-policy-v2/owned_child-v2.mjs':'c4a9e77b4de27799507a55814d93db0a4a5b7ae336b670add852a4e5bac57a70',
 'current-base-binding-v2/binding.py':'3815c1fbbbbc9b2aaf23a9adcd469d5f5b0a2c4bb38ca42dfed9e826a491f87c',
 'current-base-binding-v2/bridge.py':'c3c2afb87cc28c471cdd1a56f600d2f6beda4479cef27c42ccdcd8bac37ee0b4',
 'current-base-binding-v2/binding_test.py':'2ca92a5638d36d5903ccd8a6fd803879d3ece6995a24ed9637c58023a0f85cb7',
 'current-base-binding-v2/source-pins.json':'3aae0ba39d020c40a2ade6980f1d2dc5426e50a081b552a9b048be2bfa735457',
 'luna-capture-v5/fixture_builder.py':'905dcd708fcb4291df13eabeddf174b14c1a8110147a7f75a5b5bc408b72ab72',
 'luna-capture-v5/binding_bridge.py':'d9076c9adf0f0529dd88e118a22ecefb191a5755387951c0e9f836658f840db5',
 'prompt-binding-v2/prompt_binding.py':'513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
 'all-call-policy-v1/policy.py':'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf',
 'stream_adapters.py':'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323'
};
for(const [name,pin] of Object.entries(pins))assert.equal(sha(read(path.join(fair,name))),pin);
const py=spawnSync('/usr/bin/python3',['-I','-S','-B','-c','import sys,os;print(os.path.realpath(sys.executable))'],{encoding:'utf8',env:{},timeout:5000});
assert.equal(py.status,0); const python=py.stdout.trim();
// Independently authored fixed declaration, before fixture request assembly.
const controls={model:'gpt-6-luna',stream:true,store:false,max_output_tokens:8192,
 reasoning:{effort:'low',summary:'auto'},include:['reasoning.encrypted_content'],parallel_tool_calls:true,prompt_cache_key:'synthetic-fixed-session'};
const policy={schema_version:1,profile:'fixed-luna-v1',route:'openai-direct',client:'light',controls};
function assembly(){
 const code=`import runpy,json,base64,sys\ns=runpy.run_path(sys.argv[1]);f=s['fixture']()\nprint(json.dumps({'body':json.loads(f['request_bytes']),'contract_base64':base64.b64encode(f['contract_bytes']).decode(),'expected':f['expected'],'deployed_source_pins':f['deployed_source_pins']}))\n`;
 const result=spawnSync(python,['-I','-S','-B','-c',code,path.join(fair,'current-base-binding-v2/binding_test.py')],{encoding:'utf8',env:{},timeout:5000,maxBuffer:65536});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

async function run({mutate,first=false,metaFault,stop=false,lock=false,mutateCaller=false,
  spendPolicy={mode:'credit_exhaustion'},responseMode,requestMode,cap=45}={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'luna-observer-v5-')));
 fs.chmodSync(root,0o700);
 const write=(name,value)=>fs.writeFileSync(path.join(root,name),value,{flag:'wx',mode:0o600});
 write('luna-api-ledger.jsonl','');
 const rs=fs.statSync(root,{bigint:true}),js=fs.statSync(path.join(root,'luna-api-ledger.jsonl'),{bigint:true});
 const inventory={rootDev:String(rs.dev),rootIno:String(rs.ino),journalDev:String(js.dev),journalIno:String(js.ino),
   prefixBytes:0,prefixSha256:sha('')};
 const fixture=assembly();
 write('contract.json',Buffer.from(fixture.contract_base64,'base64'));
 const policyRaw=JSON.stringify(policy);write('policy.json',policyRaw);
 const binding={contract_path:path.join(root,'contract.json'),expected:fixture.expected,deployed_source_pins:fixture.deployed_source_pins,
  binding_source_sha256:pins['current-base-binding-v2/binding.py'],bridge_source_sha256:pins['current-base-binding-v2/bridge.py'],python_path:python,python_sha256:sha(read(python))};
 const meta={schema_version:10,contract:'prospective-current-source-finance-v5',protocol_id:'synthetic-current-profile',run_id:'synthetic',
  root_turn_id:'root',route:'openai-direct',task_prompt_sha256:sha('Synthetic fixed task.'),
  observer_source_sha256:sha(read(path.join(here,'direct.mjs'))),installed_adapter_sha256:pins['stream_adapters.py'],
  installed_adapter_path:path.join(fair,'stream_adapters.py'),publication_channel_id:crypto.randomUUID(),binding,
  fixed_policy:{policy_path:path.join(root,'policy.json'),policy_sha256:sha(policyRaw),
    bridge_sha256:sha(read(path.join(fair,'luna-policy-v2/policy_bridge.py')))},
  financial:{schema_version:2,spend_policy:spendPolicy,policy_id:financialPolicyId(spendPolicy),inventory}};
 metaFault?.(meta);
 const raw=JSON.stringify(meta);write('metadata.json',raw);
 const original=structuredClone(fixture.body),changed=structuredClone(original);
 mutate?.(changed);
 const bodies=first?[changed]:[original,changed];
 write('requests.json',JSON.stringify({bodies,mutateCaller,responseMode,requestMode}));
 const sentinel='original-stop-sentinel\n';
 if(stop)write('luna-api-stop.json',sentinel);
 if(lock){fs.mkdirSync(path.join(root,'luna-api-admission.lock'));fs.writeFileSync(path.join(root,'luna-api-admission.lock','foreign'),'original-lock');}
 const acks=[];
 await childGate.run(()=>fork(path.join(here,'child.test-fixture.mjs'),[],{
  execPath:process.execPath,execArgv:['--expose-gc'],cwd:root,stdio:['ignore','pipe','pipe','ipc'],
  env:{HOME:root,LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'synthetic',LUNA_TASK_CALL_CAP:String(cap),
    LUNA_CAPTURE_METADATA:path.join(root,'metadata.json'),LUNA_CAPTURE_METADATA_SHA256:sha(raw)}}),{onMessage:m=>acks.push(m)});
 const rows=read(path.join(root,'luna-api-ledger.jsonl')).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
 const result={root,rows,acks,bodies,...JSON.parse(read(path.join(root,'outcome.json')))};
 if(stop)assert.equal(read(path.join(root,'luna-api-stop.json')).toString(),sentinel);
 if(lock)assert.equal(read(path.join(root,'luna-api-admission.lock','foreign')).toString(),'original-lock');
 return result;
}

test('actual observer joins fixed policy, initial binding, transport, journal and capture in both modes',async()=>{
 for(const spendPolicy of [{mode:'credit_exhaustion'},{mode:'positive_cap',capUsd:'0.1'}]) {
  const r=await run({spendPolicy,mutateCaller:true});
  assert.equal(r.calls,2);assert.deepEqual(r.errors,[null,null]);
  assert.deepEqual(r.redirects,['manual','manual']);
  assert.deepEqual(r.rows.map(x=>x.event),['admit','settle','admit','settle']);
  assert.deepEqual(r.acks.map(x=>x.kind),['luna.capture.published.current.v5','luna.capture.published.current.v5']);
  assert.deepEqual(r.forwarded,r.bodies.map(x=>sha(JSON.stringify(x))));
  for(let n=1;n<=2;n++){
   const receipt=JSON.parse(read(path.join(r.root,'capture-receipt-'+String(n).padStart(3,'0')+'.json')));
   assert.equal(receipt.capture_write_complete,true);assert.equal(receipt.transport_outcome,'eof');
   assert.equal(receipt.downstream_delivery_failed,false);assert.equal(receipt.call_ordinal,n);
   assert.equal(receipt.request_body_sha256,r.forwarded[n-1]);
   assert.equal(r.rows[2*n-1].settlement_proof,'completed-full-usage-v1');
   assert.equal(r.rows[2*n-1].charge_nanos,'20000');
  }
 }
});
for(const first of [true,false])test('policy drift refuses before '+(first?'initial':'later')+' reservation',async()=>{
 const r=await run({first,mutate:b=>b.reasoning.summary='none'});
 assert.equal(r.calls,first?0:1);assert.equal(r.rows.length,first?0:2);assert.equal(r.errors.at(-1),'refused');
});
test('changed initial task cannot borrow a matching fixed-policy declaration',async()=>{
 const r=await run({first:true,mutate:b=>b.input.push({role:'user',content:'Different synthetic task.'})});
 assert.equal(r.calls,0);assert.equal(r.rows.length,0);assert.deepEqual(r.errors,['refused']);
});
test('existing stop and foreign lock are never replaced or cleared',async()=>{
 for(const option of [{stop:true},{lock:true}]){
  const r=await run({...option,first:true});assert.equal(r.calls,0);assert.equal(r.rows.length,0);
 }
});
for(const responseMode of ['fetch_error','http_error','redirect','late_error'])test(responseMode+' keeps full unknown hold with no second send',async()=>{
 const r=await run({responseMode});
 assert.equal(r.calls,1);assert.deepEqual(r.errors,['refused','refused']);assert.equal(r.rows.length,2);
 assert.equal(r.rows[1].usage_missing,true);assert.equal(r.rows[1].cost_usd,null);
 assert.equal(r.rows[1].charge_nanos,r.rows[0].reserve_nanos);
 assert.equal(fs.existsSync(path.join(r.root,'luna-api-stop.json')),true);
});
test('task cap blocks later call without losing completed accounting',async()=>{
 const r=await run({cap:1});assert.equal(r.calls,1);assert.equal(r.rows.length,2);assert.deepEqual(r.errors,[null,'refused']);
});
test('abort during stalled request preparation cancels owned reader before any admission',async()=>{
 const r=await run({first:true,requestMode:'abort_preparation'});
 assert.equal(r.calls,0);assert.equal(r.rows.length,0);assert.deepEqual(r.errors,['refused']);
 assert.equal(r.preparationCancels,1);
});
for(const [name,metaFault]of Object.entries({
 missing:m=>delete m.financial,
 mismatch:m=>m.financial.policy_id='0'.repeat(64),
 mode:m=>m.financial.spend_policy={mode:'credit_exhaustion',capUsd:'0'},
 inode:m=>m.financial.inventory.journalIno='0',
 prefix:m=>m.financial.inventory.prefixSha256='0'.repeat(64),
}))test('financial '+name+' refuses without provider call',async()=>{
 const r=await run({first:true,metaFault});assert.equal(r.calls,0);assert.equal(r.rows.length,0);
 assert.deepEqual(r.errors,['refused']);
});

for(const requestMode of ['abort_fetch_gc','abort_body_gc'])test('observer owns upstream caller lifetime: '+requestMode,async()=>{
 const r=await run({first:true,requestMode});
 assert.equal(r.calls,1);assert.equal(r.gcState.state,'refused');
 if(requestMode==='abort_body_gc')assert.equal(r.gcState.originalRetained,true);
 assert.equal(r.responseCancels,1);assert.equal(r.rows.length,2);
 assert.equal(r.rows[1].usage_missing,true);assert.equal(r.rows[1].charge_nanos,r.rows[0].reserve_nanos);
 assert.equal(fs.existsSync(path.join(r.root,'luna-api-stop.json')),true);
});
