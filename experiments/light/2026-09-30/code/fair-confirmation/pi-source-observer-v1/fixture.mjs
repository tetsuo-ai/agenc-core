// Pure fixture declarations and read-only integrity checks; no package imports.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const HERE=path.dirname(fileURLToPath(import.meta.url)), FAIR=path.dirname(HERE);
export const selection=JSON.parse(fs.readFileSync(path.join(HERE,'selection.json')));
export const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export const need=(value,reason)=>{if(!value)throw new Error(reason);};
// Python reducer canonical JSON: sorted keys, ensure_ascii, compact separators.
export function canonical(value) {
  const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'
    ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
  return JSON.stringify(sort(value)).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function verifySelection() {
  need(selection.execution_approved===true,'execution_not_authorized');
  need(process.execPath===selection.node&&sha(fs.readFileSync(process.execPath))===selection.node_sha256,'node_mismatch');
  need(fs.realpathSync(selection.python)===selection.python&&sha(fs.readFileSync(selection.python))===selection.python_sha256,'python_mismatch');
  need(sha(fs.readFileSync(path.join(selection.install,'package-lock.json')))===selection.lock_sha256,'lock_mismatch');
  for(const [name,pin]of Object.entries(selection.dependencies))need(sha(fs.readFileSync(path.join(FAIR,name)))===pin,'dependency_mismatch');
  const rows=[];
  function walk(relative){
    for(const name of fs.readdirSync(path.join(selection.install,relative)).sort()){
      const key=path.posix.join(relative,name),full=path.join(selection.install,key),info=fs.lstatSync(full);
      if(info.isSymbolicLink()){
        need(fs.realpathSync(full).startsWith(selection.install+path.sep),'external_link');
        rows.push([key,'symlink',fs.readlinkSync(full)]);
      }else if(info.isDirectory())walk(key);
      else {need(info.isFile()&&info.size<=256*1024*1024,'unsupported_file');rows.push([key,'file',sha(fs.readFileSync(full))]);}
      need(rows.length<=100000,'inventory_limit');
    }
  }
  walk('node_modules');
  need(sha(JSON.stringify(rows))===selection.tree_sha256,'tree_mismatch');
  need(rows.filter(x=>x[1]==='file').length===selection.files&&rows.filter(x=>x[1]==='symlink').length===selection.symlinks,'inventory_count');
  for(const [name,pin]of Object.entries(selection.pi_sources))need(sha(fs.readFileSync(path.join(selection.install,'node_modules',name)))===pin,'selected_source_mismatch');
}
export const TASK='Reply with a short acknowledgement; do not call tools.';
export const NAMES=['read','bash','edit','write'];
export const pick=t=>({name:t.name,description:t.description,parameters:t.parameters});
export function sealInputs({system,tools,sessionId,root,mode,channel}){
  const controls={model:'gpt-6-luna',stream:true,store:false,max_output_tokens:8192,
    reasoning:{effort:'low',summary:'auto'},include:['reasoning.encrypted_content'],prompt_cache_key:sessionId};
  const envelope={...controls,tools:tools.map(t=>({type:'function',...pick(t),strict:false}))};
  const config={scope:'reduced-sdk',date:'2026-09-30T12:00:00.000Z',tz:'UTC',workspace:root,
    sessionId,names:NAMES,retry:{enabled:false,provider:{maxRetries:0}},compaction:false};
  const contract={schema_version:2,profile_id:'pi-luna-v0731-shared-v1',protocol_id:'pi-source-observer-v1',
    run_id:'synthetic',root_turn_id:sessionId,task_index:1,task_prompt_sha256:sha(TASK),
    client_artifact_sha256:selection.tree_sha256,configuration_sha256:sha(canonical(config)),
    source_inventory_sha256:sha(canonical(selection.pi_sources)),instructions_sha256:null,
    auxiliary:[{index:0,slot:'static_system',origin:'pi.static-system',text_sha256:sha(system)}],
    envelope_fields:Object.keys(envelope).sort(),envelope_sha256:sha(canonical(envelope))};
  const contractRaw=canonical(contract),expected=Object.fromEntries(['protocol_id','run_id','root_turn_id','task_prompt_sha256','client_artifact_sha256','configuration_sha256'].map(k=>[k,contract[k]]));
  Object.assign(expected,{client:'pi',route:'openai-direct',contract_sha256:sha(contractRaw)});
  // Independently declared semantic wire, never used as the outgoing transport body.
  const expectedBody={...envelope,input:[{role:'developer',content:system},{role:'user',content:[{type:'input_text',text:TASK}]}]};
  return {contractRaw,expected,expectedBody,policyRaw:canonical({schema_version:1,profile:'fixed-luna-v1',route:'openai-direct',client:'pi',controls}),
    systemHash:sha(system),toolsHash:sha(canonical(tools.map(pick))),mode,channel};
}
