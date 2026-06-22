/**
 * Internal AgenC SDK type/value barrel.
 *
 * The runtime package root does not export this module. Moved runtime code uses
 * it as a stable import target for generated SDK event/message types and the
 * small set of runtime constants that are consumed at execution time.
 */

export { EXIT_REASONS, HOOK_EVENTS } from './sdk/coreTypes.js'
export type * from './sdk/coreTypes.js'
export type { EffortLevel } from './sdk/runtimeTypes.js'
export type { Settings } from './sdk/settingsTypes.generated.js'
