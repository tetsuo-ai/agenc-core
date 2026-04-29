import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_WORKFLOW_STATE,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
  ensureSessionWorkflowState,
  resolveSessionWorkflowState,
  updateSessionWorkflowState,
} from "./workflow-state.js";

describe("workflow-state", () => {
  it("defaults missing metadata to the idle workflow state", () => {
    expect(resolveSessionWorkflowState({})).toEqual(
      DEFAULT_SESSION_WORKFLOW_STATE,
    );
  });

  it("ensures an initial workflow state for new sessions", () => {
    const metadata: Record<string, unknown> = {};

    const state = ensureSessionWorkflowState(
      metadata,
      {
        stage: "plan",
        worktreeMode: "child_optional",
        objective: "Ship Phase 4",
      },
      100,
    );

    expect(state).toEqual({
      stage: "plan",
      worktreeMode: "child_optional",
      objective: "Ship Phase 4",
      enteredAt: 100,
      updatedAt: 100,
    });
    expect(metadata[SESSION_WORKFLOW_STATE_METADATA_KEY]).toEqual(state);
  });

  it("preserves enteredAt when the stage does not change", () => {
    const metadata: Record<string, unknown> = {
      [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
        stage: "implement",
        worktreeMode: "child_optional",
        enteredAt: 100,
        updatedAt: 100,
      },
    };

    const state = updateSessionWorkflowState(
      metadata,
      { objective: "Finish review polish" },
      250,
    );

    expect(state).toEqual({
      stage: "implement",
      worktreeMode: "child_optional",
      objective: "Finish review polish",
      enteredAt: 100,
      updatedAt: 250,
    });
  });

  it("resets enteredAt when the workflow stage changes", () => {
    const metadata: Record<string, unknown> = {
      [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
        stage: "plan",
        worktreeMode: "child_optional",
        enteredAt: 100,
        updatedAt: 120,
      },
    };

    const state = updateSessionWorkflowState(
      metadata,
      { stage: "review" },
      300,
    );

    expect(state).toEqual({
      stage: "review",
      worktreeMode: "child_optional",
      enteredAt: 300,
      updatedAt: 300,
    });
  });
});
