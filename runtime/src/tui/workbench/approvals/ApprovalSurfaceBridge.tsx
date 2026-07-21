import React from "react";

import { Box, Text } from "../../ink.js";
import { useKeybinding } from "../../keybindings/useKeybinding.js";
import type { PendingRequest } from "../../permission-requests.js";
import { useWorkbenchDispatch } from "../state.js";
import { classifyApprovalRisk } from "../../../permissions/risk.js";
import { approvalInputText } from "./inputText.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../../../tools/ExitPlanModeTool/constants.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../../tools/ask-user-question/tool.js";

// Tools with their own full approval UI (plan review card, question picker)
// must NOT also get this hint row: both render above the same overlay area
// and stomp each other (observed: "risk low - press d…" line printed over
// the plan-review card, fusing with its text into "reviewall").
const HINTLESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
]);

export function ApprovalSurfaceBridge({
  request,
}: {
  readonly request?: PendingRequest;
}): React.ReactElement | null {
  const dispatch = useWorkbenchDispatch();
  useKeybinding(
    "workbench:openDiff",
    () => {
      if (request) {
        dispatch({ type: "openDiff", diffId: request.id, focus: true });
      }
    },
    { context: "Confirmation", isActive: request !== undefined },
  );

  if (!request) return null;
  if (HINTLESS_TOOL_NAMES.has(request.ctx.toolName)) return null;
  const risk = classifyApprovalRisk({
    request,
    description: request.description,
    command: approvalInputText(request.input),
  });
  return (
    <Box flexDirection="column">
      <Text color={risk === "destructive" ? "error" : risk === "medium" ? "warning" : "text2"} wrap="truncate-end">
        Approval pending: {request.description}
      </Text>
      <Text dimColor wrap="truncate-end">
        risk {risk} - press d or ctrl+w d for full diff review
      </Text>
    </Box>
  );
}
