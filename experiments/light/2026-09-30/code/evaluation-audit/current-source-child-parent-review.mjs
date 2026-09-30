import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const path='/private/tmp/light-takeover/fair-confirmation/current-source-child-v1/parent.mjs';
const original=readFileSync(path,'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'2f3161e67c809e986b8db4b394b1fe9c2cf9233cff7c7d71587cdd55e93b8faf');
// Exact parent body; replace only external acquisition/clock imports and module
// syntax. No real child, directory, timer, source import or financial I/O.
const body=original.replace(/^import .*;\n/gm,'').replace('export async function','async function')
  .replace('import.meta.url',JSON.stringify('file://'+path));
function fixture(){
 const child=new EventEmitter(); child.pid=321;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 const kills=[];child.kill=s=>{kills.push(s);return true;};
 const timers=new Map();let n=0,forks=0;
 const runChild=vm.runInNewContext('(function(){'+body+';return runChild})()',{
  fork:()=>{forks++;return child;},mkdtempSync:()=>'/synthetic/owned',mkdirSync:()=>{},realpathSync:x=>x,
  readdirSync:()=>[],CORE:'/synthetic/core',verifySelection:()=>{},URL,
  setTimeout:(fn,ms)=>{const id=++n;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
 });
 const message=()=>child.emit('message',{kind:'source-child-v1',pid:321,ok:true,result:{fixture:true},loader:{sourceModules:0}});
 const close=()=>{child.emit('disconnect');child.emit('exit',0,null);child.emit('close',0,null);};
 return {child,runChild,kills,timers,message,close,forks:()=>forks};
}
test('success requires spawned child, channel, immutable matching exit/close; concurrent run refuses',async()=>{
 const f=fixture();const p=f.runChild();await assert.rejects(f.runChild(),/sequence refused/);
 f.child.emit('spawn');f.message();f.close();const r=await p;
 assert.equal(r.confirmed,true);assert.equal(r.invalid,false);assert.equal(f.kills.length,0);assert.equal(f.forks(),1);
});
test('late lifecycle or output contradictions block the next child without rewriting prior result',async()=>{
 for(const late of [c=>c.emit('spawn'),c=>c.emit('exit',1,null),c=>c.emit('close',1,null),c=>c.emit('disconnect'),c=>c.stdout.emit('data',Buffer.alloc(0))]){
  const f=fixture();const p=f.runChild();f.child.emit('spawn');f.message();f.close();const r=await p;
  late(f.child);assert.equal(r.invalid,false);assert.equal(Object.isFrozen(r),true);
  await assert.rejects(f.runChild(),/sequence refused/);assert.equal(f.forks(),1);assert.equal(f.kills.length,0);
 }
});
test('mismatched close refuses and any observed exit prevents a fallback signal',async()=>{
 const f=fixture();const p=f.runChild();f.child.emit('spawn');f.message();f.child.emit('disconnect');f.child.emit('exit',0,null);
 f.child.emit('error',new Error('synthetic'));f.child.emit('close',1,null);const r=await p;
 assert.equal(r.confirmed,false);assert.equal(r.invalid,true);assert.equal(f.kills.length,0);
 await assert.rejects(f.runChild(),/sequence refused/);
});
test('unconfirmed deadline containment permanently refuses a new child',async()=>{
 const f=fixture();const p=f.runChild();f.child.emit('spawn');
 [...f.timers.values()].find(t=>t.ms===45000).fn();
 [...f.timers.values()].find(t=>t.ms===2000).fn();
 const r=await p;assert.equal(r.confirmed,false);assert.equal(r.invalid,true);assert.deepEqual(f.kills,['SIGKILL']);
 await assert.rejects(f.runChild(),/sequence refused/);assert.equal(f.forks(),1);
});
