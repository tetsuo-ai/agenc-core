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
      if (String(url) === "https://cdn.example/generated.webp") {
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
          data: [{ url: "https://cdn.example/generated.webp" }],
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
