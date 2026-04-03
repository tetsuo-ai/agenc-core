import test from "node:test";
import assert from "node:assert/strict";

import { buildWatchAgentsReport } from "../../src/watch/agenc-watch-agents.mjs";

test("buildWatchAgentsReport summarizes active planner threads", () => {
  const report = buildWatchAgentsReport({
    planSteps: [
      {
        id: "step-1",
        label: "Review runtime",
        objective: "Review runtime/src/watch",
        note: "checking subagent lifecycle output",
        status: "running",
        subagentSessionId: "session:child-12345678",
        order: 1,
        updatedAt: 1_000,
      },
      {
        id: "step-2",
        label: "Write tests",
        objective: "Add regression tests",
        status: "planned",
        order: 2,
        updatedAt: 900,
      },
    ],
    plannerStatus: "running",
    plannerNote: "waiting on validation",
    activeAgentLabel: "Review runtime",
    activeAgentActivity: "checking subagent lifecycle output",
  });

  assert.match(report, /Planner/);
  assert.match(report, /status: running/);
  assert.match(report, /focus: Review runtime/);
  assert.match(report, /Active agents \(2\/2\)/);
  assert.match(report, /Review runtime · running · 12345678/);
});

test("buildWatchAgentsReport filters by query and can include completed steps", () => {
  const report = buildWatchAgentsReport({
    planSteps: [
      {
        id: "step-1",
        label: "Review runtime",
        status: "completed",
        subagentSessionId: "session:child-12345678",
        updatedAt: 1_000,
      },
      {
        id: "step-2",
        label: "Fix webchat contract",
        status: "running",
        updatedAt: 1_100,
      },
    ],
    plannerStatus: "needs_verification",
    query: "webchat",
    includeCompleted: true,
  });

  assert.match(report, /Agents \(1\/2\)/);
  assert.match(report, /Fix webchat contract/);
  assert.doesNotMatch(report, /Review runtime · completed/);
});
