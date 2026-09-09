import { describe, expect, it } from "vitest";

import {
  readOnlyGrantRefusalMessage,
  readOnlyGrantVerdict,
  readShellCommand,
  shellToolIsGrantable,
  type ReadOnlyGrantTool,
  type ShellGateDeps,
} from "../../src/permissions/read-only-grant.js";
import { checkReadOnlyConstraints } from "../../src/tools/BashTool/readOnlyValidation.js";
import { checkPathConstraints } from "../../src/tools/BashTool/pathValidation.js";
import { createEmptyToolPermissionContext } from "./types.js";

const CWD = "/workspace/project";
const context = createEmptyToolPermissionContext({
  mode: "unattended",
  additionalWorkingDirectories: new Map([
    [CWD, { path: CWD, source: "session" as const }],
  ]),
});

/** The real gates, so the table is checked against shipped behaviour. */
const deps: ShellGateDeps = {
  checkReadOnly: (input) =>
    checkReadOnlyConstraints(input as never, false) as { behavior: string },
  checkPaths: (input, cwd, ctx) =>
    checkPathConstraints(input as never, cwd, ctx) as { behavior: string },
};

const tool = (
  name: string,
  overrides: Partial<ReadOnlyGrantTool> = {},
): ReadOnlyGrantTool => ({
  name,
  metadata: { source: "builtin", ...(overrides.metadata ?? {}) },
  ...overrides,
});

const readOnlyBuiltin = (name: string): ReadOnlyGrantTool =>
  tool(name, {
    isReadOnly: true,
    recoveryCategory: "idempotent",
    metadata: { source: "builtin", mutating: false },
  });

const verdict = (t: ReadOnlyGrantTool, input: unknown = {}) =>
  readOnlyGrantVerdict(t, input, CWD, context, deps);

