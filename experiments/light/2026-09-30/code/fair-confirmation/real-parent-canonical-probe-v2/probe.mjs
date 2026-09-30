// Root-invoked only. Importing this entrypoint intentionally launches the case.
// Unit tests import control.mjs/selection.mjs, never this file.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSelection} from './selection.mjs';
import {readPinnedBytes,verifyFile,MANIFEST_LIMIT} from './verify-files.mjs';
const CASES=['normal','owner-exit-before-readiness','authenticated-identity-refusal'];

function durableNew(path,value){
  const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(dirname(path),fs.constants.O_RDONLY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
const [selectionPath,selectionHash,caseName,outputPath,...extra]=process.argv.slice(2);
let output,root,owned=[],containRegistered;
try {
  if(extra.length||!selectionPath||!outputPath||!CASES.includes(caseName)||!/^[a-f0-9]{64}$/.test(selectionHash??''))throw new Error('arguments_invalid');
  if(process.platform!=='linux'||fs.readdirSync('/sys/class/net').some(name=>name!=='lo'))throw new Error('network_none_required');
  // Require a root-launched clean environment. No credential/NODE_OPTIONS or
  // user configuration inheritance, including in companion initialization.
  const permitted=new Set(['PATH','LANG','LC_ALL','TZ','HOME']);
  if(Object.keys(process.env).some(key=>!permitted.has(key)))throw new Error('clean_parent_environment_required');
  if(process.execArgv.length!==0)throw new Error('parent_loader_options_forbidden');
  const raw=readPinnedBytes(selectionPath,selectionHash,MANIFEST_LIMIT);
  const selection=validateSelection(JSON.parse(raw));
  for(const [path,hash]of Object.entries(selection.files))verifyFile(path,hash);
  if(fs.realpathSync(process.execPath)!==fs.realpathSync(selection.node_path))throw new Error('parent_node_mismatch');
  const versionPath=join(selection.core_root,'runtime/dist/VERSION');
  const version=JSON.parse(readPinnedBytes(versionPath,selection.files[versionPath],65536));
  if(!['runtimeVersion','commit','buildTime'].every(key=>version[key]===selection.expected_build[key]))throw new Error('core_version_mismatch');
  const here=dirname(fileURLToPath(import.meta.url));
  // These modules were reviewed separately; root must include their exact bytes
  // and this probe's complete closure in selection.files before any case runs.
  const required=[
    'probe.mjs','control.mjs','selection.mjs','verify-files.mjs','guard.mjs','sentinel.mjs',
    '../real-parent-v5/lifecycle.mjs','../real-parent-adapters-v1/adapters.mjs',
    '../real-parent-adapters-v1/load-bridge.mjs','../real-parent-adapters-v1/pins.mjs',
  ].map(path=>resolve(here,path));
  if(!required.every(path=>selection.files[path]))throw new Error('probe_closure_pin_missing');
  output=resolve(outputPath);if(output!==outputPath)throw new Error('output_absolute_required');
  fs.mkdirSync(output,{mode:0o700}); // exclusive, never reuse another attempt
  root=fs.mkdtempSync('/tmp/lcp-');const home=join(root,'home'),daemonHome=join(home,'agenc');
  fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(daemonHome,{mode:0o700});
  fs.mkdirSync(join(daemonHome,'oom-snapshots'),{mode:0o700});
  // Companion transitive initialization also sees only this fresh parent home.
  process.env.HOME=home;
  let parentFetchDenied=0;
  globalThis.fetch=async()=>{parentFetchDenied++;throw new Error('probe_forbids_fetch');};
  const {loadCanonicalBridge}=await import('../real-parent-adapters-v1/load-bridge.mjs');
  const api=await loadCanonicalBridge(selection.bridge);
  const control=await import('./control.mjs');const {runCase}=control;
  containRegistered=control.containRegistered;
  const env=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:home,
    USER:'benchmark',LOGNAME:'benchmark',CI:'1',AGENC_HOME:daemonHome,
    LIGHT_CANONICAL_PROBE_CASE:caseName});
  function start(args,name,ipc,register){
    const fd=fs.openSync(join(root,name+'.log'),'wx',0o600);
    try {
      const child=spawn(selection.node_path,args,{cwd:daemonHome,env,stdio:['ignore',fd,fd,...(ipc?['ipc']:[])]});
      // Track and register synchronously before any fallible close/setup.
      const record={child,exited:false,closed:false};owned.push(record);
      child.on('error',()=>{});child.once('exit',()=>{record.exited=true;});child.once('close',()=>{record.closed=true;});
      register(child);
    } finally {fs.closeSync(fd);}
  }
  let changedCookie=false;
  const result=await runCase({caseName,api,expectedBuild:selection.expected_build,daemonHome,userHome:home,
    spawnOwner:register=>start(['--max-old-space-size=4096','--heapsnapshot-near-heap-limit=1',
      '--diagnostic-dir='+join(daemonHome,'oom-snapshots'),'--import='+join(here,'guard.mjs'),
      join(selection.core_root,'runtime/bin/agenc'),'daemon','start','--foreground'],'owner',true,register),
    spawnSentinel:register=>start([join(here,'sentinel.mjs')],'readiness-sentinel',false,register),
    corruptFreshCookie(){
      if(changedCookie)throw new Error('refusal_already_injected');
      // Canonical daemon-control.ts exports filename daemon.cookie. This is
      // only our new private home's cookie; never discover or use a user home.
      const fd=fs.openSync(join(daemonHome,'daemon.cookie'),fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);
      try {
        const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1)throw new Error('cookie_not_owned_regular');
        fs.ftruncateSync(fd,0);fs.writeFileSync(fd,'deliberately-invalid-probe-cookie\n');fs.fsyncSync(fd);changedCookie=true;
      }finally{fs.closeSync(fd);}
    },
  });
  if(parentFetchDenied!==0)throw new Error('unexpected_parent_fetch');
  const record={...result,parent_fetch_denied:parentFetchDenied,selection_sha256:selectionHash,source_revision:selection.source_revision,
    bridge_sha256:selection.bridge.sha256,expected_build:selection.expected_build,fixture_root:root,
    guard:'fetch_forbidden_no_synthetic_response',cookie_mutated:changedCookie};
  durableNew(join(output,'result.json'),record);
  console.log(JSON.stringify({case:caseName,case_pass:result.case_pass,contained:result.contained,
    requires_container_teardown:result.requires_container_teardown}));
  // Explicit exit closes the parent's outstanding I/O handles, but does not
  // substitute for root destroying this single-use network-none container.
  process.exit(result.case_pass?0:2);
} catch {
  // Do not print raw exceptions/cookie/path-derived response text. Only exact
  // children returned to this invocation may be signalled on unexpected failure.
  if(containRegistered)await containRegistered(owned);
  const failure={case:CASES.includes(caseName)?caseName:'invalid',case_pass:false,
    contained:false,requires_container_teardown:true,error:'probe_failed',fixture_root:root??null};
  if(output){try{durableNew(join(output,'failure.json'),failure);}catch{}}
  console.error(JSON.stringify({error:'probe_failed',requires_container_teardown:true}));
  process.exit(2);
}
