import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { worktreeShellWriteRefusal } from "../../src/agents/worktree-shell-confinement.js";

// Goal steps run in <checkout>/.agenc-worktrees/m5-<run>. A shell command
// there reached the user's checkout: `rm ../../src/a.js` passed the write
// guard, which measured paths against the checkout itself.
let base: string;
let checkout: string;
let worktree: string;
let temp: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agenc-worktree-shell-guard-")));
  checkout = join(base, "checkout");
  worktree = join(checkout, ".agenc-worktrees", "m5-run");
  temp = join(base, "temp");
  for (const dir of [join(worktree, "src"), join(checkout, "src"), temp]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(checkout, "src", "a.js"), "the user's code\n");
  writeFileSync(join(worktree, "src", "a.js"), "the step's copy\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function refusal(toolName: string, args: Record<string, unknown>, tempRoot = temp): string | undefined {
  return worktreeShellWriteRefusal(toolName, args, { worktree, checkout }, tempRoot);
}

describe("worktreeShellWriteRefusal", () => {
  it("refuses a command that writes, removes or moves a file in the checkout", () => {
    for (const cmd of [
      "rm ../../src/a.js",
      "cp README.md ../../src/a.js",
      "mv src/a.js ../../src/a.js",
      "echo built > ../../dist/out.js",
      `touch ${join(checkout, "src", "new.js")}`,
      "sed -i.bak s/a/b/ ../../src/a.js",
    ]) {
      const refused = refusal("exec_command", { cmd, workdir: worktree });
      expect(refused, cmd).toContain(`This agent works in its own git worktree (${worktree})`);
      expect(refused, cmd).toContain(checkout);
    }
  });

  it("names every outside path and says the command did not run", () => {
    const refused = refusal("exec_command", { cmd: "rm ../../src/a.js ../../src/b.js" });
    expect(refused).toContain(`${join(checkout, "src", "a.js")}, ${join(checkout, "src", "b.js")}`);
    expect(refused).toContain("was not run");
  });

  it("allows changes inside the worktree, relative or absolute", () => {
    for (const cmd of [
      "rm src/a.js",
      "echo built > dist/out.js",
      "mkdir -p build && cp src/a.js build/a.js",
      `rm ${join(worktree, "src", "a.js")}`,
    ]) {
      expect(refusal("exec_command", { cmd, workdir: worktree }), cmd).toBeUndefined();
    }
  });

  it("resolves a relative workdir in the worktree and an absolute one where it points", () => {
    expect(refusal("exec_command", { cmd: "rm a.js", workdir: "src" })).toBeUndefined();
    expect(refusal("exec_command", { cmd: "rm src/a.js", workdir: checkout })).toBeDefined();
  });

  it("follows a cd in the command line", () => {
    expect(refusal("exec_command", { cmd: "cd ../.. && rm src/a.js" })).toBeDefined();
    expect(refusal("exec_command", { cmd: "cd src && rm a.js" })).toBeUndefined();
    expect(refusal("exec_command", { cmd: "(cd ../.. && ls) && rm src/a.js" })).toBeUndefined();
  });

  it("follows a link inside the worktree that points into the checkout", () => {
    symlinkSync(join(checkout, "src"), join(worktree, "linked"));
    expect(refusal("exec_command", { cmd: "rm linked/a.js" })).toBeDefined();
  });

  it("allows scratch files in the temp folders", () => {
    expect(refusal("exec_command", { cmd: `echo x > ${join(temp, "scratch.txt")}` })).toBeUndefined();
    expect(refusal("exec_command", { cmd: "echo x > /tmp/agenc-scratch.txt" })).toBeUndefined();
    expect(refusal("exec_command", { cmd: "echo x > /dev/tty" })).toBeUndefined();
  });

  it("refuses the checkout even when a temp folder holds it", () => {
    // A project under /tmp.
    expect(refusal("exec_command", { cmd: "rm ../../src/a.js" }, base)).toBeDefined();
    expect(refusal("exec_command", { cmd: `echo x > ${join(base, "scratch.txt")}` }, base)).toBeUndefined();
  });

  it("allows a temp folder inside the checkout, as a routine run's scratch folder is", () => {
    const scratch = join(checkout, "scratch");
    expect(refusal("exec_command", { cmd: `echo x > ${join(scratch, "out.txt")}` }, scratch)).toBeUndefined();
    expect(refusal("exec_command", { cmd: "rm ../../src/a.js" }, scratch)).toBeDefined();
  });

  it("reads the other shell tools: system.bash, with or without an argument vector, and write_stdin", () => {
    expect(refusal("system.bash", { command: "rm ../../src/a.js" })).toBeDefined();
    expect(refusal("system.bash", { command: "rm", args: ["../../src/a.js"] })).toBeDefined();
    expect(refusal("system.bash", { command: "rm", args: ["src/a.js"], cwd: worktree })).toBeUndefined();
    expect(refusal("write_stdin", { session_id: 1, chars: "rm ../../src/a.js\n" })).toBeDefined();
  });

  it("leaves reads, other tools and children without a worktree alone", () => {
    for (const cmd of ["cat ../../src/a.js", "ls ../..", "git -C ../.. status", "diff ../../src/a.js src/a.js"]) {
      expect(refusal("exec_command", { cmd }), cmd).toBeUndefined();
    }
    expect(refusal("Write", { file_path: join(checkout, "src", "a.js"), content: "x" })).toBeUndefined();
    expect(worktreeShellWriteRefusal("exec_command", { cmd: "rm ../../src/a.js" }, undefined, temp)).toBeUndefined();
  });
});
