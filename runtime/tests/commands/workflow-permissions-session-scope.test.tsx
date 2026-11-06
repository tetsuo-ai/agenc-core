import React from "react";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../../src/commands/types.js";
import type { PendingToolApproval } from "../../src/app-server/protocol/index.js";
import { WorkflowPermissionsPanel } from "../../src/commands/workflow-permissions.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { formatPendingToolApprovals } from "../../src/permissions/pending-approval-display.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { createRoot } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { KeybindingProvider } from "../../src/tui/keybindings/KeybindingContext.js";
import { parseBindings } from "../../src/tui/keybindings/parser.js";
import type { KeybindingContextName } from "../../src/tui/keybindings/types.js";

/**
 * An MCP tool approved without filesystem-write targets gets a session grant
 * keyed on the tool alone, so approving it for the session covers every later
 * call, whatever the arguments. A workflow child's request reaches the person
 * through the pending listing, not the live event; the listing and the card
 * built from it must say what the grant covers, as the live card does.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const TOOL = "mcp.inventory.get_stock";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const delay = (milliseconds = 60) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function lastFrame(output: string): string {
  let frame: string | null = null;
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;
    const end = output.indexOf(SYNC_END, start + SYNC_START.length);
    if (end === -1) break;
    const content = output.slice(start + SYNC_START.length, end);
    if (content.trim().length > 0) frame = content;
    cursor = end + SYNC_END.length;
  }
  return stripAnsi(frame ?? output).replace(/[\s│]+/gu, "");
}

function sessionFixture(conversationId: string): Session {
  const eventLog = new EventLog();
  const closeListeners = new Set<() => void | Promise<void>>();
  let sequence = 0;
  const session = {
    conversationId,
    eventLog,
    abortController: new AbortController(),
    permissionModeRegistry: new PermissionModeRegistry({
      mode: "default", additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    }),
    services: { admissionRequired: false },
    rolloutStore: {},
    emit: (event: Parameters<EventLog["emit"]>[0]) => {
      const canonical = { ...event, eventId: `${conversationId}:${++sequence}`, seq: sequence };
      eventLog.emit(canonical);
      return canonical;
    },
    onBeforeDurableClose: (listener: () => void | Promise<void>) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  } as unknown as Session;
  cleanups.push(async () => {
    session.abortController.abort();
    for (const listener of closeListeners) await listener();
  });
  return session;
}

/** A workflow owner whose child has asked for an MCP call and a shell command. */
function workflowWithPendingRequests() {
  const broker = new LiveApprovalBroker();
  const owner = sessionFixture("wf-owner");
  cleanups.push(broker.register(owner, { workflow: true, isActive: () => true }));
  const child = sessionFixture("wf-child");
  registerChildApprovalSession(child, owner);
  const ask = (toolName: string, args: Record<string, unknown>, extra: Partial<ApprovalCtx> = {}) => requestApproval({
    ctx: {
      callId: `call-${toolName}`, toolName, turnId: "turn_1",
      invocation: {
        callId: `call-${toolName}`, session: child,
        payload: { kind: "function", name: toolName, arguments: JSON.stringify(args) },
        turn: { subId: "turn_1" },
      } as ApprovalCtx["invocation"],
      ...extra,
    },
    resolver: owner.services.approvalResolver,
    args,
  });
  const mcp = ask(TOOL, { sku: "a-1" }, {
    mcpFilesystemApproval: { serverName: "inventory", toolName: "get_stock", toolIdentity: "installed-tool-1" },
  });
  const shell = ask("exec_command", { cmd: "node --test" });
  return { broker, owner, mcp, shell };
}

async function renderPanel(controls: {
  list: (ownerRunId: string) => Promise<readonly PendingToolApproval[]>;
  respond: (request: PendingToolApproval, decision: ReviewDecision) => Promise<boolean>;
}) {
  let output = "";
  const stdout = new PassThrough();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 });
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  const activeContexts = new Set<KeybindingContextName>();
  root.render(<AppStateProvider initialState={getDefaultAppState()}>
    <KeybindingProvider
      bindings={parseBindings([])}
      pendingChordRef={{ current: null }} pendingChord={null} setPendingChord={() => {}}
      activeContexts={activeContexts}
      registerActiveContext={(context) => { activeContexts.add(context); }}
      unregisterActiveContext={(context) => { activeContexts.delete(context); }}
      handlerRegistryRef={{ current: new Map() }}
    >
      <WorkflowPermissionsPanel ownerRunId="wf-owner" controls={controls} session={{ services: {} } as SlashCommandContext["session"]} close={() => {}} />
    </KeybindingProvider>
  </AppStateProvider>);
  cleanups.push(() => { root.unmount(); stdin.end(); stdout.end(); });
  await delay();
  return {
    frame: () => lastFrame(output),
    press: async (key: string) => { stdin.write(key); await delay(); },
  };
}

describe("a workflow child's MCP approval", () => {
  it("carries the journaled permissions on the pending listing", async () => {
    const { broker, owner } = workflowWithPendingRequests();
    await vi.waitFor(() => expect(broker.list(owner.conversationId)).toHaveLength(2));
    const byTool = new Map(broker.list(owner.conversationId).map((pending) => [pending.toolName, pending]));
    expect(byTool.get(TOOL)?.permissions).toEqual(["tool.use", "mcp_no_fs_writes"]);
    expect(byTool.get("exec_command")?.permissions).toEqual(["tool.use"]);
    const listing = formatPendingToolApprovals(broker.list(owner.conversationId));
    expect(listing).toContain(`session grant covers any arguments, every "${TOOL}" call`);
    expect(listing).toContain("session grant covers this exact action only");
    broker.abort(owner.conversationId);
  });

  it("says on the workflow card that a session grant covers every call, and grants it", async () => {
    const { broker, owner, mcp } = workflowWithPendingRequests();
    await vi.waitFor(() => expect(broker.list(owner.conversationId)).toHaveLength(2));
    const respond = vi.fn(async (request: PendingToolApproval, decision: ReviewDecision) =>
      broker.resolve(owner.conversationId, request.requestId, decision));
    const panel = await renderPanel({ list: async (ownerRunId) => broker.list(ownerRunId), respond });
    const index = broker.list(owner.conversationId).findIndex((pending) => pending.toolName === TOOL);
    for (let step = 0; step < index; step += 1) await panel.press("\x1b[B");
    await panel.press("\r");
    const frame = panel.frame();
    expect(frame).toContain(`TOOL·${TOOL.toUpperCase()}`);
    expect(frame).toContain(`2approveforsessionanyarguments,every${TOOL}call`);
    expect(frame).not.toContain("thisexactactiononly");
    await panel.press("2");
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(respond.mock.calls[0]?.[1]).toEqual({ kind: "approved_for_session" });
    expect((await mcp).decision).toEqual({ kind: "approved_for_session" });
    broker.abort(owner.conversationId);
  });
});
