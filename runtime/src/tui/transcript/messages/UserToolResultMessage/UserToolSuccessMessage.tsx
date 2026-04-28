/**
 * UserToolSuccessMessage — renders a successful tool-call row.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream resolved a tool object via `findToolByName` and called
 *     `tool.renderToolResultMessage()`. AgenC's transcript already
 *     attaches `toolName` and `toolArgs` to every result row, so we
 *     route through the shared `ToolCell` widget which dispatches into
 *     the `tool-renderers.ts` registry. This keeps the rendering
 *     consistent with the live transcript path.
 *   - upstream wrapped the row in a `<SentryErrorBoundary>` and
 *     rendered a `HookProgressMessage` for `PostToolUse` hooks. AgenC's
 *     hook progress is emitted as separate transcript events handled
 *     by the dispatcher, so this component is pure rendering.
 *   - The classifier-approval and `feature(...)` branches are dropped
 *     since AgenC's classifier surface is owned by a different layer.
 *
 * @module
 */

import React from "react";

import { ToolCell } from "../../ToolCell.js";
import type { ToolResultEnvelope } from "./utils.js";
import { resolveResultText } from "./utils.js";

export interface UserToolSuccessMessageProps {
  readonly envelope: ToolResultEnvelope;
}

export function UserToolSuccessMessage({
  envelope,
}: UserToolSuccessMessageProps): React.ReactElement {
  return (
    <ToolCell
      toolName={envelope.toolName}
      toolArgs={envelope.toolArgs}
      isComplete
      isError={false}
      result={resolveResultText(envelope)}
      metadata={envelope.toolResultMetadata}
    />
  );
}

export default UserToolSuccessMessage;
