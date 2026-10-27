import { describe, expect, it } from "vitest";
import { classifyShellWorkspaceWritePolicy, collectShellWorkspaceMutationTargets } from "../../src/llm/shell-write-policy.js";
import { unwrapToolError, summarizeToolError } from "../../src/tui/tool-error-text.js";

const command = "mkdir -p lava/src lava/tests lava/vendor && cp game/vendor/three.module.js lava/vendor/three.module.js && ls -la lava lava/vendor";
const input = { toolName: "exec_command", workspaceRoot: "/repo", args: { command } };
describe("RC3 shell write guard", () => {
  it("passes read globs, pipes, null redirects and find literal options", () => {
    const command = 'ls ~/Library/Caches/ms-playwright/chromium_headless_shell-1243/*/ 2>/dev/null | head; echo ---; find ~/Library/Caches/ms-playwright -maxdepth 3 -type f -name "*chrome*" 2>/dev/null | head';
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command } }).blocked).toBe(false);
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command: "find . -unsupported" } }).blocked).toBe(false);
  });
  it.each(['printf "%s\\n" "$(pwd)"', 'echo $(pwd)', 'echo "`pwd`"', 'echo "$((1+2))"', 'echo "$(echo $(pwd))"']) ("allows a read-only substitution: %s", (command) => {
    const decision = classifyShellWorkspaceWritePolicy({ ...input, args: { command } });
    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
  });
  it.each(['echo "$(touch .git/config)"', 'echo "$(echo $(touch .git/config))"', 'echo "`touch .git/config`"']) ("retains protected embedded writes in bypass: %s", (command) => {
    const decision = classifyShellWorkspaceWritePolicy({ ...input, args: { command }, bypassesApprovalsAndSandbox: true });
    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toContain("/repo/.git/config");
  });
  it("classifies embedded workspace writes, and keeps opaque substitutions guarded", () => {
    const decision = classifyShellWorkspaceWritePolicy({ ...input, args: { command: 'echo "$(touch src/nested)"' } });
    expect(decision.blocked).toBe(true);
    expect(decision.observedTargets).toContain("/repo/src/nested");
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command: 'echo "$(node -e foo)"' } }).indeterminate).toBe(true);
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command: 'echo "$(node -e foo)"' }, validationPhase: "preflight" }).blocked).toBe(false);
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command: 'echo "$(node -e foo)"' }, allowWorkspaceWrites: true }).blocked).toBe(false);
    expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command: 'echo "$(echo \'$(touch .git/config)\')"' } }).blocked).toBe(false);
  });
  it("routes a content write through preflight then permits an approved edit", () => {
    expect(classifyShellWorkspaceWritePolicy(input).blocked).toBe(true);
    expect(classifyShellWorkspaceWritePolicy({ ...input, validationPhase: "preflight" }).blocked).toBe(false);
    expect(classifyShellWorkspaceWritePolicy({ ...input, allowWorkspaceWrites: true }).blocked).toBe(false);
    expect(classifyShellWorkspaceWritePolicy({ ...input, bypassesApprovalsAndSandbox: true }).blocked).toBe(false);
    expect(collectShellWorkspaceMutationTargets(input)).toContain("/repo/lava/vendor/three.module.js");
  });
  it("keeps protected writes and outside removals blocked with edit consent", () => {
    for (const command of ["echo no > .git/config", "rm /etc/hosts"]) {
      expect(classifyShellWorkspaceWritePolicy({ ...input, args: { command }, allowWorkspaceWrites: true, allowWorkspaceDeletions: true }).blocked).toBe(true);
    }
  });
  it("displays the reason from terminal JSON envelopes", () => {
    const raw = JSON.stringify({ tool_use_id: "call1", is_error: true, content: "<tool_use_error>tool aborted before completion</tool_use_error>" });
    expect(unwrapToolError(raw)).toBe("<tool_use_error>tool aborted before completion</tool_use_error>");
    expect(summarizeToolError(raw)).toBe("tool aborted before completion");
  });
});
