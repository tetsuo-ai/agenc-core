import { describe, expect, test } from "vitest";
import { runPostToolUseHooks } from "../../tools/hooks.js";
import { getAutoFixConfig } from "./autoFixConfig.js";
import {
  buildAutoFixContext,
  createAutoFixPostToolHook,
  shouldRunAutoFix,
} from "./autoFixHook.js";
import { runAutoFixCheck } from "./autoFixRunner.js";
import { explicitDangerBroker } from "../../helpers/explicit-danger-boundary.js";

const TEST_CWD = process.cwd();

describe("autoFix end-to-end flow", () => {
  test("config to check to context", async () => {
    const config = getAutoFixConfig({
      enabled: true,
      lint: 'node -e "console.log(\\"error: unused\\"); process.exit(1)"',
      maxRetries: 2,
      timeout: 5_000,
    });
    expect(config).not.toBeNull();
    expect(shouldRunAutoFix("Edit", config)).toBe(true);

    const result = await runAutoFixCheck({
      lint: config!.lint,
      test: config!.test,
      timeout: config!.timeout,
      cwd: TEST_CWD,
      sandboxExecutionBroker: explicitDangerBroker,
    });
    expect(result.hasErrors).toBe(true);

    const context = buildAutoFixContext(result);
    expect(context).not.toBeNull();
    expect(context).toContain("AUTO-FIX");
    expect(context).toContain("unused");
  });

  test("post-tool hook contributes additional context to the hook pipeline", async () => {
    const hook = createAutoFixPostToolHook({
      configSource: () => ({
        enabled: true,
        lint: "lint",
        maxRetries: 2,
        timeout: 5_000,
      }),
      cwd: TEST_CWD,
      runCheck: async () => ({
        hasErrors: true,
        errorSummary: "Lint errors (exit code 1):\nsrc/foo.ts:1:1 bad",
      }),
    });

    const result = await runPostToolUseHooks([hook], {
      invocation: {
        callId: "call-1",
        toolName: { name: "Edit" },
        payload: { kind: "function", arguments: "{}" },
        source: "direct",
        session: {},
        turn: { subId: "turn-1" },
        tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      },
      tool: {
        name: "Edit",
        inputSchema: {},
        execute: async () => ({ content: "ok" }),
      },
      args: {},
      result: { content: "ok" },
    });

    expect(result.additionalContexts).toHaveLength(1);
    expect(result.additionalContexts[0]).toContain("src/foo.ts:1:1 bad");
  });

  test("no errors produce no context", async () => {
    const config = getAutoFixConfig({
      enabled: true,
      lint: 'node -e "console.log(\\"all clean\\")"',
      timeout: 5_000,
    });
    const result = await runAutoFixCheck({
      lint: config!.lint,
      timeout: config!.timeout,
      cwd: TEST_CWD,
      sandboxExecutionBroker: explicitDangerBroker,
    });
    expect(result.hasErrors).toBe(false);
    expect(buildAutoFixContext(result)).toBeNull();
  });
});
