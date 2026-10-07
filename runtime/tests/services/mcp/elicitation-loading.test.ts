import { expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({
  loads: 0,
  request: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  result: vi.fn(async (_server: unknown, result: unknown, ..._args: unknown[]) => result),
}));
vi.mock("../../../src/services/mcp/elicitationHandler.js", () => {
  effects.loads++;
  return { runElicitationHooks: effects.request, runElicitationResultHooks: effects.result };
});

test("keeps elicitation deferred on normal/error calls and preserves hook overrides and retries", async () => {
  const { callMCPToolWithUrlElicitationRetry } = await import("../../../src/services/mcp/client.js");
  expect(effects.loads).toBe(0);
  const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
  const signal = new AbortController().signal;
  const plain = { content: [{ type: "text", text: "done" }] };
  const options = {
    client: {} as never, clientConnection: { type: "connected", name: "fixture" } as never,
    tool: "url-tool", args: { input: 1 }, signal,
    setAppState: vi.fn(() => { throw new Error("unexpected UI queue"); }),
    callToolFn: vi.fn(async () => plain as never),
  };
  await expect(callMCPToolWithUrlElicitationRetry(options)).resolves.toBe(plain);
  const ordinaryError = new Error("ordinary failure");
  options.callToolFn.mockRejectedValueOnce(ordinaryError);
  await expect(callMCPToolWithUrlElicitationRetry(options)).rejects.toBe(ordinaryError);
  const malformed = new McpError(ErrorCode.UrlElicitationRequired, "malformed", { elicitations: [] });
  options.callToolFn.mockRejectedValueOnce(malformed);
  await expect(callMCPToolWithUrlElicitationRetry(options)).rejects.toBe(malformed);
  expect(effects.loads).toBe(0);

  const elicitation = { mode: "url", url: "https://example.test/approve", elicitationId: "fixture-id", message: "approve" };
  const required = new McpError(ErrorCode.UrlElicitationRequired, "required", { elicitations: [elicitation] });
  options.callToolFn.mockRejectedValueOnce(required);
  effects.request.mockResolvedValueOnce({ action: "decline" });
  const denied = await callMCPToolWithUrlElicitationRetry(options);
  expect(denied.content).toContain("declined by a hook");
  expect(effects.request).toHaveBeenLastCalledWith("fixture", elicitation, signal);
  expect(effects.loads).toBe(1);
  expect(options.setAppState).not.toHaveBeenCalled();

  options.callToolFn.mockClear();
  options.callToolFn.mockRejectedValueOnce(required);
  effects.request.mockResolvedValueOnce({ action: "accept" });
  await expect(callMCPToolWithUrlElicitationRetry(options)).resolves.toBe(plain);
  expect(options.callToolFn).toHaveBeenCalledTimes(2);

  options.callToolFn.mockClear();
  options.callToolFn.mockRejectedValueOnce(required);
  effects.result.mockResolvedValueOnce({ action: "decline" });
  const handled = { ...options, handleElicitation: vi.fn(async () => ({ action: "accept" as const })) };
  const final = await callMCPToolWithUrlElicitationRetry(handled);
  expect(final.content).toContain("declined by the user");
  expect(effects.result).toHaveBeenLastCalledWith("fixture", { action: "accept" }, signal, "url", "fixture-id");
  expect(options.callToolFn).toHaveBeenCalledTimes(1);
});
