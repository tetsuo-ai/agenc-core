import { describe, expect, test } from "vitest";
import { isLLMPreGenerationRejection } from "../../src/llm/errors.js";
import { observeInitialHttpResponse, withInitialHttpRejection } from "../../src/llm/initial-http-rejection.js";

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
