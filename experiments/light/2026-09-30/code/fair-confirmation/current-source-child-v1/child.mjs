import {installSourceLoader} from './source-loader.mjs';
import fs from 'node:fs';
// Explicit containment controls: no source/client import or user task executes.
if(process.argv[2]==='early_exit'){process.disconnect();process.exit(73);}
if(process.argv[2]==='unexpected_ipc'){
 process.send({kind:'not-authorized',pid:process.pid});await new Promise(()=>{});
}
if(process.argv[2]==='timeout'){setInterval(()=>{},1000);await new Promise(()=>{});}
let outcome,stage='loader';
try{
 const inventory=await installSourceLoader();
 stage='source_import';const {probe}=await import('./scenario.ts');
 const {runWithStartupProviderSelection}=await import('/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/utils/model/providers.ts');
 stage='turn';
 const result=await runWithStartupProviderSelection({provider:'openai',model:'gpt-6-luna',environment:{AGENC_CACHE_SESSION_TAIL:'0',AGENC_OPENAI_REASONING_REPLAY:'1'}},()=>probe(process.argv[2]==='task'?'task':undefined));
 outcome={kind:'source-child-v1',pid:process.pid,ok:true,result,loader:inventory()};
}catch(error){
 // Import-stage failures precede fixture input. Retain only source locations
 // and an allowlisted module-linking diagnostic, never arbitrary exception text.
 const sourceFrames=typeof error?.stack==='string'?error.stack.split('\n').filter(s=>/^\s+at .*(?:file:\/\/\/private\/tmp|node:)/.test(s)).slice(0,8):[];
 const link=stage==='source_import'&&typeof error?.message==='string'&&/^(The requested module |Cannot find |.* is not defined$)/.test(error.message)?error.message.slice(0,500):null;
 fs.writeFileSync(process.env.SOURCE_CHILD_ROOT+'/failure.json',JSON.stringify({stage,name:error?.name,link,sourceFrames}),{flag:'wx',mode:0o600});
 const code=['ERR_MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code)?error.code:null;
 const module=typeof error?.url==='string'&&error.url.startsWith('file:///private/tmp/light-clean-prepared-mHtxlR/source/')?error.url:null;
 outcome={kind:'source-child-v1',pid:process.pid,ok:false,reason:'source_child_refused',stage,code,module};
 process.exitCode=1;
}
await new Promise(resolve=>process.send(outcome,error=>{if(error)process.exitCode=1;resolve();}));
process.disconnect();
