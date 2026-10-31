/**
 * A skill turn's `allowed-tools` grants reach the turn's own tool calls, and
 * only while the current permission policy allows rules from outside managed
 * settings: a policy reload during the turn revokes them from the next
 * evaluation on. Code-mode nested calls never receive them: the code-mode
 * service is shared with child sessions and routes a cell's calls to the
 * most recent turn host, so a grant there could outlive its turn.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { hasPermissionsToUseTool } from "../../src/permissions/evaluator.js";
import { buildLiveToolDispatchOptions } from "../../src/phases/execute-tools.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import { QuickJsCodeModeService } from "../../src/tools/code-mode/service.js";
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

const services: QuickJsCodeModeService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    for (const cellId of ["1", "2", "3", "4"]) {
      await service.wait({ cellId, terminate: true }).catch(() => {});
    }
  }
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
function lookupSession(codeModeService?: CodeModeService): {
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
    codeModeService: codeModeService ?? codeMode.service,
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

/**
 * Start the code-mode worker for a turn the way run-turn does. The turn is
 * passed along on purpose: an earlier version took it to hand the turn's
 * grants to nested calls, which let them outlive the turn.
 */
function startWorkerForTurn(session: Session, turn: TurnContext) {
  const start = startCodeModeTurnWorker as (
    session: Session,
    turn?: TurnContext,
  ) => ReturnType<typeof startCodeModeTurnWorker>;
  return start(session, turn);
}

async function decision(tool: Tool, ctx: TurnContext, session: Session): Promise<string> {
  return (await hasPermissionsToUseTool(
    tool,
    {},
    buildLiveToolDispatchOptions(ctx, session).permissionContext!,
  )).behavior;
}

/** A code-mode cell that calls `custom.lookup` and reports what happened. */
async function runLookupCell(service: QuickJsCodeModeService): Promise<string> {
  const response = await service.execute({
    cellId: service.allocateCellId(),
    toolCallId: "exec-1",
    enabledTools: [{
      name: "custom.lookup",
      globalName: "custom_lookup",
      description: "Look a value up.",
      kind: "function",
      inputSchema: { type: "object" },
    }],
    source: [
      "try {",
      "  const result = await tools.custom_lookup({});",
      "  text('ALLOWED ' + JSON.stringify(result));",
      "} catch (error) {",
      "  text('REFUSED ' + String(error));",
      "}",
    ].join("\n"),
    storedValues: await service.storedValues(),
    yieldTimeMs: 5_000,
  });
  return response.contentItems
    .map((item) => (item.type === "input_text" ? item.text : ""))
    .join("\n");
}

describe("skill turn grants", () => {
  test("the grant allows the skill turn's own tool call; another turn asks", async () => {
    const { session, tool } = lookupSession();
    const turn = await skillTurn(session);
    expect(await decision(tool, turn, session)).toBe("allow");
    expect(await decision(tool, session.newDefaultTurn(), session)).toBe("ask");
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

  test("a code-mode nested call of the skill turn does not receive its grants", async () => {
    const { session, tool, execute, codeMode } = lookupSession();
    const turn = await skillTurn(session);
    expect(await decision(tool, turn, session)).toBe("allow");

    startWorkerForTurn(session, turn);
    await expect(codeMode.host().invokeTool(
      { cellId: "1", runtimeToolCallId: "n1", toolName: "custom.lookup", input: {} },
      new AbortController().signal,
    )).rejects.toThrow("custom.lookup needs approval");
    expect(execute).not.toHaveBeenCalled();
  });

  test("nor does a cell on the real code-mode service during the skill turn", async () => {
    const service = new QuickJsCodeModeService({ enabled: true });
    services.push(service);
    expect(service.enabled()).toBe(true);
    const parent = lookupSession(service);
    const turn = await skillTurn(parent.session);
    expect(await decision(parent.tool, turn, parent.session)).toBe("allow");

    const worker = startWorkerForTurn(parent.session, turn);
    const during = await runLookupCell(service);
    worker.dispose();

    expect(during).toContain("REFUSED");
    expect(during).toContain("custom.lookup needs approval");
    expect(parent.execute).not.toHaveBeenCalled();
  });

  test("nor after an overlapping parent and child worker are both disposed (the parent first)", async () => {
    const service = new QuickJsCodeModeService({ enabled: true });
    services.push(service);
    // A parent session in a skill turn and a child session share the service.
    const parent = lookupSession(service);
    const child = lookupSession(service);
    const turn = await skillTurn(parent.session);

    const parentWorker = startWorkerForTurn(parent.session, turn);
    const childWorker = startWorkerForTurn(child.session, child.session.newDefaultTurn());
    // The parent ends first; disposing the child then puts the ended parent's
    // host back as the service's host.
    parentWorker.dispose();
    childWorker.dispose();
    const after = await runLookupCell(service);

    expect(after).toContain("REFUSED");
    // Refused by the permission check, or earlier, where nested calls are
    // bound to their turn and no turn's host is attached any more.
    expect(after).toMatch(/custom\.lookup needs approval|host is not attached/);
    expect(parent.execute).not.toHaveBeenCalled();
    expect(child.execute).not.toHaveBeenCalled();
  });
});
