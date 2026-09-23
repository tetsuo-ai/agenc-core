import "./helpers/cron-os-home.js";
import { setTimeout as realSleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CronDeliveryOutboxStore } from "../src/gateway/cron-outbox.js";
import { addSessionCronTask, getSessionCronTasks, resetStateForTests, setScheduledTasksEnabled } from "../src/bootstrap/state.js";
import { EventLog, type Event } from "../src/session/event-log.js";
import { startSessionCronScheduler } from "../src/session/session-cron-scheduler.js";
import * as sessionCronScheduler from "../src/session/session-cron-scheduler.js";
import { resetCronSchedulerForTests } from "../src/utils/cronScheduler.js";
import type { Session } from "../src/session/session.js";
import { cronLockAuthorityRoot } from "../src/sandbox/cron-authority-protection.js";
import { acquireCronStorageLock, withCronStorage } from "../src/utils/cron-storage.js";
import { appendCronTask, cronRestoreFailureNeedsWarning, getCronFilePath, readCronFile, readCronTasks, writeCronTasks, type CronFile, type CronTask } from "../src/utils/cronTasks.js";
import * as cronTasks from "../src/utils/cronTasks.js";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  beforeMkdir: undefined as ((path: string) => void) | undefined,
  descriptorUnavailable: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    realpath: (...args: Parameters<typeof original.realpath>) => {
      if (hooks.descriptorUnavailable && /^\/(?:proc\/self\/fd|dev\/fd)\//.test(String(args[0]))) {
        return Promise.reject(Object.assign(new Error("No traversable descriptor alias"), { code: "ENOENT" }));
      }
      return original.realpath(...args);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      hooks.beforeRename?.(String(args[0]), String(args[1]));
      return original.rename(...args);
    },
    mkdir: (...args: Parameters<typeof original.mkdir>) => {
      hooks.beforeMkdir?.(String(args[0]));
      return original.mkdir(...args);
    },
  };
});

let root: string;
let workspace: string;
let outside: string;
const task = (id: string): CronTask => ({ id, cron: "* * * * *", prompt: "synthetic durable work", createdAt: 1_000, recurring: true });
/**
 * Durable cron storage does real file I/O while these tests fake the clock.
 * Advance fake time in steps and let that I/O finish between them, so the
 * fake clock never runs an hour ahead of a claim that is still reading.
 */
async function advanceAlongsideRealIo(ms: number, drain?: () => Promise<void>): Promise<void> {
  const step = 10_000;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    if (drain !== undefined) await drain();
    // node:timers/promises is not faked: a real pause lets file I/O settle.
    await realSleep(5);
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-cron-storage-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
});
afterEach(async () => {
  hooks.beforeRename = undefined;
  hooks.beforeMkdir = undefined;
  hooks.descriptorUnavailable = false;
  vi.unstubAllEnvs();
  await resetCronSchedulerForTests();
  resetStateForTests();
  await rm(root, { recursive: true, force: true });
});

