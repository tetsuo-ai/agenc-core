import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  LocalAgentTaskState,
  LocalShellTaskState,
} from "../../src/tasks/types.js";
import type { AppState } from "../../src/tui/state/AppStateStore.js";

const getTaskOutputDeltaMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputDelta: getTaskOutputDeltaMock,
}));

import {
  applyTaskOffsetsAndEvictions,
  collectTaskStateMaintenance,
} from "../../src/utils/task/framework.js";

function shellTask(
  id: string,
  overrides: Partial<LocalShellTaskState> = {},
): LocalShellTaskState {
  return {
    id,
    type: "local_bash",
    status: "running",
    description: id,
    startTime: 1,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: false,
    command: "echo test",
    ...overrides,
  };
}

function agentTask(
  id: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "completed",
    description: id,
    startTime: 1,
    outputFile: `/tmp/${id}.log`,
    outputOffset: 0,
    notified: true,
    agentId: id,
    prompt: "test",
    agentType: "general-purpose",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  };
}

function stateWith(
  ...tasks: Array<LocalShellTaskState | LocalAgentTaskState>
): AppState {
  return {
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
  } as unknown as AppState;
}

function applyMaintenance(
  state: AppState,
  maintenance: Awaited<ReturnType<typeof collectTaskStateMaintenance>>,
): AppState {
  let next = state;
  applyTaskOffsetsAndEvictions(
    (updater) => {
      next = updater(next);
    },
    maintenance.updatedTaskOffsets,
    maintenance.evictedTaskIds,
  );
  return next;
}

beforeEach(() => {
  getTaskOutputDeltaMock.mockReset();
});

describe("task state maintenance", () => {
  test("collects output offsets without manufacturing attachment payloads", async () => {
    getTaskOutputDeltaMock.mockResolvedValue({
      content: "new output",
      newOffset: 42,
    });
    const state = stateWith(shellTask("running", { outputOffset: 7 }));

    const maintenance = await collectTaskStateMaintenance(state);

    expect(getTaskOutputDeltaMock).toHaveBeenCalledWith("running", 7);
    expect(maintenance).toEqual({
      updatedTaskOffsets: { running: 42 },
      evictedTaskIds: [],
    });
    expect(Object.hasOwn(maintenance, "attachments")).toBe(false);
    expect(
      applyMaintenance(state, maintenance).tasks.running?.outputOffset,
    ).toBe(42);
  });

  test("evicts only fresh terminal tasks that have already been notified", async () => {
    const terminal = shellTask("terminal", {
      status: "completed",
      notified: true,
    });
    const maintenance = await collectTaskStateMaintenance(stateWith(terminal));

    expect(maintenance.evictedTaskIds).toEqual(["terminal"]);
    expect(
      applyMaintenance(stateWith(terminal), maintenance).tasks.terminal,
    ).toBeUndefined();

    const unnotified = shellTask("terminal", {
      status: "completed",
      notified: false,
    });
    expect(
      applyMaintenance(stateWith(unnotified), maintenance).tasks.terminal,
    ).toEqual(unnotified);

    const resumed = shellTask("terminal", {
      status: "running",
      notified: false,
      outputOffset: 11,
    });
    expect(
      applyMaintenance(stateWith(resumed), maintenance).tasks.terminal,
    ).toEqual(resumed);
  });

  test("does not overwrite a concurrent terminal transition with a stale offset", async () => {
    getTaskOutputDeltaMock.mockResolvedValue({
      content: "late output",
      newOffset: 99,
    });
    const maintenance = await collectTaskStateMaintenance(
      stateWith(shellTask("transition", { outputOffset: 5 })),
    );
    const completed = shellTask("transition", {
      status: "completed",
      notified: false,
      outputOffset: 12,
    });

    const next = applyMaintenance(stateWith(completed), maintenance);

    expect(next.tasks.transition).toEqual(completed);
  });

  test("preserves retained agent results until their eviction deadline", async () => {
    const retained = agentTask("retained", {
      retain: true,
      evictAfter: Date.now() + 60_000,
    });
    const maintenance = await collectTaskStateMaintenance(stateWith(retained));

    expect(maintenance.evictedTaskIds).toEqual(["retained"]);
    expect(
      applyMaintenance(stateWith(retained), maintenance).tasks.retained,
    ).toEqual(retained);

    const expired = { ...retained, evictAfter: 0 };
    expect(
      applyMaintenance(stateWith(expired), maintenance).tasks.retained,
    ).toBeUndefined();
  });
});
