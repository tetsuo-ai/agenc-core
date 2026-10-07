import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { withCheckpointProjectionCache } from "../../src/session/checkpoint-projection-cache.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import {
  createCheckpointResponseItemProjector,
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
} from "../../src/session/message-history-conversion.js";
import * as rollout from "../../src/session/rollout-item.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import { HARD_MAX_RECOVERY_LINE_BYTES } from "../../src/state/recovery-contract.js";

const serialize = rollout.serializeRolloutItem;
const wire = (item: rollout.ResponseItem): string => serialize({ type: "response_item", payload: item });
type Project = (message: LLMMessage) => rollout.ResponseItem;
type RecordValue = Record<string, unknown>;

function tool(id = "call-one", content = "ordinary echo output\n"): LLMMessage {
  // This is the success-result shape produced by execute-tools.ts. run-turn
  // preserves these keys when replacing the seal's persisted identity.
  return {
    role: "tool", toolCallId: id, toolName: "exec_command", content,
    runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
      runId: "test-run", toolCallId: id, content,
    }) },
  };
}

function recordAt(message: LLMMessage, path: readonly string[]): RecordValue {
  let value: unknown = message;
  for (const key of path) value = (value as RecordValue)[key];
  return value as RecordValue;
}

function set(message: LLMMessage, path: readonly string[], value: unknown): void {
  recordAt(message, path.slice(0, -1))[path.at(-1)!] = value;
}

function outcome(project: Project, message: LLMMessage): unknown {
  try { return { line: wire(project(message)) }; }
  catch (error) {
    return { error: error instanceof Error ? [error.name, error.message] : String(error) };
  }
}

function tracked(): { full: ReturnType<typeof vi.fn<Project>>; project: Project } {
  const full = vi.fn(llmMessageToCheckpointResponseItem);
  return { full, project: withCheckpointProjectionCache(full) };
}

const sealPath = ["runtimeOnly", "toolResultIntegrity"];
const identityPaths = [sealPath, [...sealPath, "original"], [...sealPath, "persisted"]];
const integrityKeys = ["version", "algorithm", "runId", "toolCallId", "resultId", "original", "persisted"];
const originalKeys = ["digest", "byteLength"];
const persistedKeys = ["representation", "digest", "byteLength"];
// Unlike echo/output/tool, these tokens are not BIP39 words. The boundary
// fixtures must reach the line-size checks without mnemonic redaction first.
const cleanPayload = "checkpoint_payload!\n";
const cleanMetadata = "checkpoint_metadata!\n";

afterEach(() => vi.restoreAllMocks());

