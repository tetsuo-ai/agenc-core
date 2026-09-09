/**
 * LIVE: the GPT Image and MiniMax Image backends against the real APIs.
 *
 * Run:
 *   OPENAI_API_KEY=… MINIMAX_API_KEY=… \
 *     npm --workspace=@tetsuo-ai/runtime exec vitest run \
 *     tests/live/imagine-image-backends.live.test.ts
 *
 * Each case generates one image and is therefore billed. Both providers are
 * asked for inline base64, so a passing run also proves the tool never needs
 * a download host for either backend.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineImageTool } from "../../src/tools/system/imagine-image.js";
import { createProvider } from "../../src/llm/provider.js";
import { resolveHomeContext } from "../../src/config/home.js";
import type { Session } from "../../src/session/session.js";

const PROMPT = "a plain grey square on a white background";

async function generate(input: {
  readonly provider: "openai" | "minimax";
  readonly model: string;
  readonly credential: string;
  readonly args: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), `live-imagine-${input.provider}-`));
  const tool = createImagineImageTool({
    workspaceRoot: root,
    home: resolveHomeContext(
      { AGENC_HOME: join(root, ".agenc-home"), HOME: root },
      { platformHome: root },
    ),
    getSession: () =>
      ({
        services: {
          provider: createProvider(input.provider, {
            // Deliberately not a usable media credential: only the
            // environment ingress may authorize either backend.
            apiKey: "session-key-not-for-media",
            model: input.model,
          }),
        },
      }) as unknown as Session,
    env: { [input.credential]: process.env[input.credential] ?? "" },
  });
  const result = await tool.execute({ prompt: PROMPT, ...input.args });
  return { tool, result };
}

describe.skipIf(!process.env.OPENAI_API_KEY)("GPT Image, live", () => {
  it("generates and saves a real image", async () => {
    const { tool, result } = await generate({
      provider: "openai",
      model: "gpt-6-astra",
      credential: "OPENAI_API_KEY",
      args: { aspect_ratio: "1:1", quality: "low" },
    });

    expect(tool.description).toContain("GPT Image");
    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      model: string;
      path: string;
      n: number;
    };
    expect(parsed).toMatchObject({
      backend: "openai",
      model: "gpt-image-2",
      n: 1,
    });
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(1_000);
    // The saved extension has to match the real encoding or the desktop
    // transcript renders a broken image.
    expect(parsed.path.endsWith(".png")).toBe(true);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }, 300_000);
});

describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Image, live", () => {
  it("generates and saves a real image", async () => {
    const { tool, result } = await generate({
      provider: "minimax",
      model: "MiniMax-M2.5",
      credential: "MINIMAX_API_KEY",
      args: { aspect_ratio: "1:1", n: 1 },
    });

    expect(tool.description).toContain("MiniMax Image");
    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      backend: string;
      model: string;
      path: string;
      n: number;
    };
    expect(parsed).toMatchObject({
      backend: "minimax",
      model: "image-01",
      n: 1,
    });
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(parsed.path.endsWith(".jpg")).toBe(true);
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 300_000);
});
