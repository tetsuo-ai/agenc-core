import { closeSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_SPAWN_STDERR_FILENAME,
  AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME,
  openDaemonSpawnStderrCapture,
  resolveAgenCDaemonSpawnStderrPath,
  resolveAgenCDaemonSpawnStderrPreviousPath,
} from "../../src/app-server/daemon-cli.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agenc-spawn-stderr-"));
  homes.push(home);
  return home;
}

function capture(path: string, previous: string, text: string): void {
  const fd = openDaemonSpawnStderrCapture(path, previous);
  expect(fd).not.toBe("ignore");
  writeSync(fd as number, text);
  closeSync(fd as number);
}

describe("daemon spawn stderr capture", () => {
  it("keeps the previous spawn's stderr as the .prev.log sibling", () => {
    const home = tempHome();
    const env = { AGENC_HOME: home };
    const path = resolveAgenCDaemonSpawnStderrPath(env, home);
    const previous = resolveAgenCDaemonSpawnStderrPreviousPath(env, home);
    expect(path.endsWith(AGENC_DAEMON_SPAWN_STDERR_FILENAME)).toBe(true);
    expect(previous.endsWith(AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME)).toBe(true);

    capture(path, previous, "first daemon: FATAL ERROR: out of memory\n");
    capture(path, previous, "second daemon starting\n");

    expect(readFileSync(previous, "utf8")).toBe(
      "first daemon: FATAL ERROR: out of memory\n",
    );
    expect(readFileSync(path, "utf8")).toBe("second daemon starting\n");

    // A third spawn keeps only the immediately preceding attempt.
    capture(path, previous, "third\n");
    expect(readFileSync(previous, "utf8")).toBe("second daemon starting\n");
    expect(readFileSync(path, "utf8")).toBe("third\n");
  });

  it("opens a fresh capture when no previous file exists", () => {
    const home = tempHome();
    const path = join(home, AGENC_DAEMON_SPAWN_STDERR_FILENAME);
    const previous = join(home, AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME);
    capture(path, previous, "only\n");
    expect(readFileSync(path, "utf8")).toBe("only\n");
    expect(() => readFileSync(previous, "utf8")).toThrow();
  });

  it("proceeds without a capture when the home cannot take one", () => {
    const missing = join(tempHome(), "no", "such", "dir");
    expect(
      openDaemonSpawnStderrCapture(
        join(missing, AGENC_DAEMON_SPAWN_STDERR_FILENAME),
        join(missing, AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME),
      ),
    ).toBe("ignore");
  });
});