describe("checkpoint projection reuse", () => {
  it("checks each newly persisted result once while unchanged old results retain exact JSONL", () => {
    const project = createCheckpointResponseItemProjector();
    const old: LLMMessage[] = [];
    const lineCheck = vi.spyOn(rollout, "serializeRolloutItem");
    for (let step = 0; step < 12; step += 1) {
      const message = tool(`call-${step}`);
      // Match run-turn's actual durable sealing/rebinding before checkpointing.
      const durable = llmMessageToDurableResponseItem(message);
      message.runtimeOnly = { ...message.runtimeOnly, toolResultIntegrity: {
        ...message.runtimeOnly!.toolResultIntegrity!, persisted: durable.toolResultIntegrity!.persisted,
      } };
      old.push(message);
      lineCheck.mockClear();
      const projected = old.map(project);
      expect(lineCheck).toHaveBeenCalledTimes(1);
      expect(projected.map(wire)).toEqual(old.map(llmMessageToCheckpointResponseItem).map(wire));
    }
  });

  it("returns fresh roots but preserves only the current nested identity aliases", () => {
    const message = tool();
    message.phase = "commentary";
    message.runtimeOnly = { ...message.runtimeOnly, responseItemId: "response-one" };
    const { project, full } = tracked();
    const first = project(message);
    const second = project(message);
    expect(full).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    expect(first.toolResultIntegrity).not.toBe(second.toolResultIntegrity);
    expect(second.toolResultIntegrity!.original).toBe(message.runtimeOnly!.toolResultIntegrity!.original);
    expect(second.toolResultIntegrity!.persisted).toBe(message.runtimeOnly!.toolResultIntegrity!.persisted);
    expect(wire(second)).toBe(wire(llmMessageToCheckpointResponseItem(message)));

    Object.assign(first, { content: "changed returned body", id: "changed returned id" });
    Object.assign(first.toolResultIntegrity!, { runId: "changed returned root" });
    expect(wire(project(message))).toBe(wire(llmMessageToCheckpointResponseItem(message)));
    expect(full).toHaveBeenCalledTimes(1);

    const replacement = structuredClone(message.runtimeOnly!.toolResultIntegrity!);
    message.runtimeOnly = { ...message.runtimeOnly, toolResultIntegrity: replacement };
    const replaced = project(message);
    expect(full).toHaveBeenCalledTimes(1);
    expect(replaced.toolResultIntegrity!.original).toBe(replacement.original);
    expect(replaced.toolResultIntegrity!.persisted).toBe(replacement.persisted);
    expect(replaced.toolResultIntegrity!.original).not.toBe(second.toolResultIntegrity!.original);
    Object.assign(replaced.toolResultIntegrity!.original, { digest: "invalid" });
    expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
    expect(full).toHaveBeenCalledTimes(2);
  });

  const scalarChanges: Array<[string, string[], unknown]> = [
    ["role", ["role"], "assistant"],
    ["same-length body", ["content"], "Ordinary echo output\n"],
    ["malformed Unicode body", ["content"], "\ud800"],
    ["call id", ["toolCallId"], "other-call"],
    ["tool name", ["toolName"], "other-tool"],
    ["phase", ["phase"], "final_answer"],
    ["response id", ["runtimeOnly", "responseItemId"], "response-two"],
    ["version", [...sealPath, "version"], 2],
    ["algorithm", [...sealPath, "algorithm"], "sha512"],
    ["run id", [...sealPath, "runId"], "other-run"],
    ["seal call id", [...sealPath, "toolCallId"], "other-call"],
    ["result id", [...sealPath, "resultId"], `tool-result:${"0".repeat(64)}`],
    ["original digest", [...sealPath, "original", "digest"], `sha256:${"0".repeat(64)}`],
    ["original length", [...sealPath, "original", "byteLength"], 123],
    ["persisted digest", [...sealPath, "persisted", "digest"], `sha256:${"1".repeat(64)}`],
    ["persisted length", [...sealPath, "persisted", "byteLength"], 124],
    ["representation", [...sealPath, "persisted", "representation"], "compacted"],
    ["invalid numeric identity", [...sealPath, "persisted", "byteLength"], NaN],
    ["missing runtime", ["runtimeOnly"], undefined],
    ["missing integrity", sealPath, undefined],
    ["missing original", [...sealPath, "original"], undefined],
    ["missing persisted", [...sealPath, "persisted"], undefined],
  ];
  it.each(scalarChanges)("fully rechecks a changed %s", (_name, path, value) => {
    const message = tool();
    message.phase = "commentary";
    message.runtimeOnly = { ...message.runtimeOnly, responseItemId: "response-one" };
    const { project, full } = tracked();
    project(message);
    project(message);
    expect(full).toHaveBeenCalledTimes(1);
    set(message, path, value);
    expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
    expect(full).toHaveBeenCalledTimes(2);
  });

  it.each([["toolName"], ["phase"], ["runtimeOnly", "responseItemId"]])(
    "distinguishes absent, present and present-undefined optional field %j", (...path) => {
      const message = tool();
      const object = recordAt(message, path.slice(0, -1));
      const key = path.at(-1)!;
      delete object[key];
      const { project, full } = tracked();
      project(message);
      object[key] = key === "phase" ? "commentary" : "optional-value";
      expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
      expect(full).toHaveBeenCalledTimes(2);
      project(message);
      expect(full).toHaveBeenCalledTimes(2);
      object[key] = undefined;
      expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
      project(message);
      expect(full).toHaveBeenCalledTimes(4);
      delete object[key];
      expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
      project(message);
      expect(full).toHaveBeenCalledTimes(5);
    },
  );

  const enumerablePaths = [
    ...["role", "content", "toolCallId", "toolName", "runtimeOnly"].map((key) => [key]),
    ["phase"], ["runtimeOnly", "responseItemId"],
    ["runtimeOnly", "toolResultIntegrity"],
    ...integrityKeys.map((key) => [...sealPath, key]),
    ...originalKeys.map((key) => [...sealPath, "original", key]),
    ...persistedKeys.map((key) => [...sealPath, "persisted", key]),
  ];
  it.each(enumerablePaths.map((path) => [path.join("."), path] as const))(
    "rechecks same-value non-enumerable %s", (_name, path) => {
      const message = tool();
      message.phase = "commentary";
      message.runtimeOnly = { ...message.runtimeOnly, responseItemId: "response-one" };
      const { project, full } = tracked();
      project(message);
      Object.defineProperty(recordAt(message, path.slice(0, -1)), path.at(-1)!, { enumerable: false });
      const expected = outcome(llmMessageToCheckpointResponseItem, message);
      if (path.length >= 3) expect(expected).toHaveProperty("error");
      expect(outcome(project, message)).toEqual(expected);
      expect(full).toHaveBeenCalledTimes(2);
    },
  );

  it.each(identityPaths.map((path) => [path.join("."), path] as const))(
    "preserves JSONL order after replacing or reinserting %s keys", (_name, path) => {
      for (const mutation of ["replace", "reinsert"] as const) {
        const message = tool();
        const project = createCheckpointResponseItemProjector();
        project(message);
        const identity = recordAt(message, path);
        if (mutation === "replace") {
          set(message, path, Object.fromEntries(Object.entries(identity).reverse()));
        } else {
          const firstKey = Object.keys(identity)[0]!;
          const value = identity[firstKey];
          delete identity[firstKey];
          identity[firstKey] = value;
        }
        const check = vi.spyOn(rollout, "serializeRolloutItem");
        const result = project(message);
        expect(check).toHaveBeenCalledTimes(1);
        expect(wire(result)).toBe(wire(llmMessageToCheckpointResponseItem(message)));
        check.mockRestore();
        set(message, path, recordAt(tool(), path));
        expect(wire(project(message))).toBe(wire(llmMessageToCheckpointResponseItem(message)));
      }
    },
  );

  it("keeps redacting changed bodies and identities without publishing a clean proof", () => {
    const { project, full } = tracked();
    const message = tool();
    project(message);
    const secret = "a".repeat(40);
    message.content = `password=${secret}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const projected = project(message);
      expect(wire(projected)).toBe(wire(llmMessageToCheckpointResponseItem(message)));
      expect(wire(projected)).not.toContain(secret);
    }
    expect(full).toHaveBeenCalledTimes(3);
    message.content = tool().content;
    project(message);
    project(message);
    expect(full).toHaveBeenCalledTimes(4);

    for (const field of ["runId", "toolCallId"] as const) {
      const callId = field === "toolCallId" ? `password=${secret}` : "call-one";
      const redacted = tool(callId);
      redacted.runtimeOnly = { toolResultIntegrity: createToolResultIntegrity({
        runId: field === "runId" ? `password=${secret}` : "test-run",
        toolCallId: callId, content: redacted.content,
      }) };
      const local = tracked();
      expect(wire(local.project(redacted))).toBe(wire(llmMessageToCheckpointResponseItem(redacted)));
      expect(wire(local.project(redacted))).not.toContain(secret);
      expect(local.full).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["original", "persisted"] as const)("detects mutation through a returned %s identity alias", (identity) => {
    const message = tool();
    const { project, full } = tracked();
    project(message);
    const hit = project(message);
    const nested = hit.toolResultIntegrity![identity];
    expect(nested).toBe(message.runtimeOnly!.toolResultIntegrity![identity]);
    Object.assign(nested, { byteLength: nested.byteLength + 1 });
    expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
    expect(full).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["multibyte", "漢🙂é\n".repeat(200)],
    ["escaping", '\\"\t\n\u0000'.repeat(100)],
    ["small boundary", cleanPayload.repeat(2_000).slice(0, 32_768)],
    ["oversize", cleanPayload.repeat(2_000)],
  ])("preserves exact %s bytes and applies the small-body limit", (_name, content) => {
    const message = tool("call-one", content);
    expect(llmMessageToCheckpointResponseItem(message).content).toBe(content);
    const { project, full } = tracked();
    expect(wire(project(message))).toBe(wire(llmMessageToCheckpointResponseItem(message)));
    expect(wire(project(message))).toBe(wire(llmMessageToCheckpointResponseItem(message)));
    expect(full).toHaveBeenCalledTimes(content.length <= 32_768 ? 1 : 2);
  });

  it("keeps recovery-line bounding and limit errors on the full path", () => {
    const oversized = tool("call-one", cleanPayload.repeat(
      Math.ceil(HARD_MAX_RECOVERY_LINE_BYTES / cleanPayload.length),
    ));
    const { project, full } = tracked();
    const bounded = project(oversized);
    expect(wire(bounded)).toBe(wire(llmMessageToCheckpointResponseItem(oversized)));
    expect(Buffer.byteLength(wire(bounded)) - 1).toBeLessThanOrEqual(HARD_MAX_RECOVERY_LINE_BYTES);
    expect(bounded.content).toContain("[Tool result text truncated for durable history]");
    project(oversized);
    expect(full).toHaveBeenCalledTimes(2);

    const metadata = tool();
    metadata.toolName = cleanMetadata.repeat(
      Math.ceil(HARD_MAX_RECOVERY_LINE_BYTES / cleanMetadata.length),
    );
    const failure = tracked();
    expect(() => llmMessageToCheckpointResponseItem(metadata)).toThrow("recovery line byte limit");
    expect(outcome(failure.project, metadata)).toEqual(outcome(llmMessageToCheckpointResponseItem, metadata));
    expect(() => failure.project(metadata)).toThrow("recovery line byte limit");
    expect(failure.full).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ type: "text", text: "ordinary array text" }],
    [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }],
    [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } }],
  ])("keeps structured tool content on the full path: %j", (...content) => {
    const message = tool();
    message.content = content as LLMMessage["content"];
    message.runtimeOnly = { toolResultIntegrity: createToolResultIntegrity({
      runId: "test-run", toolCallId: message.toolCallId!, content: message.content,
    }) };
    const { project, full } = tracked();
    expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
    expect(outcome(project, message)).toEqual(outcome(llmMessageToCheckpointResponseItem, message));
    expect(full).toHaveBeenCalledTimes(2);
  });

  it("evicts by entry count without trusting matching IDs or another projector", () => {
    // All 257 proofs fit the string budget, isolating the 256-entry limit.
    const messages = Array.from({ length: 257 }, (_, index) => {
      const message = tool(`c${index}`, "");
      delete message.toolName;
      message.runtimeOnly = { toolResultIntegrity: createToolResultIntegrity({
        runId: "r", toolCallId: message.toolCallId!, content: message.content,
      }) };
      return message;
    });
    const { project, full } = tracked();
    messages.slice(0, 256).forEach(project);
    project(messages[0]!);
    expect(full).toHaveBeenCalledTimes(256);
    project(messages[256]!);
    expect(full).toHaveBeenCalledTimes(257);
    project(messages[256]!);
    expect(full).toHaveBeenCalledTimes(257);
    project(messages[1]!);
    expect(full).toHaveBeenCalledTimes(258);
    project(structuredClone(messages[1]!));
    expect(full).toHaveBeenCalledTimes(259);
    const other = tracked();
    other.project(messages[256]!);
    expect(other.full).toHaveBeenCalledTimes(1);
  });

  it("bounds retained strings during insertion and same-source proof replacement", () => {
    const { project, full } = tracked();
    const small = tool("small", "ok");
    const first = tool("first", "ok \n".repeat(7_500));
    const second = tool("second", "ok \n".repeat(7_500));
    project(small);
    project(first);
    project(second);
    project(first);
    expect(full).toHaveBeenCalledTimes(3);
    // A changed proof replaces its old budget rather than consuming it twice.
    first.content = "OK \n".repeat(7_500);
    project(first);
    project(second);
    expect(full).toHaveBeenCalledTimes(4);
    const third = tool("third", "ok \n".repeat(7_500));
    project(third);
    project(small);
    expect(full).toHaveBeenCalledTimes(6);
    project(third);
    expect(full).toHaveBeenCalledTimes(6);
  });

  it("does not retain one proof whose otherwise valid metadata exceeds the string budget", () => {
    const message = tool();
    const { project, full } = tracked();
    project(message);
    message.toolName = cleanMetadata.repeat(7_000);
    expect(llmMessageToCheckpointResponseItem(message).toolName).toBe(message.toolName);
    expect(wire(project(message))).toBe(wire(llmMessageToCheckpointResponseItem(message)));
    project(message);
    expect(full).toHaveBeenCalledTimes(3);
    message.toolName = "exec_command";
    project(message);
    project(message);
    expect(full).toHaveBeenCalledTimes(4);
  });

  it("hashes the current full prefix after replacement, reorder, shrink and restoration", () => {
    const project = createCheckpointResponseItemProjector();
    const messages = [tool("first"), tool("second"), tool("third")];
    const versions = [messages, [...messages].reverse(), messages.slice(0, 1),
      [structuredClone(messages[0]!), messages[1]!], [], messages];
    const hashes: string[] = [];
    for (const prefix of versions) {
      const projected = prefix.map(project);
      const fresh = prefix.map(llmMessageToCheckpointResponseItem);
      expect(projected.map(wire)).toEqual(fresh.map(wire));
      const hash = computeCheckpointPrefixHashV3(projected, projected.length);
      expect(hash).toBe(computeCheckpointPrefixHashV3(fresh, fresh.length));
      hashes.push(hash);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
    expect(hashes[0]).toBe(hashes.at(-1));
  });
});
