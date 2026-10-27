import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

function productionMethodCalls(
  methods: readonly string[],
): string[] {
  const pattern = new RegExp(
    `\\.(${methods.join("|")})\\s*(?:\\?\\.)?\\s*\\(`,
    "gu",
  );
  return sourceFiles(sourceRoot)
    .flatMap((path) => {
      const name = relative(sourceRoot, path).replaceAll("\\", "/");
      return Array.from(
        readFileSync(path, "utf8").matchAll(pattern),
        (match) => `${name}:${match[1]}`,
      );
    })
    .sort();
}

describe("sandbox execution ingress architecture", () => {
  test("enumerates every production command, runtime sandbox, and child-broker ingress", () => {
    expect(
      productionMethodCalls(["prepareSpawn", "runtimeSandbox", "forkForCwd", "forkForReadOnlyInspection"]),
    ).toEqual([
      "agents/delegate.ts:forkForCwd",
      // Goal plans inspect the owned workflow checkout through a scoped broker.
      "agents/delegate.ts:forkForCwd",
      "agents/delegate.ts:forkForCwd",
      "agents/run-agent.ts:forkForCwd",
      "agents/run-agent.ts:forkForReadOnlyInspection",
      "agents/run-agent.ts:runtimeSandbox",
      "agents/worktree.ts:prepareSpawn",
      "agents/worktree.ts:runtimeSandbox",
      "app-server/workflow/session-adapters.ts:forkForCwd",
      "app-server/workflow/session-adapters.ts:prepareSpawn",
      "browser/cdp.ts:prepareSpawn",
      "context.ts:prepareSpawn",
      "hooks/engine/command-runner.ts:prepareSpawn",
      "mcp-client/transports/stdio.ts:prepareSpawn",
      "prompts/attachments/user-pdf-input.ts:prepareSpawn",
      "prompts/system-prompt.ts:prepareSpawn",
      "services/autoFix/autoFixRunner.ts:prepareSpawn",
      "services/lsp/LSPClient.ts:prepareSpawn",
      "services/xai/acp.ts:prepareSpawn",
      "session/agenc-delegate.ts:forkForCwd",
      "session/turn-compat.ts:forkForCwd",
      // The read-only fast path narrows the session broker to an inspection
      // fork (every write grant lowered to read, read denials kept, network
      // disabled), through this one call pair for both of its routes. It
      // launches there only a verified literal inspection, pinned to a
      // root-owned native executable, or a command line the read-only
      // classification admits, run through a system-owned POSIX shell:
      // prepareReadOnlyInspectionInvocation and prepareReadOnlyShellInvocation
      // refuse any sandbox that is not mandatory, no-write and no-network, and
      // the process manager asserts it again before launch. Neither call can
      // widen authority; a command that tries to write fails with a read-only
      // file system, and the network seccomp program refuses every connect.
      "tools/side-effect-free-shell.ts:forkForReadOnlyInspection",
      "tools/side-effect-free-shell.ts:runtimeSandbox",
      "tools/system/apply-runtime-sandbox.ts:prepareSpawn",
      "tools/system/bash.ts:prepareSpawn",
      "tools/system/coding-common.ts:prepareSpawn",
      "tools/system/exec-command.ts:runtimeSandbox",
      "tools/worktree-sandbox-boundary.ts:prepareSpawn",
      "utils/Shell.ts:prepareSpawn",
      "utils/hooks.ts:prepareSpawn",
      "utils/pdf.ts:prepareSpawn",
      "utils/pdf.ts:prepareSpawn",
      "utils/powershell/parser.ts:prepareSpawn",
      "utils/worktree.ts:forkForCwd",
      "utils/worktree.ts:prepareSpawn",
    ]);
  });

  test("keeps lifecycle mutation and fence primitives inside the coordinator", () => {
    expect(
      productionMethodCalls([
        "beginLifecycleAuthorityTransition",
        "proveLifecycleParticipantsQuiesced",
        "applyAuthorityAfterLifecycleQuiesce",
        "rebaseAfterLifecycleQuiesce",
        "endLifecycleAuthorityTransition",
      ]),
    ).toEqual([
      "sandbox/execution-lifecycle.ts:applyAuthorityAfterLifecycleQuiesce",
      "sandbox/execution-lifecycle.ts:applyAuthorityAfterLifecycleQuiesce",
      "sandbox/execution-lifecycle.ts:applyAuthorityAfterLifecycleQuiesce",
      "sandbox/execution-lifecycle.ts:beginLifecycleAuthorityTransition",
      "sandbox/execution-lifecycle.ts:endLifecycleAuthorityTransition",
      "sandbox/execution-lifecycle.ts:proveLifecycleParticipantsQuiesced",
      "sandbox/execution-lifecycle.ts:proveLifecycleParticipantsQuiesced",
      "sandbox/execution-lifecycle.ts:proveLifecycleParticipantsQuiesced",
      "sandbox/execution-lifecycle.ts:proveLifecycleParticipantsQuiesced",
      "sandbox/execution-lifecycle.ts:rebaseAfterLifecycleQuiesce",
      "sandbox/execution-lifecycle.ts:rebaseAfterLifecycleQuiesce",
    ]);
  });
});
