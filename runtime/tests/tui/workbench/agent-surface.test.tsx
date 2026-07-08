import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  deferredTaskIds: new Set<string>(),
  handlers: {} as Record<string, () => void>,
  logError: vi.fn(),
  pendingRejects: new Map<string, (reason?: unknown) => void>(),
  pendingReads: new Map<string, (result: { content: string }) => void>(),
  readCounts: {} as Record<string, number>,
  rejectOnRead: {} as Record<string, number>,
  tails: {} as Record<string, string>,
}));

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async (path: string) => {
    const taskId = /\/tmp\/(.+)\.log$/u.exec(path)?.[1] ?? path;
    const readCount = (keybindingHarness.readCounts[taskId] ?? 0) + 1;
    keybindingHarness.readCounts[taskId] = readCount;
    if (keybindingHarness.rejectOnRead[taskId] === readCount) {
      throw new Error(`tail failed for ${taskId}`);
    }
    if (keybindingHarness.deferredTaskIds.has(taskId)) {
      return new Promise<{ content: string }>((resolve, reject) => {
        keybindingHarness.pendingRejects.set(taskId, reject);
        keybindingHarness.pendingReads.set(taskId, resolve);
      });
    }
    return { content: keybindingHarness.tails[taskId] ?? "" };
  }),
}));

vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  evictTaskOutput: vi.fn(async () => {}),
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.log`,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    keybindingHarness.handlers = handlers;
  },
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: keybindingHarness.logError,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
import { AgentSurface, canEnterAgentTranscript } from "../../../src/tui/workbench/surfaces/AgentSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

describe("AgentSurface", () => {
  beforeEach(() => {
    keybindingHarness.deferredTaskIds = new Set();
    keybindingHarness.handlers = {};
    keybindingHarness.logError.mockReset();
    keybindingHarness.pendingRejects = new Map();
    keybindingHarness.pendingReads = new Map();
    keybindingHarness.readCounts = {};
    keybindingHarness.rejectOnRead = {};
    keybindingHarness.tails = {};
  });

  it("falls back to the first observed agent when the selected agent id is stale", async () => {
    const oldAgent = {
      id: "agent-old",
      type: "local_agent",
      status: "completed",
      description: "old completed agent",
      startTime: 1_000,
      outputFile: "urn:agenc:task:agent-old:output",
      outputOffset: 0,
      notified: false,
    } as any;
    const newAgent = {
      id: "agent-new",
      type: "local_agent",
      status: "running",
      description: "new running agent",
      startTime: 2_000,
      outputFile: "urn:agenc:task:agent-new:output",
      outputOffset: 0,
      notified: false,
    } as any;

    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            [oldAgent.id]: oldAgent,
            [newAgent.id]: newAgent,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: "agent-gone",
          },
        }}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("AGENT - completed - old completed agent");
    expect(output).not.toContain("new running agent");
  });

  it("opens in-process teammate transcripts from the agent surface", async () => {
    const changes: AppState[] = [];
    const teammateTask = {
      id: "teammate-1",
      type: "in_process_teammate",
      status: "running",
      description: "reviewing",
      startTime: 1_000,
      outputFile: "urn:agenc:task:teammate-1:output",
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: "agent-1",
        agentName: "Reviewer",
        teamName: "audit",
      },
    } as any;

    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: { [teammateTask.id]: teammateTask },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: teammateTask.id,
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      80,
    );

    expect(output).toContain("enter transcript");

    keybindingHarness.handlers["surface:open"]?.();

    expect(changes.at(-1)).toMatchObject({
      viewingAgentTaskId: teammateTask.id,
      viewSelectionMode: "viewing-agent",
    });
  });

  it("renders an empty agent surface and keeps empty-surface actions inert", async () => {
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
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "missing-agent",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(screenText(stdout))).toContain("Nobackgroundagentselected");

      keybindingHarness.handlers["surface:open"]?.();
      keybindingHarness.handlers["surface:stop"]?.();

      expect(changes).toHaveLength(0);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("stops the selected local agent from the agent surface", async () => {
    const changes: AppState[] = [];
    const abortController = new AbortController();
    const unregisterCleanup = vi.fn();

    await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              ...agentTask("agent-1", "current agent", "running", 1_000),
              abortController,
              unregisterCleanup,
            },
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: "agent-1",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    keybindingHarness.handlers["surface:stop"]?.();

    expect(abortController.signal.aborted).toBe(true);
    expect(unregisterCleanup).toHaveBeenCalledOnce();
    expect(changes.at(-1)?.tasks["agent-1"]).toMatchObject({
      status: "killed",
      abortController: undefined,
      unregisterCleanup: undefined,
    });
  });

  it("clears stale tail content immediately when switching selected agent tasks", async () => {
    keybindingHarness.tails["agent-old"] = [
      "old agent output",
      "stale output from old agent",
    ].join("\n");
    keybindingHarness.deferredTaskIds.add("agent-new");
    let selectAgent: ((taskId: string) => void) | null = null;
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
            tasks: {
              "agent-old": agentTask("agent-old", "old agent", "completed", 1_000),
              "agent-new": agentTask("agent-new", "new agent", "running", 2_000),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "agent-old",
            },
          }}
        >
          <AgentTaskSelector onReady={(setter) => { selectAgent = setter; }} />
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(screenText(stdout))).toContain("staleoutputfromoldagent");

      selectAgent?.("agent-new");
      await sleep(25);

      expect(compact(screenText(stdout))).toContain("running-newagent");
      expect(compact(screenText(stdout))).not.toContain("staleoutputfromoldagent");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("limits transcript entry to locally viewable agent task types", () => {
    expect(canEnterAgentTranscript({ id: "local", type: "local_agent" })).toBe(true);
    expect(canEnterAgentTranscript({ id: "team", type: "in_process_teammate" })).toBe(true);
    // Stale record with the deleted remote_agent scaffold kind stays view-only.
    expect(canEnterAgentTranscript({ id: "stale", type: "remote_agent" })).toBe(false);
    expect(canEnterAgentTranscript({ type: "local_agent" })).toBe(false);
    expect(canEnterAgentTranscript(null)).toBe(false);
  });

  it("keeps the last agent tail visible when a later poll fails", async () => {
    keybindingHarness.tails["agent-1"] = "current agent output";
    keybindingHarness.rejectOnRead["agent-1"] = 2;
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
            tasks: {
              "agent-1": agentTask("agent-1", "current agent", "running", 1_000),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "agent-1",
            },
          }}
        >
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(screenText(stdout))).toContain("currentagentoutput");

      await sleep(1_200);

      expect(compact(screenText(stdout))).toContain("currentagentoutput");
      expect(compact(screenText(stdout))).not.toContain("(nooutput)");
      expect(keybindingHarness.logError.mock.calls.some(([error]) =>
        error instanceof Error && error.message === "tail failed for agent-1"
      )).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps the current agent tail visible while a same-task status refresh is pending", async () => {
    keybindingHarness.tails["agent-1"] = "current agent output";
    let updateAgent: ((taskId: string, update: Record<string, unknown>) => void) | null = null;
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
            tasks: {
              "agent-1": agentTask("agent-1", "current agent", "running", 1_000),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "agent-1",
            },
          }}
        >
          <AgentTaskUpdater onReady={(updater) => { updateAgent = updater; }} />
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(screenText(stdout))).toContain("currentagentoutput");

      keybindingHarness.deferredTaskIds.add("agent-1");
      updateAgent?.("agent-1", { status: "completed", endTime: 2_000 });
      await sleep(25);

      expect(compact(screenText(stdout))).toContain("completed-currentagent");
      expect(compact(screenText(stdout))).toContain("currentagentoutput");
      expect(compact(screenText(stdout))).not.toContain("(nooutput)");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores stale tail read failures after switching selected agent tasks", async () => {
    keybindingHarness.deferredTaskIds.add("agent-old");
    keybindingHarness.tails["agent-new"] = "new agent output";
    let selectAgent: ((taskId: string) => void) | null = null;
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
            tasks: {
              "agent-old": agentTask("agent-old", "old agent", "running", 1_000),
              "agent-new": agentTask("agent-new", "new agent", "running", 2_000),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "agent-old",
            },
          }}
        >
          <AgentTaskSelector onReady={(setter) => { selectAgent = setter; }} />
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();
      expect(keybindingHarness.pendingRejects.has("agent-old")).toBe(true);

      selectAgent?.("agent-new");
      await sleep(25);

      keybindingHarness.pendingRejects.get("agent-old")?.(new Error("old tail failed"));
      await sleep(25);

      expect(compact(screenText(stdout))).toContain("newagentoutput");
      expect(keybindingHarness.logError).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores stale tail read successes after switching selected agent tasks", async () => {
    keybindingHarness.deferredTaskIds.add("agent-old");
    keybindingHarness.tails["agent-new"] = "new agent output";
    let selectAgent: ((taskId: string) => void) | null = null;
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
            tasks: {
              "agent-old": agentTask("agent-old", "old agent", "running", 1_000),
              "agent-new": agentTask("agent-new", "new agent", "running", 2_000),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "agent",
              selectedAgentTaskId: "agent-old",
            },
          }}
        >
          <AgentTaskSelector onReady={(setter) => { selectAgent = setter; }} />
          <AgentSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();
      expect(keybindingHarness.pendingReads.has("agent-old")).toBe(true);

      selectAgent?.("agent-new");
      await sleep(25);

      keybindingHarness.pendingReads.get("agent-old")?.({ content: "old stale output" });
      await sleep(25);

      expect(compact(screenText(stdout))).toContain("newagentoutput");
      expect(compact(screenText(stdout))).not.toContain("oldstaleoutput");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders rich progress, path, stop availability, and recent activity fallbacks", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              id: "agent-1",
              type: "local_agent",
              status: "running",
              description: "background review",
              startTime: 1_000,
              outputFile: "urn:agenc:task:agent-1:output",
              outputOffset: 0,
              notified: false,
              agentId: "agent-1",
              agentType: "worker",
              prompt: "review",
              cwd: "/repo",
              retrieved: false,
              pendingMessages: [],
              lastReportedToolCount: 0,
              lastReportedTokenCount: 0,
              retain: false,
              diskLoaded: false,
              progress: {
                toolUseCount: 3,
                tokenCount: 42,
                lastActivity: {
                  toolName: "Edit",
                },
                recentActivities: [
                  { activityDescription: "old activity" },
                  { activityDescription: "read file" },
                  { toolName: "Search" },
                  {},
                ],
              },
            },
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "agent",
            selectedAgentTaskId: "agent-1",
          },
        }}
      >
        <AgentSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("path /repo");
    expect(output).toContain("tools 3");
    expect(output).toContain("tokens 42");
    expect(output).toContain("now Edit");
    expect(output).toContain("recent read file");
    expect(output).toContain("recent Search");
    expect(output).toContain("recent activity");
    expect(output).not.toContain("old activity");
    expect(output).toContain("x stop");
    expect(output).toContain("enter transcript");
  });
});

function AgentTaskSelector({
  onReady,
}: {
  readonly onReady: (selectAgent: (taskId: string) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((selectedAgentTaskId: string) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          selectedAgentTaskId,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

function AgentTaskUpdater({
  onReady,
}: {
  readonly onReady: (updateAgent: (taskId: string, update: Record<string, unknown>) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((taskId: string, update: Record<string, unknown>) => {
      setAppState((state) => ({
        ...state,
        tasks: {
          ...state.tasks,
          [taskId]: {
            ...state.tasks[taskId],
            ...update,
          } as any,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

function agentTask(
  id: string,
  description: string,
  status: "running" | "completed",
  startTime: number,
): any {
  return {
    id,
    type: "local_agent",
    status,
    description,
    startTime,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
  };
}

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.resume();

  return {
    stdin,
    stdout,
  };
}

function sleep(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function screenText(stdout: PassThrough): string {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream) as
    | { readonly frontFrame?: { readonly screen?: { readonly width: number; readonly height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let row = 0; row < screen.height; row += 1) {
    const chars: string[] = [];
    for (let column = 0; column < screen.width; column += 1) {
      chars.push(cellAt(screen, column, row)?.char ?? " ");
    }
    rows.push(chars.join("").trimEnd());
  }
  return rows.join("\n");
}
