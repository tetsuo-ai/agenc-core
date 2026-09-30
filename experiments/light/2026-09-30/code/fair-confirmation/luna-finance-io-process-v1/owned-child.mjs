import { fork } from 'node:child_process';

// Small fixture-local containment gate, not a reusable production supervisor.
let sequenceBlocked = false;
export function assertSequenceSafe() {
  if (sequenceBlocked) throw new Error('Synthetic child sequence blocked');
}
const fail = () => new Error('Synthetic child lifecycle refused');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const id = value => keys(value, ['dev', 'ino']) && typeof value.dev === 'string' && typeof value.ino === 'string'
  && /^[0-9]+$/.test(value.dev) && /^[0-9]+$/.test(value.ino);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function startOwned(payload) {
  assertSequenceSafe();
  let child;
  try { child = fork(new URL('./child.mjs', import.meta.url), [JSON.stringify(payload)], {
    cwd: payload.options.root, env: {}, execPath: process.execPath, execArgv: [],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json',
  }); } catch { sequenceBlocked = true; throw fail(); }
  let spawned = false, disconnected = false, exit = null, closed = false, invalid = false;
  let killed = false, observedPid, bytes = 0, pending = '', next = 'ready';
  const messages = [], waits = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let deadline, containment;
  function wake() { for (const callback of [...waits]) callback(); }
  function killOwned() {
    if (closed || killed) return;
    // ChildProcess object is the only kill target; never a PID lookup or group.
    if (!spawned || child.pid !== observedPid) { sequenceBlocked = true; return; }
    killed = true;
    if (exit === null) {
      try { if (!child.kill('SIGKILL')) sequenceBlocked = true; }
      catch { sequenceBlocked = true; }
    }
  }
  function invalidate() {
    invalid = true;
    // An immutable resolved result cannot be revoked. Late contradictory
    // evidence instead permanently refuses every subsequent fixture launch.
    if (closed) sequenceBlocked = true;
  }
  function reject() { invalidate(); killOwned(); }
  function accept(message) {
    if (!spawned || disconnected || exit || closed || message.pid !== observedPid) return reject();
    if (next === 'ready' && keys(message, ['type', 'pid', 'mode']) && message.type === 'ready' && message.mode === payload.mode) {
      next = payload.mode === 'normal' ? 'result' : 'boundary';
    } else if (next === 'boundary' && keys(message, ['type', 'pid', 'mode', 'lock', 'owner', 'ownerSha256', 'rowSha256', 'rowBytes', 'priorSyncs'])
      && message.type === 'boundary' && message.mode === payload.mode && id(message.lock) && id(message.owner)
      && hash(message.ownerSha256) && hash(message.rowSha256) && Number.isSafeInteger(message.rowBytes) && message.rowBytes > 0 && message.rowBytes < 4096
      && JSON.stringify(message.priorSyncs) === '["owner","lock","root"]') {
      next = payload.mode === 'crash' ? 'closed' : 'result';
    } else if (next === 'result' && message.type === 'result' && typeof message.poisoned === 'boolean'
      && ((keys(message, ['type', 'pid', 'state', 'exposure', 'poisoned']) && message.state === 'committed' && message.exposure === '10000000' && !message.poisoned)
        || (keys(message, ['type', 'pid', 'state', 'code', 'poisoned']) && message.state === 'refused' && ['LOCKED', 'STOPPED', 'OWNED_BARRIER_RETAINED'].includes(message.code)))) {
      next = 'closed';
    } else return reject();
    messages.push(Object.freeze(message)); wake();
  }
  child.on('spawn', () => {
    if (spawned || disconnected || exit || !Number.isSafeInteger(child.pid) || child.pid <= 0) return reject();
    spawned = true; observedPid = child.pid;
    if (invalid) killOwned();
  });
  child.on('error', reject);
  child.on('message', reject); // No unexpected IPC message is ignored.
  child.stdin.on('error', reject);
  child.stdout.on('error', reject); child.stderr.on('error', reject);
  child.stdout.on('data', chunk => {
    if (closed) return reject();
    if (invalid) return;
    bytes += chunk.length;
    if (bytes > 4096) return reject();
    try {
      pending += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        accept(JSON.parse(line));
        if (invalid) return;
      }
    } catch { reject(); }
  });
  child.stderr.on('data', reject); // Never echo child exception/private payloads.
  child.on('disconnect', () => { if (!spawned || disconnected || closed) invalidate(); disconnected = true; });
  child.on('exit', (code, signal) => {
    if (!spawned || exit || closed) invalidate();
    else exit = Object.freeze({ code, signal });
  });
  child.on('close', (code, signal) => {
    if (closed) { sequenceBlocked = true; return; }
    closed = true; clearTimeout(deadline); clearTimeout(containment);
    try { pending += decoder.decode(); } catch { invalid = true; }
    const confirmed = spawned && disconnected && exit !== null && exit.code === code && exit.signal === signal;
    if (!confirmed) sequenceBlocked = true;
    if (!confirmed || pending !== '' || next !== 'closed') invalid = true;
    resolveDone(Object.freeze({ confirmed, invalid, pid: observedPid, code, signal, messages: Object.freeze([...messages]) })); wake();
  });
  deadline = setTimeout(() => {
    reject();
    containment = setTimeout(() => {
      if (closed) return;
      sequenceBlocked = true;
      resolveDone(Object.freeze({ confirmed: false, invalid: true, messages: Object.freeze([...messages]) })); wake();
    }, 2000);
  }, 10000);
  function waitFor(type) {
    return new Promise((resolve, rejectWait) => {
      const check = () => {
        const message = messages.find(value => value.type === type);
        if (message && !invalid) { waits.delete(check); resolve(message); }
        else if (closed || sequenceBlocked) { waits.delete(check); rejectWait(fail()); }
      };
      waits.add(check); check();
    });
  }
  function send(command) {
    if (invalid || closed || exit || disconnected || !spawned || !['G', 'R', 'K', 'X'].includes(command)) throw fail();
    child.stdin.write(command, error => { if (error) reject(); });
  }
  async function contain() {
    if (!closed) killOwned();
    const result = await done;
    if (!result.confirmed) { sequenceBlocked = true; throw fail(); }
    return result;
  }
  return Object.freeze({ waitFor, send, done, contain });
}
