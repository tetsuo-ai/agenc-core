import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const source = '/private/tmp/light-takeover/fair-confirmation/real-parent-capture-v1/lifecycle.mjs';
function isolated(dispatch) {
  const code = `
import {EventEmitter} from 'node:events';
import {supervise} from ${JSON.stringify(source)};
class Child extends EventEmitter {
  constructor(){super();this.pid=42;this.connected=true;this.closed=false;}
  close(){if(this.closed)return;this.closed=true;this.connected=false;this.emit('disconnect');this.emit('exit',0,null);this.emit('close',0,null);}
  kill(){this.close();return true;}
}
const child=new Child();
const result=await supervise({arm:'pi',expectedMessages:0,readyMs:20,taskMs:20,stopMs:20,closeMs:20,killGraceMs:10,
  dispatchOwnerMessage:${dispatch},
  spawnOwner(register){register(child);queueMicrotask(()=>{child.emit('spawn');child.emit('message',{});setTimeout(()=>child.close(),1);});}});
console.log(JSON.stringify({valid:result.valid,cleanup:result.cleanup_complete,issues:result.issues}));
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding:'utf8', env:{}, timeout:2000, maxBuffer:16384 });
}
function cleanRefusal(observed) {
  assert.equal(observed.status,0, 'malformed dispatcher result must not terminate the parent');
  const facts=JSON.parse(observed.stdout);
  assert.equal(facts.valid,false);assert.equal(facts.cleanup,true);
  assert(facts.issues.includes('invalid_owner_dispatch'));
  assert.equal(observed.stderr,'');
}
test('synchronous thrown value is a clean refusal control',()=>cleanRefusal(isolated('()=>{throw null;}')));
test('resolved Promise is a clean refusal control',()=>cleanRefusal(isolated('()=>Promise.resolve({kind:"publication"})')));
test('rejected Promise must be contained, not become an unhandled rejection',()=>
  cleanRefusal(isolated('()=>Promise.reject(new Error("SYNTHETIC_DISPATCH_FAILURE"))')));
test('a validated descriptor must not be followed by an unsafe property reread',()=>
  cleanRefusal(isolated('()=>new Proxy({kind:"publication"},{get(target,key){if(key==="kind")throw new Error("SYNTHETIC_TAG_FAILURE");return Reflect.get(target,key);}})')));
