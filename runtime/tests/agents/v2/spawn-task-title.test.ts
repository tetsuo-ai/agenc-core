import { describe, expect, it } from "vitest";

import { shortAgentTaskTitle } from "../../../src/agents/v2/spawn.js";

// Multi-agent UX loop iter 6 (D1b/D10 legibility). A live 5-agent fan-out drive
// showed each rail/transcript row labelled with the agent's ENTIRE prompt block
// ("You are responsible for generating a microservice stub for the 'billing'
// service under the src/ directory. Your task: 1. ..."). The spawned task's
// `description` must be a short title derived from task_name, not the prompt.

const PROMPT =
  "You are responsible for generating a microservice stub for the " +
  "\"billing\" service under the src/ directory. Your task: 1. Create the " +
  "folder src/billing/. 2. Write index.ts, README.md, and a smoke test.";

describe("shortAgentTaskTitle", () => {
  it("uses the task_name (humanized), never the full prompt", () => {
    const title = shortAgentTaskTitle("billing_microservice", PROMPT);
    expect(title).toBe("billing microservice");
    // the regression we are fixing: the title must NOT be the prompt block.
    expect(title).not.toBe(PROMPT);
    expect(title.length).toBeLessThan(PROMPT.length);
  });

  it("humanizes underscores and dashes from the task name", () => {
    expect(shortAgentTaskTitle("auth-gateway_v2", PROMPT)).toBe("auth gateway v2");
  });

  it("falls back to the first non-empty prompt line when no task name", () => {
    expect(shortAgentTaskTitle(undefined, "\n  Build the parser.\nmore detail")).toBe(
      "Build the parser.",
    );
    expect(shortAgentTaskTitle("   ", "Fix the off-by-one bug")).toBe(
      "Fix the off-by-one bug",
    );
  });

  it("bounds the length (rail rows must not overflow)", () => {
    const long = "a".repeat(200);
    const title = shortAgentTaskTitle(long, PROMPT);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });
});
