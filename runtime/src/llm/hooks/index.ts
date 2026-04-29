/**
 * Hook system entry point (Cut 5.2).
 *
 * Re-exports the registry, dispatcher, matcher, executor, and types so
 * other runtime modules import from a single path.
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
export {
  buildUserHookDefinitions,
  type UserHooksSettings,
  type UserHookEntry,
  type UserHookMatcherEntry,
  type UserHookCommandEntry,
  type UserHookHttpEntry,
  type BuildUserHookDefinitionsResult,
} from "./user-config.js";
export * from "./stop-hooks.js";
