// Synthetic historical-profile recipe, not current Core/Pi provenance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOwnedChildGate} from './owned_child-v2.mjs';
const childGate=createOwnedChildGate();
const here=path.dirname(fileURLToPath(import.meta.url)),fair=path.dirname(here);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const read=p=>fs.readFileSync(p);
const pins={
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
async function run({mutate,first=false,metaFault,stop=false,hold=false,mutateCaller=false,cap}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'luna-policy-test-'));
 const write=(name,value)=>fs.writeFileSync(path.join(root,name),value,{flag:'wx',mode:0o600});
 const fixture=assembly();
 write('contract.json',Buffer.from(fixture.contract_base64,'base64'));
 const policyRaw=JSON.stringify(policy);write('policy.json',policyRaw);
 const binding={contract_path:path.join(root,'contract.json'),expected:fixture.expected,deployed_source_pins:fixture.deployed_source_pins,
  binding_source_sha256:pins['prompt-binding-v2/prompt_binding.py'],bridge_source_sha256:pins['luna-capture-v5/binding_bridge.py'],python_path:python,python_sha256:sha(read(python))};
 const meta={schema_version:7,contract:'prospective-output-capture-policy-v2',protocol_id:'fixture-protocol',run_id:'fixture',root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:sha('Synthetic task.'),
  observer_source_sha256:sha(read(path.join(here,'direct.mjs'))),installed_adapter_sha256:pins['stream_adapters.py'],installed_adapter_path:path.join(fair,'stream_adapters.py'),publication_channel_id:crypto.randomUUID(),binding,
  fixed_policy:{policy_path:path.join(root,'policy.json'),policy_sha256:sha(policyRaw),bridge_sha256:sha(read(path.join(here,'policy_bridge.py')))}};
 metaFault?.(meta,root);
 const raw=JSON.stringify(meta);write('metadata.json',raw);
 const original=structuredClone(fixture.body),changed=structuredClone(original);
 mutate?.(changed);
 write('requests.json',JSON.stringify({bodies:first?[changed]:[original,changed],mutateCaller}));
 const sentinel='{"reason":"existing stop sentinel"}\n';
 if(stop)write('luna-api-stop.json',sentinel);
 const held='{"event":"admit","id":"prior:1","run":"prior","call":1,"reserve":1}\n';
 if(hold)write('luna-api-ledger.jsonl',held);
 const acks=[];
 await childGate.run(()=>fork(path.join(here,'child.test-fixture.mjs'),[],{execArgv:[],cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{HOME:root,LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'fixture',LUNA_TASK_CALL_CAP:String(cap??45),LUNA_CAPTURE_METADATA:path.join(root,'metadata.json'),LUNA_CAPTURE_METADATA_SHA256:sha(raw)}}),{onMessage:m=>acks.push(m)});
 const ledger=path.join(root,'luna-api-ledger.jsonl');
 const rows=fs.existsSync(ledger)?read(ledger).toString().trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const result={root,rows,acks,...JSON.parse(read(path.join(root,'outcome.json')))};
 assert.equal(fs.existsSync(path.join(root,'luna-api-admission.lock')),false);
 if(stop)assert.equal(read(path.join(root,'luna-api-stop.json')).toString(),sentinel);
 if(hold)assert.ok(read(ledger).toString().startsWith(held));
 return result;
}
test('fixed policy accepts initial and continuation, immutable caller snapshot',async()=>{
 const r=await run({mutateCaller:true});assert.equal(r.calls,2);assert.deepEqual(r.errors,[null,null]);
 assert.deepEqual(r.rows.map(x=>x.event),['admit','settle','admit','settle']);
 assert.deepEqual(r.acks.map(x=>x.kind),['luna.capture.published.policy.v2','luna.capture.published.policy.v2']);
 assert.equal(r.forwarded[0].max_output_tokens,8192);
});
test('valid 900KB continuation passes bridge without base64-induced content rejection',async()=>{
 const r=await run({mutate:b=>b.input.push({role:'user',content:'x'.repeat(450000)},{role:'assistant',content:'y'.repeat(450000)})});
 assert.equal(r.calls,2);assert.deepEqual(r.errors,[null,null]);assert.equal(r.rows.length,4);
});
const mutations={summary:b=>b.reasoning.summary='none',include:b=>b.include=[],cap:b=>b.max_output_tokens=8191,
 unknown:b=>b.temperature=0,store:b=>b.store=true,stream:b=>b.stream=false};
for(const [name,mutate] of Object.entries(mutations))for(const first of [true,false]){
 test(`${name} mismatch rejected before ${first?'initial':'later'} admission/send`,async()=>{
  const r=await run({mutate,first});assert.equal(r.calls,first?0:1);
  assert.equal(r.errors.at(-1),'Fixed request policy refused');assert.equal(r.rows.length,first?0:2);
  assert.equal(r.acks.length,first?0:1);assert.equal(fs.existsSync(path.join(r.root,'luna-api-stop.json')),false);
 });
}
for(const [name,metaFault] of Object.entries({missing:m=>delete m.fixed_policy,wrongPin:m=>m.fixed_policy.policy_sha256='0'.repeat(64),
 missingFile:m=>m.fixed_policy.policy_path+='.absent',bridgePin:m=>m.fixed_policy.bridge_sha256='0'.repeat(64),
 policySymlink:(m,root)=>{fs.symlinkSync(m.fixed_policy.policy_path,path.join(root,'policy-link'));m.fixed_policy.policy_path=path.join(root,'policy-link');}})){
 test(`${name} metadata cannot admit or send`,async()=>{const r=await run({first:true,metaFault});assert.equal(r.calls,0);assert.equal(r.rows.length,0);assert.notEqual(r.errors[0],null);});
}
test('existing stop preserved byte-for-byte, no send',async()=>{const r=await run({stop:true});assert.equal(r.calls,0);assert.equal(r.rows.length,0);});
test('existing unknown reservation retained on refusal',async()=>{const r=await run({first:true,hold:true,mutate:mutations.cap});assert.equal(r.calls,0);assert.deepEqual(r.rows.map(x=>x.id),['prior:1']);});
test('original model mismatch still writes original stop classification',async()=>{const r=await run({first:true,mutate:b=>b.model='other'});assert.equal(r.calls,0);assert.equal(r.rows.length,0);assert.equal(JSON.parse(read(path.join(r.root,'luna-api-stop.json'))).reason,'unexpected_model_settings');});
test('original task cap still refuses later call with no extra reservation',async()=>{const r=await run({cap:1});assert.equal(r.calls,1);assert.equal(r.rows.length,2);assert.equal(JSON.parse(read(path.join(r.root,'luna-api-stop.json'))).reason,'task_call_cap');});
