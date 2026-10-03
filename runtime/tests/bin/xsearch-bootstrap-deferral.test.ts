import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const credential = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("../../src/llm/xai-capability-config.js", async (original) => ({
  ...await original<typeof import("../../src/llm/xai-capability-config.js")>(),
  tryResolveXaiBearerTokenForBaseUrl: credential,
}));
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { createProvider } from "../../src/llm/provider.js";
import type { Session } from "../../src/session/session.js";

describe("bootstrap XSearch credentials", () => {
  const homes: string[] = [];
  function options() {
    const root = mkdtempSync(join(tmpdir(), "agenc-xsearch-bootstrap-"));
    homes.push(root);
    return { workspaceRoot: root, agencHome: root, getSession: (): Session | null => null, env: {} };
  }
  afterEach(() => {
    credential.mockClear();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("registers a deferred tool without reading native credentials", () => {
    const tool = createModelFacingTools(options()).find(t => t.name === "XSearch");
    expect(tool?.metadata?.deferred).toBe(true);
    expect(credential).not.toHaveBeenCalled();
  });

  it("does not register or resolve an explicitly disabled tool", () => {
    const tools = createModelFacingTools({ ...options(), grokCapabilities: { x_search: false } });
    expect(tools.some(t => t.name === "XSearch")).toBe(false);
    expect(credential).not.toHaveBeenCalled();
  });

  it("resolves the attached provider at execution and refuses absent credentials before transport", async () => {
    const opts = options();
    let session: Session | null = null;
    const tool = createModelFacingTools({ ...opts, getSession: () => session }).find(t => t.name === "XSearch")!;
    const provider = createProvider("deepseek", { apiKey: "reasoning-key", model: "deepseek-chat" });
    session = { services: { provider } } as unknown as Session;
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await tool.execute({ query: "current news" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("independent xAI backend");
    expect(credential).toHaveBeenCalledOnce();
    expect(credential.mock.calls[0]).not.toContain("reasoning-key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains backend-based availability when a session is already attached", () => {
    const opts = options();
    const provider = createProvider("deepseek", { apiKey: "reasoning-key", model: "deepseek-chat" });
    const tools = createModelFacingTools({ ...opts, getSession: () => ({ services: { provider } }) as unknown as Session });
    expect(tools.some(t => t.name === "XSearch")).toBe(false);
    expect(credential).toHaveBeenCalled();
  });
});
