// UNEXECUTED DRAFT. Root review/authorization required before execution.
// Only fresh synthetic files and bounded local Python preparation/scoring.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PYTHON='/usr/bin/python3';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const selected={
  'finalize.mjs':'f08c8cd77f3624a5ed6af96d2695c400d7fabbd5fd4bf8becad39662048df2aa',
  'score_gate.py':'a73cd7ef4ccc7b036139ab819a164d8a43c428fe725daee588592ad40ba8993b',
  'integration_fixture.py':'22ee4424cd5951cb159c2925e9c5b3eb261a798921c4a558c9e9682281a5cb8a',
};
for(const [name,pin]of Object.entries(selected))assert.equal(sha(fs.readFileSync(path.join(HERE,name))),pin);
const {finalizeAttempt}=await import('./finalize.mjs');
const identify=filename=>{const st=fs.lstatSync(filename,{bigint:true});return {dev:String(st.dev),ino:String(st.ino)};};
let sequenceBlocked=false;
function python(mode,directory,client,payload){
  assert.equal(sequenceBlocked,false,'no later child after an unconfirmed or failed fixture operation');
  const args=['-I','-B',path.join(HERE,'integration_fixture.py'),mode,directory];if(client)args.push(client);
  const result=spawnSync(PYTHON,args,{encoding:'utf8',cwd:HERE,
    env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},input:payload?JSON.stringify(payload):'',
    timeout:15000,killSignal:'SIGKILL',maxBuffer:1024*1024,windowsHide:true});
  if(result.error!==undefined||result.signal!==null||result.status!==0)sequenceBlocked=true;
  assert.equal(result.error,undefined,'owned synchronous Python operation must finish without spawn/timeout/output error');
  assert.equal(result.signal,null,'no fixture timeout/kill may count as success');
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  return JSON.parse(result.stdout);
}
function closedSyntheticChild(pid,ipc){return {pid,spawned:true,exit_observed:true,closed:true,
  ipc_disconnected:ipc,exit_code:0,exit_signal:null,close_code:0,close_signal:null,invalid:false,error:false,
  timed_out:false,kill_attempted:false,kill_failed:false};}
function prepare(t,client){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shared-parent-cross-language-')));
  t.diagnostic(JSON.stringify({retained_synthetic_root:directory,client}));
  const prepared=python('prepare',directory,client);assert.deepEqual(prepared,{prepared:true,client,admitted_calls:2});
  assert.equal(fs.existsSync(path.join(directory,'parent-attempt-v1.json')),false,'preparation never creates authority');
  const selection=JSON.parse(fs.readFileSync(path.join(directory,'selection.json'),'utf8'));
  assert.equal(selection.expected.parent_source_sha256,sha(fs.readFileSync(fileURLToPath(import.meta.url))));
  const lifecycle={schema_version:1,client,owner:closedSyntheticChild(1234,true),
    task:client==='light'?closedSyntheticChild(1235,null):null,
    daemon_identity_sha256:selection.expected.daemon_identity_sha256,shutdown_acknowledged:client==='light'?true:null,
    pending_operations:false,journal_quiescent:true,sticky_invalid:false};
  // Lifecycle assertions are deliberately synthetic unit facts, not observations
  // of Pi, Light, a daemon or the short-lived Python preparation process.
  const ledgerPath=path.join(directory,'synthetic-ledger.jsonl'),ledgerBefore=fs.readFileSync(ledgerPath);
  const directoryIdentity=identify(directory);
  return {directory,selection,ledgerPath,ledgerBefore,args:{directory,directoryIdentity,ledgerPath,
    ledgerIdentity:identify(ledgerPath),expected:selection.expected,acknowledgments:selection.acknowledgments,
    outcome:selection.outcome,observeLifecycle:()=>lifecycle}};
}
function finishAndScore(f){
  const committed=finalizeAttempt(f.args);
  // Pass the ACTUAL successful return directly. Do not reconstruct a capability
  // by hashing the surviving file or substituting the attempt-only digest.
  const result=python('score',f.directory,null,{trusted_clean_commit_sha256:committed.cleanCommitSha256,
    expected:f.args.expected,outcome:f.args.outcome,directory_identity:f.args.directoryIdentity});
  assert.deepEqual(fs.readFileSync(f.ledgerPath),f.ledgerBefore,'finalization/scoring cannot mutate the financial fixture');
  return {committed,inventory:JSON.parse(committed.inventoryBytes),result};
}
for(const client of ['light','pi'])test(`actual Node return to Python scorer: ${client} two-call synthetic attempt`,t=>{
  const f=prepare(t,client),{committed,inventory,result}=finishAndScore(f);
  assert.match(committed.cleanCommitSha256,/^[a-f0-9]{64}$/);
  assert.equal(inventory.accounting.admittedCalls,2);assert.equal(inventory.accounting.chargeTotalNanodollars,'40000');
  assert.equal(inventory.terminal_accounting_complete,true);assert.equal(inventory.artifacts.length,2);
  assert.equal(result.parent_publication_verified,true);assert.equal(result.capture_verified,true);
  assert.equal(result.binding_verified,true);assert.equal(result.client,client);
  assert.equal(result.visible_plan_format_pass,true);assert.equal(result.code_completion,true);
  assert.equal(result.requested_format_contract_pass,true);assert.equal(result.plan_semantic_quality,null);
});
test('actual failed-attempt return cannot create capture authority; both charges remain',t=>{
  const f=prepare(t,'pi');f.args.acknowledgments.pop();
  const {committed,inventory,result}=finishAndScore(f);
  assert.equal(committed.cleanCommitSha256,null);assert.match(committed.attemptCommitSha256,/^[a-f0-9]{64}$/);
  assert.equal(inventory.accounting.admittedCalls,2);assert.equal(inventory.accounting.chargeTotalNanodollars,'40000');
  assert.equal(result.parent_publication_verified,false);assert.equal(result.capture_verified,false);
  assert.equal(result.code_completion,true);assert.equal(result.visible_plan_format_pass,null);
});
test('later capture changed after actual commit cannot borrow unchanged first capture',t=>{
  const f=prepare(t,'light'),committed=finalizeAttempt(f.args);assert.match(committed.cleanCommitSha256,/^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(f.directory,'capture-response-002.sse'),' ');
  const result=python('score',f.directory,null,{trusted_clean_commit_sha256:committed.cleanCommitSha256,
    expected:f.args.expected,outcome:f.args.outcome,directory_identity:f.args.directoryIdentity});
  assert.equal(result.parent_publication_verified,false);assert.equal(result.capture_verified,false);
  assert.equal(result.code_completion,true);assert.equal(result.visible_plan_format_pass,null);
  assert.deepEqual(fs.readFileSync(f.ledgerPath),f.ledgerBefore);
});
