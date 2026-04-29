/**
 * Shared helpers for the UserToolResultMessage family.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/utils.tsx`.
 *
 * Differences from upstream:
 *   - upstream looked tools up via a `buildMessageLookups`
 *     `toolUseByToolUseID` map keyed by Anthropic block id, then resolved
 *     a `Tool` object from a `Tools` array. AgenC's transcript reducer
 *     already attaches `toolName` and `toolArgs` to every `tool_result`
 *     row (see `state/events-to-messages.ts`), so the lookup collapses
 *     to a registry hit on `tool-renderers.ts`.
 *   - The React Compiler `_c()` cache slots are dropped — AgenC ports
 *     prefer clean React per the port pattern guide.
 *
 * @module
 */

import type {
  ToolRenderContext,
  ToolRenderPresentation,
} from "../../tool-renderers.js";
import { renderToolPresentation } from "../../tool-renderers.js";

export type ToolResultStatus = "success" | "error" | "reject" | "cancel";

/**
 * Sentinel strings used by the runtime when a tool result was injected
 * by the user-facing controls rather than the tool itself. Mirrors the
 * `CANCEL_MESSAGE` / `REJECT_MESSAGE` / `INTERRUPT_MESSAGE_FOR_TOOL_USE`
 * constants in upstream's `utils/messages.ts`. The exact prefixes are
 * runtime-internal; we match by case-insensitive substring so resumed
 * sessions written by an older runtime still classify correctly.
 */
export const CANCEL_MESSAGE_MARKER = "tool use was cancelled";
export const REJECT_MESSAGE_MARKER = "tool use was rejected";
export const INTERRUPT_MESSAGE_MARKER = "interrupted by user";
export const PLAN_REJECTION_PREFIX = "user rejected plan:";
export const REJECT_MESSAGE_WITH_REASON_PREFIX = "tool use was rejected:";

/**
 * Subset of a `TranscriptMessage` carrying everything the result router
 * needs to dispatch. Kept narrow so the renderers stay decoupled from
 * the full transcript envelope.
 */
export interface ToolResultEnvelope {
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly toolResultContent?: string;
  readonly content?: string;
  readonly toolResultMetadata?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly isComplete?: boolean;
}

/**
 * Resolve the result text we should classify against. The reducer
 * stores the cleaned result in `toolResultContent` and falls back to
 * `content` for legacy resumed rows.
 */
export function resolveResultText(envelope: ToolResultEnvelope): string {
  if (typeof envelope.toolResultContent === "string") {
    return envelope.toolResultContent;
  }
  if (typeof envelope.content === "string") {
    return envelope.content;
  }
  return "";
}

/**
 * Classify a `tool_result` envelope into the variant the router should
 * dispatch to. Exported for unit tests and call sites that need to
 * decide between sub-renderers without touching the result body.
 */
export function classifyToolResult(envelope: ToolResultEnvelope): ToolResultStatus {
  const text = resolveResultText(envelope).toLowerCase();
  if (text.includes(CANCEL_MESSAGE_MARKER)) return "cancel";
  if (
    text.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text.startsWith(PLAN_REJECTION_PREFIX) ||
    text.includes(REJECT_MESSAGE_MARKER) ||
    text.includes(INTERRUPT_MESSAGE_MARKER)
  ) {
    return "reject";
  }
  if (envelope.isError === true) return "error";
  return "success";
}

/**
 * Build a {@link ToolRenderContext} from an envelope. Wraps the
 * existing `tool-renderers` registry so the message renderers can
 * delegate to the same per-tool shaping the live `ToolCell` uses.
 */
export function buildRenderContext(
  envelope: ToolResultEnvelope,
  overrides: Partial<ToolRenderContext> = {},
): ToolRenderContext {
  return {
    toolName: envelope.toolName,
    toolArgs: envelope.toolArgs,
    result: resolveResultText(envelope),
    metadata: envelope.toolResultMetadata,
    isComplete: envelope.isComplete !== false,
    isError: envelope.isError === true,
    ...overrides,
  };
}

/**
 * Resolve a {@link ToolRenderPresentation} for the given envelope from
 * the registered renderer table, returning `null` if no renderer is
 * registered for the tool name. Mirrors the upstream
 * `tool.renderToolResultMessage()` / `renderToolUseErrorMessage()`
 * dispatch on a single helper.
 */
export function resolveResultPresentation(
  envelope: ToolResultEnvelope,
): Partial<ToolRenderPresentation> | null {
  return renderToolPresentation(buildRenderContext(envelope));
}
