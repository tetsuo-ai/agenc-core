// Draft. No test is authorized until root reviews platform containment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {PREFLIGHT_EXECUTION_APPROVED} from './preflight-selection.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function layout(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cli-private-preflight-'));
 fs.chmodSync(root,0o700);
 const value={root,workspace:path.join(root,'workspace'),targetHome:path.join(root,'target-home'),preflightHome:path.join(root,'preflight-home'),managedRoot:path.join(root,'absent-managed')};
 for(const dir of [value.workspace,value.targetHome,value.preflightHome,path.join(value.workspace,'.git')])fs.mkdirSync(dir,{mode:0o700});
 return value; // Retain every root, including failed cases. No recursive deletion.
}
test('independent canonical bootstrap prepares once without sampling or measured-home mutation',async()=>{
 assert.equal(PREFLIGHT_EXECUTION_APPROVED,true,'root containment approval required; not a skipped gate');
 const inputs=layout(),iso='2026-09-30T12:00:00.000Z';
 // This test runs in its own root-owned hermetic process, never a shared suite.
 process.env.HOME=inputs.preflightHome;process.env.AGENC_HOME=inputs.preflightHome;
 process.env.AGENC_CACHE_SESSION_TAIL='0';process.env.AGENC_OPENAI_REASONING_REPLAY='1';process.env.TZ='UTC';
 const NativeDate=Date;
 class FixedDate extends NativeDate{constructor(...args){super(...(args.length?args:[iso]));}static now(){return NativeDate.parse(iso);}}
 globalThis.Date=FixedDate;
 try{
  const {installSourceLoader}=await import('./source-loader.mjs');await installSourceLoader();
  const {prepareIndependent,CONFIG}=await import('./preflight.ts');
  const configPath=path.join(inputs.root,'config.toml');fs.writeFileSync(configPath,CONFIG,{flag:'wx',mode:0o600});
  const result=await prepareIndependent({...inputs,configPath,configSha256:sha(CONFIG),fixedIso:iso,signal:new AbortController().signal});
  assert.equal(result.producerCollections,1);assert.equal(result.forbiddenFetches,0);assert.equal(result.validations,0);
  assert.equal(result.material.selectedOrWireObserved,false);assert.equal(result.material.assembly.outcomes.length,19);
  assert.deepEqual(fs.readdirSync(inputs.targetHome),[]);
  assert.equal(result.material.wireTemplate.max_output_tokens,8192);
  assert.equal(result.material.wireTemplate.reasoning.effort,'low');
  assert.equal(Object.hasOwn(result.material.wireTemplate,'prompt_cache_key'),false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.material)),result.material,'sealed material must survive private JSON persistence');
  // Retain raw independent material only in this private fixture, not stdout.
  fs.writeFileSync(path.join(inputs.root,'private-material.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  assert.equal(fs.statSync(path.join(inputs.root,'private-material.json')).mode&0o777,0o600);
 }finally{globalThis.Date=NativeDate;}
});
