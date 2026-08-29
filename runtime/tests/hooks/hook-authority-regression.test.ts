import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../../src/hooks/configured-hooks.js";
import { createHookExecutionAuthority } from "../../src/hooks/execution-authority.js";
import { defaultConfig, type HooksMap } from "../../src/config/schema.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "../../src");
const temporaryDirectories: string[] = [];

function source(relativePath: string): string {
  return readFileSync(resolve(SOURCE_ROOT, relativePath), "utf8");
}

function productionSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.(?:ts|tsx)$/u.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) =>
    productionSources(resolve(path, entry)),
  );
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("hook authority regressions", () => {
  test("config reload preserves plugin hooks and installs each Stop command once", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-hook-authority-"));
    temporaryDirectories.push(root);
    const executionLog = join(root, "executions.log");
    const appendCommand = (label: string): string =>
      [
        JSON.stringify(process.execPath),
        "-e",
        JSON.stringify(
          "require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')",
        ),
        JSON.stringify(executionLog),
        JSON.stringify(label),
      ].join(" ");
    const configCommand = appendCommand("config");
    const replacementConfigCommand = appendCommand("replacement-config");
    const pluginCommand = appendCommand("plugin");
    const pluginHooks: HooksMap = {
      Stop: [{ hooks: [{ type: "command", command: pluginCommand }] }],
    };
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    const runtime = new ConfiguredHooksRuntime({
      cwd: root,
      env: {},
      agencHome: root,
      shellPath: "/bin/sh",
      admissionRequired: false,
      sandboxExecutionBroker: explicitDangerBroker,
      executionAuthority: createHookExecutionAuthority({
        runtimeOptions: { simpleMode: false, allowUntrustedHooks: false },
        isWorkspaceTrusted: () => true,
      }),
    });
    runtime.attachTarget(target);

    runtime.setPluginHooks(pluginHooks);
    runtime.loadConfigAuthority({
      config: {
        ...defaultConfig(),
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: configCommand }] }],
        },
      },
      layers: [],
    });
    runtime.loadConfigAuthority({
      config: {
        ...defaultConfig(),
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: replacementConfigCommand },
              ],
            },
          ],
        },
      },
      layers: [],
    });

    expect(
      runtime.listHooks().map((hook) => hook.command.command).sort(),
    ).toEqual([pluginCommand, replacementConfigCommand].sort());
    expect(target.stopHooks).toHaveLength(2);

    const request = {
      sessionId: "session",
      turnId: "turn",
      cwd: root,
      model: "test-model",
      permissionMode: "default",
      stopHookActive: false,
      lastIsApiErrorMessage: false,
    } as const;
    await Promise.all(target.stopHooks.map((hook) => hook.run(request)));

    expect(readFileSync(executionLog, "utf8").trim().split("\n").sort()).toEqual(
      ["plugin", "replacement-config"].sort(),
    );
  });

  test("registered callback hooks cannot read canonical config hooks", () => {
    const callbackRuntime = source("utils/hooks.ts");
    const hookHelpers = source("utils/hooks/hooksSettings.ts");

    expect(callbackRuntime).not.toMatch(
      /hooksConfigSnapshot|getHooksConfigFromSnapshot/u,
    );
    expect(callbackRuntime).not.toMatch(/(?:config|settings)\.hooks\b/u);
    expect(hookHelpers).not.toMatch(
      /\b(?:getAllHooks|getHooksForEvent|HookSource|IndividualHookConfig|hookSourceDescriptionDisplayString|hookSourceHeaderDisplayString|hookSourceInlineDisplayString|sortMatchersByPriority)\b/u,
    );
    expect(hookHelpers).not.toMatch(
      /settings\/settings|getSettingsForSource|getSettingsFilePathForSource|getSessionHooks|getSessionId/u,
    );

    const productionRawLoaders = productionSources(SOURCE_ROOT)
      .filter((path) => /\.loadForTesting\s*\(/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"));
    expect(productionRawLoaders).toEqual([]);
  });

  test("turn compatibility exposes canonical configured Stop hooks once", () => {
    const turnCompat = source("session/turn-compat.ts");

    expect(
      turnCompat.match(
        /configuredCompatStopHooks\(parent\.services\.hooks\)/gu,
      ),
    ).toHaveLength(1);
  });

  test("prompt ingress reuses the sole configured hook runtime authority", () => {
    const configuredRuntimeConstructionSites = productionSources(SOURCE_ROOT)
      .flatMap((path) => {
        const contents = readFileSync(path, "utf8");
        return Array.from(
          contents.matchAll(/\bnew\s+ConfiguredHooksRuntime\s*\(/gu),
          () => relative(SOURCE_ROOT, path).replaceAll("\\", "/"),
        );
      })
      .sort();
    expect(configuredRuntimeConstructionSites).toEqual([
      "bin/bootstrap-services.ts",
    ]);

    const cliOwner = source("bin/agenc-main.ts");
    expect(cliOwner).not.toMatch(/\bConfiguredHooksRuntime\b/u);
    expect(cliOwner).not.toMatch(/\bSandboxExecutionBroker\b/u);
    expect(cliOwner).not.toMatch(/\bcreateOneShotHookTarget\b/u);
    expect(cliOwner).not.toMatch(/\bprepareOneShotPromptForDaemon\b/u);

    for (const ingressOwner of [
      "bin/agenc-main.ts",
      "app-server/background-agent-runner.ts",
    ]) {
      const contents = source(ingressOwner);
      expect(contents).toMatch(
        /from\s+["']\.\.\/hooks\/user-prompt-ingress\.js["']/u,
      );
      expect(contents).toMatch(/\bprepareUserPromptForTurn\s*\(/u);
    }
  });

  test("hook authority has one runtime-option parser", () => {
    const duplicateResolverSites = productionSources(SOURCE_ROOT)
      .filter((path) =>
        /\bresolveAutomationAgentRuntimeOptions\b/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"));
    expect(duplicateResolverSites).toEqual([]);

    const environmentReaderSites = productionSources(SOURCE_ROOT)
      .filter((path) =>
        readFileSync(path, "utf8").includes("AGENC_ALLOW_UNTRUSTED_HOOKS"),
      )
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"));
    expect(environmentReaderSites).toEqual(["session/runtime-options.ts"]);

    const authorityConstructionSites = productionSources(SOURCE_ROOT)
      .filter((path) =>
        /\bcreateHookExecutionAuthority\s*\(/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"))
      .sort();
    expect(authorityConstructionSites).toEqual([
      "bin/bootstrap-services.ts",
      "hooks/execution-authority.ts",
    ]);

    expect(source("utils/hooks.ts")).not.toMatch(
      /shouldSkipHookDueToTrust|allowUntrustedHooksOptIn/u,
    );
    expect(source("hooks/configured-hooks.ts")).not.toMatch(
      /\ballowUntrustedHooks\b/u,
    );
  });

  test("obsolete config snapshot and file watcher are deleted", () => {
    expect(
      existsSync(resolve(SOURCE_ROOT, "utils/hooks/hooksConfigSnapshot.ts")),
    ).toBe(false);

    const snapshotImports = productionSources(SOURCE_ROOT)
      .filter((path) =>
        /(?:from\s+["'][^"']*hooksConfigSnapshot(?:\.js)?["']|\b(?:updateHooksConfigSnapshot|getHooksConfigFromSnapshot)\s*\()/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"));
    expect(snapshotImports).toEqual([]);

    expect(
      existsSync(resolve(SOURCE_ROOT, "utils/hooks/fileChangedWatcher.ts")),
    ).toBe(false);
    expect(source("utils/hooks/cwdChangedHooks.ts")).not.toMatch(
      /chokidar|FileChanged|initializeFileChangedWatcher|resolveWatchPaths|restartWatching|updateWatchPaths/u,
    );
  });
});