describe("unattended read-only grant", () => {
  it("admits the confined read tools", () => {
    for (const name of ["FileRead", "Grep", "Glob", "system.listDir", "system.stat"]) {
      expect(verdict(readOnlyBuiltin(name)), name).toEqual({ granted: true });
    }
  });

  it("admits a read-only shell command that stays inside the project", () => {
    for (const command of [
      "git log --oneline -5",
      "git status",
      "ls",
      "cat README.md",
      "grep -r TODO .",
      "wc -l package.json",
    ]) {
      expect(
        verdict(tool("system.bash"), { command }),
        command,
      ).toEqual({ granted: true });
    }
  });

  it("reads exec_command's command off its own key", () => {
    expect(readShellCommand("exec_command", { cmd: "ls" })).toMatchObject({ command: "ls" });
    expect(readShellCommand("system.bash", { command: "ls" })).toMatchObject({ command: "ls" });
    // Each tool ignores the other's key, so a command cannot arrive unchecked.
    expect(readShellCommand("exec_command", { command: "ls" })).toBeNull();
    expect(readShellCommand("system.bash", { cmd: "ls" })).toBeNull();
    expect(verdict(tool("exec_command"), { cmd: "git log -1" })).toEqual({ granted: true });
  });

  it("refuses a command that reads outside the project folder", () => {
    // Read-only in the sense of "writes nothing", which is not the same as
    // "stays here". The path gate is the half that decides this.
    for (const command of [
      "cat ~/.ssh/id_rsa",
      "cat /Users/someone/.ssh/id_rsa",
      "cat ~/.agenc/wallet.json",
      "head -c 100 /etc/passwd",
      "cat ../outside/secret.txt",
    ]) {
      const result = verdict(tool("system.bash"), { command });
      expect(result.granted, command).toBe(false);
      if (!result.granted) {
        expect(result.refusal.kind).toBe("shell");
        if (result.refusal.kind === "shell") {
          expect(result.refusal.reason).toContain("outside this project folder");
        }
      }
    }
  });

  it("refuses a command that changes anything", () => {
    for (const command of ["rm -rf build", "npm install", "git push", "echo x > out.txt"]) {
      const result = verdict(tool("system.bash"), { command });
      expect(result.granted, command).toBe(false);
    }
  });

  it("refuses a shell tool that can reach a running process or outlive the run", () => {
    expect(shellToolIsGrantable("system.bash")).toBe(true);
    expect(shellToolIsGrantable("exec_command")).toBe(true);
    expect(shellToolIsGrantable("write_stdin")).toBe(false);
    expect(shellToolIsGrantable("system.background.bash")).toBe(false);
    expect(verdict(tool("write_stdin"), { command: "ls" }).granted).toBe(false);
    expect(verdict(tool("system.background.bash"), { command: "ls" }).granted).toBe(false);
  });

  it("accepts a workdir that names this folder in another form", () => {
    // Observed live: a routine's own agent passed `workdir: "."`, which is
    // the run's folder, and the string comparison called it a different one.
    // The run then had no way to read the project it was created for.
    for (const workdir of [".", "./", `${CWD}/`, `${CWD}/.`, "./sub/.."]) {
      expect(
        verdict(tool("exec_command"), { cmd: "git status", workdir }).granted,
        workdir,
      ).toBe(true);
    }
  });

  it("still refuses a workdir that genuinely leaves the folder", () => {
    for (const workdir of ["..", "/tmp", `${CWD}/../sibling`, "sub"]) {
      const result = verdict(tool("exec_command"), { cmd: "ls", workdir });
      expect(result.granted, workdir).toBe(false);
      if (!result.granted && result.refusal.kind === "shell") {
        expect(result.refusal.reason).toContain("different folder");
      }
    }
  });

  it("admits tool discovery, which declares itself side-effecting", () => {
    // system.searchTools carries recoveryCategory "side-effecting" for
    // recovery purposes and writes nothing (virtualNoFsWrites). Refusing it
    // left an unattended run unable to find the tools it is allowed to use.
    expect(verdict(tool("system.searchTools")).granted).toBe(true);
    // Loading a schema does not widen what may run: a non-builtin tool is
    // still refused when it is actually called.
    expect(
      verdict({ name: "system.searchTools", metadata: { source: "mcp" } })
        .granted,
    ).toBe(false);
  });

  it("refuses a command that moves its own working directory", () => {
    expect(verdict(tool("exec_command"), { cmd: "ls", workdir: "/elsewhere" }).granted).toBe(false);
    expect(verdict(tool("exec_command"), { cmd: "ls", workdir: CWD }).granted).toBe(true);
  });

  it("refuses every non-builtin source, whatever it says about itself", () => {
    // tagTool stamps requiresApproval:false on any tool it does not know, and
    // an MCP server supplies its own readOnlyHint. Neither may buy a grant.
    for (const source of ["mcp", "plugin", "dynamic", undefined]) {
      const t: ReadOnlyGrantTool = {
        name: "mcp.server.looks_harmless",
        isReadOnly: true,
        requiresApproval: false,
        recoveryCategory: "idempotent",
        metadata: { mutating: false, ...(source === undefined ? {} : { source }) },
      };
      const result = verdict(t);
      expect(result.granted, String(source)).toBe(false);
      if (!result.granted) expect(result.refusal.kind).toBe("source");
    }
  });

  it("refuses the network family even though each declares itself read-only", () => {
    for (const name of ["web_fetch", "WebSearch", "XSearch"]) {
      expect(verdict(readOnlyBuiltin(name)).granted, name).toBe(false);
    }
  });

  it("refuses Skill, whose content is instructions this run would follow", () => {
    expect(verdict(readOnlyBuiltin("Skill")).granted).toBe(false);
  });

  it("refuses the plan hand-off and says why", () => {
    for (const name of ["ExitPlanMode", "EnterPlanMode"]) {
      const result = verdict(readOnlyBuiltin(name));
      expect(result.granted, name).toBe(false);
      if (!result.granted) expect(result.refusal.kind).toBe("planHandoff");
    }
    expect(readOnlyGrantRefusalMessage("ExitPlanMode", { kind: "planHandoff" }))
      .toContain("hands a plan to a person");
  });

  it("refuses anything that wants to ask a person", () => {
    const asks = tool("SomeTool", {
      isReadOnly: true,
      recoveryCategory: "idempotent",
      metadata: { source: "builtin", mutating: false },
      requiresUserInteraction: () => true,
    });
    expect(verdict(asks).granted).toBe(false);
  });

  it("needs all three clauses, so a half-declared tool is refused", () => {
    const base = { source: "builtin" as const, mutating: false };
    // Each row drops exactly one clause of the conjunction.
    expect(verdict(tool("A", { recoveryCategory: "idempotent", metadata: base })).granted).toBe(false);
    expect(verdict(tool("B", { isReadOnly: true, metadata: base })).granted).toBe(false);
    expect(
      verdict(tool("C", {
        isReadOnly: true,
        recoveryCategory: "idempotent",
        metadata: { source: "builtin", mutating: true },
      })).granted,
    ).toBe(false);
    expect(
      verdict(tool("D", {
        isReadOnly: true,
        recoveryCategory: "side-effecting",
        metadata: base,
      })).granted,
    ).toBe(false);
    // A tool that says nothing about itself fails all of them.
    expect(verdict(tool("E")).granted).toBe(false);
  });

  it("never answers 'ask', because there is nobody to ask", () => {
    const rows: Array<[ReadOnlyGrantTool, unknown]> = [
      [readOnlyBuiltin("FileRead"), {}],
      [tool("system.bash"), { command: "cat ~/.ssh/id_rsa" }],
      [tool("Write", { metadata: { source: "builtin", mutating: true } }), {}],
      [readOnlyBuiltin("web_fetch"), {}],
    ];
    for (const [t, input] of rows) {
      const result = verdict(t, input);
      expect(typeof result.granted).toBe("boolean");
    }
  });
});
