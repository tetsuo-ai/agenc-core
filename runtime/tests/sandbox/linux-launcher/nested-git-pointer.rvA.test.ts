import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getWritableRootsWithCwd, restrictedFileSystemPolicy } from "../../../src/sandbox/engine/policy.js";
import { createBwrapCommandArgs } from "../../../src/sandbox/linux-launcher/bwrap.js";
import { startProtectedCreateMonitor } from "../../../src/sandbox/linux-launcher/protected-create-monitor.js";

// Review A (sec31) of 7d689c059, not committed: nested `.git` pointers.
let base: string, ws: string;
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "zz-ptr-"))); ws = join(base, "workspace"); fs.mkdirSync(ws); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });
const policy = () => restrictedFileSystemPolicy([
  { path: { kind: "special", value: { kind: "root" } }, access: "read" },
  { path: { kind: "path", path: ws }, access: "write" }]);
const gitdir = (d: string) => { fs.mkdirSync(join(d, "objects"), { recursive: true }); fs.writeFileSync(join(d, "HEAD"), "ref: refs/heads/main\n"); };
const plan = () => createBwrapCommandArgs(["/bin/true"], policy(), ws, ws, { mountProc: false, networkMode: "isolated", sessionTempRoot: base });
const monitorFor = () => { const p = plan(); return startProtectedCreateMonitor(p.protectedCreateTargets, p.nestedGitScanRoots, p.nestedGitBaseline); };

it("P1 a pre-existing nested .git SYMLINK pointer is left alone at stop", () => {
  gitdir(join(ws, "store", "sub.gitdir"));
  fs.mkdirSync(join(ws, "sub"));
  fs.symlinkSync("../store/sub.gitdir", join(ws, "sub", ".git"));
  expect(monitorFor().stop(), "violation for an unchanged pre-existing symlink pointer").toBe(false);
  expect(fs.lstatSync(join(ws, "sub", ".git")).isSymbolicLink()).toBe(true);
});

it("P2 a pre-existing nested .git GITFILE pointer is left alone at stop", () => {
  fs.mkdirSync(join(ws, "sub"));
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
  expect(monitorFor().stop()).toBe(false);
  expect(fs.readFileSync(join(ws, "sub", ".git"), "utf8")).toBe("gitdir: ../.git/modules/sub\n");
});

it("P3 a pre-existing gitfile pointer REWRITTEN during the run is flagged", () => {
  fs.mkdirSync(join(ws, "sub"));
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
  const monitor = monitorFor();
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../elsewhere\n");
  expect(monitor.stop(), "violation for a pointer whose target changed during the run").toBe(true);
});

it("P4 an existing nested gitfile pointer is a read-only carve-out for the shell path", () => {
  fs.mkdirSync(join(ws, "sub"));
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
  const root = getWritableRootsWithCwd(policy(), ws, base).find((r) => r.root === ws);
  expect(root?.readOnlySubpaths ?? [], "readOnlySubpaths").toContain(join(ws, "sub", ".git"));
});

it("P5 an absorbed submodule gitfile redirected to writable data during the run is flagged and removed", () => {
  // A real absorbed submodule: sub/.git points into the protected .git/modules/sub.
  // It is benign, so it stays writable (AgenC must be able to remove worktrees),
  // but a redirect to a gitdir the command made becomes a new descent point.
  gitdir(join(ws, ".git"));
  gitdir(join(ws, ".git", "modules", "sub"));
  fs.mkdirSync(join(ws, "sub"));
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
  const root = getWritableRootsWithCwd(policy(), ws, base).find((r) => r.root === ws);
  expect(root?.readOnlySubpaths ?? [], "a benign gitfile is not bound read-only").not.toContain(join(ws, "sub", ".git"));
  const monitor = monitorFor();
  gitdir(join(ws, "planted"));
  fs.writeFileSync(join(ws, "sub", ".git"), "gitdir: ../planted\n");
  expect(monitor.stop(), "violation for a submodule pointer redirected to writable data").toBe(true);
  expect(fs.existsSync(join(ws, "sub", ".git"))).toBe(false);
});
