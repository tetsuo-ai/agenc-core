/** Provider-independent ImagineImage catalog and REST paths (mocked fetch). */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHomeContext } from "../../../src/config/home.js";
import { createImagineImageTool } from "../../../src/tools/system/imagine-image.js";
import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";

function testHome(workspaceRoot: string) {
  return resolveHomeContext(
    {
      AGENC_HOME: join(workspaceRoot, ".agenc-test-home"),
      HOME: workspaceRoot,
    },
    { platformHome: workspaceRoot },
  );
}

type QwenImageProduct = "qwen" | "qwen-token-plan";

function qwenJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function qwenImageResult(image: string): Response {
  return qwenJsonResponse({
    output: {
      choices: [{ message: { content: [{ image }] } }],
    },
  });
}

function createQwenImagineTool(
  product: QwenImageProduct,
  fetchImpl: typeof fetch,
  workspaceRoot = process.cwd(),
) {
  const provider = createProvider(product, {
    apiKey: product === "qwen" ? "sk-ws-session" : "sk-sp-session",
    model: "qwen3.8-max",
  });
  return createImagineImageTool({
    workspaceRoot,
    home: testHome(workspaceRoot),
    getSession: () => ({ services: { provider } }) as unknown as Session,
    env: {},
    fetchImpl,
  });
}

