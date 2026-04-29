/**
 * UserToolResultMessage — top-level router for tool-result rows.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/UserToolResultMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream looked the originating `tool_use` block up via a
 *     `buildMessageLookups`-keyed map and a `Tools` array. AgenC's
 *     transcript reducer attaches `toolName` / `toolArgs` /
 *     `isError` / `toolResultContent` directly onto the result row
 *     (`state/events-to-messages.ts`), so the dispatch is local: we
 *     classify on the envelope and forward to the matching variant.
 *   - The `progressMessagesForMessage`, `lookups`, `tools`, `verbose`,
 *     `width`, and `style` props are dropped — AgenC's `ToolCell`
 *     already owns those concerns.
 *   - The React Compiler `_c()` cache slots are dropped per the port
 *     pattern guide.
 *
 * @module
 */

import React from "react";

import { RejectedPlanMessage } from "./RejectedPlanMessage.js";
import { UserToolCanceledMessage } from "./UserToolCanceledMessage.js";
import { UserToolErrorMessage } from "./UserToolErrorMessage.js";
import { UserToolRejectMessage } from "./UserToolRejectMessage.js";
import { UserToolSuccessMessage } from "./UserToolSuccessMessage.js";
import {
  PLAN_REJECTION_PREFIX,
  classifyToolResult,
  resolveResultText,
  type ToolResultEnvelope,
} from "./utils.js";

export interface UserToolResultMessageProps {
  readonly envelope: ToolResultEnvelope;
}

export { classifyToolResult, resolveResultText };
export type { ToolResultEnvelope };

export function UserToolResultMessage({
  envelope,
}: UserToolResultMessageProps): React.ReactElement | null {
  const status = classifyToolResult(envelope);
  if (status === "cancel") {
    return <UserToolCanceledMessage />;
  }
  if (status === "reject") {
    const text = resolveResultText(envelope).toLowerCase();
    if (text.startsWith(PLAN_REJECTION_PREFIX)) {
      const planBody = resolveResultText(envelope)
        .slice(PLAN_REJECTION_PREFIX.length)
        .trim();
      return <RejectedPlanMessage plan={planBody} />;
    }
    return <UserToolRejectMessage envelope={envelope} />;
  }
  if (status === "error") {
    return <UserToolErrorMessage envelope={envelope} />;
  }
  return <UserToolSuccessMessage envelope={envelope} />;
}

export default UserToolResultMessage;
