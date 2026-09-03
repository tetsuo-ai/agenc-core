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

  it("does not advertise an unusable non-direct xAI media backend", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      env: {
        XAI_API_KEY: "xai-key",
        XAI_BASE_URL: "https://openrouter.ai/api/v1",
      },
    });

    expect(tools.some((t) => t.name === "ImagineImage")).toBe(false);
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

  it("uses Qwen Image's synchronous PayGo endpoint and downloads immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-qwen-paygo-"));
    const provider = createProvider("qwen", {
      apiKey: "sk-ws-session",
      model: "qwen3.8-max",
    });
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
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                message: {
                  content: [
                    {
                      image:
                        "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/qwen.png",
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

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
    const provider = createProvider("qwen-token-plan", {
      apiKey: "sk-sp-session",
      model: "qwen3.8-max",
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const result = await tool.execute({
      prompt: "must not be sent",
      model: "qwen-image-3.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/qwen-image-3\.0-pro.*wan2\.7/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a signed-image redirect that leaves trusted HTTPS hosts", async () => {
    const provider = createProvider("qwen", {
      apiKey: "sk-ws-session",
      model: "qwen3.8-max",
    });
    const signed =
      "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/image.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/multimodal-generation/generation")
        ? new Response(
            JSON.stringify({
              output: {
                choices: [{ message: { content: [{ image: signed }] } }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/internal" },
          }));
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "safe redirect handling" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/credential-free HTTPS/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized signed images before buffering the response", async () => {
    const provider = createProvider("qwen", {
      apiKey: "sk-ws-session",
      model: "qwen3.8-max",
    });
    const signed =
      "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/large.png";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/multimodal-generation/generation")
        ? new Response(
            JSON.stringify({
              output: {
                choices: [{ message: { content: [{ image: signed }] } }],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("not buffered", {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(20 * 1024 * 1024 + 1),
            },
          }));
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "bounded download" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/20 MiB limit/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("runs and polls a Token Plan Wan 2.7 image task with its native schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-qwen-token-plan-"));
    const provider = createProvider("qwen-token-plan", {
      apiKey: "sk-sp-session",
      model: "qwen3.8-max",
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/api/v1/services/aigc/image-generation/generation")) {
        return new Response(
          JSON.stringify({
            output: { task_id: "task-123", task_status: "PENDING" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value.endsWith("/api/v1/tasks/task-123")) {
        return new Response(
          JSON.stringify({
            output: {
              task_id: "task-123",
              task_status: "SUCCEEDED",
              results: [
                {
                  url: "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/wan.png",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
    const tool = createImagineImageTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

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
    const provider = createProvider("qwen-token-plan", {
      apiKey: "sk-sp-session",
      model: "qwen3.8-max",
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes("/api/v1/tasks/")
            ? {
                output: {
                  task_status: "UNKNOWN",
                  code: "InvalidTask",
                  message: "task disappeared",
                },
              }
            : { output: { task_id: "missing", task_status: "PENDING" } },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

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
