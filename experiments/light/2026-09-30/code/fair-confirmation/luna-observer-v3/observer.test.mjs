// Synthetic historical-profile recipe, not current Core/Pi provenance.
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
 'luna-observer-v3/direct.mjs':'34428edc1a111f738209d6f0a008ae46e201a2053034e331074c5f5e874b5676',
 'luna-observer-v3/child.test-fixture.mjs':'ca651d15e50f63fe3df517670431792e9966c135de55b82b5af5b933202c21f2',
 'luna-finance-mode-v2/journal.mjs':'7031279770cebb0d2223a61c7a7bc4146fa97dc6ac52b7da5c3f78b4dc313215',
 'luna-finance-mode-v2/owner.mjs':'e137831bca7811cad554d2245466208ce85962108dd4a824aa4bce1744a2a9c9',
 'luna-finance-v1/accounting.mjs':'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
 'luna-finance-v1/ledger-json.mjs':'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
 'luna-terminal-v1/terminal.mjs':'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70',
 'luna-financial-transport-v1/transport.mjs':'7ca45f9ddf3d629ef2e4a7cd1ef20c32921de3e1c0db18043f7cca661127e219',
 'luna-policy-v2/policy_guard.mjs':'56d6ae59ffdbe405d2a3bd0d1aab2b0798876bb016211fe284cae9f785375b9a',
 'luna-policy-v2/policy_bridge.py':'ac8620d8fd34b2d1e22761c7034a5a1d4ca972df9ca6536395ca47ba1695b590',
 'luna-policy-v2/owned_child-v2.mjs':'c4a9e77b4de27799507a55814d93db0a4a5b7ae336b670add852a4e5bac57a70',
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
 reasoning:{effort:'low',summary:'auto'},include:['reasoning.encrypted_content']};
const policy={schema_version:1,profile:'fixed-luna-v1',route:'openai-direct',client:'light',controls};
function assembly(){
 const code=`import runpy,json,base64,sys\ns=runpy.run_path(sys.argv[1])\nf=s['build']({'task':'Synthetic task.','run_id':'fixture','protocol_id':'fixture-protocol'})\nc=s['subject']['canonical']; h=s['subject']['sha']\ncontrols=json.load(sys.stdin)\n# Declare extension before execution, never derive expectations from observed wire.\nf['body'].update(controls)\ncontract=json.loads(base64.b64decode(f['contract_base64']))\nenvelope={k:v for k,v in f['body'].items() if k not in ('input','instructions')}\ncontract.update(envelope_fields=sorted(envelope),envelope_sha256=h(c(envelope)))\nb=c(contract);f['contract_base64']=base64.b64encode(b).decode();f['expected']['contract_sha256']=h(b)\nprint(json.dumps(f))\n`;
 const result=spawnSync(python,['-I','-S','-B','-c',code,path.join(fair,'luna-capture-v5/fixture_builder.py')],{input:JSON.stringify(controls),encoding:'utf8',env:{},timeout:5000,maxBuffer:65536});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

async function run({mutate,first=false,metaFault,stop=false,lock=false,mutateCaller=false,
  spendPolicy={mode:'credit_exhaustion'},responseMode,requestMode,cap=45}={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'luna-observer-v3-')));
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
  binding_source_sha256:pins['prompt-binding-v2/prompt_binding.py'],bridge_source_sha256:pins['luna-capture-v5/binding_bridge.py'],python_path:python,python_sha256:sha(read(python))};
 const meta={schema_version:8,contract:'prospective-output-capture-finance-v3',protocol_id:'fixture-protocol',run_id:'fixture',
  root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:sha('Synthetic task.'),
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
  execPath:process.execPath,execArgv:[],cwd:root,stdio:['ignore','pipe','pipe','ipc'],
  env:{HOME:root,LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'fixture',LUNA_TASK_CALL_CAP:String(cap),
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
  assert.deepEqual(r.acks.map(x=>x.kind),['luna.capture.published.finance.v3','luna.capture.published.finance.v3']);
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
