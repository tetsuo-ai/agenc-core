/**
 * Stable local re-exports for hook-related SDK types.
 *
 * Hook execution code imports this helper to avoid depending on the full SDK
 * barrel path at every call site, but the types themselves come from the
 * generated SDK contract.
 */

export type {
  AsyncHookJSONOutput,
  ConfigChangeHookInput,
  CwdChangedHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  ExitReason,
  FileChangedHookInput,
  HookEvent,
  HookInput,
  HookJSONOutput,
  InstructionsLoadedHookInput,
  NotificationHookInput,
  PermissionDeniedHookInput,
  PermissionRequestHookInput,
  PermissionUpdate,
  PostCompactHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SetupHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  SyncHookJSONOutput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  TeammateIdleHookInput,
  UserPromptSubmitHookInput,
} from '../../entrypoints/sdk/coreTypes.js'
