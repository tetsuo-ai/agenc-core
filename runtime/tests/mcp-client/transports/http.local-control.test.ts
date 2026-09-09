import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpMCPConnection } from "./http.js";

const observed = vi.hoisted(() => ({ options: undefined as unknown, proxy: vi.fn(() => ({ dispatcher: "direct-dispatcher" })) }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {
  constructor(_url: URL, options: unknown) { observed.options = options; }
} }));
vi.mock("./connect-with-cleanup.js", () => ({ connectMCPClientWithCleanup: async () => {} }));
vi.mock("../../elicitation/mcp.js", () => ({ configureMcpElicitationClient: async () => {} }));
vi.mock("../../services/mcp/hostCapabilities.js", () => ({ buildMcpHostClientCapabilities: () => ({}), configureMcpHostRequestHandlers: () => {} }));
vi.mock("../../utils/proxy.js", () => ({ getProxyFetchOptions: observed.proxy }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("private HTTP MCP transport", () => {
  it("uses an explicitly direct environment, rejects redirects and refuses alternate endpoints", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const endpoint = "http://127.0.0.1:43118/mcp";
    const headers = { Authorization: `Bearer ${"a".repeat(48)}` };
    await createHttpMCPConnection({ name: "agenc-desktop-control", endpoint, headers, localOnly: true }, undefined, undefined, undefined, { HTTP_PROXY: "http://proxy.example:80", NODE_EXTRA_CA_CERTS: "/private/credential.pem" });
    expect(observed.proxy).toHaveBeenCalledWith({ environment: {} });
    const options = observed.options as { requestInit: Record<string, unknown>; fetch: (input: string | Request, init?: RequestInit) => Promise<Response> };
    expect(options.requestInit).toEqual({ dispatcher: "direct-dispatcher", headers });
    await options.fetch(endpoint, { headers });
    expect(fetch).toHaveBeenCalledWith(endpoint, { headers, redirect: "error", dispatcher: "direct-dispatcher" });
    await expect(options.fetch("https://elsewhere.example/mcp")).rejects.toThrow("Local MCP endpoint changed");
    await expect(options.fetch(`${endpoint}?token=secret`)).rejects.toThrow("Local MCP endpoint changed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps ordinary HTTP MCP proxy and authentication behavior unchanged", async () => {
    const environment = { HTTPS_PROXY: "http://proxy.example:80" };
    await createHttpMCPConnection({ name: "ordinary", endpoint: "https://service.example/mcp", headers: { Authorization: "Bearer ordinary" } }, undefined, undefined, undefined, environment);
    expect(observed.proxy).toHaveBeenCalledWith({ environment });
    expect((observed.options as Record<string, unknown>).fetch).toBeUndefined();
  });
});
