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
    `\\.(${methods.join("|")})\\s*\\(`,
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
      productionMethodCalls(["prepareSpawn", "runtimeSandbox", "forkForCwd"]),
    ).toEqual([
      "agents/delegate.ts:forkForCwd",
      "agents/delegate.ts:forkForCwd",
      "agents/run-agent.ts:forkForCwd",
      "agents/worktree.ts:prepareSpawn",
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
      "tools/system/apply-runtime-sandbox.ts:prepareSpawn",
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
