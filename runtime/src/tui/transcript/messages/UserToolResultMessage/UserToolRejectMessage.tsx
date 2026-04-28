/**
 * UserToolRejectMessage — renders a user-rejected tool-call row.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/UserToolRejectMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream resolved a per-tool `renderToolUseRejectedMessage()`
 *     hook from the tool registry. AgenC's tool-renderer registry does
 *     not own a per-tool reject renderer; instead we render the shared
 *     `RejectedToolUseMessage` fallback and surface the optional
 *     reason text from the envelope's result string.
 *   - The React Compiler `_c()` cache slots are dropped per the port
 *     pattern guide.
 *
 * @module
 */

import React from "react";

import { RejectedToolUseMessage } from "./RejectedToolUseMessage.js";
import { RejectedPlanMessage } from "./RejectedPlanMessage.js";
import {
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  type ToolResultEnvelope,
  resolveResultText,
} from "./utils.js";

export interface UserToolRejectMessageProps {
  readonly envelope: ToolResultEnvelope;
}

export function UserToolRejectMessage({
  envelope,
}: UserToolRejectMessageProps): React.ReactElement {
  const text = resolveResultText(envelope);
  const lower = text.toLowerCase();
  if (lower.startsWith(PLAN_REJECTION_PREFIX)) {
    const planBody = text.slice(PLAN_REJECTION_PREFIX.length).trim();
    return <RejectedPlanMessage plan={planBody} />;
  }
  if (lower.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX)) {
    const reason = text.slice(REJECT_MESSAGE_WITH_REASON_PREFIX.length).trim();
    return <RejectedToolUseMessage reason={reason} />;
  }
  return <RejectedToolUseMessage />;
}

export default UserToolRejectMessage;
