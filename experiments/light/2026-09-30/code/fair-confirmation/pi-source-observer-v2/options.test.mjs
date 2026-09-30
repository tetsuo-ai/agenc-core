// Exercises the exact extracted allowlist without loading Pi or an observer.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
test('binding allowlist requires exact three pipes and windowsHide true',()=>{
  const source=fs.readFileSync(new URL('./child.mjs',import.meta.url),'utf8');
  const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
  assert.equal(sha(source),'4011c230224dbcdbcd73f8c39b8c019f712fc63244db7957f66e11924e3d91dd');
  const fragment=source.slice(source.indexOf('cp.spawnSync='),source.indexOf('syncBuiltinESMExports();'));
  const script=Buffer.from('synthetic_bridge'),fair='/fixture',file='/fixture/python';
  const selection={python:file,dependencies:{'shared-luna-binding-v1/bridge.py':sha(script),'luna-policy-v2/policy_bridge.py':sha(script)}};
  let sent=0;
  const fn=new Function('cp','fs','path','FAIR','selection','sha','deny','nativeSpawnSync',
    'let bridgeCalls=0;'+fragment+'return cp.spawnSync;')({}, {readFileSync:()=>script},path,fair,selection,sha,
      ()=>{throw new Error('refused');},()=>{sent++;return 'allowed';});
  const full='/fixture/shared-luna-binding-v1/bridge.py';
  const args=['-I','-S','-B','-c',`__file__ = ${JSON.stringify(full)}\n`+script];
  const options={input:'{}',env:{LANG:'C.UTF-8'},cwd:'/fixture/luna-observer-v6',timeout:2000,killSignal:'SIGKILL',maxBuffer:16384,stdio:['pipe','pipe','pipe'],windowsHide:true};
  assert.equal(fn(file,args,options),'allowed');
  for(const mutate of [o=>delete o.stdio,o=>o.stdio=['inherit','pipe','pipe'],o=>delete o.windowsHide,o=>o.windowsHide=false,o=>o.extra=true]){
    const changed=structuredClone(options);mutate(changed);assert.throws(()=>fn(file,args,changed),/refused/);
  }
  assert.equal(sent,1);
});
