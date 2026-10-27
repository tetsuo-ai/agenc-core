/**
 * ImagineEdit (jobs/pv, 2026-10-20): a Venice session edits a workspace image
 * with any edit model Venice lists, or upscales it 2x or 4x, at the listed
 * price; anything outside the workspace, not an image, or not listed is
 * refused before any request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineEditTool, hasImagineEditBackend } from "../../../src/tools/system/imagine-edit.js";
import {
  clearVeniceMediaModels,
  parseVeniceMediaModels,
  recordVeniceMediaModels,
} from "../../../src/tools/system/venice-media-models.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";
import { VENICE_MEDIA_LIST } from "./media-test-helpers.js";

const VENICE = "https://api.venice.ai/api/v1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const veniceSession = () =>
  () => ({ services: { provider: createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" }) } }) as unknown as Session;
const workspace = () => mkdtemp(join(tmpdir(), "pv-venice-edit-"));
const seed = () => recordVeniceMediaModels(VENICE, parseVeniceMediaModels(VENICE_MEDIA_LIST));
const bodyOf = (mock: ReturnType<typeof vi.fn>, index: number) =>
  JSON.parse(String((mock.mock.calls[index]?.[1] as RequestInit | undefined)?.body ?? "{}"));

afterEach(() => clearVeniceMediaModels());

describe("ImagineEdit: Venice edits and upscales a workspace image", () => {
  it("edits with a listed edit model, saves the PNG and records its price", async () => {
    seed();
    const root = await workspace();
    await mkdir(join(root, "art"));
    await writeFile(join(root, "art", "in.png"), PNG);
    const fetchImpl = vi.fn(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const opts = { workspaceRoot: root, env: {}, fetchImpl, getSession: veniceSession() };
    expect(hasImagineEditBackend(opts)).toBe(true);
    const tool = createImagineEditTool(opts);
    expect(tool.metadata?.deferred).toBe(true);
    // 0.03 per edit plus 0.0023 for the input image (Venice bills it; seen live 2026-10-20).
    expect(tool.admissionEstimate?.({ image: "art/in.png", prompt: "green", model: "grok-imagine-edit" })?.maxCostUsd).toBeCloseTo(0.0323, 10);
    const result = await tool.execute({ image: "art/in.png", prompt: "make it green", model: "grok-imagine-edit" });
    expect(result.isError).toBeFalsy();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${VENICE}/image/edit`);
    expect(new Headers((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe("Bearer venice-session");
    expect(bodyOf(fetchImpl, 0)).toEqual({ model: "grok-imagine-edit", prompt: "make it green", image: PNG.toString("base64"), output_format: "png" });
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ operation: "edit", model: "grok-imagine-edit" });
    expect(payload.costUsd).toBeCloseTo(0.0323, 10);
    expect(payload.path).toMatch(/\.agenc\/imagine\/imagine-edit-.*\.png$/);
    expect(await readFile(payload.path)).toEqual(PNG);
    expect(result.admissionUsage?.costUsd).toBeCloseTo(0.0323, 10);
  });

  it("upscales 2x at Venice's upscale price", async () => {
    seed();
    const root = await workspace();
    await writeFile(join(root, "in.png"), PNG);
    const fetchImpl = vi.fn(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const result = await createImagineEditTool({ workspaceRoot: root, env: {}, fetchImpl, getSession: veniceSession() })
      .execute({ image: "in.png", upscale: 2 });
    expect(result.isError).toBeFalsy();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${VENICE}/image/upscale`);
    expect(bodyOf(fetchImpl, 0)).toEqual({ image: PNG.toString("base64"), scale: 2 });
    expect(JSON.parse(result.content)).toMatchObject({ operation: "upscale", scale: 2, costUsd: 0.02 });
  });

  it("refuses an image outside the workspace, a non-image and an unlisted model before any request", async () => {
    seed();
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.png"), PNG);
    await writeFile(join(root, "notes.txt"), "not an image");
    await writeFile(join(root, "in.png"), PNG);
    const fetchImpl = vi.fn();
    const tool = createImagineEditTool({ workspaceRoot: root, env: {}, fetchImpl: fetchImpl as unknown as typeof fetch, getSession: veniceSession() });
    expect((await tool.execute({ image: join(outside, "secret.png"), prompt: "x" })).content).toContain("inside the workspace");
    expect((await tool.execute({ image: "../" + join(outside, "secret.png").split("/").slice(-2).join("/"), prompt: "x" })).isError).toBe(true);
    expect((await tool.execute({ image: "notes.txt", prompt: "x" })).content).toContain("PNG, JPEG or WebP");
    expect((await tool.execute({ image: "in.png", prompt: "x", model: "acme-unlisted-edit" })).content).toContain("firered-image-edit");
    expect((await tool.execute({ image: "in.png" })).content).toContain("prompt is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is not offered outside a Venice session", async () => {
    const root = await workspace();
    const opts = {
      workspaceRoot: root, env: { VENICE_API_KEY: "independent" }, fetchImpl: vi.fn() as unknown as typeof fetch,
      getSession: () => ({ services: { provider: createProvider("openrouter", { apiKey: "sk-or", model: "z-ai/glm-5.3-flash" }) } }) as unknown as Session,
    };
    expect(hasImagineEditBackend(opts)).toBe(false);
  });
});
