/**
 * Ports OC `src/types/message.ts` onto AgenC's runtime type surface.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor snapshot exposes permissive message aliases because the
 *     concrete message graph is outside that source slice.
 *   - AgenC keeps the extra aliases already required by live type-only
 *     imports while retaining the same permissive compatibility shape.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; this file is type-only compatibility for message imports.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgenCSystemAPIErrorMessage } from "../errors/api.js";

export type Message = any;
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
export type SystemAPIErrorMessage = AgenCSystemAPIErrorMessage;
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type NormalizedAssistantMessage<_T = unknown> = any;
export type NormalizedUserMessage = any;
export type GroupedToolUseMessage = any;
export type CollapsedReadSearchGroup = any;
export type CollapsibleMessage = any;
export type RenderableMessage = any;
export type TombstoneMessage = any;
export type ToolUseSummaryMessage = any;
export type ProgressMessage = any;
export type RequestStartEvent = any;
export type StopHookInfo = any;
export type StreamEvent = any;
export type MessageOrigin = any;
export type PartialCompactDirection = any;
