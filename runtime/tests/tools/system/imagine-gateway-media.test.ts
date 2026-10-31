/** OpenRouter and Venice media backends: image, video and speech (mocked fetch). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineImageTool } from "../../../src/tools/system/imagine-image.js";
import { createImagineVideoTool } from "../../../src/tools/system/imagine-video.js";
import { createImagineSpeechTool, hasImagineSpeechBackend } from "../../../src/tools/system/imagine-speech.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";
import { mediaTestHome as testHome, VENICE_MEDIA_LIST } from "./media-test-helpers.js";
import {
  clearVeniceMediaModels,
  parseVeniceMediaModels,
  recordVeniceMediaModels,
} from "../../../src/tools/system/venice-media-models.js";

// Venice prices media from its live list; these cases start with it read.
/** The environment these tools are built with, and so their sessions' transport. */
const ENV: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;
/** A Venice list for the session the tools run for: its endpoint, key and transport. */
beforeEach(() => recordVeniceMediaModels(
  { baseURL: "https://api.venice.ai/api/v1", bearer: "venice-session", transport: ENV },
  parseVeniceMediaModels(VENICE_MEDIA_LIST)));
afterEach(() => clearVeniceMediaModels());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const session = (provider: ReturnType<typeof createProvider>) =>
  () => ({ services: { provider } }) as unknown as Session;
const workspace = () => mkdtemp(join(tmpdir(), "pv-media-"));
const call = (mock: ReturnType<typeof vi.fn>, index: number) => ({
  url: String(mock.mock.calls[index]?.[0]),
  init: mock.mock.calls[index]?.[1] as RequestInit | undefined,
  body: JSON.parse(String((mock.mock.calls[index]?.[1] as RequestInit | undefined)?.body ?? "{}")),
});