describe("session cron scheduler durable claim recovery", () => {
  test("a second session scan cannot delay a rejected durable claim past its backoff", async () => {
    const start = Date.parse("2026-07-07T12:00:30Z");
    const due: CronTask = {
      ...task("recovering-one-shot"), cron: "1 12 * * *", createdAt: start,
      recurring: false,
    };
    let stored = true;
    const claimStarted = Promise.withResolvers<void>();
    const rejectClaim = Promise.withResolvers<void>();
    let claims = 0;
    const list = vi.spyOn(cronTasks, "listAllCronTasks")
      .mockImplementation(async () => stored ? [due] : []);
    const mutate = vi.spyOn(cronTasks, "mutateCronFile")
      .mockImplementation(async <Result>(_dir: string | undefined, change: (state: CronFile) => Result): Promise<Result> => {
        claims += 1;
        if (claims === 1) {
          claimStarted.resolve();
          await rejectClaim.promise;
        }
        const state: CronFile = { tasks: stored ? [due] : [] };
        const result = change(state);
        stored = state.tasks.length > 0;
        return result;
      });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(start);
    const closes: Array<() => Promise<void>> = [];
    const makeSession = (id: string, submit: Session["submit"]): Session => {
      const abortController = new AbortController();
      return {
        conversationId: id, abortController, eventLog: new EventLog(),
        services: { mcpStartupCancellationToken: { signal: abortController.signal } },
        nextInternalSubId: () => `${id}-warning`,
        onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
        onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
        submit,
      } as unknown as Session;
    };
    const attempts: number[] = [];
    const firstSubmit = vi.fn(async (_prompt: string, options: { onAccepted: () => Promise<void> }) => {
      attempts.push(Date.now());
      await options.onAccepted();
    });
    const secondSubmit = vi.fn();
    setScheduledTasksEnabled(true);
    try {
      const firstScheduler = await startSessionCronScheduler(makeSession("claim-first", firstSubmit as Session["submit"]), workspace);
      await vi.advanceTimersByTimeAsync(30_000);
      await claimStarted.promise;
      await startSessionCronScheduler(makeSession("claim-second", secondSubmit as Session["submit"]), workspace);
      rejectClaim.reject(Object.assign(new Error("claim failed before write"), { code: "EIO" }));
      await firstScheduler.drain();
      expect(firstSubmit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await firstScheduler.drain();
      expect(attempts).toEqual([start + 30_000, start + 150_000]);
      expect(claims).toBe(2);
      expect(stored).toBe(false);
      expect(secondSubmit).not.toHaveBeenCalled();
    } finally {
      rejectClaim.resolve();
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
      Object.defineProperty(process, "platform", platform);
      list.mockRestore();
      mutate.mockRestore();
    }
  });
});

describe("cron tools without durable storage", () => {
  test("session jobs can be created, listed, and deleted without durable I/O", async () => {
    hooks.descriptorUnavailable = true;
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "cron-session-only" }) as Session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const created = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "session work" });
    expect(created.isError).toBeFalsy();
    const id = (JSON.parse(String(created.content)) as { cron: { id: string } }).cron.id;
    expect((JSON.parse(String((await tool("CronList").execute({})).content)) as { crons: { id: string }[] }).crons)
      .toContainEqual(expect.objectContaining({ id }));
    const deleted = await tool("CronDelete").execute({ id });
    expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id });
    expect(getSessionCronTasks()).toEqual([]);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("cron pre-change failures settle as no effect and durable refusal is plain", async () => {
    hooks.descriptorUnavailable = true;
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "cron-refusals" }) as Session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    for (const args of [
      { prompt: "missing schedule" },
      { cron: "* * *", prompt: "bad schedule" },
      { cron: "* * * * *", prompt: "missing recipient", announceChannel: "stdio" },
      { cron: "* * * * *", prompt: "bad webhook", webhook: "ftp://example.test/hook" },
    ]) {
      const result = await tool("CronCreate").execute(args);
      expect(result.isError).toBe(true);
      expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    }
    const durable = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "durable work", durable: true });
    expect(durable.isError).toBe(true);
    expect(String(durable.content)).toContain("descriptor-relative reads and writes");
    expect(durable.effectDisposition?.disposition).toBe("confirmed_no_effect");
    const missing = await tool("CronDelete").execute({});
    expect(missing.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(getSessionCronTasks()).toEqual([]);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("durable storage still fails closed before a write", async () => {
    hooks.descriptorUnavailable = true;
    await expect(appendCronTask(task("new"), workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(await readdir(workspace)).toEqual([]);
  });

  test.skipIf(process.platform === "darwin")("a post-mkdir descriptor refusal does not claim zero effects", async () => {
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const create = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "post-mkdir-refusal" }) as Session,
    }).find((candidate) => candidate.name === "CronCreate")!;
    hooks.beforeMkdir = (path) => {
      if (path.endsWith("/.agenc")) hooks.descriptorUnavailable = true;
    };
    let failure: unknown;
    try {
      await create.execute({ cron: "* * * * *", prompt: "durable work", durable: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(["DESCRIPTOR_UNSUPPORTED", "ENOENT"])
      .toContain((failure as NodeJS.ErrnoException).code);
    expect(failure).not.toHaveProperty("effectDisposition");
    expect(await readdir(workspace)).toEqual([".agenc"]);
  });

  test("a due durable record never stops a Darwin session scheduler", async () => {
    if (process.platform === "darwin") {
      await mkdir(join(workspace, ".agenc"), { mode: 0o700 });
      await writeFile(getCronFilePath(workspace), JSON.stringify({ tasks: [task("durable-due")] }), { mode: 0o600 });
    } else {
      await writeCronTasks([task("durable-due")], workspace);
    }
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const events: Event[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe((event) => events.push(event));
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const submit = vi.fn(async (prompt: string, options: { onAccepted: () => Promise<void> }) => {
      if (prompt === "synthetic durable work") hooks.descriptorUnavailable = true;
      await options.onAccepted();
    });
    const session = {
      conversationId: "darwin-session-fire", abortController, eventLog,
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      nextInternalSubId: () => "darwin-session-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    addSessionCronTask({ ...task("session-due"), prompt: "session work", durable: false,
      queueOwner: { kind: "session", conversationId: session.conversationId } });
    setScheduledTasksEnabled(true);
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      const scheduler = await startSessionCronScheduler(session, workspace);
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.drain();
      expect(submit).toHaveBeenCalledWith("session work", expect.objectContaining({ onAccepted: expect.any(Function) }));
      expect(submit).not.toHaveBeenCalledWith("synthetic durable work", expect.anything());
      expect(scheduler.getLastTelemetry()?.nextWakeInMs).not.toBeNull();
      expect(events.some((event) => event.msg.type === "warning" && event.msg.payload.cause === "scheduled_turn_failed")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
      setScheduledTasksEnabled(false);
    }
  });

  test.skipIf(process.platform !== "linux")("failed minute durable writes do not consume an hourly session job's budget", async () => {
    const start = Date.parse("2026-07-07T12:00:30Z");
    await writeCronTasks([{ ...task("durable-due"), createdAt: start }], workspace);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(start);
    const events: Event[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe((event) => events.push(event));
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const submit = vi.fn(async (prompt: string, options: { onAccepted: () => Promise<void> }) => {
      await options.onAccepted();
    });
    const session = {
      conversationId: "linux-durable-failure", abortController, eventLog,
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      nextInternalSubId: () => "linux-durable-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    addSessionCronTask({ ...task("session-due"), cron: "0 * * * *", createdAt: start,
      prompt: "session work", durable: false,
      queueOwner: { kind: "session", conversationId: session.conversationId } });
    hooks.beforeRename = (_from, to) => {
      if (to.endsWith("/scheduled_tasks.json")) {
        throw Object.assign(new Error("durable write failed"), { code: "EIO" });
      }
    };
    setScheduledTasksEnabled(true);
    try {
      const scheduler = await startSessionCronScheduler(session, workspace);
      await advanceAlongsideRealIo(60_000, () => scheduler.drain());
      await scheduler.drain();
      expect(submit.mock.calls.map(([prompt]) => prompt)).toEqual(["synthetic durable work"]);
      expect(events.some((event) => event.msg.type === "warning" && event.msg.payload.cause === "scheduled_turn_failed")).toBe(true);
      expect(scheduler.getLastTelemetry()?.nextWakeInMs).not.toBeNull();
      await advanceAlongsideRealIo(59 * 60_000, () => scheduler.drain());
      await scheduler.drain();
      expect(submit.mock.calls.filter(([prompt]) => prompt === "synthetic durable work").length).toBeLessThan(20);
      expect(submit.mock.calls.filter(([prompt]) => prompt === "session work")).toHaveLength(1);
      expect(scheduler.isPaused()).toBe(false);
      expect(scheduler.getLastTelemetry()?.nextWakeInMs).not.toBeNull();
      expect(getSessionCronTasks().map((entry) => entry.id)).toEqual(["session-due"]);
    } finally {
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
      setScheduledTasksEnabled(false);
    }
  });

  test("schedule read failures settle before CronCreate or CronDelete changes anything", async () => {
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "cron-read-error" }) as Session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const read = vi.spyOn(cronTasks, "readCronFile").mockRejectedValueOnce(new Error("schedule read failed"));
    const list = vi.spyOn(cronTasks, "listAllCronTasks").mockRejectedValueOnce(new Error("schedule read failed"));
    try {
      const create = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "durable work", durable: true });
      expect(create.isError).toBe(true);
      expect(String(create.content)).toContain("schedule read failed");
      expect(create.effectDisposition?.disposition).toBe("confirmed_no_effect");
      const remove = await tool("CronDelete").execute({ id: "missing" });
      expect(remove.isError).toBe(true);
      expect(String(remove.content)).toContain("schedule read failed");
      expect(remove.effectDisposition?.disposition).toBe("confirmed_no_effect");
      expect(getSessionCronTasks()).toEqual([]);
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      read.mockRestore();
      list.mockRestore();
    }
  });

  test("a known session job can be deleted when durable storage cannot be read", async () => {
    const session = { conversationId: "delete-known-session-job", submit: vi.fn() } as unknown as Session;
    const start = vi.spyOn(sessionCronScheduler, "startSessionCronScheduler")
      .mockResolvedValue({} as Awaited<ReturnType<typeof startSessionCronScheduler>>);
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const created = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "session job" });
    const id = (JSON.parse(String(created.content)) as { cron: { id: string } }).cron.id;
    const failure = vi.spyOn(cronTasks, "listAllCronTasks")
      .mockRejectedValueOnce(Object.assign(new Error("storage unavailable"), { code: "EIO" }));
    try {
      const deleted = await tool("CronDelete").execute({ id });
      expect(deleted.isError).toBeFalsy();
      expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id });
      expect(getSessionCronTasks()).toEqual([]);
      expect(start).toHaveBeenLastCalledWith(session, workspace, {});
    } finally {
      failure.mockRestore();
      start.mockRestore();
    }
  });

  test.skipIf(process.platform !== "linux")("deleting a session job after one EIO keeps durable scheduling active", async () => {
    const start = Date.parse("2026-07-07T12:00:30Z");
    await writeCronTasks([{
      ...task("durable-after-delete"),
      cron: "0 * * * *",
      prompt: "durable after delete",
      createdAt: start,
    }], workspace);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(start);
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const submit = vi.fn(async (_prompt: string, options: { onAccepted: () => Promise<void> }) => {
      await options.onAccepted();
    });
    const session = {
      conversationId: "delete-keeps-durable", abortController, eventLog: new EventLog(),
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      nextInternalSubId: () => "delete-keeps-durable-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace, getSession: () => session });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    try {
      const created = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "session to delete" });
      const id = (JSON.parse(String(created.content)) as { cron: { id: string } }).cron.id;
      const failure = vi.spyOn(cronTasks, "listAllCronTasks")
        .mockRejectedValueOnce(Object.assign(new Error("storage unavailable"), { code: "EIO" }));
      try {
        const deleted = await tool("CronDelete").execute({ id });
        expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id });
      } finally {
        failure.mockRestore();
      }
      await advanceAlongsideRealIo(61 * 60_000);
      // vi.waitFor polls on real timers, so the last claim's file I/O can finish.
      await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("durable after delete", expect.objectContaining({ onAccepted: expect.any(Function) })));
    } finally {
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
    }
  });

  test.skipIf(process.platform === "darwin")("an unavailable durable record leaves session listing and creation usable", async () => {
    const metadata = join(workspace, ".agenc");
    await mkdir(metadata, { mode: 0o700 });
    const file = getCronFilePath(workspace);
    const body = JSON.stringify({ tasks: [task("prior-durable")] });
    await writeFile(file, body, { mode: 0o600 });
    hooks.descriptorUnavailable = true;
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "cron-prior-durable" }) as Session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const listed = await tool("CronList").execute({});
    const deleted = await tool("CronDelete").execute({ id: "prior-durable" });
    const created = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "session job" });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(String(listed.content))).toMatchObject({ crons: [], warning: expect.stringContaining("descriptor-relative reads and writes") });
    expect(deleted.isError).toBe(true);
    expect(String(deleted.content)).toContain("Use durable:false");
    expect(deleted.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(created.isError).toBeFalsy();
    expect(getSessionCronTasks()).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(body);
  });
});

