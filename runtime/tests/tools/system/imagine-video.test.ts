/**
 * ImagineVideo LIVE tool — text/image-to-video via xAI async API.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHomeContext } from "../../../src/config/home.js";
import { createImagineVideoTool } from "../../../src/tools/system/imagine-video.js";
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

describe("ImagineVideo catalog gate", () => {
  it("is registered for non-Grok sessions with independent xAI credentials", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineVideo")).toBe(true);
  });

  it("is registered for grok + direct xAI + credentials", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "grok",
      sessionBaseURL: "https://api.x.ai/v1",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineVideo")).toBe(true);
  });

  it("is not registered when the configured xAI media host is not direct", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      env: {
        XAI_API_KEY: "xai-key",
        XAI_BASE_URL: "https://openrouter.ai/api/v1",
      },
    });

    expect(tools.some((t) => t.name === "ImagineVideo")).toBe(false);
  });

  it("is registered with a direct Grok factory bearer and no env key", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-video-factory-catalog-"));
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

    expect(tools.some((t) => t.name === "ImagineVideo")).toBe(true);
  });
});

describe("ImagineVideo execute", () => {
  it("submits, polls, downloads mp4 with OAuth session bearer", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-vid-"));
    const provider = createProvider("grok", {
      apiKey: "oauth-subscription-bearer",
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
    });

    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos/generations") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-vid-1" }),
        };
      }
      if (u.includes("/videos/req-vid-1")) {
        polls += 1;
        if (polls < 2) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: "pending" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "done",
            video: { url: "https://cdn.example/out.mp4" },
          }),
        };
      }
      if (u === "https://cdn.example/out.mp4") {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
              .buffer,
        };
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const admittedAbort = new AbortController();
    const result = await tool.execute({
      prompt: "a rocket launching at dawn",
      duration: 6,
      aspect_ratio: "16:9",
      __abortSignal: admittedAbort.signal,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      path: string;
      request_id: string;
      model: string;
    };
    expect(parsed.request_id).toBe("req-vid-1");
    expect(parsed.model).toBe("grok-imagine-video");
    expect(parsed.path).toMatch(/imagine-video-.*\.mp4$/);
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(0);

    const submitCall = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find((c) => String(c[0]).includes("/videos/generations"));
    expect(submitCall).toBeDefined();
    const auth = (submitCall![1] as { headers: { authorization: string } })
      .headers.authorization;
    expect(auth).toBe("Bearer oauth-subscription-bearer");
    const body = JSON.parse(
      (submitCall![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.prompt).toBe("a rocket launching at dawn");
    expect(body.duration).toBe(6);
    expect(
      (
        fetchImpl as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.every(
        (call) =>
          (call[1] as { signal?: AbortSignal } | undefined)?.signal ===
          admittedAbort.signal,
      ),
    ).toBe(true);
  });

  it("stops polling when the admitted tool signal is cancelled", async () => {
    const provider = createProvider("grok", {
      apiKey: "oauth-subscription-bearer",
      model: "grok-4.5",
      baseURL: "https://api.x.ai/v1",
    });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(url).endsWith("/videos/generations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-cancel" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "pending" }),
      };
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
      pollIntervalMs: 10_000,
      pollTimeoutMs: 30_000,
    });
    const admittedAbort = new AbortController();
    const reason = new Error("kernel cancelled video generation");

    const running = tool.execute({
      prompt: "a cancelled video",
      __abortSignal: admittedAbort.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    admittedAbort.abort(reason);

    await expect(running).rejects.toBe(reason);
  });

  it("uses xAI media credentials, never the Meta reasoning credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-meta-vid-"));
    const provider = createProvider("meta", {
      apiKey: "meta-session-key-must-not-leak",
      model: "muse-spark-1.3",
      baseURL: "https://api.meta.ai/v1",
    });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/videos/generations")) {
        expect(
          (init?.headers as { authorization: string }).authorization,
        ).toBe("Bearer xai-media-key");
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: "req-meta-xai" }),
        };
      }
      if (value.endsWith("/videos/req-meta-xai")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "done",
            video: { url: "https://cdn.example/meta-xai.mp4" },
          }),
        };
      }
      if (value === "https://cdn.example/meta-xai.mp4") {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
              .buffer,
        };
      }
      throw new Error(`unexpected fetch ${value}`);
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {
        MODEL_API_KEY: "canonical-meta-key-must-not-leak",
        XAI_API_KEY: "xai-media-key",
      },
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await tool.execute({ prompt: "a short clip" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { path: string };
    expect((await readFile(parsed.path)).length).toBeGreaterThan(0);
    expect(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    ).toBe("https://api.x.ai/v1/videos/generations");
  });

  it("fails closed when a Meta session has no independent xAI credential", async () => {
    const provider = createProvider("meta", {
      apiKey: "meta-session-key-must-not-leak",
      model: "muse-spark-1.3",
      baseURL: "https://api.meta.ai/v1",
    });
    const fetchImpl = vi.fn();
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: { MODEL_API_KEY: "canonical-meta-key-must-not-leak" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool.execute({ prompt: "must not run" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/independent xAI media credential/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
