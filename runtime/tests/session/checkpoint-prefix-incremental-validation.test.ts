/**
 * Opening a session validates every durable checkpoint against the history
 * before it. The incremental validator does each per-message gate once per
 * history instead of once per checkpoint; these tests hold it to the full
 * validator's outcome, failure for failure.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IncrementalCheckpointPrefixValidatorV4,
  computeCheckpointPrefixHashV4,
  validateCheckpointPrefixV4,
  type DurableCheckpointPrefixValidation,
} from "../../src/session/durable-checkpoint-reader.js";
import type { TurnCheckpointV4Event } from "../../src/session/event-log.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";
import { CORPUS_RUN_ID, checkpointPrefixCorpus } from "./fixtures/checkpoint-prefix-corpus.js";
import {
  RUN_ID,
  assistant,
  checkpoint,
  longSession,
  sealed,
  writerCheckpoints,
  type Message,
} from "./fixtures/long-checkpoint-session.js";

let agencHome: string;
let cwd: string;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-incremental-checkpoint-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-incremental-checkpoint-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver, { discardOnTerminal: true });
});

afterEach(() => {
  driver.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

let fullValidations = 0;
function fullValidation(
  checkpointEvent: TurnCheckpointV4Event,
  messages: readonly Message[],
  runId = RUN_ID,
): DurableCheckpointPrefixValidation {
  fullValidations += 1;
  return validateCheckpointPrefixV4({
    checkpoint: checkpointEvent,
    expectedRunId: runId,
    messages,
    projection,
    projectionId: `full-${fullValidations}`,
    sourceKey: "incremental-test",
  });
}

function incrementalValidator(runId = RUN_ID): IncrementalCheckpointPrefixValidatorV4 {
  return new IncrementalCheckpointPrefixValidatorV4({
    expectedRunId: runId,
    projection,
    projectionId: "incremental",
    sourceKey: "incremental-test",
  });
}

/** Validate every checkpoint both ways, in order, continuing after failures. */
function compareAll(
  checkpoints: readonly TurnCheckpointV4Event[],
  history: readonly Message[],
  runId = RUN_ID,
): { readonly outcomes: string[]; readonly fallbacks: number } {
  const validator = incrementalValidator(runId);
  const outcomes: string[] = [];
  let fallbacks = 0;
  for (const event of checkpoints) {
    const full = fullValidation(event, history, runId);
    const incremental = validator.validate(event, history);
    if (incremental === undefined) fallbacks += 1;
    else expect(incremental).toEqual(full);
    outcomes.push(full.status === "valid" ? "valid" : `${full.status}:${full.failure.code}`);
  }
  validator.close();
  return { outcomes, fallbacks };
}

function projectionRuns(): Array<{ readonly projection_id: string; readonly status: string }> {
  return driver.state
    .prepare("SELECT projection_id, status FROM tool_pair_projection_runs ORDER BY projection_id")
    .all() as Array<{ readonly projection_id: string; readonly status: string }>;
}

