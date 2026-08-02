import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DurableCheckpointReadError,
  readTurnCheckpoint,
  validateCheckpointPrefixV2,
} from "../../src/session/durable-checkpoint-reader.js";
import { planLegacyDurableCheckpointUpgrade } from "../../src/session/durable-checkpoint-upgrade.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type TurnCheckpointV2Event,
} from "../../src/session/event-log.js";
import {
  parseRolloutLine,
  type ResponseItem,
  type RolloutItem,
  type ToolResultIntegrityResponseItem,
} from "../../src/session/rollout-item.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";
import {
  isCanonicalEventPayload,
  isCanonicalRolloutPayload,
} from "../../src/state/recovery-journal-schema.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../fnd/fixtures/checkpoints/", import.meta.url),
);

let agencHome: string;
let cwd: string;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-checkpoint-reader-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-checkpoint-reader-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver);
});

afterEach(() => {
  driver.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("durable checkpoint v2 reader", () => {
  it("layers strict checkpoint validation over the additive recovery envelope", () => {
    const checkpoint = {
      ...legacyCheckpoint("a".repeat(64)),
      checkpointVersion: 2,
      toolResultIntegrityVersion: 1,
    };
    const integrity = createToolResultIntegrity({
      runId: "recovery-envelope-run",
      toolCallId: "recovery-envelope-call",
      content: "sealed result",
    });
    const response = {
      role: "tool" as const,
      content: "sealed result",
      toolCallId: "recovery-envelope-call",
      toolResultIntegrity: integrity,
    };

    expect(isCanonicalEventPayload("turn_checkpoint", checkpoint)).toBe(true);
    expect(isCanonicalRolloutPayload("response_item", response)).toBe(true);
    expect(readTurnCheckpoint(checkpoint)).toMatchObject({ version: 2 });

    const malformed = { ...checkpoint, toolResultIntegrityVersion: "1" };
    expect(isCanonicalEventPayload("turn_checkpoint", malformed)).toBe(true);
    expect(() => readTurnCheckpoint(malformed)).toThrowError(
      expect.objectContaining<DurableCheckpointReadError>({
        code: "checkpoint_shape_invalid",
      }),
    );
  });

  it("strictly dispatches legacy and v2 checkpoints and rejects unknown versions", () => {
    const legacy = legacyCheckpoint("a".repeat(64));
    expect(readTurnCheckpoint(legacy)).toMatchObject({ version: 1 });
    expect(
      readTurnCheckpoint({ ...legacy, checkpointVersion: 1 }),
    ).toMatchObject({
      version: 1,
    });
    expect(
      readTurnCheckpoint({
        ...legacy,
        checkpointVersion: 2,
        toolResultIntegrityVersion: 1,
      }),
    ).toMatchObject({ version: 2 });
    expect(() =>
      readTurnCheckpoint({ ...legacy, checkpointVersion: 3 }),
    ).toThrowError(
      expect.objectContaining<DurableCheckpointReadError>({
        code: "checkpoint_version_unsupported",
        kind: "integrity_failure",
      }),
    );
    expect(() =>
      readTurnCheckpoint({ ...legacy, checkpointVersion: 2 }),
    ).toThrowError(
      expect.objectContaining<DurableCheckpointReadError>({
        code: "checkpoint_shape_invalid",
      }),
    );
    expect(() =>
      readTurnCheckpoint({
        ...legacy,
        checkpointVersion: 1,
        toolResultIntegrityVersion: 1,
      }),
    ).toThrowError(
      expect.objectContaining<DurableCheckpointReadError>({
        code: "checkpoint_shape_invalid",
      }),
    );
    expect(() =>
      readTurnCheckpoint({ ...legacy, prefixHash: "not-a-digest" }),
    ).toThrowError(
      expect.objectContaining<DurableCheckpointReadError>({
        code: "checkpoint_shape_invalid",
      }),
    );
    expect(() =>
      readTurnCheckpoint({ ...legacy, unversionedField: true }),
    ).toThrowError(/unversioned fields/);
  });

  it("authenticates an upgraded prefix and rejects body substitution", () => {
    const upgraded = upgradedFixture(
      "legacy-v1-tool-result-a.jsonl",
      "upgrade-alpha",
    );
    const history = responseHistory(upgraded);
    const checkpoint = v2Checkpoint(upgraded);
    expect(
      validateCheckpointPrefixV2({
        checkpoint,
        messages: history,
        projection,
        projectionId: "validate-alpha",
        sourceKey: "fixture-alpha",
      }),
    ).toMatchObject({ status: "valid" });

    const substituted = history.map((message) =>
      message.role === "tool" ? { ...message, content: "omega" } : message,
    );
    expect(
      validateCheckpointPrefixV2({
        checkpoint,
        messages: substituted,
        projection,
        projectionId: "validate-substitution",
        sourceKey: "fixture-alpha-substituted",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "tool_result_integrity_invalid",
        cause: { code: "persisted_body_digest_mismatch" },
      },
    });
  });

  it("returns an operational deferral when a prefix exceeds its reader bound", () => {
    const upgraded = upgradedFixture(
      "legacy-v1-tool-result-a.jsonl",
      "upgrade-bounded",
    );
    expect(
      validateCheckpointPrefixV2({
        checkpoint: v2Checkpoint(upgraded),
        messages: responseHistory(upgraded),
        projection,
        projectionId: "validate-bounded",
        sourceKey: "fixture-bounded",
        maxPrefixMessages: 2,
      }),
    ).toMatchObject({
      status: "deferred",
      failure: { code: "checkpoint_prefix_message_limit" },
    });
  });

  it("fails malformed response shapes closed before canonical hashing", () => {
    const upgraded = upgradedFixture(
      "legacy-v1-tool-result-a.jsonl",
      "upgrade-malformed-response",
    );
    const malformed = responseHistory(upgraded) as unknown as Array<
      Record<string, unknown>
    >;
    malformed[0] = { role: 42, content: "invalid" };

    expect(
      validateCheckpointPrefixV2({
        checkpoint: v2Checkpoint(upgraded),
        messages: malformed as unknown as ResponseItem[],
        projection,
        projectionId: "validate-malformed-response",
        sourceKey: "fixture-malformed-response",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_response_shape_invalid" },
    });
  });

  it("rejects unversioned response and tool-call fields", () => {
    const upgraded = upgradedFixture(
      "legacy-v1-tool-result-a.jsonl",
      "upgrade-unversioned-response",
    );
    const history = responseHistory(upgraded);
    const withResponseExtension = history.map((message, index) =>
      index === 0 ? { ...message, futureField: true } : message,
    );
    expect(
      validateCheckpointPrefixV2({
        checkpoint: v2Checkpoint(upgraded),
        messages: withResponseExtension as ResponseItem[],
        projection,
        projectionId: "validate-unversioned-response",
        sourceKey: "fixture-unversioned-response",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_response_shape_invalid" },
    });

    const withCallExtension = history.map((message) =>
      message.role === "assistant" && message.toolCalls !== undefined
        ? {
            ...message,
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              futureField: true,
            })),
          }
        : message,
    );
    expect(
      validateCheckpointPrefixV2({
        checkpoint: v2Checkpoint(upgraded),
        messages: withCallExtension as ResponseItem[],
        projection,
        projectionId: "validate-unversioned-call",
        sourceKey: "fixture-unversioned-call",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_response_shape_invalid" },
    });
  });
});

describe("legacy durable checkpoint upgrade planner", () => {
  it("keeps the live rollout writer on v1 until the A3b cutover", () => {
    expect(ROLLOUT_SCHEMA_VERSION).toBe(1);
  });

  it("makes equal-length fixture substitutions produce distinct v2 identities", () => {
    const alphaSource = deepFreeze(
      loadFixture("legacy-v1-tool-result-a.jsonl"),
    );
    const omegaSource = deepFreeze(
      loadFixture("legacy-v1-tool-result-body-substitution.jsonl"),
    );
    const alphaBefore = JSON.stringify(alphaSource);
    const omegaBefore = JSON.stringify(omegaSource);

    const alpha = planLegacyDurableCheckpointUpgrade({
      items: alphaSource,
      runId: "checkpoint-pair-v1",
      projection,
      projectionId: "plan-alpha",
      sourceKey: "fixture-alpha",
    });
    const omega = planLegacyDurableCheckpointUpgrade({
      items: omegaSource,
      runId: "checkpoint-pair-v1",
      projection,
      projectionId: "plan-omega",
      sourceKey: "fixture-omega",
    });
    if (alpha.status !== "planned" || omega.status !== "planned") {
      throw new Error("fixture upgrade unexpectedly failed");
    }

    const alphaTool = responseHistory(alpha.plan.upgradedItems).find(
      (message) => message.role === "tool",
    );
    const omegaTool = responseHistory(omega.plan.upgradedItems).find(
      (message) => message.role === "tool",
    );
    expect(alphaTool?.toolResultIntegrity?.original.digest).not.toBe(
      omegaTool?.toolResultIntegrity?.original.digest,
    );
    expect(v2Checkpoint(alpha.plan.upgradedItems).prefixHash).not.toBe(
      v2Checkpoint(omega.plan.upgradedItems).prefixHash,
    );
    expect(alpha.plan).toMatchObject({
      changed: true,
      toolResultsSealed: 1,
      checkpointsUpgraded: 1,
      checkpointsValidated: 1,
      sessionMetaPromotionRequired: true,
    });
    expect(JSON.stringify(alphaSource)).toBe(alphaBefore);
    expect(JSON.stringify(omegaSource)).toBe(omegaBefore);
  });

  it("is deterministic, non-mutating, and idempotent over planned output", () => {
    const source = deepFreeze(loadFixture("legacy-v1-tool-result-a.jsonl"));
    const first = planLegacyDurableCheckpointUpgrade({
      items: source,
      runId: "checkpoint-pair-v1",
      projection,
      projectionId: "plan-first",
      sourceKey: "fixture-first",
    });
    if (first.status !== "planned") throw new Error("first plan failed");
    const second = planLegacyDurableCheckpointUpgrade({
      items: first.plan.upgradedItems,
      runId: "checkpoint-pair-v1",
      projection,
      projectionId: "plan-second",
      sourceKey: "fixture-first",
    });
    if (second.status !== "planned") throw new Error("second plan failed");

    expect(second.plan.changed).toBe(false);
    expect(second.plan.toolResultsSealed).toBe(0);
    expect(second.plan.checkpointsUpgraded).toBe(0);
    expect(second.plan.checkpointsValidated).toBe(1);
    expect(second.plan.upgradedItems).toEqual(first.plan.upgradedItems);
  });

  it("promotes schema metadata in the plan without changing the live writer", () => {
    const source: RolloutItem[] = [
      {
        type: "session_meta",
        payload: {
          sessionId: "session-1",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: "/workspace",
          originator: "test",
          agencVersion: "0.13.0",
          rolloutSchemaVersion: 1,
        },
      },
      ...loadFixture("legacy-v1-tool-result-a.jsonl"),
    ];
    const planned = planLegacyDurableCheckpointUpgrade({
      items: source,
      runId: "checkpoint-pair-v1",
      projection,
      projectionId: "plan-meta",
      sourceKey: "fixture-meta",
    });
    if (planned.status !== "planned") throw new Error("metadata plan failed");

    expect(planned.plan.sessionMetaPromotionRequired).toBe(false);
    expect(planned.plan.upgradedItems[0]).toMatchObject({
      type: "session_meta",
      payload: { rolloutSchemaVersion: 2 },
    });
    expect(source[0]).toMatchObject({
      type: "session_meta",
      payload: { rolloutSchemaVersion: 1 },
    });
  });

  it("refuses to bless missing or cross-run integrity in schema-v2 history", () => {
    const assistant: RolloutItem = {
      type: "response_item",
      payload: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-v2", name: "read" }],
      },
    };
    const toolResult: ResponseItem = {
      role: "tool",
      content: "alpha",
      toolCallId: "call-v2",
      toolName: "read",
    };
    const metadata: RolloutItem = {
      type: "session_meta",
      payload: {
        sessionId: "run-v2",
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: "/workspace",
        originator: "test",
        agencVersion: "0.13.0",
        rolloutSchemaVersion: 2,
      },
    };

    expect(
      planLegacyDurableCheckpointUpgrade({
        items: [
          metadata,
          assistant,
          { type: "response_item", payload: toolResult },
        ],
        runId: "run-v2",
        projection,
        projectionId: "plan-v2-missing-integrity",
        sourceKey: "fixture-v2-missing-integrity",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "tool_result_integrity_invalid",
        reason: expect.stringContaining("missing integrity metadata"),
      },
    });

    expect(
      planLegacyDurableCheckpointUpgrade({
        items: [
          metadata,
          assistant,
          {
            type: "response_item",
            payload: {
              ...toolResult,
              toolResultIntegrity: createToolResultIntegrity({
                runId: "another-run",
                toolCallId: "call-v2",
                content: "alpha",
              }),
            },
          },
        ],
        runId: "run-v2",
        projection,
        projectionId: "plan-v2-cross-run-integrity",
        sourceKey: "fixture-v2-cross-run-integrity",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "tool_result_integrity_invalid",
        cause: { code: "run_id_mismatch" },
      },
    });
  });

  it("refuses a legacy checkpoint whose tool result precedes its call", () => {
    const source = loadFixture("legacy-v1-tool-result-a.jsonl");
    const assistantIndex = source.findIndex(
      (item) =>
        item.type === "response_item" && item.payload.role === "assistant",
    );
    const toolIndex = source.findIndex(
      (item) => item.type === "response_item" && item.payload.role === "tool",
    );
    const reordered = [...source];
    [reordered[assistantIndex], reordered[toolIndex]] = [
      reordered[toolIndex]!,
      reordered[assistantIndex]!,
    ];

    expect(
      planLegacyDurableCheckpointUpgrade({
        items: reordered,
        runId: "checkpoint-pair-v1",
        projection,
        projectionId: "plan-reordered",
        sourceKey: "fixture-reordered",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "checkpoint_invalid",
        cause: { code: "tool_result_without_call" },
      },
    });
  });

  it("refuses to bless a legacy prefix that fails its existing digest gate", () => {
    const source = loadFixture("legacy-v1-tool-result-a.jsonl");
    const userIndex = source.findIndex(
      (item) => item.type === "response_item" && item.payload.role === "user",
    );
    const user = source[userIndex];
    if (user?.type !== "response_item") throw new Error("user fixture missing");
    source[userIndex] = {
      ...user,
      payload: { ...user.payload, content: "tampered instruction" },
    };

    expect(
      planLegacyDurableCheckpointUpgrade({
        items: source,
        runId: "checkpoint-pair-v1",
        projection,
        projectionId: "plan-tampered-legacy-prefix",
        sourceKey: "fixture-tampered-legacy-prefix",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "checkpoint_invalid",
        reason: expect.stringContaining("legacy checkpoint prefix digest"),
      },
    });
  });

  it("leaves the legacy prefix hash behavior untouched for the A3b cutover", () => {
    const alpha = loadFixture("legacy-v1-tool-result-a.jsonl");
    const omega = loadFixture("legacy-v1-tool-result-body-substitution.jsonl");
    const alphaCheckpoint = alpha.find(
      (item) =>
        item.type === "event_msg" &&
        item.payload.msg.type === "turn_checkpoint",
    );
    const omegaCheckpoint = omega.find(
      (item) =>
        item.type === "event_msg" &&
        item.payload.msg.type === "turn_checkpoint",
    );

    expect(alphaCheckpoint).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              prefixHash:
                "68cb16728e869cd1b8392c333db38adf714d4eaaf1969e4e25617ecf634326ae",
            }),
          }),
        }),
      }),
    );
    expect(omegaCheckpoint).toEqual(alphaCheckpoint);
  });
});

