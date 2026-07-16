import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import type { WorktreeSession } from "../../utils/worktree.js";

const worktreeMock = vi.hoisted(() => ({
  session: null as WorktreeSession | null,
  cleanupWorktree: vi.fn(async () => {}),
  getCurrentWorktreeSession: vi.fn(() => worktreeMock.session),
  keepWorktree: vi.fn(async () => {}),
  killTmuxSession: vi.fn(async () => {}),
}));

const execMock = vi.hoisted(() => ({
  statusStdout: "",
  revListStdout: "0\n",
  execFileNoThrow: vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "status") {
      return { code: 0, stderr: "", stdout: execMock.statusStdout };
    }
    if (args[0] === "rev-list") {
      return { code: 0, stderr: "", stdout: execMock.revListStdout };
    }
    return { code: 0, stderr: "", stdout: "" };
  }),
}));

const debugMock = vi.hoisted(() => ({
  logForDebugging: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  setCwd: vi.fn(),
}));

const plansMock = vi.hoisted(() => ({
  clear: vi.fn(),
}));

const sessionStorageMock = vi.hoisted(() => ({
  saveWorktreeState: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  props: undefined as
    | undefined
    | {
      title: React.ReactNode;
      subtitle?: React.ReactNode;
      onCancel: () => void;
      children: React.ReactNode;
    },
}));

const selectMock = vi.hoisted(() => ({
  props: undefined as
    | undefined
    | {
      defaultFocusValue?: string;
      options: Array<{ label: string; value: string; description?: string }>;
      onChange: (value: string) => void | Promise<void>;
    },
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: debugMock.logForDebugging,
}));

vi.mock("../../utils/execFileNoThrow.js", () => ({
  execFileNoThrow: execMock.execFileNoThrow,
}));

vi.mock("../../utils/plans.js", () => ({
  getPlansDirectory: {
    cache: {
      clear: plansMock.clear,
    },
  },
}));

vi.mock("../../utils/Shell.js", () => ({
  setCwd: shellMock.setCwd,
}));

vi.mock("../../utils/worktree.js", () => ({
  cleanupWorktree: worktreeMock.cleanupWorktree,
  getCurrentWorktreeSession: worktreeMock.getCurrentWorktreeSession,
  keepWorktree: worktreeMock.keepWorktree,
  killTmuxSession: worktreeMock.killTmuxSession,
}));

vi.mock("../../utils/sessionStorage.js", () => ({
  saveWorktreeState: sessionStorageMock.saveWorktreeState,
  writeAgentMetadata: vi.fn(async () => undefined),
}));

vi.mock("./spinner/Spinner.js", () => ({
  Spinner: () => null,
}));

vi.mock("./CustomSelect/select", () => ({
  Select: (props: NonNullable<typeof selectMock.props>) => {
    selectMock.props = props;
    return null;
  },
}));

vi.mock("./design-system/Dialog", () => ({
  Dialog: (props: NonNullable<typeof dialogMock.props>) => {
    dialogMock.props = props;
    return props.children;
  },
}));

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    originalCwd: "/repo",
    originalHeadCommit: "abc123",
    sessionId: "session-1",
    worktreeBranch: "feature/test",
    worktreeName: "test",
    worktreePath: "/repo-worktree",
    ...overrides,
  };
}

function stdio() {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });
  (stdout as unknown as { columns: number }).columns = 120;
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worktree dialog");
}

