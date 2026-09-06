import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AgencSpawnFn,
  connect,
  describeDaemonStartStderr,
} from "../../../packages/agenc-sdk/src/socket.js";

// A daemon start that fails used to surface only its exit code; the CLI's
// reason went to a discarded stderr. The soak saw six "exited with code 1"
// in a row while the CLI was saying an unbound daemon cannot be signalled.

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdio: unknown;
}

function fakeSpawner(
  stderrText: string | null,
  code: number,
): { readonly spawn: AgencSpawnFn; readonly calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: AgencSpawnFn = (command, args, options) => {
    calls.push({ command, args, stdio: options.stdio });
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter | null;
    };
    child.stderr = stderrText === null ? null : new EventEmitter();
    setImmediate(() => {
      if (stderrText !== null) child.stderr?.emit("data", Buffer.from(stderrText));
      child.emit("exit", code);
    });
    return child;
  };
  return { spawn, calls };
}

describe("daemon autostart failure carries the CLI's stderr", () => {
  let home = "";
  afterEach(() => {
    if (home !== "") rmSync(home, { recursive: true, force: true });
  });

  it("appends the last stderr lines to the exit error and pipes only stderr", async () => {
    home = mkdtempSync(join(tmpdir(), "agenc-sdk-autostart-"));
    const { spawn, calls } = fakeSpawner(
      "agenc: daemon status is indeterminate for unbound pid 149\n" +
        "agenc: an unbound daemon cannot be signalled on this platform\n",
      1,
    );
    await expect(
      connect({
        env: { AGENC_HOME: home },
        autostart: true,
        agencCommand: "fake-agenc",
        spawn,
        readyTimeoutMs: 500,
      }),
    ).rejects.toThrow(
      "AgenC daemon start exited with code 1 (command: fake-agenc): " +
        "agenc: daemon status is indeterminate for unbound pid 149 | " +
        "agenc: an unbound daemon cannot be signalled on this platform",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["daemon", "start"]);
    expect(calls[0]?.stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("keeps the bare exit message when the spawner pipes no stderr", async () => {
    home = mkdtempSync(join(tmpdir(), "agenc-sdk-autostart-"));
    const { spawn } = fakeSpawner(null, 2);
    await expect(
      connect({
        env: { AGENC_HOME: home },
        autostart: true,
        agencCommand: "fake-agenc",
        spawn,
        readyTimeoutMs: 500,
      }),
    ).rejects.toThrow(/exited with code 2 \(command: fake-agenc\)$/u);
  });

  it("renders at most the last three non-empty lines of the tail", () => {
    expect(describeDaemonStartStderr([])).toBe("");
    expect(describeDaemonStartStderr(["\n  \n"])).toBe("");
    expect(describeDaemonStartStderr(["a\n", "b\n", "c\n", "d\n"])).toBe(": b | c | d");
    expect(describeDaemonStartStderr(["x".repeat(5000) + "\nlast line\n"])).toMatch(
      /^: x+ \| last line$/u,
    );
  });
});
