// Root-owned inventory for this single Linux diagnostic, not paid authority.
// The selected source archive and image were accepted independently before setup.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const [phase]=process.argv.slice(2);
if(!['setup','build','deployment'].includes(phase)||process.platform!=='linux'||process.getuid()!==1000)throw Error('invalid_sealing_context');
const source='/gate/source',fair='/gate/fair',run='/gate/cli-one';
const files={};
function scan(root){
 for(const e of fs.readdirSync(root,{withFileTypes:true})){
  const p=path.join(root,e.name);
  if(e.isDirectory())scan(p);
  else if(e.isFile())files[p]=sha(fs.readFileSync(p));
  else if(!e.isSymbolicLink())throw Error('unexpected_input_type');
 }
}
scan(source);scan(fair);
const node=fs.realpathSync(process.execPath),python=fs.realpathSync('/usr/bin/python3');
files[node]=sha(fs.readFileSync(node));files[python]=sha(fs.readFileSync(python));
const version=JSON.parse(fs.readFileSync(source+'/runtime/dist/VERSION','utf8'));
const build='38d63e586a92c4da8b1e51b31d46f74ee359a55a',product='403da04398b55e51d1f4e8814f9a70957b0db5ef';
if(version.commit!==build||version.buildTime!=='2026-09-30T11:17:38.000Z')throw Error('build_identity_changed');
let data,file;
if(phase==='setup'){
 data={schemaVersion:1,executionApproved:true,sourceRevision:product,buildRevision:build,version,
  coreRoot:source,fairRoot:fair,node,python,fixedIso:'2026-09-30T16:00:00.000Z',
  protocolId:'linux-cli-one-fake-v1',runId:'linux-38d63-one-20260930-v1',channelId:'linux-38d63-channel-v1',
  spendPolicy:{mode:'positive_cap',capUsd:'1'},containment:{network:'none',outerWatchdogSeconds:180,ordinarySandboxRequired:true},files};
 file='/gate/setup-manifest-v1.json';
}else{
 scan(run);
 if(phase==='build'){
  data={schemaVersion:1,productRevision:product,buildRevision:build,files};file='/gate/build-manifest-v1.json';
 }else{
  const setupPath=run+'/setup.json';
  data={schemaVersion:1,executionApproved:true,sourceRevision:product,buildRevision:build,
   setupPath,setupSha256:files[setupPath],entries:{owner:run+'/companion/dist/owner-caller.mjs',
    preflight:run+'/companion/dist/preflight-companion.mjs',bridge:run+'/companion/dist/identity-bridge.mjs'},
   cli:source+'/runtime/bin/agenc',clientArtifactSha256:files[source+'/runtime/dist/bin/agenc.js'],files};
  file='/gate/deployment-manifest-v1.json';
 }
}
const raw=JSON.stringify(data,null,2)+'\n';
fs.writeFileSync(file,raw,{flag:'wx',mode:0o600});
console.log(JSON.stringify({file,sha256:sha(raw),files:Object.keys(files).length,phase,paid:false}));
