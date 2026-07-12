/**
 * LIVE e2e: /grok-login OAuth (or existing stored token) → Imagine video gen.
 *
 * Run:
 *   npm --workspace=@tetsuo-ai/runtime exec vitest run tests/live/imagine-video-e2e.live.test.ts
 *
 * If no OAuth token is stored, this opens the xAI browser login URL so you can
 * sign in; then it generates a short video and downloads it under
 * /tmp/user/1000/grok-goal-00e3234b1d7c/implementer/e2e-out/
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  readXaiOauthAccessToken,
  readXaiOauthCredentials,
  saveXaiOauthCredentials,
  xaiOauthTokensToBlob,
} from "../../src/utils/xaiOauthCredentials.js";
import { runXaiBrowserLogin } from "../../src/services/xai/oauth.js";
import { createImagineVideoTool } from "../../src/tools/system/imagine-video.js";
import { createProvider } from "../../src/llm/provider.js";
import type { Session } from "../../src/session/session.js";

const SCRATCH = "/tmp/user/1000/grok-goal-00e3234b1d7c/implementer";
const OUT_DIR = join(SCRATCH, "e2e-out");
const LOG = join(SCRATCH, "e2e-imagine-video.log");

async function log(line: string): Promise<void> {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}\n`;
  process.stdout.write(msg);
  await mkdir(SCRATCH, { recursive: true });
  await writeFile(LOG, msg, { flag: "a" });
}

function openBrowser(url: string): void {
  // Best-effort open for the user to log in.
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function ensureXaiOauth(): Promise<string> {
  const existing = readXaiOauthAccessToken();
  if (existing) {
    const blob = readXaiOauthCredentials();
    await log(
      `Using stored OAuth token (account=${blob?.accountLabel ?? "unknown"}, len=${existing.length})`,
    );
    return existing;
  }

  await log("No stored OAuth token — starting browser /grok-login flow…");
  await log("A browser window should open; complete sign-in with X / Grok.");

  const login = await runXaiBrowserLogin({
    timeoutMs: 10 * 60 * 1000,
    onAuthorizeUrl: async (url) => {
      await log(`Authorize URL (also opening browser):\n${url}`);
      openBrowser(url);
    },
  });

  const blob = xaiOauthTokensToBlob(login.tokens, {
    tokenEndpoint: login.tokenEndpoint,
    accountLabel: login.identity.email ?? login.identity.sub,
  });
  const saved = saveXaiOauthCredentials(blob);
  if (!saved.success) {
    throw new Error(`Failed to store OAuth tokens: ${saved.warning ?? "unknown"}`);
  }
  const token = readXaiOauthAccessToken();
  if (!token) {
    throw new Error("OAuth login succeeded but token not readable from storage");
  }
  await log(
    `Login saved (account=${blob.accountLabel ?? "unknown"}, tokenLen=${token.length})`,
  );
  return token;
}

describe("LIVE e2e ImagineVideo", () => {
  it(
    "generates a short video via xAI with OAuth",
    { timeout: 15 * 60 * 1000 },
    async () => {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(LOG, ""); // reset

      const bearer = await ensureXaiOauth();
      expect(bearer.length).toBeGreaterThan(10);

      const provider = createProvider("grok", {
        // OAuth wins even if this were a fake key — we pass the real bearer.
        apiKey: bearer,
        model: "grok-4.5",
        baseURL: "https://api.x.ai/v1",
      });

      const tool = createImagineVideoTool({
        workspaceRoot: OUT_DIR,
        getSession: () =>
          ({
            services: { provider },
          }) as unknown as Session,
        env: {}, // force OAuth/session path, no BYOK
        pollIntervalMs: 5_000,
        pollTimeoutMs: 8 * 60 * 1000,
      });

      await log("Submitting ImagineVideo (text-to-video, ~6s, 480p)…");
      const result = await tool.execute({
        prompt:
          "A simple red rubber ball bouncing once on a white floor, studio lighting, no text",
        duration: 6,
        aspect_ratio: "16:9",
        resolution: "480p",
        model: "grok-imagine-video",
      });

      await log(`Tool isError=${result.isError ?? false}`);
      await log(`Tool content (truncated): ${result.content.slice(0, 800)}`);

      expect(result.isError).not.toBe(true);

      const parsed = JSON.parse(result.content) as {
        path?: string;
        request_id?: string;
        url?: string;
        error?: string;
      };
      expect(parsed.error).toBeUndefined();
      expect(parsed.path).toBeTruthy();
      expect(parsed.request_id).toBeTruthy();

      const st = await stat(parsed.path!);
      await log(
        `Video saved: ${parsed.path} (${st.size} bytes) request_id=${parsed.request_id}`,
      );
      expect(st.size).toBeGreaterThan(1000);

      // Sanity: file exists and is readable
      const head = await readFile(parsed.path!);
      expect(head.length).toBe(st.size);

      await log("E2E PASS");
    },
  );
});
