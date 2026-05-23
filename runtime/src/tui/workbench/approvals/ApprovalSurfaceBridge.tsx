// @ts-nocheck
import React from "react";

import { Box, Text } from "../../ink.js";
import { useKeybinding } from "../../keybindings/useKeybinding.js";
import type { PendingRequest } from "../../permission-requests.js";
import { useWorkbenchDispatch } from "../state.js";
import { classifyApprovalRisk } from "../../../permissions/risk.js";
import { approvalInputText } from "./inputText.js";

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
