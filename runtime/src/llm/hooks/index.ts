/**
 * Hook system entry point.
 *
 * Post-gut: stop-hooks and user-config modules were removed and will be
 * rebuilt by a later tranche. This barrel now exports only the generic
 * hook dispatcher + matcher + registry.
 *
 * @module
 */

export * from "./types.js";
export { HookRegistry } from "./registry.js";
export { matchesHookMatcher } from "./matcher.js";
export { dispatchHooks } from "./dispatcher.js";
export type { DispatchInput, DispatchResult } from "./dispatcher.js";
export {
  defaultHookExecutor,
  type HookExecutor,
} from "./executors.js";
