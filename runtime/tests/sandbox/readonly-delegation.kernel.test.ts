import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import type { Session } from "../../src/session/session.js";

it("runs real constrained commands and native search without profiles, writes, callbacks, or denied-file reads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-readonly-delegation-"));
  const manager = new UnifiedExecProcessManager({ cwd, env: { BASH_ENV: join(cwd, "shell-profile") } });
  try {
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd });
    const status = broker.forkForReadOnlyInspection(cwd).status();
    expect(status.kind, status.reason).toBe("ready");
    await writeFile(join(cwd, "README.md"), "needle public\n");
    await writeFile(join(cwd, "secret.txt"), "needle private\n");
    await writeFile(join(cwd, "shell-profile"), "printf MALICIOUS; touch marker\n");
    await writeFile(join(cwd, ".gitattributes"), "*.md filter=malicious\n");
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["add", "README.md", "secret.txt"], { cwd });
    execFileSync("git", ["-c", "user.name=Inspection", "-c", "user.email=inspection@example.test", "commit", "--quiet", "-m", "inspection fixture"], { cwd });
    execFileSync("git", ["config", "core.fsmonitor", "sh shell-profile"], { cwd });
    execFileSync("git", ["config", "filter.malicious.clean", "sh shell-profile"], { cwd });
    execFileSync("git", ["config", "filter.malicious.process", "sh shell-profile"], { cwd });
    const permissionContext = createEmptyToolPermissionContext({ mode: "bypassPermissions" });
    const constraint = { kind: "read-only" as const, ownerThreadId: "root", deniedRules: [`FileRead(${join(cwd, "secret.txt")})`] };
    const session = { conversationId: "inspection-child", sessionConfiguration: { cwd }, permissionModeRegistry: { current: () => permissionContext }, services: { readOnlyDelegation: constraint, sandboxExecutionBroker: broker } } as Session;
    const base = buildToolRegistry({ workspaceRoot: cwd, unifiedExecManager: manager, requireAdmission: false });
    const registry = buildFilteredRegistry(base, { childConversationId: session.conversationId, executionConstraint: constraint, sandboxExecutionBroker: broker, getSession: () => session });
    const execute = registry.tools.find((tool) => tool.name === "exec_command")!;
    const content = await execute.execute({ cmd: "cat README.md", yield_time_ms: 1000 });
    expect(content.isError, content.content).not.toBe(true);
    expect(content.content).toContain("needle public");
    const statusResult = await execute.execute({ cmd: "git show HEAD:secret.txt", yield_time_ms: 1000 });
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content).toContain("repository objects");
    expect((await execute.execute({ cmd: "cat secret.txt" })).isError).toBe(true);
    expect((await execute.execute({ cmd: "touch marker" })).isError).toBe(true);
    const search = registry.tools.find((tool) => tool.name === "Grep")!;
    const found = await search.execute({ pattern: "needle", path: cwd, output_mode: "content" });
    expect(found.isError, found.content).not.toBe(true);
    expect(found.content).toContain("needle public");
    expect(found.content).not.toContain("needle private");
    expect(found.content).not.toContain("secret.txt");
    const gitConstraint = { kind: "read-only" as const, ownerThreadId: "git-owner" };
    const gitSession = { ...session, conversationId: "git-child", services: { ...session.services, readOnlyDelegation: gitConstraint } } as Session;
    const gitRegistry = buildFilteredRegistry(base, { childConversationId: gitSession.conversationId, executionConstraint: gitConstraint, sandboxExecutionBroker: broker, getSession: () => gitSession });
    const gitTool = gitRegistry.tools.find((tool) => tool.name === "exec_command")!;
    const gitResult = await gitTool.execute({ cmd: "git log --oneline -5", yield_time_ms: 1000 });
    expect(gitResult.isError, gitResult.content).not.toBe(true);
    expect(gitResult.content).not.toContain("MALICIOUS");
    const publicBlob = await gitTool.execute({ cmd: "git show HEAD:README.md", yield_time_ms: 1000 });
    expect(publicBlob.isError, publicBlob.content).not.toBe(true);
    expect(publicBlob.content).toContain("needle public");
    const unrestrictedSecretBlob = await gitTool.execute({ cmd: "git show HEAD:secret.txt", yield_time_ms: 1000 });
    expect(unrestrictedSecretBlob.isError, unrestrictedSecretBlob.content).not.toBe(true);
    expect(unrestrictedSecretBlob.content).toContain("needle private");
    for (const kind of ["path", "glob"] as const) {
      const deniedBroker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd, permissionProfile: {
        fileSystem: { kind: "restricted", entries: [
          { path: { kind: "special", value: { kind: "root" } }, access: "write" },
          { path: kind === "path" ? { kind: "path", path: join(cwd, "secret.txt") } : { kind: "glob", pattern: join(cwd, "*.txt") }, access: "none" },
        ] }, network: "enabled",
      } });
      const deniedSession = { ...gitSession, conversationId: `sandbox-denied-${kind}`, services: { ...gitSession.services, sandboxExecutionBroker: deniedBroker } } as Session;
      const deniedRegistry = buildFilteredRegistry(base, { childConversationId: deniedSession.conversationId, executionConstraint: gitConstraint, sandboxExecutionBroker: deniedBroker, getSession: () => deniedSession });
      const deniedReader = deniedRegistry.tools.find(tool => tool.name === "FileRead")!;
      expect((await deniedReader.execute({ file_path: join(cwd, "secret.txt") })).isError).toBe(true);
      const deniedGit = deniedRegistry.tools.find(tool => tool.name === "exec_command")!;
      const secretBlob = await deniedGit.execute({ cmd: "git show HEAD:secret.txt", yield_time_ms: 1000 });
      expect(secretBlob.isError, secretBlob.content).toBe(true);
      expect(secretBlob.content).toContain("repository objects");
      expect(secretBlob.content).not.toContain("needle private");
    }
    await expect(readFile(join(cwd, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await manager.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});
