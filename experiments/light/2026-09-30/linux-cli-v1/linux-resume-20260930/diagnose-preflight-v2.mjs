// One diagnostic preparation only; no daemon/task/provider launch. Root owns
// execution in the same network-none container with a <=60s outer watchdog.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
const need=(ok,label)=>{if(!ok)throw new Error(label);};
const sha=raw=>createHash('sha256').update(raw).digest('hex');
function bytes(name,pin,max=32*1024*1024){
  need(typeof pin==='string'&&/^[a-f0-9]{64}$/.test(pin),'pin_required');
  const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const a=fs.fstatSync(fd,{bigint:true});need(a.isFile()&&a.size<=BigInt(max),'bounded_file_required');
    const raw=Buffer.alloc(Number(a.size)+1);let n=0;
    while(n<raw.length){const count=fs.readSync(fd,raw,n,raw.length-n,null);if(count===0)break;n+=count;}
    const b=fs.fstatSync(fd,{bigint:true}),c=fs.lstatSync(name,{bigint:true});
    need(n===Number(a.size)&&c.isFile()&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]&&a[k]===c[k]),'file_changed');
    const value=raw.subarray(0,n);need(sha(value)===pin,'pin_mismatch');return value;
  }finally{fs.closeSync(fd);}
}
const staticReasons=new Set([
  'preflight_execution_not_approved','config_not_independent_literal','fixed_clock_missing','private_process_home_required',
  'declared_environment_missing','network_tripwire_missing','preflight_sampling_forbidden','preflight_network_forbidden',
  'context_mismatch','policy_mismatch','runtime_options_mismatch','nonempty_startup_configuration','nonempty_plugin_configuration',
  'nonempty_style_or_lsp_configuration','permission_mismatch','unexpected_ingress_context','nonempty_instruction_inventory',
  'unexpected_initial_tools','producer_evidence_unknown','nonempty_producer_inventory','unexpected_auxiliary_layout',
  'unsupported_instruction_split','preflight_attempted_sampling','preflight_and_cleanup_failed','preflight_cleanup_failed',
]);
function describe(error,allowedRoot,depth=0){
  if(depth>3||error===null||typeof error!=='object'||types.isProxy(error))return {kind:'unclassified'};
  const result={kind:error instanceof AggregateError?'AggregateError':error instanceof Error?'Error':'unclassified',frames:[]};
  const message=Object.getOwnPropertyDescriptor(error,'message')?.value;
  if(typeof message==='string'&&staticReasons.has(message))result.staticReason=message;
  // Only selected compiled-source filenames + numeric positions survive. No
  // raw stack line, function argument, message, stdout, config or cause text.
  let stack;try{stack=error.stack;}catch{}
  if(typeof stack==='string')for(const line of stack.slice(0,16384).split('\n').slice(1,25)){
    const match=line.match(/(?:\(|\s)(?:file:\/\/)?(\/[^\s():]+):(\d+):(\d+)\)?$/);
    if(match&&match[1].startsWith(allowedRoot+'/')&&/^[A-Za-z0-9_./-]+$/.test(match[1]))
      result.frames.push({file:path.relative(allowedRoot,match[1]),line:Number(match[2]),column:Number(match[3])});
    if(result.frames.length===8)break;
  }
  const errors=Object.getOwnPropertyDescriptor(error,'errors')?.value;
  if(error instanceof AggregateError&&Array.isArray(errors))result.errors=errors.slice(0,4).map(e=>describe(e,allowedRoot,depth+1));
  const cause=Object.getOwnPropertyDescriptor(error,'cause');
  if(cause&&'value'in cause)result.cause=describe(cause.value,allowedRoot,depth+1);
  return result;
}
function save(name,value){
  const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');
  const fd=fs.openSync(name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let n=0;while(n<raw.length){const count=fs.writeSync(fd,raw,n,raw.length-n);need(count>0,'write_failed');n+=count;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function main(){
  const [deploymentPath,deploymentHash,...extra]=process.argv.slice(2);
  need(extra.length===0&&process.platform==='linux'&&process.getuid?.()!==0,'selected_linux_required');
  need(fs.readdirSync('/sys/class/net').every(name=>name==='lo'),'network_none_required');
  const d=JSON.parse(bytes(deploymentPath,deploymentHash));
  const s=JSON.parse(bytes(d.setupPath,d.setupSha256)),i=s.input,p=s.paths;
  need(d.executionApproved===true&&d.buildRevision==='38d63e586a92c4da8b1e51b31d46f74ee359a55a'&&process.execPath===i.node,'deployment_mismatch');
  const home=path.join(s.runRoot,'diagnostic-preflight-home'),report=path.join(s.runRoot,'diagnostic-preflight-result.json');
  need(process.env.HOME===home&&process.env.AGENC_HOME===home&&process.env.AGENC_WORKSPACE===p.workspace,'diagnostic_home_not_selected');
  need(process.env.AGENC_CACHE_SESSION_TAIL==='0'&&process.env.AGENC_OPENAI_REASONING_REPLAY==='1','environment_mismatch');
  const tripwire=path.join(s.runtime,'tests/helpers/network-tripwire.cjs'),calendar=path.join(s.runRoot,'selection/calendar.cjs');
  need(process.env.NODE_OPTIONS===`--require ${JSON.stringify(tripwire)}`&&process.env.NODE_PATH===undefined,'ambient_loader_refused');
  need(JSON.stringify(process.execArgv)===JSON.stringify(['--require',tripwire,'--require',calendar]),'exact_preloads_required');
  bytes(tripwire,d.files[tripwire]);bytes(calendar,d.files[calendar]);
  const marker=Object.getOwnPropertyDescriptor(globalThis,Symbol.for('agenc.test.hermetic-runtime.marker'));
  need(marker?.value?.version==='agenc-hermetic-network-tripwire-v1'&&marker.configurable===false&&marker.writable===false,'canonical_tripwire_required');
  need(fs.readdirSync(p['target-home']).length===0&&fs.readdirSync(p.workspace).join()==='.git'&&
    fs.readdirSync(path.join(p.workspace,'.git')).length===0,'target_not_unchanged');
  bytes(d.entries.preflight,d.files[d.entries.preflight]);
  bytes(path.join(s.runRoot,'selection/preflight-selection.mjs'),d.files[path.join(s.runRoot,'selection/preflight-selection.mjs')]);
  fs.mkdirSync(home,{mode:0o700}); // exclusive; never reuse the first run's home
  let phase='import',passed=false,diagnostic=null;
  try {
    const entry=await import(pathToFileURL(d.entries.preflight).href);phase='call';
    const result=await entry.runSelectedIndependent({workspace:p.workspace,targetHome:p['target-home'],preflightHome:home,
      configPath:s.configPath,configSha256:s.configurationSha256,fixedIso:i.fixedIso,signal:new AbortController().signal});
    passed=true;diagnostic={producerCollections:result.producerCollections,forbiddenFetches:result.forbiddenFetches,validations:result.validations};
  }catch(error){diagnostic=describe(error,path.dirname(d.entries.preflight));}
  save(report,{schemaVersion:1,kind:'preflight-location-diagnostic',passed,phase,diagnostic,
    targetHomeStillEmpty:fs.readdirSync(p['target-home']).length===0,
    workspaceEntries:fs.readdirSync(p.workspace).length,paid:false,ordinaryCliStarted:false});
  console.log(JSON.stringify({passed,phase,report,paid:false,ordinaryCliStarted:false}));
  process.exitCode=passed?0:1;
}
try{await main();}catch(error){
  const labels=new Set(['pin_required','bounded_file_required','file_changed','pin_mismatch','write_failed',
    'selected_linux_required','network_none_required','deployment_mismatch','diagnostic_home_not_selected',
    'environment_mismatch','ambient_loader_refused','exact_preloads_required','canonical_tripwire_required','target_not_unchanged']);
  const message=error!==null&&typeof error==='object'&&!types.isProxy(error)?Object.getOwnPropertyDescriptor(error,'message')?.value:undefined;
  const reason=typeof message==='string'&&labels.has(message)?message:'unclassified_setup_failure';
  console.log(JSON.stringify({passed:false,phase:'diagnostic_setup',staticReason:reason,paid:false}));process.exitCode=1;
}
