import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { createRoot } from "../../src/tui/ink.js";
import { KeybindingSetup } from "../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 35));
}

describe("ordinary approval keyboard ownership", () => {
  it("requires the complete destructive confirmation word even with batched shortcut keys", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
    stdout.resume();
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
    const decisions: ReviewDecision[] = [];
    const request: PendingRequest = {
      id: "typed-transfer", input: { command: "agenc transfer --amount 5" }, description: "Transfer fixture",
      ctx: { callId: "typed-transfer", toolName: "Bash", turnId: "turn-first" } as PendingRequest["ctx"],
      resolve: decision => decisions.push(decision),
    };
    try {
      root.render(<AppStateProvider initialState={getDefaultAppState()}>
        <KeybindingSetup configStore={new ConfigStore({ env: {} })}>
          <AgenCPermissionOverlay request={request} tools={[{ name: "Bash" }]} />
        </KeybindingSetup>
      </AppStateProvider>);
      await tick();
      stdin.write("\ryn\r");
      await tick();
      expect(decisions).toEqual([]);
      stdin.write("\x7f\x7f");
      await tick();
      stdin.write("transfer\r");
      await tick();
      expect(decisions).toEqual([{ kind: "approved" }]);
      stdin.write("\r");
      await tick();
      expect(decisions).toHaveLength(1);
    } finally {
      root.unmount(); stdin.end(); stdout.end();
    }
  });

  it.each([
    ["\x1b[B\x1b[B\r", "denied"],
    ["\x1b[B\r", "approved_for_session"],
    ["\r", "approved"],
    ["y", "approved"],
    ["n", "denied"],
    ["2\r2\r", "approved_for_session"],
    ["3\r1\r", "denied"],
  ].flatMap(([input, kind]) => ["default", "acceptEdits", "plan", "bypassPermissions"].map(mode => [input, kind, mode] as const)))("settles %j as %s exactly once in %s mode", async (input, kind, mode) => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, ref() {}, unref() {}, setRawMode() {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
    stdout.resume();
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
    const decisions: ReviewDecision[] = [];
    const signal = new AbortController();
    const request: PendingRequest = {
      id: "approval-first", input: { file_path: "/tmp/approval-fixture" }, description: "Read a fixture",
      ctx: { callId: "approval-first", toolName: "Read", turnId: "turn-first", signal: signal.signal } as PendingRequest["ctx"],
      resolve: decision => decisions.push(decision),
    };
    const configStore = new ConfigStore({ env: {} });
    const initialState = getDefaultAppState();
    initialState.toolPermissionContext.mode = mode as typeof initialState.toolPermissionContext.mode;
    const renderRequest = (pending: PendingRequest) => root.render(
      <AppStateProvider initialState={initialState}>
        <KeybindingSetup configStore={configStore}>
          <AgenCPermissionOverlay request={pending} tools={[{ name: "Read" }]} />
        </KeybindingSetup>
      </AppStateProvider>,
    );
    try {
      renderRequest(request);
      await tick();
      stdin.write(input);
      await tick();
      stdin.write("\r1\r");
      await tick();
      expect(decisions).toEqual([{ kind }]);
      renderRequest({ ...request, id: "approval-next" });
      await tick();
      stdin.write("2\r");
      await tick();
      expect(decisions).toEqual([{ kind }, { kind: "approved_for_session" }]);
      renderRequest({ ...request, id: "approval-cancelled" });
      await tick();
      signal.abort();
      stdin.write("y\r");
      await tick();
      expect(decisions).toEqual([{ kind }, { kind: "approved_for_session" }]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
