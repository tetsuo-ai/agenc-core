import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const parent = path.dirname(here);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalFetch = globalThis.fetch;
const folders = [];
const envNames = ['LUNA_LEDGER_ROOT','LUNA_RUN_DIR','LUNA_RUN_ID','LUNA_TASK_CALL_CAP',
  'LUNA_ALLOW_ADAPTIVE','LUNA_ADAPTIVE_HIGH','LUNA_CAPTURE_METADATA','LUNA_CAPTURE_METADATA_SHA256'];
const env = new Map(envNames.map(key => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of env) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const folder of folders.splice(0)) fs.rmSync(folder, {recursive:true});
});
const PROMPT = 'Synthetic task only.';
const USAGE = {input_tokens:1000,output_tokens:50,input_tokens_details:{cached_tokens:900}};
const EVENT = Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{usage:USAGE}})+'\n\n');
const read = (root, name) => fs.readFileSync(path.join(root,name));
const json = (root, name) => JSON.parse(read(root,name));
const records = root => read(root,'luna-api-ledger.jsonl').toString().trim().split('\n').map(JSON.parse);
const receipt = (root, n='001') => json(root,`capture-receipt-${n}.json`);
async function setup(fake, options={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'luna-capture-v2-')); folders.push(root);
  const meta = {schema_version:2,contract:'prospective-output-capture-v2',protocol_id:'synthetic-fair-v2',
    run_id:'test',root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:sha(PROMPT),
    observer_source_sha256:sha(fs.readFileSync(path.join(here,'direct.mjs'))),
    installed_adapter_sha256:sha(fs.readFileSync(path.join(parent,'stream_adapters.py'))),
    installed_adapter_path:path.join(parent,'stream_adapters.py'),...options.meta};
  const raw = JSON.stringify(meta);
  fs.writeFileSync(path.join(root,'runner-metadata.json'),raw,{mode:0o600});
  for (const key of envNames) delete process.env[key];
  Object.assign(process.env,{LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'test',
    LUNA_TASK_CALL_CAP:String(options.cap ?? 45),LUNA_CAPTURE_METADATA:path.join(root,'runner-metadata.json'),
    LUNA_CAPTURE_METADATA_SHA256:sha(raw)});
  if (options.adaptive) process.env.LUNA_ALLOW_ADAPTIVE='1';
  if (options.high) process.env.LUNA_ADAPTIVE_HIGH='1';
  globalThis.fetch = fake;
  await import(`./direct.mjs?fixture=${root}`);
  return root;
}
const body = (extra={}) => ({model:'gpt-6-luna',reasoning:{effort:'low',summary:'auto'},max_output_tokens:8192,
  stream:true,input:[{role:'user',content:[{type:'input_text',text:PROMPT}]}],...extra});
const request = (extra={}) => fetch('https://api.openai.com/v1/responses',{
  method:'POST',headers:{Authorization:'Bearer synthetic-never-real'},body:JSON.stringify(body(extra))});
const streamResponse = (bytes=EVENT) => new Response(bytes,{headers:{'content-type':'text/event-stream; charset=utf-8'}});
function assertSettled(root, error=null) {
  const rows = records(root); assert.deepEqual(rows.map(row=>row.event),['admit','settle']);
  assert.deepEqual(rows[1].error,error); return rows[1];
}

test('clean EOF receipt binds exact request/output/prompt/run/pins; headers never recorded',async()=>{
  let calls=0;
  const root=await setup(async()=>{calls++;return streamResponse();});
  assert.deepEqual(Buffer.from(await (await request()).arrayBuffer()),EVENT);
  const r=receipt(root);
  assert.equal(calls,1); assert.equal(r.transport_outcome,'eof');
  assert.equal(r.capture_write_complete,true); assert.equal(r.downstream_delivery_failed,false);
  assert.equal(r.response_byte_count,EVENT.length); assert.equal(r.response_bytes_sha256,sha(EVENT));
  assert.deepEqual(read(root,'capture-response-001.sse'),EVENT);
  assert.equal(r.request_body_sha256,sha(read(root,'capture-request-001.json')));
  assert.equal(r.task_prompt_sha256,sha(PROMPT)); assert.equal(r.call_ordinal,1);
  assert.equal(r.request_role,'root'); assert.equal(r.prior_root_generations,0);
  assert.equal(r.admission_id,'test:1'); assert.equal(r.initial_request,true);
  assert.equal(r.observer_source_sha256,sha(fs.readFileSync(path.join(here,'direct.mjs'))));
  for (const name of fs.readdirSync(root)) {
    if (fs.statSync(path.join(root,name)).isFile()) assert(!read(root,name).includes('synthetic-never-real'));
  }
  assert.equal(assertSettled(root).cost_usd,(900*.01+100*.1+50*.5)/1e6);
});

