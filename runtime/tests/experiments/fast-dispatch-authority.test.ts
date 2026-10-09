import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as plans from "../../src/planning/session-plan-authority.js";
import { setPlanSlug, clearAllPlanSlugs } from "../../src/planning/plan-files.js";
import { sessionDispatchAuthority } from "../../src/tools/session-dispatch-authority.js";
import { SESSION_PLAN_FILE_ARG, SESSION_PLAN_FILE_SIG_ARG, verifySessionPlanFileArgs } from "../../src/agents/_deps/filesystem-args.js";
import { verifySessionId, SESSION_ID_SIG_ARG } from "../../src/tools/system/filesystem.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { runMinimalTurn } from "../../src/session/minimal-turn.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

afterEach(() => { vi.restoreAllMocks(); clearAllPlanSlugs(); });

test("deferred authority authenticates the session without resolving an unused plan", () => {
  const resolve = vi.spyOn(plans, "sessionPlanFileAuthority");
  const args = sessionDispatchAuthority({ conversationId: "owner" }, "/tmp", true);
  expect(verifySessionId(args.__agencSessionId, args[SESSION_ID_SIG_ARG])).toBe("owner");
  expect(Object.keys(args)).toContain(SESSION_PLAN_FILE_ARG);
  expect(resolve).not.toHaveBeenCalled();
  expect(verifySessionPlanFileArgs(args)).toBeNull();
  expect(args[SESSION_PLAN_FILE_SIG_ARG]).toBeNull();
  expect(resolve).toHaveBeenCalledOnce();
});

test("each dispatch sees newly created plans and retains signed tamper rejection", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-plan-authority-"));
  try {
    const session = { conversationId: "owner", services: { configStore: { homeContext: { path: root } } } };
    expect(verifySessionPlanFileArgs(sessionDispatchAuthority(session, root, true))).toBeNull();
    setPlanSlug({ agencHome: root, sessionId: "owner" }, "new-plan");
    const args = sessionDispatchAuthority(session, root, true);
    expect(verifySessionPlanFileArgs(args)).toEqual(verifySessionPlanFileArgs(sessionDispatchAuthority(session, root)));
    expect(verifySessionPlanFileArgs(args)?.planFilePath).toBe(join(root, "plans", "new-plan.md"));
    expect(verifySessionPlanFileArgs({ ...args, [SESSION_PLAN_FILE_SIG_ARG]: "00".repeat(32) })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real fast command dispatch leaves plan authority unresolved", async () => {
  const resolve = vi.spyOn(plans, "sessionPlanFileAuthority");
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker });
  const provider = mkProvider();
  let calls = 0;
  provider.chatStream = async messages => {
    calls++;
    if (calls === 1) return { content: "", toolCalls: [{ id: "command", name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf authority-ok", __agencSessionPlanFile: { forged: true } }) }],
      model: "test-model", finishReason: "tool_calls" };
    expect(String(messages.find(message => message.toolCallId === "command")?.content)).toContain("authority-ok");
    return { content: "done", toolCalls: [], model: "test-model", finishReason: "stop" };
  };
  const { session } = mkSession({ provider, registry, cwd: "/tmp" });
  const ctx = mkCtx({ cwd: "/tmp", permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } });
  const loop = runMinimalTurn(session, ctx, [{ role: "user", content: "run" }], "", new AbortController().signal);
  for (;;) {
    const next = await withOneShotFastMode(() => loop.next());
    if (next.done) { expect(next.value.reason).toBe("completed"); break; }
  }
  expect(calls).toBe(2);
  expect(resolve).not.toHaveBeenCalled();
});
