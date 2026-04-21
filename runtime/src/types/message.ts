// @ts-nocheck
// Stub for openclaude's `src/types/message.ts`, which is referenced throughout
// the openclaude-ported compact/ tree but never exists in upstream source.
// The port uses these as type-only imports, so any-typed placeholders are
// sufficient to keep the compact module resolvable without pulling a live
// message-type implementation into AgenC yet.
//
// When the real runtime message graph lands, replace the stubs with real
// types/imports from the AgenC runtime.

// Use an intersection of `any` and a no-op branded type so that narrowing
// type guards like `isCompactBoundaryMessage(m): m is SystemCompactBoundaryMessage`
// do not collapse the remainder to `never`.
export type Message = any & { readonly __message_stub?: unique symbol };
export type AssistantMessage = any;
export type UserMessage = any;
export type SystemMessage = any;
export type AttachmentMessage = any;
export type HookResultMessage = any;
export interface SystemCompactBoundaryMessage {
  readonly __kind: 'compact_boundary';
  [key: string]: any;
}
export type SystemMicrocompactBoundaryMessage = any;
export type SystemMessageLevel = any;
export type SystemAPIErrorMessage = any;
export type SystemApiMetricsMessage = any;
export type SystemAwaySummaryMessage = any;
export type SystemBridgeStatusMessage = any;
export type SystemInformationalMessage = any;
export type SystemLocalCommandMessage = any;
export type SystemMemorySavedMessage = any;
export type SystemPermissionRetryMessage = any;
export type SystemScheduledTaskFireMessage = any;
export type SystemStopHookSummaryMessage = any;
export type SystemTurnDurationMessage = any;
export type SystemAgentsKilledMessage = any;
export type NormalizedMessage = any;
export type NormalizedAssistantMessage = any;
export type NormalizedUserMessage = any;
export type TombstoneMessage = any;
export type ToolUseSummaryMessage = any;
export type ProgressMessage = any;
export type RequestStartEvent = any;
export type StopHookInfo = any;
export type StreamEvent = any;
export type MessageOrigin = any;
export type PartialCompactDirection = any;
