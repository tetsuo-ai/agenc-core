import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeCheckpointPrefixHashV2,
  DurableCheckpointReadError,
  readTurnCheckpoint,
  validateCheckpointPrefixV2,
} from "../../src/session/durable-checkpoint-reader.js";
import {
  MAX_CHECKPOINT_UPGRADE_HISTORY_WORK,
  planLegacyDurableCheckpointUpgrade,
} from "../../src/session/durable-checkpoint-upgrade.js";
import { computePrefixHash } from "../../src/session/durable-turns.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type TurnCheckpointEvent,
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
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from "../../src/contracts/agent-invocation-envelope.js";
import { llmMessageToResponseItem } from "../../src/session/message-history-conversion.js";
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

  it("rejects checkpoint sequence zero for every readable version", () => {
    const legacy = { ...legacyCheckpoint("a".repeat(64)), checkpointSeq: 0 };
    const explicitV1 = { ...legacy, checkpointVersion: 1 };
    const v2 = {
      ...legacy,
      checkpointVersion: 2,
      toolResultIntegrityVersion: 1,
    };

    for (const checkpoint of [legacy, explicitV1, v2]) {
      expect(() => readTurnCheckpoint(checkpoint)).toThrowError(
        expect.objectContaining<DurableCheckpointReadError>({
          code: "checkpoint_shape_invalid",
        }),
      );
    }
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
        expectedRunId: "checkpoint-pair-v1",
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
        expectedRunId: "checkpoint-pair-v1",
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
        expectedRunId: "checkpoint-pair-v1",
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
        expectedRunId: "checkpoint-pair-v1",
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

  it("authenticates three authority channels and fails closed across resume mutations", () => {
    const envelope = createCsvAgentInvocationEnvelope({
      jobId: "checkpoint-job",
      itemId: "checkpoint-item",
      rowIndex: 3,
      rowSha256: `sha256:${"b".repeat(64)}`,
      instruction: "Classify the exact row.",
      row: { payload: "untrusted" },
    });
    const history = materializeAgentInvocationMessages(envelope).map(
      llmMessageToResponseItem,
    );
    expect(
      history.every((item) => isCanonicalRolloutPayload("response_item", item)),
    ).toBe(true);
    const checkpoint = checkpointForHistory(history);
    const validate = (messages: readonly ResponseItem[], projectionId: string) =>
      validateCheckpointPrefixV2({
        checkpoint,
        expectedRunId: "checkpoint-authority-run",
        messages,
        projection,
        projectionId,
        sourceKey: projectionId,
      });

    expect(validate(history, "authority-valid")).toMatchObject({
      status: "valid",
    });

    const unsupportedReader = structuredClone(history);
    const unsupportedMetadata = unsupportedReader[0]!
      .agentInvocation as unknown as Record<string, unknown>;
    unsupportedMetadata.minimumReaderVersion = 2;
    expect(validate(unsupportedReader, "authority-future-reader")).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_response_shape_invalid" },
    });

    const incomplete = structuredClone(history);
    incomplete[1] = { role: "user", content: "ordinary history" };
    expect(validate(incomplete, "authority-incomplete")).toMatchObject({
      status: "invalid",
      failure: { code: "agent_invocation_integrity_failure" },
    });

    const metadataStripped = structuredClone(history);
    delete (metadataStripped[2] as { agentInvocation?: unknown }).agentInvocation;
    expect(validate(metadataStripped, "authority-metadata-stripped")).toMatchObject({
      status: "invalid",
      failure: { code: "agent_invocation_integrity_failure" },
    });

    const contentBitFlip = structuredClone(history);
    contentBitFlip[2] = {
      ...contentBitFlip[2]!,
      content: `${String(contentBitFlip[2]!.content)} `,
    };
    expect(validate(contentBitFlip, "authority-content-bit-flip")).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_response_shape_invalid" },
    });
  });

  it("accepts dangling calls only at the post-assistant crash boundary", () => {
    const messages: ResponseItem[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "pending-call", name: "FileRead", arguments: "{}" }],
      },
    ];
    const checkpoint: TurnCheckpointV2Event = {
      ...legacyCheckpoint(
        computeCheckpointPrefixHashV2(messages, messages.length),
      ),
      boundary: "postAssistant",
      persistedMessageCount: messages.length,
      checkpointVersion: 2,
      toolResultIntegrityVersion: 1,
    };
    expect(
      validateCheckpointPrefixV2({
        checkpoint,
        messages,
        projection,
        projectionId: "post-assistant-dangling",
        sourceKey: "post-assistant-dangling",
      }),
    ).toMatchObject({
      status: "valid",
      danglingToolCalls: 1,
      danglingToolUses: [{ callId: "pending-call", toolName: "FileRead" }],
    });

    expect(
      validateCheckpointPrefixV2({
        checkpoint: { ...checkpoint, boundary: "iteration" },
        messages,
        projection,
        projectionId: "iteration-dangling",
        sourceKey: "iteration-dangling",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_result_missing" },
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
        expectedRunId: "checkpoint-pair-v1",
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
        expectedRunId: "checkpoint-pair-v1",
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

  it("rejects UTF-8 replacement aliases in a v2 checkpoint prefix", () => {
    const replacementHistory: ToolResultIntegrityResponseItem[] = [
      { role: "user", content: "\ufffd" },
    ];
    const checkpoint = checkpointForHistory(replacementHistory);

    expect(
      validateCheckpointPrefixV2({
        checkpoint,
        expectedRunId: "unicode-run",
        messages: replacementHistory,
        projection,
        projectionId: "validate-unicode-replacement",
        sourceKey: "unicode-replacement",
      }),
    ).toMatchObject({ status: "valid" });

    for (const malformed of ["\ud800", "\udc00"]) {
      expect(() =>
        computeCheckpointPrefixHashV2(
          [{ role: "user", content: malformed }],
          1,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "unsupported_body_value" }),
      );
      expect(
        validateCheckpointPrefixV2({
          checkpoint,
          expectedRunId: "unicode-run",
          messages: [{ role: "user", content: malformed }],
          projection,
          projectionId: `validate-unicode-${malformed.charCodeAt(0)}`,
          sourceKey: "unicode-malformed",
        }),
      ).toMatchObject({
        status: "invalid",
        failure: {
          code: "checkpoint_prefix_body_invalid",
          cause: { code: "unsupported_body_value" },
        },
      });
    }
  });

  it("binds a wholly cross-run v2 prefix to its expected durable run", () => {
    const history = toolPairHistory([
      { callId: "cross-run-call", integrityRunId: "another-run" },
    ]);

    expect(
      validateCheckpointPrefixV2({
        checkpoint: checkpointForHistory(history),
        expectedRunId: "owning-run",
        messages: history,
        projection,
        projectionId: "validate-cross-run-prefix",
        sourceKey: "cross-run-prefix",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "tool_result_integrity_invalid",
        cause: { code: "run_id_mismatch" },
      },
    });
  });

  it("rejects mixed integrity run IDs inside one v2 prefix", () => {
    const history = toolPairHistory([
      { callId: "owning-call", integrityRunId: "owning-run" },
      { callId: "foreign-call", integrityRunId: "another-run" },
    ]);

    expect(
      validateCheckpointPrefixV2({
        checkpoint: checkpointForHistory(history),
        expectedRunId: "owning-run",
        messages: history,
        projection,
        projectionId: "validate-mixed-run-prefix",
        sourceKey: "mixed-run-prefix",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: {
        code: "tool_result_integrity_invalid",
        cause: { code: "run_id_mismatch" },
      },
    });
  });
});

describe("legacy durable checkpoint upgrade planner", () => {
  it("cuts the live rollout writer over to schema v2", () => {
    expect(ROLLOUT_SCHEMA_VERSION).toBe(2);
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

  it("rejects non-finite tool results before they can be persisted", () => {
    for (const content of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        planLegacyDurableCheckpointUpgrade({
          items: [
            {
              type: "response_item",
              payload: {
                role: "tool",
                toolCallId: "non-finite-call",
                content,
              },
            },
          ],
          runId: "non-finite-run",
          projection,
          projectionId: "plan-non-finite",
          sourceKey: "non-finite",
        }),
      ).toMatchObject({
        status: "invalid",
        failure: {
          code: "tool_result_integrity_invalid",
          cause: { code: "unsupported_body_value" },
        },
      });
    }
  });

  it(
    "accumulates large response histories in linear time",
    { timeout: 5_000 },
    () => {
      const responseCount = 50_000;
      const items: RolloutItem[] = Array.from(
        { length: responseCount },
        (_, index) => ({
          type: "response_item" as const,
          payload: { role: "user" as const, content: `message-${index}` },
        }),
      );

      const outcome = planLegacyDurableCheckpointUpgrade({
        items,
        runId: "linear-history-run",
        projection,
        projectionId: "plan-linear-history",
        sourceKey: "linear-history",
      });

      expect(outcome).toMatchObject({
        status: "planned",
        plan: {
          upgradedItems: expect.objectContaining({ length: responseCount }),
        },
      });
    },
  );

  it("preserves rollback history semantics without reducing every response", () => {
    const survivingHistory: ToolResultIntegrityResponseItem[] = [
      { role: "user", content: "first request" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "replacement request" },
    ];
    const checkpoint = readTurnCheckpoint({
      ...legacyCheckpoint(
        computePrefixHash(survivingHistory, survivingHistory.length),
      ),
      persistedMessageCount: survivingHistory.length,
    });
    if (checkpoint.version !== 1) throw new Error("checkpoint is not legacy");
    const items: RolloutItem[] = [
      { type: "response_item", payload: survivingHistory[0]! },
      { type: "response_item", payload: survivingHistory[1]! },
      {
        type: "response_item",
        payload: { role: "user", content: "rolled-back request" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "rolled-back answer" },
      },
      {
        type: "event_msg",
        payload: {
          id: "rollback-event",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
      { type: "response_item", payload: survivingHistory[2]! },
      checkpointItem(checkpoint.checkpoint),
    ];

    expect(
      planLegacyDurableCheckpointUpgrade({
        items,
        runId: "rollback-run",
        projection,
        projectionId: "plan-rollback-history",
        sourceKey: "rollback-history",
      }),
    ).toMatchObject({
      status: "planned",
      plan: { checkpointsUpgraded: 1, checkpointsValidated: 1 },
    });
  });

  it.each([
    { numTurns: -1 },
    { numTurns: 0.5 },
    { numTurns: Number.NaN },
    { numTurns: Number.POSITIVE_INFINITY },
    { numTurns: Number.MAX_SAFE_INTEGER + 1 },
    {},
    null,
  ])("rejects an invalid rollback payload %#", (payload) => {
    expect(
      planLegacyDurableCheckpointUpgrade({
        items: [rollbackItem(payload)],
        runId: "invalid-rollback-run",
        projection,
        projectionId: "plan-invalid-rollback",
        sourceKey: "invalid-rollback",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "rollback_invalid", itemIndex: 0 },
    });
  });

  it(
    "keeps repeated zero-turn rollbacks constant-time in history size",
    { timeout: 2_000 },
    () => {
      const historyLength = 50_000;
      const rollbackCount = 50_000;
      const items: RolloutItem[] = [
        ...Array.from({ length: historyLength }, () => ({
          type: "response_item" as const,
          payload: { role: "assistant" as const, content: "history" },
        })),
        ...Array.from({ length: rollbackCount }, (_, index) =>
          rollbackItem({ numTurns: 0 }, index + 1),
        ),
      ];

      const startedAt = performance.now();
      const outcome = planLegacyDurableCheckpointUpgrade({
        items,
        runId: "zero-rollback-run",
        projection,
        projectionId: "plan-zero-rollback-scaling",
        sourceKey: "zero-rollback-scaling",
        maxHistoryDerivationWork: 1,
      });
      const elapsedMs = performance.now() - startedAt;

      expect(outcome).toMatchObject({
        status: "planned",
        plan: {
          upgradedItems: expect.objectContaining({
            length: historyLength + rollbackCount,
          }),
        },
      });
      expect(elapsedMs).toBeLessThan(1_000);
    },
  );

  it("charges repeated one-turn rollback scans to one aggregate bound", () => {
    const items: RolloutItem[] = [
      ...["first", "second", "third"].map((content) => ({
        type: "response_item" as const,
        payload: { role: "user" as const, content },
      })),
      rollbackItem({ numTurns: 1 }, 1),
      rollbackItem({ numTurns: 1 }, 2),
    ];

    expect(
      planLegacyDurableCheckpointUpgrade({
        items,
        runId: "bounded-rollback-run",
        projection,
        projectionId: "plan-bounded-rollbacks",
        sourceKey: "bounded-rollbacks",
        // The first 3-row rollback reserves 9 visits. The second would
        // reserve another 6 after trimming and must be rejected before work.
        maxHistoryDerivationWork: 14,
      }),
    ).toMatchObject({
      status: "deferred",
      failure: {
        code: "history_derivation_work_limit",
        itemIndex: 4,
        reason: expect.stringContaining("rollback history derivation"),
      },
    });
  });

  it("bounds repeated rollbacks when history has no user boundary", () => {
    const items: RolloutItem[] = [
      {
        type: "response_item",
        payload: { role: "assistant", content: "unchanged" },
      },
      rollbackItem({ numTurns: 1 }, 1),
      rollbackItem({ numTurns: 1 }, 2),
    ];

    expect(
      planLegacyDurableCheckpointUpgrade({
        items,
        runId: "no-boundary-rollback-run",
        projection,
        projectionId: "plan-no-boundary-rollbacks",
        sourceKey: "no-boundary-rollbacks",
        maxHistoryDerivationWork: 5,
      }),
    ).toMatchObject({
      status: "deferred",
      failure: {
        code: "history_derivation_work_limit",
        itemIndex: 2,
      },
    });
  });

  it("defers repeated checkpoints at the aggregate history-work bound", () => {
    const firstMessage: ToolResultIntegrityResponseItem = {
      role: "user",
      content: "first",
    };
    const secondMessage: ToolResultIntegrityResponseItem = {
      role: "assistant",
      content: "second",
    };
    const firstHistory = [firstMessage];
    const secondHistory = [firstMessage, secondMessage];
    const items: RolloutItem[] = [
      {
        type: "session_meta",
        payload: {
          sessionId: "aggregate-run",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: "/workspace",
          originator: "test",
          agencVersion: "0.13.0",
          rolloutSchemaVersion: 2,
        },
      },
      { type: "response_item", payload: firstMessage },
      checkpointItem(checkpointForHistory(firstHistory)),
      { type: "response_item", payload: secondMessage },
      checkpointItem(checkpointForHistory(secondHistory)),
    ];

    expect(
      planLegacyDurableCheckpointUpgrade({
        items,
        runId: "aggregate-run",
        projection,
        projectionId: "plan-aggregate-bound",
        sourceKey: "aggregate-bound",
        maxHistoryDerivationWork: 3,
      }),
    ).toMatchObject({
      status: "deferred",
      failure: {
        code: "history_derivation_work_limit",
        itemIndex: 4,
      },
    });
  });

  it("does not allow callers to disable or widen the history-work bound", () => {
    const base = {
      items: [] as RolloutItem[],
      runId: "bounded-run",
      projection,
      projectionId: "plan-invalid-bound",
      sourceKey: "invalid-bound",
    };

    expect(() =>
      planLegacyDurableCheckpointUpgrade({
        ...base,
        maxHistoryDerivationWork: 0,
      }),
    ).toThrowError(/positive safe integer/);
    expect(() =>
      planLegacyDurableCheckpointUpgrade({
        ...base,
        maxHistoryDerivationWork: MAX_CHECKPOINT_UPGRADE_HISTORY_WORK + 1,
      }),
    ).toThrowError(/no greater than/);
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

function checkpointForHistory(
  history: ReadonlyArray<ToolResultIntegrityResponseItem>,
): TurnCheckpointV2Event {
  const readable = readTurnCheckpoint({
    ...legacyCheckpoint(computeCheckpointPrefixHashV2(history, history.length)),
    checkpointVersion: 2,
    toolResultIntegrityVersion: 1,
    persistedMessageCount: history.length,
  });
  if (readable.version !== 2) throw new Error("checkpoint is not v2");
  return readable.checkpoint;
}

function checkpointItem(checkpoint: TurnCheckpointEvent): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      eventId: `checkpoint:${checkpoint.checkpointSeq}`,
      id: "checkpoint-event",
      seq: checkpoint.checkpointSeq,
      msg: { type: "turn_checkpoint", payload: checkpoint },
    },
  };
}

function rollbackItem(payload: unknown, seq = 1): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      id: `rollback-event:${seq}`,
      seq,
      msg: { type: "thread_rolled_back", payload },
    },
  } as RolloutItem;
}

function toolPairHistory(
  calls: ReadonlyArray<{
    readonly callId: string;
    readonly integrityRunId: string;
  }>,
): ToolResultIntegrityResponseItem[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: calls.map(({ callId }) => ({
        id: callId,
        name: "read",
      })),
    },
    ...calls.map(({ callId, integrityRunId }) => ({
      role: "tool" as const,
      content: `result-${callId}`,
      toolCallId: callId,
      toolName: "read",
      toolResultIntegrity: createToolResultIntegrity({
        runId: integrityRunId,
        toolCallId: callId,
        content: `result-${callId}`,
      }),
    })),
  ];
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
