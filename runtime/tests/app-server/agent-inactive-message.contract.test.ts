import { describe, expect, it } from "vitest";

import { inactiveAgentMessageForTest } from "./agent-lifecycle.js";

describe("message for an agent that cannot take work", () => {
  // Regression: a model turn was denied `context_window_exceeded`, the run
  // went to `errored` 9ms later, and every send after that answered
  // "AgenC daemon agent not found". The agent was in the registry the whole
  // time with status `error` — "not found" pointed at a lookup bug two layers
  // below the actual cause and cost hours of sqlite archaeology.
  it("says the run ended, not that the agent is missing, when it is present but inactive", () => {
    const message = inactiveAgentMessageForTest("conv-abc", {
      status: "error",
    });

    expect(message).toContain("conv-abc");
    expect(message).toContain("no longer running");
    expect(message).toContain("status: error");
    expect(message).not.toContain("not found");
  });

  it("keeps the not-found wording when the registry genuinely has no such agent", () => {
    expect(inactiveAgentMessageForTest("agent_missing", undefined)).toBe(
      "AgenC daemon agent not found: agent_missing",
    );
  });

  it("reports stopped agents by their real status", () => {
    const message = inactiveAgentMessageForTest("conv-xyz", {
      status: "stopped",
    });

    expect(message).toContain("status: stopped");
    expect(message).not.toContain("not found");
  });
});
