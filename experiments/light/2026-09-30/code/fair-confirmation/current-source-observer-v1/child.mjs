import fs from 'node:fs';
import {installSourceLoader} from './source-loader.mjs';
import {createHooks} from './seal.mjs';
import {PYTHON,PYTHON_PIN,verifyObserverSelection} from './observer-selection.mjs';
let result,stage='selection';
try{
 verifyObserverSelection();
 const mode=process.argv[2],root=process.env.SOURCE_CHILD_ROOT,channel=process.argv[3];
 if(!['normal','positive_cap','task','summary','contract_mismatch'].includes(mode)||!/^[a-f0-9-]{36}$/.test(channel))throw new Error('Fixture selection refused');
 stage='loader';const loaded=await installSourceLoader();
 stage='source_import';const {probe}=await import('./scenario.ts');
 const {runWithStartupProviderSelection}=await import('/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/utils/model/providers.ts');
 const hooks=await createHooks({root,mode,channel,pythonPath:PYTHON,pythonHash:PYTHON_PIN});
 stage='turn';
 const outcome=await runWithStartupProviderSelection({provider:'openai',model:'gpt-6-luna',environment:{AGENC_CACHE_SESSION_TAIL:'0',AGENC_OPENAI_REASONING_REPLAY:'1'}},
  ()=>probe(['task','summary'].includes(mode)?mode:undefined,hooks));
 result={kind:'current-source-observer-v1.complete',pid:process.pid,ok:true,result:outcome,loader:loaded(),hooks:hooks.summary()};
}catch(error){
 const sourceFrames=typeof error?.stack==='string'?error.stack.split('\n').filter(s=>/^\s+at .*(?:file:\/\/\/private\/tmp|node:)/.test(s)).slice(0,8):[];
 fs.writeFileSync(process.env.SOURCE_CHILD_ROOT+'/failure.json',JSON.stringify({stage,sourceFrames}),{flag:'wx',mode:0o600});
 result={kind:'current-source-observer-v1.complete',pid:process.pid,ok:false,reason:'source_observer_refused',stage};
 process.exitCode=1;
}
// All publication sends originate in this same owned process. No forwarding
// of arbitrary IPC, fake process.send, or replacement financial result.
await new Promise(resolve=>setImmediate(resolve));
await new Promise(resolve=>process.send(result,error=>{if(error)process.exitCode=1;resolve();}));
process.disconnect();
