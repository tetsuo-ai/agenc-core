import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";

const diffHarness = vi.hoisted(() => ({
  error: null as unknown,
  handlers: {} as Record<string, () => void>,
  snapshot: null as ReturnType<typeof import("../../../src/commands/diff-menu.js").createDiffMenuSnapshot> | null,
}));

vi.mock("../../../src/commands/diff.js", () => ({
  collectDiffSnapshot: vi.fn(async () => {
    if (diffHarness.error !== null) throw diffHarness.error;
    return diffHarness.snapshot;
  }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    diffHarness.handlers = handlers;
  },
}));

import { createDiffMenuSnapshot } from "../../../src/commands/diff-menu.js";
import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { DiffSurface, DiffSurfaceView } from "../../../src/tui/workbench/surfaces/DiffSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

describe("DiffSurface", () => {
  afterEach(() => {
    diffHarness.error = null;
    diffHarness.handlers = {};
    diffHarness.snapshot = null;
    vi.clearAllMocks();
  });

  it.each([
    [89, 28],
    [60, 20],
  ])("renders changed files within %ix%i", async (columns, rows) => {
    const snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      nameStatus: "M\tsrc/app.ts\nA\tsrc/new.ts\nUU\tsrc/conflict.ts",
      numstat: "1\t1\tsrc/app.ts\n2\t0\tsrc/new.ts\n1\t1\tsrc/conflict.ts",
      untrackedFiles: ["src/untracked.ts"],
    });

    const output = await renderToString(
      <DiffSurfaceView
        snapshot={snapshot}
        selected={0}
        decisions={{ "src/app.ts": "accept" }}
        focused={true}
        pendingApprovalRisk="medium"
      />,
      { columns, rows },
    );

    expect(output).toContain("DIFF");
    expect(output).toContain("git diff HEAD");
    expect(output).toContain("pending medium approval");
    expect(output).toContain("@ attach hunk");
    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("clamps stale selection to the last changed file", async () => {
    const snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/new.ts b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+fresh",
      ].join("\n"),
      nameStatus: "M\tsrc/app.ts\nA\tsrc/new.ts",
      numstat: "1\t1\tsrc/app.ts\n1\t0\tsrc/new.ts",
      untrackedFiles: [],
    });

    const output = await renderToString(
      <DiffSurfaceView
        snapshot={snapshot}
        selected={99}
        decisions={{}}
        focused={true}
        pendingApprovalRisk={null}
      />,
      { columns: 80, rows: 24 },
    );

    expect(output).toContain("src/new.ts - non-mutating review");
  });

  it("keeps destructive pending approvals out of the diff accept shortcut", async () => {
    diffHarness.snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      nameStatus: "M\tsrc/app.ts",
      numstat: "1\t1\tsrc/app.ts",
      untrackedFiles: [],
    });
    const request = pendingRequest({
      id: "approval-destructive",
      description: "Run shell command",
      input: { command: "rm -rf /tmp/agenc-danger" },
      toolName: "Bash",
    });
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <DiffSurface focused={true} pendingApproval={request} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(output())).toContain("typedconfirmationstays");

      diffHarness.handlers["surface:accept"]?.();
      await sleep();

      expect(request.resolve).not.toHaveBeenCalled();
      expect(compact(output())).not.toContain("markedaccept");
      expect(compact(output())).not.toContain("YMsrc/app.ts");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("classifies destructive approvals from non-command input fields before falling back to JSON", async () => {
    diffHarness.snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      nameStatus: "M\tsrc/app.ts",
      numstat: "1\t1\tsrc/app.ts",
      untrackedFiles: [],
    });
    const input: Record<string, unknown> = { cmd: "rm -rf /tmp/agenc-danger" };
    input.self = input;
    const request = pendingRequest({
      id: "approval-destructive-cmd",
      description: "Run shell command",
      input,
      toolName: "Bash",
    });
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <DiffSurface focused={true} pendingApproval={request} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(output())).toContain("typedconfirmationstays");

      diffHarness.handlers["surface:accept"]?.();
      await sleep();

      expect(request.resolve).not.toHaveBeenCalled();
      expect(compact(output())).not.toContain("markedaccept");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders diff snapshot load failures instead of staying on the loading state", async () => {
    diffHarness.error = new Error("git status failed");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider initialState={getDefaultAppState()}>
          <DiffSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(output())).toContain("toloaddiff:gitstatusfailed");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function sleep(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function pendingRequest({
  id,
  description,
  input,
  toolName,
}: {
  readonly id: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
  readonly toolName: string;
}) {
  return {
    id,
    description,
    input,
    ctx: {
      toolName,
      invocation: { payload: {} },
    },
    resolve: vi.fn(),
  } as any;
}
