import {supervise} from '../real-parent-v5/lifecycle.mjs';
import {createIdentityAdapters} from '../real-parent-adapters-v1/adapters.mjs';

export const CASES=Object.freeze(['normal','owner-exit-before-readiness','authenticated-identity-refusal']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function containRegistered(records,timeoutMs=1000){
  const pending=[];
  for(const record of records){
    if(record.closed)continue;
    pending.push(new Promise(resolve=>{
      let timer;
      const done=()=>{clearTimeout(timer);record.child.removeListener('close',done);resolve();};
      record.child.once('close',done);timer=setTimeout(done,timeoutMs);
      if(!record.exited&&!record.closed){try{record.child.kill('SIGKILL');}catch{}}
      if(record.closed)done();
    }));
  }
  await Promise.all(pending);
  return records.every(record=>record.closed===true);
}

// Production launch passes the real pinned bridge API. Test injection is only
// through this exported seam, never through the probe command-line interface.
export async function runCase({caseName,api,expectedBuild,daemonHome,userHome,
  spawnOwner,spawnSentinel,corruptFreshCookie,
  platform=process.platform,readyMs=15000,operationMs=12000,requestMs=1500,
  taskMs=3000,stopMs=3000,closeMs=3000,killGraceMs=1000,drainMs=2000}) {
  if(!CASES.includes(caseName))throw new Error('invalid_case');
  for(const value of [readyMs,operationMs,requestMs,taskMs,stopMs,closeMs,killGraceMs,drainMs])
    if(!Number.isSafeInteger(value)||value<1||value>60000)throw new Error('invalid_deadline');
  const observed={sentinel_starts:0,identity_attempts:0,identity_successes:0,
    shutdown_attempts:0,refusal_injected:false,identity_refusal_confirmed:false,publication_calls:0};
  // Observe only the exact source-owned static refusal category before the
  // frozen adapter sanitizes it. No substituted result, raw message export,
  // extra RPC, or retry. Source: daemon-cli.ts:4193 + daemon-control.ts:2530.
  const observedApi=Object.freeze({...api,
    async requestAgenCDaemonInstanceIdentity(host){
      try{return await api.requestAgenCDaemonInstanceIdentity(host);}
      catch(error){
        if(error instanceof Error&&error.message==='daemon connection authentication failed')
          observed.identity_refusal_confirmed=true;
        throw error;
      }
    },
  });
  let adapters,owner;
  const identityAdapter={
    readSidecar:signal=>adapters.identityAdapter.readSidecar(signal),
    readProcessStart:(pid,signal)=>adapters.identityAdapter.readProcessStart(pid,signal),
    async requestAuthenticatedIdentity(signal){
      if(caseName==='authenticated-identity-refusal'&&!observed.refusal_injected){
        // Only after sidecar and OS token proof have reached this stage. This
        // changes the fresh owned cookie, not the canonical API or its return.
        corruptFreshCookie();observed.refusal_injected=true;
      }
      observed.identity_attempts++;
      const result=await adapters.identityAdapter.requestAuthenticatedIdentity(signal);
      observed.identity_successes++;return result;
    },
  };
  let lifecycle;
  try {
    lifecycle=await supervise({arm:'light',expectedMessages:0,expectedBuild,
      readyMs,taskMs,stopMs,closeMs,killGraceMs,identityAdapter,
      spawnOwner(register){
        spawnOwner(child=>{
          // Register with v5 BEFORE adapter validation or any fallible setup.
          register(child);owner=child;
          adapters=createIdentityAdapters({api:observedApi,ownedPid:child.pid,daemonHome,userHome,
            expectedBuild,platform,requestMs,operationMs,maxReadyReads:1000,readyPollMs:25});
        });
      },
      spawnTask(register){observed.sentinel_starts++;spawnSentinel(register);},
      async requestShutdown(bound,signal){observed.shutdown_attempts++;return adapters.requestShutdown(bound,signal);},
      // No publication callback: this layer never issues a capture commit.
    });
  } finally {adapters?.close();}
  // Closing the adapter does not cancel its canonical cookie/socket/fs work.
  // Retain the parent/owned fixture until settled or explicitly quarantined.
  const deadline=Date.now()+drainMs;
  while(adapters?.state().outstanding&&Date.now()<deadline)await sleep(Math.min(10,Math.max(1,deadline-Date.now())));
  const adapter=adapters?.state()??null;
  const contained=lifecycle.cleanup_complete===true&&adapter?.outstanding===false;
  const noUnexpectedChannel=!lifecycle.issues.some(reason=>
    reason==='unexpected_channel_message'||reason==='invalid_owner_message');
  let expected=false;
  if(caseName==='normal')expected=lifecycle.valid===true&&observed.sentinel_starts===1&&
    observed.identity_successes===3&&observed.shutdown_attempts===1;
  if(caseName==='owner-exit-before-readiness')expected=lifecycle.valid===false&&
    lifecycle.owner?.code===73&&observed.sentinel_starts===0&&observed.identity_attempts===0&&observed.shutdown_attempts===0;
  if(caseName==='authenticated-identity-refusal')expected=lifecycle.valid===false&&
    observed.refusal_injected&&observed.identity_refusal_confirmed&&observed.identity_attempts===1&&observed.identity_successes===0&&
    observed.sentinel_starts===0&&observed.shutdown_attempts===0&&lifecycle.owner?.kill_attempted===true;
  return Object.freeze({case:caseName,scope:'canonical_daemon_control_no_task_no_provider',
    case_pass:expected&&contained&&noUnexpectedChannel,expected_outcome_observed:expected,contained,
    requires_container_teardown:!contained,owner_pid:owner?.pid??null,
    task_cli_calls:0,...observed,adapter,lifecycle});
}
