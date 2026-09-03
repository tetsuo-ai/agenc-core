import { PassThrough } from "node:stream";
import path from "node:path";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";

type PreviewReadResult = {
  readonly content: string;
  readonly lineCount?: number;
  readonly totalLines?: number;
  readonly totalBytes: number;
  readonly readBytes: number;
  readonly mtimeMs: number;
};

type PreviewReadCall = {
  readonly filePath: string;
  readonly offset: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: PreviewReadResult) => void;
  readonly reject: (error: unknown) => void;
};

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  calls: [] as PreviewReadCall[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(
    (
      filePath: string,
      offset: number,
      _limit: number,
      _encoding: unknown,
      signal?: AbortSignal,
    ) => {
      let resolve!: (result: PreviewReadResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = (result: PreviewReadResult) => resolvePromise(result);
        reject = rejectPromise;
      });
      previewHarness.calls.push({ filePath, offset, signal, resolve, reject });
      return promise;
    },
  ),
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(async () => new Map([["target.ts", "modified"]])),
}));

vi.mock(
  "../../../src/tui/keybindings/useKeybinding.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/tui/keybindings/useKeybinding.js")
    >()),
    useKeybinding: () => {},
    useKeybindings: (handlers: Record<string, () => void>) => {
      previewHarness.handlers = handlers;
    },
  }),
);

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
  useSetAppState,
} from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

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
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).columns = 80;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).rows = 24;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).isTTY = true;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPreviewRead(
  predicate: (call: PreviewReadCall) => boolean,
): Promise<PreviewReadCall> {
  for (let index = 0; index < 20; index += 1) {
    const call = previewHarness.calls.find(predicate);
    if (call) return call;
    await sleep(25);
  }
  throw new Error("Preview read did not start");
}

function resolvePreviewRead(
  call: PreviewReadCall,
  result: Partial<PreviewReadResult> & { readonly content: string },
): void {
  call.resolve({
    totalBytes: Buffer.byteLength(result.content),
    readBytes: Buffer.byteLength(result.content),
    mtimeMs: 1,
    ...result,
  });
}

function PreviewTargetController({
  onReady,
}: {
  readonly onReady: (
    setPreviewTarget: (filePath: string, line: number) => void,
  ) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((filePath: string, line: number) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          activeSurfaceMode: "preview",
          activeFilePath: filePath,
          activeFileLine: line,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

function PreviewPathOverrideController({
  initialPath,
  onReady,
}: {
  readonly initialPath: string;
  readonly onReady: (setPathOverride: (filePath: string) => void) => void;
}): React.ReactElement {
  const [pathOverride, setPathOverride] = React.useState(initialPath);
  React.useEffect(() => {
    onReady(setPathOverride);
  }, [onReady]);
  return <PreviewSurface focused={false} pathOverride={pathOverride} />;
}

async function renderPathOverridePreview(
  initialPath: string,
  activeFileLine: number,
) {
  let setter: ((filePath: string) => void) | null = null;
  const io = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: io.stdin as unknown as NodeJS.ReadStream,
    stdout: io.stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        workbench: {
          ...getDefaultAppState().workbench,
          activeSurfaceMode: "preview",
          activeFilePath: "center.ts",
          activeFileLine,
        },
      }}
    >
      <KeybindingSetup>
        <PreviewPathOverrideController
          initialPath={initialPath}
          onReady={(nextSetter) => {
            setter = nextSetter;
          }}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  );
  return {
    ...io,
    setPathOverride(filePath: string): void {
      if (setter === null) {
        throw new Error("Path override controller is not ready");
      }
      setter(filePath);
    },
    unmount(): void {
      root.unmount();
      io.stdin.end();
      io.stdout.end();
    },
  };
}

function waitForPathRead(fileName: string, index = 0): Promise<PreviewReadCall> {
  return waitForPreviewRead(
    (call) =>
      call ===
      previewHarness.calls.filter(({ filePath }) =>
        filePath.endsWith(fileName),
      )[index],
  );
}

function currentScreenText(stdout: PassThrough): string {
  const screen = getInkInstance(stdout as unknown as NodeJS.WriteStream)
    ?.frontFrame.screen;
  if (!screen) return "";
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from(
      { length: screen.width },
      (_, column) => cellAt(screen, column, row)?.char ?? " ",
    )
      .join("")
      .trimEnd(),
  ).join("\n");
}

