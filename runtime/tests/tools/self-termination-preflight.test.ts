import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/permissions/self-termination.js", () => ({
  selfTerminationRisk: (command: string) => command.includes("pkill") ? "Refused a kill command matching fixture AgenC pid 42" : null,
}));
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import { createBashTool } from "../../src/tools/system/bash.js";
import { preflightShellWorkspaceWritePolicy } from "../../src/tools/system/shell-preflight.js";

afterEach(() => vi.restoreAllMocks());
it("refuses self-matching shell commands in both tool preflights even with unrestricted Bash", () => {
  const exec = createExecCommandTool({ cwd: "/tmp" });
  const bash = createBashTool({ cwd: "/tmp", unrestricted: true });
  expect(exec.preflight?.({ cmd: "pkill -f fixture.py" })).toMatchObject({ code: "self_termination" });
  expect(bash.preflight?.({ command: "pkill", args: ["-f", "fixture.py"] })).toMatchObject({ code: "self_termination" });
  expect(preflightShellWorkspaceWritePolicy({ toolName: "write_stdin", args: { chars: "pkill -f fixture.py\n" } }))
    .toMatchObject({ code: "self_termination" });
});
