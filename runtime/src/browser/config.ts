/**
 * `[browser]` policy resolution for the built-in browser tool.
 *
 * Environment layering happens once in `config/env.ts`; this module projects
 * an already-resolved `[browser]` snapshot onto the runtime policy. Operational settings only —
 * whether the tool appears on the surface at all is governed by the existing
 * `tools_config` enable/disable path (the tool name is `Browser`).
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

function clampTimeout(value: number | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return DEFAULT_NAV_TIMEOUT_MS;
  }
  return Math.max(MIN_NAV_TIMEOUT_MS, Math.min(MAX_NAV_TIMEOUT_MS, value));
}

/**
 * Resolve the effective browser policy from an already-layered `[browser]`
 * config block. Never reads process-global environment state.
 */
export function resolveBrowserPolicy(config?: BrowserConfig): BrowserPolicy {
  const executablePath = nonEmpty(config?.executable_path);
  const headless = config?.headless ?? true;
  // Security-relevant toggles coerce with `=== true`: only a real boolean true
  // opens the policy. A truthy non-boolean (e.g. the string "off" an operator
  // might write intending to DISABLE the flag) must never fail open.
  const allowPrivateNetwork = config?.allow_private_network === true;
  const profileDir = nonEmpty(config?.profile_dir);
  const noSandbox = config?.no_sandbox === true;
  const navigationTimeoutMs = clampTimeout(config?.navigation_timeout_ms);

  return {
    ...(executablePath !== undefined ? { executablePath } : {}),
    headless,
    allowPrivateNetwork,
    ...(profileDir !== undefined ? { profileDir } : {}),
    noSandbox,
    navigationTimeoutMs,
  };
}
