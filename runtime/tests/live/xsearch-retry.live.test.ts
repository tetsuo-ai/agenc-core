import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  readXaiOauthAccessToken,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
  readXaiOauthCredentials,
} from "../../src/utils/xaiOauthCredentials.js";
import { runXaiBrowserLogin } from "../../src/services/xai/oauth.js";
import { createProvider } from "../../src/llm/provider.js";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import type { Session } from "../../src/session/session.js";

async function ensureOauth(): Promise<string> {
  const existing = readXaiOauthAccessToken();
  if (existing) return existing;
  console.log("Opening browser for OAuth…");
  const login = await runXaiBrowserLogin({
    timeoutMs: 10 * 60 * 1000,
    onAuthorizeUrl: async (url) => {
      console.log(url);
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    },
  });
  const blob = xaiOauthTokensToBlob(login.tokens, {
    tokenEndpoint: login.tokenEndpoint,
    accountLabel: login.identity.email ?? login.identity.sub,
  });
  saveXaiOauthCredentials(blob);
  const tok = readXaiOauthAccessToken();
  if (!tok) throw new Error("no token after login");
  return tok;
}

describe("LIVE XSearch retry longer timeout", () => {
  it("completes without 120s timeout", { timeout: 360_000 }, async () => {
    const bearer = await ensureOauth();
    console.log("account", readXaiOauthCredentials()?.accountLabel, "len", bearer.length);
    const provider = createProvider("grok", {
      apiKey: bearer,
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
      tools: [],
      extra: { xSearch: true },
      timeoutMs: 300_000,
    });
    const tools = createModelFacingTools({
      workspaceRoot: "/tmp/user/1000/grok-goal-00e3234b1d7c/implementer/e2e-full",
      getSession: () =>
        ({ services: { provider } }) as unknown as Session,
      sessionProvider: "grok",
      sessionBaseURL: "https://api.x.ai/v1",
      env: {},
      llmXai: { x_search: true },
    });
    const xsearch = tools.find((t) => t.name === "XSearch")!;
    expect(xsearch).toBeDefined();
    const result = await xsearch.execute({ query: "Grok AI" });
    console.log("XSearch", result.isError, result.content.slice(0, 800));
    expect(result.isError).not.toBe(true);
    expect(result.content).toMatch(/grok_x_search|x\.com|answer|results/i);
  });
});
