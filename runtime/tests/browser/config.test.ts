/**
 * resolveBrowserPolicy consumes only the canonical resolved config snapshot.
 */

import { describe, expect, test } from "vitest";
import { resolveBrowserPolicy } from "../../src/browser/config.js";
import { applyEnvOverrides } from "../../src/config/env.js";
import { defaultConfig, type BrowserConfig } from "../../src/config/schema.js";

describe("resolveBrowserPolicy", () => {
  test("defaults: headless on, private network OFF, no --no-sandbox", () => {
    const policy = resolveBrowserPolicy();
    expect(policy.headless).toBe(true);
    expect(policy.allowPrivateNetwork).toBe(false);
    expect(policy.noSandbox).toBe(false);
    expect(policy.navigationTimeoutMs).toBe(30_000);
    expect(policy.executablePath).toBeUndefined();
  });

  test("reads values from the [browser] config block", () => {
    const config: BrowserConfig = {
      executable_path: "/opt/chrome",
      headless: false,
      allow_private_network: true,
      profile_dir: "/tmp/p",
      no_sandbox: true,
      navigation_timeout_ms: 12_000,
    };
    const policy = resolveBrowserPolicy(config);
    expect(policy.executablePath).toBe("/opt/chrome");
    expect(policy.headless).toBe(false);
    expect(policy.allowPrivateNetwork).toBe(true);
    expect(policy.profileDir).toBe("/tmp/p");
    expect(policy.noSandbox).toBe(true);
    expect(policy.navigationTimeoutMs).toBe(12_000);
  });

  test("canonical environment layering overrides the TOML-shaped block", () => {
    const config: BrowserConfig = {
      allow_private_network: false,
      headless: true,
      executable_path: "/opt/chrome",
    };
    const env: NodeJS.ProcessEnv = {
      AGENC_BROWSER_ALLOW_PRIVATE_NETWORK: "1",
      AGENC_BROWSER_HEADLESS: "off",
      AGENC_BROWSER_EXECUTABLE: "/usr/bin/brave-browser",
      AGENC_BROWSER_NAV_TIMEOUT_MS: "5000",
    };
    const resolved = applyEnvOverrides(
      { ...defaultConfig(), browser: config },
      env,
    );
    const policy = resolveBrowserPolicy(resolved.browser);
    expect(policy.allowPrivateNetwork).toBe(true);
    expect(policy.headless).toBe(false);
    expect(policy.executablePath).toBe("/usr/bin/brave-browser");
    expect(policy.navigationTimeoutMs).toBe(5_000);
  });

  test("clamps out-of-range navigation timeouts", () => {
    expect(
      resolveBrowserPolicy({ navigation_timeout_ms: 10 })
        .navigationTimeoutMs,
    ).toBe(1_000);
    expect(
      resolveBrowserPolicy({ navigation_timeout_ms: 10_000_000 })
        .navigationTimeoutMs,
    ).toBe(300_000);
  });

  test("canonical layer warns on invalid values and preserves config", () => {
    const warnings: string[] = [];
    const resolved = applyEnvOverrides(
      { ...defaultConfig(), browser: { headless: false } },
      { AGENC_BROWSER_HEADLESS: "maybe" },
      (warning) => warnings.push(warning),
    );
    const policy = resolveBrowserPolicy(resolved.browser);
    expect(policy.headless).toBe(false);
    expect(warnings).toEqual([
      expect.stringContaining("AGENC_BROWSER_HEADLESS"),
    ]);
  });

  test("a truthy non-boolean toggle never fails open (=== true coercion)", () => {
    // An operator writing allow_private_network = "off" (a truthy string)
    // intending to keep the guard on must NOT accidentally open the policy.
    const policy = resolveBrowserPolicy({
      allow_private_network: "off" as unknown as boolean,
      no_sandbox: "off" as unknown as boolean,
    });
    expect(policy.allowPrivateNetwork).toBe(false);
    expect(policy.noSandbox).toBe(false);
  });
});
