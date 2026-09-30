// Offline prospective lifecycle seam. No Core/Pi launcher, network, filesystem,
// provider observer or financial operation. Adapters are trusted injected code.
const fields = ['pid','instanceId','processStart','runtimeVersion','commit','buildTime'];
const safeReasons = new WeakMap();
const failure = reason => { const error=new Error(reason);safeReasons.set(error,reason);return error; };
// Only internally minted static reasons are reportable. Never inspect an
// injected thrown value/property (it may be null, secret-bearing or a getter).
const reasonOf = (error,fallback) => safeReasons.get(error) ?? fallback;
const need = (value, reason) => { if (!value) throw failure(reason); };
export function identity(value) {
  need(value && Number.isSafeInteger(value.pid) && value.pid > 1, 'identity_pid');
  for (const key of fields.slice(1)) need(typeof value[key] === 'string' &&
    value[key].length > 0 && value[key].length <= 1024, 'identity_field');
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}
export const sameIdentity = (a, b) => fields.every(key => a[key] === b[key]);

// Mirrors the canonical proveAgenCDaemonCliInstance sequence. In a real adapter,
// requestAuthenticatedIdentity MUST use cookie-authenticated daemon.identity;
// a sidecar or status text alone is not an implementation of that callback.
export async function proveIdentity(adapter, pid, build, signal) {
  const before = identity(await adapter.readSidecar(signal));
  need(before.pid === pid, 'identity_owner_mismatch');
  need(['runtimeVersion','commit','buildTime'].every(k => before[k] === build[k]), 'identity_build_mismatch');
  const first = await adapter.readProcessStart(pid, signal);
  need(first === before.processStart, 'identity_process_mismatch');
  const authenticated = identity(await adapter.requestAuthenticatedIdentity(signal));
  need(sameIdentity(before, authenticated), 'identity_authenticated_mismatch');
  const after = identity(await adapter.readSidecar(signal));
  const second = await adapter.readProcessStart(pid, signal);
  need(sameIdentity(before, after) && second === first, 'identity_changed_during_proof');
  return before;
}

function deadline(promise, ms, timers, reason) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(failure(reason)), ms);
  });
  return Promise.race([promise, expired]).finally(() => timers.clearTimeout(timer));
}

