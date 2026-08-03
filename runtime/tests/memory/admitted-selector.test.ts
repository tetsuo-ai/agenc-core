import { afterEach, describe, expect, it, vi } from "vitest";

const runAdmittedModelCall = vi.hoisted(() => vi.fn());

vi.mock("../../src/budget/admitted-model-call.js", () => ({
  runAdmittedModelCall,
}));

import { createAdmittedMemorySelector } from "../../src/memory/admitted-selector.js";
import {
  MAX_MEMORY_SELECTOR_MS,
  type MemorySelectorRequest,
} from "../../src/memory/recall-contract.js";

const REQUEST: MemorySelectorRequest = {
  policy: "agenc.memory-selector.v1",
  query: { text: "browser", mode: "query" },
  recentTools: [],
  candidates: [
    {
      id: "candidate-1",
      title: "Browser",
      description: "Warnings",
      type: "user",
      mtimeMs: 1,
      omitted: { titleUtf8Bytes: 0, descriptionUtf8Bytes: 0 },
    },
  ],
};

function session(): never {
  let subId = 0;
  return {
    conversationId: "conversation",
    modelInfo: { slug: "test-model", contextWindow: 100_000 },
    services: {
      provider: {
        name: "test-provider",
        chat: vi.fn(),
      },
    },
    nextInternalSubId: () => String(subId++),
  } as never;
}

function response(content: unknown): never {
  return {
    content: typeof content === "string" ? content : JSON.stringify(content),
    toolCalls: [],
    usage: null,
    model: "test-model",
    structuredOutput: {
      type: "json_schema",
      parsed: content,
    },
  } as never;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

afterEach(() => {
  vi.useRealTimers();
  runAdmittedModelCall.mockReset();
});

describe("C3a admitted memory selector", () => {
  it("routes the structured request through the admitted call with frozen bounds", async () => {
    runAdmittedModelCall.mockResolvedValueOnce(
      response({ selected_candidate_ids: ["candidate-1"] }),
    );
    const selector = createAdmittedMemorySelector(session());

    await expect(
      selector.select(REQUEST, new AbortController().signal),
    ).resolves.toEqual({ kind: "selected", candidateIds: ["candidate-1"] });
    const options = runAdmittedModelCall.mock.calls[0]?.[0];
    expect(options.stepId).toBe("memory-selector:0");
    expect(options.parentScopeId).toBe("memory-selector");
    expect(options.options).toMatchObject({
      contextWindowTokens: 33_792,
      maxOutputTokens: 1_024,
      timeoutMs: MAX_MEMORY_SELECTOR_MS,
      parallelToolCalls: false,
      tools: [],
      structuredOutput: { enabled: true },
    });
    expect(options.options.systemPrompt).toContain("untrusted user data");
  });

  it("returns lexical-fallback status at the visible deadline while the admitted call settles later", async () => {
    vi.useFakeTimers();
    const pending = deferred<never>();
    runAdmittedModelCall.mockReturnValueOnce(pending.promise);
    const selector = createAdmittedMemorySelector(session());
    const selection = selector.select(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(MAX_MEMORY_SELECTOR_MS);
    await expect(selection).resolves.toEqual({ kind: "timeout" });
    const admitted = runAdmittedModelCall.mock.calls[0]?.[0];
    expect(admitted.signal.aborted).toBe(true);
    expect(admitted.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(runAdmittedModelCall).toHaveBeenCalledTimes(1);

    pending.resolve(response({ selected_candidate_ids: ["candidate-1"] }));
    await Promise.resolve();
    expect(runAdmittedModelCall).toHaveBeenCalledTimes(1);
  });

  it("rethrows the caller's exact abort reason even if the provider ignores abort", async () => {
    const pending = deferred<never>();
    runAdmittedModelCall.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const reason = new Error("cancel memory selector");
    const selection = createAdmittedMemorySelector(session()).select(
      REQUEST,
      controller.signal,
    );

    controller.abort(reason);
    await expect(selection).rejects.toBe(reason);
    const admitted = runAdmittedModelCall.mock.calls[0]?.[0];
    expect(admitted.signal.reason).toBe(reason);
    pending.reject(reason);
    await Promise.resolve();
  });

  it("rejects oversized, invented-shape, and over-count selector output", async () => {
    const cases: unknown[] = [
      { selected_candidate_ids: [1] },
      { selected_candidate_ids: Array.from({ length: 6 }, () => "candidate-1") },
      { wrong: [] },
      { selected_candidate_ids: [], extra: true },
      `{"selected_candidate_ids":[],"padding":"${"x".repeat(70_000)}"}`,
    ];
    for (const value of cases) {
      runAdmittedModelCall.mockResolvedValueOnce(response(value));
      await expect(
        createAdmittedMemorySelector(session()).select(
          REQUEST,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: "malformed" });
    }

    runAdmittedModelCall.mockResolvedValueOnce({
      ...response({ selected_candidate_ids: [] }),
      content: "x".repeat(70_000),
    });
    await expect(
      createAdmittedMemorySelector(session()).select(
        REQUEST,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "malformed" });
  });

  it("propagates abort injected while parsing the response", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel response parsing");
    const output = {
      get parsed() {
        controller.abort(reason);
        return { selected_candidate_ids: ["candidate-1"] };
      },
      type: "json_schema" as const,
    };
    runAdmittedModelCall.mockResolvedValueOnce({
      ...response("unused"),
      structuredOutput: output,
    });

    await expect(
      createAdmittedMemorySelector(session()).select(REQUEST, controller.signal),
    ).rejects.toBe(reason);
  });
});
