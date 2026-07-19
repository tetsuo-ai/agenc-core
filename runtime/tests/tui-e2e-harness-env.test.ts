import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hasRenderedAssistantReply,
  isolatedHomeEnv,
  resolveHarnessAgencHome,
  tempDaemonEnv,
  tuiE2eGateEnv,
} from "../scripts/check-tui-e2e/harness.mjs";

describe("TUI E2E harness state isolation", () => {
  it("recognizes the current full-height assistant message gutter", () => {
    expect(
      hasRenderedAssistantReply([
        "                               │ AGENC",
        "                               │ OK",
      ]),
    ).toBe(true);
  });

  it("requires reply content inside the assistant message boundary", () => {
    expect(
      hasRenderedAssistantReply([
        "                               │ AGENC",
        "                               │ historical reply",
        "                               │ AGENC",
        "                               │",
        "                               ┌ composer chrome",
      ]),
    ).toBe(false);
    expect(
      hasRenderedAssistantReply([
        "                               │ AGENC",
        "",
        "                               │ unrelated pane text",
      ]),
    ).toBe(false);
    expect(
      hasRenderedAssistantReply([
        "                               ▮ AGENC",
        "                                 legacy reply",
      ]),
    ).toBe(true);
  });

  it("writes trust to AGENC_HOME when it differs from HOME", () => {
    expect(
      resolveHarnessAgencHome({
        AGENC_HOME: "/private/gate-state",
        HOME: "/private/gate-home",
      }),
    ).toBe("/private/gate-state");
    expect(resolveHarnessAgencHome({ HOME: "/private/gate-home" })).toBe(
      "/private/gate-home/.agenc",
    );
  });

  it("overrides ambient AgenC roots for a temporary scenario home", () => {
    const home = "/private/scenario-home";
    const env = isolatedHomeEnv(home, {
      AGENC_CONFIG_DIR: "/ambient/config",
      AGENC_HOME: "/ambient/state",
      HOME: "/ambient/home",
      SENTINEL: "preserved",
    });

    expect(env).toMatchObject({
      AGENC_CONFIG_DIR: join(home, ".agenc"),
      AGENC_HOME: join(home, ".agenc"),
      HOME: home,
      SENTINEL: "preserved",
    });
  });

  it("assembles a temporary daemon environment without ambient state leaks", () => {
    const home = "/private/scenario-home";
    const env = tempDaemonEnv(home, 19_876, {
      AGENC_CONFIG_DIR: "/ambient/config",
      AGENC_DAEMON_WEBSOCKET_PORT: "7766",
      AGENC_HOME: "/ambient/state",
      HOME: "/ambient/home",
      SENTINEL: "preserved",
    });

    expect(env).toMatchObject({
      AGENC_CONFIG_DIR: join(home, ".agenc"),
      AGENC_DAEMON_WEBSOCKET_PORT: "19876",
      AGENC_HOME: join(home, ".agenc"),
      HOME: home,
      SENTINEL: "preserved",
    });
  });

  it("disables ambient first-run onboarding for ordinary gate scenarios", () => {
    expect(
      tuiE2eGateEnv({ AGENC_ONBOARDING: "force", SENTINEL: "preserved" }),
    ).toEqual({ AGENC_ONBOARDING: "0", SENTINEL: "preserved" });
  });

  it("applies the deterministic gate environment in the runner", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );

    expect(runner).toContain('"AGENC_ONBOARDING",');
    expect(runner).toContain(
      "tuiE2eGateEnv(buildMockProviderEnv(mockServer.baseUrl, process.env))",
    );
  });

  it.each([
    "36-print-mode-basic.mjs",
    "37-print-mode-yolo.mjs",
    "55-stdin-not-tty.mjs",
    "58-cli-no-tui-flag.mjs",
  ])("isolates the manual temp-home child in %s", (scenario) => {
    const source = readFileSync(
      new URL(`../scripts/check-tui-e2e/scenarios/${scenario}`, import.meta.url),
      "utf8",
    );

    expect(source).toContain("env: tempDaemonEnv(home, wsPort)");
    expect(source).not.toMatch(/env:\s*\{[^}]*HOME:\s*home/su);
  });

  it.each([
    "31-permission-accept.mjs",
    "32-permission-deny.mjs",
    "33-permission-always.mjs",
  ])("keeps approval coverage while bypassing only the host sandbox in %s", (scenario) => {
    const source = readFileSync(
      new URL(`../scripts/check-tui-e2e/scenarios/${scenario}`, import.meta.url),
      "utf8",
    );

    expect(source).toContain('sandboxMode: "danger-full-access"');
    expect(source).toContain('args: ["--permission-mode", "default"]');
    expect(source).toContain('path.join(slimCwd, "package.json")');
    expect(source).not.toContain('args: ["--yolo"]');
  });

  it("configures a scenario-only sandbox override before starting its temp daemon", () => {
    const harness = readFileSync(
      new URL("../scripts/check-tui-e2e/harness.mjs", import.meta.url),
      "utf8",
    );
    const configIndex = harness.indexOf(
      '[BIN_AGENC, "config", "set", "sandbox_mode", sandboxMode]',
    );
    const daemonIndex = harness.indexOf('[BIN_AGENC, "daemon", "start"]');

    expect(configIndex).toBeGreaterThan(-1);
    expect(daemonIndex).toBeGreaterThan(configIndex);
  });
});
