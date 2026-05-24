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
import { APPROVED, DENIED } from "../../../src/permissions/review-decision.js";
import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
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

  it("renders copied files with the copied status marker", async () => {
    const snapshot = createDiffMenuSnapshot({
      rawDiff: [
        "diff --git a/src/source.ts b/src/copied.ts",
        "similarity index 100%",
        "copy from src/source.ts",
        "copy to src/copied.ts",
      ].join("\n"),
      nameStatus: "C\tsrc/source.ts\tsrc/copied.ts",
      numstat: "0\t0\tsrc/{source.ts => copied.ts}",
      untrackedFiles: [],
    });

    const output = await renderToString(
      <DiffSurfaceView
        snapshot={snapshot}
        selected={0}
        decisions={{}}
        focused={true}
        pendingApprovalRisk={null}
      />,
      { columns: 100, rows: 24 },
    );

    expect(output).toContain("1 file changed");
    expect(compact(output)).toContain("Csrc/copied.ts");
    expect(compact(output)).not.toContain("Msrc/copied.ts");
  });

  it("keeps the selected changed file visible beyond the first file-list page", async () => {
    const fileCount = 45;
    const snapshot = createDiffMenuSnapshot({
      rawDiff: Array.from({ length: fileCount }, (_, index) => [
        `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
        "@@ -1 +1 @@",
        `-old${index}`,
        `+new${index}`,
      ].join("\n")).join("\n"),
      nameStatus: Array.from({ length: fileCount }, (_, index) => `M\tsrc/file-${index}.ts`).join("\n"),
      numstat: Array.from({ length: fileCount }, (_, index) => `1\t1\tsrc/file-${index}.ts`).join("\n"),
      untrackedFiles: [],
    });
    const selectedPath = snapshot.files.at(-1)?.path;

    const output = await renderToString(
      <DiffSurfaceView
        snapshot={snapshot}
        selected={fileCount - 1}
        decisions={{}}
        focused={true}
        pendingApprovalRisk={null}
      />,
      { columns: 100, rows: 30 },
    );

    expect(selectedPath).toBeTruthy();
    expect(compact(output)).toContain(`M${selectedPath}`);
    expect(output).toContain(`${selectedPath} - non-mutating review`);
  });

  it("renders empty changed snapshots and remaining status markers", async () => {
    const emptyOutput = await renderToString(
      <DiffSurfaceView
        snapshot={{ state: "changed", files: [], rawDiff: "", untrackedFiles: [] }}
        selected={0}
        decisions={{}}
        focused={false}
        pendingApprovalRisk={null}
      />,
      { columns: 100, rows: 24 },
    );

    expect(emptyOutput).toContain("0 files changed");

    const statusOutput = await renderToString(
      <DiffSurfaceView
        snapshot={{
          state: "changed",
          rawDiff: "",
          untrackedFiles: [],
          files: [{
            path: "src/deleted.ts",
            status: "deleted",
            previewLines: ["--- a/src/deleted.ts", "@@ -1 +0,0 @@", "-gone"],
          }, {
            path: "src/renamed.ts",
            status: "renamed",
            previewLines: ["diff --git a/src/old.ts b/src/renamed.ts", "@@ -1 +1 @@", " context"],
          }],
        }}
        selected={1}
        decisions={{ "src/deleted.ts": "skip" }}
        focused={true}
        pendingApprovalRisk={null}
      />,
      { columns: 100, rows: 24 },
    );
    const compactStatus = compact(statusOutput);

    expect(compactStatus).toContain("NDsrc/deleted.ts");
    expect(compactStatus).toContain("Rsrc/renamed.ts");
    expect(statusOutput).toContain("context");
  });

  it("handles navigation, file actions, and stale high selections after files shrink", async () => {
    const snapshot = createDiffMenuSnapshot({
      rawDiff: Array.from({ length: 45 }, (_, index) => {
        const suffix = String(index).padStart(2, "0");
        return [
          `diff --git a/src/file-${suffix}.ts b/src/file-${suffix}.ts`,
          "@@ -1 +1 @@",
          `-old${suffix}`,
          `+new${suffix}`,
        ].join("\n");
      }).join("\n"),
      nameStatus: Array.from({ length: 45 }, (_, index) => `M\tsrc/file-${String(index).padStart(2, "0")}.ts`).join("\n"),
      numstat: Array.from({ length: 45 }, (_, index) => `1\t1\tsrc/file-${String(index).padStart(2, "0")}.ts`).join("\n"),
      untrackedFiles: [],
    });
    diffHarness.snapshot = snapshot;
    const changes: AppState[] = [];
    const { root, stdin, stdout, output } = await mountDiffSurface({
      onChangeAppState: ({ newState }) => changes.push(newState),
    });

    try {
      await sleep();

      expect(compact(output())).toContain("src/file-00.ts-non-mutatingreview");

      diffHarness.handlers["surface:down"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-01.ts-non-mutatingreview");

      diffHarness.handlers["surface:pageDown"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-11.ts-non-mutatingreview");

      diffHarness.handlers["surface:pageUp"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-01.ts-non-mutatingreview");

      diffHarness.handlers["surface:top"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-00.ts-non-mutatingreview");

      diffHarness.handlers["surface:bottom"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-44.ts-non-mutatingreview");

      (snapshot.files as unknown as unknown[]).splice(2);
      diffHarness.handlers["surface:up"]?.();
      await sleep();
      expect(compact(output())).toContain("src/file-00.ts-non-mutatingreview");

      diffHarness.handlers["surface:accept"]?.();
      await sleep();
      expect(compact(output())).toContain("markedaccept");
      expect(compact(output())).toContain("YMsrc/file-00.ts");

      diffHarness.handlers["surface:reject"]?.();
      await sleep();
      expect(compact(output())).toContain("Nskip");

      diffHarness.handlers["surface:attach"]?.();
      diffHarness.handlers["surface:open"]?.();
      diffHarness.handlers["surface:top"]?.();
      diffHarness.handlers["workbench:closeSurface"]?.();
      await sleep();

      expect(changes.some((state) =>
        state.workbench?.attachments.some((attachment) =>
          attachment.kind === "diff-hunk" && attachment.path === "src/file-00.ts"
        )
      )).toBe(true);
      expect(changes.some((state) =>
        state.workbench?.activeSurfaceMode === "buffer" &&
        state.workbench.activeFilePath === "src/file-00.ts"
      )).toBe(true);
      expect(changes.at(-1)?.workbench?.activeSurfaceMode).toBe("transcript");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not dispatch file actions before a diff file is selected", async () => {
    diffHarness.snapshot = createDiffMenuSnapshot({
      rawDiff: "",
      nameStatus: "",
      numstat: "",
      untrackedFiles: [],
    });
    const changes: AppState[] = [];
    const { root, stdin, stdout } = await mountDiffSurface({
      onChangeAppState: ({ newState }) => changes.push(newState),
    });

    try {
      diffHarness.handlers["surface:open"]?.();
      diffHarness.handlers["surface:attach"]?.();
      diffHarness.handlers["surface:accept"]?.();
      diffHarness.handlers["surface:reject"]?.();
      await sleep();

      expect(changes).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it.each([
    ["not-repo", createDiffMenuSnapshot({ rawDiff: "", nameStatus: "", numstat: "", untrackedFiles: [], notRepo: true }), "repository"],
    ["clean", createDiffMenuSnapshot({ rawDiff: "", nameStatus: "", numstat: "", untrackedFiles: [] }), "treechanges"],
  ])("renders %s diff snapshot states", async (_name, snapshot, expectedText) => {
    diffHarness.snapshot = snapshot;
    const { root, stdin, stdout, output } = await mountDiffSurface();

    try {
      await sleep();

      expect(compact(output())).toContain(expectedText);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
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

  it("resolves non-destructive pending approvals from diff shortcuts", async () => {
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
      id: "approval-low",
      description: "Read file",
      input: { command: "cat src/app.ts" },
      toolName: "Read",
    });
    const { root, stdin, stdout, output } = await mountDiffSurface({ pendingApproval: request });

    try {
      await sleep();

      expect(compact(output())).toContain("lowapproval");

      diffHarness.handlers["surface:accept"]?.();
      diffHarness.handlers["surface:reject"]?.();
      await sleep();

      expect(request.resolve).toHaveBeenNthCalledWith(1, APPROVED);
      expect(request.resolve).toHaveBeenNthCalledWith(2, DENIED);
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

  it.each([
    ["plain string failures", "plain failed", "toloaddiff:plainfailed"],
    ["unknown failures", new Error("   "), "toloaddiff:unknownerror"],
  ])("renders %s", async (_name, error, expected) => {
    diffHarness.error = error;
    const { root, stdin, stdout, output } = await mountDiffSurface();

    try {
      await sleep();

      expect(compact(output())).toContain(expected);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

async function mountDiffSurface({
  onChangeAppState,
  pendingApproval = null,
}: {
  readonly onChangeAppState?: (change: { readonly newState: AppState }) => void;
  readonly pendingApproval?: ReturnType<typeof pendingRequest> | null;
} = {}): Promise<{
  readonly root: Awaited<ReturnType<typeof createRoot>>;
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly output: () => string;
}> {
  const { stdin, stdout, output } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider
      initialState={getDefaultAppState()}
      onChangeAppState={onChangeAppState}
    >
      <DiffSurface focused={true} pendingApproval={pendingApproval} />
    </AppStateProvider>,
  );
  return { root, stdin, stdout, output };
}

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
