import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createDeferredTextToolResultIntegrity, createToolResultIntegrity, verifyToolResultIntegrity,
  withPersistedToolResultRepresentation } from "../../src/session/tool-result-integrity.js";

// The hermetic setup loads session modules before this test's crypto mock.
vi.hoisted(() => vi.resetModules());

vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

test("immutable text integrity hashes once on consumption and serializes to the canonical bytes", () => {
  const params = { runId: "run", toolCallId: "call", content: "original body" };
  const canonical = JSON.stringify(createToolResultIntegrity(params));
  vi.mocked(createHash).mockClear();
  const integrity = createDeferredTextToolResultIntegrity(params);
  expect(createHash).not.toHaveBeenCalled();
  params.content = "changed later";
  expect(JSON.stringify(integrity)).toBe(canonical);
  const calls = vi.mocked(createHash).mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  expect(JSON.stringify(integrity)).toBe(canonical);
  expect(createHash).toHaveBeenCalledTimes(calls);
  expect(verifyToolResultIntegrity({ integrity, expectedRunId: "run", toolCallId: "call", content: "original body" }).status).toBe("valid");
  expect(verifyToolResultIntegrity({ integrity, expectedRunId: "run", toolCallId: "call", content: "changed later" }).status).toBe("invalid");
  const shortened = withPersistedToolResultRepresentation(integrity, "truncated", "short");
  expect(verifyToolResultIntegrity({ integrity: shortened, expectedRunId: "run", toolCallId: "call", content: "short" }).status).toBe("valid");
});

test("invalid text, invalid scope, and mutable structured bodies keep eager checks", () => {
  expect(() => createDeferredTextToolResultIntegrity({ runId: "run", toolCallId: "call", content: "\ud800" })).toThrow();
  expect(() => createDeferredTextToolResultIntegrity({ runId: "", toolCallId: "call", content: "body" })).toThrow();
  expect(() => createDeferredTextToolResultIntegrity({ runId: "run", toolCallId: "\ud800", content: "body" })).toThrow();
  const content = [{ type: "text", text: "original" }];
  const integrity = createDeferredTextToolResultIntegrity({ runId: "run", toolCallId: "call", content });
  const bytes = JSON.stringify(integrity);
  content[0]!.text = "changed";
  expect(JSON.stringify(integrity)).toBe(bytes);
  expect(verifyToolResultIntegrity({ integrity, expectedRunId: "run", toolCallId: "call", content }).status).toBe("invalid");
});
