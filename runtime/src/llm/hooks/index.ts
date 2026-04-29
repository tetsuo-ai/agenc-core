/**
 * Lifecycle hook surface for the gut runtime — `PreCompact`,
 * `PostCompact`, `SessionStart`. Tool-use hooks live in
 * `runtime/src/tools/hooks.ts`.
 *
 * @module
 */
export {
  HOOK_EXECUTION_TIMEOUT_MS,
  dispatchPostCompact,
  dispatchPreCompact,
  dispatchSessionStart,
  type PostCompactDispatchResult,
  type PreCompactDispatchResult,
} from "./dispatcher.js";
export {
  LifecycleHookRegistry,
  getLifecycleHookRegistry,
  registerPostCompactHook,
  registerPreCompactHook,
  registerSessionStartHook,
  resetLifecycleHookRegistry,
  setLifecycleHookRegistry,
} from "./registry.js";
export type {
  CompactTrigger,
  HookInput,
  HookResult,
  LifecycleHook,
  LifecycleHookEvent,
  PostCompactHook,
  PostCompactHookInput,
  PreCompactHook,
  PreCompactHookInput,
  SessionStartHook,
  SessionStartHookInput,
  SessionStartSource,
} from "./types.js";
