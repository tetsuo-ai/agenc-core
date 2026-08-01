import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  createChildProcessHarness,
  type ChildInvocation,
  type ChildProcessHarness,
} from "../helpers/child-process-harness.js";
import {
  createTempWorkspaceFixture,
  type TempWorkspaceFixture,
} from "../helpers/temp-workspace.js";

const CRASH_CHILD = fileURLToPath(
  new URL("./process-fixtures/crash-child.ts", import.meta.url),
);
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_OUTPUT_BYTES = 8_192;
const TERMINATE_GRACE_MS = 50;
const MARKER_TIMEOUT_MS = 3_000;
const MARKER_MAX_BYTES = 1_024;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const PROCESS_EXIT_POLL_MS = 20;
const COOPERATIVE_TIMEOUT_MS = 2_000;
const HEARTBEAT_STARTUP_TIMEOUT_MS = 3_000;
const HEARTBEAT_INTERVAL_TIMEOUT_MS = 3_000;
const EXPECT_RESISTANT_CHILD_ESCALATION = process.platform !== "win32";

test("contained timeout removes a termination-resistant native descendant", async () => {
  let descendantPid = 0;
  await withNativeHarness(async (harness, root) => {
    const markerPath = join(root, "descendant.json");
    const child = await harness.spawn(
      nodeInvocation(root, [CRASH_CHILD, "resist", markerPath], {
        durableMarkers: [markerPath],
      }),
    );
    await child.waitForMarker({
      path: markerPath,
      timeoutMs: MARKER_TIMEOUT_MS,
      maxBytes: MARKER_MAX_BYTES,
    });
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      readonly descendantPid?: unknown;
    };
    if (!isSafeProcessId(marker.descendantPid)) {
      throw new Error("native descendant did not publish a safe process id");
    }
    descendantPid = marker.descendantPid;

    const result = await child.settled;
    expect(result).toMatchObject({
      exitCode: null,
      stopReason: "timeout",
      forced: EXPECT_RESISTANT_CHILD_ESCALATION,
      backstopExpired: false,
      heartbeatCount: 0,
    });
    // Windows Job Object shutdown removes the whole tree on the initial broker
    // request; POSIX descendants can retain SIGTERM and require SIGKILL.
    // Darwin can prove the detached process group absent before Node reports
    // an exit signal for the process.execve boundary. The owned-tree proof,
    // stop reason, and actual escalation flag are the authoritative outcome.
    expect(result.error).toBeUndefined();
    expect(await waitForProcessExit(descendantPid)).toBe(true);
  });
});

test("native timeout escalation is unchanged by heartbeat observation", async () => {
  await withNativeHarness(async (harness, root) => {
    const withoutHeartbeat = await harness.run(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"], {
        timeoutMs: COOPERATIVE_TIMEOUT_MS,
      }),
    );
    const heartbeatPath = join(root, "cooperative-heartbeat.json");
    const withHeartbeat = await harness.run(
      nodeInvocation(
        root,
        [CRASH_CHILD, "heartbeat-cooperative", heartbeatPath],
        {
          heartbeat: {
            path: heartbeatPath,
            startupTimeoutMs: HEARTBEAT_STARTUP_TIMEOUT_MS,
            intervalTimeoutMs: HEARTBEAT_INTERVAL_TIMEOUT_MS,
            maxBytes: MARKER_MAX_BYTES,
          },
          timeoutMs: COOPERATIVE_TIMEOUT_MS,
        },
      ),
    );
    expect(withoutHeartbeat).toMatchObject({
      stopReason: "timeout",
      forced: false,
      backstopExpired: false,
    });
    expect(withHeartbeat).toMatchObject({
      stopReason: "timeout",
      forced: false,
      backstopExpired: false,
      heartbeatCount: 1,
    });
  });
});

test("native evidence admission rejects portable path aliases", async () => {
  await withNativeHarness(async (harness, root) => {
    const invocation = (durableMarkers: readonly string[]): ChildInvocation =>
      nodeInvocation(root, ["--eval", "process.exit(0)"], {
        durableMarkers,
      });
    for (const markerPaths of [
      [join(root, "Marker.json"), join(root, "marker.json")],
      [join(root, "caf\u00e9.json"), join(root, "cafe\u0301.json")],
    ]) {
      await expect(harness.spawn(invocation(markerPaths))).rejects.toThrow(
        /resolve uniquely/u,
      );
    }
    await expect(
      harness.spawn(invocation([join(root, "FILE~1.JS")])),
    ).rejects.toThrow(/reserved segment/u);
  });
});

function nodeInvocation(
  root: string,
  args: readonly string[],
  overrides: Partial<
    Pick<ChildInvocation, "durableMarkers" | "heartbeat" | "timeoutMs">
  > = {},
): ChildInvocation {
  return {
    program: process.execPath,
    args,
    cwd: root,
    env: childEnvironment(),
    timeoutMs: overrides.timeoutMs ?? CHILD_TIMEOUT_MS,
    maxOutputBytes: CHILD_OUTPUT_BYTES,
    terminateGraceMs: TERMINATE_GRACE_MS,
    ...(overrides.heartbeat === undefined
      ? {}
      : { heartbeat: overrides.heartbeat }),
    ...(overrides.durableMarkers === undefined
      ? {}
      : { durableMarkers: overrides.durableMarkers }),
  };
}

async function withNativeHarness(
  action: (harness: ChildProcessHarness, root: string) => Promise<void>,
): Promise<void> {
  const workspaces = createTempWorkspaceFixture("agenc-fnd-process-native-");
  const root = await workspaces.create();
  let harness: ChildProcessHarness | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try {
    harness = await createChildProcessHarness(root);
    await action(harness, root);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  const cleanupErrors = await cleanupNativeHarness(harness, workspaces);
  if (actionFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [actionError, ...cleanupErrors],
      "native process test and cleanup both failed",
    );
  }
  if (actionFailed) throw actionError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "native process test cleanup failed",
    );
  }
}

async function cleanupNativeHarness(
  harness: ChildProcessHarness | undefined,
  workspaces: TempWorkspaceFixture,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (harness !== undefined) {
    try {
      await harness.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await workspaces.cleanup();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function childEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
  };
  for (const name of [
    "ComSpec",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "WINDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, PROCESS_EXIT_POLL_MS),
    );
  }
  return !isProcessRunning(pid);
}

function isSafeProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

function isProcessRunning(pid: number): boolean {
  if (!isSafeProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
