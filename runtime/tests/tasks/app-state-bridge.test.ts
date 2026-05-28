import { describe, expect, it } from "vitest";

import type { BackgroundTaskSnapshot } from "./lifecycle.js";
import { syncBackgroundTaskSnapshotToAppState } from "./app-state-bridge.js";

function snapshot(
  overrides: Partial<BackgroundTaskSnapshot> = {},
): BackgroundTaskSnapshot {
  return {
    id: "agent-1",
    type: "local_agent",
    status: "running",
    description: "inspect the repo",
    startedAtMs: 10,
    output: { uri: "urn:agenc:task:agent-1:output", bytes: 0 },
    outputOffset: 0,
    notified: false,
    metadata: {
      threadName: "reviewer",
      agentRole: "worker",
      model: "qwen3.6-35b-a3b-fp8",
      cwd: "  /repo/current  ",
      worktreePath: "  /repo/worktree  ",
    },
    progress: {
      toolUseCount: 2,
      tokenCount: 123,
    },
    ...overrides,
  };
}

describe("syncBackgroundTaskSnapshotToAppState", () => {
  it("mirrors local_agent lifecycle snapshots into AppState task shape", () => {
    let appState: unknown = { tasks: {} };
    syncBackgroundTaskSnapshotToAppState(
      {
        setAppState(updater) {
          appState = updater(appState);
        },
      },
      snapshot(),
    );

    expect(appState).toMatchObject({
      tasks: {
        "agent-1": {
          id: "agent-1",
          type: "local_agent",
          status: "running",
          description: "reviewer",
          agentId: "agent-1",
          prompt: "inspect the repo",
          agentType: "worker",
          model: "qwen3.6-35b-a3b-fp8",
          cwd: "/repo/current",
          worktreePath: "/repo/worktree",
          isBackgrounded: true,
          progress: {
            toolUseCount: 2,
            tokenCount: 123,
          },
        },
      },
    });
  });

  it("preserves UI-owned local agent fields across lifecycle updates", () => {
    let appState: unknown = {
      tasks: {
        "agent-1": {
          id: "agent-1",
          type: "local_agent",
          status: "running",
          description: "old",
          startTime: 1,
          outputFile: "old",
          outputOffset: 0,
          notified: false,
          agentId: "agent-1",
          prompt: "old prompt",
          agentType: "worker",
          retrieved: true,
          lastReportedToolCount: 1,
          lastReportedTokenCount: 2,
          isBackgrounded: true,
          pendingMessages: ["follow up"],
          retain: true,
          diskLoaded: true,
          messages: [{ type: "assistant" }],
        },
      },
    };
    syncBackgroundTaskSnapshotToAppState(
      {
        setAppState(updater) {
          appState = updater(appState);
        },
      },
      snapshot({ status: "completed", endedAtMs: 20, notified: true }),
    );

    expect(appState).toMatchObject({
      tasks: {
        "agent-1": {
          status: "completed",
          retrieved: true,
          pendingMessages: ["follow up"],
          retain: true,
          diskLoaded: true,
          messages: [{ type: "assistant" }],
        },
      },
    });
  });

  it("surfaces final agent messages as completed task summaries", () => {
    let appState: unknown = { tasks: {} };
    syncBackgroundTaskSnapshotToAppState(
      {
        setAppState(updater) {
          appState = updater(appState);
        },
      },
      snapshot({
        status: "completed",
        endedAtMs: 20,
        metadata: {
          threadName: "reviewer",
          finalMessage: "Found the remaining provider-boundary work.",
        },
        progress: {
          toolUseCount: 4,
          tokenCount: 500,
        },
      }),
    );

    expect(appState).toMatchObject({
      tasks: {
        "agent-1": {
          status: "completed",
          progress: {
            toolUseCount: 4,
            tokenCount: 500,
            summary: "Found the remaining provider-boundary work.",
          },
        },
      },
    });
  });

  it("preserves previous display paths when later lifecycle snapshots omit metadata", () => {
    let appState: unknown = {
      tasks: {
        "agent-1": {
          id: "agent-1",
          type: "local_agent",
          status: "running",
          description: "old",
          startTime: 1,
          outputFile: "old",
          outputOffset: 0,
          notified: false,
          agentId: "agent-1",
          prompt: "old prompt",
          agentType: "worker",
          cwd: "/repo/current",
          worktreePath: "/repo/worktree",
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          isBackgrounded: true,
          pendingMessages: [],
          retain: false,
          diskLoaded: false,
        },
      },
    };
    syncBackgroundTaskSnapshotToAppState(
      {
        setAppState(updater) {
          appState = updater(appState);
        },
      },
      snapshot({ metadata: undefined }),
    );

    expect(appState).toMatchObject({
      tasks: {
        "agent-1": {
          cwd: "/repo/current",
          worktreePath: "/repo/worktree",
        },
      },
    });
  });

  it("ignores lifecycle-only task kinds that do not belong in AppState.tasks", () => {
    const original = { tasks: {} };
    let appState: unknown = original;
    syncBackgroundTaskSnapshotToAppState(
      {
        setAppState(updater) {
          appState = updater(appState);
        },
      },
      snapshot({ type: "generic" }),
    );

    expect(appState).toBe(original);
  });
});
