/**
 * G3: ImagineImage LIVE tool gates + REST path (mocked fetch).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineImageTool } from "../../../src/tools/system/imagine-image.js";
import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";

describe("ImagineImage tool", () => {
  it("is not catalog-registered for non-Grok (Claude/OpenAI) sessions", () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      sessionProvider: "openai",
      env: { XAI_API_KEY: "key" },
    });
    expect(tools.some((t) => t.name === "ImagineImage")).toBe(false);
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

  it("refuses non-grok sessions at execute time (defense-in-depth)", async () => {
    const tool = createImagineImageTool({
      workspaceRoot: process.cwd(),
      getSession: () =>
        ({
          services: { provider: { name: "openai" } },
        }) as unknown as Session,
      env: { XAI_API_KEY: "key" },
    });
    const result = await tool.execute({ prompt: "a cat" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/session provider is grok/i);
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
});
