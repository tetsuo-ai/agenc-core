// Offline, test-only proposal. No imports from Core and no provider/storage calls.
import { writeSync } from 'node:fs';

export const VERSION = 'm4-stage-diagnostics-v1';
export const LIMITS = Object.freeze({ bytes: 1048576, records: 2048, line: 512 });
const FLOWS = Object.freeze({
  crash: ['node_preload', 'fixture_entry', 'paths_ready', 'crash_dispatch',
    'reservation_imports_start', 'reservation_imports_ready', 'kernel_ready',
    'journal_bound', 'acquire_start'],
  recover: ['node_preload', 'fixture_entry', 'paths_ready', 'recover_start', 'recover_done'],
  daemon: ['node_preload', 'daemon_entry', 'main_start'],
  marker: ['wait_start', 'marker_observed', 'wait_error'],
  sdk: ['connect_start', 'connect_error', 'connect_ready'],
});
const validScope = scope => Object.hasOwn(FLOWS, scope);
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Deliberately accepts ONLY a known stage, never errors, argv, paths or environment.
// A failed/short write permanently disables this observer, without changing work.
export function createEmitter(scope, {
  write = bytes => writeSync(3, bytes),
  clock = () => process.hrtime.bigint(),
  cpu = () => process.cpuUsage(),
} = {}) {
  if (!validScope(scope)) throw new Error('invalid diagnostic scope');
  let seq = 0;
  let disabled = false;
  return Object.freeze({
    mark(stage) {
      if (disabled) return false;
      try {
        if (!FLOWS[scope].includes(stage) || seq >= LIMITS.records) throw new Error();
        const time = clock();
        const usage = cpu();
        if (typeof time !== 'bigint' || time < 0n ||
            !integer(usage.user) || !integer(usage.system)) throw new Error();
        const bytes = Buffer.from(JSON.stringify({ v: 1, scope, seq,
          stage, ns: String(time), user: usage.user, system: usage.system }) + '\n');
        if (bytes.length > LIMITS.line || write(bytes) !== bytes.length) throw new Error();
        seq++;
        return true;
      } catch {
        disabled = true;
        return false;
      }
    },
    status: () => ({ emitted: seq, disabled }),
  });
}

function follows(scope, previous, stage, index) {
  if (scope === 'sdk') {
    return previous === undefined || previous === 'connect_error'
      ? stage === 'connect_start'
      : previous === 'connect_start' && ['connect_error', 'connect_ready'].includes(stage);
  }
  if (scope === 'marker') {
    return previous === undefined ? stage === 'wait_start'
      : previous === 'wait_start' && ['marker_observed', 'wait_error'].includes(stage);
  }
  return stage === FLOWS[scope][index];
}

export function createCollector(scope) {
  if (!validScope(scope)) throw new Error('invalid diagnostic scope');
  let pending = Buffer.alloc(0);
  let total = 0;
  let bad = false;
  let ended = false;
  const rows = [];
  const fail = () => { bad = true; pending = Buffer.alloc(0); };
  return Object.freeze({
    push(chunk) {
      if (ended) { fail(); return; }
      if (bad) return;
      if (!Buffer.isBuffer(chunk)) { fail(); return; }
      total += chunk.length;
      if (total > LIMITS.bytes) { fail(); return; }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline === -1) break;
        const bytes = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        try {
          if (bytes.length + 1 > LIMITS.line || rows.length >= LIMITS.records) throw new Error();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const row = JSON.parse(text);
          // Canonical fixed-key JSON rejects duplicate keys/extra fields/alternate encodings.
          const canonical = { v: row.v, scope: row.scope, seq: row.seq, stage: row.stage,
            ns: row.ns, user: row.user, system: row.system };
          if (JSON.stringify(canonical) !== text || row.v !== 1 || row.scope !== scope ||
              row.seq !== rows.length || !integer(row.user) || !integer(row.system) ||
              typeof row.ns !== 'string' || !/^(0|[1-9][0-9]{0,24})$/.test(row.ns) ||
              !follows(scope, rows.at(-1)?.stage, row.stage, rows.length)) throw new Error();
          const prior = rows.at(-1);
          if (prior && (BigInt(row.ns) < BigInt(prior.ns) || row.user < prior.user ||
              row.system < prior.system)) throw new Error();
          rows.push(row);
        } catch { fail(); return; }
      }
      if (pending.length >= LIMITS.line) fail();
    },
    end() {
      if (ended) fail();
      ended = true;
      if (pending.length) fail();
    },
    report() {
      const valid = ended && !bad && rows.length > 0;
      return {
        version: VERSION, scope,
        evidence: valid ? 'observed_prefix_only' : 'unknown',
        cause: 'not_established',
        records: rows.length,
        lastObserved: valid ? rows.at(-1).stage : null,
        attempts: scope === 'sdk' && valid
          ? rows.filter(row => row.stage === 'connect_start').length : null,
        // Cap rendered output independently of the bounded internal record buffer.
        segmentCount: valid ? Math.max(0, rows.length - 1) : 0,
        segments: valid ? rows.slice(1).map((row, i) => ({
          from: rows[i].stage, to: row.stage,
          wallMs: Number(BigInt(row.ns) - BigInt(rows[i].ns)) / 1e6,
          cpuUserUs: row.user - rows[i].user,
          cpuSystemUs: row.system - rows[i].system,
        })).slice(-32) : [],
      };
    },
  });
}

// Operation/throw identity, options and existing deadline stay with the caller.
// No retries, cancellation, exception inspection or timer changes are introduced.
export async function observeSdkAttempt(emitter, operation) {
  emitter.mark('connect_start');
  try {
    const value = await operation();
    emitter.mark('connect_ready');
    return value;
  } catch (error) {
    emitter.mark('connect_error');
    throw error;
  }
}

export async function observeMarkerWait(emitter, operation) {
  emitter.mark('wait_start');
  try {
    const value = await operation();
    emitter.mark('marker_observed');
    return value;
  } catch (error) {
    emitter.mark('wait_error');
    throw error;
  }
}

export function createLocalProbe(scope, options = {}) {
  const collector = createCollector(scope);
  const emitter = createEmitter(scope, { ...options,
    write(bytes) { collector.push(bytes); return bytes.length; },
  });
  return { emitter, finish() {
    if (emitter.status().disabled) collector.push(null);
    collector.end();
    return collector.report();
  } };
}

const EMITTER = Symbol.for('agenc.test.m4-stage-diagnostics.v1');
export function installPreload(scope, options) {
  // Preload and fixture imports share exactly one sequence; no second recorder.
  if (globalThis[EMITTER] !== undefined) throw new Error('duplicate diagnostic preload');
  const emitter = createEmitter(scope, options);
  globalThis[EMITTER] = emitter;
  emitter.mark('node_preload');
}
export function mark(stage) {
  // Disabled by default. Merely importing this helper has no writes/timers.
  return globalThis[EMITTER]?.mark(stage) ?? false;
}
