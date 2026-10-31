import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENC_DAEMON_RESTART_LOCK_FILENAME,
  AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS,
  AGENC_DAEMON_RESTART_LOCK_LABEL,
  AGENC_DAEMON_RESTART_LOCK_WAIT_MS,
  AGENC_RUNTIME_CAPABILITY_DAEMON_RESTART_LOCK,
  agenCDaemonStartWaitBoundMs,
  describeAgenCDaemonRestartLockFailure,
  formatAgenCDaemonRestartWaitingLine,
  isLocalSqliteLockBusyTimeout,
  resolveAgenCDaemonRestartHandoffTimeoutMs,
} from "../../src/app-server/daemon-restart-handoff.js";
import * as daemonControl from "../../src/app-server/daemon-control.js";
import * as handoff from "../../src/app-server/daemon-restart-handoff.js";
import { acquireLocalSqliteLock } from "../../src/utils/sqlite-lock.js";
import { LocalSqliteLockTimeoutError } from "../../../packages/agenc/lib/sqlite-lock.mjs";

const MINUTE = 60_000;
const RESTART_LOCK = {
  label: AGENC_DAEMON_RESTART_LOCK_LABEL,
  filename: AGENC_DAEMON_RESTART_LOCK_FILENAME,
};

/** How `daemon start` waits for readiness: budget steps up to its maximum. */
function readinessMs(budgetMs: number, maxWaitMs: number): number {
  let waited = budgetMs;
  for (let extension = 1; extension <= Math.ceil(maxWaitMs / budgetMs) - 1; extension += 1) {
    waited += budgetMs;
  }
  return waited;
}

describe("the update's wait for its restart step", () => {
  it("covers the step's queue wait, its daemon start and the work around them", () => {
    const linux = resolveAgenCDaemonRestartHandoffTimeoutMs({}, "linux");
    // Queue: a short try and up to 15 minutes. Start: 14 readiness steps of 45 s.
    const queue = AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS + 15 * MINUTE;
    expect(linux).toBeGreaterThanOrEqual(queue + readinessMs(45_000, 600_000) + 5 * MINUTE);
    // The case the old fixed 20 minutes cut short: 14 minutes queued, then 7 starting.
    expect(linux).toBeGreaterThan(14 * MINUTE + 7 * MINUTE);
    expect(linux).toBe(1_000 + 15 * MINUTE + 630_000 + 10 * MINUTE);
    // On macOS the launchd job's pid publication comes before readiness.
    expect(resolveAgenCDaemonRestartHandoffTimeoutMs({}, "darwin")).toBe(linux + 600_000);
  });

  it("grows with the start budgets the restart step reads from the same environment", () => {
    const env = { AGENC_DAEMON_START_MAX_WAIT_MS: String(30 * MINUTE) };
    expect(agenCDaemonStartWaitBoundMs(env, "linux")).toBe(readinessMs(45_000, 30 * MINUTE));
    expect(resolveAgenCDaemonRestartHandoffTimeoutMs(env, "linux"))
      .toBeGreaterThanOrEqual(AGENC_DAEMON_RESTART_LOCK_WAIT_MS + 30 * MINUTE);
    const slowReady = { AGENC_DAEMON_READY_TIMEOUT_MS: "100000" };
    expect(agenCDaemonStartWaitBoundMs(slowReady, "linux")).toBe(readinessMs(100_000, 600_000));
  });

  it("is built from the budgets daemon-control uses, not copies of them", () => {
    expect(daemonControl.DEFAULT_DAEMON_START_MAX_WAIT_MS).toBe(handoff.DEFAULT_DAEMON_START_MAX_WAIT_MS);
    expect(daemonControl.DEFAULT_DAEMON_READY_TIMEOUT_MS).toBe(handoff.DEFAULT_DAEMON_READY_TIMEOUT_MS);
    expect(daemonControl.resolveAgenCDaemonStartMaxWaitMs).toBe(handoff.resolveAgenCDaemonStartMaxWaitMs);
    expect(daemonControl.resolveAgenCDaemonReadyTimeoutMs).toBe(handoff.resolveAgenCDaemonReadyTimeoutMs);
  });

  it("has one waiting line, which says how long", () => {
    expect(formatAgenCDaemonRestartWaitingLine()).toBe("Waiting for another daemon restart to finish (up to 15 minutes).");
  });
});

describe("a restart lock that times out", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rho-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is busy only when another holder kept it", async () => {
    const lockPath = join(home, AGENC_DAEMON_RESTART_LOCK_FILENAME);
    const release = await acquireLocalSqliteLock(lockPath, { label: AGENC_DAEMON_RESTART_LOCK_LABEL, timeoutMs: 1_000 });
    let busy: unknown;
    try {
      await acquireLocalSqliteLock(lockPath, { label: AGENC_DAEMON_RESTART_LOCK_LABEL, timeoutMs: 50 });
    } catch (error) {
      busy = error;
    } finally {
      release();
    }
    expect(isLocalSqliteLockBusyTimeout(busy, RESTART_LOCK)).toBe(true);
    expect(describeAgenCDaemonRestartLockFailure(busy))
      .toBe("another daemon restart was still running after 50 ms, so the daemon was left as it is");
  });

  it("keeps the real reason when the macOS filesystem probe of the lock directory takes too long", () => {
    const probe = new LocalSqliteLockTimeoutError({
      path: home,
      label: `${AGENC_DAEMON_RESTART_LOCK_LABEL} (macOS lock filesystem probe via /bin/df)`,
      timeoutMs: 2_000,
    });
    expect(isLocalSqliteLockBusyTimeout(probe, RESTART_LOCK)).toBe(false);
    expect(describeAgenCDaemonRestartLockFailure(probe)).toBe(
      "the daemon restart lock could not be taken: agenc: AgenC daemon restart (macOS lock filesystem probe via /bin/df) " +
        `timed out after 2000ms waiting for local process lock ${home}`,
    );
  });

  it("is not busy for another lock or another error", () => {
    const lifecycle = new LocalSqliteLockTimeoutError({
      path: join(home, "daemon-lifecycle.lock.sqlite"),
      label: "AgenC daemon lifecycle",
      timeoutMs: 120_000,
    });
    expect(isLocalSqliteLockBusyTimeout(lifecycle, RESTART_LOCK)).toBe(false);
    expect(isLocalSqliteLockBusyTimeout(new Error("EACCES"), RESTART_LOCK)).toBe(false);
    expect(isLocalSqliteLockBusyTimeout(undefined, RESTART_LOCK)).toBe(false);
  });
});

describe("the runtime capability that tells the updater who takes the lock", () => {
  it("is what the build writes into dist/VERSION", () => {
    const script = readFileSync(join(import.meta.dirname, "../../scripts/write-build-version.mjs"), "utf8");
    expect(AGENC_RUNTIME_CAPABILITY_DAEMON_RESTART_LOCK).toBe("daemon-restart-lock");
    expect(script).toContain(`capabilities: ["${AGENC_RUNTIME_CAPABILITY_DAEMON_RESTART_LOCK}"]`);
  });
});
