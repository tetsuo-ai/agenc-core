import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import instances from "../../src/tui/ink/instances.js";
import { createRoot } from "../../src/tui/ink.js";
import { KeybindingSetup } from "../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { EffectReviewCard } from "../../src/tui/components/EffectReviewCard.js";

it.each([
  ["1", "confirmed_no_effect"], ["2", "confirmed_committed"], ["3", "remains_unknown"],
])("records choice %s with one keypress through the slash command resolver", async (key, disposition) => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  const response = Promise.withResolvers<void>();
  const resolve = vi.fn(() => response.promise);
  try {
    root.render(<AppStateProvider initialState={getDefaultAppState()}><KeybindingSetup configStore={new ConfigStore({ env: {} })}>
      <EffectReviewCard review={{ callId: "call-browser", toolName: "Browser", description: "navigate http://127.0.0.1:4173", error: "Chrome crashed at launch" }} resolve={resolve} />
    </KeybindingSetup></AppStateProvider>);
    await vi.waitFor(() => expect(stripAnsi(output).replace(/\s/gu, "")).toContain("Chromecrashedatlaunch"));
    stdin.write(key);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ toolCallId: "call-browser", disposition, attestation: "operator" }));
    stdin.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(resolve).toHaveBeenCalledTimes(1);
    response.resolve();
  } finally {
    root.unmount(); stdin.end(); stdout.end();
  }
});

it("keeps session handles in details and resolves the exact owner", async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  const resolve = vi.fn(async () => {});
  try {
    root.render(<AppStateProvider initialState={getDefaultAppState()}><KeybindingSetup configStore={new ConfigStore({ env: {} })}>
      <EffectReviewCard review={{ sessionId: "opaque-session-id", callId: "call-browser", toolName: "Browser", description: "Open preview", error: "Connection closed", blocksSession: false }} resolve={resolve} />
    </KeybindingSetup></AppStateProvider>);
    await vi.waitFor(() => expect(stripAnsi(output).replace(/\s/gu, "")).toContain("Fromabackgroundsession"));
    expect(output).not.toContain("opaque-session-id");
    expect(stripAnsi(output).replace(/\s/gu, "")).toContain("ddetails");
    stdin.write("d");
    await vi.waitFor(() => expect(stripAnsi(output).replace(/\s/gu, "")).toContain("Recoverydetails"));
    instances.get(stdout as unknown as NodeJS.WriteStream)?.forceRedraw();
    await vi.waitFor(() => expect(stripAnsi(output).replace(/\s/gu, "")).toContain("SessionID:opaque-session-id"));
    expect(stripAnsi(output).replace(/\s/gu, "")).toContain("ToolcallID:call-browser");
    expect(resolve).not.toHaveBeenCalled();
    stdin.write("1");
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ toolCallId: "call-browser", effectSessionId: "opaque-session-id", disposition: "confirmed_no_effect", attestation: "operator" }));
  } finally { root.unmount(); stdin.end(); stdout.end(); }
});