async function renderDialog({
  onCancel,
  onDone = vi.fn(),
}: {
  onCancel?: () => void;
  onDone?: (result?: string, options?: { display?: string }) => void;
} = {}) {
  const { WorktreeExitDialog } = await import("./WorktreeExitDialog.js");
  const io = stdio();
  const root = await createRoot({
    stdout: io.stdout as unknown as NodeJS.WriteStream,
    stdin: io.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  root.render(<WorktreeExitDialog onDone={onDone} onCancel={onCancel} />);

  return {
    onDone,
    output: io.output,
    unmount: () => {
      root.unmount();
      io.stdin.end();
      io.stdout.end();
    },
  };
}

describe("WorktreeExitDialog", () => {
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    worktreeMock.session = session();
    worktreeMock.cleanupWorktree.mockReset().mockResolvedValue(undefined);
    worktreeMock.keepWorktree.mockReset().mockResolvedValue(undefined);
    worktreeMock.killTmuxSession.mockReset().mockResolvedValue(undefined);
    worktreeMock.getCurrentWorktreeSession.mockClear();
    execMock.statusStdout = "";
    execMock.revListStdout = "0\n";
    execMock.execFileNoThrow.mockClear();
    debugMock.logForDebugging.mockClear();
    shellMock.setCwd.mockClear();
    plansMock.clear.mockClear();
    sessionStorageMock.saveWorktreeState.mockClear();
    dialogMock.props = undefined;
    selectMock.props = undefined;
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  });

  afterEach(() => {
    chdirSpy.mockRestore();
  });

  test("finishes immediately when there is no active worktree session", async () => {
    worktreeMock.session = null;
    const onDone = vi.fn();
    const rendered = await renderDialog({ onDone });

    try {
      expect(onDone).toHaveBeenCalledWith("No active worktree session found", {
        display: "system",
      });
      expect(dialogMock.props).toBeUndefined();
    } finally {
      rendered.unmount();
    }
  });

  test("asks with change and commit summaries and respects explicit cancel", async () => {
    execMock.statusStdout = " M src/a.ts\n?? src/b.ts\n";
    execMock.revListStdout = "2\n";
    const onCancel = vi.fn();
    const rendered = await renderDialog({ onCancel });

    try {
      await waitFor(() => selectMock.props !== undefined);

      expect(dialogMock.props?.subtitle).toContain(
        "2 uncommitted files and 2 commits",
      );
      expect(selectMock.props).toMatchObject({
        defaultFocusValue: "keep",
        options: [
          { label: "Keep worktree", value: "keep" },
          { label: "Remove worktree", value: "remove" },
        ],
      });

      dialogMock.props?.onCancel();
      expect(onCancel).toHaveBeenCalledOnce();
      expect(worktreeMock.keepWorktree).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  test("falls back to keep on cancel when no cancel handler is provided", async () => {
    execMock.statusStdout = " M src/a.ts\n";
    const rendered = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);

      expect(dialogMock.props?.subtitle).toContain("1 uncommitted file");
      dialogMock.props?.onCancel();
      await waitFor(() => rendered.onDone.mock.calls.length > 0);

      expect(worktreeMock.keepWorktree).toHaveBeenCalledOnce();
      expect(chdirSpy).toHaveBeenCalledWith("/repo");
      expect(shellMock.setCwd).toHaveBeenCalledWith("/repo");
      expect(sessionStorageMock.saveWorktreeState).toHaveBeenCalledWith(null);
      expect(plansMock.clear).toHaveBeenCalledOnce();
      expect(rendered.onDone).toHaveBeenCalledWith(
        "Worktree kept. Your work is saved at /repo-worktree on branch feature/test",
      );
    } finally {
      rendered.unmount();
    }
  });

  test("renders tmux choices and keeps worktree while terminating tmux", async () => {
    worktreeMock.session = session({ tmuxSessionName: "agent-tmux" });
    execMock.revListStdout = "1\n";
    const rendered = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);

      expect(selectMock.props).toMatchObject({
        defaultFocusValue: "keep-with-tmux",
        options: [
          { label: "Keep worktree and tmux session", value: "keep-with-tmux" },
          { label: "Keep worktree, kill tmux session", value: "keep-kill-tmux" },
          { label: "Remove worktree and tmux session", value: "remove-with-tmux" },
        ],
      });

      await selectMock.props?.onChange("keep-kill-tmux");
      await waitFor(() => rendered.onDone.mock.calls.length > 0);

      expect(worktreeMock.killTmuxSession).toHaveBeenCalledWith("agent-tmux");
      expect(worktreeMock.keepWorktree).toHaveBeenCalledOnce();
      expect(rendered.onDone).toHaveBeenCalledWith(
        "Worktree kept at /repo-worktree on branch feature/test. Tmux session terminated.",
      );
    } finally {
      rendered.unmount();
    }
  });

  test("keeps tmux sessions when requested", async () => {
    worktreeMock.session = session({ tmuxSessionName: "agent-tmux" });
    execMock.revListStdout = "1\n";
    const rendered = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("keep-with-tmux");
      await waitFor(() => rendered.onDone.mock.calls.length > 0);

      expect(worktreeMock.killTmuxSession).not.toHaveBeenCalled();
      expect(worktreeMock.keepWorktree).toHaveBeenCalledOnce();
      expect(rendered.onDone).toHaveBeenCalledWith(
        "Worktree kept. Your work is saved at /repo-worktree on branch feature/test. Reattach to tmux session with: tmux attach -t agent-tmux",
      );
    } finally {
      rendered.unmount();
    }
  });

  test("removes tmux sessions and reports discarded branch commits", async () => {
    worktreeMock.session = session({ tmuxSessionName: "agent-tmux" });
    execMock.revListStdout = "2\n";
    const rendered = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove-with-tmux");
      await waitFor(() => rendered.onDone.mock.calls.length > 0);

      expect(worktreeMock.killTmuxSession).toHaveBeenCalledWith("agent-tmux");
      expect(worktreeMock.cleanupWorktree).toHaveBeenCalledOnce();
      expect(rendered.onDone).toHaveBeenCalledWith(
        "Worktree removed. 2 commits on feature/test were discarded. Tmux session terminated.",
      );
    } finally {
      rendered.unmount();
    }
  });

  test("removes worktree and reports discarded work", async () => {
    execMock.statusStdout = " M src/a.ts\n";
    execMock.revListStdout = "1\n";
    const rendered = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove");
      await waitFor(() => rendered.onDone.mock.calls.length > 0);

      expect(worktreeMock.cleanupWorktree).toHaveBeenCalledOnce();
      expect(rendered.onDone).toHaveBeenCalledWith(
        "Worktree removed. 1 commit and uncommitted changes were discarded.",
      );
    } finally {
      rendered.unmount();
    }
  });

  test("reports uncommitted-only removal and explicit cleanup failures", async () => {
    execMock.statusStdout = " M src/a.ts\n";
    execMock.revListStdout = "0\n";
    const removed = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove");
      await waitFor(() => removed.onDone.mock.calls.length > 0);

      expect(removed.onDone).toHaveBeenCalledWith(
        "Worktree removed. Uncommitted changes were discarded.",
      );
    } finally {
      removed.unmount();
    }

    worktreeMock.cleanupWorktree.mockReset().mockRejectedValue(new Error("boom"));
    execMock.statusStdout = " M src/a.ts\n";
    selectMock.props = undefined;
    const failed = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove");
      await waitFor(() => failed.onDone.mock.calls.length > 0);

      expect(debugMock.logForDebugging).toHaveBeenCalledWith(
        "Failed to clean up worktree: Error: boom",
        { level: "error" },
      );
      expect(failed.onDone).toHaveBeenCalledWith(
        "Worktree cleanup failed, exiting anyway",
      );
    } finally {
      failed.unmount();
    }
  });

  test("covers removal pluralization variants", async () => {
    execMock.statusStdout = " M src/a.ts\n?? src/b.ts\n";
    execMock.revListStdout = "0\n";
    const uncommitted = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      expect(dialogMock.props?.subtitle).toContain("2 uncommitted files");
      await selectMock.props?.onChange("remove");
      await waitFor(() => uncommitted.onDone.mock.calls.length > 0);

      expect(uncommitted.onDone).toHaveBeenCalledWith(
        "Worktree removed. Uncommitted changes were discarded.",
      );
    } finally {
      uncommitted.unmount();
    }

    selectMock.props = undefined;
    execMock.statusStdout = "";
    execMock.revListStdout = "1\n";
    const oneCommit = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove");
      await waitFor(() => oneCommit.onDone.mock.calls.length > 0);

      expect(oneCommit.onDone).toHaveBeenCalledWith(
        "Worktree removed. 1 commit on feature/test was discarded.",
      );
    } finally {
      oneCommit.unmount();
    }

    selectMock.props = undefined;
    execMock.statusStdout = " M src/a.ts\n";
    execMock.revListStdout = "2\n";
    const commitsAndChanges = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      await selectMock.props?.onChange("remove");
      await waitFor(() => commitsAndChanges.onDone.mock.calls.length > 0);

      expect(commitsAndChanges.onDone).toHaveBeenCalledWith(
        "Worktree removed. 2 commits and uncommitted changes were discarded.",
      );
    } finally {
      commitsAndChanges.unmount();
    }
  });

  test("renders keeping and removing progress while actions are pending", async () => {
    execMock.statusStdout = " M src/a.ts\n";
    const keep = deferred();
    worktreeMock.keepWorktree.mockImplementationOnce(() => keep.promise);
    const keeping = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      const keepAction = selectMock.props!.onChange("keep");
      await waitFor(() => keeping.output().includes("Keeping worktree..."));
      keep.resolve();
      await keepAction;
      await waitFor(() => keeping.onDone.mock.calls.length > 0);
    } finally {
      keeping.unmount();
    }

    execMock.statusStdout = " M src/a.ts\n";
    const cleanup = deferred();
    worktreeMock.cleanupWorktree.mockImplementationOnce(() => cleanup.promise);
    selectMock.props = undefined;
    const removing = await renderDialog();

    try {
      await waitFor(() => selectMock.props !== undefined);
      const removeAction = selectMock.props!.onChange("remove");
      await waitFor(() => removing.output().includes("Removing worktree..."));
      cleanup.resolve();
      await removeAction;
      await waitFor(() => removing.onDone.mock.calls.length > 0);
    } finally {
      removing.unmount();
    }
  });

  test("auto-removes clean worktrees and reports cleanup failures", async () => {
    const success = await renderDialog();

    try {
      await waitFor(() => success.onDone.mock.calls.length > 0);
      expect(worktreeMock.cleanupWorktree).toHaveBeenCalledOnce();
      expect(success.onDone).toHaveBeenCalledWith(
        "Worktree removed (no changes)",
      );
    } finally {
      success.unmount();
    }

    worktreeMock.cleanupWorktree.mockReset().mockRejectedValue(new Error("nope"));
    const failure = await renderDialog();

    try {
      await waitFor(() => failure.onDone.mock.calls.length > 0);
      expect(debugMock.logForDebugging).toHaveBeenCalledWith(
        "Failed to clean up worktree: Error: nope",
        { level: "error" },
      );
      expect(failure.onDone).toHaveBeenCalledWith(
        "Worktree cleanup failed, exiting anyway",
      );
    } finally {
      failure.unmount();
    }
  });
});
