import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,readdirSync} from 'node:fs';
import {CORE,verifySelection} from './selection.mjs';
let blocked=false,active=false;
export async function runChild(mode='normal'){
 if(blocked||active||!['normal','task','early_exit','unexpected_ipc','timeout'].includes(mode))throw new Error('Source child sequence refused');
 verifySelection();active=true;
 const root=realpathSync(mkdtempSync('/private/tmp/current-source-child-v1-'));
 mkdirSync(root+'/network-attempts');mkdirSync(root+'/launch-home');
 let child;
 try{child=fork(new URL('./child.mjs',import.meta.url),[mode],{
  execPath:'/opt/homebrew/bin/node',execArgv:['--require',CORE+'/tests/helpers/network-tripwire.cjs'],
  cwd:root,env:{HOME:root+'/launch-home',PATH:'/usr/bin:/bin',SOURCE_CHILD_ROOT:root,
   AGENC_TEST_HERMETIC_RUN_ROOT:root,AGENC_TEST_NETWORK_ATTEMPT_LEDGER:root+'/network-attempts'},
  stdio:['ignore','pipe','pipe','ipc'],serialization:'json'});
 }catch{active=false;blocked=true;throw new Error('Source child spawn refused');}
 return await new Promise(resolve=>{
  let spawned=false,disconnected=false,exit=null,closed=false,invalid=false,killed=false,pid,settled=false;
  let message=null,outputBytes=0,killTimer;
  const finish=result=>{if(settled)return;settled=true;active=false;resolve(Object.freeze(result));};
  const kill=()=>{
   if(closed||exit||killed)return;killed=true;
   if(!spawned||child.pid!==pid){blocked=true;return;}
   try{if(!child.kill('SIGKILL'))blocked=true;}catch{blocked=true;}
  };
  const bad=()=>{invalid=true;if(closed)blocked=true;else kill();};
  const deadline=setTimeout(()=>{
   bad();killTimer=setTimeout(()=>{if(!closed){blocked=true;finish({root,confirmed:false,invalid:true});}},2000);
  },mode==='timeout'?1000:45000);
  child.on('spawn',()=>{if(spawned||disconnected||exit||closed||!Number.isSafeInteger(child.pid))return bad();spawned=true;pid=child.pid;if(invalid)kill();});
  child.on('error',bad);child.stdout.on('error',bad);child.stderr.on('error',bad);
  // Logs are never forwarded. Count bounded incidental Node/core diagnostics;
  // explicit typed IPC is the only success report.
  const count=bytes=>{outputBytes+=bytes.length;if(closed||outputBytes>16384)bad();};
  child.stdout.on('data',count);child.stderr.on('data',count);
  child.on('message',value=>{
   if(!spawned||disconnected||exit||closed||message||value?.kind!=='source-child-v1'||value.pid!==pid||typeof value.ok!=='boolean'||JSON.stringify(value).length>8192)return bad();
   const wanted=value.ok?['kind','pid','ok','result','loader']:['kind','pid','ok','reason','stage','code','module'];
   if(Object.keys(value).sort().join()!==wanted.sort().join())return bad();
   message=Object.freeze(value);
  });
  child.on('disconnect',()=>{if(!spawned||disconnected||closed)bad();disconnected=true;});
  child.on('exit',(code,signal)=>{if(!spawned||exit||closed)return bad();exit=Object.freeze({code,signal});});
  child.on('close',(code,signal)=>{
   if(closed)return bad();closed=true;clearTimeout(deadline);clearTimeout(killTimer);
   const confirmed=spawned&&disconnected&&exit!==null&&exit.code===code&&exit.signal===signal;
   if(!confirmed)blocked=true;
   if(!message||code!==0||signal!==null)invalid=true;
   let networkAttempts=null;
   try{networkAttempts=readdirSync(root+'/network-attempts').length;}
   catch{invalid=true;blocked=true;}
   if(networkAttempts)invalid=true;
   finish({root,confirmed,invalid,pid,code,signal,outputBytes,networkAttempts,message});
  });
 });
}
