import "../helpers/cron-os-home.js";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import {
  addSessionCronTask, getSessionCronTasks, resetStateForTests,
  setCwdState, setOriginalCwd, setProjectRoot,
} from "../../src/bootstrap/state.js";
import { ToolRouter } from "../../src/tools/router.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";
import { getCronScheduler, resetCronSchedulerForTests } from "../../src/utils/cronScheduler.js";
import { startSessionCronScheduler } from "../../src/session/session-cron-scheduler.js";
import * as cronTasks from "../../src/utils/cronTasks.js";
import { getCommandQueueSnapshot, resetCommandQueueForTesting } from "../../src/utils/messageQueueManager.js";
import { attachContextDefaults, hasPermissionsToUseTool } from "../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

let root: string;
let workspace: string;
let session: Session;
let tools: Map<string, Tool>;
let router: ToolRouter;
let closeCallbacks: Array<() => Promise<void>>;
let serial = 0;
const owner = "sandbox-cron-owner";
const createInput = { cron: "* * * * *", recurring: true, durable: false, prompt: "scheduled literal /tmp/example" };

function installTools(currentSession = session): void {
  tools = new Map(createModelFacingTools({ workspaceRoot: workspace, getSession: () => currentSession })
    .filter((tool) => tool.name.startsWith("Cron")).map((tool) => [tool.name, tool]));
  router = new ToolRouter([...tools.values()].map((tool) => ({ tool, supportsParallelToolCalls: false })));
}

async function dispatch(name: string, args: Record<string, unknown>, sandboxMode: "workspace_write" | "read_only" = "workspace_write") {
  const id = `sandbox-cron-${++serial}`;
  return router.dispatchModelToolCall({ id, name, arguments: JSON.stringify(args) }, {
    session,
    turn: {
      subId: id, cwd: workspace,
      approvalPolicy: { value: "never" }, sandboxPolicy: { value: sandboxMode },
    } as never,
    tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} } as never,
    approvalPolicy: "never", sandboxMode,
  });
}

