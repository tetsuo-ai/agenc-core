import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  CheckpointPrefixTracker,
  checkpointPrefixTrackerFor,
  type CheckpointPrefixCaptureOptions,
} from "../../src/session/checkpoint-prefix-tracker.js";
import {
  computeCheckpointPrefixHashV2,
  computeCheckpointPrefixHashV3,
  computeCheckpointPrefixHashV4,
} from "../../src/session/durable-checkpoint-reader.js";
import {
  captureCheckpointMessage,
  llmMessageToCheckpointResponseItem,
} from "../../src/session/message-history-conversion.js";
import {
  CanonicalFieldRecorder,
  CanonicalSha256Writer,
  createToolResultIntegrity,
  digestToolResultBody,
  type CanonicalFieldRecord,
  type ToolResultIntegrity,
} from "../../src/session/tool-result-integrity.js";
import {
  assistantToolCall,
  boundedToolResult,
  checkpointPrefixCorpus,
  persistedResponseItem,
  sealedToolResult,
} from "./fixtures/checkpoint-prefix-corpus.js";
import { CHECKPOINT_PREFIX_GOLDEN } from "./fixtures/checkpoint-prefix-golden.js";

// Produced by the unmodified r4/base 6a19c87fd implementation from the corpus.
const golden = CHECKPOINT_PREFIX_GOLDEN;

const LIVE: CheckpointPrefixCaptureOptions = { deferring: false, pendingIntegrity: () => false };

function outcome(run: () => string): string {
  try { return run(); }
  catch (error) { return `error:${error instanceof Error ? error.message : String(error)}`; }
}

/** The writer before this change: project everything, then hash everything. */
function fullDigest(messages: readonly LLMMessage[]): string {
  return outcome(() => {
    const projected = messages.map((message) => llmMessageToCheckpointResponseItem(message));
    for (const item of projected) {
      if (item.role === "tool" && item.toolResultIntegrity === undefined) {
        throw new Error("checkpoint v2 requires every tool result to be sealed");
      }
    }
    return computeCheckpointPrefixHashV4(projected, projected.length);
  });
}

function trackerDigest(
  tracker: CheckpointPrefixTracker,
  messages: readonly LLMMessage[],
  options: CheckpointPrefixCaptureOptions = LIVE,
): string {
  return outcome(() => tracker.capture(messages, options).build().prefixHash);
}

function windowAt(index: number, body = `result ${index}: ${"line of output\n".repeat(20)}`): LLMMessage[] {
  const id = `call-${index}`;
  return [
    assistantToolCall(index, [{ id, name: "Read", arguments: JSON.stringify({ file_path: `/w/file-${index}.ts` }) }]),
    sealedToolResult(id, body, { toolName: "Read" }),
  ];
}

