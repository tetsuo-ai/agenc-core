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
    // Review item 5: plain requests.
    "Have two helpers read alpha.txt and beta.txt.",
    "Let two helpers check the docs.",
    "Spawn helpers for the lint and the tests.",
    "Spawn agents to check each file.",
    // A negation cue elsewhere in the sentence does not cancel the request.
    "Instead of doing it yourself, spawn two helpers.",
    "No, use two helpers.",
    "Rather than reading the files yourself, use two sub-agents.",
    "Don't read the files yourself, use two helpers instead.",
    "I do not need the docs, but use two helpers for the tests.",
    // English request in other text (review note N2).
    "Por favor use two sub-agents para esto",
    // Re-review R2: a negation does not reach across "and" before a base-form verb or across a spaced dash, and
    // polite openers are requests.
    "Stop doing it yourself and use two helpers.",
    "Stop reading the files yourself and spawn two helpers.",
    "Skip the manual review and use two sub-agents to check the PR.",
    "Don't touch the tests and use two sub-agents to fix the source.",
    "Do not change files and use two helpers to read alpha.txt and beta.txt.",
    "Don't modify anything - just use two helpers to read the files.",
    "Don't modify anything \u2014 just use two helpers to read the files.",
    "Don't modify anything \u2013 just use two helpers to read the files.",
    "Would it be possible to use two helpers for this?",
    "Could we use sub-agents for the review?",
    "Don't edit files and bring in two helpers to check them.",
    // The accepted tradeoff of R2: after "and" a base-form verb starts a new instruction.
    "I don't want you to edit files and use sub-agents.",
    "Please don't edit files and use sub-agents to review them.",
    // Every match counts, and each sentence is read on its own (re-review T1).
    "Please avoid using sub-agents for the docs, but use sub-agents for the tests.",
    "Do not change files. Use two helpers to read alpha.txt and beta.txt.",
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
    // Review item 1: opt-outs.
    "I don't want you to use sub-agents for this.",
    "You do not need to use sub-agents for this.",
    "Please avoid using sub-agents.",
    "Instead of spawning sub-agents, read both files yourself.",
    "Rather than using two helpers, just do it.",
    "Using sub-agents would be overkill here, just read the file.",
    "There is no reason to use sub-agents here.",
    "Please, do not use sub-agents.",
    "You should not, in this case, spawn helpers.",
    "Do not, under any circumstances, spawn sub-agents.",
    "Never, ever spawn helpers.",
    // Review item 2: questions about the feature.
    "How do I use sub-agents in AgenC?",
    "Does AgenC support spawning sub-agents?",
    "Should I use sub-agents for this?",
    "What does 'spawn two agents' mean in the docs?",
    "What does \u2018spawn two agents\u2019 mean?",
    // Review item 3: a single helper is a helper function.
    "Delegate the formatting to a helper.",
    "Offload the date parsing to a helper.",
    "Hand off the parsing to a helper so the handler stays short.",
    "Process the files concurrently using a helper that limits the pool size.",
    // Re-review R2: a cue left before an aside, and a gerund after "and" that the negation still governs.
    "Avoid, if possible, spawning sub-agents.",
    "Avoid editing files and using sub-agents.",
    // Other languages (review note N2).
    "Agrega una funcion helper para las fechas.",
    "Usa un helper para parsear la fecha.",
    "El agente usa sub-agents con un helper para cada archivo? Explica el codigo.",
  ])("does not ask for helpers: %s", (text) => {
    expect(requestsHelpers(text)).toBe(false);
  });

  // fx31 re-review: a removed span must not join the words on either side of it.
  test("the words around a code span or a quote do not join into a request", () => {
    expect(requestsHelpers("Use `--no` sub-agents flag when you run the tests.")).toBe(false);
    expect(requestsHelpers('Use "--no" sub-agents flag when you run the tests.')).toBe(false);
    // A request next to a code span still counts.
    expect(requestsHelpers("Use two sub-agents to run `npm test` and `npm run lint`.")).toBe(true);
  });

  // fx31 re-review 2: an opt-out right before a code span or a quote still declines, as on 0.19.30.
  test.each([
    "Earlier you asked me to use two sub-agents. Do not use sub-agents `at all`.",
    'Earlier you asked me to use two sub-agents. Do not use sub-agents "at all".',
    "Use two sub-agents for the API review. Do not use sub-agents `elsewhere`.",
    "Spawn two helpers to read the files, but do not delegate `the summary`.",
    "Do not use helpers `here`; use two sub-agents for the docs.",
  ])("an opt-out followed by a code span or a quote still wins: %s", (prompt) => {
    expect(requestsHelpers(prompt)).toBe(false);
  });

  // fx31 known limit: a double quote right after a digit is an inch mark, but it paired with the next double quote on
  // its line as the start of a quotation.
  test.each([
    'Set the 5" display; use two helpers to check "beta.txt" and alpha.txt',
    "He is 6'2\" tall; spawn two helpers to read \"alpha.txt\" and \"beta.txt\".",
  ])("an inch mark does not hide the request after it: %s", (text) => {
    expect(requestsHelpers(text)).toBe(true);
  });

  test.each([
    'The 27" monitor guide says "use two helpers" for this setup.',
    'Print the 5" label, then "use two helpers" stays a literal string in the config.',
  ])("an inch mark does not leave the quotation after it unpaired: %s", (text) => {
    expect(requestsHelpers(text)).toBe(false);
  });

  test("a quotation that ends with a digit still ends there, and a lone inch mark hides nothing", () => {
    expect(requestsHelpers('Explain "use 2 helpers" and "version 2" in the docs.')).toBe(false);
    expect(requestsHelpers('Set the 5" display and use two helpers to check alpha.txt and beta.txt.')).toBe(true);
  });

  test("treats missing input as no request", () => {
    expect(requestsHelpers(null)).toBe(false);
  });

  test("every match counts: an opt-out for one part does not cancel a request for another", () => {
    expect(requestsHelpers("Please avoid using sub-agents for the docs.")).toBe(false);
    expect(requestsHelpers("Please avoid using sub-agents for the docs, but use sub-agents for the tests.")).toBe(true);
  });

  test("each sentence is read on its own: a negation in one sentence does not reach the next", () => {
    expect(requestsHelpers("Do not change files and do not use two helpers.")).toBe(false);
    expect(requestsHelpers("Do not change files. Use two helpers to read alpha.txt and beta.txt.")).toBe(true);
    expect(requestsHelpers(GATE_SCENARIO_4)).toBe(true);
  });

  // The docs say the check reads English: these requests are not detected (review note N2).
  test.each([
    "Usa dos sub-agentes para revisar la API y la TUI.",
    "Lanza dos agentes en paralelo para revisar alpha.txt y beta.txt.",
    "Utilise deux sous-agents pour verifier les fichiers.",
    "Verwende zwei Subagenten fuer die Pruefung.",
  ])("reads English only: %s", (text) => {
    expect(requestsHelpers(text)).toBe(false);
  });
});

