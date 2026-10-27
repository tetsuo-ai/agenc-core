import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { createRoot } from "../../src/tui/ink.js";
import { KeybindingSetup } from "../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";

async function tick(ms = 35): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

const MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
type DecisionKind = "approved" | "approved_for_session" | "denied";
function decision(kind: DecisionKind): ReviewDecision {
  return kind === "denied" ? { kind, decidedBy: "user" } : { kind };
}

async function fixture(mode: typeof MODES[number], destructive = false, initialDraft?: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  const decisions: ReviewDecision[] = [];
  let draft = initialDraft ?? "";
  const signal = new AbortController();
  const request: PendingRequest = {
    id: "approval-first",
    input: destructive ? { command: "agenc transfer --amount 5" } : { file_path: "/tmp/approval-fixture" },
    description: destructive ? "Transfer fixture" : "Read a fixture",
    ctx: { callId: "approval-first", toolName: destructive ? "Bash" : "Read", turnId: "turn-first", signal: signal.signal } as PendingRequest["ctx"],
    resolve: value => decisions.push(value),
  };
  const configStore = new ConfigStore({ env: {} });
  const initialState = getDefaultAppState();
  initialState.toolPermissionContext.mode = mode;
  const render = (id: string) => root.render(
    <AppStateProvider initialState={initialState}>
      <KeybindingSetup configStore={configStore}>
        <AgenCPermissionOverlay request={{ ...request, id }} tools={[{ name: request.ctx.toolName }]}
          {...(initialDraft === undefined ? {} : { composerDraft: {
            text: draft,
            onInput: (input: string, key: { return: boolean; backspace: boolean }) => {
              if (key.backspace) draft = draft.slice(0, -1);
              else if (!key.return) draft += input;
            },
          } })}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  );
  render(request.id);
  await tick();
  return {
    stdin, decisions, signal, render,
    output: () => stripAnsi(output),
    draft: () => draft,
    dispose: () => { root.unmount(); stdin.end(); stdout.end(); },
  };
}

async function assertSettlesOnce(f: Awaited<ReturnType<typeof fixture>>, first: ReviewDecision) {
  expect(f.decisions).toEqual([first]);
  for (const input of ["1", "2", "3", "\r"]) {
    f.stdin.write(input);
    await tick();
  }
  expect(f.decisions).toEqual([first]);
  f.render("approval-next");
  await tick();
  f.stdin.write("2"); // A fresh request gets its own isolated choice.
  await tick();
  f.stdin.write("\r");
  await tick();
  expect(f.decisions).toEqual([first, { kind: "approved_for_session" }]);
  f.render("approval-cancelled");
  await tick();
  f.signal.abort();
  for (const input of ["1", "2", "3", "\r"]) {
    f.stdin.write(input);
    await tick();
  }
  expect(f.decisions).toEqual([first, { kind: "approved_for_session" }]);
}

