import { describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../../src/config/home.js";
import { runWithCurrentRuntimeSession } from "../../../src/session/current-session.js";
import {
  runWithAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../../../src/session/runtime-options.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";

const { writeToMailbox } = vi.hoisted(() => ({
  writeToMailbox: vi.fn(async () => undefined),
}));

vi.mock("../../../src/bootstrap/state.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSessionId: () => "parent-session",
  getChromeFlagOverride: () => undefined,
  getInlinePlugins: () => [],
}));
vi.mock("../../../src/utils/bundledMode.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isInBundledMode: () => false,
}));
vi.mock(
  "../../../src/utils/swarm/backends/teammateModeSnapshot.js",
  () => ({ getTeammateModeFromSnapshot: () => "tmux" }),
);
vi.mock("../../../src/utils/swarm/backends/detection.js", () => ({
  isInsideTmux: async () => true,
}));
vi.mock("../../../src/utils/teammateMailbox.js", () => ({
  writeToMailbox,
}));
vi.mock("../../../src/utils/cleanupRegistry.js", () => ({
  registerCleanup: vi.fn(),
}));
vi.mock("../../../src/utils/debug.js", () => ({
  logForDebugging: vi.fn(),
}));

import { PaneBackendExecutor } from "../../../src/utils/swarm/backends/PaneBackendExecutor.js";

function settingsAuthority(home: string) {
  return {
    current: () => ({}),
    sources: () => [],
    projectRoot: "/tmp/agenc-pane-workspace",
    homeContext: resolveHomeContext({ AGENC_HOME: home }),
    stateRepository: { getNamespace: () => ({}) },
    reload: async () => {},
    subscribe: () => {},
  } as never;
}

describe("PaneBackendExecutor runtime authority", () => {
  test("spawns a bare teammate with the complete captured provider and runtime projection", async () => {
    const sendCommandToPane = vi.fn(async () => undefined);
    const backend = {
      type: "tmux",
      isAvailable: async () => true,
      createTeammatePaneInSwarmView: async () => ({
        paneId: "%17",
        isFirstTeammate: false,
      }),
      enablePaneBorderStatus: vi.fn(async () => undefined),
      sendCommandToPane,
      killPane: vi.fn(async () => undefined),
    };
    const executor = new PaneBackendExecutor(backend as never);
    executor.setContext({
      getAppState: () => ({
        toolPermissionContext: { mode: "default" },
      }),
    } as never);
    const runtimeOptions = Object.freeze({
      simpleMode: true,
      stdinDataMode: false,
      remoteMode: false,
      posixShellPath: "/bin/zsh",
      commandWrapperArgv: Object.freeze([
        "env",
        "PANE_BOUND=1",
        "/bin/zsh",
        "-c",
      ]),
      sessionTempRoot: "/tmp/agenc-pane-session-temp",
      pluginStorageRoot: "/tmp/agenc-pane-plugin-storage",
      allowUntrustedHooks: true,
    }) satisfies AgentRuntimeOptions;
    const runtimeSession = {
      services: {
        runtimeOptions,
        configStore: {
          homeContext: resolveHomeContext({
            AGENC_HOME: "/tmp/agenc-pane-home",
          }),
        },
        providerService: {
          current: () => ({ provider: "grok", model: "grok-4.6" }),
          environment: () => ({
            AGENC_MODEL: "stale-leader-model",
            PATH: "/pane/captured/bin:/usr/bin",
            XAI_API_KEY: "pane-xai-key",
            ANTHROPIC_API_KEY: "pane-anthropic-key",
            OPENROUTER_API_KEY: "pane-openrouter-key",
          }),
        },
        userShell: {
          childEnvironment: {
            HOME: "/tmp/agenc-pane-user",
            PATH: "/pane/captured/bin:/usr/bin",
            TERM: "xterm-256color",
            AGENC_MODEL: "stale-pane-model",
            AGENC_SHELL_PREFIX: "stale-pane-wrapper",
            AGENC_WORKSPACE: "/tmp/stale-pane-workspace",
            AGENC_PROJECT_DIR: "/tmp/stale-pane-project",
            PWD: "/tmp/stale-pane-pwd",
            OPENAI_API_KEY: "stale-pane-openai-key",
          },
        },
      },
    } as never;

    const result = await runWithCanonicalSettingsAuthority(
      settingsAuthority("/tmp/agenc-pane-home"),
      () =>
        runWithStartupProviderSelection(
          {
            provider: "grok",
            model: "grok-4.6",
            environment: {
              AGENC_MODEL: "stale-leader-model",
              XAI_API_KEY: "pane-xai-key",
              ANTHROPIC_API_KEY: "pane-anthropic-key",
              OPENROUTER_API_KEY: "pane-openrouter-key",
            },
          },
          () =>
            runWithAgentRuntimeOptions(runtimeOptions, () =>
              runWithCurrentRuntimeSession(runtimeSession, () =>
                executor.spawn({
                  name: "worker",
                  teamName: "authority-team",
                  prompt: "Inspect the runtime authority.",
                  parentSessionId: "parent-session",
                  cwd: "/tmp/agenc-pane-workspace",
                  model: "worker-model",
                } as never),
              ),
            ),
        ),
    );

    expect(result).toMatchObject({ success: true, paneId: "%17" });
    expect(sendCommandToPane).toHaveBeenCalledOnce();
    const command = String(sendCommandToPane.mock.calls[0]?.[1]);
    expect(command).toContain("env -i --");
    expect(command).toContain("--bare");
    expect(command).toContain("--model worker-model");
    expect(command.match(/--model /gu)).toHaveLength(1);
    expect(command).not.toMatch(/AGENC_MODEL(?:=|\\=)/u);
    expect(command).not.toContain("stale-leader-model");
    expect(command).not.toContain("stale-pane-model");
    expect(command).not.toContain("stale-pane-wrapper");
    expect(command).not.toContain("stale-pane-openai-key");
    expect(command).not.toContain("stale-pane-workspace");
    expect(command).not.toContain("stale-pane-project");
    expect(command).not.toContain("stale-pane-pwd");
    expect(command).toContain("pane/captured/bin");
    expect(command).toContain("--teammate-mode tmux");
    expect(command).toContain("AGENC_PROVIDER\\=grok");
    expect(command).toContain("XAI_API_KEY\\=pane-xai-key");
    expect(command).toContain("ANTHROPIC_API_KEY\\=pane-anthropic-key");
    expect(command).toContain("OPENROUTER_API_KEY\\=pane-openrouter-key");
    expect(command).toContain("AGENC_SHELL\\=/bin/zsh");
    expect(command).toContain("PANE_BOUND\\=1");
    expect(command).toContain("AGENC_TMPDIR\\=/tmp/agenc-pane-session-temp");
    expect(command).toContain(
      "AGENC_PLUGIN_CACHE_DIR\\=/tmp/agenc-pane-plugin-storage",
    );
    expect(command).toContain("AGENC_ALLOW_UNTRUSTED_HOOKS\\=1");
    expect(command).not.toContain("AGENC_SIMPLE");
    expect(writeToMailbox).toHaveBeenCalledOnce();
  });
});
