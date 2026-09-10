import React from "react";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { permissionsCommand } from "../../src/commands/permissions.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import type { PendingToolApproval } from "../../src/app-server/protocol/index.js";
import { createRoot } from "../../src/tui/ink.js";
import { WorkflowPermissionsPanel } from "../../src/commands/workflow-permissions.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { KeybindingProvider } from "../../src/tui/keybindings/KeybindingContext.js";
import { parseBindings } from "../../src/tui/keybindings/parser.js";
import type { KeybindingContextName } from "../../src/tui/keybindings/types.js";

const delay = (milliseconds = 60) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function renderedPanel(initial: PendingToolApproval[]) {
  let pending = initial;
  let output = "";
  const stdout = new PassThrough();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 });
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
  const controls = { list: vi.fn(async () => pending), respond: vi.fn(async () => true) };
  const close = vi.fn();
  const activeContexts = new Set<KeybindingContextName>();
  root.render(<AppStateProvider initialState={getDefaultAppState()}>
    <KeybindingProvider
      bindings={parseBindings([{ context: "Global", bindings: { escape: "app:interrupt" } }])}
      pendingChordRef={{ current: null }} pendingChord={null} setPendingChord={() => {}}
      activeContexts={activeContexts}
      registerActiveContext={(context) => { activeContexts.add(context); }}
      unregisterActiveContext={(context) => { activeContexts.delete(context); }}
      handlerRegistryRef={{ current: new Map() }}
    >
      <WorkflowPermissionsPanel ownerRunId="wf-owner" controls={controls} session={{ services: {} } as SlashCommandContext["session"]} close={close} />
    </KeybindingProvider>
  </AppStateProvider>);
  await delay();
  return { root, stdin, controls, close, output: () => output, setPending: (current: PendingToolApproval[]) => { pending = current; } };
}

function pendingRequest(toolName = "exec_command", input = { command: "node --test" }): PendingToolApproval {
  return { ownerRunId: "wf-owner", sessionId: "child-one", requestId: "request-one", toolName, input };
}

describe("explicit workflow permissions command", () => {
  it("opens the supplied owner without requiring or changing the active session registry", async () => {
    const setToolJSX = vi.fn();
    const list = vi.fn().mockResolvedValue([]);
    const respond = vi.fn();
    const result = await permissionsCommand.execute({
      argsRaw: "wf-owner",
      session: { workflowApprovalControls: { list, respond }, services: {} },
      appState: { setToolJSX },
      cwd: "/workspace",
      home: "/home/test",
    } as unknown as SlashCommandContext);
    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledOnce();
    expect(React.isValidElement(setToolJSX.mock.calls[0]?.[0].jsx)).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("requires selecting a request before the existing modal can approve", async () => {
    const panel = await renderedPanel([pendingRequest()]);
    try {
      expect(panel.controls.respond).not.toHaveBeenCalled();
      panel.stdin.write("\r");
      await delay();
      expect(stripAnsi(panel.output())).toContain("node--test");
      expect(panel.controls.respond).not.toHaveBeenCalled();
      panel.stdin.write("1");
      panel.stdin.write("1");
      await delay();
      expect(panel.controls.respond).toHaveBeenCalledOnce();
      expect(panel.controls.respond.mock.calls[0]?.[0]).toEqual(pendingRequest());
      expect(panel.controls.respond.mock.calls[0]?.[1]).toEqual({ kind: "approved" });
      expect(panel.controls.respond.mock.calls[0]?.[2]).toMatch(/^workflow-panel:/u);
    } finally { panel.root.unmount(); }
  });

  it.each([
    pendingRequest(),
    pendingRequest("exec_command", { command: "rm -rf /workspace/disposable" }),
    { ...pendingRequest("ExitPlanMode"), planContent: "# Approved plan" },
    { ...pendingRequest("AskUserQuestion"), input: { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }], multiSelect: false }] } },
  ])("dismisses $toolName without deciding or cancelling the workflow", async (pending) => {
    const panel = await renderedPanel([pending]);
    try {
      panel.stdin.write("\r");
      await delay();
      panel.stdin.write("\x1b");
      await delay(100);
      expect(panel.controls.respond).not.toHaveBeenCalled();
      expect(panel.close).not.toHaveBeenCalled();
      panel.stdin.write("\x1b");
      await delay(100);
      expect(panel.close).toHaveBeenCalledOnce();
      expect(panel.controls.respond).not.toHaveBeenCalled();
    } finally { panel.root.unmount(); }
  });

  it("removes a settled request while its modal is open and stops polling on close", async () => {
    const panel = await renderedPanel([pendingRequest()]);
    panel.stdin.write("\r");
    await delay();
    panel.setPending([]);
    await delay(1_100);
    panel.stdin.write("1");
    await delay();
    expect(panel.controls.respond).not.toHaveBeenCalled();
    panel.root.unmount();
    const calls = panel.controls.list.mock.calls.length;
    await delay(1_100);
    expect(panel.controls.list).toHaveBeenCalledTimes(calls);
  });

  it("sends an explicit denial through the modal", async () => {
    const panel = await renderedPanel([pendingRequest()]);
    try {
      panel.stdin.write("\r");
      await delay();
      panel.stdin.write("3");
      await delay();
      expect(panel.controls.respond).toHaveBeenCalledOnce();
      expect(panel.controls.respond.mock.calls[0]?.[1]).toEqual({ kind: "denied" });
    } finally { panel.root.unmount(); }
  });
});
