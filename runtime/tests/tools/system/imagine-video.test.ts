/**
 * ImagineVideo LIVE tool — text/image-to-video via xAI async API.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineVideoTool } from "../../../src/tools/system/imagine-video.js";
import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";
import {
  isModelFacingToolRegistered,
  mediaTestHome as testHome,
} from "./media-test-helpers.js";

describe("ImagineVideo catalog gate", () => {
  it("is registered for non-Grok sessions with independent xAI credentials", () => {
    expect(isModelFacingToolRegistered("ImagineVideo", {
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "key" },
    })).toBe(true);
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
    expect(isModelFacingToolRegistered("ImagineVideo", {
      workspaceRoot: root,
      agencHome: join(root, ".agenc-test-home"),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
    })).toBe(true);
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
        // A real Response: the download streams through a byte cap and
        // inspects redirect headers, which a bare object cannot answer.
        return new Response(
          Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
          { status: 200 },
        );
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
        return new Response(
          Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
          { status: 200 },
        );
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

  it("surfaces xAI's bare error string instead of a bare HTTP code", async () => {
    // A Zero Data Retention team gets exactly this on every video call, and
    // xAI reports it as `error: "..."`, not the {message} shape the chat
    // endpoints use. Losing it leaves the operator with "HTTP 400".
    const provider = createProvider("grok", {
      apiKey: "oauth-subscription-bearer",
      model: "grok-4.6",
      baseURL: "https://api.x.ai/v1",
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        code: "invalid-argument",
        error:
          "Zero Data Retention teams must provide output.upload_url for video generation.",
      }),
    })) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "a short clip" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Zero Data Retention");
  });

  it("generates with Sora for an OpenAI session holding an API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-sora-"));
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "video_abc", status: "queued" }),
        };
      }
      if (u.endsWith("/videos/video_abc")) {
        polls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: polls < 2 ? "in_progress" : "completed",
            progress: polls < 2 ? 40 : 100,
          }),
        };
      }
      if (u.endsWith("/videos/video_abc/content")) {
        return new Response(
          Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({
          services: {
            provider: createProvider("openai", {
              apiKey: "chatgpt-oauth-bearer-must-not-leak",
              model: "gpt-6-astra",
              baseURL: "https://api.openai.com/v1",
            }),
          },
        }) as unknown as Session,
      env: {
        OPENAI_API_KEY: "isolated-openai-key",
        XAI_API_KEY: "must-not-win-for-openai-session",
      },
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await tool.execute({ prompt: "a rotating cube", duration: 4 });

    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      model: string;
      request_id: string;
      duration: number;
      size: string;
      path: string;
    };
    expect(parsed).toMatchObject({
      model: "sora-2",
      request_id: "video_abc",
      duration: 4,
      size: "1280x720",
    });
    expect((await readFile(parsed.path)).length).toBeGreaterThan(0);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const submit = calls[0]?.[1] as {
      headers: Record<string, string>;
      body: string;
    };
    expect(submit.headers.authorization).toBe("Bearer isolated-openai-key");
    // Sora rejects unknown parameters, so the body carries exactly four.
    expect(JSON.parse(submit.body)).toEqual({
      model: "sora-2",
      prompt: "a rotating cube",
      seconds: "4",
      size: "1280x720",
    });
    // The MP4 came from the API host under the same bearer: no URL out of a
    // response body was ever followed.
    expect(String(calls.at(-1)?.[0])).toBe(
      "https://api.openai.com/v1/videos/video_abc/content",
    );
  });

  it("snaps a duration Sora does not offer and maps size from the frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-sora-snap-"));
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "v1" }) };
      }
      if (u.endsWith("/videos/v1")) {
        return { ok: true, status: 200, json: async () => ({ status: "completed" }) };
      }
      return new Response(Uint8Array.from([0x00]), { status: 200 });
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({
          services: {
            provider: createProvider("openai", {
              apiKey: "unused",
              model: "gpt-6-astra",
              baseURL: "https://api.openai.com/v1",
            }),
          },
        }) as unknown as Session,
      env: { OPENAI_API_KEY: "isolated-openai-key" },
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    await tool.execute({
      prompt: "a rotating cube",
      duration: 7,
      aspect_ratio: "9:16",
      resolution: "1080p",
    });

    const submit = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(submit.body)).toMatchObject({
      seconds: "8",
      size: "1024x1792",
    });
  });

  it("refuses Sora controls that need an uploaded reference", async () => {
    const fetchImpl = vi.fn();
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({
          services: {
            provider: createProvider("openai", {
              apiKey: "unused",
              model: "gpt-6-astra",
              baseURL: "https://api.openai.com/v1",
            }),
          },
        }) as unknown as Session,
      env: { OPENAI_API_KEY: "isolated-openai-key" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const withImage = await tool.execute({
      prompt: "x",
      image_url: "https://example.com/frame.png",
    });
    expect(withImage.isError).toBe(true);
    expect(String(withImage.content)).toContain("text-to-video only");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("generates with MiniMax Hailuo and downloads from its own CDN", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-hailuo-"));
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/video_generation") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            task_id: "task-1",
            base_resp: { status_code: 0, status_msg: "success" },
          }),
        };
      }
      if (u.includes("/query/video_generation")) {
        polls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            // Observed casing from the live API.
            status: polls < 2 ? "Processing" : "Success",
            file_id: polls < 2 ? "" : "file-9",
            base_resp: { status_code: 0 },
          }),
        };
      }
      if (u.includes("/files/retrieve")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            file: {
              download_url: "https://video-product.cdn.minimax.io/out.mp4",
            },
            base_resp: { status_code: 0 },
          }),
        };
      }
      if (u === "https://video-product.cdn.minimax.io/out.mp4") {
        return new Response(
          Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({
          services: {
            provider: createProvider("minimax", {
              apiKey: "minimax-session-key",
              model: "MiniMax-M2.5",
            }),
          },
        }) as unknown as Session,
      env: { MINIMAX_API_KEY: "isolated-minimax-key" },
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await tool.execute({ prompt: "a rotating cube", duration: 6 });

    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      model: string;
      request_id: string;
      duration: number;
      resolution: string;
      modality: string;
      path: string;
    };
    expect(parsed).toMatchObject({
      model: "MiniMax-Hailuo-02",
      request_id: "task-1",
      duration: 6,
      resolution: "768P",
      modality: "text",
    });
    expect((await readFile(parsed.path)).length).toBeGreaterThan(0);
    const submit = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[1] as { headers: Record<string, string>; body: string };
    expect(submit.headers.authorization).toBe("Bearer isolated-minimax-key");
    expect(JSON.parse(submit.body)).toEqual({
      model: "MiniMax-Hailuo-02",
      prompt: "a rotating cube",
      duration: 6,
      resolution: "768P",
    });
  });

  it("refuses a MiniMax download that leaves MiniMax's hosts", async () => {
    const root = await mkdtemp(join(tmpdir(), "imagine-hailuo-host-"));
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/video_generation") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ task_id: "t", base_resp: { status_code: 0 } }),
        };
      }
      if (u.includes("/query/video_generation")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "Success",
            file_id: "f",
            base_resp: { status_code: 0 },
          }),
        };
      }
      if (u.includes("/files/retrieve")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            file: { download_url: "https://cdn.evil.example/out.mp4" },
            base_resp: { status_code: 0 },
          }),
        };
      }
      throw new Error(`must not fetch ${u}`);
    }) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({
          services: {
            provider: createProvider("minimax", {
              apiKey: "unused",
              model: "MiniMax-M2.5",
            }),
          },
        }) as unknown as Session,
      env: { MINIMAX_API_KEY: "isolated-minimax-key" },
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await tool.execute({ prompt: "a rotating cube" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not trusted");
  });

  it("applies MiniMax's own parameter rules before spending a request", async () => {
    const fetchImpl = vi.fn();
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({
          services: {
            provider: createProvider("minimax", {
              apiKey: "unused",
              model: "MiniMax-M2.5",
            }),
          },
        }) as unknown as Session,
      env: { MINIMAX_API_KEY: "isolated-minimax-key" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // "param 'resolution' 512P is only supported when param
    // 'first_frame_image' provided" — refused here rather than upstream.
    const lowRes = await tool.execute({ prompt: "x", resolution: "512P" });
    expect(lowRes.isError).toBe(true);
    expect(String(lowRes.content)).toContain("512P only with a first frame");

    const model = await tool.execute({ prompt: "x", model: "MiniMax-Hailuo-99" });
    expect(model.isError).toBe(true);
    expect(String(model.content)).toContain("MiniMax video model must be");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a MiniMax HTTP 200 carrying a failure status as an error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        task_id: "",
        base_resp: { status_code: 1008, status_msg: "insufficient balance" },
      }),
    })) as unknown as typeof fetch;
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({
          services: {
            provider: createProvider("minimax", {
              apiKey: "unused",
              model: "MiniMax-M2.5",
            }),
          },
        }) as unknown as Session,
      env: { MINIMAX_API_KEY: "isolated-minimax-key" },
      fetchImpl,
    });

    const result = await tool.execute({ prompt: "a rotating cube" });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("insufficient balance");
  });

  it("drops a dimension control the backend cannot honour and names it", async () => {
    // The universal schema a model sees before a Session attaches is the xAI
    // one, so 480p and 4:3 reach Sora, and 16:9 reaches MiniMax. Refusing
    // them stalls the run; dropping and naming them lets it finish.
    const root = await mkdtemp(join(tmpdir(), "imagine-video-drop-"));
    const soraFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/videos") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "v9" }) };
      }
      if (u.endsWith("/videos/v9")) {
        return { ok: true, status: 200, json: async () => ({ status: "completed" }) };
      }
      return new Response(Uint8Array.from([0x00, 0x01]), { status: 200 });
    }) as unknown as typeof fetch;
    const sora = createImagineVideoTool({
      workspaceRoot: root,
      home: testHome(root),
      getSession: () =>
        ({
          services: {
            provider: createProvider("openai", {
              apiKey: "unused",
              model: "gpt-6-astra",
              baseURL: "https://api.openai.com/v1",
            }),
          },
        }) as unknown as Session,
      env: { OPENAI_API_KEY: "isolated-openai-key" },
      fetchImpl: soraFetch,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await sora.execute({
      prompt: "a rotating cube",
      aspect_ratio: "4:3",
      resolution: "480p",
    });

    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      ignoredControls?: string[];
      size: string;
    };
    expect(parsed.ignoredControls).toEqual(["aspect_ratio", "resolution"]);
    // Falls back to Sora's own defaults rather than guessing a translation.
    expect(parsed.size).toBe("1280x720");
  });

  it("never gates the session on an argument it refused before requesting", async () => {
    // ImagineVideo is side-effecting, so a bare isError from argument
    // validation is filed as an unknown outcome and blocks every later
    // side-effecting call behind /resolve (#2190). None of these paths
    // reached a provider, so each must carry the disposition that says so.
    const fetchImpl = vi.fn();
    const sora = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({
          services: {
            provider: createProvider("openai", {
              apiKey: "unused",
              model: "gpt-6-astra",
              baseURL: "https://api.openai.com/v1",
            }),
          },
        }) as unknown as Session,
      env: { OPENAI_API_KEY: "isolated-openai-key" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const hailuo = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () =>
        ({
          services: {
            provider: createProvider("minimax", {
              apiKey: "unused",
              model: "MiniMax-M2.5",
            }),
          },
        }) as unknown as Session,
      env: { MINIMAX_API_KEY: "isolated-minimax-key" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const unconfigured = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      home: testHome(process.cwd()),
      getSession: () => null,
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const cases: Array<[string, Promise<{ isError?: boolean; effectDisposition?: { disposition?: string } }>]> = [
      ["no prompt", sora.execute({})],
      ["no credential", unconfigured.execute({ prompt: "x" })],
      ["sora image_url", sora.execute({ prompt: "x", image_url: "https://e/x.png" })],
      ["sora model", sora.execute({ prompt: "x", model: "sora-9" })],
      ["minimax model", hailuo.execute({ prompt: "x", model: "Hailuo-99" })],
      ["minimax 512P", hailuo.execute({ prompt: "x", resolution: "512P" })],
    ];
    for (const [name, pending] of cases) {
      const result = await pending;
      expect(result.isError, name).toBe(true);
      expect(result.effectDisposition?.disposition, name).toBe(
        "confirmed_no_effect",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
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
