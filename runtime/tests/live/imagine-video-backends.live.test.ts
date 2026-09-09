/**
 * LIVE: the Sora and MiniMax Hailuo video backends against the real APIs.
 *
 * Run:
 *   OPENAI_API_KEY=… MINIMAX_API_KEY=… \
 *     npm --workspace=@tetsuo-ai/runtime exec vitest run \
 *     --config vitest.live.config.ts \
 *     tests/live/imagine-video-backends.live.test.ts
 *
 * Each case generates one short clip at the cheapest settings the provider
 * offers and is therefore billed. Both assert the saved file is a real MP4
 * rather than trusting the provider's content type.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImagineVideoTool } from "../../src/tools/system/imagine-video.js";
import { createProvider } from "../../src/llm/provider.js";
import { resolveHomeContext } from "../../src/config/home.js";
import type { Session } from "../../src/session/session.js";

const PROMPT = "a grey cube slowly rotating on a white background";
/** ftyp box at offset 4: every MP4 this tool saves must start with one. */
const MP4_FTYP = "66747970";

async function generate(input: {
  readonly provider: "openai" | "minimax";
  readonly model: string;
  readonly credential: string;
  readonly args: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), `live-video-${input.provider}-`));
  const tool = createImagineVideoTool({
    workspaceRoot: root,
    home: resolveHomeContext(
      { AGENC_HOME: join(root, ".agenc-home"), HOME: root },
      { platformHome: root },
    ),
    getSession: () =>
      ({
        services: {
          provider: createProvider(input.provider, {
            apiKey: "session-key-not-for-media",
            model: input.model,
          }),
        },
      }) as unknown as Session,
    env: { [input.credential]: process.env[input.credential] ?? "" },
    pollIntervalMs: 5_000,
    pollTimeoutMs: 600_000,
  });
  const result = await tool.execute({ prompt: PROMPT, ...input.args });
  return { tool, result };
}

describe.skipIf(!process.env.OPENAI_API_KEY)("Sora video, live", () => {
  it("generates, polls and saves a real MP4", async () => {
    const { tool, result } = await generate({
      provider: "openai",
      model: "gpt-6-astra",
      credential: "OPENAI_API_KEY",
      args: { duration: 4, aspect_ratio: "9:16", resolution: "720p" },
    });

    expect(tool.description).toContain("Sora");
    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      model: string;
      duration: number;
      size: string;
      path: string;
    };
    expect(parsed).toMatchObject({
      model: "sora-2",
      duration: 4,
      size: "720x1280",
    });
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.subarray(4, 8).toString("hex")).toBe(MP4_FTYP);
  }, 660_000);
});

describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax video, live", () => {
  it("generates, polls, retrieves the file and saves a real MP4", async () => {
    const { tool, result } = await generate({
      provider: "minimax",
      model: "MiniMax-M2.5",
      credential: "MINIMAX_API_KEY",
      args: { duration: 6, resolution: "768P" },
    });

    expect(tool.description).toContain("Hailuo");
    expect(result.isError, String(result.content)).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      model: string;
      duration: number;
      resolution: string;
      url: string;
      path: string;
    };
    expect(parsed).toMatchObject({
      model: "MiniMax-Hailuo-02",
      duration: 6,
      resolution: "768P",
    });
    // Proves the download allowlist matches the host MiniMax actually uses.
    expect(new URL(parsed.url).hostname.endsWith(".minimax.io")).toBe(true);
    const bytes = await readFile(parsed.path);
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.subarray(4, 8).toString("hex")).toBe(MP4_FTYP);
  }, 660_000);
});
