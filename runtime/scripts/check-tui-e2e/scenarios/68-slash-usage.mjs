/**
 * /usage scenario.
 *
 * /usage shows a Providers section with every connected provider that has a usage API. The gate's only such key is a
 * DeepSeek key whose endpoint refuses connections, so the DeepSeek row must
 * fail on its own line without holding up the command. /usage ollama must
 * then say Ollama Cloud is not connected. No request leaves the machine.
 */
import { waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description:
    "/usage shows providers, a failing provider gets one line, and /usage <provider> answers.",
  env: {
    DEEPSEEK_API_KEY: "tui-e2e-usage-key",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1",
  },
  timeoutMs: 60_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/usage");
  await waitForFrameText(
    session,
    /Providers[\s\S]*DeepSeek\s+usage unavailable \((network error|timed out)\)/u,
    "/usage provider failure line",
    15_000,
  );
  await session.waitForIdle({ timeout: 15_000 });
  if (session.latestFrame.includes("AgenC account")) {
    throw new Error("/usage must not show account model usage");
  }
  await session.submitSlashCommand("/usage ollama");
  await waitForFrameText(
    session,
    /Ollama Cloud is not connected\. Set OLLAMA_API_KEY, or connect it in \/provider\./u,
    "/usage ollama without a key",
    15_000,
  );
  await session.waitForIdle({ timeout: 15_000 });
  if (session.raw.includes("tui-e2e-usage-key")) {
    throw new Error("/usage printed the provider key");
  }
  session.assertNoCrash();
}
