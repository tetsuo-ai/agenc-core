/**
 * Venice media from Venice's own live list (jobs/pv, 2026-10-20): every
 * image, edit, upscale, speech and text-to-video model Venice lists is usable
 * at its listed price; a name Venice does not list is refused before any
 * generation request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineImageTool } from "../../../src/tools/system/imagine-image.js";
import { createImagineVideoTool } from "../../../src/tools/system/imagine-video.js";
import { createImagineSpeechTool } from "../../../src/tools/system/imagine-speech.js";
import {
  clearVeniceMediaModels,
  parseVeniceMediaModels,
  recordVeniceMediaModels,
} from "../../../src/tools/system/venice-media-models.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";
import { mediaTestHome as testHome, VENICE_MEDIA_LIST } from "./media-test-helpers.js";

const VENICE = "https://api.venice.ai/api/v1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const veniceSession = () =>
  () => ({ services: { provider: createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" }) } }) as unknown as Session;
const workspace = () => mkdtemp(join(tmpdir(), "pv-venice-media-"));
const seed = () => recordVeniceMediaModels(VENICE, parseVeniceMediaModels(VENICE_MEDIA_LIST));
const bodyOf = (mock: ReturnType<typeof vi.fn>, index: number) =>
  JSON.parse(String((mock.mock.calls[index]?.[1] as RequestInit | undefined)?.body ?? "{}"));

afterEach(() => clearVeniceMediaModels());

describe("ImagineImage: any Venice image model at its listed price", () => {
  it("generates with a model the reviewed table never named and charges its 1K tier", async () => {
    seed();
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const tool = createImagineImageTool({ workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, getSession: veniceSession() });
    expect(tool.admissionEstimate?.({ prompt: "x", model: "grok-imagine-image-quality" })).toMatchObject({ maxCostUsd: 0.06 });
    const result = await tool.execute({ prompt: "a red circle", model: "grok-imagine-image-quality" });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(fetchImpl, 0)).toMatchObject({ model: "grok-imagine-image-quality", size: "1024x1024", n: 1 });
    expect(JSON.parse(result.content)).toMatchObject({ backend: "venice", model: "grok-imagine-image-quality", costUsd: 0.06 });
    // A tiered model with a default quality is charged that quality's price.
    const quality = await tool.execute({ prompt: "a red circle", model: "gpt-image-2" });
    expect(JSON.parse(quality.content)).toMatchObject({ costUsd: 0.27 });
  });

  it("refuses a name Venice does not list before any request", async () => {
    seed();
    const root = await workspace();
    const fetchImpl = vi.fn();
    const tool = createImagineImageTool({
      workspaceRoot: root, home: testHome(root), env: {}, fetchImpl: fetchImpl as unknown as typeof fetch, getSession: veniceSession(),
    });
    const result = await tool.execute({ prompt: "x", model: "acme-unlisted-image" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("grok-imagine-image-quality");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads Venice's list with the session's key when it has none yet", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/models?type=all") ? json(VENICE_MEDIA_LIST) : json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const tool = createImagineImageTool({ workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, getSession: veniceSession() });
    const result = await tool.execute({ prompt: "a red circle", model: "grok-imagine-image-quality" });
    expect(result.isError).toBeFalsy();
    const urls = fetchImpl.mock.calls.map(entry => String(entry[0]));
    expect(urls.filter(url => url === `${VENICE}/models?type=all`)).toHaveLength(1);
    const listCall = fetchImpl.mock.calls.find(entry => String(entry[0]).endsWith("/models?type=all"));
    expect(new Headers((listCall?.[1] as RequestInit | undefined)?.headers).get("authorization")).toBe("Bearer venice-session");
    expect(JSON.parse(result.content)).toMatchObject({ costUsd: 0.06 });
  });
});

describe("ImagineSpeech: any Venice voice model at its listed price", () => {
  it("speaks with a listed model and its first voice, and refuses a voice it does not list", async () => {
    seed();
    const root = await workspace();
    const audio = Buffer.from("ID3-fake-mp3");
    const fetchImpl = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
    const tool = createImagineSpeechTool({ workspaceRoot: root, env: {}, fetchImpl, getSession: veniceSession() });
    const text = "AgenC speech check";
    expect(tool.admissionEstimate?.({ text, model: "tts-elevenlabs-turbo-v2-5" })?.maxCostUsd).toBeCloseTo(62.5e-6 * text.length, 12);
    const result = await tool.execute({ text, model: "tts-elevenlabs-turbo-v2-5" });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(fetchImpl, 0)).toMatchObject({ model: "tts-elevenlabs-turbo-v2-5", voice: "Alice", input: text });
    expect(JSON.parse(result.content).costUsd).toBeCloseTo(62.5e-6 * text.length, 12);
    const refused = await tool.execute({ text, model: "tts-elevenlabs-turbo-v2-5", voice: "af_sky" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Alice, Aria");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ImagineSpeech: a Venice model that returns only WAV", () => {
  it("asks for the model's own format and saves a .wav", async () => {
    // Seen live: tts-orpheus, tts-inworld-1-5-max, tts-chatterbox-hd and
    // tts-gradium-v1 answer 400 to response_format mp3.
    seed();
    const root = await workspace();
    const audio = Buffer.from("RIFF-fake-wav");
    const fetchImpl = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/wav" } }));
    const result = await createImagineSpeechTool({ workspaceRoot: root, env: {}, fetchImpl, getSession: veniceSession() })
      .execute({ text: "AgenC speech check", model: "tts-orpheus" });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(fetchImpl, 0)).toMatchObject({ model: "tts-orpheus", voice: "dan", response_format: "wav" });
    expect(JSON.parse(result.content).path).toMatch(/imagine-speech-.*\.wav$/);
  });
});

describe("Venice media seen in the TUI (jobs/pv F5-ven-media, 2026-10-20)", () => {
  it("the schema a registry advertises before its session attaches takes any speech model name", async () => {
    seed();
    const root = await workspace();
    let current: Session | null = null;
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("RIFF-fake-wav"), { headers: { "content-type": "audio/wav" } }));
    const tool = createImagineSpeechTool({ workspaceRoot: root, env: {}, fetchImpl, getSession: () => current });
    // Base: an enum of the reviewed models, so the TUI refused tts-orpheus ("value not in enum").
    const model = (tool.inputSchema as { properties: Record<string, { enum?: unknown }> }).properties.model;
    expect(model?.enum).toBeUndefined();
    current = veniceSession()();
    const result = await tool.execute({ text: "AgenC speech check", model: "tts-orpheus" });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(fetchImpl, 0)).toMatchObject({ model: "tts-orpheus", response_format: "wav" });
  });

  it("saves an image under the type its bytes declare, not the one asked for", async () => {
    seed();
    const root = await workspace();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const fetchImpl = vi.fn(async () => json({ data: [{ b64_json: jpeg.toString("base64") }] }));
    const tool = createImagineImageTool({ workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, getSession: veniceSession() });
    const result = await tool.execute({ prompt: "a bicycle", model: "grok-imagine-image-quality" });
    expect(JSON.parse(result.content).path).toMatch(/imagine-.*\.jpg$/);
  });

  it("the video schema advertised before the session attaches takes max_usd and any tier", () => {
    const root = "/nonexistent-workspace";
    const tool = createImagineVideoTool({ workspaceRoot: root, home: testHome(root), env: {}, fetchImpl: vi.fn() as unknown as typeof fetch, getSession: () => null });
    const properties = (tool.inputSchema as { properties: Record<string, { enum?: unknown; type?: string }> }).properties;
    expect(properties.max_usd?.type).toBe("number");
    expect(properties.resolution?.enum).toBeUndefined();
  });

  it("waits as long as Venice says the model takes, past the default poll", async () => {
    seed();
    const root = await workspace();
    const mp4 = Buffer.from("venice-slow-mp4");
    let retrieves = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/video/quote")) return json({ quote: 0.09 });
      if (url.endsWith("/video/queue")) return json({ queue_id: "q-slow" });
      if (url.endsWith("/video/retrieve")) {
        retrieves += 1;
        return retrieves < 20
          ? json({ status: "PROCESSING", average_execution_time: 40, execution_duration: retrieves })
          : new Response(mp4, { headers: { "content-type": "video/mp4" } });
      }
      if (url.endsWith("/video/complete")) return json({ success: true });
      throw new Error(`unexpected ${url}`);
    });
    // Base: the 5 ms poll gave up while Venice was still at work (paid, no video).
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 5, getSession: veniceSession(),
    });
    const result = await tool.execute({ prompt: "waves", model: "seedance-2-0-text-to-video" });
    expect(result.isError).toBeFalsy();
    expect(retrieves).toBe(20);
    expect(JSON.parse(result.content).costUsd).toBe(0.09);
  });
});

describe("ImagineVideo: any Venice text-to-video model under the call's max_usd", () => {
  it("quotes a listed model with its own shape and queues it when the quote fits", async () => {
    seed();
    const root = await workspace();
    const mp4 = Buffer.from("venice-listed-mp4");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/video/quote")) return json({ quote: 0.42 });
      if (url.endsWith("/video/queue")) return json({ queue_id: "q-9" });
      if (url.endsWith("/video/retrieve")) return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      if (url.endsWith("/video/complete")) return json({ success: true });
      throw new Error(`unexpected ${url}`);
    });
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, pollIntervalMs: 1, pollTimeoutMs: 1000, getSession: veniceSession(),
    });
    expect(tool.admissionEstimate?.({ prompt: "x", model: "seedance-2-0-text-to-video" })).toMatchObject({ maxCostUsd: 1 });
    const result = await tool.execute({ prompt: "waves", model: "seedance-2-0-text-to-video" });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(fetchImpl, 0)).toEqual({ model: "seedance-2-0-text-to-video", duration: "5s", resolution: "480p", aspect_ratio: "16:9" });
    expect(JSON.parse(result.content).costUsd).toBe(0.42);
  });

  it("keeps Venice's own spelling of a capitalised tier (480P)", async () => {
    seed();
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({ quote: 9 }));
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, pollIntervalMs: 1, getSession: veniceSession(),
    });
    await tool.execute({ prompt: "waves", model: "minimax-h3-max-turbo-text-to-video" });
    expect(bodyOf(fetchImpl, 0)).toEqual({ model: "minimax-h3-max-turbo-text-to-video", duration: "6s", resolution: "480P", aspect_ratio: "16:9" });
  });

  it("refuses a quote above max_usd, an image-to-video model and an unlisted model before queueing", async () => {
    seed();
    const root = await workspace();
    const fetchImpl = vi.fn(async () => json({ quote: 0.6 }));
    const tool = createImagineVideoTool({
      workspaceRoot: root, home: testHome(root), env: {}, fetchImpl, pollIntervalMs: 1, getSession: veniceSession(),
    });
    const over = await tool.execute({ prompt: "waves", model: "seedance-2-0-text-to-video", max_usd: 0.5 });
    expect(over.isError).toBe(true);
    expect(over.content).toContain("above max_usd");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const model of ["seedance-2-0-image-to-video", "acme-unlisted-video"]) {
      const refused = await tool.execute({ prompt: "waves", model });
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("seedance-2-0-text-to-video");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
