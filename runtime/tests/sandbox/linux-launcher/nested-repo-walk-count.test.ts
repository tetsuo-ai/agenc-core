import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restrictedFileSystemPolicy } from "../../../src/sandbox/engine/index.js";
import { createBwrapCommandArgs } from "../../../src/sandbox/linux-launcher/bwrap.js";
import { startProtectedCreateMonitor } from "../../../src/sandbox/linux-launcher/protected-create-monitor.js";

// A2 re-review 4: the bounded nested-repository walk must run at most once per
// command at start (in the plan) and once in the monitor's stop(). Earlier it
// ran about four times (getWritableRootsWithCwd twice from
// createBwrapCommandArgs, plus the monitor's baseline and stop), which cost
// ~16-20% of a core per command on a node_modules workspace. A "walk" is one
// bounded scan of a writable root; it begins by reading that root directory,
// so counting readdir calls on the exact root path counts the walks.
let base: string, workspace: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "walk-count-")));
  workspace = join(base, "workspace");
  for (const pkg of ["a", "b", "c"]) {
    fs.mkdirSync(join(workspace, "node_modules", pkg, "dist"), { recursive: true });
    fs.writeFileSync(join(workspace, "node_modules", pkg, "index.js"), "");
  }
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true }); });

const policy = () => restrictedFileSystemPolicy([
  { path: { kind: "special", value: { kind: "root" } }, access: "read" },
  { path: { kind: "path", path: workspace }, access: "write" },
]);
const options = () => ({ mountProc: false, networkMode: "isolated" as const, sessionTempRoot: base });
const rootWalks = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([dir]) => dir === workspace).length;

describe("per-command nested-repository walk count", () => {
  it("walks each writable root once in the plan and once in the monitor's stop", () => {
    const readdir = vi.spyOn(fs, "readdirSync");
    const plan = createBwrapCommandArgs(["/bin/true"], policy(), workspace, workspace, options());
    // The plan computes the writable roots once: one walk of the workspace.
    const afterPlan = rootWalks(readdir);
    expect(afterPlan).toBe(1);
    // The plan hands the monitor its start baseline, so the monitor does not
    // walk at start; it walks once in stop().
    const monitor = startProtectedCreateMonitor(
      plan.protectedCreateTargets, plan.nestedGitScanRoots, plan.nestedGitBaseline,
    );
    expect(rootWalks(readdir)).toBe(afterPlan);
    monitor.stop();
    expect(rootWalks(readdir)).toBe(afterPlan + 1);
    // Two walks per command in all, not four.
    expect(rootWalks(readdir)).toBe(2);
  });

  it("exposes the nested-repository baseline from the plan", () => {
    fs.mkdirSync(join(workspace, "sub", ".git", "objects"), { recursive: true });
    fs.writeFileSync(join(workspace, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
    const plan = createBwrapCommandArgs(["/bin/true"], policy(), workspace, workspace, options());
    expect(plan.nestedGitBaseline.map((p) => fs.realpathSync(p)))
      .toContain(fs.realpathSync(join(workspace, "sub", ".git")));
  });

  it("falls back to a start walk when no baseline is supplied", () => {
    const readdir = vi.spyOn(fs, "readdirSync");
    const monitor = startProtectedCreateMonitor([], [workspace]);
    expect(rootWalks(readdir)).toBe(1);
    monitor.stop();
    expect(rootWalks(readdir)).toBe(2);
  });
});
