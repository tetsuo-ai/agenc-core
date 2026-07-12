/**
 * LIVE full-surface e2e for Grok parity (real xAI API).
 *
 * Requires stored `/grok-login` OAuth (or will open browser once).
 *
 *   npm --workspace=@tetsuo-ai/runtime exec vitest run \
 *     tests/live/grok-full-surface-e2e.live.test.ts
 *
 * Artifacts + log:
 *   /tmp/user/1000/grok-goal-00e3234b1d7c/implementer/e2e-full/
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  readXaiOauthAccessToken,
  readXaiOauthCredentials,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
} from "../../src/utils/xaiOauthCredentials.js";
import { runXaiBrowserLogin } from "../../src/services/xai/oauth.js";
import {
  getProviderNativeToolDefinitions,
  isGrokMultiAgentModel,
  supportsGrokServerSideTools,
} from "../../src/llm/provider-native-search.js";
import {
  hasXaiCredentials,
  resolveGrokProviderApiKey,
  resolveXaiBearerToken,
  resolveXaiCapabilityExtra,
  resolveXaiLiveWebSearchOptions,
  isDirectXaiInferenceHost,
} from "../../src/llm/xai-capability-config.js";
import { createProvider } from "../../src/llm/provider.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { createImagineImageTool } from "../../src/tools/system/imagine-image.js";
import { createImagineVideoTool } from "../../src/tools/system/imagine-video.js";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import type { Session } from "../../src/session/session.js";
import type { LLMTool } from "../../src/llm/types.js";

const SCRATCH = "/tmp/user/1000/grok-goal-00e3234b1d7c/implementer";
const OUT = join(SCRATCH, "e2e-full");
const LOG = join(SCRATCH, "e2e-full-surface.log");

const DUMMY_CLIENT_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

async function log(line: string): Promise<void> {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(msg);
  await mkdir(SCRATCH, { recursive: true });
  await writeFile(LOG, msg, { flag: "a" });
}

function openBrowser(url: string): void {
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function ensureOauth(): Promise<string> {
  const existing = readXaiOauthAccessToken();
  if (existing) {
    const blob = readXaiOauthCredentials();
    await log(
      `OAuth present account=${blob?.accountLabel ?? "?"} tokenLen=${existing.length}`,
    );
    return existing;
  }
  await log("No OAuth — opening browser for /grok-login…");
  const login = await runXaiBrowserLogin({
    timeoutMs: 10 * 60 * 1000,
    onAuthorizeUrl: async (url) => {
      await log(`Authorize URL:\n${url}`);
      openBrowser(url);
    },
  });
  const blob = xaiOauthTokensToBlob(login.tokens, {
    tokenEndpoint: login.tokenEndpoint,
    accountLabel: login.identity.email ?? login.identity.sub,
  });
  const saved = saveXaiOauthCredentials(blob);
  if (!saved.success) {
    throw new Error(`store failed: ${saved.warning}`);
  }
  const tok = readXaiOauthAccessToken();
  if (!tok) throw new Error("login ok but no token readable");
  await log(`Login saved account=${blob.accountLabel} len=${tok.length}`);
  return tok;
}

function sessionWith(provider: unknown): Session {
  return { services: { provider } } as unknown as Session;
}

describe("LIVE full Grok surface e2e", () => {
  let bearer = "";

  beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
    await writeFile(LOG, "");
    bearer = await ensureOauth();
  }, 12 * 60 * 1000);

  it("P0 gates: multi-agent, empty model, non-grok, host allowlist", async () => {
    expect(isGrokMultiAgentModel("grok-4.20-multi-agent-0309")).toBe(true);
    expect(supportsGrokServerSideTools(undefined)).toBe(false);
    expect(supportsGrokServerSideTools("")).toBe(false);
    expect(supportsGrokServerSideTools("grok-4.5")).toBe(true);
    expect(isDirectXaiInferenceHost("https://api.x.ai/v1")).toBe(true);
    expect(isDirectXaiInferenceHost("https://openrouter.ai/api/v1")).toBe(
      false,
    );

    const openAiDefs = getProviderNativeToolDefinitions({
      provider: "openai",
      model: "gpt-4o",
      webSearch: true,
      xSearch: true,
      codeExecution: true,
    });
    expect(openAiDefs).toEqual([]);
    await log("P0 static gates OK");
  });

  it("OAuth always wins over env BYOK", async () => {
    expect(hasXaiCredentials({ XAI_API_KEY: "dead-key" })).toBe(true);
    const resolved = resolveGrokProviderApiKey("dead-byok-key", {
      XAI_API_KEY: "dead-byok-key",
    });
    expect(resolved).toBe(bearer);
    expect(resolved).not.toBe("dead-byok-key");
    const rest = resolveXaiBearerToken(
      { XAI_API_KEY: "dead-byok-key" },
      "session-ignored-when-oauth",
    );
    expect(rest).toBe(bearer);
    await log("OAuth-wins-over-BYOK OK");
  });

  it("catalog: non-Grok has no Imagine/XSearch; Grok has full media + XSearch", async () => {
    const openaiTools = createModelFacingTools({
      workspaceRoot: OUT,
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "should-not-matter" },
      llmXai: {
        x_search: true,
        web_search: true,
      },
    });
    const openaiNames = openaiTools.map((t) => t.name);
    expect(openaiNames).not.toContain("ImagineImage");
    expect(openaiNames).not.toContain("ImagineVideo");
    expect(openaiNames).not.toContain("XSearch");
    // WebSearch remains generic
    expect(openaiNames).toContain("WebSearch");

    const grokTools = createModelFacingTools({
      workspaceRoot: OUT,
      getSession: () => null,
      sessionProvider: "grok",
      sessionBaseURL: "https://api.x.ai/v1",
      // no env BYOK — OAuth credentials present via storage
      env: {},
      llmXai: {
        x_search: true,
        web_search: true,
      },
    });
    const grokNames = grokTools.map((t) => t.name);
    expect(grokNames).toContain("ImagineImage");
    expect(grokNames).toContain("ImagineVideo");
    expect(grokNames).toContain("XSearch");
    expect(grokNames).toContain("WebSearch");
    await log(
      `catalog openai=${openaiNames.filter((n) => n.startsWith("Imagine") || n === "XSearch").join(",") || "none"} grok media+XSearch present`,
    );
  });

  it(
    "chat: simple Grok turn with OAuth (no tools)",
    { timeout: 120_000 },
    async () => {
      const provider = createProvider("grok", {
        apiKey: "should-be-ignored-dead-key",
        model: "grok-4.5",
        baseURL: "https://api.x.ai/v1",
      });
      const response = await provider.chat(
        [
          {
            role: "user",
            content: "Reply with exactly: E2E_OK",
          },
        ],
        {
          maxOutputTokens: 64,
          temperature: 0,
        },
      );
      await log(
        `chat finish=${response.finishReason} content=${JSON.stringify(response.content.slice(0, 200))}`,
      );
      expect(response.finishReason).not.toBe("error");
      expect(response.content.toUpperCase()).toContain("E2E_OK");
    },
  );

  it(
    "multi-agent: zero client function tools on wire",
    { timeout: 30_000 },
    async () => {
      const multi = new GrokProvider({
        apiKey: bearer,
        model: "grok-4.20-multi-agent-0309",
        tools: [DUMMY_CLIENT_TOOL],
        webSearch: true,
        codeExecution: true,
        baseURL: "https://api.x.ai/v1",
      });
      const plan = (
        multi as unknown as {
          buildRequestPlan: (m: unknown[]) => {
            params: { tools?: readonly Record<string, unknown>[] };
          };
        }
      ).buildRequestPlan([{ role: "user", content: "hi" }]);
      const tools = plan.params.tools ?? [];
      const fn = tools.filter((t) => t.type === "function");
      expect(fn).toEqual([]);
      expect(tools.some((t) => t.type === "web_search" || t.type === "code_interpreter")).toBe(
        true,
      );
      await log(
        `multi-agent tools=${tools.map((t) => t.type).join(",")} fnCount=0`,
      );
    },
  );

  it(
    "server tools: web_search + code_interpreter one-shot on Responses",
    { timeout: 180_000 },
    async () => {
      const liveOpts = resolveXaiLiveWebSearchOptions({});
      expect(liveOpts?.enableImageSearch).toBe(true);

      const provider = new GrokProvider({
        apiKey: bearer,
        model: "grok-4.5",
        tools: [],
        webSearch: true,
        codeExecution: true,
        webSearchOptions: {
          enableImageSearch: true,
        },
        baseURL: "https://api.x.ai/v1",
      });

      // Verify wire shape first
      const plan = (
        provider as unknown as {
          buildRequestPlan: (m: unknown[]) => {
            params: { tools?: readonly Record<string, unknown>[] };
          };
        }
      ).buildRequestPlan([{ role: "user", content: "search" }]);
      const types = (plan.params.tools ?? []).map((t) => t.type);
      expect(types).toContain("web_search");
      expect(types).toContain("code_interpreter");
      const web = (plan.params.tools ?? []).find((t) => t.type === "web_search");
      expect(web).toMatchObject({ enable_image_search: true });

      const response = await provider.chat(
        [
          {
            role: "user",
            content:
              "Use web_search if needed. What is the capital of France? One short sentence.",
          },
        ],
        {
          maxOutputTokens: 256,
          tools: [],
          toolRouting: { allowedToolNames: ["web_search", "code_interpreter"] },
        },
      );
      await log(
        `web/code chat finish=${response.finishReason} content=${JSON.stringify(response.content.slice(0, 300))}`,
      );
      expect(response.finishReason).not.toBe("error");
      expect(response.content.toLowerCase()).toMatch(/paris/);
    },
  );

  it(
    "LIVE XSearch with OAuth",
    { timeout: 180_000 },
    async () => {
      const provider = createProvider("grok", {
        apiKey: bearer,
        model: "grok-4.5",
        baseURL: "https://api.x.ai/v1",
        tools: [],
        extra: { xSearch: true },
      });
      const tools = createModelFacingTools({
        workspaceRoot: OUT,
        getSession: () => sessionWith(provider),
        sessionProvider: "grok",
        sessionBaseURL: "https://api.x.ai/v1",
        env: {},
        llmXai: { x_search: true },
      });
      const xsearch = tools.find((t) => t.name === "XSearch");
      expect(xsearch).toBeDefined();
      const result = await xsearch!.execute({
        query: "xAI Grok from:xai",
      });
      await log(
        `XSearch isError=${result.isError ?? false} content=${result.content.slice(0, 500)}`,
      );
      // Soft: if rate-limited still report; hard fail only on gate/auth errors
      if (result.isError) {
        expect(result.content).not.toMatch(/only available when the session provider is grok/i);
        expect(result.content).not.toMatch(/disabled/i);
        expect(result.content).not.toMatch(/needs xAI credentials/i);
        await log(`XSearch soft-fail (upstream): ${result.content.slice(0, 200)}`);
      } else {
        expect(result.content).toMatch(/grok_x_search|x\.com|results|answer/i);
      }
    },
  );

  it(
    "ImagineImage live",
    { timeout: 180_000 },
    async () => {
      const provider = createProvider("grok", {
        apiKey: bearer,
        model: "grok-4.5",
        baseURL: "https://api.x.ai/v1",
      });
      const tool = createImagineImageTool({
        workspaceRoot: OUT,
        getSession: () => sessionWith(provider),
        env: {},
      });
      const result = await tool.execute({
        prompt: "A simple solid blue square on white background, no text",
        n: 1,
        aspect_ratio: "1:1",
      });
      await log(
        `ImagineImage isError=${result.isError ?? false} ${result.content.slice(0, 400)}`,
      );
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content) as { path?: string };
      expect(parsed.path).toBeTruthy();
      const st = await stat(parsed.path!);
      expect(st.size).toBeGreaterThan(500);
      await log(`ImagineImage saved ${parsed.path} (${st.size} bytes)`);
    },
  );

  it(
    "ImagineVideo live (short 480p)",
    { timeout: 10 * 60 * 1000 },
    async () => {
      const provider = createProvider("grok", {
        apiKey: bearer,
        model: "grok-4.5",
        baseURL: "https://api.x.ai/v1",
      });
      const tool = createImagineVideoTool({
        workspaceRoot: OUT,
        getSession: () => sessionWith(provider),
        env: {},
        pollIntervalMs: 5_000,
        pollTimeoutMs: 8 * 60 * 1000,
      });
      const result = await tool.execute({
        prompt: "A yellow ball rolling left to right on a gray floor, simple, no text",
        duration: 5,
        aspect_ratio: "16:9",
        resolution: "480p",
        model: "grok-imagine-video",
      });
      await log(
        `ImagineVideo isError=${result.isError ?? false} ${result.content.slice(0, 500)}`,
      );
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content) as {
        path?: string;
        request_id?: string;
      };
      expect(parsed.path).toBeTruthy();
      const st = await stat(parsed.path!);
      expect(st.size).toBeGreaterThan(1000);
      await log(
        `ImagineVideo saved ${parsed.path} (${st.size} bytes) id=${parsed.request_id}`,
      );
    },
  );

  it("capability extra defaults enable code_execution continuous", async () => {
    const extra = resolveXaiCapabilityExtra({
      provider: "grok",
      baseURL: "https://api.x.ai/v1",
      llmXai: undefined,
    });
    expect(extra.codeExecution).toBe(true);
    expect(extra.webSearch).toBeUndefined(); // Pattern A
    expect(extra.xSearch).toBeUndefined();
    await log("capability defaults OK (code on, search Pattern A)");
  });

  it("writes summary matrix", async () => {
    const summary = {
      at: new Date().toISOString(),
      account: readXaiOauthCredentials()?.accountLabel ?? null,
      oauthTokenLen: readXaiOauthAccessToken()?.length ?? 0,
      outDir: OUT,
      log: LOG,
    };
    await writeFile(
      join(OUT, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    await log(`SUMMARY ${JSON.stringify(summary)}`);
  });
});
