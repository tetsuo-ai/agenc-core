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