beforeEach(() => {
  closeCallbacks = [];
  root = mkdtempSync(join(tmpdir(), "agenc-cron-sandbox-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  setProjectRoot(workspace);
  setOriginalCwd(workspace);
  setCwdState(workspace);
  resetCommandQueueForTesting();
  session = {
    conversationId: owner,
    eventLog: new EventLog(),
    services: { admissionRequired: false, runtimeOptions: { sessionTempRoot: join(root, "temp") } },
  } as unknown as Session;
  installTools();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const close of closeCallbacks) await close();
  await resetCronSchedulerForTests();
  vi.restoreAllMocks();
  resetStateForTests();
  resetCommandQueueForTesting();
  rmSync(root, { recursive: true, force: true });
});

describe("session cron admission through the actual tool router", () => {
  it("creates, fires, and deletes a session job without a cron file or lock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const diskLookup = vi.spyOn(cronTasks, "listAllCronTasks");
    const diskRemoval = vi.spyOn(cronTasks, "removeCronTasks");
    const created = await dispatch("CronCreate", createInput);
    expect(created.isError, String(created.content)).toBeFalsy();
    const id = JSON.parse(String(created.content)).cron.id;
    expect(getSessionCronTasks()).toContainEqual(expect.objectContaining({ id, queueOwner: { kind: "session", conversationId: owner } }));
    for (let minute = 0; minute < 3; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      await getCronScheduler().drain();
    }
    expect(getCommandQueueSnapshot()).toContainEqual(expect.objectContaining({ value: createInput.prompt, queueOwner: { kind: "session", conversationId: owner } }));
    const deleted = await dispatch("CronDelete", { id });
    expect(deleted.isError).toBeFalsy();
    expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id });
    expect(getSessionCronTasks()).toEqual([]);
    expect(diskLookup).not.toHaveBeenCalled();
    expect(diskRemoval).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, ".agenc"))).toBe(false);
  });

  it("uses the real session-owned runner and accepts a one-shot without durable I/O", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const diskLookup = vi.spyOn(cronTasks, "listAllCronTasks");
    const diskMutation = vi.spyOn(cronTasks, "mutateCronFile");
    const diskRemoval = vi.spyOn(cronTasks, "removeCronTasks");
    const submit = vi.fn(async (_prompt: string, options: { onAccepted: () => Promise<void> }) => {
      await options.onAccepted();
    });
    session = {
      ...session,
      abortController: new AbortController(),
      services: { ...session.services, mcpStartupCancellationToken: { signal: new AbortController().signal } },
      submit,
      onBeforeDurableClose: (close: () => Promise<void>) => { closeCallbacks.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
    } as unknown as Session;
    installTools();
    const created = await dispatch("CronCreate", { ...createInput, recurring: false });
    expect(created.isError).toBeFalsy();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(submit).toHaveBeenCalledExactlyOnceWith(createInput.prompt, expect.objectContaining({ onAccepted: expect.any(Function) }));
    expect(getSessionCronTasks()).toEqual([]);
    expect(diskLookup).not.toHaveBeenCalled();
    expect(diskMutation).not.toHaveBeenCalled();
    expect(diskRemoval).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, ".agenc"))).toBe(false);
  });

  it.skipIf(process.platform === "darwin")("cancels a queued durable claim before file I/O when narrowed, keeping memory work runnable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const accept = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const accepted: string[] = [];
    const submit = vi.fn(async (prompt: string, options: { onAccepted: () => Promise<void> }) => {
      entered.resolve();
      await accept.promise;
      await options.onAccepted();
      accepted.push(prompt);
    });
    session = {
      ...session,
      abortController: new AbortController(),
      services: { ...session.services, mcpStartupCancellationToken: { signal: new AbortController().signal } },
      submit,
      onBeforeDurableClose: (close: () => Promise<void>) => { closeCallbacks.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
    } as unknown as Session;
    installTools();
    // Existing direct/bootstrap durable authority is unchanged by this fix.
    const durable = await tools.get("CronCreate")!.execute({ ...createInput, prompt: "old durable", durable: true, recurring: false });
    expect(durable.isError).toBeFalsy();
    const scheduler = await startSessionCronScheduler(session, workspace);
    const durablePath = join(workspace, ".agenc", "scheduled_tasks.json");
    const before = readFileSync(durablePath, "utf8");
    await vi.advanceTimersByTimeAsync(60_000);
    // The durable load uses real filesystem I/O; virtual time alone does not
    // prove that the turn reached its acceptance boundary.
    await entered.promise;
    expect(submit).toHaveBeenCalledOnce();
    const diskLookup = vi.spyOn(cronTasks, "listAllCronTasks");
    const diskMutation = vi.spyOn(cronTasks, "mutateCronFile");
    try {
      const memory = await dispatch("CronCreate", { ...createInput, recurring: false });
      expect(memory.isError).toBeFalsy();
      accept.resolve();
      await scheduler.drain();
      expect(accepted).toEqual([]);
      expect(diskMutation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await scheduler.drain();
      expect(accepted).toEqual([createInput.prompt]);
      expect(getSessionCronTasks()).toEqual([]);
      expect(diskLookup).not.toHaveBeenCalled();
      expect(diskMutation).not.toHaveBeenCalled();
      expect(readFileSync(durablePath, "utf8")).toBe(before);
    } finally {
      accept.resolve();
    }
  });

  it.each(["directory-symlink", "file-symlink", "file-hardlink"])("never follows a durable %s for missing, foreign, or colliding ids", async (kind) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const durablePath = join(outside, "scheduled_tasks.json");
    const original = JSON.stringify({ tasks: [{ id: "same-id", cron: "* * * * *", prompt: "must not arm", createdAt: 0, recurring: true }] });
    writeFileSync(durablePath, original, { mode: 0o600 });
    if (kind === "directory-symlink") symlinkSync(outside, join(workspace, ".agenc"), "dir");
    else {
      mkdirSync(join(workspace, ".agenc"));
      if (kind === "file-symlink") symlinkSync(durablePath, join(workspace, ".agenc", "scheduled_tasks.json"));
      else linkSync(durablePath, join(workspace, ".agenc", "scheduled_tasks.json"));
    }
    const diskLookup = vi.spyOn(cronTasks, "listAllCronTasks");
    const diskRemoval = vi.spyOn(cronTasks, "removeCronTasks");
    addSessionCronTask({ id: "foreign-id", cron: "* * * * *", prompt: "foreign", createdAt: Date.now(), queueOwner: { kind: "session", conversationId: "foreign-owner" } });
    addSessionCronTask({ id: "same-id", cron: "* * * * *", prompt: "own", createdAt: Date.now(), queueOwner: { kind: "session", conversationId: owner } });
    for (const id of ["missing-id", "foreign-id", "same-id", "same-id"]) {
      const result = await dispatch("CronDelete", { id });
      expect(result.isError).toBeFalsy();
    }
    expect(getSessionCronTasks().map((task) => task.id)).toEqual(["foreign-id"]);
    expect(readFileSync(durablePath, "utf8")).toBe(original);
    expect(readdirSync(outside)).toEqual(["scheduled_tasks.json"]);
    expect(diskLookup).not.toHaveBeenCalled();
    expect(diskRemoval).not.toHaveBeenCalled();
    const created = await dispatch("CronCreate", createInput);
    expect(created.isError).toBeFalsy();
    expect(diskLookup).not.toHaveBeenCalled();
    expect(readFileSync(durablePath, "utf8")).toBe(original);
  });

  it.each([
    { durable: true },
    { webhook: "https://example.invalid/hook" },
    { announceChannel: "stdio", announceTo: "recipient" },
  ])("keeps durable/delivery creation denied: %j", async (fields) => {
    const result = await dispatch("CronCreate", { ...createInput, ...fields });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("could not verify write targets");
    expect(getSessionCronTasks()).toEqual([]);
    expect(existsSync(join(workspace, ".agenc"))).toBe(false);
  });

  it.each(["CronCreate", "CronDelete"])("preserves read-only and plan/approval gates for %s", async (name) => {
    const args = name === "CronCreate" ? createInput : { id: "missing" };
    const result = await dispatch(name, args, "read_only");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read_only");
    const tool = tools.get(name)!;
    for (const mode of ["plan", "default"] as const) {
      const context = attachContextDefaults({
        getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext({ mode }) }),
      });
      const permission = await hasPermissionsToUseTool(tool, args, context);
      expect(permission.behavior).toBe(mode === "plan" ? "deny" : "ask");
    }
    expect(getSessionCronTasks()).toEqual([]);
  });

  it("does not grant a lookalike tool authority by its name or metadata", async () => {
    const execute = vi.fn(async () => ({ content: "unexpected" }));
    const lookalike = { ...tools.get("CronCreate")!, execute };
    router = new ToolRouter([{ tool: lookalike, supportsParallelToolCalls: false }]);
    const result = await dispatch("CronCreate", createInput);
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not admit a registered tool bound to another conversation", async () => {
    installTools({ ...session, conversationId: "another-session" } as Session);
    const result = await dispatch("CronCreate", createInput);
    expect(result.isError).toBe(true);
    expect(getSessionCronTasks()).toEqual([]);
  });
});
