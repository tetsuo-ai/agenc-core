import { PassThrough } from "node:stream";
import path from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";
import type { TaskState } from "../../../src/tasks/types.js";
import {
  notifyPreviewFileChanged,
  resetPreviewFileRevisionsForTesting,
} from "../../../src/tui/workbench/previewInvalidation.js";
import { previewAgentTask } from "./preview-invalidation-fixtures.js";

type PendingRead = {
  readonly filePath: string;
  readonly offset: number;
  readonly signal: AbortSignal | undefined;
  readonly finish: (body: string) => void;
};

const pendingReads = vi.hoisted(() => {
  const queue: PendingRead[] = [];
  return {
    queue,
    clear(): void {
      queue.length = 0;
    },
    enqueue(
      filePath: string,
      offset: number,
      signal: AbortSignal | undefined,
      finish: (body: string) => void,
    ): void {
      queue.push({ filePath, offset, signal, finish });
    },
  };
});

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange(
    filePath: string,
    offset: number,
    _limit: number,
    _encoding: unknown,
    signal?: AbortSignal,
  ) {
    return new Promise<{
      readonly content: string;
      readonly lineCount: number;
      readonly totalLines: number;
      readonly totalBytes: number;
      readonly readBytes: number;
      readonly mtimeMs: number;
    }>((settle) => {
      pendingReads.enqueue(filePath, offset, signal, (body) => {
        settle({
          content: body,
          lineCount: 1,
          totalLines: 1,
          totalBytes: Buffer.byteLength(body),
          readBytes: Buffer.byteLength(body),
          mtimeMs: 1,
        });
      });
    });
  },
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: async () => new Map([["target.ts", "modified"]]),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", async (loadActual) => {
  const actual = await loadActual<
    typeof import("../../../src/tui/keybindings/useKeybinding.js")
  >();
  return {
    ...actual,
    useKeybinding() {},
    useKeybindings() {},
  };
});

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import {
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

type PreviewMutators = {
  replaceTasks: (tasks: Record<string, TaskState>) => void;
  retarget: (filePath: string, line: number) => void;
};

function PreviewMutatorBridge({
  bind,
}: {
  readonly bind: (mutators: PreviewMutators) => void;
}): React.ReactElement {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    bind({
      replaceTasks(tasks) {
        setAppState((current) => ({ ...current, tasks }));
      },
      retarget(filePath, line) {
        setAppState((current) => ({
          ...current,
          workbench: {
            ...current.workbench,
            activeSurfaceMode: "preview",
            activeFilePath: filePath,
            activeFileLine: line,
          },
        }));
      },
    });
  }, [bind, setAppState]);
  return <PreviewSurface focused={false} />;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function visibleFrame(stdout: PassThrough): string {
  const screen = getInkInstance(stdout as unknown as NodeJS.WriteStream)
    ?.frontFrame.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let row = 0; row < screen.height; row += 1) {
    let line = "";
    for (let column = 0; column < screen.width; column += 1) {
      line += cellAt(screen, column, row)?.char ?? " ";
    }
    rows.push(line.trimEnd());
  }
  return rows.join("\n");
}

async function awaitRead(
  pick: (queue: readonly PendingRead[]) => PendingRead | undefined,
): Promise<PendingRead> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const hit = pick(pendingReads.queue);
    if (hit) return hit;
    await pause(25);
  }
  throw new Error("Preview read did not start");
}

function selectedPreviewState(
  filePath: string,
  tasks: Record<string, TaskState>,
) {
  const defaults = getDefaultAppState();
  return {
    ...defaults,
    tasks,
    workbench: {
      ...defaults.workbench,
      activeFileLine: 1,
      activeFilePath: filePath,
      activeSurfaceMode: "preview" as const,
    },
  };
}

