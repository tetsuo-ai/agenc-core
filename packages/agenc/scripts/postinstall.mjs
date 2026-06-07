#!/usr/bin/env node
// Runs on `npm install @tetsuo-ai/agenc`. Pre-fetches the platform runtime so
// the first `agenc` invocation is fast. Best-effort: a failure here (offline
// install, CI, etc.) is NOT fatal — the launcher fetches lazily on first run.

// Skip in obviously non-interactive / packaging contexts.
if (process.env.AGENC_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
  process.exit(0);
}

try {
  const { ensureRuntime } = await import("../lib/runtime-manager.mjs");
  await ensureRuntime();
} catch (err) {
  process.stderr.write(
    `agenc: runtime pre-fetch skipped (${err?.message ?? err}); it will be fetched on first run.\n`,
  );
  // Non-fatal by design.
}
