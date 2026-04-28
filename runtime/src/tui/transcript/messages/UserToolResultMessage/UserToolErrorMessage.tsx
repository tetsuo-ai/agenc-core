/**
 * UserToolErrorMessage — renders a failed tool-call row.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/UserToolErrorMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream dispatched on substring markers in the result body to
 *     either an `InterruptedByUser`, `RejectedPlanMessage`, or
 *     `RejectedToolUseMessage`. AgenC's reducer routes those cases out
 *     of the error path entirely (the parent `UserToolResultMessage`
 *     classifies first), so this component only handles the genuine
 *     "tool returned an error" branch.
 *   - upstream delegated the body to
 *     `tool.renderToolUseErrorMessage()` and otherwise fell back to
 *     `<FallbackToolUseErrorMessage />`. AgenC routes through the
 *     existing `ToolCell` so the rendering path matches what live
 *     transcript rows already use.
 *   - The React Compiler `_c()` cache slots are dropped per the port
 *     pattern guide.
 *
 * @module
 */

import React from "react";

import { ToolCell } from "../../ToolCell.js";
import type { ToolResultEnvelope } from "./utils.js";
import { resolveResultText } from "./utils.js";

export interface UserToolErrorMessageProps {
  readonly envelope: ToolResultEnvelope;
}

export function UserToolErrorMessage({
  envelope,
}: UserToolErrorMessageProps): React.ReactElement {
  return (
    <ToolCell
      toolName={envelope.toolName}
      toolArgs={envelope.toolArgs}
      isComplete
      isError
      result={resolveResultText(envelope)}
      metadata={envelope.toolResultMetadata}
    />
  );
}

export default UserToolErrorMessage;