test('existing runner without new metadata cannot send or admit',async()=>{
  let calls=0; const root=await setup(async()=>{calls++;return streamResponse();});
  delete process.env.LUNA_CAPTURE_METADATA;
  await assert.rejects(request(),/capture metadata/);
  assert.equal(calls,0);assert(!fs.existsSync(path.join(root,'luna-api-ledger.jsonl')));
});
test('metadata digest, run, observer, contract, adapter bytes and unknown fields fail before admission',async()=>{
  for (const bad of [{run_id:'other'},{schema_version:1},{contract:'old'},
    {observer_source_sha256:'a'.repeat(64)},{installed_adapter_sha256:'a'.repeat(64)},
    {installed_adapter_path:path.join(here,'direct.mjs')},{unexpected:true}]) {
    let calls=0;const root=await setup(async()=>{calls++;return streamResponse();},{meta:bad});
    await assert.rejects(request(),/capture metadata/);assert.equal(calls,0);
    assert(!fs.existsSync(path.join(root,'luna-api-ledger.jsonl')));
  }
  const root=await setup(async()=>{throw new Error('must not send');});
  fs.appendFileSync(path.join(root,'runner-metadata.json'),' ');
  await assert.rejects(request(),/capture metadata/);
});
test('nofollow metadata rejects symlink even with matching bytes',async()=>{
  const root=await setup(async()=>{throw new Error('must not send');});
  fs.symlinkSync('runner-metadata.json',path.join(root,'metadata-alias.json'));
  process.env.LUNA_CAPTURE_METADATA=path.join(root,'metadata-alias.json');
  await assert.rejects(request(),/capture metadata/);
});
test('call one requires exact unique root prompt and no prior assistant/tool history',async()=>{
  for (const extra of [{input:'Synthetic task only.'},{input:[{role:'user',content:'different'}]},
    {input:[{role:'assistant',content:'prior'},{role:'user',content:PROMPT}]},
    {input:[{role:'user',content:PROMPT},{role:'user',content:PROMPT}]},
    {previous_response_id:'prior'},{conversation:'prior'}]) {
    let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
    await assert.rejects(request(extra),/capture metadata/);assert.equal(calls,0);
    assert(!fs.existsSync(path.join(root,'luna-api-ledger.jsonl')));
    assert(!fs.existsSync(path.join(root,'luna-api-admission.lock')));
  }
});
test('later success explicitly remains continuation and cannot masquerade as initial',async()=>{
  const root=await setup(async()=>streamResponse());
  await(await request()).text();await(await request({input:[{type:'function_call_output',call_id:'old',output:'ok'}]})).text();
  const r=receipt(root,'002');assert.equal(r.call_ordinal,2);assert.equal(r.initial_request,false);
  assert.equal(r.prior_root_generations,1);assert.equal(r.request_role,'continuation');
  assert.equal(records(root).length,4);
});
test('nonstream and HTTP errors retain financial semantics but never claim SSE EOF',async()=>{
  let root=await setup(async()=>Response.json({usage:USAGE}));
  await request({stream:false});assert.equal(receipt(root).transport_outcome,'nonstream');assertSettled(root);
  let calls=0;root=await setup(async()=>{calls++;return new Response(Buffer.from([255,0,12]),{status:503});});
  await request();assert.equal(receipt(root).transport_outcome,'http_error');
  assert.deepEqual(read(root,'capture-response-001.sse'),Buffer.from([255,0,12]));
  assert.equal(assertSettled(root,{status:503}).usage_missing,true);
  await assert.rejects(request(),/stopped/);assert.equal(calls,1);
});
test('billing and fetch errors stop and retain missing-usage reservations without retry',async()=>{
  let calls=0;let root=await setup(async()=>{calls++;return Response.json({error:{code:'insufficient_quota'}},{status:429});});
  await request();assert.equal(json(root,'luna-api-stop.json').reason,'billing_error');
  assert.equal(assertSettled(root,{status:429}).budget_charge_usd,records(root)[0].reserve);assert.equal(calls,1);
  calls=0;root=await setup(async()=>{calls++;throw new Error('secret transport details');});
  await assert.rejects(request(),/Direct Luna request failed/);
  assert.equal(receipt(root).transport_outcome,'fetch_error');assert.equal(calls,1);
  assertSettled(root,{type:'fetch_error'});
});
test('stream read failure is not EOF; complete prior usage still settles once',async()=>{
  let pulls=0,calls=0;
  const root=await setup(async()=>{calls++;return new Response(new ReadableStream({pull(c){
    if(pulls++===0)c.enqueue(EVENT);else c.error(new Error('synthetic read failure'));
  }}),{headers:{'content-type':'text/event-stream'}});});
  await assert.rejects((await request()).text(),/Luna stream failed/);
  assert.equal(receipt(root).transport_outcome,'read_error');assert.equal(calls,1);
  assert.equal(assertSettled(root,{type:'stream_error'}).usage_missing,false);
});
test('cancel is distinct from EOF and settles before upstream cancellation throws',async()=>{
  const root=await setup(async()=>new Response(new ReadableStream({pull(){},cancel(){throw new Error('cancel failed');}})));
  const response=await request();await assert.rejects(response.body.cancel(),/cancel failed/);
  const r=receipt(root);assert.equal(r.transport_outcome,'cancelled');assert.equal(r.downstream_delivery_failed,true);
  assertSettled(root,{type:'cancelled'});
});
test('delivery enqueue failure gets explicit delivery receipt and existing stream-error settlement',async()=>{
  const root=await setup(async()=>streamResponse());
  const prototype=ReadableStreamDefaultController.prototype,enqueue=prototype.enqueue;
  const response=await request();
  prototype.enqueue=function(){throw new Error('delivery failure');};
  try {await assert.rejects(response.text(),/Luna stream failed/);}finally{prototype.enqueue=enqueue;}
  assert.equal(receipt(root).transport_outcome,'delivery_error');
  assert.equal(receipt(root).downstream_delivery_failed,true);assertSettled(root,{type:'stream_error'});
});
test('optional request/response/receipt open failures never prevent settlement, delivery or cause retry',async()=>{
  for(const filename of ['capture-request-001.json','capture-response-001.sse','capture-receipt-001.json.pending']){
    let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
    fs.mkdirSync(path.join(root,filename));
    assert.deepEqual(Buffer.from(await(await request()).arrayBuffer()),EVENT);assertSettled(root);assert.equal(calls,1);
    if(filename.includes('receipt'))assert(!fs.existsSync(path.join(root,'capture-receipt-001.json')));
    else assert.equal(receipt(root).capture_write_complete,false);
    assert(!fs.existsSync(path.join(root,'luna-api-stop.json')));
  }
});
test('optional capture short writes loop; zero write records failure without affecting settlement',async()=>{
  for(const zero of [false,true]){
    const root=await setup(async()=>streamResponse());
    const open=fs.openSync,write=fs.writeSync;const names=new Map();
    fs.openSync=(name,...args)=>{const fd=open(name,...args);names.set(fd,String(name));return fd;};
    fs.writeSync=(fd,buffer,offset,length,...args)=>names.get(fd)?.endsWith('capture-response-001.sse')
      ?zero?0:write(fd,buffer,offset,Math.min(length,7),...args):write(fd,buffer,offset,length,...args);
    try{await(await request()).text();}finally{fs.openSync=open;fs.writeSync=write;}
    assertSettled(root);assert.equal(receipt(root).capture_write_complete,!zero);
    if(!zero)assert.deepEqual(read(root,'capture-response-001.sse'),EVENT);
  }
});
test('receipt final-directory fsync failure withdraws publication but never replays or alters settlement',async()=>{
  let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
  const sync=fs.fsyncSync,link=fs.linkSync;let published=false,failed=false;
  fs.linkSync=(...args)=>{const value=link(...args);published=true;return value;};
  fs.fsyncSync=fd=>{
    if(published&&!failed&&fs.fstatSync(fd).isDirectory()){failed=true;throw new Error('publication directory sync fault');}
    return sync(fd);
  };
  try{await(await request()).text();}finally{fs.fsyncSync=sync;fs.linkSync=link;}
  assert.equal(failed,true);assert.equal(calls,1);assertSettled(root);
  assert(!fs.existsSync(path.join(root,'capture-receipt-001.json')));
});
test('cancel while a read is pending cannot subsequently publish EOF or settle twice',async()=>{
  let resolveRead;
  const root=await setup(async()=>new Response(new ReadableStream({pull(){return new Promise(resolve=>{resolveRead=resolve;});}})));
  const response=await request();await response.body.cancel();resolveRead?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(receipt(root).transport_outcome,'cancelled');assertSettled(root,{type:'cancelled'});
});
test('byte-split UTF8 is retained exactly rather than decoded and re-encoded',async()=>{
  const bytes=Buffer.from('data: {"delta":"λ😀"}\r\n\r\n');let offset=0;
  const root=await setup(async()=>new Response(new ReadableStream({pull(c){
    if(offset<bytes.length)c.enqueue(bytes.subarray(offset,++offset));else c.close();
  }}),{headers:{'content-type':'text/event-stream'}}));
  await(await request()).text();assert.deepEqual(read(root,'capture-response-001.sse'),bytes);
  assert.equal(receipt(root).response_bytes_sha256,sha(bytes));assertSettled(root);
});
test('capture fsync and receipt publication faults do not skip or alter settlement',async()=>{
  for(const fault of ['response-sync','receipt-sync','publish']){
    let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
    const open=fs.openSync,sync=fs.fsyncSync,link=fs.linkSync;const names=new Map();
    fs.openSync=(name,...args)=>{const fd=open(name,...args);names.set(fd,String(name));return fd;};
    fs.fsyncSync=fd=>{
      const name=names.get(fd)||'';
      if(fault==='response-sync'&&name.endsWith('capture-response-001.sse')||fault==='receipt-sync'&&name.endsWith('.json.pending'))throw new Error('synthetic optional fsync fault');
      return sync(fd);
    };
    if(fault==='publish')fs.linkSync=()=>{throw new Error('synthetic publication fault');};
    try{await(await request()).text();}finally{fs.openSync=open;fs.fsyncSync=sync;fs.linkSync=link;}
    assertSettled(root);assert.equal(calls,1);
    if(fault==='response-sync')assert.equal(receipt(root).capture_write_complete,false);
    else assert(!fs.existsSync(path.join(root,'capture-receipt-001.json')));
  }
});
test('existing receipt is not overwritten and still cannot change settlement',async()=>{
  const root=await setup(async()=>streamResponse());
  fs.writeFileSync(path.join(root,'capture-receipt-001.json'),'preexisting');
  await(await request()).text();assertSettled(root);
  assert.equal(read(root,'capture-receipt-001.json').toString(),'preexisting');
});
test('fixed-low failure remains zero-fetch zero-admission durable sanitized stop',async()=>{
  let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
  await assert.rejects(request({reasoning:{effort:'medium'},input:'secret marker'}),/settings/);
  assert.equal(calls,0);assert(!fs.existsSync(path.join(root,'luna-api-ledger.jsonl')));
  const stop=json(root,'luna-api-stop.json');assert.equal(stop.reason,'unexpected_model_settings');
  assert.deepEqual(stop.settings,{model_matches:true,reasoning_effort:'medium',output_cap:8192,output_cap_type:'number'});
  assert(!read(root,'luna-api-stop.json').includes('secret marker'));
});
test('original financial settlement write failure is not hidden or converted to a successful capture',async()=>{
  let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
  const write=fs.writeFileSync;
  fs.writeFileSync=(name,...args)=>{
    if(String(name).endsWith('usage-001.json'))throw new Error('financial write failure');
    return write(name,...args);
  };
  try{await assert.rejects((await request()).text(),/Luna stream failed/);}finally{fs.writeFileSync=write;}
  assert.equal(calls,1);assert.deepEqual(records(root).map(row=>row.event),['admit']);
  assert.equal(json(root,'luna-api-stop.json').reason,'stream_error');
  assert.equal(receipt(root).transport_outcome,'read_error');
});
test('failed stop fsync still rejects before fetch/admission with no optional capture work',async()=>{
  let calls=0;const root=await setup(async()=>{calls++;return streamResponse();});
  const sync=fs.fsyncSync;fs.fsyncSync=()=>{throw new Error('stop sync failed');};
  try{await assert.rejects(request({reasoning:{effort:'medium'}}),/stop sync failed/);}finally{fs.fsyncSync=sync;}
  assert.equal(calls,0);assert(!fs.existsSync(path.join(root,'luna-api-ledger.jsonl')));
  assert(!fs.readdirSync(root).some(name=>name.startsWith('capture-')));
});
test('adaptive flags and actual task call cap retain baseline behavior',async()=>{
  let root=await setup(async()=>streamResponse(),{adaptive:true});
  await(await request({reasoning:{effort:'medium'}})).text();assertSettled(root);
  await assert.rejects(request({reasoning:{effort:'high'}}),/settings/);
  root=await setup(async()=>streamResponse(),{adaptive:true,high:true});
  await(await request({reasoning:{effort:'high'}})).text();assertSettled(root);
  let calls=0;root=await setup(async()=>{calls++;return streamResponse();},{cap:1});
  await(await request()).text();const prior=read(root,'luna-api-ledger.jsonl');
  await assert.rejects(request(),/per-task call limit/);assert.equal(calls,1);
  assert.deepEqual(read(root,'luna-api-ledger.jsonl'),prior);assert(!fs.existsSync(path.join(root,'wire-002.json')));
});
test('historical holds remain byte-identical prefix; no invented monetary/cumulative call cap',async()=>{
  const root=await setup(async()=>streamResponse());
  const prior=Array.from({length:650},(_,n)=>JSON.stringify({event:'admit',id:`old:${n}`,run:'old',call:n,reserve:100})).join('\n')+'\n';
  fs.writeFileSync(path.join(root,'luna-api-ledger.jsonl'),prior);
  await(await request()).text();assert(read(root,'luna-api-ledger.jsonl').toString().startsWith(prior));
  assert.equal(records(root).length,652);
});
test('admission lock conflict and existing stop still prohibit sends',async()=>{
  let calls=0;let root=await setup(async()=>{calls++;return streamResponse();});
  fs.mkdirSync(path.join(root,'luna-api-admission.lock'));await assert.rejects(request(),/EEXIST/);
  assert.equal(calls,0);assert(fs.existsSync(path.join(root,'luna-api-admission.lock')));
  root=await setup(async()=>{calls++;return streamResponse();});fs.writeFileSync(path.join(root,'luna-api-stop.json'),'{}');
  await assert.rejects(request(),/stopped/);assert.equal(calls,0);
});
test('official-origin and generation endpoint guards remain',async()=>{
  let calls=0;await setup(async()=>{calls++;return Response.json({data:[]});});
  await assert.rejects(fetch('https://example.invalid/v1/responses'),/official API/);
  await assert.rejects(fetch('https://api.openai.com/v1/chat/completions'),/Responses generation/);
  await fetch('https://api.openai.com/v1/models');assert.equal(calls,1);
});

test('produced receipts feed unmodified fair_cells: valid output passes; EOF without provider completion stays unknown',async()=>{
  const make=spawnSync('python3',['-c',
    "from test_stream_adapters import *; import sys; sys.stdout.buffer.write(sse(responses([message('m',0)]),numbered=True))"],
    {cwd:parent,encoding:null,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(make.status,0);
  for(const complete of [true,false]){
    const bytes=complete?make.stdout:EVENT;
    const root=await setup(async()=>streamResponse(bytes));await(await request()).text();
    const graded=spawnSync('python3',[path.join(here,'score_fixture.py'),root],{encoding:'utf8'});
    assert.equal(graded.status,0,graded.stderr);const score=JSON.parse(graded.stdout);
    assert.equal(score.capture_verified,true);assert.equal(score.code_completion,true);
    assert.equal(score.visible_plan_format_pass,complete?true:null);
    assert(!graded.stdout.includes('- [ ]'));assert(!graded.stdout.includes(PROMPT));
  }
});
