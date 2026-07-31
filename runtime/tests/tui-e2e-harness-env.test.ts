import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  TuiSession,
  hasRenderedAssistantReply,
  isolatedHomeEnv,
  resolveHarnessAgencHome,
  tempDaemonEnv,
  tuiE2eGateEnv,
} from "../scripts/check-tui-e2e/harness.mjs";
import {
  runScenario,
  shouldSeedTuiGateDefaultConfig,
} from "../scripts/check-tui-e2e/runner.mjs";
import {
  createTuiGateState,
  teardownTuiGateState,
  tuiGateEnvironment,
} from "../scripts/tui-gate-state.mjs";

describe("TUI E2E harness state isolation", () => {
  it("recognizes the current full-height assistant message gutter", () => {
    expect(
      hasRenderedAssistantReply([
        "                               │ AGENC",
        "                               │ OK",
      ]),
    ).toBe(true);
  });

  it("recognizes a compact workbench reply aligned below its user prompt", () => {
    expect(
      hasRenderedAssistantReply([
        " │ ▾ project                         ❯ hi                                                        │",
        " │     package.json                                                                                │",
        " │     README.md                       OK                                                         │",
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
    expect(
      hasRenderedAssistantReply([
        " │ ▾ project                         ❯ hi                                                        │",
        " │     package.json                                                              Delegate work │",
        " │                                                                                              │",
        " │ ┌ composer chrome                                                                           │",
      ]),
    ).toBe(false);
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

  it("replaces ambient state roots and drops unrelated operator values", () => {
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
      USERPROFILE: home,
      AGENC_AUTH_BACKEND: "local",
      AGENC_DAEMON_WEBSOCKET_PORT: "0",
      TMPDIR: join(home, "tmp"),
    });
    expect(env.SENTINEL).toBeUndefined();
  });

  it("always requests an ephemeral daemon port", () => {
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
      AGENC_DAEMON_WEBSOCKET_PORT: "0",
      AGENC_HOME: join(home, ".agenc"),
      HOME: home,
    });
    expect(env.SENTINEL).toBeUndefined();
  });

  it("disables ambient first-run onboarding for ordinary gate scenarios", () => {
    expect(
      tuiE2eGateEnv({ AGENC_ONBOARDING: "force", SENTINEL: "preserved" }),
    ).toEqual({ AGENC_ONBOARDING: "0", SENTINEL: "preserved" });
  });

  it("applies private state lifecycle in the runner without ambient daemon control", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );

    expect(runner).toContain("createTuiGateState({");
    expect(runner).toContain("startTuiGateDaemon(gateState, BIN_AGENC)");
    expect(runner).toContain("teardownTuiGateState(gateState, BIN_AGENC)");
    expect(runner).not.toContain("DEFAULT_DAEMON_SOCKET");
    expect(runner).not.toContain("restartDaemon()");
  });

  it("removes embedded-Neovim workspaces only after PTY cleanup", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );
    const runScenarioStart = runner.indexOf(
      "export async function runScenario(",
    );
    const sessionCleanup = runner.indexOf(
      "await session.cleanup();",
      runScenarioStart,
    );
    const scenarioReturn = runner.indexOf("\n  return {", sessionCleanup);
    const runScenarioEntryStart = runner.indexOf(
      "async function runScenarioEntry(",
      scenarioReturn,
    );
    const scenarioRun = runner.indexOf(
      "result = await runScenario(",
      runScenarioEntryStart,
    );
    const gateTeardown = runner.indexOf(
      "await teardownTuiGateState(gateState, BIN_AGENC);",
      scenarioRun,
    );

    expect(runScenarioStart).toBeGreaterThan(-1);
    expect(sessionCleanup).toBeGreaterThan(runScenarioStart);
    expect(scenarioReturn).toBeGreaterThan(sessionCleanup);
    expect(runScenarioEntryStart).toBeGreaterThan(scenarioReturn);
    expect(scenarioRun).toBeGreaterThan(runScenarioEntryStart);
    expect(gateTeardown).toBeGreaterThan(scenarioRun);

    for (const scenario of [
      "120-workbench-buffer-neovim.mjs",
      "121-workbench-buffer-neovim-missing-fallback.mjs",
      "122-workbench-buffer-neovim-kill-cleanup.mjs",
      "123-workbench-buffer-neovim-runtime-exit.mjs",
      "124-workbench-buffer-neovim-visual-render.mjs",
      "130-workbench-buffer-neovim-platform-gate.mjs",
      "131-workbench-buffer-neovim-platform-kill-cleanup.mjs",
    ]) {
      const source = readFileSync(
        new URL(
          `../scripts/check-tui-e2e/scenarios/${scenario}`,
          import.meta.url,
        ),
        "utf8",
      );
      expect(source).toContain("mkdtemp(join(tmpdir(),");
      expect(source).toContain("Windows cannot delete a live process cwd.");
      expect(source).not.toMatch(/\brm\s*\(/u);
    }
  });

  it("forces deterministic gate controls after scenario overrides", () => {
    const env = tuiGateEnvironment("/private/gate", {
      AGENC_AUTH_BACKEND: "remote",
      AGENC_DAEMON_WEBSOCKET_HOST: "0.0.0.0",
      AGENC_DAEMON_WEBSOCKET_PORT: "7766",
      AGENC_ONBOARDING: "force",
      NODE_OPTIONS: "--inspect=9229",
      OPENAI_API_KEY: "operator-secret",
    });

    expect(env).toMatchObject({
      AGENC_AUTH_BACKEND: "local",
      AGENC_DAEMON_WEBSOCKET_HOST: "127.0.0.1",
      AGENC_DAEMON_WEBSOCKET_PORT: "0",
      AGENC_ONBOARDING: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      NODE_OPTIONS: "",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each([
    "36-print-mode-basic.mjs",
    "37-print-mode-yolo.mjs",
    "55-stdin-not-tty.mjs",
    "58-cli-no-tui-flag.mjs",
  ])("uses the runner-owned tracked child in %s", (scenario) => {
    const source = readFileSync(
      new URL(`../scripts/check-tui-e2e/scenarios/${scenario}`, import.meta.url),
      "utf8",
    );

    expect(source).toContain("session.runAgenc");
    expect(source).not.toContain("createTempHome");
    expect(source).not.toContain("tempDaemonEnv");
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
    expect(source).toContain("slimCwd: true");
    expect(source).not.toContain("mkdtemp");
    expect(source).not.toContain('args: ["--yolo"]');
  });

  it("configures a scenario-only sandbox override before starting its temp daemon", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );
    const configIndex = runner.indexOf("await configureTuiGateSandbox(");
    const daemonIndex = runner.indexOf(
      "await startTuiGateDaemon(gateState, BIN_AGENC)",
    );

    expect(configIndex).toBeGreaterThan(-1);
    expect(daemonIndex).toBeGreaterThan(configIndex);
  });

  it("seeds prediction-off state before ordinary scenario daemons while preserving first-use consent coverage", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );
    const scenarioEntryIndex = runner.indexOf(
      "async function runScenarioEntry(",
    );
    const environmentIndex = runner.indexOf(
      "gateState.env = environmentForTuiGateState(",
      scenarioEntryIndex,
    );
    const configIndex = runner.indexOf(
      "await writeTuiGateDefaultConfig(gateState);",
      scenarioEntryIndex,
    );
    const sandboxIndex = runner.indexOf(
      "await configureTuiGateSandbox(",
      scenarioEntryIndex,
    );
    const daemonIndex = runner.indexOf(
      "await startTuiGateDaemon(gateState, BIN_AGENC)",
      scenarioEntryIndex,
    );

    expect(scenarioEntryIndex).toBeGreaterThan(-1);
    expect(environmentIndex).toBeGreaterThan(scenarioEntryIndex);
    expect(configIndex).toBeGreaterThan(environmentIndex);
    expect(sandboxIndex).toBeGreaterThan(configIndex);
    expect(daemonIndex).toBeGreaterThan(sandboxIndex);
    expect(shouldSeedTuiGateDefaultConfig({})).toBe(true);
    expect(
      shouldSeedTuiGateDefaultConfig({ firstUsePredictionConsent: false }),
    ).toBe(true);
    expect(
      shouldSeedTuiGateDefaultConfig({ firstUsePredictionConsent: true }),
    ).toBe(false);
    expect(() =>
      shouldSeedTuiGateDefaultConfig({
        firstUsePredictionConsent: "yes",
      }),
    ).toThrow(/must be boolean/u);

    const ordinaryScenarios = [
      "130-workbench-buffer-neovim-platform-gate.mjs",
      "131-workbench-buffer-neovim-platform-kill-cleanup.mjs",
    ].map((scenario) =>
      readFileSync(
        new URL(
          `../scripts/check-tui-e2e/scenarios/${scenario}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const consentScenario = readFileSync(
      new URL(
        "../scripts/check-tui-e2e/scenarios/133-editor-code-prediction.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    for (const source of ordinaryScenarios) {
      expect(source).not.toContain("firstUsePredictionConsent");
    }
    expect(consentScenario).toContain("firstUsePredictionConsent: true");
    expect(consentScenario).toContain("Enable editor code predictions");
    expect(consentScenario).toContain('session.send("\\x1by")');
  });

  it("keeps /init writes out of the source checkout", () => {
    const source = readFileSync(
      new URL(
        "../scripts/check-tui-e2e/scenarios/18-slash-init.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("slimCwd: true");
  });

  it("refuses an ambient TUI session without private gate ownership", async () => {
    const session = new TuiSession();
    await expect(session.prepare()).rejects.toThrow(
      /requires runner-owned gate state or useTempHome isolation/u,
    );
  });

  it("omits unsupported node-pty signals when terminating on Windows", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (platformDescriptor === undefined) {
      throw new Error("process.platform descriptor is unavailable");
    }
    const kill = vi.fn((signal?: string) => {
      if (signal !== undefined) {
        throw new Error("Signals not supported on windows.");
      }
    });
    const session = new TuiSession();
    session.term = { kill } as typeof session.term;

    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "win32",
    });
    try {
      session.kill("SIGKILL");
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith();
  });

  it("gives every scenario a private clean git fixture", () => {
    const runner = readFileSync(
      new URL("../scripts/check-tui-e2e/runner.mjs", import.meta.url),
      "utf8",
    );
    const gateState = readFileSync(
      new URL("../scripts/tui-gate-state.mjs", import.meta.url),
      "utf8",
    );
    const commitScenario = readFileSync(
      new URL(
        "../scripts/check-tui-e2e/scenarios/25-slash-commit.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    expect(runner).toContain("createTuiGateProject(gateState");
    expect(runner).toContain("dirty: scenario.meta.dirtyCwd === true");
    expect(runner).toContain('{ cwd: scenarioCwd }');
    expect(gateState).toContain(
      '["init", "--quiet", "--initial-branch=main"]',
    );
    expect(gateState).toContain('if (dirty) {');
    expect(gateState).toContain('trackedFiles.push("diff-fixture.txt")');
    expect(commitScenario).toContain("runner-owned clean git fixture");
  });

  it("cancels tracked children and waits for scenario quiescence on timeout", async () => {
    const gateState = await createTuiGateState({
      prefix: "agenc-tui-timeout-test-",
    });
    let childPid: number | undefined;
    try {
      const result = await runScenario(
        {
          name: "timeout-test.mjs",
          meta: { timeoutMs: 50 },
          run: async (session: TuiSession) => {
            const child = await session.spawnTracked(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { stdio: "ignore" },
            );
            childPid = child.pid;
            await session.waitForChildClose(child, 5_000);
          },
        },
        gateState,
      );

      expect(result.ok).toBe(false);
      expect(result.quiesced).toBe(true);
      expect(result.error?.message).toMatch(/scenario timeout/u);
      expect(result.session.cwd).toBe(join(gateState.root, "project"));
      expect(childPid).toBeTypeOf("number");
      expect(() => process.kill(childPid!, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      await teardownTuiGateState(gateState);
    }
  });
});
