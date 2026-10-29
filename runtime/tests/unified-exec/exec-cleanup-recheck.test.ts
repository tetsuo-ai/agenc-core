/**
 * A command killed while one of its processes is stuck in the kernel must not
 * close the shell for the rest of the session.
 *
 * Seen live (Core 0.19.23, macOS): `find /` was killed while it read a USB
 * hard disk. The killed process accepted SIGKILL but could exit only when its
 * disk read returned, after the 1 s settlement backstop. The proof failed,
 * unified exec closed for good, and every later exec_command was refused with
 * "permanently closed" although the process had exited by then. The model
 * retried shell commands for 12 minutes.
 *
 * The stuck process is stood in for by a real process blocked reading a FIFO,
 * which only the test can release. The settlement proof runs for real on the
 * command's own tree; the stand-in plays the member that proof still sees
 * alive, for as long as it lives, as `isProcessTreeAlive` would.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stuckTree = vi.hoisted(() => ({
  label: undefined as string | undefined,
  pid: 0,
  alive: (): boolean => false,
}));

vi.mock("../../src/utils/supervisedProcess.js", async (original) => {
  const actual = await original<typeof import("../../src/utils/supervisedProcess.js")>();
  return {
    ...actual,
    terminateProcessTreeAndReport: vi.fn(async (
      child: Parameters<typeof actual.terminateProcessTreeAndReport>[0],
      options: Parameters<typeof actual.terminateProcessTreeAndReport>[1] = {},
    ) => {
      const outcome = await actual.terminateProcessTreeAndReport(child, options);
      if (options.label === undefined || options.label !== stuckTree.label) return outcome;
      // The real proof waits the TERM grace and then the kill wait while a
      // member it recorded is still alive.
      const deadline = Date.now() + (options.terminateGraceMs ?? 500) + (options.killGraceMs ?? 1_000);
      while (stuckTree.alive() && Date.now() < deadline) await delay(20);
      if (stuckTree.alive()) {
        throw new Error(
          `${options.label} tree survived forced shutdown (pid ${child.pid}); live descendants: ${stuckTree.pid}`,
        );
      }
      return outcome;
    }),
    // What the failed proof's last snapshot saw alive.
    liveProcessTreeDescendants: vi.fn(() => (stuckTree.alive() ? [stuckTree.pid] : [])),
    processTreeCleanupRecheckable: vi.fn(actual.processTreeCleanupRecheckable),
  };
});

const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");
const supervised = await import("../../src/utils/supervisedProcess.js");
const { createExecCommandTool } = await import("../../src/tools/system/exec-command.js");
const { bindExplicitDangerBoundary } = await import("../helpers/explicit-danger-boundary.js");

let root: string;
let releaseStandIn: (() => Promise<void>) | undefined;
let killStandIn: (() => void) | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exec-cleanup-recheck-"));
});

afterEach(() => {
  vi.mocked(supervised.processTreeCleanupRecheckable).mockRestore?.();
  killStandIn?.();
  releaseStandIn = undefined;
  killStandIn = undefined;
  stuckTree.label = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A real process blocked reading a FIFO until `release` closes the writer. */
function startStuckProcess(label: string): void {
  const fifo = join(root, "disk");
  execFileSync("mkfifo", [fifo]);
  const standIn = spawn(
    process.execPath,
    ["-e", "require('node:fs').readFileSync(process.argv[1]); process.exit(0)", fifo],
    { stdio: "ignore", detached: true },
  );
  const exited = new Promise<void>((resolve) => standIn.once("exit", () => resolve()));
  stuckTree.label = label;
  stuckTree.pid = standIn.pid!;
  stuckTree.alive = () => standIn.exitCode === null && standIn.signalCode === null;
  releaseStandIn = async () => {
    // Non-blocking: if the stand-in were gone, opening would fail instead of hanging.
    for (let attempt = 0; ; attempt += 1) {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENXIO" || attempt >= 50) throw error;
        await delay(20);
      }
    }
    await exited;
  };
  killStandIn = () => {
    if (stuckTree.alive()) standIn.kill("SIGKILL");
  };
}

/** Admission is a synchronous check; it throws only while commands are refused. */
async function waitUntilRefused(manager: InstanceType<typeof UnifiedExecProcessManager>): Promise<Error> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      manager.assertOwnerAdmission(undefined);
    } catch (error) {
      return error as Error;
    }
    if (Date.now() > deadline) throw new Error("admission never closed");
    await delay(25);
  }
}

