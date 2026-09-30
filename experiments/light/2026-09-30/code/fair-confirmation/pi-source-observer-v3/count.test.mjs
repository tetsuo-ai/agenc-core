import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
test('capture byte-count gate accepts zero only for abort, rejects negative and invalid counts',()=>{
  const source=fs.readFileSync(new URL('./parent.mjs',import.meta.url),'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'2ff7a47093c424d72a61bb163e5ae2462b92babf62551cf1a9e5b4ff69a1d400');
  const expression=source.match(/need\(uuid\(ack.root_turn_id\).*'invalid_ack_scalar'\);/)[0];
  const check=new Function('ack','caseName','need','uuid',expression);
  const run=(count,mode)=>check({root_turn_id:'synthetic-valid-uuid',response_byte_count:count},mode,
    ok=>{if(!ok)throw new Error('refused');},()=>true);
  run(0,'abort');run(1,'normal');run(1,'abort');
  assert.throws(()=>run(0,'normal'),/refused/);
  for(const mode of ['normal','abort'])for(const count of [-1,0.5,null,false,'0',1048577,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>run(count,mode),/refused/);
});
