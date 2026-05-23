// @ts-nocheck
import React, { useEffect, useState } from "react";

import { collectDiffSnapshot } from "../../../commands/diff.js";
import type { DiffMenuSnapshot } from "../../../commands/diff-menu.js";
import { APPROVED, DENIED } from "../../../permissions/review-decision.js";
import { classifyApprovalRisk } from "../../../permissions/risk.js";
import { getCwd } from "../../../utils/cwd.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import type { PendingRequest } from "../../permission-requests.js";
import { attachDiffHunkCommand, openBufferCommand } from "../commands.js";
import { approvalInputText } from "../approvals/inputText.js";
import { useWorkbenchDispatch } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { clampSurfaceSelection } from "./selection.js";

export function DiffSurface({
  focused,
  pendingApproval,
}: {
  readonly focused: boolean;
  readonly pendingApproval?: PendingRequest | null;
}): React.ReactElement {
  const dispatch = useWorkbenchDispatch();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DiffMenuSnapshot | null>(null);
  const [selected, setSelected] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "skip">>({});
  const files = snapshot?.files ?? [];
  const selectedFile = files[clampSurfaceSelection(selected, files.length)] ?? files[0];
  const approvalRisk = pendingApproval
    ? classifyApprovalRisk({
        request: pendingApproval,
        description: pendingApproval.description,
        command: approvalInputText(pendingApproval.input),
      })
    : null;

  useEffect(() => {
    let mounted = true;
    collectDiffSnapshot(getCwd()).then(
      (next) => {
        if (mounted) setSnapshot(next);
      },
      (error) => {
        if (mounted) setLoadError(errorMessage(error));
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  useRegisterKeybindingContext("Surface", focused);
  useKeybindings(
    {
      "surface:up": () => setSelected((value) => Math.max(0, value - 1)),
      "surface:down": () => setSelected((value) => Math.min(Math.max(0, files.length - 1), value + 1)),
      "surface:pageUp": () => setSelected((value) => Math.max(0, value - 10)),
      "surface:pageDown": () => setSelected((value) => Math.min(Math.max(0, files.length - 1), value + 10)),
      "surface:top": () => setSelected(0),
      "surface:bottom": () => setSelected(Math.max(0, files.length - 1)),
      "surface:open": () => {
        if (selectedFile) dispatch(openBufferCommand(selectedFile.path, undefined, true));
      },
      "surface:attach": () => {
        if (selectedFile) dispatch(attachDiffHunkCommand({ path: selectedFile.path, label: `${selectedFile.path} diff` }));
      },
      "surface:accept": () => {
        if (pendingApproval) {
          if (approvalRisk !== "destructive") {
            pendingApproval.resolve(APPROVED);
          }
          return;
        }
        if (selectedFile) setDecisions((prev) => ({ ...prev, [selectedFile.path]: "accept" }));
      },
      "surface:reject": () => {
        if (pendingApproval) {
          pendingApproval.resolve(DENIED);
          return;
        }
        if (selectedFile) setDecisions((prev) => ({ ...prev, [selectedFile.path]: "skip" }));
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (loadError !== null) return <EmptySurface title="DIFF" message={`Unable to load diff: ${loadError}`} />;
  if (snapshot === null) return <EmptySurface title="DIFF" message="Loading diff" />;
  if (snapshot.state === "not-repo") return <EmptySurface title="DIFF" message="Not a git repository" />;
  if (snapshot.state === "clean") return <EmptySurface title="DIFF" message="No working tree changes" />;

  return (
    <DiffSurfaceView
      snapshot={snapshot}
      selected={selected}
      decisions={decisions}
      focused={focused}
      pendingApprovalRisk={approvalRisk}
    />
  );
}

export function DiffSurfaceView({
  snapshot,
  selected,
  decisions,
  focused,
  pendingApprovalRisk,
}: {
  readonly snapshot: DiffMenuSnapshot;
  readonly selected: number;
  readonly decisions: Record<string, "accept" | "skip">;
  readonly focused: boolean;
  readonly pendingApprovalRisk?: "low" | "medium" | "destructive" | null;
}): React.ReactElement {
  const files = snapshot.files ?? [];
  const selectedIndex = clampSurfaceSelection(selected, files.length);
  const selectedFile = files[selectedIndex] ?? files[0];
  const acceptedCount = Object.values(decisions).filter((value) => value === "accept").length;
  const skippedCount = Object.values(decisions).filter((value) => value === "skip").length;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader
        title="DIFF"
        detail={`${files.length} file${files.length === 1 ? "" : "s"} changed - git diff HEAD - [q] close`}
        focused={focused}
      />
      <Text dimColor wrap="truncate-end">
        {pendingApprovalRisk
          ? pendingApprovalRisk === "destructive"
            ? "pending destructive approval - typed confirmation stays in the approval overlay"
            : `pending ${pendingApprovalRisk} approval - y approve  n deny`
          : "review only - y accept mark  n skip mark"}  @ attach hunk  marked {acceptedCount}/{skippedCount}  tests not queued
      </Text>
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" width={32} flexShrink={0} borderRight borderColor="gray" paddingRight={1}>
          {files.slice(0, 40).map((file, index) => (
            <Text key={file.path} color={index === selectedIndex ? "suggestion" : undefined} wrap="truncate-end">
              {decisionMarker(decisions[file.path])}{statusMarker(file.status)} {file.path}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1} overflow="hidden">
          {selectedFile ? (
            <>
              <Text color="text2" wrap="truncate-end">
                {selectedFile.path} - non-mutating review{decisions[selectedFile.path] ? ` - marked ${decisions[selectedFile.path]}` : ""}
              </Text>
              {selectedFile.previewLines.map((line, index) => (
                <Text key={`${selectedFile.path}:${index}`} color={lineColor(line)} wrap="truncate-end">{line}</Text>
              ))}
            </>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "unknown error";
}

function statusMarker(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "unmerged":
      return "U";
    case "untracked":
      return "?";
    default:
      return "M";
  }
}

function decisionMarker(decision: "accept" | "skip" | undefined): string {
  if (decision === "accept") return "Y ";
  if (decision === "skip") return "N ";
  return "";
}

function lineColor(line: string): string | undefined {
  if (line.startsWith("+")) return "success";
  if (line.startsWith("-")) return "error";
  if (line.startsWith("@@")) return "warning";
  return undefined;
}
