/**
 * LIVE: the GPT Image and MiniMax Image backends against the real APIs.
 *
 * Run:
 *   OPENAI_API_KEY=… MINIMAX_API_KEY=… \
 *     npm --workspace=@tetsuo-ai/runtime exec vitest run \
 *     --config vitest.live.config.ts \
 *     tests/live/imagine-image-backends.live.test.ts
 *
 * Each case generates one image and is therefore billed. Both providers are
 * asked for inline base64, so a passing run also proves the tool never needs
 * a download host for either backend. The saved extension is checked against
 * the file's own magic bytes: Electron's agenc-media handler derives the
 * rendered content type from it, so a wrong guess shows a broken image.
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

interface LiveImageCase {
  readonly label: string;
  readonly provider: "openai" | "minimax";
  readonly sessionModel: string;
  readonly credential: string;
  readonly args: Record<string, unknown>;
  readonly backend: string;
  readonly imageModel: string;
  readonly extension: string;
  /** Leading bytes the real encoding must start with. */
  readonly magic: string;
}

const CASES: readonly LiveImageCase[] = [
  {
    label: "GPT Image",
    provider: "openai",
    sessionModel: "gpt-6-astra",
    credential: "OPENAI_API_KEY",
    args: { aspect_ratio: "1:1", quality: "low" },
    backend: "openai",
    imageModel: "gpt-image-2",
    extension: ".png",
    magic: "89504e470d0a1a0a",
  },
  {
    label: "MiniMax Image",
    provider: "minimax",
    sessionModel: "MiniMax-M2.5",
    credential: "MINIMAX_API_KEY",
    args: { aspect_ratio: "1:1", n: 1 },
    backend: "minimax",
    imageModel: "image-01",
    extension: ".jpg",
    magic: "ffd8",
  },
];

for (const testCase of CASES) {
  describe.skipIf(!process.env[testCase.credential])(
    `${testCase.label}, live`,
    () => {
      it("generates and saves a real image", async () => {
        const root = await mkdtemp(
          join(tmpdir(), `live-imagine-${testCase.provider}-`),
        );
        const tool = createImagineImageTool({
          workspaceRoot: root,
          home: resolveHomeContext(
            { AGENC_HOME: join(root, ".agenc-home"), HOME: root },
            { platformHome: root },
          ),
          getSession: () =>
            ({
              services: {
                provider: createProvider(testCase.provider, {
                  // Deliberately not a usable media credential: only the
                  // environment ingress may authorize either backend.
                  apiKey: "session-key-not-for-media",
                  model: testCase.sessionModel,
                }),
              },
            }) as unknown as Session,
          env: {
            [testCase.credential]: process.env[testCase.credential] ?? "",
          },
        });

        const result = await tool.execute({ prompt: PROMPT, ...testCase.args });

        expect(tool.description).toContain(testCase.label);
        expect(result.isError, String(result.content)).toBeUndefined();
        const parsed = JSON.parse(result.content) as {
          backend: string;
          model: string;
          path: string;
          n: number;
        };
        expect(parsed).toMatchObject({
          backend: testCase.backend,
          model: testCase.imageModel,
          n: 1,
        });
        expect(parsed.path.endsWith(testCase.extension)).toBe(true);
        const bytes = await readFile(parsed.path);
        expect(bytes.length).toBeGreaterThan(1_000);
        expect(
          bytes.subarray(0, testCase.magic.length / 2).toString("hex"),
        ).toBe(testCase.magic);
      }, 300_000);
    },
  );
}
