import { describe, expect, it, vi } from "vitest";

// shouldUseSandbox.ts:22 (core-todo.md): containsExcludedCommand carried a dead
// "dynamic config" scaffold (a hardcoded-empty { commands, substrings } and two
// loops that could never match) alongside the live settings-driven path. The
// dead scaffold was removed (it is a convenience path, not a security boundary,
// so it must not be re-wired to exclude MORE commands from the sandbox). This
// characterizes the surviving behavior: only settings.sandbox.excludedCommands
// takes a command out of the sandbox.

vi.mock("../../../src/utils/sandbox/sandbox-runtime.js", () => ({
  SandboxManager: {
    isSandboxingEnabled: () => true,
    areUnsandboxedCommandsAllowed: () => true,
  },
}));

const excludedCommands: string[] = [];
vi.mock("../../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({ sandbox: { excludedCommands } }),
}));

const { shouldUseSandbox } = await import(
  "../../../src/tools/BashTool/shouldUseSandbox.js"
);

describe("shouldUseSandbox — excluded-commands path", () => {
  it("sandboxes an ordinary command", () => {
    excludedCommands.length = 0;
    expect(shouldUseSandbox({ command: "ls -la" })).toBe(true);
  });

  it("does not sandbox a command matching a user-configured exclusion", () => {
    excludedCommands.length = 0;
    excludedCommands.push("bazel:*");
    expect(shouldUseSandbox({ command: "bazel build //..." })).toBe(false);
    // A command that does not match the exclusion is still sandboxed — the
    // removed dead scaffold never excluded anything on its own.
    expect(shouldUseSandbox({ command: "curl https://evil.example" })).toBe(true);
  });

  it("matches an exclusion through env-var and wrapper prefixes", () => {
    excludedCommands.length = 0;
    excludedCommands.push("bazel:*");
    // `FOO=bar timeout 30 bazel test` strips to `bazel test` and matches bazel:*.
    expect(shouldUseSandbox({ command: "FOO=bar timeout 30 bazel test //x" })).toBe(
      false,
    );
  });
});
