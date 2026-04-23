/**
 * Lean primitive re-exports for `runtime/src/session/**`.
 *
 * The session subsystem leans on a handful of gut-authored primitives
 * (`monotonicMs`, `AsyncLock`, `AsyncQueue`, `BehaviorSubject`) that
 * happen to live under `runtime/src/utils/` alongside the openclaude
 * port. Routing them through `_deps/` keeps every `src/session/*.ts`
 * import targeted at gut-owned surfaces and lets the openclaude port
 * be deleted without churn here later.
 *
 * Also re-exports a couple of error/log primitives shared with the
 * `runtime/src/llm/compact/_deps/` lean stubs.
 */

export { monotonicMs } from "../../utils/monotonic.js";
export { AsyncLock } from "../../utils/async-lock.js";
export { AsyncQueue } from "../../utils/async-queue.js";
export { BehaviorSubject } from "../../utils/behavior-subject.js";
export {
  hasExactErrorMessage,
  errorMessage,
  logError,
} from "../../llm/compact/_deps/utils.js";
