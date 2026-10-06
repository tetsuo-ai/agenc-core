import { describe, expect, it } from "vitest";

import { LLMInvalidResponseError } from "../errors.js";
import {
  normalizeFinishReason,
  requireMappedFinishReason,
} from "./shared.js";

describe("normalizeFinishReason", () => {
  it("maps documented provider stop reasons onto the shared finish reasons", () => {
    expect(normalizeFinishReason("tool_calls")).toBe("tool_calls");
    expect(normalizeFinishReason("tool_use")).toBe("tool_calls");
    expect(normalizeFinishReason("length")).toBe("length");
    expect(normalizeFinishReason("max_tokens")).toBe("length");
    expect(normalizeFinishReason("model_context_window_exceeded")).toBe(
      "length",
    );
    expect(normalizeFinishReason("content_filter")).toBe("content_filter");
    expect(normalizeFinishReason("refusal")).toBe("content_filter");
    expect(normalizeFinishReason("sensitive")).toBe("content_filter");
    expect(normalizeFinishReason("error")).toBe("error");
    expect(normalizeFinishReason("network_error")).toBe("error");
  });

  it("treats an unsupported pause as an error instead of a clean stop", () => {
    expect(normalizeFinishReason("pause_turn")).toBe("error");
  });

  it("defaults unknown or non-string reasons to stop, not String(reason)", () => {
    expect(normalizeFinishReason("stop")).toBe("stop");
    expect(normalizeFinishReason("unknown")).toBe("stop");
    expect(normalizeFinishReason("")).toBe("stop");
    expect(normalizeFinishReason(undefined)).toBe("stop");
    expect(normalizeFinishReason(null)).toBe("stop");
    expect(normalizeFinishReason(0)).toBe("stop");
    expect(normalizeFinishReason({ reason: "tool_calls" })).toBe("stop");
  });
});

describe("requireMappedFinishReason", () => {
  it("returns the mapped reason for documented stop states", () => {
    expect(requireMappedFinishReason("meta", "tool_calls")).toBe("tool_calls");
    expect(requireMappedFinishReason("meta", "max_tokens")).toBe("length");
    expect(requireMappedFinishReason("meta", undefined)).toBe("stop");
    expect(requireMappedFinishReason("meta", { reason: "pause_turn" })).toBe(
      "stop",
    );
  });

  it("rejects pause_turn as an invalid provider envelope", () => {
    expect(() => requireMappedFinishReason("meta", "pause_turn")).toThrow(
      LLMInvalidResponseError,
    );
    expect(() => requireMappedFinishReason("meta", "pause_turn")).toThrow(
      /Unsupported provider state "pause_turn"/u,
    );
  });
});
