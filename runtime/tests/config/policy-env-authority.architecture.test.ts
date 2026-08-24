import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { DAEMON_CLIENT_ENV_SNAPSHOT_KEYS } from "../../src/app-server/client-env-snapshot.js";

const SOURCE = resolve(import.meta.dirname, "../../src");
const POLICY_MODULES = [
  "browser/config.ts",
  "budget/config.ts",
  "heartbeat/config.ts",
  "transaction-guard/config.ts",
] as const;
const POLICY_ENV_KEYS = [
  "AGENC_BROWSER_EXECUTABLE",
  "AGENC_BROWSER_HEADLESS",
  "AGENC_BROWSER_ALLOW_PRIVATE_NETWORK",
  "AGENC_BROWSER_PROFILE_DIR",
  "AGENC_BROWSER_NO_SANDBOX",
  "AGENC_BROWSER_NAV_TIMEOUT_MS",
  "AGENC_BUDGET",
  "AGENC_BUDGET_DAILY_USD",
  "AGENC_BUDGET_MONTHLY_USD",
  "AGENC_BUDGET_DAILY_TOKENS",
  "AGENC_BUDGET_MONTHLY_TOKENS",
  "AGENC_BUDGET_SOFT_THRESHOLD",
  "AGENC_BUDGET_ENFORCE_INTERACTIVE",
  "AGENC_HEARTBEAT",
  "AGENC_HEARTBEAT_INTERVAL",
  "AGENC_HEARTBEAT_ACTIVE_HOURS",
  "AGENC_HEARTBEAT_TARGET",
  "AGENC_TRANSACTION_GUARD",
  "AGENC_TRANSACTION_GUARD_MODEL",
  "AGENC_TRANSACTION_GUARD_OLLAMA_URL",
  "AGENC_TRANSACTION_GUARD_FAIL_MODE",
  "AGENC_TRANSACTION_GUARD_TIMEOUT_MS",
  "AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES",
] as const;

describe("canonical policy environment authority", () => {
  test("downstream policy projectors never implement environment precedence", () => {
    for (const relative of POLICY_MODULES) {
      const source = readFileSync(resolve(SOURCE, relative), "utf8");
      expect(source, relative).not.toMatch(/process\.env|NodeJS\.ProcessEnv/);
      expect(source, relative).not.toMatch(/\bAGENC_[A-Z0-9_]+\b/);
    }
  });

  test("every policy env key is captured both by ConfigStore and client snapshots", () => {
    const envSource = readFileSync(resolve(SOURCE, "config/env.ts"), "utf8");
    const overrideSource = envSource.slice(
      envSource.indexOf("export function applyEnvOverrides"),
    );
    for (const key of POLICY_ENV_KEYS) {
      expect(envSource, key).toContain(`readonly ${key}?: string`);
      expect(overrideSource, key).toContain(key);
      expect(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS, key).toContain(key);
    }
  });
});
