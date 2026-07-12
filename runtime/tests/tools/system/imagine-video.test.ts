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

describe("ImagineVideo catalog gate", () => {
  it("is not registered for non-Grok sessions", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineVideo")).toBe(false);
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
      getSession: () =>
        ({ services: { provider } }) as unknown as Session,
      env: {},
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    const result = await tool.execute({
      prompt: "a rocket launching at dawn",
      duration: 6,
      aspect_ratio: "16:9",
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
  });

  it("refuses non-grok sessions", async () => {
    const tool = createImagineVideoTool({
      workspaceRoot: process.cwd(),
      getSession: () =>
        ({
          services: { provider: { name: "anthropic" } },
        }) as unknown as Session,
      env: { XAI_API_KEY: "k" },
    });
    const result = await tool.execute({ prompt: "x" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/session provider is grok/i);
  });
});
