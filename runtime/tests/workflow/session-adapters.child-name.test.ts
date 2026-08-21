/**
 * Workflow child agent names must satisfy the agent registry.
 *
 * The spawner derives a child's agent name from its deterministic child run
 * id, and the registry validates that name. The two disagreed: the derived
 * name kept the run id's dashes and dots while `assertValidAgentName`
 * accepts lowercase letters, digits and underscores only. Every workflow
 * child was therefore rejected on spawn, which failed `workflow.plan` on
 * both attempts and ended every verified-change run with
 * `step_retries_exhausted` before any work was done.
 */

import { describe, expect, it } from "vitest";

import { assertValidAgentName } from "../../src/agents/registry.js";
import { workflowChildAgentName } from "../../src/app-server/workflow/session-adapters.js";

/** Child run ids as the controller mints them, one per workflow stage. */
const CHILD_RUN_IDS = [
  "wf-3f78249a-c5e4-42b4-90ac-c89cf87618f5:plan#1",
  "wf-3f78249a-c5e4-42b4-90ac-c89cf87618f5:plan#2",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:implement#1",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:verify-agent#1",
  "wf-da1faa33-5db1-45df-96f2-af57d5fa2273:review#3",
] as const;

describe("workflowChildAgentName", () => {
  it("produces names the agent registry accepts", () => {
    for (const childRunId of CHILD_RUN_IDS) {
      expect(() =>
        assertValidAgentName(workflowChildAgentName(childRunId)),
      ).not.toThrow();
    }
  });

  it("folds every separator a child run id can carry", () => {
    expect(workflowChildAgentName("wf-ABC.123:plan#1")).toBe("wf_abc_123_plan_1");
  });

  it("is stable per child, and distinct between stages and attempts", () => {
    const first = workflowChildAgentName(CHILD_RUN_IDS[0]);
    expect(workflowChildAgentName(CHILD_RUN_IDS[0])).toBe(first);
    expect(workflowChildAgentName(CHILD_RUN_IDS[1])).not.toBe(first);
    expect(new Set(CHILD_RUN_IDS.map(workflowChildAgentName)).size).toBe(
      CHILD_RUN_IDS.length,
    );
  });
});
