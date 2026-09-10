import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "../../src/tui/ink.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";

describe("workflow-only modal dismissal", () => {
  it.each([
    ["exec_command", { command: "rm -rf /workspace/disposable" }],
    ["ExitPlanMode", { plan: "# Plan" }],
    ["AskUserQuestion", { questions: [{ question: "Choose?", header: "Choice", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }], multiSelect: false }] }],
  ] as const)("dismisses %s without recording a decision", async (toolName, input) => {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const resolve = vi.fn();
    const onDismiss = vi.fn();
    const request = {
      id: "workflow-response-key",
      ctx: { callId: "workflow-response-key", toolName, invocation: { toolName: { name: toolName } } },
      input,
      description: "Workflow child approval",
      resolve,
    } as unknown as PendingRequest;
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
    try {
      root.render(<AppStateProvider initialState={getDefaultAppState()}>
        <AgenCPermissionOverlay request={request} tools={[{ name: toolName }]} onDismiss={onDismiss} />
      </AppStateProvider>);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      stdin.write("\x1b");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });
});