describe.runIf(process.platform === "darwin")("darwin cron tools", () => {
  test("creates, lists, and deletes a session job while refusing durable record reads", async () => {
    const metadata = join(workspace, ".agenc");
    await mkdir(metadata, { mode: 0o700 });
    await writeFile(getCronFilePath(workspace), JSON.stringify({ tasks: [task("prior-durable")] }), { mode: 0o600 });
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const tools = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "darwin-durable" }) as Session,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const created = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "session work" });
    expect(created.isError).toBeFalsy();
    const id = (JSON.parse(String(created.content)) as { cron: { id: string } }).cron.id;
    await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    const listed = await tool("CronList").execute({});
    expect(listed.isError).toBeFalsy();
    const listing = JSON.parse(String(listed.content)) as { crons: { id: string }[]; warning: string };
    expect(listing.crons)
      .toContainEqual(expect.objectContaining({ id }));
    expect(listing.crons).not.toContainEqual(expect.objectContaining({ id: "prior-durable" }));
    expect(listing.warning).toContain("descriptor-relative reads and writes");
    const deleted = await tool("CronDelete").execute({ id });
    expect(deleted.isError).toBeFalsy();
    expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id });
    await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    const durableDelete = await tool("CronDelete").execute({ id: "prior-durable" });
    expect(durableDelete.isError).toBe(true);
    expect(String(durableDelete.content)).toContain("Use durable:false");
    expect(durableDelete.effectDisposition?.disposition).toBe("confirmed_no_effect");
    const durableCreate = await tool("CronCreate").execute({ cron: "* * * * *", prompt: "durable work", durable: true });
    expect(durableCreate.isError).toBe(true);
    expect(String(durableCreate.content)).toContain("Use durable:false");
    expect(durableCreate.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(await readFile(getCronFilePath(workspace), "utf8"))
      .toBe(JSON.stringify({ tasks: [task("prior-durable")] }));
  });
});