describe("PreviewSurface interactions", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.calls = [];
  });

  afterEach(() => {
    resetAllLSPDiagnosticState();
  });

  it("handles scroll, attach, edit, close, diagnostics, and in-flight agent states", async () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: path.resolve(process.cwd(), "target.ts"),
          diagnostics: [
            { message: "first", severity: "Warning" },
            { message: "second", severity: "Error" },
          ],
        },
      ],
    });

    const changes: AppState[] = [];
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            tasks: {
              "bash-1": {
                id: "bash-1",
                type: "local_bash",
                status: "running",
                description: "cat target.ts",
                startTime: 0,
                outputFile: "",
                outputOffset: 0,
                notified: false,
                command: "cat target.ts",
              } as any,
              "agent-done": {
                id: "agent-done",
                type: "local_agent",
                status: "completed",
                description: "finished target.ts",
                startTime: 0,
                endTime: 1,
                outputFile: "",
                outputOffset: 0,
                notified: false,
                agentId: "agent",
                prompt: "target.ts",
                agentType: "general",
                retrieved: false,
                lastReportedToolCount: 0,
                lastReportedTokenCount: 0,
                pendingMessages: [],
                retain: false,
                diskLoaded: false,
              } as any,
              "agent-1": {
                id: "agent-1",
                type: "local_agent",
                status: "running",
                startTime: 0,
                outputFile: "",
                outputOffset: 0,
                notified: false,
                agentId: "agent",
                prompt: "editing target.ts",
                agentType: "general",
                retrieved: false,
                lastReportedToolCount: 0,
                lastReportedTokenCount: 0,
                pendingMessages: [],
                retain: false,
                diskLoaded: false,
              } as any,
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 25,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <PreviewSurface focused={true} />
        </AppStateProvider>,
      );

      const initialRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 24,
      );
      resolvePreviewRead(initialRead, {
        content: "line25\nline26\nline27",
        lineCount: 3,
        totalLines: 100,
      });
      await sleep();

      const rendered = compact(output());
      expect(rendered).toContain("2diagnostics");
      expect(rendered).toContain("agenteditinflight:agent-1");
      expect(rendered).toContain(",modified]");

      previewHarness.handlers["surface:pageDown"]?.();
      resolvePreviewRead(
        await waitForPreviewRead(
          (call) => call.filePath.endsWith("target.ts") && call.offset === 44,
        ),
        { content: "line45\nline46\nline47", lineCount: 3, totalLines: 100 },
      );
      await sleep();

      previewHarness.handlers["surface:up"]?.();
      resolvePreviewRead(
        await waitForPreviewRead(
          (call) => call.filePath.endsWith("target.ts") && call.offset === 43,
        ),
        { content: "line44\nline45\nline46", lineCount: 3, totalLines: 100 },
      );
      await sleep();

      previewHarness.handlers["surface:pageUp"]?.();
      resolvePreviewRead(
        await waitForPreviewRead(
          (call) => call.filePath.endsWith("target.ts") && call.offset === 23,
        ),
        { content: "line24\nline25\nline26", lineCount: 3, totalLines: 100 },
      );
      await sleep();

      previewHarness.handlers["surface:top"]?.();
      resolvePreviewRead(
        await waitForPreviewRead(
          (call) => call.filePath.endsWith("target.ts") && call.offset === 0,
        ),
        { content: "line1\nline2\nline3", lineCount: 3, totalLines: 100 },
      );
      await sleep();

      previewHarness.handlers["surface:down"]?.();
      resolvePreviewRead(
        await waitForPreviewRead(
          (call) => call.filePath.endsWith("target.ts") && call.offset === 1,
        ),
        { content: "line2\nline3\nline4", lineCount: 3, totalLines: 100 },
      );
      await sleep();

      previewHarness.handlers["surface:attach"]?.();
      await sleep();
      expect(changes.at(-1)?.workbench.attachments.at(-1)).toMatchObject({
        id: "file-range:target.ts:2-4",
        label: "target.ts:2-4",
        path: "target.ts",
        line: 2,
        endLine: 4,
      });

      previewHarness.handlers["surface:edit"]?.();
      await sleep();
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "target.ts",
        activeFileLine: 2,
      });

      previewHarness.handlers["workbench:closeSurface"]?.();
      await sleep();
      expect(changes.at(-1)?.workbench.activeSurfaceMode).toBe("preview");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores attach and edit actions when no file is selected", async () => {
    const changes: AppState[] = [];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: null,
              activeFileLine: null,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <PreviewSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      previewHarness.handlers["surface:attach"]?.();
      previewHarness.handlers["surface:edit"]?.();
      await sleep();

      expect(changes).toHaveLength(0);
      expect(previewHarness.calls).toHaveLength(0);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("allows scrolling before the preview has loaded total line metadata", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={true} />
        </AppStateProvider>,
      );

      const initialRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 0,
      );
      previewHarness.handlers["surface:down"]?.();
      const scrolledRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 1,
      );

      expect(initialRead.signal?.aborted).toBe(true);
      resolvePreviewRead(scrolledRead, {
        content: "line2",
        lineCount: 1,
        totalLines: 2,
      });
      await sleep();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores aborted preview read resolutions after switching targets", async () => {
    let setPreviewTarget: ((filePath: string, line: number) => void) | null =
      null;
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController
            onReady={(setter) => {
              setPreviewTarget = setter;
            }}
          />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("old.ts") && call.offset === 0,
      );
      setPreviewTarget?.("new.ts", 1);
      const newRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("new.ts") && call.offset === 0,
      );

      expect(oldRead.signal?.aborted).toBe(true);
      resolvePreviewRead(oldRead, {
        content: "old stale body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(output()).not.toContain("old stale body");

      resolvePreviewRead(newRead, {
        content: "new body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(output()).toContain("new body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores aborted preview read failures after switching targets", async () => {
    let setPreviewTarget: ((filePath: string, line: number) => void) | null =
      null;
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController
            onReady={(setter) => {
              setPreviewTarget = setter;
            }}
          />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("old.ts") && call.offset === 0,
      );
      setPreviewTarget?.("new.ts", 1);
      const newRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("new.ts") && call.offset === 0,
      );

      expect(oldRead.signal?.aborted).toBe(true);
      oldRead.reject(new Error("old read failed"));
      await sleep();
      expect(output()).not.toContain("old read failed");

      resolvePreviewRead(newRead, {
        content: "new body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(output()).toContain("new body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders non-Error preview read failures", async () => {
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const read = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 0,
      );
      read.reject("plain failure");
      await sleep();

      expect(output()).toContain("plain failure");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("uses lineCount when totalLines is absent and clamps the requested start line", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 6,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const unclampedRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 5,
      );
      resolvePreviewRead(unclampedRead, { content: "", lineCount: 2 });

      const clampedRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 1,
      );
      resolvePreviewRead(clampedRead, {
        content: "line2",
        lineCount: 1,
        totalLines: 2,
      });
      await sleep();

      expect(previewHarness.calls.some((call) => call.offset === 1)).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("treats missing total line metadata as zero total lines", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const read = await waitForPreviewRead(
        (call) => call.filePath.endsWith("target.ts") && call.offset === 0,
      );
      resolvePreviewRead(read, { content: "" });
      await sleep();

      expect(previewHarness.calls).toHaveLength(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("starts override previews at line one and clears old content on navigation", async () => {
    const preview = await renderPathOverridePreview("a.ts", 37);

    try {
      const aRead = await waitForPathRead("a.ts");
      expect(aRead.offset).toBe(0);
      resolvePreviewRead(aRead, {
        content: "resolved body from a",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(currentScreenText(preview.stdout)).toContain(
        "resolved body from a",
      );

      preview.setPathOverride("b.ts");
      const bRead = await waitForPathRead("b.ts");
      expect(bRead.offset).toBe(0);
      await sleep();

      const pendingFrame = currentScreenText(preview.stdout);
      expect(pendingFrame).toContain("b.ts [read-only");
      expect(pendingFrame).not.toContain("resolved body from a");
    } finally {
      preview.unmount();
    }
  });

  it("keeps the newest A preview across deferred A to B to A reads", async () => {
    const preview = await renderPathOverridePreview("a.ts", 23);

    try {
      const firstARead = await waitForPathRead("a.ts");
      preview.setPathOverride("b.ts");
      const bRead = await waitForPathRead("b.ts");
      preview.setPathOverride("a.ts");
      const newestARead = await waitForPathRead("a.ts", 1);

      expect(previewHarness.calls.map(({ offset }) => offset)).toEqual([
        0, 0, 0,
      ]);
      expect(firstARead.signal?.aborted).toBe(true);
      expect(bRead.signal?.aborted).toBe(true);

      resolvePreviewRead(newestARead, {
        content: "newest a body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(currentScreenText(preview.stdout)).toContain("newest a body");

      resolvePreviewRead(bRead, {
        content: "late b body",
        lineCount: 1,
        totalLines: 1,
      });
      resolvePreviewRead(firstARead, {
        content: "late first a body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      const settledFrame = currentScreenText(preview.stdout);
      expect(settledFrame).toContain("a.ts [read-only");
      expect(settledFrame).toContain("newest a body");
      expect(settledFrame).not.toContain("late b body");
      expect(settledFrame).not.toContain("late first a body");
    } finally {
      preview.unmount();
    }
  });

  it("scrolls the current override while both path reads are pending", async () => {
    const preview = await renderPathOverridePreview("a.ts", 1);

    try {
      const aRead = await waitForPathRead("a.ts");
      preview.setPathOverride("b.ts");
      const bRead = await waitForPathRead("b.ts");
      await sleep();

      preview.stdin.write("\x1b[<65;1;2M");
      const scrolledBRead = await waitForPreviewRead(
        (call) => call.filePath.endsWith("b.ts") && call.offset === 3,
      );

      expect(aRead.signal?.aborted).toBe(true);
      expect(bRead.signal?.aborted).toBe(true);
      expect(scrolledBRead.offset).toBe(3);
    } finally {
      preview.unmount();
    }
  });
});

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
