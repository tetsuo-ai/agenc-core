import { describe, expect, test } from "vitest";
import {
  isLLMPreGenerationRejection,
  markLLMInitialHttpRejection,
} from "../../src/llm/errors.js";
import { observeInitialHttpResponse, withInitialHttpRejection } from "../../src/llm/initial-http-rejection.js";

const CONFIRMED_REFUSAL_STATUSES = [400, 401, 402, 403, 429] as const;
const AMBIGUOUS_STATUSES = [200, 408, 500, 503] as const;

describe("SDK opening response evidence", () => {
  test("isolates concurrent calls and uses observed HTTP status, not error properties", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refused = new Error("refused");
    const accepted = Object.assign(new Error("body failed"), { status: 429 });
    const a = withInitialHttpRejection("grok", true, async () => {
      observeInitialHttpResponse(new Response(null, { status: 429 }));
      await gate;
      throw refused;
    });
    const b = withInitialHttpRejection("grok", true, async () => {
      observeInitialHttpResponse(new Response(null, { status: 200 }));
      release();
      throw accepted;
    });
    await Promise.allSettled([a, b]);
    expect(isLLMPreGenerationRejection(refused, "grok")).toBe(true);
    expect(isLLMPreGenerationRejection(refused, "ollama")).toBe(false);
    expect(isLLMPreGenerationRejection(accepted, "grok")).toBe(false);
  });

  test.each([{ statuses: [] }, { statuses: [200, 429] }, { statuses: [503, 429] }])("refuses evidence without exactly one opening response: %j", async ({ statuses }) => {
    const error = Object.assign(new Error("failure"), { status: 429 });
    await expect(withInitialHttpRejection("grok", true, async () => {
      for (const status of statuses) observeInitialHttpResponse(new Response(null, { status }));
      throw error;
    })).rejects.toBe(error);
    expect(isLLMPreGenerationRejection(error, "grok")).toBe(false);
  });
});

describe("markLLMInitialHttpRejection", () => {
  test.each(CONFIRMED_REFUSAL_STATUSES)(
    "marks HTTP %s only for a single-wire attempt on that provider",
    (status) => {
      const error = new Error("refused");
      expect(markLLMInitialHttpRejection(error, "grok", status, true)).toBe(error);
      expect(isLLMPreGenerationRejection(error, "grok")).toBe(true);
      expect(isLLMPreGenerationRejection(error, "openai")).toBe(false);
    },
  );

  test.each(AMBIGUOUS_STATUSES)(
    "does not mark HTTP %s even on a single-wire attempt",
    (status) => {
      const error = new Error("ambiguous");
      markLLMInitialHttpRejection(error, "grok", status, true);
      expect(isLLMPreGenerationRejection(error, "grok")).toBe(false);
    },
  );

  test.each([false, undefined] as const)(
    "does not mark a confirmed 429 when singleWireAttempt is %s",
    (singleWireAttempt) => {
      const error = new Error("retryable");
      markLLMInitialHttpRejection(error, "grok", 429, singleWireAttempt);
      expect(isLLMPreGenerationRejection(error, "grok")).toBe(false);
    },
  );

  test.each(["429", undefined, null, true] as const)(
    "does not treat a non-numeric status as a confirmed refusal: %j",
    (status) => {
      const error = new Error("bad status");
      markLLMInitialHttpRejection(error, "grok", status, true);
      expect(isLLMPreGenerationRejection(error, "grok")).toBe(false);
    },
  );
});
