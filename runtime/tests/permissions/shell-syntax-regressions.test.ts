import { expect, it } from "vitest";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";

it.each([
  "sh -c \"sh -c 'tee ~/.bashrc'\"", "eval 'tee ~/.bashrc'", "(tee ~/.bashrc)",
  "{ tee ~/.bashrc; }", "f() { tee ~/.bashrc; }; f", "function f { tee ~/.bashrc; }; f",
])("retains the protected-write floor through shell syntax: %s", command => {
  expect(classifyShellWorkspaceWritePolicy({ toolName: "exec_command", args: { command }, workspaceRoot: "/repo", allowWorkspaceWrites: true, allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true }).blocked).toBe(true);
});
