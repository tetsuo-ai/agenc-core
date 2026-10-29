import { describe, expect, test } from "vitest";
import { QWEN_CURRENT_MODELS } from "../../src/llm/registry/qwen-current-models.js";
import {
  isOffPeakAt,
  msUntilNextUtcHour,
  offPeakScheduleFor,
} from "../../src/session/off-peak-pricing.js";

const at = (iso: string): number => Date.parse(iso);

describe("off-peak hours", () => {
  test("DeepSeek bills half outside 01:00-04:00 and 06:00-10:00 UTC on weekdays", () => {
    const deepseek = offPeakScheduleFor("deepseek", "deepseek-flash")!;
    expect(deepseek).not.toBeNull();
    // 2026-10-19 is a Monday.
    expect(isOffPeakAt(deepseek, at("2026-10-19T00:59:59Z"))).toBe(true);
    expect(isOffPeakAt(deepseek, at("2026-10-19T01:00:00Z"))).toBe(false);
    expect(isOffPeakAt(deepseek, at("2026-10-19T03:59:59Z"))).toBe(false);
    expect(isOffPeakAt(deepseek, at("2026-10-19T04:00:00Z"))).toBe(true);
    expect(isOffPeakAt(deepseek, at("2026-10-19T05:30:00Z"))).toBe(true);
    expect(isOffPeakAt(deepseek, at("2026-10-19T06:00:00Z"))).toBe(false);
    expect(isOffPeakAt(deepseek, at("2026-10-19T09:59:59Z"))).toBe(false);
    expect(isOffPeakAt(deepseek, at("2026-10-19T10:00:00Z"))).toBe(true);
    expect(isOffPeakAt(deepseek, at("2026-10-23T08:00:00Z"))).toBe(false); // Friday
    // Weekends are off-peak all day.
    expect(isOffPeakAt(deepseek, at("2026-10-24T02:00:00Z"))).toBe(true); // Saturday
    expect(isOffPeakAt(deepseek, at("2026-10-25T08:00:00Z"))).toBe(true); // Sunday
    // Every DeepSeek API model shares the hours.
    expect(offPeakScheduleFor("deepseek", "deepseek-v4-pro")).toBe(deepseek);
  });

  test("QwenCloud's DeepSeek rows are busy 08:00-22:00 UTC+8 every day", () => {
    const qwen = offPeakScheduleFor("qwen", "deepseek-v4.1-flash")!;
    expect(qwen).not.toBeNull();
    expect(isOffPeakAt(qwen, at("2026-10-19T13:59:59Z"))).toBe(false); // 21:59 UTC+8
    expect(isOffPeakAt(qwen, at("2026-10-19T14:00:00Z"))).toBe(true); // 22:00 UTC+8
    expect(isOffPeakAt(qwen, at("2026-10-19T23:59:59Z"))).toBe(true); // 07:59 UTC+8
    expect(isOffPeakAt(qwen, at("2026-10-20T00:00:00Z"))).toBe(false); // 08:00 UTC+8
    expect(isOffPeakAt(qwen, at("2026-10-24T03:00:00Z"))).toBe(false); // Saturday, busy
  });

  test("applies only to the rows the Qwen registry prices at busy-hour rates", () => {
    for (const model of ["deepseek-v4-flash-0731", "deepseek-v4-pro-0813", "deepseek-v4.1-flash"]) {
      expect(offPeakScheduleFor("qwen", model), model).not.toBeNull();
      // The rows exist and carry the busy-hour price the mark qualifies.
      expect(QWEN_CURRENT_MODELS.find((entry) => entry.model === model)?.rates?.length, model).toBeGreaterThan(0);
    }
    for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "qwen3.8-max"]) {
      expect(offPeakScheduleFor("qwen", model), model).toBeNull();
    }
    expect(offPeakScheduleFor("qwen-token-plan", "deepseek-v4.1-flash")).toBeNull();
  });

  test("Ollama Cloud bills its DeepSeek rows half outside 12:00-18:00 UTC on weekdays", () => {
    const ollama = offPeakScheduleFor("ollama-cloud", "deepseek-v4.1-flash")!;
    expect(ollama).not.toBeNull();
    // 2026-10-22 is a Thursday.
    expect(isOffPeakAt(ollama, at("2026-10-22T11:59:59Z"))).toBe(true);
    expect(isOffPeakAt(ollama, at("2026-10-22T12:00:00Z"))).toBe(false);
    expect(isOffPeakAt(ollama, at("2026-10-22T17:59:59Z"))).toBe(false);
    expect(isOffPeakAt(ollama, at("2026-10-22T18:00:00Z"))).toBe(true);
    expect(isOffPeakAt(ollama, at("2026-10-24T13:00:00Z"))).toBe(true); // Saturday
    expect(isOffPeakAt(ollama, at("2026-10-25T15:00:00Z"))).toBe(true); // Sunday
    // Every tag of the two DeepSeek families shares the hours.
    for (const model of ["deepseek-v4.1-flash:1017", "deepseek-v4-pro:0813", "DeepSeek-V4-Pro"]) {
      expect(offPeakScheduleFor("ollama-cloud", model), model).toBe(ollama);
    }
    // Models without an off-peak row on Ollama's price list get no mark.
    for (const model of ["glm-5.3", "kimi-k2.7-code", "gpt-oss:120b", "deepseek-v4-flash:0731", undefined]) {
      expect(offPeakScheduleFor("ollama-cloud", model), String(model)).toBeNull();
    }
  });

  test("is unknown for providers whose hours AgenC does not record", () => {
    for (const [provider, model] of [
      ["openrouter", "deepseek/deepseek-v4.1-flash"],
      ["agenc", "deepseek-v4.1-flash"],
      ["venice", "deepseek-v4-flash"],
      ["anthropic", "claude-opus-5-5"],
      ["ollama", "llama3.3"],
      [undefined, undefined],
    ] as const) {
      expect(offPeakScheduleFor(provider, model), String(provider)).toBeNull();
    }
  });

  test("waits for the next whole UTC hour, where every window starts and ends", () => {
    expect(msUntilNextUtcHour(at("2026-10-19T13:59:59Z"))).toBe(1_000);
    expect(msUntilNextUtcHour(at("2026-10-19T14:00:00Z"))).toBe(3_600_000);
    expect(msUntilNextUtcHour(at("2026-10-19T14:30:00Z"))).toBe(1_800_000);
  });
});
