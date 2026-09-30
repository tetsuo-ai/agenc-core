import { isAbsolute, normalize } from 'node:path';
import { API_NAMES, SOURCE_REVISION } from './pins.mjs';

const tupleFields = ['pid','instanceId','processStart','runtimeVersion','commit','buildTime'];
const fail = reason => { throw new Error(reason); };
const need = (condition,reason) => { if(!condition)fail(reason); };
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= 60_000;

// Trusted injected canonical API, never a transport mock in a real parent.
// expectedBuild must come from root's independently selected immutable VERSION
// inventory, not from the sidecar this adapter is about to read.
export function createIdentityAdapters({api,ownedPid,daemonHome,userHome,expectedBuild,
  requestMs=1000,operationMs=1500,readyPollMs=25,maxReadyReads=100,
  platform=process.platform,timers=globalThis}) {
  need(platform==='linux','linux_only'); // Canonical Linux identity uses /proc, no helper process.
  for(const name of API_NAMES)need(typeof api?.[name]==='function','canonical_api_missing');
  need(Number.isSafeInteger(ownedPid)&&ownedPid>1,'owned_pid_invalid');
  for(const home of [daemonHome,userHome])need(typeof home==='string'&&isAbsolute(home)&&
    normalize(home)===home&&home.trim()===home,'home_invalid');
  need(duration(requestMs)&&duration(operationMs)&&requestMs<operationMs&&duration(readyPollMs),'deadline_invalid');
  need(Number.isSafeInteger(maxReadyReads)&&maxReadyReads>=1&&maxReadyReads<=1000,'read_limit_invalid');
  const build=Object.freeze(Object.fromEntries(['runtimeVersion','commit','buildTime'].map(key=>{
    need(typeof expectedBuild?.[key]==='string'&&expectedBuild[key].length>0,'build_invalid');
    return [key,expectedBuild[key]];
  })));
  need(build.commit===SOURCE_REVISION,'build_revision_mismatch');
  const env=Object.freeze({AGENC_HOME:daemonHome,HOME:userHome,AGENC_DAEMON_REQUEST_TIMEOUT_MS:String(requestMs)});
  // Requests use only env/userHome. Supply the rest of the host contract with
  // denied capabilities, never createNodeDaemonCliHost's ambient env/process controls.
  const denied=()=>fail('host_capability_denied');
  const host=Object.freeze({env,userHome,platform:'linux',pid:process.pid,
    entrypointPath:'',execPath:'',spawnDetachedDaemon:denied,isPidRunning:denied,
    terminatePid:denied,sleep:denied});
  need(api.resolveAgenCDaemonHome(env,userHome)===daemonHome,'home_resolution_mismatch');
  need(api.resolveAgenCDaemonRequestTimeoutMs(env,requestMs)===requestMs,'request_timeout_mismatch');
  const sidecarPath=api.resolveAgenCDaemonRuntimeInfoPath(daemonHome);
  let poisoned=false,closed=false,outstanding=false,firstSidecar=true,shutdownStarted=false;
  let authenticated=null;
  const checked=value=>{
    need(api.isAgenCDaemonInstanceIdentity(value),'identity_invalid');
    const copy=Object.freeze(Object.fromEntries(tupleFields.map(key=>[key,value[key]])));
    need(copy.pid===ownedPid,'identity_owner_mismatch');
    need(['runtimeVersion','commit','buildTime'].every(key=>copy[key]===build[key]),'identity_build_mismatch');
    return copy;
  };
  const state=()=>Object.freeze({poisoned,closed,outstanding,shutdown_started:shutdownStarted});
  async function operation(work,signal) {
    if(signal?.aborted){poisoned=true;fail('operation_aborted');}
    need(!closed&&!poisoned,'adapter_unavailable');
    if(outstanding){poisoned=true;fail('operation_overlap');}
    outstanding=true;
    let timer,onAbort;
    const check=()=>need(!closed&&!poisoned&&!signal?.aborted,'operation_aborted');
    const stopped=new Promise((_,reject)=>{
      const stop=reason=>{poisoned=true;reject(new Error(reason));};
      timer=timers.setTimeout(()=>stop('operation_timeout'),operationMs);
      onAbort=()=>stop('operation_aborted');
      signal?.addEventListener('abort',onAbort,{once:true});
    });
    // The slot is held until the REAL operation settles, not just Promise.race.
    // Attach rejection handling even if timeout wins. No retry or background queue.
    const pending=Promise.resolve().then(()=>{check();return work(check);})
      .then(value=>{check();return value;})
      .finally(()=>{outstanding=false;});
    try { return await Promise.race([pending,stopped]); }
    catch {poisoned=true;fail('adapter_operation_failed');}
    finally {timers.clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  const sleep=()=>new Promise(resolve=>timers.setTimeout(resolve,readyPollMs));
  const identityAdapter=Object.freeze({
    readSidecar(signal){return operation(async check=>{
      const attempts=firstSidecar?maxReadyReads:1;firstSidecar=false;
      for(let attempt=0;attempt<attempts;attempt++) {
        check();const info=api.readDaemonRuntimeInfo(sidecarPath);check();
        if(info!==null)return checked(api.daemonInstanceIdentityFromRuntimeInfo(info));
        if(attempt+1<attempts){await sleep();check();}
      }
      fail('sidecar_unavailable');
    },signal);},
    readProcessStart(pid,signal){return operation(async check=>{
      need(pid===ownedPid,'process_owner_mismatch');check();
      // No override: Linux canonical implementation must read actual /proc.
      const token=await api.readAgenCDaemonProcessStart(pid);check();
      need(typeof token==='string'&&token.length>0,'process_identity_unavailable');return token;
    },signal);},
    requestAuthenticatedIdentity(signal){return operation(async check=>{
      check();const value=await api.requestAgenCDaemonInstanceIdentity(host);check();
      const result=checked(value);authenticated=result;return result;
    },signal);},
  });
  async function requestShutdown(bound,signal) {
    return operation(async check=>{
      const expected=checked(bound);
      need(authenticated!==null&&api.sameAgenCDaemonInstanceIdentity(authenticated,expected),'shutdown_not_authenticated');
      need(!shutdownStarted,'shutdown_already_started');shutdownStarted=true;
      check();await api.requestAgenCDaemonShutdown(host,expected);check();
      // Canonical void return means its full expected-identity initialize and
      // instance-bound shutdown response checks succeeded, not a locally guessed ack.
      return Object.freeze({shuttingDown:true,instanceId:expected.instanceId});
    },signal);
  }
  return Object.freeze({identityAdapter,requestShutdown,state,expectedBuild:build,
    close(){closed=true;poisoned=true;}});
}