async function openSelectedPreview(
  filePath: string,
  tasks: Record<string, TaskState> = {},
): Promise<{
  readonly mutators: PreviewMutators;
  readonly frame: () => string;
  readonly dispose: () => void;
}> {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    ref() {},
    setRawMode() {},
    unref() {},
  });
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: true,
  });
  const tree = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  let mutators: PreviewMutators | undefined;
  tree.render(
    <AppStateProvider initialState={selectedPreviewState(filePath, tasks)}>
      <PreviewMutatorBridge
        bind={(next) => {
          mutators = next;
        }}
      />
    </AppStateProvider>,
  );
  return {
    get mutators(): PreviewMutators {
      if (!mutators) throw new Error("Preview mutators are not ready");
      return mutators;
    },
    frame: () => visibleFrame(stdout),
    dispose() {
      tree.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

async function withSelectedPreview(
  filePath: string,
  tasks: Record<string, TaskState>,
  run: (session: Awaited<ReturnType<typeof openSelectedPreview>>) => Promise<void>,
): Promise<void> {
  const session = await openSelectedPreview(filePath, tasks);
  try {
    await run(session);
  } finally {
    session.dispose();
  }
}

function readForSuffix(suffix: string): Promise<PendingRead> {
  return awaitRead((queue) =>
    queue.find((read) => read.filePath.endsWith(suffix)),
  );
}

describe("PreviewSurface same-path invalidation", () => {
  beforeEach(() => {
    pendingReads.clear();
    resetPreviewFileRevisionsForTesting();
  });

  afterEach(() => {
    resetAllLSPDiagnosticState();
    resetPreviewFileRevisionsForTesting();
  });

  it("rereads and refreshes diagnostics after a same-path file revision", async () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: path.resolve(process.cwd(), "target.ts"),
          diagnostics: [{ message: "stale", severity: "Error" }],
        },
      ],
    });
    await withSelectedPreview("target.ts", {}, async (session) => {
      const first = await readForSuffix("target.ts");
      first.finish("old selected body");
      await pause(50);
      expect(session.frame()).toContain("old selected body");
      expect(session.frame()).toMatch(/1\s*diagnostic/u);

      notifyPreviewFileChanged(first.filePath);
      const second = await awaitRead((queue) => queue[1]);
      expect(second.filePath).toBe(first.filePath);
      expect(second.offset).toBe(first.offset);
      second.finish("new selected body");
      await pause(50);

      const frame = session.frame();
      expect(frame).toContain("new selected body");
      expect(frame).not.toContain("old selected body");
      expect(frame).toMatch(/1\s*diagnostic/u);
      expect(pendingReads.queue).toHaveLength(2);
    });
  });

  it("rereads once when a referencing task completes", async () => {
    await withSelectedPreview(
      "target.ts",
      { "agent-1": previewAgentTask({ id: "agent-1", status: "running" }) },
      async (session) => {
        const first = await readForSuffix("target.ts");
        first.finish("before agent finished");
        await pause(50);
        expect(session.frame()).toContain("before agent finished");
        expect(pendingReads.queue).toHaveLength(1);

        session.mutators.replaceTasks({
          "agent-1": previewAgentTask({
            id: "agent-1",
            status: "completed",
            endTime: 10,
          }),
        });
        const second = await awaitRead((queue) => queue[1]);
        expect(second.offset).toBe(first.offset);
        second.finish("after agent finished");
        await pause(50);

        const frame = session.frame();
        expect(frame).toContain("after agent finished");
        expect(frame).not.toContain("before agent finished");
        expect(pendingReads.queue).toHaveLength(2);
      },
    );
  });

  it("does not reread when an unrelated task updates", async () => {
    await withSelectedPreview("target.ts", {}, async (session) => {
      const first = await readForSuffix("target.ts");
      first.finish("unchanged selected body");
      await pause(50);

      session.mutators.replaceTasks({
        "agent-other": previewAgentTask({
          id: "agent-other",
          status: "completed",
          prompt: "other.ts",
          endTime: 4,
        }),
      });
      await pause(80);

      expect(pendingReads.queue).toHaveLength(1);
      expect(session.frame()).toContain("unchanged selected body");
    });
  });

  it("keeps the newest same-path read when an earlier invalidation settles late", async () => {
    await withSelectedPreview("target.ts", {}, async (session) => {
      const first = await readForSuffix("target.ts");
      notifyPreviewFileChanged(first.filePath);
      const second = await awaitRead((queue) => queue[1]);
      expect(first.signal?.aborted).toBe(true);

      second.finish("newest same-path body");
      await pause(50);
      expect(session.frame()).toContain("newest same-path body");

      first.finish("late first same-path body");
      await pause(50);

      const frame = session.frame();
      expect(frame).toContain("newest same-path body");
      expect(frame).not.toContain("late first same-path body");
    });
  });

  it("keeps A-to-B-to-A race protection after same-path invalidation is added", async () => {
    await withSelectedPreview("a.ts", {}, async (session) => {
      const firstA = await readForSuffix("a.ts");
      session.mutators.retarget("b.ts", 1);
      const bRead = await readForSuffix("b.ts");
      session.mutators.retarget("a.ts", 1);
      const newestA = await awaitRead((queue) =>
        queue.find((read) => read.filePath.endsWith("a.ts") && read !== firstA),
      );

      expect(firstA.signal?.aborted).toBe(true);
      expect(bRead.signal?.aborted).toBe(true);

      newestA.finish("newest a body");
      await pause(50);
      bRead.finish("late b body");
      firstA.finish("late first a body");
      await pause(50);

      const frame = session.frame();
      expect(frame).toContain("newest a body");
      expect(frame).not.toContain("late b body");
      expect(frame).not.toContain("late first a body");
    });
  });
});
