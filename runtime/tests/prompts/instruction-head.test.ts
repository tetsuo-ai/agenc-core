import { describe, expect, it } from "vitest";
import {
  resetRelevantMemoryBudget,
  getAttachmentTrackingState,
} from "../../src/session/attachment-state.js";
import {
  resetInstructionHead,
  stabilizeInstructionHead,
  takeInstructionHeadUpdate,
} from "../../src/prompts/instruction-head.js";

const v1 = { workspaceText: "W1", memoryText: "M1" };

describe("instruction head snapshot", () => {
  it("keeps the first version at the head and queues later changes once", () => {
    const tracking = getAttachmentTrackingState({});
    expect(stabilizeInstructionHead(tracking, v1, "/ws")).toEqual(v1);
    expect(tracking.pendingInstructionUpdate).toBeUndefined();

    // Same content again: nothing to say.
    expect(stabilizeInstructionHead(tracking, { ...v1 }, "/ws")).toEqual(v1);
    expect(tracking.pendingInstructionUpdate).toBeUndefined();

    // Memory changed: the head stays, the change is queued.
    expect(stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M2" }, "/ws")).toEqual(v1);
    expect(tracking.pendingInstructionUpdate).toEqual({ memoryText: "M2" });

    // The producer takes it once; the same files next turn say nothing new.
    expect(takeInstructionHeadUpdate(tracking)).toEqual({ memoryText: "M2" });
    expect(takeInstructionHeadUpdate(tracking)).toBeUndefined();
    expect(stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M2" }, "/ws")).toEqual(v1);
    expect(tracking.pendingInstructionUpdate).toBeUndefined();

    // A further change is measured against what was announced, not the head.
    stabilizeInstructionHead(tracking, { workspaceText: "W2", memoryText: "M2" }, "/ws");
    expect(tracking.pendingInstructionUpdate).toEqual({ workspaceText: "W2" });
  });

  it("drops a queued change that reverted before it was delivered", () => {
    const tracking = getAttachmentTrackingState({});
    stabilizeInstructionHead(tracking, v1, "/ws");
    stabilizeInstructionHead(tracking, { workspaceText: "W1", memoryText: "M2" }, "/ws");
    expect(tracking.pendingInstructionUpdate).toEqual({ memoryText: "M2" });
    stabilizeInstructionHead(tracking, v1, "/ws");
    expect(tracking.pendingInstructionUpdate).toBeUndefined();
  });

  it("starts a new head for a turn in another workspace instead of announcing a diff", () => {
    const tracking = getAttachmentTrackingState({});
    stabilizeInstructionHead(tracking, v1, "/ws-a");
    const other = { workspaceText: "WB", memoryText: "MB" };
    expect(stabilizeInstructionHead(tracking, other, "/ws-b")).toEqual(other);
    expect(tracking.pendingInstructionUpdate).toBeUndefined();
    expect(tracking.instructionHeadScope).toBe("/ws-b");
  });

  it("starts a new head after compaction reset", () => {
    const key = {};
    const tracking = getAttachmentTrackingState(key);
    stabilizeInstructionHead(tracking, v1, "/ws");
    resetRelevantMemoryBudget(key);
    expect(tracking.instructionHead).toBeUndefined();
    const v2 = { workspaceText: "W2", memoryText: "M2" };
    expect(stabilizeInstructionHead(tracking, v2, "/ws")).toEqual(v2);
    expect(tracking.pendingInstructionUpdate).toBeUndefined();
    resetInstructionHead(tracking);
    expect(tracking.instructionAnnounced).toBeUndefined();
  });
});
