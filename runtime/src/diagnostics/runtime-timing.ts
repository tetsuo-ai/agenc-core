/** Opt-in, payload-free runtime timing. Each process owns its JSONL file.
 * A buffered, best-effort diagnostic sink must never become a durability barrier.
 */
import { appendFileSync } from "node:fs";

const output = process.env.AGENC_RUNTIME_TIMING;
const enabled = Boolean(output);
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;

export function flushRuntimeTiming(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!output || pending.length === 0) return;
  const lines = pending;
  pending = [];
  try { appendFileSync(`${output}.${process.pid}.jsonl`, lines.join(""), { mode: 0o600 }); }
  catch { /* Diagnostics cannot change runtime outcomes. */ }
}

if (enabled) process.on("exit", flushRuntimeTiming);

export function runtimeSpan(
  name: string,
  fields?: Readonly<Record<string, string | number>>,
): () => void {
  if (!enabled) return noop;
  const start = performance.now();
  const id = ++sequence;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pending.push(JSON.stringify({ name, id, pid: process.pid,
      start_ms: performance.timeOrigin + start,
      duration_ms: performance.now() - start, ...fields }) + "\n");
    // Bounded memory even when a task produces an unusually large event stream.
    if (pending.length >= 4096) flushRuntimeTiming();
    else timer ??= setTimeout(flushRuntimeTiming, 100).unref();
  };
}
function noop(): void {}

export function timedRuntime<T>(
  name: string, operation: () => Promise<T>,
  fields?: Readonly<Record<string, string | number>>,
): Promise<T> {
  if (!enabled) return operation();
  const end = runtimeSpan(name, fields);
  try {
    return operation().then(
      value => { end(); return value; },
      error => { end(); throw error; },
    );
  } catch (error) { end(); return Promise.reject(error); }
}