function upgradedFixture(
  filename: string,
  projectionId: string,
): RolloutItem[] {
  const outcome = planLegacyDurableCheckpointUpgrade({
    items: loadFixture(filename),
    runId: "checkpoint-pair-v1",
    projection,
    projectionId,
    sourceKey: filename,
  });
  if (outcome.status !== "planned") {
    throw new Error(`fixture upgrade failed: ${outcome.failure.reason}`);
  }
  return [...outcome.plan.upgradedItems];
}

function loadFixture(filename: string): RolloutItem[] {
  return readFileSync(join(FIXTURE_ROOT, filename), "utf8")
    .trim()
    .split("\n")
    .map((line) => parseRolloutLine(line))
    .filter((item): item is RolloutItem => item !== null);
}

function responseHistory(
  items: ReadonlyArray<RolloutItem>,
): ToolResultIntegrityResponseItem[] {
  return items.flatMap((item) =>
    item.type === "response_item" ? [item.payload] : [],
  );
}

function v2Checkpoint(
  items: ReadonlyArray<RolloutItem>,
): TurnCheckpointV2Event {
  for (const item of items) {
    if (
      item.type === "event_msg" &&
      item.payload.msg.type === "turn_checkpoint"
    ) {
      const readable = readTurnCheckpoint(item.payload.msg.payload);
      if (readable.version !== 2) throw new Error("checkpoint is not v2");
      return readable.checkpoint;
    }
  }
  throw new Error("checkpoint is missing");
}

function legacyCheckpoint(prefixHash: string): Record<string, unknown> {
  return {
    turnId: "turn-1",
    iterationIndex: 1,
    boundary: "iteration",
    checkpointSeq: 1,
    persistedMessageCount: 0,
    prefixHash,
    resumableState: {
      turnCount: 1,
      recoveryReentryCount: 0,
      maxOutputTokensRecoveryCount: 0,
      continuationNudgeCount: 0,
      stopHookBlockingCount: 0,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