class OwnedChild {
  constructor(child, role, ownerMessages, issues) {
    this.child=child;this.role=role;this.issues=issues;
    this.spawned=false;this.exited=false;this.closed=false;this.disconnected=false;
    this.exitObserved=false;this.lifecycleInvalid=false;
    this.errors=false;this.channelInvalid=false;this.joined=false;
    this.timedOut=false;this.killAttempted=false;this.killFailed=false;
    this.code=null;this.signal=null;this.closeCode=null;this.closeSignal=null;
    this.ended=new Promise(resolve=>{this.resolveEnded=resolve;});
    this.spawnedPromise=new Promise(resolve=>{this.resolveSpawned=resolve;});
    this.closedPromise=new Promise(resolve=>{this.resolveClosed=resolve;});
    const invalid=reason=>{this.lifecycleInvalid=true;issues.add(role+'_'+reason);this.resolveEnded();};
    child.on('spawn',()=>{
      if(this.spawned||this.disconnected||this.exitObserved||this.closed||this.errors){invalid('unexpected_spawn');return;}
      this.spawned=true;this.resolveSpawned();
    });
    child.on('error',()=>{
      if(this.closed)invalid('error_after_close');
      this.errors=true;issues.add(role+'_error');this.resolveEnded();
    });
    child.on('exit',(code,signal)=>{
      if(this.exitObserved){invalid('duplicate_exit');return;}
      this.exitObserved=true; // Never signal after ANY exit observation.
      if(!this.spawned||this.closed){invalid('out_of_order_exit');return;}
      this.exited=true;this.code=code;this.signal=signal;this.resolveEnded();
    });
    child.on('close',(code,signal)=>{
      if(this.closed){invalid('duplicate_close');return;}
      if(!this.exited)invalid('close_before_exit');
      if(this.exited&&(code!==this.code||signal!==this.signal))invalid('exit_close_mismatch');
      // Close still confirms that the owned resource is closed, but cannot
      // overwrite first exit evidence or erase an ordering violation.
      this.closed=true;this.closeCode=code;this.closeSignal=signal;
      this.resolveEnded();this.resolveClosed();
    });
    child.on('disconnect',()=>{
      if(this.disconnected){invalid('duplicate_disconnect');return;}
      if(this.closed)invalid('disconnect_after_close');
      this.disconnected=true;this.resolveEnded();
    });
    child.on('message',message=>{
      if (role!=='owner' || !this.spawned || this.disconnected || this.exited || this.closed || this.errors || child.connected!==true) {
        this.channelInvalid=true;this.resolveEnded();issues.add('unexpected_channel_message');return;
      }
      // Test probe messages, NOT durable-publication acknowledgments.
      if (!message || Object.keys(message).sort().join()!=='connected,kind,ordinal,pid' ||
          message.kind!=='lifecycle-probe-v5' || message.pid!==child.pid ||
          message.ordinal!==ownerMessages.length+1 || message.connected!==true) {
        this.channelInvalid=true;this.resolveEnded();issues.add('invalid_owner_message');return;
      }
      ownerMessages.push(Object.freeze({...message}));
    });
  }
  live() { return !this.exitObserved && !this.closed && !this.errors && !this.disconnected && !this.channelInvalid && !this.lifecycleInvalid; }
  clean() { return this.spawned && this.exited && this.closed && this.code===0 &&
    this.signal===null && this.closeCode===this.code && this.closeSignal===this.signal &&
    !this.errors && !this.timedOut && !this.lifecycleInvalid && !this.channelInvalid; }
  async join(ms, grace, timers) {
    if(this.joined)return this.facts();
    this.joined=true;
    try { await deadline(this.closedPromise,ms,timers,this.role+'_timeout'); }
    catch {
      this.timedOut=true;this.issues.add(this.role+'_timeout');
      // Never signal a PID discovered from a file, and never signal after an
      // exit event (its numeric PID may already be reusable).
      if (!this.exitObserved && !this.closed && Number.isSafeInteger(this.child.pid)) {
        this.killAttempted=true;
        try { if (!this.child.kill('SIGKILL')) this.killFailed=true; }
        catch { this.killFailed=true; }
        if(this.killFailed)this.issues.add(this.role+'_kill_failed');
      }
      try { await deadline(this.closedPromise,grace,timers,this.role+'_close_unconfirmed'); }
      catch { this.issues.add(this.role+'_close_unconfirmed'); }
    }
    return this.facts();
  }
  facts() { return {spawned:this.spawned,exited:this.exited,closed:this.closed,
    disconnected:this.disconnected,code:this.code,signal:this.signal,
    close_code:this.closeCode,close_signal:this.closeSignal,lifecycle_invalid:this.lifecycleInvalid,
    error:this.errors,timeout:this.timedOut,kill_attempted:this.killAttempted,
    kill_failed:this.killFailed}; }
}

// Close a parent's log FD even when spawn throws. register runs synchronously
// immediately after successful spawn, before any fallible close/output step.
export function spawnWithLog({openLog,closeLog,spawn,register}) {
  const fd=openLog();
  try { const child=spawn(fd);register(child);return child; }
  finally { closeLog(fd); }
}

