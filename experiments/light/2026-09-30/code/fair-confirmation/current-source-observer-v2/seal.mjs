import fs from 'node:fs';
import path from 'node:path';
import {sha} from './selection.mjs';
import {FAIR,pins,OBSERVER_PIN,METADATA_SCHEMA,OBSERVER_CONTRACT,BINDING_PROFILE,verifyObserverSelection} from './observer-selection.mjs';
const need=ok=>{if(!ok)throw new Error('Independent observer fixture refused');};
// Same codec as Python json.dumps(sort_keys=True,ensure_ascii=True,separators).
// Inputs are independently assembled JSON-only fixture declarations.
export function canonical(value){
 function clean(v){
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isFinite(v));return v;}
  if(typeof v==='string'){need([...v].every(c=>{const n=c.codePointAt(0);return n<0xd800||n>0xdfff;}));return v;}
  if(Array.isArray(v))return v.map(clean);
  need(v&&Object.getPrototypeOf(v)===Object.prototype);
  return Object.fromEntries(Object.keys(v).sort().map(k=>[clean(k),clean(v[k])]));
 }
 return Buffer.from(JSON.stringify(clean(value)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
}
export async function createHooks({root,mode,channel,pythonPath,pythonHash}){
 verifyObserverSelection();
 const {financialPolicyId}=await import(FAIR+'/luna-finance-mode-v2/journal.mjs');
 const {parseLedgerBytes,numericLexeme}=await import(FAIR+'/luna-finance-v1/ledger-json.mjs');
 const financialRoot=path.join(root,'financial');fs.mkdirSync(financialRoot,{mode:0o700});
 const ledger=path.join(financialRoot,'luna-api-ledger.jsonl');fs.writeFileSync(ledger,'',{flag:'wx',mode:0o600});
 const rs=fs.statSync(financialRoot,{bigint:true}),ls=fs.statSync(ledger,{bigint:true});
 const sources=JSON.parse(fs.readFileSync(new URL('./source-pins.json',import.meta.url),'utf8'));
 const deployed=Object.fromEntries(Object.entries(sources).map(([k,v])=>['runtime/'+k,v]));
 const spendPolicy=mode==='positive_cap'?{mode:'positive_cap',capUsd:'0.1'}:{mode:'credit_exhaustion'};
 let sealed=false,observedFetch,entries=0,contractHash=null,metadataHash=null;
 const put=(name,bytes)=>{const p=path.join(root,name);fs.writeFileSync(p,bytes,{flag:'wx',mode:0o600});return p;};
 return Object.freeze({
  mode,
  async seal({wire,policy,policyHash,task,turn,nativeFetch}){
   need(!sealed&&sha(policy)===policyHash);sealed=true;
   // No actual Session, selected report or outgoing request exists yet.
   const envelope=Object.fromEntries(Object.entries(wire).filter(([k])=>k!=='input'&&k!=='instructions'));
   const identity={protocol_id:'current-source-observer-v2',run_id:'preflight-root',root_turn_id:turn,
    client:'light',route:'openai-direct',task_prompt_sha256:sha(Buffer.from(task)),
    client_artifact_sha256:sha(canonical({revision:'44aed233a73dc8207ce66280b0ee374d1345e66e',selected:deployed})),
    configuration_sha256:sha(canonical({task,isolatedInstructions:true,context:'source-child-reduced-v1',policy_sha256:policyHash,workspace:path.join(root,'workspace')}))};
   const contract={schema_version:2,profile_id:BINDING_PROFILE,
    ...Object.fromEntries(['protocol_id','run_id','root_turn_id','task_prompt_sha256','client_artifact_sha256','configuration_sha256'].map(k=>[k,identity[k]])),
    task_index:0,source_inventory_sha256:sha(canonical(deployed)),instructions_sha256:sha(Buffer.from(wire.instructions)),
    auxiliary:[{index:1,slot:'dynamic_system',origin:'light.responses-dynamic-suffix',text_sha256:sha(Buffer.from(wire.input[1].content[0].text))}],
    envelope_fields:Object.keys(envelope).sort(),envelope_sha256:sha(canonical(envelope))};
   // Explicitly wrong preauthorization negative; never adapted to observed wire.
   if(mode==='contract_mismatch')contract.instructions_sha256='0'.repeat(64);
   const contractBytes=canonical(contract);contractHash=sha(contractBytes);
   const expected={...identity,contract_sha256:contractHash};
   const contractPath=put('contract.json',contractBytes),policyPath=put('policy.json',policy);
   const meta={schema_version:METADATA_SCHEMA,contract:OBSERVER_CONTRACT,
    protocol_id:identity.protocol_id,run_id:identity.run_id,root_turn_id:turn,route:'openai-direct',task_prompt_sha256:identity.task_prompt_sha256,
    observer_source_sha256:OBSERVER_PIN,installed_adapter_sha256:pins['stream_adapters.py'],installed_adapter_path:FAIR+'/stream_adapters.py',publication_channel_id:channel,
    binding:{contract_path:contractPath,expected,deployed_source_pins:deployed,
     binding_source_sha256:pins['current-base-binding-v2/binding.py'],bridge_source_sha256:pins['current-base-binding-v2/bridge.py'],python_path:pythonPath,python_sha256:pythonHash},
    fixed_policy:{policy_path:policyPath,policy_sha256:policyHash,bridge_sha256:pins['luna-policy-v2/policy_bridge.py']},
    financial:{schema_version:2,spend_policy:spendPolicy,policy_id:financialPolicyId(spendPolicy),
     inventory:{rootDev:String(rs.dev),rootIno:String(rs.ino),journalDev:String(ls.dev),journalIno:String(ls.ino),prefixBytes:0,prefixSha256:sha('')}}};
   const raw=canonical(meta);metadataHash=sha(raw);const metadataPath=put('metadata.json',raw);
   Object.assign(process.env,{LUNA_LEDGER_ROOT:financialRoot,LUNA_RUN_DIR:root,LUNA_RUN_ID:'preflight-root',LUNA_TASK_CALL_CAP:'1',LUNA_CAPTURE_METADATA:metadataPath,LUNA_CAPTURE_METADATA_SHA256:metadataHash});
   globalThis.fetch=nativeFetch;
   await import(FAIR+'/luna-observer-v5/direct.mjs');
   observedFetch=globalThis.fetch;need(observedFetch!==nativeFetch);
  },
  fetch(...args){need(sealed&&typeof observedFetch==='function');entries++;need(entries===1);return observedFetch(...args);},
  requireFinancial(requestHash){
   const rows=parseLedgerBytes(fs.readFileSync(ledger));need(rows.length===1);
   const row=rows[0];need(row.event==='admit'&&row.run==='preflight-root'&&numericLexeme(row.call)==='1'&&row.request_sha256===requestHash);
  },
  summary(){return {sealed,observerEntries:entries,contractHash,metadataHash};},
 });
}
