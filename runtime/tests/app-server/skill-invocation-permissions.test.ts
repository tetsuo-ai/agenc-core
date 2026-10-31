/**
 * A skill turn's `allowed-tools` grants reach every tool call of that turn,
 * through the ordinary dispatch path and through code-mode nested calls, and
 * only while the current permission policy allows rules from outside managed
 * settings: a policy reload during the turn revokes them from the next
 * evaluation on.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { hasPermissionsToUseTool } from "../../src/permissions/evaluator.js";
import { buildLiveToolDispatchOptions } from "../../src/phases/execute-tools.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import { startCodeModeTurnWorker } from "../../src/tools/code-mode/turn-host.js";
import type {
  CodeModeService,
  CodeModeTurnHost,
} from "../../src/tools/code-mode/types.js";
import type { Tool } from "../../src/tools/types.js";
import {
  deepSeekSkillTurnSession,
  reloadManagedPolicy,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

afterEach(() => {
  removeSkillTurnHomes();
});

/** A read-only lookup that asks before each call unless a rule allows it. */
function lookupTool(execute: Tool["execute"]): Tool {
  return {
    name: "custom.lookup",
    description: "Look a value up.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    recoveryCategory: "idempotent",
    checkPermissions: () => ({
      behavior: "ask",
      message: "custom.lookup needs approval",
    }),
    execute,
  } as Tool;
}

function capturingCodeModeService(): {
  readonly service: CodeModeService;
  host(): CodeModeTurnHost;
} {
  let captured: CodeModeTurnHost | undefined;
  const service = {
    enabled: () => true,
    startTurnWorker(host: CodeModeTurnHost) {
      captured = host;
      return { dispose: () => undefined };
    },
  } as unknown as CodeModeService;
  return {
    service,
    host: () => {
      if (captured === undefined) throw new Error("no code-mode worker started");
      return captured;
    },
  };
}

/**
 * A daemon-style session whose registry dispatches `custom.lookup`, with a
 * code-mode service and a managed policy file a test can change.
 */
function lookupSession(): {
  readonly session: Session;
  readonly tool: Tool;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly codeMode: ReturnType<typeof capturingCodeModeService>;
} {
  const execute = vi.fn(async () => ({ content: "looked up" }));
  const tool = lookupTool(execute);
  const codeMode = capturingCodeModeService();
  let registry: ToolRegistry | undefined;
  const session = deepSeekSkillTurnSession({
    managedPolicy: true,
    codeModeService: codeMode.service,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
      dispatchCodeModeNestedTool: (
        call: Parameters<NonNullable<ToolRegistry["dispatchCodeModeNestedTool"]>>[0],
      ) => registry!.dispatchCodeModeNestedTool!(call),
    },
  });
  registry = buildToolRegistry({
    workspaceRoot: "/tmp",
    getSession: () => session,
    extraTools: [tool],
  });
  return { session, tool, execute, codeMode };
}

async function skillTurn(session: Session): Promise<TurnContext> {
  const admitted = await admitSkillInvocation(
    session,
    session.services.configStore!,
    { name: "lookup-skill", allowedTools: ["custom.lookup", "exec_command"] },
  );
  return session.newSkillInvocationTurn(admitted.overrides);
}

describe("skill turn grants on every dispatch path", () => {
  test("the same grant allows the call through tool dispatch and code-mode nested dispatch", async () => {
    const { session, tool, execute, codeMode } = lookupSession();
    const turn = await skillTurn(session);
    const signal = new AbortController().signal;
    const nested = { cellId: "1", runtimeToolCallId: "n1", toolName: "custom.lookup", input: {} };

    const dispatch = buildLiveToolDispatchOptions(turn, session);
    expect(
      (await hasPermissionsToUseTool(tool, {}, dispatch.permissionContext!)).behavior,
    ).toBe("allow");
    startCodeModeTurnWorker(session, turn);
    await expect(codeMode.host().invokeTool(nested, signal)).resolves.toBe("looked up");
    expect(execute).toHaveBeenCalledOnce();

    // Another turn of the session, code-mode included, asks as before.
    const plain = session.newDefaultTurn();
    expect(
      (await hasPermissionsToUseTool(
        tool,
        {},
        buildLiveToolDispatchOptions(plain, session).permissionContext!,
      )).behavior,
    ).toBe("ask");
    startCodeModeTurnWorker(session, plain);
    await expect(codeMode.host().invokeTool(nested, signal)).rejects.toThrow(
      "custom.lookup needs approval",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  test("a managed-only policy reload during the skill turn revokes its grants from the next tool call", async () => {
    const { session, tool } = lookupSession();
    const turn = await skillTurn(session);
    // One dispatch context serves the whole turn.
    const dispatch = buildLiveToolDispatchOptions(turn, session);
    const snapshot = () =>
      dispatch.permissionContext!.getAppState().toolPermissionContext;
    expect(snapshot().alwaysAllowRules.command).toEqual([
      "custom.lookup",
      "exec_command",
      "Skill(lookup-skill)",
    ]);
    expect(
      (await hasPermissionsToUseTool(tool, {}, dispatch.permissionContext!)).behavior,
    ).toBe("allow");

    await reloadManagedPolicy(session, ["allowManagedPermissionRulesOnly = true"]);

    expect(snapshot().alwaysAllowRules.command).toBeUndefined();
    expect(
      (await hasPermissionsToUseTool(tool, {}, dispatch.permissionContext!)).behavior,
    ).toBe("ask");
    // The registry itself never held the grants.
    expect(
      session.permissionModeRegistry.current().alwaysAllowRules.command,
    ).toBeUndefined();
  });

  test("the same reload revokes them from code-mode nested calls of the turn", async () => {
    const { session, execute, codeMode } = lookupSession();
    const turn = await skillTurn(session);
    const signal = new AbortController().signal;
    const nested = { cellId: "1", runtimeToolCallId: "n2", toolName: "custom.lookup", input: {} };
    // One code-mode worker serves the whole turn.
    startCodeModeTurnWorker(session, turn);
    await expect(codeMode.host().invokeTool(nested, signal)).resolves.toBe("looked up");

    await reloadManagedPolicy(session, ["allowManagedPermissionRulesOnly = true"]);

    await expect(codeMode.host().invokeTool(nested, signal)).rejects.toThrow(
      "custom.lookup needs approval",
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});
