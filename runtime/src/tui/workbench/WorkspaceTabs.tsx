import React from "react";

import type { SpinnerMode } from "../components/spinner/types.js";
import { Box, Text } from "../ink.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { useAppState } from "../state/AppState.js";
import { useBufferStore } from "./buffer/useBufferStore.js";
import { useWorkbenchDispatch, useWorkbenchState } from "./state.js";
import type { WorkspaceView } from "./types.js";

export function WorkspaceTabs({
  activityMode,
  pendingApproval,
  columns,
  hidden = false,
}: {
  readonly activityMode?: SpinnerMode | null;
  readonly pendingApproval: boolean;
  readonly columns: number;
  readonly hidden?: boolean;
}): React.ReactElement | null {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const buffer = useBufferStore();
  const hasRunningTask = useAppState((state) =>
    Object.values(state.tasks ?? {}).some(
      (task) => task.status === "running" || task.status === "pending",
    ),
  );

  useRegisterKeybindingContext("WorkspaceTabs");
  useKeybindings(
    {
      "workspace:switchAgent": () =>
        dispatch({ type: "switchWorkspaceView", view: "agent" }),
      "workspace:switchEditor": () =>
        dispatch({ type: "switchWorkspaceView", view: "editor" }),
      "workspace:cycleView": () =>
        dispatch({ type: "cycleWorkspaceView", direction: "next" }),
    },
    { context: "WorkspaceTabs" },
  );

  const compact = columns < 72;
  const agentBadge = pendingApproval
    ? " !"
    : activityMode != null || hasRunningTask
      ? " •"
      : "";
  const editorBadge = buffer.dirty ? " ●" : "";

  if (hidden) return null;

  return (
    <Box
      height={1}
      width="100%"
      flexShrink={0}
      paddingX={compact ? 1 : 2}
      gap={compact ? 1 : 2}
      backgroundColor="#000000"
    >
      <WorkspaceTab
        active={workbench.activeWorkspaceView === "agent"}
        label={`${compact ? "1" : "1 Agent"}${agentBadge}`}
        view="agent"
        onSelect={(view) => dispatch({ type: "switchWorkspaceView", view })}
      />
      <WorkspaceTab
        active={workbench.activeWorkspaceView === "editor"}
        label={`${compact ? "2" : "2 Editor"}${editorBadge}`}
        view="editor"
        onSelect={(view) => dispatch({ type: "switchWorkspaceView", view })}
      />
      <Box flexGrow={1} />
      {!compact ? (
        <Text color="inactive" wrap="truncate-end">
          alt+1 / alt+2
        </Text>
      ) : null}
    </Box>
  );
}

function WorkspaceTab({
  active,
  label,
  view,
  onSelect,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly view: WorkspaceView;
  readonly onSelect: (view: WorkspaceView) => void;
}): React.ReactElement {
  return (
    <Box onClick={() => onSelect(view)}>
      <Text
        color={active ? "agenc" : "inactive"}
        bold={active}
        inverse={active}
        wrap="truncate-end"
      >
        {` ${label} `}
      </Text>
    </Box>
  );
}
