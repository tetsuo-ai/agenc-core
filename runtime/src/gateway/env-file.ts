/**
 * Gateway secrets file — `<agencHome>/gateway/env` (task O-3/O-4 of
 * docs/onboarding.md; historical plan: docs/archive/onboarding-plan-2026-07.md).
 *
 * Channel tokens (Telegram/Discord/Slack, webchat/hooks overrides) need a
 * home that works for BOTH `agenc gateway run` and the gateway service
 * unit. A 0600 KEY=VALUE file is that home: the onboarding channel act
 * writes it, `agenc gateway run` merges it UNDER the real environment
 * (explicit env always wins), the systemd unit points EnvironmentFile at
 * it, and `sanitizeGatewayDaemonEnv` keeps every one of these names out of
 * the daemon.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function gatewayEnvFilePath(agencHome: string): string {
  return join(agencHome, "gateway", "env");
}

/** Parse the env file; missing/corrupt → empty (never throws). */
export function readGatewayEnvFile(
  agencHome: string,
): Record<string, string> {
  const path = gatewayEnvFilePath(agencHome);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } catch {
    return {};
  }
  return out;
}

/** Merge entries into the file (existing keys overwritten), 0600. */
export function writeGatewayEnvEntries(
  agencHome: string,
  entries: Readonly<Record<string, string>>,
): void {
  const merged = { ...readGatewayEnvFile(agencHome), ...entries };
  const path = gatewayEnvFilePath(agencHome);
  mkdirSync(join(agencHome, "gateway"), { recursive: true, mode: 0o700 });
  const body = [
    "# Gateway channel credentials — loaded by `agenc gateway run` and the",
    "# gateway service unit. Never committed, never passed to the daemon.",
    ...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600 });
}

/**
 * The environment `gateway run` should use: the env file's entries UNDER
 * the caller's environment — an explicitly exported variable always wins.
 */
export function mergeGatewayEnv(
  agencHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...readGatewayEnvFile(agencHome), ...env };
}
