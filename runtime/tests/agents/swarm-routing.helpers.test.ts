/**
 * Explicit helper requests (agents/swarm-routing.ts requestsHelpers) and the routing word list that now names
 * helpers. The first case is the real daemon gate's helper scenario, which Light sessions mostly answered without
 * spawning a helper.
 */
import { describe, expect, test } from "vitest";

import { requestsHelpers, routeSwarmTask } from "../../src/agents/swarm-routing.js";

const GATE_SCENARIO_4 =
  "Please do these two independent checks in parallel using two helpers.\n" +
  "Helper one: read alpha.txt and report its number.\n" +
  "Helper two: read beta.txt and report its number.\n" +
  "Do not change files. Wait for both helpers and report both results.";

describe("requestsHelpers", () => {
  test.each([
    GATE_SCENARIO_4,
    "Please do these two checks using two helpers.",
    "Use two sub-agents to review the API and the TUI.",
    "use subagents for this",
    "Spawn three agents to investigate these bugs.",
    "Can you spawn a helper to run the tests while you fix the docs?",
    "Spawn a helper to read alpha.txt.",
    "Use an agent to research the API.",
    "Ask two helpers to read the files.",
    "Get two agents to check the README and the changelog.",
    "Could you use multiple sub-agents here?",
    "Spin up two helpers for the lint and the tests.",
    "Run 3 agents in parallel on these files",
    "Have a sub-agent look at the logs.",
    "Use a helper agent to summarize the file.",
    "Start a child agent for the migration review.",
    "Delegate the review to two agents.",
    "Split the work between two helpers.",
    "In parallel with helpers, check A and B.",
    "Use subagents only with my approval.",
    "Helper one: read a.txt\nHelper two: read b.txt",
    "Agent 1: audit the API\nAgent 2: audit the TUI",
  ])("asks for helpers: %s", (text) => {
    expect(requestsHelpers(text)).toBe(true);
  });

  test.each([
    "Read alpha.txt and report its number.",
    "Add a helper function to parse dates.",
    "Use a helper function for this.",
    "Use a helper to parse the date.",
    "Implement this with a helper.",
    "Refactor the string helpers in utils.ts.",
    "Use the helpers in utils.ts.",
    "Update the test helpers so they reset the clock.",
    "Write two helper functions and their tests.",
    "Add helpers.ts with a slugify helper.",
    "We have two helpers in utils, merge them.",
    "Run two worker threads for the build.",
    "Configure gunicorn to use 4 workers.",
    "Use a background worker to send email.",
    "Use a Worker from node:worker_threads to parse the CSV.",
    "Spawn a child to investigate the failure.",
    "Use a child process to run the command.",
    "Use an agent SDK to build the bot.",
    "Use the agent field from the config.",
    "Assign the value to the agents array.",
    "Start a helper process that watches files.",
    "Fix the bug in the subagent depth limit.",
    "The user agent string is wrong in http.ts",
    "Do not use helpers.",
    "Don't use two helpers; do it yourself.",
    "Without using sub-agents, read alpha.txt.",
    "No need to spawn agents, just read the file.",
    "Handle this yourself without sub-agents",
    "Use no subagents.",
    "Use subagents to inspect the files. Do not use subagents.",
    "```\nspawning 2 agents\n```\nwhat does this log mean?",
    "Explain `use two helpers` in the docs.",
    "> use two sub-agents\nThat quote is from the issue; fix the typo in it.",
    'Explain "Spawn two independent agents to inspect the files."',
    "Helper one: read a.txt",
    "",
  ])("does not ask for helpers: %s", (text) => {
    expect(requestsHelpers(text)).toBe(false);
  });

  test("treats missing input as no request", () => {
    expect(requestsHelpers(null)).toBe(false);
  });
});

describe("routeSwarmTask names helpers like agents and workers", () => {
  test("an explicit count of helpers is explicit parallelism", () => {
    expect(routeSwarmTask("Use two helpers to review the API and the TUI").signals).toContain(
      "explicit_parallelism",
    );
  });

  test.each(["Do not use helpers for this task", "Handle this yourself without helpers", "Use no helpers"])(
    "an opt-out that names helpers keeps the work local: %s",
    (prompt) => {
      expect(routeSwarmTask(prompt)).toMatchObject({
        mode: "sequential",
        signals: expect.arrayContaining(["explicit_no_delegation"]),
      });
    },
  );
});
