// Inert reviewer tests. Imports only the pinned fixture-only cleanup helper;
// never imports Core, constructs a Session, opens a journal, or spawns a child.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('/private/tmp/light-clean-recovery-CDlDMw/source/node_modules/typescript/lib/typescript.js');
const base='/private/tmp/light-takeover/fair-confirmation/current-policy-probe-v1/';
const raw=readFileSync(base+'cleanup.ts','utf8');
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(sha(raw),'c207c95da42a861bf7dd250b97b677360648163530b42f819df9a7bdc56f1211');
assert.equal(sha(readFileSync(base+'probe.test.ts')),'075ed00c6e8ae18944f8b14da626b38a0238df0d8610f94c1eb6f11816377805');
const compiled=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {withFixtureCleanup}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const names=['unbind','unsubscribe','session.shutdown','unmount','store.close','seed.shutdown','kernel.close'];
const orders=[0,1,10,20,30,40,50];
async function exercise(failAt,primary) {
  const events=[],cleanupError=new Error('inert cleanup failure');let result,caught,threw=false;
  try { result=await withFixtureCleanup(async register=>{
    for(const i of [6,5,2,3,4,0,1])register(orders[i],async()=>{
      events.push(names[i]);if(names[i]===failAt)throw cleanupError;
    });
    if(primary.present)throw primary.value;
    return 19;
  }); } catch(error){threw=true;caught=error;}
  return {events,cleanupError,result,caught,threw};
}
test('all acquired operations run in dependency order and preserve successful result',async()=>{
  const value=await exercise(null,{present:false});
  assert.deepEqual(value.events,names);assert.equal(value.result,19);assert.equal(value.threw,false);
});
for(const failAt of names)test(`${failAt} failure does not skip any later operation`,async()=>{
  const primary=new Error('inert primary');const value=await exercise(failAt,{present:true,value:primary});
  assert.deepEqual(value.events,names);assert(value.caught instanceof AggregateError);
  assert.deepEqual(value.caught.errors,[primary,value.cleanupError]);
});
test('early setup failure cleans only resources already registered',async()=>{
  const events=[],primary={marker:'setup'};
  await assert.rejects(withFixtureCleanup(async register=>{
    register(50,()=>events.push('kernel'));register(40,()=>events.push('seed'));throw primary;
  }),error=>error===primary);
  assert.deepEqual(events,['seed','kernel']);
});
for(const value of [null,undefined])test(`primary ${String(value)} is not swallowed`,async()=>{
  const seen=await exercise(null,{present:true,value});
  assert.equal(seen.threw,true);assert.equal(seen.caught,value);assert.deepEqual(seen.events,names);
});
test('all cleanup errors are retained without a primary exception',async()=>{
  const events=[];
  await assert.rejects(withFixtureCleanup(async register=>{
    register(30,()=>{events.push(30);throw null;});
    register(10,async()=>{events.push(10);throw undefined;});
    return 'unused';
  }),error=>error instanceof AggregateError&&assert.deepEqual(error.errors,[undefined,null])===undefined);
  assert.deepEqual(events,[10,30]);
});