describe("ImagineImage tool", () => {
  it("is catalog-registered for non-Grok sessions with an independent xAI credential", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineImage")).toBe(true);
  });

  it("is catalog-registered for Meta sessions with a native image credential", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "meta",
      sessionBaseURL: "https://api.meta.ai/v1",
      env: { MODEL_API_KEY: "meta-key" },
    });
    expect(tools.some((t) => t.name === "ImagineImage")).toBe(true);
  });

  it("is catalog-registered for either isolated QwenCloud credential", () => {
    for (const env of [
      { DASHSCOPE_API_KEY: "sk-ws-test" },
      { QWEN_TOKEN_PLAN_API_KEY: "sk-sp-test" },
    ]) {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
        env,
      });
      expect(tools.some((tool) => tool.name === "ImagineImage")).toBe(true);
    }
  });

  it("is catalog-registered with an isolated Z.ai image credential", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "zai",
      env: { ZAI_API_KEY: "zai-image-key" },
    });
    expect(tools.some((tool) => tool.name === "ImagineImage")).toBe(true);
  });

  it("keeps a deferred ImagineImage across an OpenAI-to-Z.AI provider switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-zai-switch-"));
    let session: Session | null = null;
    const generatedUrl = "https://cdn.bigmodel.cn/generated/switched.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === generatedUrl
        ? new Response(Buffer.from("switched-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(JSON.stringify({ data: [{ url: generatedUrl }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const tool = createModelFacingTools({
        workspaceRoot: root,
        agencHome: join(root, ".agenc-test-home"),
        getSession: () => session,
        sessionProvider: "openai",
        env: {},
      }).find((candidate) => candidate.name === "ImagineImage");
      if (tool === undefined) throw new Error("ImagineImage was not registered");
      expect(tool.metadata?.deferred).toBe(true);

      const provider = createProvider("zai", {
        apiKey: "late-payg-key",
        model: "glm-5.3",
      });
      session = ({ services: { provider } }) as unknown as Session;
      const result = await tool.execute({ prompt: "switched session image" });

      expect(result.isError).toBeUndefined();
      const [, init] = fetchImpl.mock.calls[0] ?? [];
      expect((init?.headers as Record<string, string>).authorization)
        .toBe("Bearer late-payg-key");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("keeps Coding Plan image discovery deferred without treating its key as authority", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "zai",
      env: {
        ZAI_API_KEY: "zai-coding-plan-key",
        ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
      },
    });
    const tool = tools.find((candidate) => candidate.name === "ImagineImage");
    if (tool === undefined) throw new Error("ImagineImage was not registered");
    expect(tool.metadata?.deferred).toBe(true);
    await expect(tool.execute({ prompt: "must not use coding key" }))
      .resolves.toMatchObject({ isError: true });
  });

  it("never treats a native Coding Plan credential as image authority", () => {
    const provider = createProvider("zai-coding-plan", {
      apiKey: "coding-plan-key-must-not-be-media",
      model: "glm-5.3",
    });
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      sessionProvider: "zai-coding-plan",
      env: {
        ZAI_CODING_PLAN_API_KEY: "coding-plan-key-must-not-be-media",
      },
    });
    expect(tools.some((tool) => tool.name === "ImagineImage")).toBe(false);
  });

  it("uses only an independent PAYG key for images in a Coding Plan session", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-zai-plan-isolation-"));
    const provider = createProvider("zai-coding-plan", {
      apiKey: "coding-plan-key-must-not-leak",
      model: "glm-5.3",
    });
    const generatedUrl = "https://cdn.bigmodel.cn/generated/isolated.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === generatedUrl
        ? new Response(Buffer.from("isolated-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(JSON.stringify({ data: [{ url: generatedUrl }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        ZAI_CODING_PLAN_API_KEY: "coding-plan-key-must-not-leak",
        ZAI_API_KEY: "payg-media-key",
      },
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "isolated image" });

    expect(result.isError).toBeUndefined();
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const authorization = (init?.headers as Record<string, string>)
      .authorization;
    expect(authorization).toBe("Bearer payg-media-key");
    expect(authorization).not.toContain("coding-plan-key-must-not-leak");
  });

  it("keeps a universal schema until a late-bound Z.AI session exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-zai-late-session-"));
    let session: Session | null = null;
    const generatedUrl = "https://cdn.bigmodel.cn/generated/late.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === generatedUrl
        ? new Response(Buffer.from("late-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          })
        : new Response(JSON.stringify({ data: [{ url: generatedUrl }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => session,
      env: {},
      fetchImpl,
    });
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual([
      "prompt",
      "model",
      "n",
      "aspect_ratio",
      "resolution",
      "quality",
    ]);

    const provider = createProvider("zai", {
      apiKey: "late-payg-key",
      model: "glm-5.3",
    });
    session = ({ services: { provider } }) as unknown as Session;
    const result = await tool.execute({
      prompt: "late session image",
      quality: "standard",
    });

    expect(result.isError).toBeUndefined();
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).authorization)
      .toBe("Bearer late-payg-key");
  });

  it("advertises a Z.ai-specific schema without unsupported count or resolution", () => {
    const provider = createProvider("zai", {
      apiKey: "isolated-zai-key",
      model: "glm-5.3",
    });
    const tool = createModelFacingTools({
      workspaceRoot: process.cwd(),
      agencHome: join(process.cwd(), ".agenc-test-home"),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      sessionProvider: "zai",
      env: {},
    }).find((candidate) => candidate.name === "ImagineImage");
    if (tool === undefined) throw new Error("ImagineImage was not registered");
    const properties = tool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(tool.description).toMatch(/exactly one image/u);
    expect(Object.keys(properties)).toEqual([
      "prompt",
      "model",
      "aspect_ratio",
      "quality",
    ]);
    expect(properties.model?.enum).toEqual([
      "glm-image",
      "cogview-4-250304",
    ]);
    expect(properties.n).toBeUndefined();
    expect(properties.resolution).toBeUndefined();
    expect(properties.quality?.enum).toEqual(["hd", "standard"]);
  });

  it("keeps each non-Z.ai backend's supported controls in its schema", () => {
    const metaProvider = createProvider("meta", {
      apiKey: "meta-session-key-not-used-for-images",
      model: "muse-spark-1.3",
    });
    const metaTool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({ services: { provider: metaProvider } }) as unknown as Session,
      env: { MODEL_API_KEY: "isolated-meta-image-key" },
    });
    const metaProperties = metaTool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(metaProperties.model?.enum).toEqual(["muse-image-1.0"]);
    expect(metaProperties.n).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    expect(metaProperties.aspect_ratio).toBeDefined();
    expect(metaProperties.resolution).toBeUndefined();
    expect(metaProperties.quality).toBeUndefined();

    const fetchImpl = vi.fn<typeof fetch>();
    const qwenTool = createQwenImagineTool("qwen", fetchImpl);
    const qwenProperties = qwenTool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(qwenProperties.n).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 6,
    });
    expect(qwenProperties.resolution?.enum).toEqual(["1k", "2k"]);
    expect(qwenProperties.quality).toBeUndefined();

    const xaiProvider = createProvider("grok", {
      apiKey: "isolated-xai-key",
      model: "grok-4.6",
      baseURL: "https://api.x.ai/v1",
    });
    const xaiTool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({ services: { provider: xaiProvider } }) as unknown as Session,
      env: {},
    });
    const xaiProperties = xaiTool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(xaiProperties.n).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    expect(xaiProperties.resolution?.enum).toEqual(["1k", "2k"]);
    expect(xaiProperties.quality).toBeUndefined();
  });

  it("is catalog-registered for grok + direct xAI with BYOK or any credential probe", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "grok",
      sessionBaseURL: "https://api.x.ai/v1",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineImage")).toBe(true);
  });

  it("uses a direct Grok factory bearer when no environment key exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-factory-catalog-"));
    const provider = createProvider("grok", {
      apiKey: "factory-only-xai-key",
      model: "grok-4.6",
      baseURL: "https://api.x.ai/v1",
    });
    const tools = createModelFacingTools({
      workspaceRoot: root,
      agencHome: join(root, ".agenc-test-home"),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
    });

    expect(tools.some((t) => t.name === "ImagineImage")).toBe(true);
  });

  it("keeps an unusable non-direct xAI backend deferred and fail-closed", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      env: {
        XAI_API_KEY: "xai-key",
        XAI_BASE_URL: "https://openrouter.ai/api/v1",
      },
    });

    const tool = tools.find((candidate) => candidate.name === "ImagineImage");
    if (tool === undefined) throw new Error("ImagineImage was not registered");
    expect(tool.metadata?.deferred).toBe(true);
    await expect(tool.execute({ prompt: "must not use proxy credential" }))
      .resolves.toMatchObject({ isError: true });
  });

  it("uses independent xAI credentials for a Meta reasoning session", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-meta-xai-"));
    const provider = createProvider("meta", {
      apiKey: "meta-session-key-must-not-leak",
      model: "muse-spark-1.3",
      baseURL: "https://api.meta.ai/v1",
    });
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    })) as unknown as typeof fetch;
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: { XAI_API_KEY: "xai-media-key" },
      fetchImpl,
    });
    const result = await tool.execute({ prompt: "a cat" });
    expect(result.isError).toBeUndefined();
    const [url, init] = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.x.ai/v1/images/generations");
    const authorization = (init as { headers: { authorization: string } })
      .headers.authorization;
    expect(authorization).toBe("Bearer xai-media-key");
    expect(authorization).not.toContain("meta-session-key-must-not-leak");
  });

  it("prefers Meta Muse Image and saves its response for a Meta session", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-meta-native-"));
    const provider = createProvider("meta", {
      apiKey: "meta-session-key-must-not-be-used",
      model: "muse-spark-1.3",
      baseURL: "https://session-meta.invalid/v1",
    });
    const b64 = Buffer.from("RIFF0000WEBP", "ascii").toString("base64");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    })) as unknown as typeof fetch;
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        MODEL_API_KEY: "canonical-meta-image-key",
        XAI_API_KEY: "unused-xai-key",
      },
      fetchImpl,
    });

    const result = await tool.execute({
      prompt: "portrait on a quiet street",
      aspect_ratio: "9:16",
      n: 1,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      model: string;
      path: string;
    };
    expect(parsed.backend).toBe("meta");
    expect(parsed.model).toBe("muse-image-1.0");
    expect(parsed.path).toMatch(/\.webp$/u);
    expect((await readFile(parsed.path)).length).toBeGreaterThan(0);

    const [url, init] = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.meta.ai/v1/images/generations");
    expect(
      (init as { headers: { authorization: string } }).headers.authorization,
    ).toBe("Bearer canonical-meta-image-key");
    const body = JSON.parse((init as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      model: "muse-image-1.0",
      prompt: "portrait on a quiet street",
      size: "1024x1536",
      n: 1,
    });
  });

  it("uses Z.ai GLM-Image synchronously with its own key and trusted URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-zai-native-"));
    const provider = createProvider("zai", {
      apiKey: "isolated-zai-key",
      model: "glm-5.3",
    });
    const generatedUrl = "https://cdn.bigmodel.cn/generated/glm-image.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === generatedUrl) {
        return new Response(Buffer.from("zai-png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(JSON.stringify({ data: [{ url: generatedUrl }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        ZAI_API_KEY: "isolated-zai-key",
        XAI_API_KEY: "must-not-win-for-zai-session",
      },
      fetchImpl,
    });

    const result = await tool.execute({
      prompt: "a precise scientific frog diagram",
      aspect_ratio: "16:9",
      quality: "standard",
      n: 1,
    });

    expect(tool.admissionEstimate?.({ prompt: "one" }).maxCostUsd).toBe(0.015);
    expect(
      tool.admissionEstimate?.({
        prompt: "one",
        model: "cogview-4-250304",
      }).maxCostUsd,
    ).toBe(0.01);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      model: string;
      path: string;
      n: number;
    };
    expect(parsed).toMatchObject({
      backend: "zai",
      model: "glm-image",
      n: 1,
    });
    expect(parsed.path).toMatch(/\.png$/u);
    expect(await readFile(parsed.path, "utf8")).toBe("zai-png");

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.z.ai/api/paas/v4/images/generations",
    );
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer isolated-zai-key",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "glm-image",
      prompt: "a precise scientific frog diagram",
      size: "1728x960",
      quality: "standard",
    });
  });

  it("honors ZAI_BASE_URL without borrowing another provider session key", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-zai-fallback-"));
    const provider = createProvider("openai", {
      apiKey: "openai-key-must-not-leak",
      model: "gpt-5",
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/images/generations")
        ? new Response(JSON.stringify({
            data: [{ url: "https://sfile.chatglm.cn/generated/cogview.png" }],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(Buffer.from("cogview-webp"), {
            status: 200,
            headers: { "content-type": "image/webp" },
          }));
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        ZAI_API_KEY: "zai-only-media-key",
        ZAI_BASE_URL: "https://zai-proxy.example/api/paas/v4/",
      },
      fetchImpl,
    });

    const result = await tool.execute({
      prompt: "a safe fallback",
      model: "cogview-4-250304",
      aspect_ratio: "3:4",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { path: string };
    expect(parsed.path).toMatch(/\.webp$/u);
    expect(await readFile(parsed.path, "utf8")).toBe("cogview-webp");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://zai-proxy.example/api/paas/v4/images/generations",
    );
    const authorization = (init?.headers as Record<string, string>)
      .authorization;
    expect(authorization).toBe("Bearer zai-only-media-key");
    expect(authorization).not.toContain("openai-key-must-not-leak");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "cogview-4-250304",
      size: "864x1152",
      quality: "standard",
    });
  });

  it("rejects unsupported Z.ai image requests and untrusted result hosts", async () => {
    const provider = createProvider("zai", {
      apiKey: "isolated-zai-key",
      model: "glm-5.3",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ url: "https://attacker.example/generated.png" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const invalidModel = await tool.execute({
      prompt: "must not send",
      model: "grok-imagine-image",
    });
    expect(invalidModel.isError).toBe(true);
    expect(invalidModel.content).toMatch(/glm-image.*cogview-4-250304/u);
    expect(fetchImpl).not.toHaveBeenCalled();

    const invalidCount = await tool.execute({ prompt: "must not send", n: 2 });
    expect(invalidCount.isError).toBe(true);
    expect(invalidCount.content).toMatch(/exactly one image/u);
    expect(fetchImpl).not.toHaveBeenCalled();

    const invalidResolution = await tool.execute({
      prompt: "must not send",
      resolution: "2k",
    });
    expect(invalidResolution.isError).toBe(true);
    expect(invalidResolution.content).toMatch(/selected by aspect_ratio/u);
    expect(fetchImpl).not.toHaveBeenCalled();

    const untrusted = await tool.execute({ prompt: "host validation" });
    expect(untrusted.isError).toBe(true);
    expect(untrusted.content).toMatch(/not trusted for the zai backend/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when Z.ai unexpectedly returns more than one image", async () => {
    const provider = createProvider("zai", {
      apiKey: "isolated-zai-key",
      model: "glm-5.3",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { url: "https://cdn.bigmodel.cn/generated/first.png" },
          { url: "https://cdn.bigmodel.cn/generated/second.png" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "one image only" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/must return exactly one image/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses Qwen Image's synchronous PayGo endpoint and downloads immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-qwen-paygo-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (
        String(url) ===
        "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/qwen.png"
      ) {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return qwenImageResult(
        "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/qwen.png",
      );
    });
    const tool = createQwenImagineTool("qwen", fetchImpl, root);

    const result = await tool.execute({
      prompt: "a production-ready spaceship",
      model: "qwen-image-3.0-pro",
      aspect_ratio: "16:9",
      resolution: "2k",
      n: 9,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      path: string;
    };
    expect(parsed.backend).toBe("qwen");
    expect(parsed.path).toMatch(/\.png$/u);
    expect(await readFile(parsed.path, "utf8")).toBe("png");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-ws-session",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen-image-3.0-pro",
      input: {
        messages: [
          {
            role: "user",
            content: [{ text: "a production-ready spaceship" }],
          },
        ],
      },
      parameters: {
        prompt_extend: true,
        n: 6,
        size: "2720*1536",
      },
    });

    const portrait = await tool.execute({
      prompt: "a portrait-oriented spaceship",
      model: "qwen-image-3.0-pro",
      aspect_ratio: "9:16",
      resolution: "2k",
    });
    expect(portrait.isError).toBeUndefined();
    const portraitRequest = JSON.parse(
      String(fetchImpl.mock.calls[2]?.[1]?.body),
    ) as { parameters: { size: string } };
    expect(portraitRequest.parameters.size).toBe("1536*2720");
  });

  it("rejects an unverified Qwen Image model on Token Plan", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tool = createQwenImagineTool("qwen-token-plan", fetchImpl);

    const result = await tool.execute({
      prompt: "must not be sent",
      model: "qwen-image-3.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/qwen-image-3\.0-pro.*wan2\.7/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a signed-image redirect that leaves trusted HTTPS hosts", async () => {
    const signed =
      "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/image.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/multimodal-generation/generation")
        ? qwenImageResult(signed)
        : new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/internal" },
          }));
    const tool = createQwenImagineTool("qwen", fetchImpl);

    const result = await tool.execute({ prompt: "safe redirect handling" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/credential-free HTTPS/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized signed images before buffering the response", async () => {
    const signed =
      "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/large.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/multimodal-generation/generation")
        ? qwenImageResult(signed)
        : new Response("not buffered", {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(20 * 1024 * 1024 + 1),
            },
          }));
    const tool = createQwenImagineTool("qwen", fetchImpl);

    const result = await tool.execute({ prompt: "bounded download" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/20 MiB limit/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("runs and polls a Token Plan Wan 2.7 image task with its native schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-qwen-token-plan-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/api/v1/services/aigc/image-generation/generation")) {
        return qwenJsonResponse({
          output: { task_id: "task-123", task_status: "PENDING" },
        });
      }
      if (value.endsWith("/api/v1/tasks/task-123")) {
        return qwenJsonResponse({
          output: {
            task_id: "task-123",
            task_status: "SUCCEEDED",
            results: [
              {
                url: "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/wan.png",
              },
            ],
          },
        });
      }
      if (
        value ===
        "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/wan.png"
      ) {
        return new Response(Buffer.from("wan-png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const tool = createQwenImagineTool("qwen-token-plan", fetchImpl, root);

    const result = await tool.execute({
      prompt: "a detailed frog meme",
      model: "wan2.7-image-pro",
      resolution: "2k",
      n: 8,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      path: string;
    };
    expect(parsed.backend).toBe("qwen-token-plan");
    expect(await readFile(parsed.path, "utf8")).toBe("wan-png");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [createUrl, createInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(createUrl)).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
    );
    expect(
      (createInit?.headers as Record<string, string>)["x-dashscope-async"],
    ).toBe("enable");
    expect(JSON.parse(String(createInit?.body))).toEqual({
      model: "wan2.7-image-pro",
      input: {
        messages: [
          { role: "user", content: [{ text: "a detailed frog meme" }] },
        ],
      },
      parameters: {
        n: 4,
        size: "2048*2048",
        enable_sequential: false,
        watermark: false,
        thinking_mode: true,
      },
    });
  });

  it("fails a terminal UNKNOWN Token Plan image task instead of polling forever", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      qwenJsonResponse(
        String(url).includes("/api/v1/tasks/")
          ? {
              output: {
                task_status: "UNKNOWN",
                code: "InvalidTask",
                message: "task disappeared",
              },
            }
          : { output: { task_id: "missing", task_status: "PENDING" } },
      ));
    const tool = createQwenImagineTool("qwen-token-plan", fetchImpl);

    const result = await tool.execute({ prompt: "will fail" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/task disappeared/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to Meta when the configured xAI media host is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-invalid-xai-meta-"));
    const provider = createProvider("openai", {
      apiKey: "openai-session-key-must-not-leak",
      model: "gpt-5",
    });
    const b64 = Buffer.from("RIFF0000WEBP", "ascii").toString("base64");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    })) as unknown as typeof fetch;
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        XAI_API_KEY: "xai-key-for-invalid-host",
        XAI_BASE_URL: "https://openrouter.ai/api/v1",
        MODEL_API_KEY: "meta-media-key",
      },
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "safe backend fallback" });

    expect(result.isError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] ?? [];
    expect(url).toBe("https://api.meta.ai/v1/images/generations");
    expect(
      (init as { headers: { authorization: string } }).headers.authorization,
    ).toBe("Bearer meta-media-key");
  });

  it("does not save an error response returned by an image URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-download-error-"));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://scontent.example.fbcdn.net/generated.webp") {
        return {
          ok: false,
          status: 502,
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ url: "https://scontent.example.fbcdn.net/generated.webp" }],
        }),
      };
    }) as unknown as typeof fetch;
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => null,
      env: { MODEL_API_KEY: "meta-media-key" },
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "download failure" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Image download HTTP 502/u);
  });

  it("fails closed instead of using a non-Grok reasoning session key for xAI", async () => {
    const provider = createProvider("openai", {
      apiKey: "openai-session-key-must-not-leak",
      model: "gpt-5",
      baseURL: "https://api.openai.com/v1",
    });
    const fetchImpl = vi.fn();
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool.execute({ prompt: "must not run" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/media backend credential/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts session OAuth bearer when BYOK env is unset (subscription path)", async () => {
    // Session provider already holds /grok-login bearer as factory apiKey —
    // same as Grok Build subscription users without a metered XAI_API_KEY.
    const root = await mkdtemp(join(tmpdir(), "imagine-oauth-"));
    const provider = createProvider("grok", {
      apiKey: "oauth-subscription-bearer",
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
    });
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    })) as unknown as typeof fetch;

    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({ services: { provider } }) as unknown as Session,
      env: {}, // no BYOK
      fetchImpl,
    });
    const result = await tool.execute({ prompt: "a cat" });
    expect(result.isError).toBeUndefined();
    const auth = (
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[1] as { headers: { authorization: string } }
    ).headers.authorization;
    expect(auth).toBe("Bearer oauth-subscription-bearer");
  });

  it("calls /images/generations and saves b64 image under workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-"));
    const provider = createProvider("grok", {
      apiKey: "unused",
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
    });
    // 1x1 jpeg-ish base64
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    })) as unknown as typeof fetch;

    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({ services: { provider } }) as unknown as Session,
      env: { XAI_API_KEY: "real-byok-key" },
      fetchImpl,
    });
    const result = await tool.execute({
      prompt: "starship on pad",
      aspect_ratio: "16:9",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      path: string;
      paths: string[];
    };
    expect(parsed.path).toMatch(/\.agenc\/imagine\/imagine-/);
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalled();
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(String(call[0])).toMatch(/\/images\/generations$/);
    const body = JSON.parse(
      (call[1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.prompt).toBe("starship on pad");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.response_format).toBe("b64_json");
  });

  it("aborts the in-flight xAI request from the admitted tool signal", async () => {
    const provider = createProvider("grok", {
      apiKey: "session-key",
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
    });
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });
    const admittedAbort = new AbortController();
    const reason = new Error("kernel cancelled image generation");

    const running = tool.execute({
      prompt: "a cancelled image",
      __abortSignal: admittedAbort.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    admittedAbort.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });
});
