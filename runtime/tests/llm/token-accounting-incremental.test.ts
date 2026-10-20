/**
 * Every model call counts the whole request, and the session's history is
 * most of it. Counting must not walk (snapshot, serialize, normalize) the
 * unchanged history again, and must give exactly the results the
 * whole-request implementation gave.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { TOKEN_ACCOUNTING_SESSION_GOLDEN } from "./fixtures/token-accounting-session-golden.js";
import { cloneLlmMessageSnapshot } from "../../src/llm/content-conversion.js";
import {
  TokenAccountingService,
  estimateUtf8TokenUnits,
  type TokenAccountingResult,
} from "../../src/llm/token-accounting.js";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  SESSION_CORPUS_CALLS,
  sessionCorpusAccountingRequest,
  sessionCorpusHistory,
  sessionCorpusRequests,
  type SessionCorpusRequest,
} from "./fixtures/token-accounting-session-corpus.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function summary(result: TokenAccountingResult, requestBytes: number | null): Record<string, unknown> {
  return {
    inputTokens: result.inputTokens,
    totalTokens: result.totalTokens,
    safetyMarginTokens: result.safetyMarginTokens,
    confidence: result.confidence,
    admissible: result.admissible,
    contentTypes: [...result.coverage.contentTypes],
    uncertainComponents: [...result.coverage.uncertainComponents],
    requestBytes,
  };
}

/** The serialized request size, which the byte limit reports. */
async function requestBytes(spec: SessionCorpusRequest, messages: readonly LLMMessage[], scope: string): Promise<number | null> {
  const bounded = new TokenAccountingService({ maxRequestBytes: 200 });
  try {
    await bounded.count(sessionCorpusAccountingRequest(spec, messages, scope));
  } catch (error) {
    const match = /request is (\d+) bytes/.exec(String((error as Error).message));
    return match === null ? null : Number(match[1]);
  }
  return null;
}

function referenceUpperBound(value: string): number {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  return Math.max(bytes(value), ...(["NFC", "NFD", "NFKC", "NFKD"] as const).map((form) => bytes(value.normalize(form))));
}

