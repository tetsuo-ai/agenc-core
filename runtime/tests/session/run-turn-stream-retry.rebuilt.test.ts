import { describe, expect, test } from "vitest";

import { LLMRequestRebuiltError } from "../../src/llm/errors.js";
import { StreamModelError } from "../../src/phases/stream-model.js";
import { isRetryableStreamError } from "../../src/session/run-turn.js";

describe("isRetryableStreamError", () => {
  test("a rebuilt request is retried through the reconnect ladder", () => {
    const cause = new LLMRequestRebuiltError("grok", "store refused; next attempt is unstored");
    expect(isRetryableStreamError(new StreamModelError(cause))).toBe(true);
  });
});
