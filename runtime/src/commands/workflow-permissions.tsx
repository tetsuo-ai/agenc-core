import React, { useEffect, useMemo, useState } from "react";
import { randomUUID } from "node:crypto";
import type { PendingToolApproval } from "../app-server/protocol/index.js";
import { takeAskUserQuestionUpdatedInput } from "../tools/ask-user-question/tool.js";
import { Box, useInput } from "../tui/ink.js";
import { buildDaemonApprovalCtx } from "../tui/daemon-approval-context.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../tui/permission-requests.js";
import { takePlanApprovalChoice } from "../tui/plan-approval-choice.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { useRegisterOverlay } from "../tui/context/overlayContext.js";
import { sameWorkflowApproval, type WorkflowApprovalControls } from "../tui/workflow-approval-controls.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext, SlashCommandResult } from "./types.js";

function display(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/gu, "?");
}

export function WorkflowPermissionsPanel({
  ownerRunId, controls, session, close,
}: {
  readonly ownerRunId: string;
  readonly controls: WorkflowApprovalControls;
  readonly session: SlashCommandContext["session"];
  readonly close: () => void;
}): React.ReactElement {
  const lifecycle = useMemo(() => new AbortController(), [ownerRunId, controls]);
  const [requests, setRequests] = useState<readonly PendingToolApproval[]>([]);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState("Loading pending approvals...");
  const [selected, setSelected] = useState<{ pending: PendingToolApproval; responseKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useRegisterOverlay("workflow-permissions");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const current = await controls.list(ownerRunId, lifecycle.signal);
        if (lifecycle.signal.aborted) return;
        setRequests(current);
        setIndex((value) => Math.min(value, Math.max(0, current.length - 1)));
        setSelected((value) => value !== null && current.some((request) => sameWorkflowApproval(request, value.pending)) ? value : null);
        setNotice(current.length === 0 ? "No live pending approvals. Closing this panel leaves the workflow running." : "Select a request to review. Closing this panel leaves requests pending.");
      } catch {
        if (lifecycle.signal.aborted) return;
        setRequests([]);
        setSelected(null);
        setNotice("Cannot refresh workflow approvals. Reopen this panel after reconnecting.");
      }
      if (!lifecycle.signal.aborted) timer = setTimeout(() => void refresh(), 1_000);
    };
    void refresh();
    return () => {
      lifecycle.abort();
      clearTimeout(timer);
    };
  }, [controls, ownerRunId, lifecycle]);
  useEffect(() => () => {
    if (selected === null) return;
    takePlanApprovalChoice(selected.responseKey);
    takeAskUserQuestionUpdatedInput(selected.responseKey);
  }, [selected]);
  const request = useMemo<PendingRequest | undefined>(() => {
    if (selected === null) return undefined;
    let settled = false;
    return {
      id: selected.responseKey,
      ctx: buildDaemonApprovalCtx(session, {
        ...selected.pending,
        callId: selected.responseKey,
      }, selected.pending.toolName, lifecycle.signal),
      input: selected.pending.input ?? {},
      description: selected.pending.reason ?? "Permission required by the workflow child.",
      resolve(decision) {
        if (settled || lifecycle.signal.aborted) return;
        settled = true;
        if (decision.kind === "abort") {
          setSelected(null);
          return;
        }
        setBusy(true);
        void controls.respond(selected.pending, decision, selected.responseKey, lifecycle.signal).then(
          (applied) => {
            if (!lifecycle.signal.aborted) setNotice(applied ? "Decision sent." : "This request is no longer pending. Refreshing...");
          },
          () => {
            if (!lifecycle.signal.aborted) setNotice("The decision could not be delivered. Refresh before trying again.");
          },
        ).finally(() => {
          if (!lifecycle.signal.aborted) {
            setBusy(false);
            setSelected(null);
          }
        });
      },
    };
  }, [controls, lifecycle, selected, session]);
  useInput((_input, key, event) => {
    if (key.escape) {
      event.stopImmediatePropagation();
      lifecycle.abort();
      close();
    } else if (!busy && key.upArrow) {
      event.stopImmediatePropagation();
      setIndex((value) => Math.max(0, value - 1));
    } else if (!busy && key.downArrow) {
      event.stopImmediatePropagation();
      setIndex((value) => Math.min(Math.max(0, requests.length - 1), value + 1));
    } else if (!busy && key.return && requests[index] !== undefined) {
      event.stopImmediatePropagation();
      setSelected({ pending: requests[index], responseKey: `workflow-panel:${randomUUID()}` });
    }
  }, { isActive: selected === null || busy });
  if (request !== undefined && selected !== null && !busy) {
    return <Box flexDirection="column">
      <ThemedText>Workflow {display(ownerRunId)} / child {display(selected.pending.sessionId)}</ThemedText>
      <AgenCPermissionOverlay request={request} tools={[{ name: selected.pending.toolName }]} onDismiss={() => setSelected(null)} />
    </Box>;
  }
  const firstVisible = Math.max(0, index - 9);
  return <MenuModal
    title="Workflow approvals"
    summary={display(ownerRunId)}
    count={String(requests.length)}
    columns={[30, 35, 35]}
    headers={["TOOL", "CHILD", "REQUEST"]}
    items={requests.slice(firstVisible, firstVisible + 10)}
    activeIndex={index - firstVisible}
    renderRow={(pending) => [display(pending.toolName), display(pending.sessionId), display(pending.requestId)]}
    footer={[{ keyName: "enter", label: "review" }, { keyName: "esc", label: "close without deciding" }]}
    hint={busy ? "Sending decision..." : notice}
  />;
}

export function openWorkflowPermissions(ctx: SlashCommandContext, ownerRunId: string): SlashCommandResult {
  const controls = (ctx.session as unknown as { workflowApprovalControls?: WorkflowApprovalControls }).workflowApprovalControls;
  if (controls === undefined) return { kind: "error", message: "Workflow approvals require a connected daemon TUI. Use agenc permissions list --session <ownerRunId>." };
  if (!openLocalJsxCommand(ctx, (close) => <WorkflowPermissionsPanel ownerRunId={ownerRunId} controls={controls} session={ctx.session} close={close} />)) {
    return { kind: "error", message: "Use agenc permissions list --session <ownerRunId> outside the TUI." };
  }
  return { kind: "skip" };
}
