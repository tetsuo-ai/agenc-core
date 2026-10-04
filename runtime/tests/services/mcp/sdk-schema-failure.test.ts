import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ error: new Error("MCP schemas unavailable"), load: vi.fn() }));
vi.mock("../../../src/services/mcp/sdk-schema.js", () => ({
  loadMcpTypes: () => { state.load(); throw state.error; },
}));

describe("deferred MCP schema failure", () => {
  it("does not register unvalidated host handlers when schemas cannot load", async () => {
    const host = await import("../../../src/services/mcp/hostCapabilities.js");
    expect(state.load).not.toHaveBeenCalled();
    const setRequestHandler = vi.fn();
    expect(() => host.configureMcpHostRequestHandlers({ setRequestHandler } as never, "server", "/tmp")).toThrow(state.error);
    expect(setRequestHandler).not.toHaveBeenCalled();
  });
});
