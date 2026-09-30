// Inert extraction of the frozen transport-test supervisor. No fork, observer,
// ledger, provider or actual child is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const rawSource=readFileSync('/private/tmp/light-takeover/fair-confirmation/luna-policy-v1/transport.test.mjs','utf8');
assert.equal(createHash('sha256').update(rawSource).digest('hex'),'292de4f8dc10516bcbb534de85be9bc70ba6dfb94b0cb23a8c08dd546988f72b');
const start=rawSource.indexOf(' await new Promise((resolve,reject)=>{');
const end=rawSource.indexOf('\n const ledger=',start);
assert(start>=0&&end>start);
const body=rawSource.slice(start,end).trim().replace(/^await /,'return ');
const supervise=new Function('fork','root','here','cap','raw','sha','acks','path','setTimeout','clearTimeout','assert',body);
function fixture(killResult=true){
  const child=new EventEmitter();child.pid=12345;
  child.stderr=new EventEmitter();child.stdout={resume(){}};
  const kills=[];child.kill=signal=>{kills.push(signal);return killResult;};
  const timers=[];let settled=false,error;
  const promise=supervise(()=>child,'/inert','/inert',45,'{}',()=> 'a'.repeat(64),[],path,
    fn=>{timers.push(fn);return timers.length;},()=>{},assert).then(()=>{settled=true;},reason=>{settled=true;error=reason;});
  return {child,kills,timers,promise,get settled(){return settled;},get error(){return error;}};
}
test('clean close control settles normally',async()=>{
  const f=fixture();f.child.emit('close',0,null);await f.promise;
  assert.equal(f.settled,true);assert.equal(f.error,undefined);assert.deepEqual(f.kills,[]);
});
test('error after successful spawn must not skip owned-child cleanup',async()=>{
  const f=fixture();f.child.emit('spawn');f.child.emit('error',new Error('synthetic child error'));await f.promise;
  assert(f.error);assert.deepEqual(f.kills,['SIGKILL'],'frozen test rejects without any containment attempt');
});
test('failed timeout signal must not stand in for observed close',async()=>{
  const f=fixture(false);f.child.emit('spawn');f.timers[0]();await f.promise;
  assert.deepEqual(f.kills,['SIGKILL']);
  assert.equal(f.settled,false,'frozen supervisor completes rejection before a close/containment boundary');
});
