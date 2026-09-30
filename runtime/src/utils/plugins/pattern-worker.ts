import { Worker } from 'node:worker_threads'

export type PatternCheck = { pattern: string; entries: unknown[] }
export type PatternDiagnostic = 'startup_timeout' | 'execution_timeout' |
  'input_clone_failed' | 'worker_construction_failed' | 'worker_error' | 'worker_exit' |
  'submission_failed' | 'invalid_message' | 'termination_failed'

// Startup may be scheduled behind other workers. No manifest data or regex is
// sent until ready. Execution still has one 125ms budget for ALL fields/entries,
// not 125ms per pattern. Both stages fail closed; no pooling or retries.
// These are event-loop deadlines, not a hard wall-time bound on synchronous
// cloning, scheduling or cleanup. Late observed messages also fail closed.
const STARTUP_TIMEOUT_MS = 1_000
const MATCH_TIMEOUT_MS = 125
const WORKER_SOURCE = `
  const { parentPort } = require('node:worker_threads');
  parentPort.once('message', checks => {
    const results = [];
    for (const { pattern, entries } of checks) {
      try {
        const regex = new RegExp(pattern, 'u');
        results.push(entries.every(entry => typeof entry !== 'string' || regex.test(entry)) ? 1 : 2);
      } catch { results.push(3); }
    }
    parentPort.postMessage({ type: 'result', results });
  });
  parentPort.postMessage({ type: 'ready' });
`

export function matchConfigPatterns(
  checks: readonly PatternCheck[],
  onDiagnostic?: (cause: PatternDiagnostic) => void,
): Promise<number[]> {
  const count = checks.length
  if (count === 0) return Promise.resolve([])
  const invalid = () => Array<number>(count).fill(3)
  const report = (cause: PatternDiagnostic) => {
    // Diagnostics carry only a fixed category, never patterns, entries or raw
    // exceptions. A failed logging sink cannot change validation or cleanup.
    try { onDiagnostic?.(cause) } catch {}
  }
  // Match the old workerData clone boundary: caller mutation during startup
  // cannot replace the values or change the accepted result count.
  let snapshot: PatternCheck[]
  try { snapshot = structuredClone(checks.map(({ pattern, entries }) => ({ pattern, entries }))) }
  catch { report('input_clone_failed'); return Promise.resolve(invalid()) }
  return new Promise(resolve => {
    let worker: Worker
    try { worker = new Worker(WORKER_SOURCE, { eval: true }) }
    catch { report('worker_construction_failed'); resolve(invalid()); return }
    let settled = false
    let running = false
    let deadlineAt = performance.now() + STARTUP_TIMEOUT_MS
    let deadline: ReturnType<typeof setTimeout>
    const finish = (results: number[], cause?: PatternDiagnostic) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (cause) report(cause)
      resolve(results)
      // Validation is complete independently of cleanup. A termination failure
      // is reported as cleanup uncertainty, not proof that a valid result was
      // incorrect or that the worker stopped. Never reuse it or accept late data.
      try { void worker.terminate().catch(() => report('termination_failed')) }
      catch { report('termination_failed') }
    }
    deadline = setTimeout(() => finish(invalid(), 'startup_timeout'), STARTUP_TIMEOUT_MS)
    worker.on('message', (value: unknown) => {
      if (settled) return
      if (performance.now() >= deadlineAt) {
        finish(invalid(), running ? 'execution_timeout' : 'startup_timeout'); return
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        finish(invalid(), 'invalid_message'); return
      }
      const message = value as { type?: unknown; results?: unknown }
      if (!running && message.type === 'ready' && Object.keys(message).length === 1) {
        running = true
        clearTimeout(deadline)
        deadlineAt = performance.now() + MATCH_TIMEOUT_MS
        deadline = setTimeout(() => finish(invalid(), 'execution_timeout'), MATCH_TIMEOUT_MS)
        try { worker.postMessage(snapshot) }
        catch { finish(invalid(), 'submission_failed') }
        return
      }
      if (running && message.type === 'result' && Object.keys(message).length === 2 &&
          Array.isArray(message.results) && message.results.length === count &&
          message.results.every(result => result === 1 || result === 2 || result === 3)) {
        finish(message.results)
      } else { finish(invalid(), 'invalid_message') }
    })
    worker.on('error', () => finish(invalid(), 'worker_error'))
    worker.on('exit', () => finish(invalid(), 'worker_exit'))
  })
}
