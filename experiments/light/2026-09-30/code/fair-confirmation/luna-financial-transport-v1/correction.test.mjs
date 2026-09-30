// Real owner and temporary journals; synthetic Fetch only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFinancialTransport} from './transport.mjs';
import {createFinancialOwner} from '../luna-finance-owner-v1/owner.mjs';
import {financialPolicyId} from '../luna-finance-io-v1/journal.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const endpoint='https://api.openai.com/v1/responses';
const bytes=Buffer.from(JSON.stringify({model:'gpt-6-luna',stream:true,max_output_tokens:8192,input:'Synthetic task'}));
const event=v=>'data: '+JSON.stringify(v)+'\n\n';
const identity={id:'synthetic-correction',model:'gpt-6-luna'};
const raw=event({type:'response.created',response:{...identity,status:'in_progress'}})+event({type:'response.completed',response:{...identity,status:'completed',usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}}}});
const response=()=>new Response(raw,{headers:{'content-type':'text/event-stream'}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'luna-transport-correction-')));
 fs.chmodSync(root,0o700);
 const ledger=path.join(root,'luna-api-ledger.jsonl');fs.writeFileSync(ledger,'',{flag:'wx',mode:0o600});
 const r=fs.statSync(root,{bigint:true}),j=fs.statSync(ledger,{bigint:true});
 const owner=createFinancialOwner({runId:'correction',taskCallCap:3,root,capUsd:'0.1',policyId:financialPolicyId('0.1'),inventory:{rootDev:String(r.dev),rootIno:String(r.ino),journalDev:String(j.dev),journalIno:String(j.ino),prefixBytes:0,prefixSha256:sha('')}});
 return {owner,rows:()=>fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
function input(signal,extra={}){return {request:new Request(endpoint,{method:'POST',body:bytes,signal,...extra}),bodyBytes:bytes,requestSha256:sha(bytes),outputCap:8192,beforeAdmit:()=>undefined};}
function unknown(t){const rows=t.rows();assert.equal(rows.length,2);assert.equal(rows[1].usage_missing,true);assert.equal(rows[1].charge_nanos,rows[0].reserve_nanos);}
test('abort between Fetch resolution and reader acquisition cancels received body once',async()=>{
 const t=fixture(),controller=new AbortController();let cancels=0,calls=0,resolveFetch;
 const upstream=new Response(new ReadableStream({cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
 const pending=createFinancialTransport({owner:t.owner,nativeFetch:()=>{
  calls++;
  return new Promise(resolve=>{resolveFetch=resolve;});
 }}).send(input(controller.signal));
 const refused=assert.rejects(pending);
 for(let i=0;!resolveFetch&&i<100;i++)await tick();assert.equal(typeof resolveFetch,'function');
 resolveFetch(upstream);queueMicrotask(()=>controller.abort());
 await refused;await tick();unknown(t);assert.equal(calls,1);assert.equal(cancels,1);
});
test('explicit request metadata survives outgoing body reconstruction',async()=>{
 const t=fixture();let actual;
 const out=await createFinancialTransport({owner:t.owner,nativeFetch:req=>{actual=req;return response();}}).send(input(undefined,{referrer:'https://example.invalid/path',referrerPolicy:'no-referrer',credentials:'omit',cache:'no-store'}));
 await out.response.text();await out.accounting;
 assert.equal(actual.referrerPolicy,'no-referrer');assert.equal(actual.referrer,'https://example.invalid/path');assert.equal(actual.credentials,'omit');assert.equal(actual.cache,'no-store');assert.equal(actual.redirect,'manual');
});
test('original caller signal is retained across GC until pending Fetch ends',async()=>{
 assert.equal(typeof globalThis.gc,'function','run with --expose-gc');
 const t=fixture(),controller=new AbortController(),supplied=input(controller.signal);
 let resolveFetch,status='pending',output,cancels=0;
 const pending=createFinancialTransport({owner:t.owner,nativeFetch:()=>new Promise(resolve=>{resolveFetch=resolve;})}).send(supplied);
 const observed=pending.then(v=>{output=v;status='response';},()=>{status='refused';});
 for(let i=0;!resolveFetch&&i<100;i++)await tick();assert.equal(typeof resolveFetch,'function');
 for(let i=0;i<3;i++){await tick();globalThis.gc();}
 controller.abort();await tick();const atAbort=status;
 resolveFetch(new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(raw));},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}}));
 await observed;
 // Always drain/cancel a buggy synthetic return before asserting the failure.
 if(output)await output.response.body.cancel();
 await tick();assert.equal(supplied.request.signal.aborted,true);assert.equal(atAbort,'refused');unknown(t);assert.equal(cancels,1);
});
test('caller Request remains owned after send returns until active read terminates',async()=>{
 assert.equal(typeof globalThis.gc,'function');
 const t=fixture(),controller=new AbortController();let cancels=0;
 const upstream=new Response(new ReadableStream({cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
 let supplied=input(controller.signal);
 const weak=new WeakRef(supplied.request);
 const out=await createFinancialTransport({owner:t.owner,nativeFetch:()=>upstream}).send(supplied);
 supplied=null;
 const reader=out.response.body.getReader();let state='pending';
 const observed=reader.read().then(()=>{state='done';},()=>{state='refused';});
 for(let i=0;i<4;i++){await tick();globalThis.gc();}
 controller.abort();await tick();const atAbort={state,cancels,rows:t.rows().length,collected:weak.deref()===undefined};
 await reader.cancel().catch(()=>undefined);await observed;await out.accounting;
 assert.equal(atAbort.state,'refused');assert.equal(atAbort.cancels,1);assert.equal(atAbort.rows,2);unknown(t);
});
test('terminal cleanup never rereads the caller-owned Request signal property',async()=>{
 const t=fixture(),supplied=input();let getters=0,accounting='pending';
 const out=await createFinancialTransport({owner:t.owner,nativeFetch:()=>response()}).send(supplied);
 Object.defineProperty(supplied.request,'signal',{get(){getters++;throw new Error('synthetic getter');}});
 out.accounting.then(()=>{accounting='settled';},()=>{accounting='refused';});
 const reader=out.response.body.getReader();assert.equal((await reader.read()).done,false);
 let state='pending';const pending=reader.read().then(()=>{state='done';},()=>{state='refused';});
 await tick();await tick();const observed={getters,accounting,state,rows:t.rows().length};
 await reader.cancel().catch(()=>undefined);await pending;
 assert.deepEqual(observed,{getters:0,accounting:'settled',state:'done',rows:2});
});