describe("ordinary approval keyboard ownership", () => {
  it.each([false, true])("retains the composer draft across approval focus, including digits and Enter (destructive: %s)", async (destructive) => {
    const f = await fixture("default", destructive, "act");
    try {
      for (const input of ["ually make it for groceries, not work stuff. and use blue please", " 123", "\x7f", "\r"]) {
        f.stdin.write(input);
        await tick();
      }
      await tick(650);
      f.stdin.write("2\r");
      await tick();
      expect(f.draft()).toBe("actually make it for groceries, not work stuff. and use blue please 122");
      expect(f.decisions).toEqual([]);
      f.stdin.write("\x1b");
      await tick(100);
      expect(f.decisions).toEqual([{ kind: "abort" }]);
    } finally { f.dispose(); }
  });

  it("requires an explicit focus change before a preserved draft can become an approval", async () => {
    const f = await fixture("default", false, "act");
    try {
      f.stdin.write("ually blue");
      await tick();
      f.stdin.write("\t");
      await tick(650);
      f.stdin.write("2");
      await tick();
      expect(f.draft()).toBe("actually blue");
      expect(f.decisions).toEqual([{ kind: "approved_for_session" }]);
    } finally { f.dispose(); }
  });

  it("Escape interrupts instead of denying only the visible request", async () => {
    const f = await fixture("default");
    try {
      f.stdin.write("\x1b");
      await tick(100);
      expect(f.decisions).toEqual([{ kind: "abort" }]);
      expect(f.output().replace(/\s/gu, "")).toContain("escstopturn");
    } finally { f.dispose(); }
  });

  it("requires the exact destructive word and a separate Enter, settling once", async () => {
    const f = await fixture("default", true);
    try {
      f.stdin.write("\ryn\r");
      await tick();
      expect(f.decisions).toEqual([]);
      f.stdin.write("\x7f\x7f");
      await tick();
      f.stdin.write("transfer\r");
      await tick();
      expect(f.decisions).toEqual([]);
      await tick(650);
      f.stdin.write("\r");
      await tick();
      expect(f.decisions).toEqual([{ kind: "approved" }]);
      f.stdin.write("\r");
      await tick();
      expect(f.decisions).toEqual([{ kind: "approved" }]);
    } finally { f.dispose(); }
  });

  it("accepts the displayed high-risk confirmation when the composer is empty", async () => {
    const f = await fixture("default", true, "");
    try {
      expect(f.output().replace(/\s/gu, "")).toContain("type'transfer'toapprove");
      expect(f.output().replace(/\s/gu, "")).toContain("pause,thenEnter");
      f.stdin.write("transfer");
      await tick(650);
      f.stdin.write("\r");
      await tick();
      expect(f.decisions).toEqual([{ kind: "approved" }]);
      expect(f.draft()).toBe("");
    } finally { f.dispose(); }
  });

  it("shows the focus step before high-risk confirmation and accepts it after Tab", async () => {
    const f = await fixture("default", true, "act");
    try {
      expect(f.output().replace(/\s/gu, "")).toContain("Tabreviewsapproval");
      expect(f.output().replace(/\s/gu, "")).not.toContain("type'transfer'toapprove");
      f.stdin.write("ually blue");
      await tick();
      f.stdin.write("\t");
      await tick();
      f.stdin.write("transfer");
      await tick(650);
      f.stdin.write("\r");
      await tick();
      expect(f.decisions).toEqual([{ kind: "approved" }]);
      expect(f.draft()).toBe("actually blue");
    } finally { f.dispose(); }
  });

  const choices = [
    ["1", "approved"], ["2", "approved_for_session"], ["3", "denied"],
    ["\x1b[B\x1b[B", "denied"], ["\x1b[B", "approved_for_session"],
    ["\r", "approved"], // An untouched card accepts a separate Enter.
  ] as const;
  it.each(choices.flatMap(([input, kind]) => MODES.map(mode => [input, kind, mode] as const)))
    ("settles isolated choice %j as %s exactly once in %s mode", async (input, kind, mode) => {
      const f = await fixture(mode);
      try {
        f.stdin.write(input);
        await tick();
        if (input.startsWith("\x1b")) {
          f.stdin.write("\r"); // Navigation and confirmation are separate inputs.
          await tick();
        }
        await assertSettlesOnce(f, decision(kind));
      } finally { f.dispose(); }
    });

  const typing = [
    ["y", "1", "approved"], ["n", "3", "denied"],
    ["2\r2\r", "2", "approved_for_session"], ["3\r1\r", "3", "denied"],
    ["1\r", "1", "approved"], ["2\r", "2", "approved_for_session"], ["3\r", "3", "denied"],
  ] as const;
  it.each(typing.flatMap(([input, shortcut, kind]) => MODES.map(mode => [input, shortcut, kind, mode] as const)))
    ("keeps typing %j pending until isolated %s settles %s once in %s mode", async (input, shortcut, kind, mode) => {
      const f = await fixture(mode);
      try {
        f.stdin.write(input);
        await tick();
        expect(f.decisions).toEqual([]);
        // Incremental ANSI frames need not repeat the complete hint in raw output.
        expect(f.output()).toContain("waiting");
        await tick(650);
        f.stdin.write("\r");
        await tick();
        expect(f.decisions).toEqual([]);
        f.stdin.write(shortcut);
        await tick();
        await assertSettlesOnce(f, decision(kind));
      } finally { f.dispose(); }
    });
});
