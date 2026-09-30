// Read-only review of the frozen offline helper. No OS child or provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=new URL('../fair-confirmation/real-parent-v4/lifecycle.mjs',import.meta.url);
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),
  'f1b24d162f665ca18143a6d4e866ad62b05ba93cf40e4ad1b87b79efd0058c8e');
const {supervise}=await import(source.href);

async function trace(order,{publish,spawnThrow}={}) {
  const owner=new EventEmitter();
  Object.assign(owner,{pid:101,connected:true,kill(){assert.fail('No completed synthetic owner kill');}});
  return supervise({arm:'pi',expectedMessages:1,
    readyMs:50,taskMs:50,stopMs:50,closeMs:50,killGraceMs:20,
    spawnOwner(register){
      if(spawnThrow)throw spawnThrow.value;
      register(owner);queueMicrotask(()=>{
        for(const event of order){
          if(event==='message')owner.emit(event,{kind:'lifecycle-probe-v4',pid:101,ordinal:1,connected:true});
          else if(event==='disconnect'){owner.connected=false;owner.emit(event);}
          else if(event==='exit-fail')owner.emit('exit',9,null);
          else if(event==='exit'||event==='close')owner.emit(event,0,null);
          else owner.emit(event);
        }
      });
    },
    publish:publish?()=>publish(owner):undefined,
  });
}

test('v4 rejects duplicate exit and retains first nonzero exit',async()=>{
  const result=await trace(['spawn','message','disconnect','exit-fail','exit','close']);
  assert.equal(result.valid,false);assert.equal(result.owner.code,9);
  assert(result.issues.includes('owner_duplicate_exit'));
});
test('v4 rejects close-before-exit permanently',async()=>{
  const result=await trace(['spawn','message','disconnect','close','exit']);
  assert.equal(result.valid,false);assert.equal(result.owner.code,null);
  assert(result.issues.includes('owner_close_before_exit'));
});
test('v4 rejects late exit during publication without overwriting original status',async()=>{
  const result=await trace(['spawn','message','disconnect','exit','close'],
    {publish:owner=>owner.emit('exit',9,null)});
  assert.equal(result.valid,false);assert.equal(result.owner.code,0);
  assert(result.issues.includes('owner_duplicate_exit'));
});
for(const value of [null,undefined])test(`v4 returns sanitized thrown ${String(value)}`,async()=>{
  const result=await trace([],{spawnThrow:{value}});
  assert.equal(result.valid,false);assert.equal(result.owner,null);
  assert(result.issues.includes('launch_or_task_error'));
});

function* permutations(items){
  if(!items.length){yield [];return;}
  for(let i=0;i<items.length;i++)for(const rest of permutations(items.filter((_,j)=>i!==j)))
    yield [items[i],...rest];
}
test('frozen v4 characterization: three pre-spawn-message traces remain accepted',async()=>{
  const accepted=[];let count=0;
  for(const order of permutations(['spawn','message','disconnect','exit','close'])){
    count++;if((await trace(order)).valid)accepted.push(order);
  }
  assert.equal(count,120);
  assert.deepEqual(accepted,[
    ['spawn','message','disconnect','exit','close'],
    ['spawn','message','exit','disconnect','close'],
    // These three are remaining defect characterizations, not approval.
    ['message','spawn','disconnect','exit','close'],
    ['message','spawn','exit','disconnect','close'],
    ['message','disconnect','spawn','exit','close'],
  ]);
});