describe("ImagineImage on an OpenRouter or Venice session", () => {
  it("OpenRouter: the session's own key, the Image API, base64 output and the reported cost", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({
      data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }],
      usage: { cost: 0.009 },
    }));
    const tool = createImagineImageTool({
      workspaceRoot: root, home: testHome(root), env: { OPENROUTER_API_KEY: "env-key-not-used" }, fetchImpl,
      getSession: session(createProvider("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3-flash" })),
    });
    expect(tool.admissionEstimate?.({ prompt: "a bicycle" })).toMatchObject({ maxCostUsd: 0.036 });
    const result = await tool.execute({ prompt: "a red bicycle", aspect_ratio: "1:1", resolution: "1k" });
    expect(result.isError).toBeFalsy();
    const request = call(fetchImpl, 0);
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer sk-or-session");
    expect(request.body).toEqual({ model: "black-forest-labs/flux-3-image-klein", prompt: "a red bicycle", n: 1, aspect_ratio: "1:1", resolution: "1K" });
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ backend: "openrouter", n: 1, costUsd: 0.009 });
    expect(payload.path).toMatch(/\/\.agenc\/imagine\/imagine-.*\.png$/);
    expect(await readFile(payload.path)).toEqual(PNG);
    expect(result.admissionUsage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0.009 });
  });

  it("Venice: the OpenAI-compatible route, one image, the published price", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const tool = createImagineImageTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl,
      getSession: session(createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })),
    });
    const result = await tool.execute({ prompt: "a cat", n: 3, aspect_ratio: "16:9" });
    const request = call(fetchImpl, 0);
    expect(request.url).toBe("https://api.venice.ai/api/v1/images/generations");
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer venice-session");
    expect(request.body).toEqual({ model: "z-image-turbo", prompt: "a cat", n: 1, size: "1536x1024", output_format: "png", response_format: "b64_json" });
    expect(JSON.parse(result.content)).toMatchObject({ backend: "venice", n: 1, costUsd: 0.01, ignoredControls: ["n"] });
    expect(result.admissionUsage?.costUsd).toBe(0.01);
  });

  it("refuses an unreviewed model before any request, and the managed route gets no backend", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn();
    const tool = createImagineImageTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch,
      getSession: session(createProvider("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3-flash" })),
    });
    const refused = await tool.execute({ prompt: "x", model: "acme/unreviewed-image" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("OpenRouter image model must be one of");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createProvider("openrouter", {
      apiKey: "agenc-managed", model: "openrouter/deepseek/deepseek-v4.1-flash", baseURL: "https://gateway.invalid/v1",
      extra: { managedGateway: true },
    })).toThrow("AgenC accounts no longer provide models");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ImagineVideo on an OpenRouter or Venice session", () => {
  it("OpenRouter: submit, poll, download from the API host only, record the cost", async () => {
    const root = await workspace();
    const mp4 = Buffer.from("fake-mp4-bytes");
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/videos")) return json({ id: "job_123", polling_url: "https://openrouter.ai/api/v1/videos/job_123", status: "pending" }, 202);
      if (url.endsWith("/videos/job_123")) {
        polls += 1;
        return polls < 2
          ? json({ id: "job_123", status: "in_progress" })
          : json({ id: "job_123", status: "completed", unsigned_urls: ["https://elsewhere.invalid/v.mp4"], usage: { cost: 0.08 } });
      }
      if (url.endsWith("/videos/job_123/content?index=0")) return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      throw new Error(`unexpected ${url}`);
    });
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 1000,
      getSession: session(createProvider("openrouter", { apiKey: "sk-or-session", model: "z-ai/glm-5.3-flash" })),
    });
    expect(tool.admissionEstimate?.({ prompt: "waves" })).toMatchObject({ maxCostUsd: 0.08 });
    const result = await tool.execute({ prompt: "waves" });
    expect(result.isError).toBeFalsy();
    expect(call(fetchImpl, 0).body).toEqual({ model: "x-ai/grok-imagine-video-1.5-lite", prompt: "waves", duration: 4, resolution: "480p", aspect_ratio: "16:9" });
    expect(fetchImpl.mock.calls.map((entry) => String(entry[0]))).not.toContain("https://elsewhere.invalid/v.mp4");
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ model: "x-ai/grok-imagine-video-1.5-lite", duration: 4, resolution: "480p", costUsd: 0.08 });
    expect(await readFile(payload.path)).toEqual(mp4);
    expect(result.admissionUsage?.costUsd).toBe(0.08);
  });

  it("Venice: quote, queue, retrieve the MP4 inline, remove the stored copy, charge the quote", async () => {
    const root = await workspace();
    const mp4 = Buffer.from("venice-mp4");
    let retrieves = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/video/quote")) return json({ quote: 0.1 });
      if (url.endsWith("/video/queue")) return json({ model: "grok-imagine-1-5-lite-text-to-video", queue_id: "q-1" });
      if (url.endsWith("/video/retrieve")) {
        retrieves += 1;
        return retrieves < 2 ? json({ status: "PROCESSING" }) : new Response(mp4, { headers: { "content-type": "video/mp4" } });
      }
      if (url.endsWith("/video/complete")) return json({ success: true });
      throw new Error(`unexpected ${url}`);
    });
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 1000,
      getSession: session(createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })),
    });
    const result = await tool.execute({ prompt: "gondola" });
    expect(result.isError).toBeFalsy();
    expect(call(fetchImpl, 0).body).toEqual({ model: "grok-imagine-1-5-lite-text-to-video", duration: "4s", resolution: "480p", aspect_ratio: "16:9" });
    expect(call(fetchImpl, 1).body).toMatchObject({ prompt: "gondola", duration: "4s" });
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe("https://api.venice.ai/api/v1/video/complete");
    const payload = JSON.parse(result.content);
    expect(payload.costUsd).toBe(0.1);
    expect((await stat(payload.path)).size).toBe(mp4.byteLength);
  });

  // Observed live 2026-10-20: grok-imagine-1-5-lite answers COMPLETED and
  // hands the MP4 out once through a pre-signed private-share.venice.ai link.
  it("Venice: a pre-signed link on Venice's domain is downloaded without the key, then revoked", async () => {
    const root = await workspace();
    const mp4 = Buffer.from("venice-linked-mp4");
    const link = "https://private-share.venice.ai/v1/share/abc";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/video/quote")) return json({ quote: 0.1 });
      if (url.endsWith("/video/queue")) return json({ queue_id: "q-2", download_url: link });
      if (url.endsWith("/video/retrieve")) return json({ status: "COMPLETED" });
      if (url === link && (init?.method ?? "GET") === "GET") return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      if (url === link && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 1000,
      getSession: session(createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })),
    });
    const result = await tool.execute({ prompt: "waves" });
    expect(result.isError).toBeFalsy();
    const linkCalls = fetchImpl.mock.calls.filter((entry) => String(entry[0]) === link);
    expect(linkCalls.map((entry) => (entry[1] as RequestInit | undefined)?.method ?? "GET")).toEqual(["GET", "DELETE"]);
    for (const entry of linkCalls) expect(new Headers((entry[1] as RequestInit | undefined)?.headers).get("authorization")).toBeNull();
    expect(await readFile(JSON.parse(result.content).path)).toEqual(mp4);
  });

  it("Venice: a download link off Venice's domain is refused", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/video/quote")) return json({ quote: 0.1 });
      if (url.endsWith("/video/queue")) return json({ queue_id: "q-3", download_url: "https://evil.invalid/v.mp4" });
      throw new Error(`unexpected ${url}`);
    });
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl, pollIntervalMs: 1,
      getSession: session(createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })),
    });
    const result = await tool.execute({ prompt: "waves" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not trusted for the venice backend");
    expect(fetchImpl.mock.calls.map((entry) => String(entry[0]))).not.toContain("https://evil.invalid/v.mp4");
  });

  it("Venice: a quote above the reviewed ceiling is refused before anything is queued", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({ quote: 5 }));
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: ENV, fetchImpl, pollIntervalMs: 1,
      getSession: session(createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })),
    });
    const result = await tool.execute({ prompt: "gondola" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("above its reviewed ceiling");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ImagineSpeech", () => {
  it("speaks with the session's own key and records the per-character price", async () => {
    const root = await workspace();
    const audio = Buffer.from("ID3-fake-mp3");
    const fetchImpl = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
    for (const [provider, key, url, model, rate] of [
      ["openrouter", "sk-or-session", "https://openrouter.ai/api/v1/audio/speech", "hexgrad/kokoro-82m", 0.00000062],
      ["venice", "venice-session", "https://api.venice.ai/api/v1/audio/speech", "tts-kokoro", 3.5 / 1_000_000],
    ] as const) {
      fetchImpl.mockClear();
      const tool = createImagineSpeechTool({
        workspaceRoot: root, env: ENV, fetchImpl,
        getSession: session(createProvider(provider, { apiKey: key, model: provider === "venice" ? "zai-org-glm-5-2" : "z-ai/glm-5.3-flash" })),
      });
      expect(tool.metadata?.deferred).toBe(true);
      const result = await tool.execute({ text: "AgenC speech check" });
      expect(result.isError).toBeFalsy();
      const request = call(fetchImpl, 0);
      expect(request.url).toBe(url);
      expect(new Headers(request.init?.headers).get("authorization")).toBe(`Bearer ${key}`);
      expect(request.body).toMatchObject({ model, input: "AgenC speech check", response_format: "mp3" });
      const payload = JSON.parse(result.content);
      expect(payload.path).toMatch(/imagine-speech-.*\.mp3$/);
      expect(await readFile(payload.path)).toEqual(audio);
      expect(payload.costUsd).toBeCloseTo(rate * "AgenC speech check".length, 12);
    }
  });

  it("is refused in any other provider's session", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn();
    const opts = {
      workspaceRoot: root, env: { OPENROUTER_API_KEY: "independent", VENICE_API_KEY: "independent" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getSession: session(createProvider("deepseek", { apiKey: "ds", model: "deepseek-flash" })),
    };
    expect(hasImagineSpeechBackend(opts)).toBe(false);
    const result = await createImagineSpeechTool(opts).execute({ text: "hi" });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