export async function supervise({arm,spawnOwner,spawnTask,identityAdapter,expectedBuild,
  expectedMessages,requestShutdown,publish,timers=globalThis,
  readyMs=1000,taskMs=1000,stopMs=1000,closeMs=1000,killGraceMs=100}) {
  need(['light','pi'].includes(arm),'invalid_arm');
  need(Number.isSafeInteger(expectedMessages)&&expectedMessages>=0,'invalid_message_count');
  for(const ms of [readyMs,taskMs,stopMs,closeMs,killGraceMs])need(Number.isSafeInteger(ms)&&ms>0,'invalid_deadline');
  const issues=new Set(),messages=[],tracked=[];
  let owner,task,bound,shutdown='not_attempted',publication='not_attempted';
  const register=(child,role)=>{
    need(child && typeof child.on==='function' && typeof child.kill==='function','invalid_child');
    need(!tracked.some(item=>item.child===child),'duplicate_child');
    const record=new OwnedChild(child,role,messages,issues);tracked.push(record);return record;
  };
  // Spawn callbacks must register synchronously before any later fallible work.
  // This makes log-close errors unable to hide an already-created owned child.
  const launch=(fn,role)=>{
    let record;
    fn(child=>{need(!record,'duplicate_registration');record=register(child,role);
      if(role==='owner')owner=record;else task=record;});
    need(record,'missing_registration');return record;
  };
  const guarded=async(work,ms,reason)=>{
    const abort=new AbortController();
    try {
      const ended=owner.ended.then(()=>{throw failure('owner_ended_before_task');});
      return await deadline(Promise.race([Promise.resolve().then(()=>work(abort.signal)),ended]),ms,timers,reason);
    } finally { abort.abort(); }
  };
  const revalidate=async(signal)=>{
    need(owner.live(),'owner_not_live');
    const current=await proveIdentity(identityAdapter,owner.child.pid,expectedBuild,signal);
    need(!bound||sameIdentity(bound,current),'owner_instance_changed');
    need(owner.live(),'owner_not_live');
    return current;
  };
  try {
    launch(spawnOwner,'owner');
    await deadline(Promise.race([owner.spawnedPromise,owner.ended.then(()=>{
      need(owner.spawned,'owner_ended_before_spawn');
    })]),readyMs,timers,'owner_spawn_timeout');
    if(arm==='light') {
      bound=await guarded(revalidate,readyMs,'readiness_timeout');
      await guarded(revalidate,readyMs,'pre_task_identity_timeout');
      launch(spawnTask,'task');
      const facts=await task.join(taskMs,killGraceMs,timers);
      if(!facts.spawned||!facts.exited||facts.code!==0||facts.signal!==null||!facts.closed||facts.error||facts.timeout)issues.add('task_not_successful');
      if(!owner.live())issues.add('owner_ended_before_cleanup');
    } else {
      await owner.join(taskMs,killGraceMs,timers);
    }
  } catch(error) { issues.add(reasonOf(error,'launch_or_task_error')); }
  finally {
    // Shutdown errors must never skip fallback/join. No unbound `daemon stop`:
    // adapter must call the canonical instance-bound shutdown(expectedIdentity).
    try {
      if(arm==='light'&&owner?.live()&&bound) {
        await guarded(revalidate,readyMs,'pre_shutdown_identity_timeout');
        const abort=new AbortController();
        try {
          const ack=await deadline(Promise.resolve().then(()=>requestShutdown(bound,abort.signal)),stopMs,timers,'shutdown_timeout');
          need(ack?.shuttingDown===true&&ack.instanceId===bound.instanceId,'shutdown_ack_mismatch');
          shutdown='acknowledged';
        } finally {abort.abort();}
      }
    } catch(error) {shutdown='failed';issues.add(reasonOf(error,'shutdown_error'));}
    finally {
      // Catch per child: one broken child cannot bypass cleanup of another.
      for(const record of [...tracked].reverse()) {
        if(record.closed)continue;
        try {await record.join(closeMs,killGraceMs,timers);}
        catch {issues.add(record.role+'_cleanup_error');}
      }
    }
  }
  const checkFinal=()=>{
    if(!owner?.clean()||!owner.disconnected)issues.add('owner_not_cleanly_closed');
    if(arm==='light'&&!task?.clean())issues.add('task_not_successful');
    if(messages.length!==expectedMessages)issues.add('message_count_mismatch');
    if(arm==='light'&&shutdown!=='acknowledged')issues.add('shutdown_not_acknowledged');
  };
  checkFinal();
  const facts=()=>({arm,valid:issues.size===0,issues:[...issues].sort(),
    owner:owner?.facts()??null,task:task?.facts()??null,shutdown,publication,
    message_count:messages.length,cleanup_complete:tracked.every(item=>item.closed)});
  // Output failure cannot undo completed cleanup or turn surviving files into
  // success. publish is test-only report persistence, not a financial/capture ack.
  if(issues.size===0 && publish) {
    try {await deadline(Promise.resolve().then(()=>publish(facts())),closeMs,timers,'publication_timeout');publication='returned';}
    catch {publication='failed';issues.add('publication_failed');}
  }
  // The publication callback awaits: repeat validity after that boundary.
  // Terminal listeners are sticky and never mutate previously observed status.
  checkFinal();
  return facts();
}