describe("checkpoint prefix digests against the old writer", () => {
  it("the full digests still equal the base implementation's digests", () => {
    const { live, durable } = checkpointPrefixCorpus();
    expect(live).toHaveLength(golden.messages);
    const projected = live.map((message) => llmMessageToCheckpointResponseItem(message));
    for (const prefix of golden.prefixes) {
      expect(outcome(() => computeCheckpointPrefixHashV2(projected, prefix.count))).toBe(prefix.v2);
      expect(outcome(() => computeCheckpointPrefixHashV3(projected, prefix.count))).toBe(prefix.v3);
      expect(outcome(() => computeCheckpointPrefixHashV4(projected, prefix.count))).toBe(prefix.v4);
      expect(outcome(() => computeCheckpointPrefixHashV4(durable, prefix.count))).toBe(prefix.v4Durable);
    }
    for (const body of golden.bodies) expect(digestToolResultBody(body.value)).toEqual(body.identity);
  });

  it("the incremental digest equals the base digest for every prefix, live or deferred", () => {
    const { live } = checkpointPrefixCorpus();
    const shared = new CheckpointPrefixTracker();
    for (const prefix of golden.prefixes) {
      const messages = live.slice(0, prefix.count);
      expect(trackerDigest(shared, messages)).toBe(prefix.v4);
      expect(trackerDigest(new CheckpointPrefixTracker(), messages)).toBe(prefix.v4);
      expect(trackerDigest(shared, messages, { deferring: true, pendingIntegrity: () => false })).toBe(prefix.v4);
    }
  });

  it("recorded fields replay into a digest byte for byte", () => {
    type Field = readonly [kind: "count" | "string", label: string, value: number | string];
    const fields: readonly Field[] = [
      ["string", "role", "assistant"], ["count", "tool-call-count", 2], ["string", "unicode", "ünï \u{1F680} 测试"],
      ["count", "zero", 0], ["string", "empty", ""], ["string", "long", "x".repeat(70_000)],
      ["count", "large", Number.MAX_SAFE_INTEGER],
    ];
    const write = (writer: CanonicalSha256Writer | CanonicalFieldRecorder, [kind, label, value]: Field) => {
      if (kind === "count") writer.writeCount(label, value as number);
      else writer.writeString(label, value as string);
    };
    const domain = "agenc.test.replay";
    for (let split = 0; split <= fields.length; split += 1) {
      const direct = new CanonicalSha256Writer(domain);
      for (const field of fields) write(direct, field);
      // Record a prefix (nested once), replay it, then write the rest.
      const inner = new CanonicalFieldRecorder();
      for (const field of fields.slice(0, Math.floor(split / 2))) write(inner, field);
      const outer = new CanonicalFieldRecorder();
      outer.writeRecord(inner.finish());
      for (const field of fields.slice(Math.floor(split / 2), split)) write(outer, field);
      const replayed = new CanonicalSha256Writer(domain);
      replayed.writeRecord(outer.finish());
      for (const field of fields.slice(split)) write(replayed, field);
      expect(replayed.digest()).toBe(direct.digest());
      expect(replayed.payloadByteLength).toBe(direct.payloadByteLength);
    }
    const forged = Object.freeze({ byteLength: 0, payloadByteLength: 0 }) as CanonicalFieldRecord;
    expect(() => new CanonicalSha256Writer(domain).writeRecord(forged))
      .toThrow("canonical field record was not produced by a recorder");
    const illFormed = (writer: CanonicalSha256Writer | CanonicalFieldRecorder) =>
      outcome(() => { writer.writeString("label", "\ud800"); return "accepted"; });
    expect(illFormed(new CanonicalFieldRecorder())).toBe(illFormed(new CanonicalSha256Writer(domain)));
    expect(illFormed(new CanonicalFieldRecorder())).toMatch(/^error:/);
  });
});

