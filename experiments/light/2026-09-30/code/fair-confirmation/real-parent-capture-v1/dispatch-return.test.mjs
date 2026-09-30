// Revision2 regressions. Prior lifecycle revision digest is recorded in source;
// original55 tests and reviewer reproducer remain untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('./lifecycle.mjs',import.meta.url));
function isolated(dispatch) {
  const code=`
import {EventEmitter} from 'node:events';
import {supervise} from ${JSON.stringify(source)};
let invoked=0;
class Child extends EventEmitter {
  constructor(){super();this.pid=42;this.connected=true;this.closed=false;}
  close(){if(this.closed)return;this.closed=true;this.connected=false;this.emit('disconnect');this.emit('exit',0,null);this.emit('close',0,null);}
  kill(){this.close();return true;}
}
const child=new Child();
const result=await supervise({arm:'pi',expectedMessages:0,readyMs:30,taskMs:30,stopMs:30,closeMs:30,killGraceMs:10,
  dispatchOwnerMessage:${dispatch},spawnOwner(register){register(child);queueMicrotask(()=>{
    child.emit('spawn');child.emit('message',{});setTimeout(()=>child.close(),1);
  });}});
await new Promise(resolve=>setImmediate(resolve));
console.log(JSON.stringify({valid:result.valid,cleanup:result.cleanup_complete,issues:result.issues,invoked}));
`;
  const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',code],
    {encoding:'utf8',env:{},timeout:3000,maxBuffer:4096});
  assert.equal(result.status,0,'parent must return sanitized refusal, not terminate');
  assert.equal(result.stderr,'');
  const facts=JSON.parse(result.stdout);
  assert.equal(facts.valid,false);assert.equal(facts.cleanup,true);
  assert(facts.issues.includes('invalid_owner_dispatch'));
  assert.equal(facts.invoked,0,'no user getter, thenable or overridden then may execute');
}
for(const [name,dispatch] of [
  ['native rejected Promise','()=>Promise.reject(new Error("synthetic rejection"))'],
  ['native resolved Promise','()=>Promise.resolve({kind:"publication"})'],
  ['native rejected Promise with overridden then','()=>{const p=Promise.reject(null);p.then=()=>{invoked++;throw null;};return p;}'],
  ['throwing proxy tag','()=>new Proxy({kind:"publication"},{get(){invoked++;throw null;}})'],
  ['reflective proxy trap','()=>new Proxy({kind:"publication"},{getPrototypeOf(){invoked++;throw null;}})'],
  ['arbitrary thenable','()=>({then(){invoked++;throw null;}})'],
  ['then getter','()=>({get then(){invoked++;throw null;}})'],
  ['kind getter','()=>({get kind(){invoked++;throw null;}})'],
]) test(`${name} is contained as sticky invalid`,()=>isolated(dispatch));
