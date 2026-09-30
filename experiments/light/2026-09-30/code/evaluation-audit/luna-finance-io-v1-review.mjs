import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFinancialJournal, financialPolicyId} from '../fair-confirmation/luna-finance-io-v1/journal.mjs';
import {PRICE_ID, TERMINAL_PROOF} from '../fair-confirmation/luna-finance-v1/accounting.mjs';

const source = fs.readFileSync(new URL('../fair-confirmation/luna-finance-io-v1/journal.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(source), '804f5312aee4779a8651816282066a2cc4a17d5e0d2ddbcd6c5b86748e53a824');
const policy = financialPolicyId('0.015');
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const admit = (run = 'review') => ({event:'admit', id:`${run}:1`, run, call:1, reserve:0.01,
  financial_schema:1, financial_policy_id:policy, price_id:PRICE_ID, reserve_nanos:'10000000'});
const settle = () => ({event:'settle', id:'review:1', run:'review', call:1,
  financial_schema:1, financial_policy_id:policy, price_id:PRICE_ID, charge_nanos:'19100', settlement_proof:TERMINAL_PROOF,
  usage_missing:false, usage:{input_tokens:100, output_tokens:20, total_tokens:120, input_tokens_details:{cached_tokens:10}},
  input_tokens:100, output_tokens:20, cached_tokens:10, uncached_tokens:90,
  cost_usd:0.0000191, budget_charge_usd:0.0000191, error:null});
function legacy(row) {
  const result = {...row};
  for (const key of ['financial_schema','financial_policy_id','price_id','reserve_nanos','charge_nanos','settlement_proof']) delete result[key];
  return result;
}
function setup(initial = Buffer.alloc(0)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-io-review-')));
  const ledger = path.join(root,'luna-api-ledger.jsonl'), stop = path.join(root,'luna-api-stop.json'), lock = path.join(root,'luna-api-admission.lock');
  fs.writeFileSync(ledger,initial,{flag:'wx',mode:0o600});
  const r=fs.statSync(root,{bigint:true}),j=fs.statSync(ledger,{bigint:true});
  const options={root,inventory:{rootDev:String(r.dev),rootIno:String(r.ino),journalDev:String(j.dev),journalIno:String(j.ino),
    prefixBytes:initial.length,prefixSha256:hash(initial)},capUsd:'0.015',policyId:policy};
  return {root,ledger,stop,lock,client:adapter=>createFinancialJournal({...options,...(adapter?{fs:adapter}:{})})};
}
function adapter(t,hooks={}) {
  const names=new Map();
  return new Proxy(fs,{get(target,key){
    if(key==='openSync')return(...args)=>{
      if(hooks.openSync)return hooks.openSync(args,names);
      const fd=fs.openSync(...args);names.set(fd,args[0]===t.ledger?'journal':args[0]===t.stop?'stop':args[0]===t.lock?'lock':args[0]===t.root?'root':'owner');return fd;
    };
    if(hooks[key])return(...args)=>hooks[key](names.get(args[0]),args,names);
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
}
const refused=(fn,code)=>assert.throws(fn,error=>error.message==='Financial journal refused'&&error.code===code);

test('legacy unsettled and unproven settled reservations still consume cap across clients',()=>{
  for(const initial of [encode(legacy(admit())),Buffer.concat([encode(legacy(admit())),encode(legacy(settle()))])]){
    const t=setup(initial),client=t.client();
    refused(()=>client.commit(encode(admit('new'))),'OWNED_BARRIER_RETAINED');
    assert.deepEqual(fs.readFileSync(t.ledger),initial);assert.equal(client.isPoisoned(),true);
  }
});

test('malformed, duplicate and orphaned historical rows cannot be deduplicated or treated as empty',()=>{
  for(const initial of [Buffer.concat([encode(admit()),encode(admit())]),encode(settle()),Buffer.from('{"event":"admit"}\n'),
    Buffer.from('{"event":"admit"'),Buffer.from('{"event":"admit","event":"settle"}\n')]){
    const t=setup(initial),client=t.client();refused(()=>client.commit(encode(admit('new'))),'OWNED_BARRIER_RETAINED');
    assert.deepEqual(fs.readFileSync(t.ledger),initial);assert.equal(fs.existsSync(t.lock),true);
  }
});

test('regular journal hard links refuse before append; neither alias is modified',()=>{
  const t=setup(),alias=path.join(t.root,'journal-alias');fs.linkSync(t.ledger,alias);
  refused(()=>t.client().commit(encode(admit())),'OWNED_BARRIER_RETAINED');
  assert.equal(fs.statSync(alias).size,0);assert.equal(fs.statSync(t.ledger).size,0);
});

test('a symlink named as the stop is treated as a stop, not followed or overwritten',()=>{
  const t=setup(),target=path.join(t.root,'test-owned-stop-target');fs.writeFileSync(target,'retained',{flag:'wx'});fs.symlinkSync(target,t.stop);
  refused(()=>t.client().commit(encode(admit())),'STOPPED');
  assert.equal(fs.readFileSync(target,'utf8'),'retained');assert.equal(fs.existsSync(t.lock),false);
});

test('short descriptor reads loop to the full pinned history without dropping exposure',()=>{
  const initial=encode(admit()),t=setup(initial);
  const a=adapter(t,{readSync:(_kind,[fd,buf,offset,length,position])=>fs.readSync(fd,buf,offset,Math.min(length,7),position)});
  assert.equal(t.client(a).commit(encode(settle())).exposureNanodollars,'19100');
  assert.deepEqual(fs.readFileSync(t.ledger),Buffer.concat([initial,encode(settle())]));
});

test('unexpected zero read retains the owned barrier and original journal',()=>{
  const initial=encode(admit()),t=setup(initial);
  const a=adapter(t,{readSync:(kind,args)=>kind==='journal'?0:fs.readSync(...args)});
  refused(()=>t.client(a).commit(encode(settle())),'OWNED_BARRIER_RETAINED');
  assert.deepEqual(fs.readFileSync(t.ledger),initial);
});

test('a changed owner token cannot be used for ordinary unlock',()=>{
  const t=setup();let changed=false;
  const a=adapter(t,{fsyncSync:(kind,args)=>{
    fs.fsyncSync(...args);
    if(kind==='journal'&&!changed){changed=true;fs.writeFileSync(path.join(t.lock,'owner'),'another-token');}
  }});
  refused(()=>t.client(a).commit(encode(admit())),'OWNED_BARRIER_RETAINED');
  assert.equal(fs.readFileSync(path.join(t.lock,'owner'),'utf8'),'another-token');
  assert.deepEqual(fs.readFileSync(t.ledger),encode(admit()));
});

test('close-after-effect uncertainty never closes a foreign descriptor reusing that number',()=>{
  const t=setup(),foreign=path.join(t.root,'foreign-test-owned');let held,first=true;
  const a=adapter(t,{closeSync:(kind,[fd])=>{
    fs.closeSync(fd);
    if(kind==='journal'&&first){first=false;held=fs.openSync(foreign,'wx',0o600);assert.equal(held,fd);throw new Error('synthetic close ambiguity');}
  }});
  try{
    refused(()=>t.client(a).commit(encode(admit())),'OWNED_BARRIER_RETAINED');
    assert.equal(typeof held,'number');assert.equal(fs.fstatSync(held).isFile(),true);
  }finally{if(held!==undefined)fs.closeSync(held);}
});

test('post-removal plus stop-open double fault is explicitly uncertain, never fictitiously retained',()=>{
  const t=setup();let removed=false;
  const a=adapter(t,{
    rmdirSync:(_kind,args)=>{fs.rmdirSync(...args);removed=true;throw new Error('synthetic after-removal fault');},
    openSync:(args,names)=>{
      if(removed&&args[0]===t.stop)throw new Error('synthetic stop-open failure');
      const fd=fs.openSync(...args);names.set(fd,args[0]===t.ledger?'journal':args[0]===t.stop?'stop':args[0]===t.lock?'lock':args[0]===t.root?'root':'owner');return fd;
    }
  });
  const client=t.client(a);refused(()=>client.commit(encode(admit())),'UNLOCK_UNCERTAIN');
  assert.equal(client.isPoisoned(),true);assert.equal(fs.existsSync(t.lock),false);assert.equal(fs.existsSync(t.stop),false);
  assert.deepEqual(fs.readFileSync(t.ledger),encode(admit()));
  refused(()=>client.commit(encode(admit('again'))),'POISONED');
});