describe("request token accounting over a growing session", () => {
  test("counts every call of the session exactly as the whole-request implementation", async () => {
    const history = sessionCorpusHistory(SESSION_CORPUS_CALLS);
    const service = new TokenAccountingService();
    const records = new Map(TOKEN_ACCOUNTING_SESSION_GOLDEN.map((record) => [record.label, record]));
    for (const spec of sessionCorpusRequests()) {
      const { label: _label, messages: length, ...expected } = records.get(spec.label)!;
      // Each model request counts its own copy of the history, twice.
      for (let copy = 0; copy < 2; copy += 1) {
        const messages = history.slice(0, length).map(cloneLlmMessageSnapshot);
        const result = await service.count(sessionCorpusAccountingRequest(spec, messages));
        expect(summary(result, await requestBytes(spec, messages, "conv-token-accounting-corpus")), spec.label)
          .toEqual(expected);
      }
    }
  });

  test("never reuses work for a message whose data changed", async () => {
    const history = sessionCorpusHistory(SESSION_CORPUS_CALLS);
    const spec = sessionCorpusRequests().find((request) => request.label === `deepseek-${SESSION_CORPUS_CALLS}`)!;
    const service = new TokenAccountingService();
    let cold = 0;
    const count = async (messages: LLMMessage[], scope = "conv-token-accounting-corpus") =>
      service.count(sessionCorpusAccountingRequest(spec, messages, scope));
    // A fresh service scope and fresh objects share nothing with earlier counts.
    const fresh = async (messages: LLMMessage[]) =>
      count(messages.map((message) => structuredClone(message)), `cold-${(cold += 1)}`);
    const warm = history.map(cloneLlmMessageSnapshot);
    await count(warm);
    const edits: Array<[string, (messages: LLMMessage[]) => void]> = [
      ["content edited in place", (messages) => { (messages[5] as { content: string }).content = `${messages[5]!.content as string} edited ü`; }],
      ["reasoning edited in place", (messages) => { messages[4]!.providerReasoningContent = "rewritten reasoning 가"; }],
      ["keys reordered", (messages) => {
        const { role, content, ...rest } = messages[6]!;
        messages[6] = { ...rest, content, role } as LLMMessage;
      }],
      ["message replaced at its position", (messages) => { messages[8] = { role: "developer", content: "replaced ﬁ" }; }],
      ["field added", (messages) => { messages[10] = { ...messages[10]!, phase: "final_answer" }; }],
      ["accessor field", (messages) => {
        const target = { ...messages[12]! };
        Object.defineProperty(target, "content", { enumerable: true, get: () => "accessor content" });
        messages[12] = target;
      }],
    ];
    for (const [, edit] of edits) {
      edit(warm);
      const copy = warm.map(cloneLlmMessageSnapshot);
      expect(await count(copy)).toEqual(await fresh(warm));
    }
  });

  test("does not serialize or normalize the unchanged history again", async () => {
    const history = sessionCorpusHistory(SESSION_CORPUS_CALLS);
    const spec = sessionCorpusRequests().find((request) => request.label === `deepseek-${SESSION_CORPUS_CALLS}`)!;
    const service = new TokenAccountingService();
    const stringify = JSON.stringify;
    let serialized = 0;
    vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const text = stringify(...args);
      serialized += text?.length ?? 0;
      return text;
    });
    const normalize = String.prototype.normalize;
    let normalized = 0;
    vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string, form?: string) {
      normalized += this.length;
      return normalize.call(this, form);
    });
    const perCall: Array<{ serialized: number; normalized: number }> = [];
    for (let calls = SESSION_CORPUS_CALLS - 10; calls <= SESSION_CORPUS_CALLS; calls += 1) {
      const messages = history.slice(0, sessionCorpusHistory(calls).length).map(cloneLlmMessageSnapshot);
      serialized = 0;
      normalized = 0;
      await service.count(sessionCorpusAccountingRequest(spec, messages));
      perCall.push({ serialized, normalized });
    }
    const requestSize = (await requestBytes(spec, history, "bytes"))!;
    const last = perCall.at(-1)!;
    // The whole request is about requestSize characters; a full walk
    // serializes it twice and normalizes its prompt four times per count.
    expect(last.serialized).toBeLessThan(requestSize / 4);
    expect(last.normalized).toBeLessThan(requestSize / 4);
    // Later calls cost about the same as earlier ones.
    expect(last.serialized).toBeLessThan(2 * perCall[0]!.serialized + 4_096);
  });

  test("bounds UTF-8 under every normalization form exactly, piece by piece", () => {
    const palette = [
      "a", "e", "A", " ", "\n", "\"", "{", "0", "́", "̈", "̧", "̊", "̈́", "ཱི",
      "ᄀ", "ᅡ", "ᆨ", "가", "é", "Å", "Å", "ẛ", "̣", "ﬁ",
      "ﷺ", "⑴", "㎡", "Ａ", "　", "\u{1f680}", "‍", "\u{1f469}", "测", "क़",
      "\ud800", "\udc00", "ال", "אַ", " ", "Ω", "क़",
    ];
    let seed = 0x5bd1e995;
    const random = (limit: number) => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) % limit;
    };
    const samples = ["", "plain ascii", "é", "ä́b", "ﷺﷺ", "각xᄀ", "\ud800a\udc00"];
    for (let index = 0; index < 4_000; index += 1) {
      let text = "";
      const length = 1 + random(24);
      for (let char = 0; char < length; char += 1) text += palette[random(palette.length)]!;
      samples.push(text);
    }
    for (const text of samples) {
      expect(estimateUtf8TokenUnits(text, 1), JSON.stringify(text)).toBe(referenceUpperBound(text));
    }
  });
});
