import { describe, expect, it } from "vitest";

import {
  createRequestTaskProgressState,
  getRemainingRequestTaskMilestones,
  noteRequestTaskVerifierAttempt,
  observeRequestTaskToolRecord,
  setAllowedRequestTaskMilestones,
} from "./request-task-progress.js";

function taskResult(params: {
  readonly toolName?: "task.create" | "task.update" | "task.get" | "task.list";
  readonly id?: string;
  readonly status?: "pending" | "in_progress" | "completed" | "deleted";
  readonly metadata?: Record<string, unknown>;
}): { name: string; result: string } {
  const toolName = params.toolName ?? "task.update";
  if (toolName === "task.list") {
    return {
      name: toolName,
      result: JSON.stringify({
        count: 1,
        tasks: [{ id: "1", subject: "Task 1", status: "completed" }],
      }),
    };
  }
  const id = params.id ?? "1";
  const status = params.status ?? "pending";
  return {
    name: toolName,
    result: JSON.stringify({
      task: {
        id,
        subject: `Task ${id}`,
        status,
      },
      taskRuntime: {
        fullTask: {
          id,
          subject: `Task ${id}`,
          description: `Description ${id}`,
          status,
          blocks: [],
          blockedBy: [],
          ...(params.metadata ? { metadata: params.metadata } : {}),
          createdAt: 1,
          updatedAt: 2,
        },
        runtimeMetadata: {},
      },
    }),
  };
}

describe("request-task-progress", () => {
  it("derives milestone completion from latest completed task state and removes it when reopened", () => {
    const state = createRequestTaskProgressState();
    setAllowedRequestTaskMilestones(state, [
      { id: "phase_1", description: "Finish phase 1" },
      { id: "phase_2", description: "Finish phase 2" },
    ]);

    observeRequestTaskToolRecord(
      state,
      taskResult({
        id: "1",
        status: "completed",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1"],
          },
        },
      }),
    );

    expect(state.completedMilestoneIds).toEqual(["phase_1"]);
    expect(getRemainingRequestTaskMilestones(state)).toEqual([
      { id: "phase_2", description: "Finish phase 2" },
    ]);

    observeRequestTaskToolRecord(
      state,
      taskResult({
        id: "1",
        status: "in_progress",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1"],
          },
        },
      }),
    );

    expect(state.completedMilestoneIds).toEqual([]);
    expect(getRemainingRequestTaskMilestones(state)).toEqual([
      { id: "phase_1", description: "Finish phase 1" },
      { id: "phase_2", description: "Finish phase 2" },
    ]);
  });

  it("treats unknown milestone ids as malformed and ignores task.list for metadata refresh", () => {
    const state = createRequestTaskProgressState();
    setAllowedRequestTaskMilestones(state, [
      { id: "phase_1", description: "Finish phase 1" },
    ]);

    observeRequestTaskToolRecord(
      state,
      taskResult({
        id: "1",
        status: "completed",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_2"],
          },
        },
      }),
    );

    expect(state.completedMilestoneIds).toEqual([]);
    expect(state.malformedTasks).toEqual([
      {
        taskId: "1",
        errors: ["unknown request milestone ids: phase_2"],
      },
    ]);

    const beforeList = state.completedMilestoneIds;
    expect(observeRequestTaskToolRecord(state, taskResult({ toolName: "task.list" }))).toBeUndefined();
    expect(state.completedMilestoneIds).toBe(beforeList);
  });

  it("resets verification pressure when a verification task or verifier attempt is observed", () => {
    const state = createRequestTaskProgressState();
    for (const id of ["1", "2", "3"]) {
      observeRequestTaskToolRecord(
        state,
        taskResult({
          id,
          status: "completed",
        }),
      );
    }

    expect(state.completedNonVerificationTaskIdsSinceVerification).toEqual([
      "1",
      "2",
      "3",
    ]);

    observeRequestTaskToolRecord(
      state,
      taskResult({
        id: "4",
        status: "pending",
        metadata: {
          _runtime: {
            verification: true,
          },
        },
      }),
    );

    expect(state.completedNonVerificationTaskIdsSinceVerification).toEqual([]);

    observeRequestTaskToolRecord(
      state,
      taskResult({
        id: "5",
        status: "completed",
      }),
    );
    expect(state.completedNonVerificationTaskIdsSinceVerification).toEqual(["5"]);

    noteRequestTaskVerifierAttempt(state);
    expect(state.completedNonVerificationTaskIdsSinceVerification).toEqual([]);
  });
});
