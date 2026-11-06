import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canWritePathWithCwd, restrictedFileSystemPolicy } from "../../../src/sandbox/engine/policy.js";

/**
 * Re-review residual: a REAL nested repository created DURING a sandboxed run.
 * Narrowing of a nested repo is gated on it being a real repo (HEAD+objects)
 * AT THE TIME the carve-outs are computed. A confined command can assemble a
 * real nested repo with a malicious fsmonitor/filter/hook through writes that
 * are each allowed because, at the moment of each write, `sub/.git` is not yet
 * a repository. The final on-disk state is a real repo with a planted config.
 */
let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "residual-"))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function policy() {
  return restrictedFileSystemPolicy([{ path: { kind: "path", path: root }, access: "write" }]);
}
const canWrite = (target: string) => canWritePathWithCwd(policy(), target, root, root);
const sub = () => path.join(root, "sub", ".git");

describe("nested repo assembled during a run", () => {
  it("DEMONSTRATES the residual: every step of planting a real malicious nested repo is allowed", () => {
    // The top-level workspace is itself a real repo (as when AgenC opens one).
    fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    // A direct write to the top-level .git surface is refused (baseline).
    expect(canWrite(path.join(root, ".git", "config"))).toBe(false);

    // Step 1: plant the malicious config + hook while sub/.git is NOT yet a repo.
    fs.mkdirSync(path.join(sub(), "hooks"), { recursive: true });
    expect(canWrite(path.join(sub(), "config")), "config into nascent nested .git").toBe(false);
    fs.writeFileSync(path.join(sub(), "config"), "[core]\n\tfsmonitor = /tmp/evil\n");
    expect(canWrite(path.join(sub(), "hooks", "pre-commit")), "hook into nascent nested .git").toBe(false);
    fs.writeFileSync(path.join(sub(), "hooks", "pre-commit"), "#!/bin/sh\n");

    // Step 2: promote sub/.git to a real repository (add HEAD + objects).
    expect(canWrite(path.join(sub(), "HEAD")), "HEAD promotes to repo").toBe(false);
    fs.writeFileSync(path.join(sub(), "HEAD"), "ref: refs/heads/main\n");
    expect(canWrite(path.join(sub(), "objects", "pack", "x")), "objects promotes to repo").toBe(false);
    fs.mkdirSync(path.join(sub(), "objects"), { recursive: true });

    // Final state: a REAL nested repo (HEAD + objects) carrying the malicious config.
    expect(fs.lstatSync(path.join(sub(), "HEAD")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(sub(), "objects")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(sub(), "config"), "utf8")).toContain("fsmonitor");
    // Now that it is a real repo, a FURTHER config write is refused (the fix
    // protects an existing real nested repo) - but the malicious config is
    // already in place from step 1.
    expect(canWrite(path.join(sub(), "config")), "config once it is a real repo").toBe(false);
  });
});
