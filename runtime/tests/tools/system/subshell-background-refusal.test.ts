import { describe, expect, test } from "vitest";
import { findUnwaitedBackgroundJob } from "../../../src/tools/system/background-job-refusal.js";
import { deepSeekSubshellBackgroundGuardEnabled } from "../../../src/tools/system/subshell-background-mode.js";
import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";
import { attachToolRuntimeContext, type ToolRuntimeAttemptContext } from "../../../src/tools/runtimes/context.js";
import { buildToolRegistry } from "../../../src/tool-registry.js";
import type { Session } from "../../../src/session/session.js";
import { getSelectedProviderEnvironment, runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

// TB2 sam-cell-seg__2sETXFN step 109: the command returned "started", then
// AgenC stopped the stress test left in its subshell. The outer shell only
// slept and printed a status line; no caller was waiting for the work.
const recorded = "cd /tmp && (python -u /tmp/stress.py > /tmp/stress2.log 2>&1 &) ; sleep 2; echo started";

describe("opt-in detection of an unwaited subshell job", () => {
  test("refuses the recorded lost background process before starting it", () => {
    expect(findUnwaitedBackgroundJob(recorded, { includeSubshell: true })).toMatchObject({ kind: "trailing" });
  });
  test("keeps the existing default", () => {
    expect(findUnwaitedBackgroundJob(recorded)).toBeUndefined();
  });
  test.each([
    "(server &); sleep 1; curl -sf localhost:8000",
    "(server & sleep 1; curl -sf localhost:8000; kill $!)",
    "(a & b & wait)",
    "(server &); wait",
    "(server &) | cat",
    "(server &) > pipe",
    "producer | (reader &)",
    "(reader &) < pipe",
    "(reader &); printf hello > pipe",
    "f() { (server &); }; echo defined",
    "x=$(server &); echo $x",
    "( (server &) ); echo started",
    "if true; then (server &); fi",
    "(server &", // An incomplete command is left to the shell.
    "echo '(server &)'; echo started",
    "cat <<'EOF'\n(server &)\nEOF",
  ])("keeps work, ambiguous forms and inert text executable: %s", (cmd) => {
    expect(findUnwaitedBackgroundJob(cmd, { includeSubshell: true })).toBeUndefined();
  });
  test.each(["(nohup worker > log 2>&1 &); echo started", "cd /tmp && (setsid worker &) ; sleep 2"])(
    "detects a simple wrapped worker: %s", (cmd) => {
      expect(findUnwaitedBackgroundJob(cmd, { includeSubshell: true })).toBeDefined();
    },
  );
});

const enabledEnv = { AGENC_DEEPSEEK_SUBSHELL_BACKGROUND_GUARD: "1" };
test("the switch is off by default and applies only to DeepSeek", () => {
  expect(deepSeekSubshellBackgroundGuardEnabled("deepseek", {})).toBe(false);
  expect(deepSeekSubshellBackgroundGuardEnabled("deepseek", { AGENC_DEEPSEEK_SUBSHELL_BACKGROUND_GUARD: "off" })).toBe(false);
  expect(deepSeekSubshellBackgroundGuardEnabled("deepseek", enabledEnv)).toBe(true);
  for (const provider of [undefined, "openai", "gemini", "qwen", "qwen-token-plan", "anthropic", "grok", "zai"]) {
    expect(deepSeekSubshellBackgroundGuardEnabled(provider, enabledEnv), provider).toBe(false);
  }
});

test("preflight and execute refuse before dispatch, with no-effect evidence and unchanged schema", async () => {
  const tool = createExecCommandTool({ subshellBackgroundGuard: () => true });
  const ordinary = createExecCommandTool();
  expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(ordinary.inputSchema));
  expect(tool.description).toBe(ordinary.description);
  expect(tool.preflight!({ cmd: recorded })).toMatchObject({ code: "background-job" });
  const result = await tool.execute({ cmd: recorded });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("This command has not started");
  expect(result.content).toContain("background: true");
  expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
  for (const args of [{ cmd: recorded, detach: true }, { cmd: recorded, tty: true }]) {
    expect(tool.preflight!(args)).toEqual(ordinary.preflight!(args));
  }
});

test("a delegated call uses the invoking provider and switch instead of the parent's", () => {
  for (const [parentEnabled, provider, env, shouldRefuse] of [
    [true, "openai", enabledEnv, false],
    [true, "deepseek", {}, false],
    [false, "deepseek", enabledEnv, true],
  ] as const) {
    const tool = createExecCommandTool({ subshellBackgroundGuard: () => parentEnabled });
    const args = { cmd: recorded };
    attachToolRuntimeContext(args, {
      callId: "tb-subshell", toolName: "exec_command", sandboxMode: "danger_full_access",
      invocation: { session: { services: { provider: { name: provider }, providerEnvironment: env } } },
    } as ToolRuntimeAttemptContext);
    expect(tool.preflight!(args)?.code === "background-job").toBe(shouldRefuse);
  }
});

test("the client switch survives session capture and reaches registry preflight without changing the catalog", async () => {
  for (const provider of ["deepseek", "openai", "anthropic", "gemini", "grok", "qwen", "zai"]) {
    const catalogs: string[] = [];
    for (const enabled of [false, true]) {
      await runWithStartupProviderSelection({ provider, model: "test-model", environment: enabled ? enabledEnv : {} }, async () => {
        const registry = buildToolRegistry({
          workspaceRoot: "/tmp", lightMode: true,
          getSession: () => ({ services: {
            provider: { name: provider }, providerEnvironment: getSelectedProviderEnvironment(),
          } }) as Session,
        });
        const tool = registry.tools.find((t) => t.name === "exec_command")!;
        expect(tool.preflight!({ cmd: recorded })?.code === "background-job").toBe(enabled && provider === "deepseek");
        catalogs.push(JSON.stringify(registry.toLLMTools()));
      });
    }
    expect(catalogs[1], provider).toBe(catalogs[0]);
  }
});
