import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

/** Opt-in local diagnostics. No arguments, paths, output or credentials. */
export type ToolStage = "permission_policy" | "hooks" | "admission" |
  "sandbox_broker" | "execution" | "result_sealing" | "persistence" | "ui_fanout";
const STAGES: readonly ToolStage[] = ["permission_policy", "hooks", "admission",
  "sandbox_broker", "execution", "result_sealing", "persistence", "ui_fanout"];
interface Timing {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly stages: Record<ToolStage, number>;
  path: "durable" | "read_only";
}
interface Span { readonly timing: Timing; readonly stage: ToolStage; childrenMs: number }
const active = new AsyncLocalStorage<Span>();
const pending = new WeakMap<object, Map<string, Timing>>();

export function withToolTiming<T>(session: object, callId: string, toolName: string, run: () => T): T {
  if (!process.env.AGENC_TOOL_TIMINGS_FILE) return run();
  let calls = pending.get(session);
  if (!calls) { calls = new Map(); pending.set(session, calls); }
  const timing: Timing = { callId, toolName, startedAt: performance.now(), path: "durable",
    stages: Object.fromEntries(STAGES.map(stage => [stage, 0])) as Record<ToolStage, number> };
  calls.set(callId, timing);
  return active.run({ timing, stage: "permission_policy", childrenMs: 0 }, () =>
    toolStage("permission_policy", run));
}

/** Nested spans subtract their elapsed time from their parent, so stages sum. */
export function toolStage<T>(stage: ToolStage, run: () => T): T {
  const parent = active.getStore();
  if (!parent) return run();
  const span: Span = { timing: parent.timing, stage, childrenMs: 0 };
  const start = performance.now();
  const finish = (): void => {
    const elapsed = performance.now() - start;
    span.timing.stages[stage] += Math.max(0, elapsed - span.childrenMs);
    parent.childrenMs += elapsed;
  };
  try {
    const result = active.run(span, run);
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) { finish(); throw error; }
}

export function markReadOnlyToolTiming(): void {
  const span = active.getStore();
  if (span) span.timing.path = "read_only";
}

/** Result persistence happens after the dispatch promise leaves its async scope. */
export function withCompletedToolTiming<T>(session: object, callId: string, run: () => T): T {
  const timing = pending.get(session)?.get(callId);
  if (!timing) return run();
  try { return active.run({ timing, stage: "result_sealing", childrenMs: 0 }, () => toolStage("result_sealing", run)); }
  finally {
    pending.get(session)?.delete(callId);
    const totalMs = performance.now() - timing.startedAt;
    const accountedMs = Object.values(timing.stages).reduce((sum, value) => sum + value, 0);
    try {
      appendFileSync(process.env.AGENC_TOOL_TIMINGS_FILE!, JSON.stringify({
        version: 1, callId, toolName: timing.toolName, path: timing.path,
        totalMs, stagesMs: timing.stages, queueAndOtherMs: Math.max(0, totalMs - accountedMs),
      }) + "\n", { mode: 0o600 });
    } catch { /* Diagnostics must never change tool behavior. */ }
  }
}
