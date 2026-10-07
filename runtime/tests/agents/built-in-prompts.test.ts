import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PLAN_SYSTEM_PROMPT,
  SCANNER_SYSTEM_PROMPT,
  VERIFICATION_SYSTEM_PROMPT,
} from "../../src/agents/built-in-prompts.js";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import { canWritePathWithCwd } from "../../src/sandbox/engine/index.js";
import { permissionProfileForSandboxMode } from "../../src/tools/runtimes/sandboxing.js";

// The verification role was told to write scratch scripts to "/tmp or
// $TMPDIR". Under workspace_write the sandbox refused /tmp, and the shell
// write guard refused `> "$TMPDIR/x"` because a variable in a write target is
// indeterminate; only <workspace>/tmp/ got through. These checks hold the
// prompt to the locations both layers accept, without loosening either.

let base: string;
let workspace: string;
let sessionTempRoot: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agenc-verify-scratch-")));
  workspace = join(base, "workspace");
  sessionTempRoot = join(base, "session-temp");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionTempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function shellWrite(command: string) {
  return classifyShellWorkspaceWritePolicy({
    toolName: "system.bash",
    args: { command, cwd: workspace },
    workspaceRoot: workspace,
  });
}

describe("verification prompt scratch guidance", () => {
  it("names a literal scratch folder under the workspace tmp/ directory", () => {
    expect(VERIFICATION_SYSTEM_PROMPT).toContain(
      "except your own scratch folder under tmp/ described below",
    );
    expect(VERIFICATION_SYSTEM_PROMPT).toContain("tmp/verify-1/");
    expect(VERIFICATION_SYSTEM_PROMPT).toContain("spell that literal path out in every command");
    expect(VERIFICATION_SYSTEM_PROMPT).toContain("remove tmp/ with rmdir if you created it");
  });

  it("offers a file-free route for one-off scripts", () => {
    expect(VERIFICATION_SYSTEM_PROMPT).toContain("pipe it to its interpreter (node - <<'EOF' ... EOF)");
  });

  it("steers away from /tmp and from variables in write targets", () => {
    expect(VERIFICATION_SYSTEM_PROMPT).not.toContain("/tmp or $TMPDIR");
    expect(VERIFICATION_SYSTEM_PROMPT).toContain("Do not write to /tmp");
    expect(VERIFICATION_SYSTEM_PROMPT).toContain(
      "do not put $TMPDIR or any other variable in a write target",
    );
  });

  it("matches what the shell write guard accepts without bypassed approvals", () => {
    for (const command of [
      "mkdir -p tmp/verify-1",
      "cat > tmp/verify-1/race.mjs <<'EOF'\nconsole.log(1)\nEOF",
      "node tmp/verify-1/race.mjs",
      "node - <<'EOF'\nconsole.log(process.env.HOME)\nEOF",
      "rm -rf tmp/verify-1",
      "rmdir tmp",
    ]) {
      expect(shellWrite(command).blocked, command).toBe(false);
    }
    const variableTarget = shellWrite('echo hi > "$TMPDIR/vr-probe.txt"');
    expect(variableTarget.blocked).toBe(true);
    expect(variableTarget.indeterminate).toBe(true);
    // The folder sits under tmp/ because other workspace paths are routed to
    // the file tools, which the verification role does not have.
    expect(shellWrite("echo hi > scratch.mjs").blocked).toBe(true);
  });

  it("matches what the workspace_write sandbox accepts", () => {
    const profile = permissionProfileForSandboxMode("workspace_write", { cwd: workspace });
    const writable = (target: string) =>
      canWritePathWithCwd(profile.fileSystem, target, workspace, sessionTempRoot);
    expect(writable(join(workspace, "tmp", "verify-1", "race.mjs"))).toBe(true);
    expect(writable("/tmp/vr-probe.txt")).toBe(false);
    // The literal session temp root ($TMPDIR outside a routine run) is also
    // writable; only a variable naming it is refused, by the write guard.
    expect(writable(join(sessionTempRoot, "vr-probe.txt"))).toBe(true);
  });
});

describe("read-only role prompts", () => {
  it("forbid temporary files outright, so they name no scratch location", () => {
    for (const prompt of [SCANNER_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT]) {
      expect(prompt).toContain("Creating temporary files anywhere, including /tmp");
      expect(prompt).not.toContain("$TMPDIR");
    }
  });
});