describe.skipIf(process.platform === "darwin")("descriptor-confined durable cron storage", () => {

  test.skipIf(process.platform === "darwin")("default in-memory creation still fires when durable storage is unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    await writeCronTasks([task("durable-kept")], workspace);
    const before = await readFile(getCronFilePath(workspace), "utf8");
    hooks.descriptorUnavailable = true;
    const events: Event[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe((event) => events.push(event));
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const submit = vi.fn(async (_prompt: string, options: { onAccepted: () => Promise<void> }) => { await options.onAccepted(); });
    const session = {
      conversationId: "memory-with-unavailable-storage", abortController, eventLog,
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      nextInternalSubId: () => "memory-storage-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    addSessionCronTask({ ...task("foreign-memory"), queueOwner: { kind: "session", conversationId: "foreign-owner" } });
    setScheduledTasksEnabled(true);
    try {
      const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
      const create = createModelFacingTools({ workspaceRoot: workspace, getSession: () => session }).find((tool) => tool.name === "CronCreate")!;
      // No workspace-write context: this is the ordinary mixed scheduler path,
      // and omitted durable uses CronCreate's documented in-memory default.
      const result = await create.execute({ cron: "* * * * *", prompt: "owned memory work", recurring: false });
      expect(result.isError).toBeFalsy();
      const scheduler = await startSessionCronScheduler(session, workspace);
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.drain();
      expect(submit).toHaveBeenCalledExactlyOnceWith("owned memory work", expect.objectContaining({ onAccepted: expect.any(Function) }));
      expect(getSessionCronTasks().map((entry) => entry.id)).toEqual(["foreign-memory"]);
      expect(events.some((event) => event.msg.type === "warning" &&
        event.msg.payload.cause === "cron_storage_unavailable" &&
        event.msg.payload.message.startsWith("Durable scheduled tasks unavailable:"))).toBe(true);
      expect(await readFile(getCronFilePath(workspace), "utf8")).toBe(before);
      await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    } finally {
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
      resetStateForTests();
    }
  });

  test.skipIf(process.platform === "darwin")("fails closed before any metadata write when directory aliases are unavailable", async () => {
    hooks.descriptorUnavailable = true;
    await expect(appendCronTask(task("new"), workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    await expect(readCronFile(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(await readdir(workspace)).toEqual([]);
  });

  test.skipIf(process.platform === "darwin")("startup restore warns only when an unrestorable durable record exists", async () => {
    hooks.descriptorUnavailable = true;
    const unsupported: unknown = await readCronTasks(workspace).catch((error: unknown) => error);
    expect(unsupported).toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(await cronRestoreFailureNeedsWarning(unsupported, workspace)).toBe(false);
    hooks.descriptorUnavailable = false;
    await writeCronTasks([task("kept")], workspace);
    hooks.descriptorUnavailable = true;
    expect(await cronRestoreFailureNeedsWarning(unsupported, workspace)).toBe(true);
    expect(await cronRestoreFailureNeedsWarning(new Error("Cron storage must be owned by the current user"), workspace)).toBe(true);
  });

  test.skipIf(process.platform === "darwin")("distinguishes missing or malformed records from storage capability failures", async () => {
    expect(await readCronTasks(workspace)).toEqual([]);
    await mkdir(join(workspace, ".agenc"), { mode: 0o700 });
    expect(await readCronTasks(workspace)).toEqual([]);
    await writeFile(getCronFilePath(workspace), "malformed", { mode: 0o600 });
    expect(await readCronTasks(workspace)).toEqual([]);
    hooks.descriptorUnavailable = true;
    await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
  });

  test.skipIf(process.platform === "darwin")("CronList reports incomplete durable storage while listing session jobs", async () => {
    await writeCronTasks([task("kept")], workspace);
    const { createModelFacingTools } = await import("../src/bin/model-facing-tools.js");
    const list = createModelFacingTools({ workspaceRoot: workspace,
      getSession: () => ({ conversationId: "cron-list-diagnostic" }) as Session,
    }).find((tool) => tool.name === "CronList")!;
    hooks.descriptorUnavailable = true;
    const result = await list.execute({});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toMatchObject({
      crons: [], warning: expect.stringContaining("descriptor-relative reads and writes"),
    });
  });

  test.skipIf(process.platform === "darwin")("reports a session warning for failed durable loading without submitting model work", async () => {
    await writeCronTasks([task("kept")], workspace);
    hooks.descriptorUnavailable = true;
    const eventLog = new EventLog();
    const events: Event[] = [];
    eventLog.subscribe((event) => events.push(event));
    const submit = vi.fn();
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const session = {
      conversationId: "cron-storage-diagnostic",
      abortController,
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      eventLog,
      nextInternalSubId: () => "cron-storage-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    setScheduledTasksEnabled(true);
    try {
      const scheduler = await startSessionCronScheduler(session, workspace);
      expect(events).toContainEqual(expect.objectContaining({ msg: {
        type: "warning", payload: {
          cause: "cron_storage_unavailable",
          message: expect.stringContaining("No traversable directory descriptor"),
        },
      } }));
      expect(scheduler.getLastTelemetry()?.nextWakeInMs).toBeNull();
      expect(submit).not.toHaveBeenCalled();
      hooks.descriptorUnavailable = false;
      expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
    } finally {
      await Promise.all(closes.map((close) => close()));
      setScheduledTasksEnabled(false);
    }
  });

  test("refuses redirected metadata before writes, reads, and delivery claims", async () => {
    const target = join(outside, "scheduled_tasks.json");
    const before = JSON.stringify({ tasks: [task("outside")] });
    await writeFile(target, before, { mode: 0o600 });
    await symlink(outside, join(workspace, ".agenc"), "dir");
    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/root must be a real directory/);
    await expect(readCronFile(workspace)).rejects.toThrow(/root must be a real directory/);
    await expect(readCronTasks(workspace)).rejects.toThrow();
    const operation = vi.fn();
    await expect(new CronDeliveryOutboxStore(workspace).withClaim("outside", () => 90_000, operation)).rejects.toThrow(/root must be a real directory/);
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(before);
    expect(await readdir(outside)).toEqual(["scheduled_tasks.json"]);
  });

  test.each(["symlink", "hardlink"])("refuses a %s task file without reading or changing its target", async (kind) => {
    await mkdir(join(workspace, ".agenc"), { mode: 0o755 });
    const target = join(outside, "private.json");
    const before = JSON.stringify({ tasks: [task("outside")] });
    await writeFile(target, before, { mode: 0o644 });
    if (kind === "symlink") await symlink(target, getCronFilePath(workspace));
    else await link(target, getCronFilePath(workspace));
    await expect(readCronTasks(workspace)).rejects.toThrow();
    await expect(readCronFile(workspace)).rejects.toThrow(/regular file/);
    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/regular file/);
    expect(await readFile(target, "utf8")).toBe(before);
  });

  test("accepts existing owner-controlled 755 metadata and 644 records", async () => {
    await mkdir(join(workspace, ".agenc"), { mode: 0o755 });
    await writeFile(getCronFilePath(workspace), JSON.stringify({ tasks: [task("kept")] }), { mode: 0o644 });
    await appendCronTask(task("added"), workspace);
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept", "added"]);
  });

  test("a metadata swap after validation cannot redirect publication or temporary cleanup", async () => {
    await writeCronTasks([task("kept")], workspace);
    const target = join(outside, "scheduled_tasks.json");
    await writeFile(target, "outside marker", { mode: 0o600 });
    let exchanged = false;
    hooks.beforeRename = () => {
      hooks.beforeRename = undefined;
      renameSync(join(workspace, ".agenc"), join(workspace, ".agenc-held"));
      symlinkSync(outside, join(workspace, ".agenc"), "dir");
      exchanged = true;
    };
    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/root changed during I\/O/);
    expect(exchanged).toBe(true);
    expect(await readFile(target, "utf8")).toBe("outside marker");
    expect(await readdir(outside)).toEqual(["scheduled_tasks.json"]);
    expect((await readdir(join(workspace, ".agenc-held"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a workspace swap cannot redirect creation of the metadata directory", async () => {
    let exchanged = false;
    hooks.beforeMkdir = (path) => {
      if (!path.startsWith("/proc/self/fd/") || !path.endsWith("/.agenc")) return;
      hooks.beforeMkdir = undefined;
      renameSync(workspace, join(root, "workspace-held"));
      symlinkSync(outside, workspace, "dir");
      exchanged = true;
    };
    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/root changed during I\/O/);
    expect(exchanged).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  test("does not acknowledge a linked temporary-file substitution as a successful publication", async () => {
    await writeCronTasks([task("kept")], workspace);
    const target = join(outside, "private.json");
    await writeFile(target, "outside marker", { mode: 0o600 });
    hooks.beforeRename = (from) => {
      hooks.beforeRename = undefined;
      unlinkSync(from);
      symlinkSync(target, from);
    };
    await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/publication file was replaced or linked/);
    expect(await readFile(target, "utf8")).toBe("outside marker");
    await expect(readCronTasks(workspace)).rejects.toThrow();
  });

  test("refuses an alias retarget between execution-stripe acquisition and claim admission", async () => {
    const delivery = { ...task("delivery"), deliver: { channel: "synthetic", to: "owned" } };
    await writeCronTasks([delivery], workspace);
    await writeCronTasks([delivery], outside);
    const before = await readFile(getCronFilePath(outside), "utf8");
    const alias = join(root, "alias");
    await symlink(workspace, alias, "dir");
    const operation = vi.fn();
    await expect(new CronDeliveryOutboxStore(alias).withClaim("delivery", () => {
      unlinkSync(alias);
      symlinkSync(outside, alias, "dir");
      return 90_000;
    }, operation)).rejects.toThrow(/workspace identity changed/);
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(getCronFilePath(outside), "utf8")).toBe(before);
    expect((await readCronFile(workspace)).deliveryOutbox).toBeUndefined();
  });

  test("binds later claim updates and lease cleanup to the stripe owner's workspace identity", async () => {
    const delivery = { ...task("delivery"), deliver: { channel: "synthetic", to: "owned" } };
    await writeCronTasks([delivery], workspace);
    await writeCronTasks([delivery], outside);
    const alias = join(root, "alias");
    await symlink(workspace, alias, "dir");
    const store = new CronDeliveryOutboxStore(alias);
    let before: string | undefined;
    await expect(store.withClaim("delivery", () => 90_000, async (claim) => {
      // Copying the token demonstrates identity protection independently of
      // the existing lease-token guard: the redirected state is otherwise valid.
      before = await readFile(getCronFilePath(workspace), "utf8");
      await writeFile(getCronFilePath(outside), before, { mode: 0o600 });
      unlinkSync(alias);
      symlinkSync(outside, alias, "dir");
      await expect(store.beginAttempt(claim, "model", 90_000)).rejects.toThrow(/workspace identity changed/);
    })).rejects.toThrow(/workspace identity changed/);
    expect(before).toBeDefined();
    expect(await readFile(getCronFilePath(outside), "utf8")).toBe(before);
  });

  test("shares one lock across workspace aliases and independently configured homes", async () => {
    const alias = join(root, "alias");
    await symlink(workspace, alias, "dir");
    await writeCronTasks([task("first")], workspace);
    let firstLock: string | undefined;
    await withCronStorage(workspace, false, async (storage) => {
      firstLock = storage.lockDirectory;
      const release = await acquireCronStorageLock(storage, "tasks", { timeoutMs: 1_000 });
      try {
        vi.stubEnv("HOME", outside);
        vi.stubEnv("AGENC_HOME", join(outside, "another-home"));
        await withCronStorage(alias, false, async (other) => {
          expect(other.lockDirectory).toBe(firstLock);
          await expect(acquireCronStorageLock(other, "tasks", { timeoutMs: 25 })).rejects.toThrow(/timed out/);
        });
      } finally { release(); }
    });
    await appendCronTask(task("second"), alias);
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(firstLock!.startsWith(`${cronLockAuthorityRoot()}/`)).toBe(true);
  });

  test("uses the same trusted namespace for the task transaction and every outbox stripe", async () => {
    await writeCronTasks([], workspace);
    const ids = new Map<number, string>();
    for (let ordinal = 0; ids.size < 16; ordinal++) {
      const id = `stripe-${ordinal}`;
      ids.set(createHash("sha256").update(id).digest()[0]! % 16, id);
    }
    const store = new CronDeliveryOutboxStore(workspace);
    for (const id of ids.values()) await store.withClaim(id, () => 90_000, async () => { throw new Error("No task exists"); });
    await withCronStorage(workspace, false, async (storage) => {
      expect((await readdir(storage.lockDirectory)).sort()).toEqual([
        "tasks.lock.sqlite", ...Array.from({ length: 16 }, (_, stripe) => `${stripe}.lock.sqlite`),
      ].sort());
    });
    expect(await readdir(join(workspace, ".agenc"))).toEqual(["scheduled_tasks.json"]);
  });

  test.each(["symlink", "hardlink"])("refuses a %s trusted lock file", async (kind) => {
    await writeCronTasks([task("kept")], workspace);
    const before = await readFile(getCronFilePath(workspace), "utf8");
    await withCronStorage(workspace, false, async (storage) => {
      const lock = join(storage.lockDirectory, "tasks.lock.sqlite");
      const target = join(outside, "lock.sqlite");
      await writeFile(target, "outside marker", { mode: 0o600 });
      await rm(lock);
      if (kind === "symlink") await symlink(target, lock);
      else await link(target, lock);
      await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(kind === "symlink" ? /not a regular file/ : /hard-link aliases/);
      expect(await readFile(target, "utf8")).toBe("outside marker");
      await rm(lock);
    });
    expect(await readFile(getCronFilePath(workspace), "utf8")).toBe(before);
  });

  test("refuses redirected lock authority and workspace containment", async () => {
    await writeCronTasks([task("kept")], workspace);
    const authority = cronLockAuthorityRoot();
    const held = `${authority}-held`;
    renameSync(authority, held);
    symlinkSync(outside, authority, "dir");
    try {
      await expect(appendCronTask(task("new"), workspace)).rejects.toThrow(/redirected directories/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      unlinkSync(authority);
      renameSync(held, authority);
    }
    await expect(writeCronTasks([], userInfo().homedir)).rejects.toThrow(/outside the workspace/);
    await expect(writeCronTasks([], authority)).rejects.toThrow(/outside the workspace/);
  });
});
