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
});
