import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const repositoryRoot = resolve(import.meta.dirname, "../../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("retired print relay architecture", () => {
  test("does not restore event relays without production consumers", () => {
    const retiredFiles = [
      resolve(sourceRoot, "utils/commandLifecycle.ts"),
      resolve(sourceRoot, "utils/sessionState.ts"),
      resolve(sourceRoot, "utils/awsAuthStatusManager.ts"),
    ];
    const retiredImport =
      /from\s+["'][^"']*(?:commandLifecycle|sessionState|awsAuthStatusManager)\.js["']/u;
    const importViolations = sourceFiles(sourceRoot).flatMap((path) =>
      retiredImport.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : [],
    );

    expect(retiredFiles.map((path) => existsSync(path))).toEqual([
      false,
      false,
      false,
    ]);
    expect(importViolations).toEqual([]);
  });

  test("keeps command consumption and AppState observation free of dead bookkeeping", () => {
    const runTurn = readFileSync(
      resolve(sourceRoot, "session/run-turn.ts"),
      "utf8",
    );
    const appStateObserver = readFileSync(
      resolve(sourceRoot, "tui/state/onChangeAppState.ts"),
      "utf8",
    );

    expect(runTurn).not.toMatch(
      /\b(?:notifyCommandLifecycle|consumedCommandUuids|returnTerminal)\b/u,
    );
    expect(appStateObserver).not.toMatch(
      /\b(?:externalMetadataToAppState|notifyPermissionModeChanged|notifySessionMetadataChanged)\b/u,
    );
  });

  test("preserves the live daemon and SDK notification registries", () => {
    const sdkClient = readFileSync(
      resolve(repositoryRoot, "packages/agenc-sdk/src/client.ts"),
      "utf8",
    );
    const daemonClient = readFileSync(
      resolve(sourceRoot, "app-server/agent-cli.ts"),
      "utf8",
    );
    const cli = readFileSync(resolve(sourceRoot, "bin/agenc-main.ts"), "utf8");

    expect(sdkClient).toContain("onNotification(");
    expect(sdkClient).toContain("onSessionNotification(");
    expect(daemonClient).toContain("sessionListeners");
    expect(daemonClient).toContain("notificationListeners");
    expect(cli).toContain("subscribeToSessionEvents(");
  });

  test("does not restore the shadow process-signal installer", () => {
    const gracefulShutdownSource = readFileSync(
      resolve(sourceRoot, "utils/gracefulShutdown.ts"),
      "utf8",
    );
    const lifecycleSignalSource = readFileSync(
      resolve(sourceRoot, "lifecycle/signal-handlers.ts"),
      "utf8",
    );
    const cliSource = readFileSync(
      resolve(sourceRoot, "bin/agenc-main.ts"),
      "utf8",
    );
    const processSource = readFileSync(
      resolve(sourceRoot, "utils/process.ts"),
      "utf8",
    );

    expect(gracefulShutdownSource).not.toMatch(
      /\b(?:setupGracefulShutdown|orphanCheckInterval|tokenizeCliOptionRegion|getIsScrollDraining)\b/u,
    );
    expect(gracefulShutdownSource).not.toContain('from "signal-exit"');
    expect(gracefulShutdownSource).toContain("installGlobalErrorNet");
    expect(gracefulShutdownSource).toContain(
      "export async function gracefulShutdown",
    );
    expect(lifecycleSignalSource).toContain(
      "export function installAgenCShutdownSignalHandlers",
    );
    expect(cliSource).toContain("installAgenCShutdownSignalHandlers");
    expect(cliSource).not.toContain("installInitSignalHandlers");
    expect(cliSource).toContain("registerProcessOutputErrorHandlers");
    expect(processSource).toContain(
      "export function registerProcessOutputErrorHandlers",
    );
    expect(processSource).not.toContain("function handleEPIPE");
  });

  test("does not retain deleted-output cache slots, pollers, or environment controls", () => {
    const forkedAgent = readFileSync(
      resolve(sourceRoot, "utils/forkedAgent.ts"),
      "utf8",
    );
    const taskFramework = readFileSync(
      resolve(sourceRoot, "utils/task/framework.ts"),
      "utf8",
    );
    const envReference = readFileSync(
      resolve(repositoryRoot, "docs/reference/env.md"),
      "utf8",
    );
    const hermeticEnv = readFileSync(
      resolve(repositoryRoot, "runtime/tests/helpers/hermetic-env.mjs"),
      "utf8",
    );

    expect(forkedAgent).not.toMatch(
      /\b(?:lastCacheSafeParams|saveCacheSafeParams|getLastCacheSafeParams)\b/u,
    );
    expect(taskFramework).not.toMatch(
      /\b(?:POLL_INTERVAL_MS|getRunningTasks|pollTasks|enqueueTaskNotification)\b/u,
    );

    for (const retiredVariable of [
      "AGENC_PROGRESS_NORMALIZE_VOLATILE",
      "AGENC_PROGRESS_RESULT_PREFIX",
      "AGENC_PROGRESS_WINDOW",
      "AGENC_REMOTE_SEND_KEEPALIVES",
    ]) {
      expect(envReference).not.toContain(retiredVariable);
      expect(hermeticEnv).not.toContain(retiredVariable);
    }
  });
});
