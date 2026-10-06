import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeMessagesForAPI } from "../../src/llm/messages.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { REDACTED_SECRET } from "../../src/secrets/sanitizer.js";
import { compactConversation } from "../../src/services/compact/compact.js";
import { finalizeCompactionTransaction } from "../../src/services/compact/finalize-transaction.js";
import { reconstructCompactionPayloadV1 } from "../../src/services/compact/payload-manifest.js";
import type {
  CompactionPayloadChunkV1,
  CompactionPersistedIntentV1,
  CompactionProjectionMessageV1,
} from "../../src/services/compact/transaction-types.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { parseRolloutLine, serializeRolloutItem } from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import {
  createToolResultIntegrity,
  verifyToolResultIntegrity,
} from "../../src/session/tool-result-integrity.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

/**
 * #2476: an `exec_command` result that printed `T[:100]` and `invT[:80]`
 * index permutations reached the rollout as `[REDACTED_SECRET]`, and every
 * later reader (resume, compaction source selection) saw the marker instead of
 * the evidence. This drives benchmark-shaped benign output and a synthetic
 * wallet keypair through the same hermetic session path and checks that the
 * two are told apart at every sink while the provider-facing content, the
 * tool-result identity and the content-addressed compaction chunks keep their
 * invariants.
 */

const SESSION_ID = "benign-integer-arrays-boundary";
const PERM_CALL = "call-permutation";
const SECRET_CALL = "call-keypair";

const permutation = (length: number): number[] =>
  Array.from({ length }, (_v, i) => i);
const syntheticBytes = (length: number): number[] =>
  Array.from({ length }, (_v, i) => (i * 37 + 11) % 256);
// Distinct generator from the benign lists so no prefix is shared.
const keypairBytes = (): number[] =>
  Array.from({ length: 64 }, (_v, i) => (i * 53 + 7) % 256);

const T_LINE = `T[:100] [${permutation(100).join(", ")}]`;
const INVT_LINE = `invT[:80] (source for each output position of delayed stream) [${permutation(80).join(", ")}]`;
const OFFSETS_LINE = `offsets [${permutation(80).map((v) => v - 40).join(", ")}]`;
const BENIGN_STDOUT = [
  T_LINE,
  "is T a perm of 0..M-1? True",
  INVT_LINE,
  OFFSETS_LINE,
  `sample bytes [${syntheticBytes(33).join(",")}]`,
].join("\n");

// Synthetic `~/.config/solana/id.json`-shaped keypair and a runtime key shape,
// assembled at runtime so scanners do not flag the fixture.
const KEYPAIR_JSON = `[${keypairBytes().join(",")}]`;
const XAI_TOKEN = `xai-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`;
const SECRET_STDOUT = `$ cat ~/.config/solana/id.json\n${KEYPAIR_JSON}\n$ env | grep XAI\nXAI_KEY_VALUE ${XAI_TOKEN}\n`;

function toolResult(toolCallId: string, content: string): LLMMessage {
  return {
    role: "tool",
    toolCallId,
    toolName: "exec_command",
    content,
    runtimeOnly: {
      toolResultIntegrity: createToolResultIntegrity({
        runId: SESSION_ID,
        toolCallId,
        content,
      }),
    },
  };
}

function expectBenignIntact(text: string): void {
  expect(text).toContain(T_LINE);
  expect(text).toContain(INVT_LINE);
  expect(text).toContain(OFFSETS_LINE);
  expect(text).toContain(`[${syntheticBytes(33).join(",")}]`);
}

function expectSecretProtected(text: string): void {
  expect(text).not.toContain(KEYPAIR_JSON);
  expect(text).not.toContain(keypairBytes().slice(0, 8).join(","));
  expect(text).not.toContain(XAI_TOKEN);
  expect(text).toContain(REDACTED_SECRET);
}