describe("checkpoint prefix tracker", () => {
  const errorCases: number[] = [];

  it("projects each message once across a long session and stays exact", () => {
    const tracker = new CheckpointPrefixTracker();
    const history: LLMMessage[] = [{ role: "user", content: "Refactor the parser." }];
    const windows: LLMMessage[][] = [];
    for (let index = 1; index <= 150; index += 1) {
      const [assistant, tool] = windowAt(index);
      windows.push([assistant!, tool!]);
      const sampled = index % 25 === 0 || index < 4;
      history.push(assistant!);
      const postAssistant = tracker.capture(history, LIVE).build();
      if (sampled) expect(postAssistant.prefixHash).toBe(fullDigest(history));
      history.push(tool!);
      // Retention bounds an old body while its sealed identity stays.
      if (index > 8) history[2 + (index - 9) * 2] = boundedToolResult(windows[index - 9]![1]!, "[cleared]");
      const iteration = tracker.capture(history, LIVE).build();
      if (sampled) expect(iteration.prefixHash).toBe(fullDigest(history));
      // The first checkpoint also projects the user message.
      expect(postAssistant.projectedMessages).toBe(index === 1 ? 2 : 1);
      expect(iteration.projectedMessages).toBe(index > 8 ? 2 : 1);
      expect(iteration.persistedMessageCount).toBe(history.length);
    }
  });

  it("detects every in-place change of a recorded message", () => {
    const mutations: Array<[name: string, mutate: (history: LLMMessage[]) => void]> = [
      ["user content", (h) => { h[0]!.content = "Refactor the lexer."; }],
      ["text part", (h) => { (h[0]!.content as Array<{ text: string }>)[0]!.text = "changed"; }],
      ["tool arguments", (h) => { h[1]!.toolCalls![0]!.arguments = "{\"file_path\":\"/w/other.ts\"}"; }],
      ["tool call name", (h) => { h[1]!.toolCalls![0]!.name = "Grep"; }],
      ["extra tool call", (h) => { h[1]!.toolCalls!.push({ id: "call-x", name: "Read", arguments: "{}" }); }],
      ["reasoning", (h) => { h[1]!.providerReasoningContent = "different reasoning"; }],
      ["provenance model", (h) => { (h[1]!.providerReasoningProvenance as { model: string }).model = "deepseek-pro"; }],
      ["phase", (h) => { h[1]!.phase = "final_answer"; }],
      ["response id", (h) => { (h[1]!.runtimeOnly as { responseItemId?: string }).responseItemId = "resp-other"; }],
      ["tool result body", (h) => { h[2]!.content = "a different body"; }],
      ["persisted seal", (h) => {
        const seal = h[2]!.runtimeOnly!.toolResultIntegrity as { persisted: unknown };
        seal.persisted = { representation: "compacted", ...digestToolResultBody("[cleared]") };
      }],
      ["persisted digest leaf", (h) => {
        const persisted = h[2]!.runtimeOnly!.toolResultIntegrity!.persisted as { digest: string };
        persisted.digest = `sha256:${"0".repeat(64)}`;
      }],
      ["failure flag", (h) => {
        h[2]!.runtimeOnly = { ...h[2]!.runtimeOnly, toolResultIsError: true };
      }],
      ["added key", (h) => { (h[3] as unknown as Record<string, unknown>).phase = "commentary"; }],
      ["deleted key", (h) => { delete (h[3]!.runtimeOnly as { responseItemId?: string }).responseItemId; }],
      ["tool call id", (h) => { h[2]!.toolCallId = "call-other"; }],
    ];
    for (const [name, mutate] of mutations) {
      const history: LLMMessage[] = [
        { role: "user", content: [{ type: "text", text: "Refactor the parser." }] },
        ...windowAt(1),
        { role: "assistant", content: "Done.", runtimeOnly: { responseItemId: "resp-done" } },
      ];
      const tracker = new CheckpointPrefixTracker();
      expect(trackerDigest(tracker, history), name).toBe(fullDigest(history));
      mutate(history);
      const expected = fullDigest(history);
      const capture = tracker.capture(history, LIVE);
      expect(outcome(() => capture.build().prefixHash), name).toBe(expected);
      // The changed message is projected again, never reused.
      if (!expected.startsWith("error:")) expect(capture.build().projectedMessages, name).toBe(1);
    }
  });

  it("reuses records for rebuilt copies that only change key order", () => {
    const tracker = new CheckpointPrefixTracker();
    const history: LLMMessage[] = [{ role: "user", content: "start" }];
    for (let index = 1; index <= 20; index += 1) history.push(...windowAt(index));
    tracker.capture(history, LIVE).build();
    // A new turn starts from copies whose keys come in another order.
    const reversedKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversedKeys);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).reverse().map(([key, field]) => [key, reversedKeys(field)]));
    };
    const copies = history.map((message) => reversedKeys(message) as LLMMessage);
    copies.push({ role: "user", content: "next turn" });
    const result = tracker.capture(copies, LIVE).build();
    expect(result.projectedMessages).toBe(1);
    expect(result.prefixHash).toBe(fullDigest(copies));
    // A real value change in a copy is still caught.
    copies[3]!.toolCalls![0]!.arguments = "{}";
    const changed = tracker.capture(copies, LIVE).build();
    expect(changed.projectedMessages).toBe(1);
    expect(changed.prefixHash).toBe(fullDigest(copies));
  });

  it("stays exact across removal, rewind, compaction and reinsertion", () => {
    const tracker = new CheckpointPrefixTracker();
    let history: LLMMessage[] = [{ role: "user", content: "start" }];
    for (let index = 1; index <= 12; index += 1) history.push(...windowAt(index));
    const original = [...history];
    const check = () => expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
    check();
    history.splice(5, 1); // a correction removed from the middle
    check();
    history = history.slice(0, 9); // rewind
    check();
    history = original.map((message) => structuredClone(message)); // equal values, new objects
    check();
    expect(tracker.capture(history, LIVE).build().projectedMessages).toBe(0);
    history = [{ role: "user", content: "summary of the compacted conversation" }, ...original.slice(15)];
    check();
    history = [...original]; // the original objects come back
    check();
    history.reverse();
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
  });

  it("builds a deferred checkpoint from the state at capture time", () => {
    const tracker = new CheckpointPrefixTracker();
    const history: LLMMessage[] = [{ role: "user", content: "start" }, ...windowAt(1), ...windowAt(2)];
    const deferred: CheckpointPrefixCaptureOptions = { deferring: true, pendingIntegrity: () => false };
    const expected = fullDigest(history.map((message) => captureCheckpointMessage(message)));
    const capture = tracker.capture(history, deferred);
    history[0]!.content = "changed after capture";
    history[3]!.toolCalls![0]!.arguments = "{}";
    history.push(...windowAt(3));
    expect(capture.build().prefixHash).toBe(expected);
    expect(trackerDigest(tracker, history, deferred)).toBe(fullDigest(history));
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
  });

  it("shares a pending seal like the full writer and never reuses its record", () => {
    const tracker = new CheckpointPrefixTracker();
    const pending = new WeakSet<object>();
    const options: CheckpointPrefixCaptureOptions = {
      deferring: true,
      pendingIntegrity: (integrity) => pending.has(integrity),
    };
    const history: LLMMessage[] = [{ role: "user", content: "start" }, ...windowAt(1)];
    tracker.capture(history, LIVE).build();
    // run-turn persists a new result by queueing a job that fills the
    // persisted identity of a private seal copy shared with the message.
    const content = "API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789\n";
    const assistant = assistantToolCall(2, [{ id: "call-2", name: "exec_command", arguments: "{}" }]);
    const unsealed = createToolResultIntegrity({ runId: "conv-checkpoint-corpus", toolCallId: "call-2", content });
    const seal: ToolResultIntegrity = { ...unsealed, original: { ...unsealed.original }, persisted: { ...unsealed.persisted } };
    const live: LLMMessage = {
      role: "tool", toolCallId: "call-2", toolName: "exec_command", content,
      runtimeOnly: { toolResultIntegrity: seal },
    };
    pending.add(seal);
    history.push(assistant, live);
    const expectedCapture = history.map((message) => captureCheckpointMessage(message,
      message.runtimeOnly?.toolResultIntegrity !== undefined && pending.has(message.runtimeOnly.toolResultIntegrity)
        ? message.runtimeOnly.toolResultIntegrity : undefined));
    const first = tracker.capture(history, options);
    const second = tracker.capture(history, options);
    // The FIFO response-item job fills the shared seal before either build.
    (seal as { persisted: ToolResultIntegrity["persisted"] }).persisted =
      persistedResponseItem(sealedToolResult("call-2", content, { toolName: "exec_command" })).toolResultIntegrity!.persisted;
    pending.delete(seal);
    const expected = fullDigest(expectedCapture);
    expect(first.build().prefixHash).toBe(expected);
    expect(second.build().prefixHash).toBe(expected);
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
    expect(tracker.capture(history, LIVE).build().projectedMessages).toBe(0);
  });

  it("never reuses messages that are not plain data", () => {
    const tracker = new CheckpointPrefixTracker();
    let reads = 0;
    const accessor = { role: "user", runtimeOnly: { responseItemId: "resp-accessor" } } as LLMMessage;
    Object.defineProperty(accessor, "content", { enumerable: true, get: () => { reads += 1; return "accessor body"; } });
    class Message { role = "assistant" as const; content = "class instance"; }
    const history: LLMMessage[] = [accessor, new Message() as LLMMessage, ...windowAt(1)];
    for (let round = 0; round < 3; round += 1) {
      const result = tracker.capture(history, LIVE).build();
      expect(result.prefixHash).toBe(fullDigest(history));
      expect(result.projectedMessages).toBe(round === 0 ? 4 : 2);
    }
    expect(reads).toBeGreaterThan(0);
  });

  it("fails like the full writer and recovers once the history is valid", () => {
    const tracker = new CheckpointPrefixTracker();
    const [assistant, tool] = windowAt(1);
    const unsealed: LLMMessage = { role: "tool", toolCallId: "call-1", content: "no seal" };
    const history: LLMMessage[] = [{ role: "user", content: "start" }, assistant!, unsealed];
    expect(trackerDigest(tracker, history)).toBe("error:checkpoint v2 requires every tool result to be sealed");
    expect(fullDigest(history)).toBe("error:checkpoint v2 requires every tool result to be sealed");
    history[2] = tool!;
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
    const invalidPhase = { role: "assistant", content: "x", phase: 7 } as unknown as LLMMessage;
    history.push(invalidPhase);
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
    expect(fullDigest(history)).toMatch(/^error:checkpoint response item 3 has invalid phase/);
    history.pop();
    expect(trackerDigest(tracker, history)).toBe(fullDigest(history));
  });

  it.each([1, 2, 3, 4, 5, 6])("matches the full writer under random history edits (seed %i)", (seed) => {
    let state = seed * 0x9e3779b1;
    const next = (bound: number): number => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return (state >>> 0) % bound;
    };
    const tracker = new CheckpointPrefixTracker();
    let history: LLMMessage[] = [{ role: "user", content: "start" }];
    let window = 0;
    const queued: Array<{ readonly build: () => string; readonly expected: string }> = [];
    const seen = { live: 0, deferred: 0, errors: 0 };
    const compare = (actual: string, expected: string, label: string) => {
      expect(actual, label).toBe(expected);
      if (expected.startsWith("error:")) seen.errors += 1;
    };
    const toolIndices = () => history.flatMap((message, index) => message.role === "tool" ? [index] : []);
    const mutations: Array<(message: LLMMessage) => void> = [
      (message) => { message.content = `edited ${next(1000)}`; },
      (message) => { message.phase = next(2) === 0 ? "commentary" : "final_answer"; },
      (message) => { message.runtimeOnly = { ...message.runtimeOnly, responseItemId: `resp-${next(1000)}` }; },
      (message) => { if (message.toolCalls?.[0]) message.toolCalls[0].arguments = `{"n":${next(1000)}}`; },
      (message) => { if (message.providerReasoningContent !== undefined) message.providerReasoningContent += "!"; },
      (message) => {
        const seal = message.runtimeOnly?.toolResultIntegrity;
        if (seal) (seal as { persisted: unknown }).persisted = { representation: "compacted", ...digestToolResultBody(`c${next(9)}`) };
      },
      // Breaks the seal binding: both writers must refuse the same way.
      (message) => { if (message.role === "tool" && next(4) === 0) message.toolCallId = "call-unbound"; },
    ];
    for (let step = 0; step < 220; step += 1) {
      const operation = next(100);
      if (operation < 30) {
        window += 1;
        history.push(...windowAt(window, `body ${window} ${"x".repeat(next(400))}`));
      } else if (operation < 36) {
        history.push(next(2) === 0
          ? { role: "user", content: `note ${step}` }
          : { role: "assistant", content: `answer ${step}`, phase: "final_answer" });
      } else if (operation < 44 && toolIndices().length > 0) {
        const indices = toolIndices();
        const index = indices[next(indices.length)]!;
        history[index] = boundedToolResult(history[index]!, `[cleared ${step}]`);
      } else if (operation < 54) {
        const message = history[next(history.length)]!;
        mutations[next(mutations.length)]!(message);
      } else if (operation < 57 && history.length > 1) {
        history.splice(1 + next(history.length - 1), 1);
      } else if (operation < 59) {
        history = history.slice(0, 1 + next(history.length));
      } else if (operation < 62) {
        const index = next(history.length);
        history[index] = structuredClone(history[index]!);
      } else if (operation < 63) {
        history = history.map((message) => structuredClone(message));
      } else if (operation < 80) {
        compare(trackerDigest(tracker, history), fullDigest(history), `step ${step}`);
        seen.live += 1;
      } else if (operation < 92) {
        const expected = fullDigest(history.map((message) => captureCheckpointMessage(message)));
        const capture = tracker.capture(history, { deferring: true, pendingIntegrity: () => false });
        queued.push({ build: () => outcome(() => capture.build().prefixHash), expected });
      } else if (queued.length > 0) {
        const { build, expected } = queued.shift()!;
        compare(build(), expected, `step ${step}`);
        seen.deferred += 1;
      }
    }
    for (const { build, expected } of queued) compare(build(), expected, "drain");
    compare(trackerDigest(tracker, history), fullDigest(history), "final");
    expect(seen.live).toBeGreaterThanOrEqual(20);
    expect(seen.deferred).toBeGreaterThanOrEqual(5);
    errorCases.push(seen.errors);
  });

  it("covered refused histories in the random edits", () => {
    expect(errorCases).toHaveLength(6);
    expect(errorCases.reduce((total, count) => total + count, 0)).toBeGreaterThan(0);
  });

  it("is shared by every turn of one session object", () => {
    const session = {};
    expect(checkpointPrefixTrackerFor(session)).toBe(checkpointPrefixTrackerFor(session));
    expect(checkpointPrefixTrackerFor(session)).not.toBe(checkpointPrefixTrackerFor({}));
  });
});
