import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHomeContext } from "../../../src/config/home.js";

const state = vi.hoisted(() => ({ loads: vi.fn(), error: new Error("MCP SDK unavailable") }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  state.loads();
  throw state.error;
});
afterEach(() => vi.restoreAllMocks());

describe("deferred MCP client loading", () => {
  it("keeps an unconfigured client surface usable and reports a configured connection failure", async () => {
    const client = await import("../../../src/services/mcp/client.js");
    const host = await import("../../../src/services/mcp/hostCapabilities.js");
    expect(state.loads).not.toHaveBeenCalled();
    expect(host.buildMcpHostClientCapabilities()).toMatchObject({ roots: {} });
    const homeContext = resolveHomeContext({ AGENC_HOME: "/tmp/agenc-sdk-load-test" }, { platformHome: "/tmp" });
    const connection = await client.connectToServer("missing-sdk", {
      type: "stdio", command: "never-spawn", scope: "local", homeContext,
    });
    expect(state.loads).toHaveBeenCalledOnce();
    expect(connection.type).toBe("failed");
    client.connectToServer.cache.clear?.();
  });
});
