import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonWorkflowStartService } from "../../../src/app-server/workflow/run-start-service.js";
import type { VerifiedChangeWorkflowController } from "../../../src/app-server/workflow/verified-change-controller.js";
import {
  getCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../../src/session/current-session.js";
import type { Session } from "../../../src/session/session.js";

/**
 * A desktop daemon tracks many sessions. The goal runner's path reaches
 * utilities that fall back to the ambient current session, which throws
 * "Ambiguous runtime session" once more than one session is tracked; every
 * run.start from the app failed that way. The start service runs the
 * controller inside the bootstrap scope, where the fallback yields null.
 */
describe("run.start with several sessions tracked in the process", () => {
  const dirs: string[] = [];
  afterEach(() => {
    setCurrentRuntimeSession(null);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("starts the run and gives the controller no ambient session instead of an error", async () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-run-start-scope-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    setCurrentRuntimeSession({ sessionConfiguration: { cwd: repo } } as unknown as Session);
    setCurrentRuntimeSession({ sessionConfiguration: { cwd: repo } } as unknown as Session);
    expect(() => getCurrentRuntimeSession()).toThrow(/Ambiguous runtime session/);

    let seenInsideStart: unknown = "unset";
    const controller = {
      start: async () => {
        seenInsideStart = getCurrentRuntimeSession();
        return {
          runId: "run-scope-test",
          specDigest: "a".repeat(64),
          baseCommit: "b".repeat(40),
          baseDirty: false,
        };
      },
    } as unknown as VerifiedChangeWorkflowController;
    const service = new DaemonWorkflowStartService({
      controller,
      primaryCwd: repo,
      warn: () => {},
    });

    const result = await service.startRun({
      goal: "make the tests green",
      cwd: repo,
      verification: [{ label: "verify", script: "true" }],
    } as never);
    expect(result.runId).toBe("run-scope-test");
    expect(seenInsideStart).toBeNull();
  });
});
