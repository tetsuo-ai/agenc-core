import React from "react";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import stripAnsi from "strip-ansi";
import { budgetCommand } from "../../src/commands/budget.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { ConfigStore } from "../../src/config/store.js";
import { getInkInstance } from "../../src/tui/ink/instances.js";
import { createRoot } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { VoiceProvider } from "../../src/tui/context/voice.js";

const delay = () => new Promise(resolve => setTimeout(resolve, 40));
it.each([["max", 0], ["3m", 3_000_000]] as const)("applies %s from the frozen daemon picker and updates its header", async (choice, tokens) => {
  const home = await mkdtemp(join(tmpdir(), "agenc-budget-picker-"));
  const cwd = join(home, "workspace"); await mkdir(cwd);
  const store = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd }); await store.reload();
  const original = Object.freeze({ taskTokenBudget: 2_400_000 });
  const applyDaemonConfig = vi.fn(async () => ({ taskTokenBudget: tokens, summary: "Budget updated" }));
  const session = { config: original, applyDaemonConfig };
  let jsx: React.ReactNode;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 180, rows: 50 });
  let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  try {
    expect(await budgetCommand.execute({ argsRaw: "", cwd, home, configStore: store, session,
      appState: { setToolJSX: (value: { jsx: React.ReactNode }) => { jsx = value.jsx; } },
    } as unknown as SlashCommandContext)).toMatchObject({ kind: "skip" });
    root.render(<AppStateProvider initialState={getDefaultAppState()}><VoiceProvider>{jsx}</VoiceProvider></AppStateProvider>);
    await delay();
    expect(stripAnsi(output)).toContain("custom");
    // A rapid arrow + Enter must apply the selection even before React paints.
    stdin.write(choice === "max" ? "\x1b[B\r" : "\x1b[B\x1b[B\r"); await delay();
    if (choice === "3m") { stdin.write("3m"); await delay(); stdin.write("\r"); }
    await vi.waitFor(() => expect(session.config.taskTokenBudget).toBe(tokens));
    await delay();
    // Capture a complete repaint rather than concatenating cursor-diff patches.
    output = "";
    getInkInstance(stdout as unknown as NodeJS.WriteStream)!.forceRedraw();
    await vi.waitFor(() => expect(stripAnsi(output).replace(/\s+/gu, "")).toContain(choice === "max" ? "NOWMAX(NOTOKENCAP)" : "NOWCUSTOM(3,000,000TOKENS)"));
    expect(original.taskTokenBudget).toBe(2_400_000);
    expect(store.current().task_token_budget).toBe(tokens);
    expect(stripAnsi(output)).not.toContain("not extensible");
    expect(applyDaemonConfig).toHaveBeenCalledTimes(1);
  } finally { root.unmount(); stdin.end(); stdout.end(); await rm(home, { recursive: true, force: true }); }
});
