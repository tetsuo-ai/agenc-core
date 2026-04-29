import { describe, expect, test } from "vitest";
import { resolveMaxToolUseConcurrency } from "./orchestration.js";

describe("orchestration", () => {
  test("resolveMaxToolUseConcurrency default + env override", () => {
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "5";
    expect(resolveMaxToolUseConcurrency()).toBe(5);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "bogus";
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  });
});
