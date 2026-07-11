/**
 * `[browser]` policy resolution for the built-in browser tool.
 *
 * Precedence is the repo-standard env > config > built-in default, mirroring
 * `heartbeat/config.ts` and `budget/config.ts`. Operational settings only —
 * whether the tool appears on the surface at all is governed by the existing
 * `tools_config` enable/disable path (the tool name is `Browser`).
 *
 * Env vars:
 *   AGENC_BROWSER_EXECUTABLE             absolute path to a Chromium binary
 *   AGENC_BROWSER_HEADLESS               on/off (default on)
 *   AGENC_BROWSER_ALLOW_PRIVATE_NETWORK  on/off (default off) — SSRF opt-out
 *   AGENC_BROWSER_PROFILE_DIR            dedicated profile dir override
 *   AGENC_BROWSER_NO_SANDBOX             on/off (default off) — Chromium --no-sandbox
 *   AGENC_BROWSER_NAV_TIMEOUT_MS         navigation timeout (default 30000)
 *
 * @module
 */

import type { BrowserConfig } from "../config/schema.js";

export interface BrowserPolicy {
  readonly executablePath?: string;
  readonly headless: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly profileDir?: string;
  readonly noSandbox: boolean;
  readonly navigationTimeoutMs: number;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const MIN_NAV_TIMEOUT_MS = 1_000;
const MAX_NAV_TIMEOUT_MS = 300_000;

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  const v = nonEmpty(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const v = nonEmpty(value);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_NAV_TIMEOUT_MS;
  return Math.max(MIN_NAV_TIMEOUT_MS, Math.min(MAX_NAV_TIMEOUT_MS, value));
}

/**
 * Resolve the effective browser policy from an optional `[browser]` config
 * block and the environment. Never throws — invalid values fall back to the
 * next precedence tier.
 */
export function resolveBrowserPolicy(
  config?: BrowserConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserPolicy {
  const executablePath =
    nonEmpty(env.AGENC_BROWSER_EXECUTABLE) ?? nonEmpty(config?.executable_path);
  const headless =
    parseBool(env.AGENC_BROWSER_HEADLESS) ?? config?.headless ?? true;
  // Security-relevant toggles coerce with `=== true`: only a real boolean true
  // opens the policy. A truthy non-boolean (e.g. the string "off" an operator
  // might write intending to DISABLE the flag) must never fail open.
  const allowPrivateNetwork =
    parseBool(env.AGENC_BROWSER_ALLOW_PRIVATE_NETWORK) ??
    config?.allow_private_network === true;
  const profileDir =
    nonEmpty(env.AGENC_BROWSER_PROFILE_DIR) ?? nonEmpty(config?.profile_dir);
  const noSandbox =
    parseBool(env.AGENC_BROWSER_NO_SANDBOX) ?? config?.no_sandbox === true;
  const navigationTimeoutMs = clampTimeout(
    parsePositiveInt(env.AGENC_BROWSER_NAV_TIMEOUT_MS) ??
      config?.navigation_timeout_ms,
  );

  return {
    ...(executablePath !== undefined ? { executablePath } : {}),
    headless,
    allowPrivateNetwork,
    ...(profileDir !== undefined ? { profileDir } : {}),
    noSandbox,
    navigationTimeoutMs,
  };
}