// It runs synchronously on every Light root turn's text in the daemon. Every match of every pattern is checked, so the
// look-back for a negation is bounded: unbounded, 1 MB of "avoid using sub-agents, " took 30 s (re-review R1). A run
// takes about 30 to 45 ms; the 500 ms bound leaves room for a loaded machine and still fails the quadratic version
// about 60 times over.
describe("requestsHelpers on large inputs", () => {
  const MB = 1 << 20;
  const repeat = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  test.each([
    ["avoid using sub-agents, ", false],
    ["avoid using sub-agents ", false],
    ["instead of spawn agents ", false],
    ["The agent reads the file. ", false],
    ["Add a helper function, keep the helpers small; the agent SDK. ", false],
    ["The parser reads the file. It keeps the rows in order; the writer flushes them. ", false],
  ])("1 MB of %j finishes in under 500 ms", (unit, expected) => {
    const text = repeat(unit, MB);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      expect(requestsHelpers(text)).toBe(expected);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(500);
  });
});

describe("routeSwarmTask names helpers like agents and workers", () => {
  test("an explicit count of helpers is explicit parallelism", () => {
    expect(routeSwarmTask("Use two helpers to review the API and the TUI").signals).toContain(
      "explicit_parallelism",
    );
  });

  // Review item 4: a helper followed by a code noun stays code under /swarm too, as on de8c71a5a562.
  test.each([
    "Use two helper functions for parsing and formatting.",
    "Use 2 helper methods instead of one big function.",
    "Spawn two helper processes that watch the files.",
    "Delegate the parsing to two helper functions.",
  ])("a helper followed by a code noun is not explicit parallelism: %s", (prompt) => {
    const decision = routeSwarmTask(prompt);
    expect(decision.signals).not.toContain("explicit_parallelism");
    expect(decision.mode).toBe("sequential");
  });

  // sub30 Fsub30-3: code spans and quotes are examples, not requests, as for requestsHelpers.
  test.each([
    "Explain `use two helpers` in the docs.",
    "Document what ```\nuse two helpers\n``` does in the README.",
    'Is "use two helpers" a good name for this setting?',
    "Reply to this quote:\n> Parallelize the review across four agents.\nKeep the answer short.",
  ])("a request for helpers inside code or quotes is not explicit parallelism: %s", (prompt) => {
    const decision = routeSwarmTask(prompt);
    expect(decision.signals).not.toContain("explicit_parallelism");
    expect(decision.mode).toBe("sequential");
  });

  // fx31 review: a removed span must not join the words around it. These routed sequential on 0.19.30 and stay so.
  test.each([
    "Run `npm test` in parallel.",
    "Delegate `review` to two agents.",
    "Review `api/` and `tui/` concurrently.",
    'Check "alpha.txt" and "beta.txt" in parallel.',
  ])("a pattern does not match across a removed span: %s", (prompt) => {
    const decision = routeSwarmTask(prompt);
    expect(decision.signals).not.toContain("explicit_parallelism");
    expect(decision.mode).toBe("sequential");
  });

  test("an inch mark does not hide the request after it", () => {
    expect(routeSwarmTask('Set the 5" display; review api and tui in parallel using "beta.txt" as a guide.')).toMatchObject({
      mode: "parallel",
      signals: expect.arrayContaining(["explicit_parallelism"]),
    });
  });

  test("an inch mark does not leave the quotation after it unpaired", () => {
    const decision = routeSwarmTask('The 27" monitor docs say "review the api and the tui in parallel" for this.');
    expect(decision.signals).not.toContain("explicit_parallelism");
    expect(decision.mode).toBe("sequential");
  });

  test("a request next to a quoted example still routes parallel", () => {
    expect(routeSwarmTask("Use two helpers to review the API and the TUI, as the `swarm` docs describe.")).toMatchObject({
      mode: "parallel",
      signals: expect.arrayContaining(["explicit_parallelism"]),
    });
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