describe("unified exec after a killed command whose process exits late", () => {
  it("waits out a process that exits seconds after SIGKILL instead of closing the shell", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root });
    try {
      const started = await manager.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
      const sessionId = started.process_id!;
      expect(sessionId).toEqual(expect.any(Number));
      startStuckProcess(`exec_command process ${sessionId}`);

      expect(manager.terminateProcess(sessionId)).toEqual({ terminated: true });
      // Longer than the old 500 ms TERM grace plus 1 s kill backstop.
      await delay(2_500);
      expect(() => manager.assertOwnerAdmission(undefined)).not.toThrow();
      await releaseStandIn!();

      const after = await manager.execCommand({ cmd: "echo still-open", yield_time_ms: 5_000 });
      expect(after.stdout).toContain("still-open");
      await expect(manager.prepareForDurableClose()).resolves.toBeUndefined();
    } finally {
      await manager.closeAll().catch(() => {});
    }
  }, 20_000);

  it("refuses commands while the process may still run and resumes once it has exited", async () => {
    const manager = new UnifiedExecProcessManager({
      cwd: root,
      sessionTempRoot: root,
      processTreeKillWaitMs: 100,
    });
    try {
      const started = await manager.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
      const sessionId = started.process_id!;
      startStuckProcess(`exec_command process ${sessionId}`);
      manager.terminateProcess(sessionId);

      const refusal = await waitUntilRefused(manager);
      expect(refusal).toMatchObject({ code: "exec_unavailable", recheckable: true });
      expect(refusal.message).toContain("Shell commands are paused in this session.");
      expect(refusal.message).toContain(`\`sleep 30\` (session ${sessionId})`);
      expect(refusal.message).toContain(`process ${stuckTree.pid} was still running`);
      expect(refusal.message).toContain("resumes on its own once they have exited");
      expect(refusal.message).not.toMatch(/\u2014/u);

      // Still alive: the check before the next command fails the same way,
      // and the tool result carries the stop that ends the turn.
      const execTool = bindExplicitDangerBoundary(
        createExecCommandTool({ unifiedExecManager: manager, cwd: root }),
      );
      const refused = await execTool.execute({ cmd: "echo refused" });
      expect(refused).toMatchObject({
        isError: true,
        metadata: {
          retryable: false,
          execUnavailableStop: { explanation: refusal.message, recheckable: true },
        },
      });
      expect(JSON.parse(refused.content)).toMatchObject({ code: "exec_unavailable", retryable: false });
      await manager.recheckCleanupAdmission();
      expect(() => manager.assertOwnerAdmission(undefined)).toThrow(/Shell commands are paused/);
      expect(manager.takeAdmissionResumedNotice()).toBeUndefined();

      await releaseStandIn!();
      await manager.recheckCleanupAdmission();
      const resumed = await execTool.execute({ cmd: "echo resumed", yield_time_ms: 5_000 });
      expect(resumed.isError).toBeFalsy();
      expect(resumed.content).toContain("resumed");
      // Said once, ahead of the output of the first command that ran again.
      expect(resumed.content.startsWith("Shell commands were paused because")).toBe(true);
      expect(resumed.content).toContain(`\`sleep 30\` (session ${sessionId})`);
      expect(resumed.content).toContain("They have exited now, so shell commands run again.");
      expect(resumed.metadata?.execAdmissionResumed).toEqual(expect.stringContaining("run again"));
      const next = await execTool.execute({ cmd: "echo next", yield_time_ms: 5_000 });
      expect(next.content).not.toContain("Shell commands were paused");
      // Session teardown proves the same tree again and seals.
      await expect(manager.prepareForDurableClose()).resolves.toBeUndefined();
    } finally {
      await manager.closeAll().catch(() => {});
    }
  }, 20_000);

  it("a subagent closing while the shell is paused does not make the pause permanent", async () => {
    const manager = new UnifiedExecProcessManager({
      cwd: root,
      sessionTempRoot: root,
      processTreeKillWaitMs: 100,
    });
    try {
      const child = manager.createOwnerLifetime("subagent").bind();
      const started = await manager.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
      const sessionId = started.process_id!;
      startStuckProcess(`exec_command process ${sessionId}`);
      manager.terminateProcess(sessionId);
      await waitUntilRefused(manager);

      // The subagent's close reports the shared failure; it records no new one.
      await expect(child.prepareForDurableClose()).rejects.toThrow(/cleanup is unproven/);
      await releaseStandIn!();
      await manager.recheckCleanupAdmission();
      const resumed = await manager.execCommand({ cmd: "echo resumed", yield_time_ms: 5_000 });
      expect(resumed.stdout).toContain("resumed");
    } finally {
      await manager.closeAll().catch(() => {});
    }
  }, 20_000);

  it("keeps shell commands disabled when the failed proof can never pass again", async () => {
    const manager = new UnifiedExecProcessManager({
      cwd: root,
      sessionTempRoot: root,
      processTreeKillWaitMs: 100,
    });
    // As after a lost process-table snapshot: no later proof can be trusted.
    vi.mocked(supervised.processTreeCleanupRecheckable).mockReturnValue(false);
    try {
      const started = await manager.execCommand({ cmd: "sleep 30", yield_time_ms: 250 });
      const sessionId = started.process_id!;
      startStuckProcess(`exec_command process ${sessionId}`);
      manager.terminateProcess(sessionId);

      const refusal = await waitUntilRefused(manager);
      expect(refusal).toMatchObject({ code: "exec_unavailable", recheckable: false });
      expect(refusal.message).toContain("Shell commands are disabled for the rest of this session.");
      expect(refusal.message).toContain(`exec_command process ${sessionId} tree survived forced shutdown`);
      expect(refusal.message).toContain("Start a new session to run shell commands.");

      await releaseStandIn!();
      await manager.recheckCleanupAdmission();
      await expect(manager.execCommand({ cmd: "echo refused" }))
        .rejects.toMatchObject({ code: "exec_unavailable", recheckable: false });
    } finally {
      await manager.closeAll().catch(() => {});
    }
  }, 20_000);
});
