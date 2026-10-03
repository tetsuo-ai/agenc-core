import { beforeAll, describe, expect, test, vi } from "vitest";

const evaluations = vi.hoisted(() => ({ axios: 0 }));
vi.mock("axios", async (original) => {
  evaluations.axios++;
  return original();
});
vi.mock("../../src/utils/sessionIngressAuth.js", () => ({
  getSessionIngressAuthToken: () => undefined,
}));

let proxy: typeof import("../../src/utils/proxy.js");
let http: typeof import("../../src/utils/http.js");
let ingress: typeof import("../../src/services/api/sessionIngress.js");
let hook: typeof import("../../src/utils/hooks/execHttpHook.js");
let mcpb: typeof import("../../src/utils/plugins/mcpbHandler.js");
let initialEvaluations: number;

beforeAll(async () => {
  [proxy, http, ingress, hook, mcpb] = await Promise.all([
    import("../../src/utils/proxy.js"),
    import("../../src/utils/http.js"),
    import("../../src/services/api/sessionIngress.js"),
    import("../../src/utils/hooks/execHttpHook.js"),
    import("../../src/utils/plugins/mcpbHandler.js"),
  ]);
  initialEvaluations = evaluations.axios;
}, 30_000);

describe.sequential("deferred axios transport", () => {
  test("imports proxy, hooks, ingress and plugin configuration without axios", () => {
    expect(initialEvaluations).toBe(0);
    expect(proxy.getProxyUrl({ HTTPS_PROXY: "http://proxy.test" })).toBe("http://proxy.test");
    expect(mcpb.isMcpbSource("example.mcpb")).toBe(true);
    vi.stubGlobal("MACRO", { VERSION: "test" });
    try {
      expect(http.getMCPUserAgent()).toContain("agenc-code/test");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(evaluations.axios).toBe(0);
  });

  test("rejects an ungranted hook without loading a transport", async () => {
    const settings = await import("../../src/utils/settings/settings.js");
    const policy = vi.spyOn(settings, "getExecutionAuthoritySettings").mockReturnValue({
      allowedHttpHookUrls: [],
    });
    try {
      await expect(hook.execHttpHook({ type: "http", url: "http://127.0.0.1:1" }, "Stop", "{}", {}))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining("HTTP hook blocked") });
      expect(evaluations.axios).toBe(0);
    } finally {
      policy.mockRestore();
    }
  });

  test("keeps unauthenticated ingress and successful request helpers transport-free", async () => {
    await expect(ingress.getSessionLogs("session", "http://127.0.0.1:1")).resolves.toBeNull();
    const { resolveSecureStorageHome } = await import("../../src/utils/secureStorage/home.js");
    await expect(http.withOAuth401Retry(resolveSecureStorageHome(), {}, async () => "ok"))
      .resolves.toBe("ok");
    expect(evaluations.axios).toBe(0);
  });

  test("loads axios only for error classification and retains the original error", async () => {
    const { resolveSecureStorageHome } = await import("../../src/utils/secureStorage/home.js");
    const error = new Error("request failed");
    await expect(http.withOAuth401Retry(resolveSecureStorageHome(), {}, async () => { throw error; }))
      .rejects.toBe(error);
    expect(evaluations.axios).toBe(1);
  });
});
