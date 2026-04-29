import { describe, expect, test } from "vitest";

import {
  buildStatusNotices,
  getActiveNotices,
  readRuntimeStatusNoticeWarnings,
} from "./StatusNotices.js";

describe("buildStatusNotices", () => {
  test("reports context, budget, output, warning, and approval notices", () => {
    const notices = buildStatusNotices({
      session: {
        contextPercent: 91,
        costUsd: 4.5,
        budgetUsd: 5,
        budgetRemainingUsd: 0.5,
        outputTokens: 20_000,
      },
      pendingApprovalCount: 2,
      messages: [
        {
          id: "w1",
          turnId: "t1",
          kind: "warning",
          content: "LSP initialization failed",
          timestamp: 0,
        },
      ],
    });

    expect(notices.map((notice) => notice.id)).toEqual([
      "approvals",
      "warning:w1",
      "context",
      "budget",
      "output",
    ]);
  });

  test("derives project-memory and agent-definition notices from runtime session state", () => {
    const warnings = readRuntimeStatusNoticeWarnings({
      projectMemoryWarnings: ["AGENC.md include dropped: missing.md (not_found)"],
      agentDefinitions: {
        activeAgents: [
          { agentType: "worker", whenToUse: "implementation" },
          { name: "malformed" },
        ],
      },
    });

    expect(warnings.projectMemoryWarnings).toEqual([
      "AGENC.md include dropped: missing.md (not_found)",
    ]);
    expect(warnings.agentDefinitionWarnings?.[0]).toMatch(
      /agent definition.*malformed/i,
    );

    const notices = getActiveNotices({
      session: {},
      messages: [],
      configWarnings: ["Invalid config key"],
      ...warnings,
    });
    expect(notices.map((notice) => notice.id)).toEqual([
      "config:0",
      "project-memory:0",
      "agent-definition:0",
    ]);
  });
});
