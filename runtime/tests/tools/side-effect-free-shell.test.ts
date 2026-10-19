import { expect, it, vi } from "vitest";
import { observationCapableShell, prepareShellObservation } from "../../src/tools/side-effect-free-shell.js";
import { toolIsSideEffectFree } from "../../src/tools/side-effect-free.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { readReadOnlyInspectionInvocation } from "../../src/permissions/readonly-inspection.js";
import { restrictedFileSystemPolicy } from "../../src/sandbox/engine/index.js";
import type { SandboxExecutionBrokerLike } from "../../src/sandbox/execution-broker.js";
import type { Tool } from "../../src/tools/types.js";

function fixture() {
  const execute = vi.fn(async (args: Record<string, unknown>) => ({ content: JSON.stringify(readReadOnlyInspectionInvocation(args)) }));
  const tool = observationCapableShell({ name: "exec_command", execute, description: "test shell",
    inputSchema: { type: "object" }, recoveryCategory: "side-effecting", metadata: { source: "builtin", mutating: true } } as Tool);
  const broker = { forkForReadOnlyInspection: vi.fn(), runtimeSandbox: () => ({ preference: "require", permissionProfile: {
    fileSystem: restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), network: "disabled",
  } }) };
  broker.forkForReadOnlyInspection.mockReturnValue(broker);
  return { tool, execute, broker: broker as unknown as SandboxExecutionBrokerLike };
}
it("never treats names, metadata or arbitrary idempotence as implementation authority", async () => {
  const file = createFileReadTool({ allowedPaths: [process.cwd()], maxTokens: 1000 });
  expect(toolIsSideEffectFree({ ...file })).toBe(true);
  expect(toolIsSideEffectFree({ ...file, execute: vi.fn() })).toBe(false);
  expect(toolIsSideEffectFree({ ...file, recoveryCategory: "side-effecting" })).toBe(false);
  const { tool, broker } = fixture();
  expect(await prepareShellObservation({ ...tool, execute: vi.fn() }, { cmd: "cat README.md" }, process.cwd(), broker)).toBeUndefined();
});
it.skipIf(process.platform === "win32")("pins direct native argv with mandatory no-write/no-network isolation and detects rewrites", async () => {
  const { tool, execute, broker } = fixture();
  const args = { cmd: "cat README.md", login: false };
  const read = await prepareShellObservation(tool, args, process.cwd(), broker);
  expect(read).toBeDefined();
  expect(toolIsSideEffectFree(read!)).toBe(true);
  const output = JSON.parse((await read!.execute({ ...args })).content);
  expect(output).toMatchObject({ program: expect.stringMatching(/\/cat$/), args: ["README.md"],
    runtimeSandbox: { preference: "require", permissionProfile: { network: "disabled" } } });
  expect(output.env).not.toHaveProperty("BASH_ENV");
  await expect(read!.execute({ ...args, cmd: "cat README.md > changed" })).rejects.toThrow(/changed/);
  await expect(read!.execute({ ...args, detach: true })).rejects.toThrow(/changed/);
  expect(execute).toHaveBeenCalledOnce();
});
it.each([
  { cmd: "printf mutated > changed" }, { cmd: "git branch changed" }, { cmd: "cat README.md", login: true },
  { cmd: "cat README.md", tty: true }, { cmd: "cat README.md", detach: true },
  { cmd: "cat README.md", sandbox_permissions: "require_escalated" }, { cmd: "./cat README.md" },
  { cmd: "rg --pre=sh pattern ." }, { cmd: "cat README.md | head" },
])("keeps unsafe or unsupported shell on the durable path: %j", async args => {
  const { tool, broker, execute } = fixture();
  expect(await prepareShellObservation(tool, args, process.cwd(), broker)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});
it("retains durable shell dispatch if the managed boundary is unavailable", async () => {
  const { tool } = fixture();
  expect(await prepareShellObservation(tool, { cmd: "cat README.md" }, process.cwd())).toBeUndefined();
});
