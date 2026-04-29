import { describe, expect, test } from "vitest";

import { buildStatusNotices } from "./StatusNotices.js";

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
});
