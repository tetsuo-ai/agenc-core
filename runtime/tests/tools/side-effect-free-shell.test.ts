import { expect, it, vi } from "vitest";
import { observationCapableShell, prepareShellObservation } from "../../src/tools/side-effect-free-shell.js";
import { toolIsSideEffectFree } from "../../src/tools/side-effect-free.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { readReadOnlyInspectionInvocation, readReadOnlyShellInvocation } from "../../src/permissions/readonly-inspection.js";
import { restrictedFileSystemPolicy } from "../../src/sandbox/engine/index.js";
import type { SandboxExecutionBrokerLike } from "../../src/sandbox/execution-broker.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";

function fixture(options: { readonly shellAvailable?: boolean; readonly result?: () => ToolResult | Promise<ToolResult> } = {}) {
  const execute = vi.fn(async (args: Record<string, unknown>): Promise<ToolResult> => options.result?.() ?? ({
    content: JSON.stringify(readReadOnlyInspectionInvocation(args) ?? readReadOnlyShellInvocation(args)),
    metadata: { exitCode: 0 },
  }));
  const tool = observationCapableShell({ name: "exec_command", execute, description: "test shell",
    inputSchema: { type: "object" }, recoveryCategory: "side-effecting", metadata: { source: "builtin", mutating: true } } as Tool,
  { readOnlyShellAvailable: () => options.shellAvailable ?? true });
  const broker = { forkForReadOnlyInspection: vi.fn(), runtimeSandbox: () => ({ preference: "require", permissionProfile: {
    fileSystem: restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), network: "disabled",
  } }) };
  broker.forkForReadOnlyInspection.mockReturnValue(broker);
  return { tool, execute, broker: broker as unknown as SandboxExecutionBrokerLike, owner: {} };
}
it("never treats names, metadata or arbitrary idempotence as implementation authority", async () => {
  const file = createFileReadTool({ allowedPaths: [process.cwd()], maxTokens: 1000 });
  expect(toolIsSideEffectFree({ ...file })).toBe(true);
  expect(toolIsSideEffectFree({ ...file, execute: vi.fn() })).toBe(false);
  expect(toolIsSideEffectFree({ ...file, recoveryCategory: "side-effecting" })).toBe(false);
  const { tool, broker, owner } = fixture();
  expect(await prepareShellObservation({ ...tool, execute: vi.fn() }, { cmd: "cat README.md" }, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
  expect(await prepareShellObservation({ ...tool, execute: vi.fn() }, { cmd: "cat README.md | head" }, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
});
it.skipIf(process.platform === "win32")("pins direct native argv with mandatory no-write/no-network isolation and detects rewrites", async () => {
  const { tool, execute, broker, owner } = fixture();
  const args = { cmd: "cat README.md", login: false };
  const read = await prepareShellObservation(tool, args, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true });
  expect(read).toBeDefined();
  expect(toolIsSideEffectFree(read!)).toBe(true);
  const output = JSON.parse(String((await read!.execute({ ...args })).content));
  expect(output).toMatchObject({ program: expect.stringMatching(/\/cat$/), args: ["README.md"],
    runtimeSandbox: { preference: "require", permissionProfile: { network: "disabled" } } });
  expect(output.env).not.toHaveProperty("BASH_ENV");
  await expect(read!.execute({ ...args, cmd: "cat README.md > changed" })).rejects.toThrow(/changed/);
  await expect(read!.execute({ ...args, detach: true })).rejects.toThrow(/changed/);
  expect(execute).toHaveBeenCalledOnce();
});
it.skipIf(process.platform === "win32")("runs a classified command line through the session shell in the same read-only sandbox", async () => {
  const { tool, execute, broker, owner } = fixture();
  const args = { cmd: "cd src && ls -la | sort | head -5", workdir: "pkg" };
  const read = await prepareShellObservation(tool, args, "/project", broker, { owner: owner, ordinaryPathSandboxed: true });
  expect(read).toBeDefined();
  expect(toolIsSideEffectFree(read!)).toBe(true);
  expect(read!.isReadOnly).toBe(true);
  const output = JSON.parse(String((await read!.execute({ ...args })).content));
  expect(output).toEqual({ command: args.cmd, cwd: "/project/pkg",
    runtimeSandbox: expect.objectContaining({ preference: "require", permissionProfile: expect.objectContaining({ network: "disabled" }) }) });
  for (const changed of [{ cmd: "cd src && rm -rf ." }, { cmd: "cd src && ls" }, { workdir: "other" }, { detach: true }, { login: true }]) {
    await expect(read!.execute({ ...args, ...changed })).rejects.toThrow(/changed after approval/);
  }
  expect(execute).toHaveBeenCalledOnce();
});
it.each([
  { cmd: "printf mutated > changed" }, { cmd: "git branch changed" }, { cmd: "cat README.md", login: true },
  { cmd: "cat README.md", tty: true }, { cmd: "cat README.md", detach: true },
  { cmd: "cat README.md", sandbox_permissions: "require_escalated" }, { cmd: "./cat README.md" },
  { cmd: "rg --pre=sh pattern ." }, { cmd: "ls | xargs rm" }, { cmd: "cat a; touch b" }, { cmd: "ls | head", shell: "/bin/zsh" },
  { cmd: "sed -i s/a/b/ file" }, { cmd: "cat $(touch marker)" }, { cmd: "cat README.md &" }, { cmd: "npm test 2>&1 | tail" },
])("keeps unsafe or unsupported shell on the durable path: %j", async args => {
  const { tool, broker, execute, owner } = fixture();
  expect(await prepareShellObservation(tool, args, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});
it("keeps command lines durable without a shell that can run them read-only or an owner to remember failures", async () => {
  const unavailable = fixture({ shellAvailable: false });
  expect(await prepareShellObservation(unavailable.tool, { cmd: "ls | head" }, process.cwd(), unavailable.broker, { owner: unavailable.owner, ordinaryPathSandboxed: true })).toBeUndefined();
  const ownerless = fixture();
  expect(await prepareShellObservation(ownerless.tool, { cmd: "ls | head" }, process.cwd(), ownerless.broker, { ordinaryPathSandboxed: true })).toBeUndefined();
  // A literal inspection needs neither.
  expect(await prepareShellObservation(ownerless.tool, { cmd: "ls" }, process.cwd(), ownerless.broker, { ordinaryPathSandboxed: true })).toBeDefined();
});
it.each([
  ["an error result", { content: "touch: cannot touch 'x': Read-only file system", isError: true }],
  ["a nonzero exit", { content: "", metadata: { exitCode: 2 } }],
  ["a thrown failure", new Error("launch failed")],
] as const)("returns %s as it is and sends the same command line down the ordinary path next time", async (_name, outcome) => {
  const { tool, execute, broker, owner } = fixture({ result: () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } });
  const args = { cmd: "cat notes.txt | head" };
  const read = await prepareShellObservation(tool, args, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true });
  if (outcome instanceof Error) await expect(read!.execute({ ...args })).rejects.toBe(outcome);
  else expect(await read!.execute({ ...args })).toBe(outcome);
  // Never retried automatically: the read-only run's own failure is the answer.
  expect(execute).toHaveBeenCalledOnce();
  expect(await prepareShellObservation(tool, args, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
  expect(await prepareShellObservation(tool, { ...args, workdir: "sub" }, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeDefined();
  expect(await prepareShellObservation(tool, { cmd: "cat other.txt | head" }, process.cwd(), broker, { owner: owner, ordinaryPathSandboxed: true })).toBeDefined();
  expect(await prepareShellObservation(tool, args, process.cwd(), broker, { owner: {}, ordinaryPathSandboxed: true })).toBeDefined();
});
it("remembers no successful command line and only a bounded number of failures", async () => {
  const succeeded = fixture();
  const ok = await prepareShellObservation(succeeded.tool, { cmd: "ls | head" }, process.cwd(), succeeded.broker, { owner: succeeded.owner, ordinaryPathSandboxed: true });
  await ok!.execute({ cmd: "ls | head" });
  expect(await prepareShellObservation(succeeded.tool, { cmd: "ls | head" }, process.cwd(), succeeded.broker, { owner: succeeded.owner, ordinaryPathSandboxed: true })).toBeDefined();
  const failing = fixture({ result: () => ({ content: "", isError: true }) });
  for (let index = 0; index <= 256; index += 1) {
    const cmd = `ls dir${index} | head`;
    await (await prepareShellObservation(failing.tool, { cmd }, process.cwd(), failing.broker, { owner: failing.owner, ordinaryPathSandboxed: true }))!.execute({ cmd });
  }
  expect(await prepareShellObservation(failing.tool, { cmd: "ls dir0 | head" }, process.cwd(), failing.broker, { owner: failing.owner, ordinaryPathSandboxed: true })).toBeDefined();
  expect(await prepareShellObservation(failing.tool, { cmd: "ls dir256 | head" }, process.cwd(), failing.broker, { owner: failing.owner, ordinaryPathSandboxed: true })).toBeUndefined();
});
it("keeps the ordinary path whenever that path would run unsandboxed", async () => {
  const { tool, broker, owner, execute } = fixture();
  for (const cmd of ["cat README.md", "cat README.md | head"]) {
    expect(await prepareShellObservation(tool, { cmd }, process.cwd(), broker, { owner, ordinaryPathSandboxed: false })).toBeUndefined();
  }
  expect(execute).not.toHaveBeenCalled();
});
it("retains durable shell dispatch if the managed boundary is unavailable", async () => {
  const { tool, owner } = fixture();
  expect(await prepareShellObservation(tool, { cmd: "cat README.md" }, process.cwd(), undefined, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
  expect(await prepareShellObservation(tool, { cmd: "cat README.md | head" }, process.cwd(), undefined, { owner: owner, ordinaryPathSandboxed: true })).toBeUndefined();
});
