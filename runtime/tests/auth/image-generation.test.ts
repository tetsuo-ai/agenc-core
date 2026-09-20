import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { createManagedImageClient, MANAGED_IMAGE_MAX_BYTES, parseImageGenerationAccess } from "../../src/auth/image-generation.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";

const requestId = "b9f0a8b3-cab2-44f5-a5fa-433374d5a16a";
const access = { enabled: true, available: true, model: { id: "qwen-image-2.1", name: "Qwen Image 2.1" },
  sizes: ["1024x1024"], maxImages: 1, priceUsd: 0, quota: { dailyLimit: 10, remaining: 10 } };
function chunk(name: string, data: Buffer): Buffer {
  const kind = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([kind, data])) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, kind, data, checksum]);
}
function png(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1024, 0); header.writeUInt32BE(1024, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(1024 * 1025))), chunk("IEND", Buffer.alloc(0))]);
}
const image = png();
const payload = () => ({ model: "qwen-image-2.1", request_id: requestId, price_usd: 0, created: 1,
  data: [{ mime_type: "image/png", b64_json: image.toString("base64") }] });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("managed image transport", () => {
  it("uses only own-backend origin and native bearer, with exact free/idempotent shape", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/image-generation") ? access : payload()));
    const client = createManagedImageClient({ origin: "https://identity.example.test/v1/auth/llm-usage", getToken: async () => "synthetic-native-token", fetchImpl: fetchImpl as typeof fetch });
    expect(await client.access()).toEqual(access);
    expect(await client.generate({ prompt: "A blue circle", requestId })).toMatchObject({ bytes: image, priceUsd: 0, requestId });
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://identity.example.test/v1/images/generations");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer synthetic-native-token", "Idempotency-Key": requestId });
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen-image-2.1", prompt: "A blue circle", n: 1, size: "1024x1024", response_format: "b64_json" });
    expect(JSON.stringify(await client.access())).not.toContain("synthetic-native-token");
  });
  it("does not dispatch without account authority or accept an insecure authority URL", async () => {
    const fetchImpl = vi.fn();
    const client = createManagedImageClient({ origin: "https://identity.example.test", getToken: async () => undefined, fetchImpl });
    expect(await client.access()).toBeUndefined();
    await expect(client.generate({ prompt: "test", requestId })).rejects.toMatchObject({ noEffect: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createManagedImageClient({ origin: "http://identity.example.test", getToken: async () => "token", fetchImpl })).toThrow("HTTPS");
  });
  it("is independent of disabled managed chat keys and never vends a provider credential", async () => {
    const fetchImpl = vi.fn(async () => response(access));
    const backend = new RemoteAuthBackend({ token: "synthetic-native-token", managedKeysEnabled: false,
      usageEndpoint: "https://identity.example.test/v1/auth/llm-usage", env: {}, fetchImpl });
    expect(await backend.getImageGenerationAccess()).toEqual(access);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    [429, "image_quota_exceeded", true], [429, "image_generation_busy", true],
    [409, "image_generation_outcome_unknown", false], [409, "image_generation_in_progress", false],
    [503, "image_generation_unavailable", false],
  ])("does not retry HTTP%s %s and preserves outcome uncertainty", async (status, code, noEffect) => {
    const fetchImpl = vi.fn(async () => response({ error: { code, message: "private upstream credential" } }, status));
    const client = createManagedImageClient({ origin: "https://identity.example.test", getToken: async () => "token", fetchImpl });
    const result = client.generate({ prompt: "test", requestId });
    await expect(result).rejects.toMatchObject({ noEffect, code });
    await expect(result).rejects.not.toThrow("private upstream credential");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...payload(), price_usd: 1 }, { ...payload(), request_id: "other" }, { ...payload(), model: "chat-model" },
    { ...payload(), data: [{ url: "https://attacker.test/key", mime_type: "image/png" }] },
    { ...payload(), data: [] }, { ...payload(), data: [payload().data[0], payload().data[0]] },
    { ...payload(), data: [{ mime_type: "image/png", b64_json: Buffer.from("not a PNG").toString("base64") }] },
  ])("rejects a malformed or charged result without following media URLs", async value => {
    const fetchImpl = vi.fn(async () => response(value));
    const client = createManagedImageClient({ origin: "https://identity.example.test", getToken: async () => "token", fetchImpl });
    await expect(client.generate({ prompt: "test", requestId })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds declared and streamed responses before decoding", async () => {
    for (const oversized of [new Response("{}", { headers: { "content-length": String(MANAGED_IMAGE_MAX_BYTES * 2) } }),
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MANAGED_IMAGE_MAX_BYTES * 2)); controller.close(); } }))]) {
      const client = createManagedImageClient({ origin: "https://identity.example.test", getToken: async () => "token", fetchImpl: vi.fn(async () => oversized) });
      await expect(client.generate({ prompt: "test", requestId })).rejects.toThrow("size limit");
    }
  });
  it("projects capability fields and rejects non-free or contradictory access", () => {
    expect(parseImageGenerationAccess({ ...access, apiKey: "private", model: { ...access.model, token: "private" } })).toEqual(access);
    for (const change of [{ priceUsd: 1 }, { enabled: false }, { quota: { dailyLimit: 10, remaining: 11 } }]) {
      expect(() => parseImageGenerationAccess({ ...access, ...change })).toThrow();
    }
  });
  it("cancels an admitted request without retrying or exposing raw transport errors", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      controller.abort(new Error("cancelled by caller"));
      init?.signal?.throwIfAborted();
      return response(payload());
    });
    const client = createManagedImageClient({ origin: "https://identity.example.test", getToken: async () => "token", fetchImpl });
    await expect(client.generate({ prompt: "test", requestId, signal: controller.signal })).rejects.toThrow("cancelled by caller");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(client.generate({ prompt: "test", requestId, signal: controller.signal })).rejects.toThrow("cancelled by caller");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