describe("incremental checkpoint prefix validation", () => {
  it("equals the full validator at every checkpoint of a long session", () => {
    const history = longSession(40);
    const checkpoints = writerCheckpoints(history);
    expect(checkpoints.length).toBe(80);
    const { outcomes, fallbacks } = compareAll(checkpoints, history);
    expect(fallbacks).toBe(0);
    expect(new Set(outcomes)).toEqual(new Set(["valid"]));
    // Its ephemeral projection run is discarded when it closes.
    expect(projectionRuns()).toEqual([]);
  });

  it("equals the full validator over every field the digest authenticates", () => {
    const corpus = checkpointPrefixCorpus().durable as Message[];
    const checkpoints = Array.from({ length: corpus.length + 1 }, (_, count) => {
      let prefixHash: string;
      try {
        prefixHash = computeCheckpointPrefixHashV4(corpus, count);
      } catch {
        prefixHash = "0".repeat(64); // a prefix that cuts the invocation channel group
      }
      return checkpoint(corpus, count, "postAssistant", count + 1, prefixHash);
    });
    const { outcomes, fallbacks } = compareAll(checkpoints, corpus, CORPUS_RUN_ID);
    expect(fallbacks).toBe(0);
    // The corpus covers digest fields, not pairing: a result for a call no
    // assistant opened closes the tool-pair stream, so every later prefix
    // starts over and fails there again, after the shape and sequence gates.
    expect(new Set(outcomes)).toEqual(new Set([
      "valid",
      "invalid:tool_result_unknown_id",
      "invalid:agent_invocation_integrity_failure",
    ]));
    expect(outcomes.indexOf("invalid:tool_result_unknown_id")).toBeGreaterThan(5);
  });

  type Mutation = {
    readonly name: string;
    readonly mutate: (history: Message[], checkpoints: TurnCheckpointV4Event[]) => void;
    readonly failures: readonly string[];
  };
  const mutations: Mutation[] = [
    {
      name: "a tampered tool result body",
      mutate: (history) => { history[12] = { ...history[12]!, content: "tampered" }; },
      failures: ["invalid:tool_result_integrity_invalid"],
    },
    {
      name: "tampered tool call arguments",
      mutate: (history) => {
        const message = history[9]!;
        history[9] = { ...message, toolCalls: [{ ...message.toolCalls![0]!, arguments: "{}" }] };
      },
      failures: ["invalid:checkpoint_prefix_digest_mismatch"],
    },
    {
      name: "an unversioned message field",
      mutate: (history) => { history[15] = { ...history[15]!, extra: true } as unknown as Message; },
      failures: ["invalid:checkpoint_response_shape_invalid"],
    },
    {
      name: "a seal on an assistant message",
      mutate: (history) => {
        history[11] = { ...history[11]!, toolResultIntegrity: history[12]!.toolResultIntegrity };
      },
      failures: ["invalid:misplaced_tool_result_integrity"],
    },
    {
      name: "a result sealed for another run",
      mutate: (history) => { history[21] = sealed("call-10", "other run", "conv-other"); },
      failures: ["invalid:tool_result_integrity_invalid"],
    },
    {
      name: "a repeated tool call id",
      mutate: (history) => {
        history[22] = assistant(11, ["call-3"]);
        history[23] = sealed("call-3", `export const value11 = compute("call-3");\n`.repeat(8));
      },
      failures: ["invalid:assistant_tool_call_id_duplicate"],
    },
    {
      name: "invocation-channel text without its metadata",
      mutate: (history) => {
        history[0] = { role: "user", content: JSON.stringify({ kind: "agent_invocation_runtime_policy" }) };
      },
      failures: ["invalid:agent_invocation_integrity_failure"],
    },
    {
      name: "one checkpoint with a wrong digest",
      mutate: (history, checkpoints) => {
        const target = checkpoints[9]!;
        checkpoints[9] = checkpoint(history, target.persistedMessageCount, target.boundary as "iteration",
          target.checkpointSeq, "e".repeat(64));
      },
      failures: ["invalid:checkpoint_prefix_digest_mismatch"],
    },
  ];

  it.each(mutations)("fails exactly as the full validator on $name, then continues", ({ mutate, failures }) => {
    const history = longSession(20);
    const checkpoints = writerCheckpoints(history);
    mutate(history, checkpoints);
    const { outcomes, fallbacks } = compareAll(checkpoints, history);
    expect(fallbacks).toBe(0);
    expect(new Set(outcomes.filter((outcome) => outcome !== "valid"))).toEqual(new Set(failures));
  });

  it("reports an iteration checkpoint whose results are missing as the full validator does", () => {
    const history = longSession(10);
    // An iteration checkpoint taken right after the assistant message.
    const checkpoints = [
      checkpoint(history, 2, "postAssistant", 1),
      checkpoint(history, 2, "iteration", 2),
      checkpoint(history, 4, "postAssistant", 3),
      checkpoint(history, 5, "iteration", 4),
    ];
    const { outcomes, fallbacks } = compareAll(checkpoints, history);
    expect(fallbacks).toBe(0);
    expect(outcomes).toEqual(["valid", "invalid:tool_result_missing", "valid", "valid"]);
  });

  it("defers to the full validator for a shorter prefix and keeps its own place", () => {
    const history = longSession(12);
    const checkpoints = writerCheckpoints(history);
    const reordered = [...checkpoints.slice(0, 10), checkpoints[3]!, ...checkpoints.slice(10)];
    const { outcomes, fallbacks } = compareAll(reordered, history);
    expect(fallbacks).toBe(1);
    expect(new Set(outcomes)).toEqual(new Set(["valid"]));
  });

  it("starts over when the history is replaced or rewritten in place", () => {
    const history = longSession(12);
    const checkpoints = writerCheckpoints(history);
    const validator = incrementalValidator();
    for (const event of checkpoints.slice(0, 8)) {
      expect(validator.validate(event, history)).toEqual(fullValidation(event, history));
    }
    // The same messages in a new array: everything is checked again.
    const copy = [...history];
    for (const event of checkpoints.slice(8, 12)) {
      expect(validator.validate(event, copy)).toEqual(fullValidation(event, copy));
    }
    // An earlier message replaced in place must not keep its old verdict.
    copy[4] = { ...copy[4]!, content: "rewritten after validation" };
    for (const event of checkpoints.slice(12)) {
      const full = fullValidation(event, copy);
      expect(full).toMatchObject({ status: "invalid", failure: { code: "tool_result_integrity_invalid" } });
      expect(validator.validate(event, copy)).toEqual(full);
    }
    validator.close();
  });
});