function sessionWire(): LLMMessage[] {
  // Filler words are chosen outside the BIP39 wordlist so the mnemonic
  // detector does not participate in this test.
  const filler = Array.from({ length: 18 }, (_v, index): LLMMessage => ({
    role: index % 2 ? "assistant" : "user",
    content: Array.from(
      { length: 180 },
      (_p, part) => `filler-${index}.${part}: measured=${part};\n`,
    ).join(""),
  }));
  return [
    ...filler,
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: PERM_CALL, name: "exec_command", arguments: "{}" },
        { id: SECRET_CALL, name: "exec_command", arguments: "{}" },
      ],
    },
    toolResult(PERM_CALL, BENIGN_STDOUT),
    toolResult(SECRET_CALL, SECRET_STDOUT),
  ];
}

describe("benign integer arrays at the durable boundary (#2476)", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("keeps the permutation output intact through the durable item, rollout line and reconstruction while the keypair is redacted", () => {
    const benign = toolResult(PERM_CALL, BENIGN_STDOUT);
    const secret = toolResult(SECRET_CALL, SECRET_STDOUT);

    // Fresh provider-facing content is the original body for both results.
    const provider = normalizeMessagesForAPI([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: PERM_CALL, name: "exec_command", arguments: "{}" },
          { id: SECRET_CALL, name: "exec_command", arguments: "{}" },
        ],
      },
      benign,
      secret,
    ]);
    expect(provider[1]?.content).toBe(BENIGN_STDOUT);
    expect(provider[2]?.content).toBe(SECRET_STDOUT);

    // Durable item: benign output is not even marked as redacted; the
    // keypair result is rebound to its redacted body with a valid seal.
    const benignDurable = llmMessageToDurableResponseItem(benign);
    expect(benignDurable.content).toBe(BENIGN_STDOUT);
    expect(benignDurable.toolResultIntegrity).toEqual(
      benign.runtimeOnly?.toolResultIntegrity,
    );
    expect(benignDurable.toolResultIntegrity?.persisted.representation).toBe(
      "original",
    );

    const secretDurable = llmMessageToDurableResponseItem(secret);
    expectSecretProtected(String(secretDurable.content));
    expect(secretDurable.toolResultIntegrity?.original).toEqual(
      secret.runtimeOnly?.toolResultIntegrity?.original,
    );
    expect(secretDurable.toolResultIntegrity?.persisted.representation).toBe(
      "redacted",
    );
    for (const [item, toolCallId] of [
      [benignDurable, PERM_CALL],
      [secretDurable, SECRET_CALL],
    ] as const) {
      expect(
        verifyToolResultIntegrity({
          integrity: item.toolResultIntegrity,
          toolCallId,
          content: item.content,
        }),
      ).toMatchObject({ status: "valid" });
    }

    // The checkpoint projection of the in-memory message equals the durable
    // record, so checkpoint hashing agrees with what the sink wrote.
    expect(llmMessageToCheckpointResponseItem(benign)).toEqual(benignDurable);
    expect(
      llmMessageToCheckpointResponseItem({
        ...secret,
        runtimeOnly: {
          toolResultIntegrity: {
            ...secret.runtimeOnly!.toolResultIntegrity!,
            persisted: secretDurable.toolResultIntegrity!.persisted,
          },
        },
      }),
    ).toEqual(secretDurable);

    // Serialized rollout line and the message rebuilt from it.
    for (const [durable, check] of [
      [benignDurable, expectBenignIntact],
      [secretDurable, expectSecretProtected],
    ] as const) {
      const line = serializeRolloutItem({ type: "response_item", payload: durable });
      check(line);
      const parsed = parseRolloutLine(line);
      if (parsed?.type !== "response_item") throw new Error("response item missing");
      expect(parsed.payload).toEqual(durable);
      check(String(responseItemToLlmMessage(parsed.payload).content));
      expect(
        verifyToolResultIntegrity({
          integrity: parsed.payload.toolResultIntegrity,
          toolCallId: parsed.payload.toolCallId!,
          content: parsed.payload.content,
        }),
      ).toMatchObject({ status: "valid" });
    }
  });

  it("persists, resumes and compacts a session with the evidence intact and the keypair protected", async () => {
    const wire = sessionWire();
    harness = createCompactionTransactionHarness([], {
      sessionId: SESSION_ID,
      compactionMode: "automatic",
    });
    for (const message of wire) {
      harness.store.appendRollout(
        { type: "response_item", payload: llmMessageToDurableResponseItem(message) },
        { durable: true },
      );
    }
    harness.store.flushDurable();

    // Durable history as written and as reconstructed for resume.
    const written = harness.store.readAll();
    const writtenJson = JSON.stringify(written);
    expectBenignIntact(writtenJson);
    expectSecretProtected(writtenJson);
    const resumed = reconstructFromRollout(written).history;
    const resumedPerm = resumed.find(
      (item) => item.role === "tool" && item.toolCallId === PERM_CALL,
    );
    expect(resumedPerm?.content).toBe(BENIGN_STDOUT);
    const resumedSecret = resumed.find(
      (item) => item.role === "tool" && item.toolCallId === SECRET_CALL,
    );
    expectSecretProtected(String(resumedSecret?.content));
    // Provider-facing replay of the reconstructed history carries the same
    // intact evidence, not a marker.
    const replay = normalizeMessagesForAPI(resumed.map(responseItemToLlmMessage));
    expect(
      replay.find((message) => message.role === "tool" && message.toolCallId === PERM_CALL)
        ?.content,
    ).toBe(BENIGN_STDOUT);

    // Compaction selects canonical saved bodies as its source.
    const result = await compactConversation(toAgenCRuntimeMessages(wire), harness.context);
    expect(harness.provider.chat).toHaveBeenCalled();
    expect(result.transaction).toBeDefined();
    await finalizeCompactionTransaction({
      store: harness.store,
      attemptId: result.transaction!.attempt_id,
      applyProjection: () => {},
      cleanup: () => {},
    });

    const rows = readFileSync(harness.store.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly type: string; readonly payload: unknown });
    const intent = rows.find((row) => row.type === "compaction_intent")
      ?.payload as CompactionPersistedIntentV1 | undefined;
    if (intent === undefined) throw new Error("compaction intent missing");
    const chunks = rows
      .filter(
        (row) =>
          row.type === "compaction_payload_chunk" &&
          (row.payload as CompactionPayloadChunkV1).attempt_id === intent.attempt_id &&
          (row.payload as CompactionPayloadChunkV1).payload_kind === "source_history",
      )
      .map((row) => row.payload as CompactionPayloadChunkV1);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.fragment_utf8_bytes).toBe(
        Buffer.byteLength(chunk.canonical_json_fragment, "utf8"),
      );
    }
    // Content-addressed reconstruction verifies every chunk digest; the
    // selected source bodies are the canonical ones.
    const sourceHistory = reconstructCompactionPayloadV1(
      intent.source_history_manifest,
      chunks,
    ) as readonly CompactionProjectionMessageV1[];
    const selectedPerm = sourceHistory.find(
      (message) => message.role === "tool" && message.toolCallId === PERM_CALL,
    );
    expect(selectedPerm?.content).toBe(BENIGN_STDOUT);
    const selectedSecret = sourceHistory.find(
      (message) => message.role === "tool" && message.toolCallId === SECRET_CALL,
    );
    expectSecretProtected(String(selectedSecret?.content));

    // Whole rollout after commit, then a cold reopen.
    const afterCommit = JSON.stringify(harness.store.readAll());
    expectSecretProtected(afterCommit);
    expectBenignIntact(afterCommit);
    const meta = harness.store
      .readAll()
      .find((record) => record.type === "session_meta");
    if (meta?.type !== "session_meta") throw new Error("session metadata missing");
    harness.store.close();
    const reopened = new RolloutStore({
      cwd: meta.payload.cwd,
      sessionId: meta.payload.sessionId,
      agencVersion: "0.13.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
      resume: true,
    });
    try {
      reopened.open(meta.payload);
      const items = reopened.readAll();
      const reopenedJson = JSON.stringify(items);
      expectSecretProtected(reopenedJson);
      const restored = reconstructFromRollout(items).history;
      expect(restored).toEqual(result.transaction!.committed.replacement_history);
      expect(JSON.stringify(restored)).not.toContain(XAI_TOKEN);
      expect(JSON.stringify(restored)).not.toContain(KEYPAIR_JSON);
    } finally {
      reopened.close();
    }
  });
});
