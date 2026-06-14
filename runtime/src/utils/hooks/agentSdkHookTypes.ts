/**
 * Stable local aliases for hook-related types pulled from the donor SDK.
 *
 * The canonical SDK barrel `src/entrypoints/agentSdkTypes.ts` overlaps its
 * own `export type * from './sdk/coreTypes.js'` re-exports with inline
 * `export type X = any` declarations. TypeScript's export resolver drops the
 * duplicated names from the emitted type table, which surfaces as
 * `TS2305: has no exported member` at downstream consumers.
 *
 * Until the donor surface is absorbed proper, expose `any`-shaped aliases
 * here so live AgenC-owned hook code can type-check without depending on the
 * unstable donor exports.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type HookEvent = any
export type HookInput = any
export type HookJSONOutput = any
export type SyncHookJSONOutput = any
export type AsyncHookJSONOutput = any

export type NotificationHookInput = any
export type PostToolUseHookInput = any
export type PostToolUseFailureHookInput = any
export type PermissionDeniedHookInput = any
export type PreCompactHookInput = any
export type PostCompactHookInput = any
export type PreToolUseHookInput = any
export type SessionStartHookInput = any
export type SessionEndHookInput = any
export type SetupHookInput = any
export type StopHookInput = any
export type StopFailureHookInput = any
export type SubagentStartHookInput = any
export type SubagentStopHookInput = any
export type TeammateIdleHookInput = any
export type TaskCreatedHookInput = any
export type TaskCompletedHookInput = any
export type ConfigChangeHookInput = any
export type CwdChangedHookInput = any
export type FileChangedHookInput = any
export type InstructionsLoadedHookInput = any
export type UserPromptSubmitHookInput = any
export type PermissionRequestHookInput = any
export type ElicitationHookInput = any
export type ElicitationResultHookInput = any

export type PermissionUpdate = any
export type ExitReason = any
