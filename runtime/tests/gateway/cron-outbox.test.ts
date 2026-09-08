import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startCronDelivery, type CronDeliveryHandle } from "../../src/gateway/cron-delivery.js";
import { CronDeliveryOutboxStore } from "../../src/gateway/cron-outbox.js";
import {
  MAX_CRON_DELIVERY_ATTEMPTS,
  MAX_CRON_PAYLOAD_BYTES,
  MAX_CRON_OUTBOX_ENTRIES,
  type CronDeliveryPayload,
} from "../../src/utils/cron-delivery-state.js";
import { getCronFilePath, mutateCronFile, readCronFile, removeCronTasks, writeCronTasks } from "../../src/utils/cronTasks.js";
import type { ChannelAdapter, GatewayDaemonClient, GatewayPromptResult } from "../../src/gateway/types.js";
import type { AgenCConfig } from "../../src/config/schema.js";

const CREATED_AT = Date.parse("2026-07-09T10:00:00Z");
const DUE_AT = CREATED_AT + 60_000;
let workspace: string;
const handles: CronDeliveryHandle[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agenc-cron-outbox-"));
  await writeCronTasks([{
    id: "delivery",
    cron: "* * * * *",
    prompt: "scheduled prompt",
    createdAt: CREATED_AT,
    deliver: { channel: "test", to: "ops", webhook: "https://hooks.example/result" },
  }], workspace);
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await rm(workspace, { recursive: true, force: true });
});

function result(finalMessage = "completed result"): GatewayPromptResult {
  return { stopReason: "completed", finalMessage };
}

function start(options: {
  now?: number;
  prompt?: () => Promise<GatewayPromptResult>;
  send?: ChannelAdapter["send"];
  postWebhook?: (url: string, body: unknown, key?: string) => Promise<void>;
  missingAdapter?: boolean;
}) {
  let now = options.now ?? CREATED_AT;
  let callback: (() => void | Promise<void>) | undefined;
  let scheduledAt = Infinity;
  const model = vi.fn(options.prompt ?? (async () => result()));
  const send = vi.fn(options.send ?? (async () => "message-id"));
  const postWebhook = vi.fn(options.postWebhook ?? (async () => {}));
  const session = {
    sessionId: "outbox-session",
    prompt: model,
  };
  const client: GatewayDaemonClient = {
    createSession: async () => session,
    attachSession: async () => session,
    close: async () => {},
  };
  const lines: string[] = [];
  const handle = startCronDelivery({
    agencHome: join(workspace, "home"),
    workspaceDir: workspace,
    config: {} as AgenCConfig,
    client,
    adapters: options.missingAdapter ? [] : [{
      id: "test",
      supportsEdit: false,
      start: async () => {},
      stop: async () => {},
      send,
    }],
    postWebhook,
    log: (line) => lines.push(line),
    clock: {
      now: () => new Date(now),
      setTimer: (timer, milliseconds) => {
        callback = timer;
        scheduledAt = now + milliseconds;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { callback = undefined; },
    },
  });
  handles.push(handle);
  return {
    handle,
    model,
    send,
    postWebhook,
    lines,
    get scheduledAt() { return scheduledAt; },
    setNow(at: number) { now = at; },
    async fire(at = DUE_AT) {
      await vi.waitFor(() => expect(callback).toBeDefined());
      now = at;
      const timer = callback!;
      callback = undefined;
      await timer();
    },
  };
}

describe("durable cron delivery", () => {
  test.each(["model", "errored", "channel", "webhook"] as const)("backs off after a slow %s failure finishes", async (failure) => {
    const finishedAt = DUE_AT + 120_000;
    const fail = async () => {
      runner.setNow(finishedAt);
      throw new Error("delayed failure");
    };
    const runner = start({
      ...(failure === "model" ? { prompt: fail } : {}),
      ...(failure === "errored" ? { prompt: async () => {
        runner.setNow(finishedAt);
        return { stopReason: "errored" as const, finalMessage: "partial" };
      } } : {}),
      ...(failure === "channel" ? { send: fail } : {}),
      ...(failure === "webhook" ? { postWebhook: fail } : {}),
    });
    await runner.fire();
    const phase = failure === "errored" ? "model" : failure;
    const entry = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!;
    const retryAt = entry[phase]!.nextAttemptAt!;
    expect(retryAt).toBeGreaterThanOrEqual(finishedAt + 22_500);
    expect(retryAt).toBeLessThanOrEqual(finishedAt + 37_500);
    expect(runner.scheduledAt).toBe(retryAt);
  });

  test.each(["channel", "webhook"] as const)("retries only the failed %s destination after restart", async (phase) => {
    const first = start({
      ...(phase === "channel" ? { send: async () => { throw new Error("private channel failure"); } } : {}),
      ...(phase === "webhook" ? { postWebhook: async () => { throw new Error("private webhook failure"); } } : {}),
    });
    await first.fire();
    expect(first.model).toHaveBeenCalledTimes(1);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(first.postWebhook).toHaveBeenCalledTimes(1);
    const persisted = await readCronFile(workspace);
    const entry = persisted.deliveryOutbox!.occurrences[0]!;
    expect(entry.model.status).toBe("delivered");
    expect(entry[phase]?.status).toBe("retryable");
    expect(persisted.tasks).toHaveLength(1);
    expect(await readFile(getCronFilePath(workspace), "utf8")).not.toContain("private ");
    const retryAt = entry[phase]!.nextAttemptAt!;
    await first.handle.stop();

    const restarted = start({ now: DUE_AT });
    await restarted.fire(retryAt - 1);
    expect(restarted.model).not.toHaveBeenCalled();
    expect(restarted.send).not.toHaveBeenCalled();
    expect(restarted.postWebhook).not.toHaveBeenCalled();
    await restarted.fire(retryAt);
    expect(restarted.model).not.toHaveBeenCalled();
    expect(restarted.send).toHaveBeenCalledTimes(phase === "channel" ? 1 : 0);
    expect(restarted.postWebhook).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
    if (phase === "webhook") {
      expect(restarted.postWebhook.mock.calls[0]).toEqual(first.postWebhook.mock.calls[0]);
    } else {
      expect(restarted.send.mock.calls[0]).toEqual(first.send.mock.calls[0]);
    }
    expect((await readCronFile(workspace)).tasks).toEqual([]);
  });

  test.each(["errored", "stopped"] as const)("persists retry state for a %s result without delivering text", async (stopReason) => {
    const runner = start({ prompt: async () => ({ stopReason, finalMessage: "partial" }) });
    await runner.fire();
    expect(runner.send).not.toHaveBeenCalled();
    expect(runner.postWebhook).not.toHaveBeenCalled();
    const state = await readCronFile(workspace);
    expect(state.tasks).toHaveLength(1);
    expect(state.deliveryOutbox?.occurrences[0]?.model).toMatchObject({
      status: "retryable", attempts: 1, lastError: `turn_${stopReason}`,
    });
  });

  test("records only a fixed admission error class and preserves the occurrence", async () => {
    const runner = start({ prompt: async () => {
      throw new Error("execution admission deny: budget_exceeded token=secret-value");
    } });
    await runner.fire();
    expect((await readCronFile(workspace)).deliveryOutbox?.occurrences[0]?.model.lastError).toBe("admission_pause");
    expect(await readFile(getCronFilePath(workspace), "utf8")).not.toContain("secret-value");
    expect(runner.lines.join("\n")).not.toContain("secret-value");
    expect(runner.send.mock.calls[0]?.[0].text).toContain("budget_exceeded");
    expect(runner.send.mock.calls[0]?.[0].text).not.toContain("secret-value");
    expect(runner.postWebhook).not.toHaveBeenCalled();
  });

  test.each([false, true])("does not repeat an admission notice across retries and restart, notice failed=%s", async (noticeFails) => {
    const prompt = async () => {
      throw new Error("execution admission deny: budget_exceeded");
    };
    let recordedBeforeSend = false;
    const notice = vi.fn(async () => {
      const entry = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!;
      recordedBeforeSend = entry.admissionNoticeAttemptedAt === DUE_AT;
      if (noticeFails) throw new Error("notice transport failed");
      return "notice-id";
    });
    const first = start({ prompt, send: notice });
    await first.fire();
    const firstEntry = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!;
    await first.fire(firstEntry.model.nextAttemptAt!);
    await first.handle.stop();
    const retryAt = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!.model.nextAttemptAt!;
    const restarted = start({ now: retryAt, prompt, send: notice });
    await restarted.fire(retryAt);

    expect(first.model).toHaveBeenCalledTimes(2);
    expect(restarted.model).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(recordedBeforeSend).toBe(true);
    expect(first.send.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    const state = await readCronFile(workspace);
    expect(state.tasks).toHaveLength(1);
    expect(state.deliveryOutbox!.occurrences[0]!).toMatchObject({
      admissionNoticeAttemptedAt: DUE_AT,
      model: { status: "retryable", attempts: 3 },
      channel: { status: "pending", attempts: 0 },
    });
  });

  test("uses the persisted model result when a missing adapter becomes available", async () => {
    const first = start({ missingAdapter: true });
    await first.fire();
    const state = await readCronFile(workspace);
    const channel = state.deliveryOutbox!.occurrences[0]!.channel!;
    expect(channel.lastError).toBe("missing_adapter");
    await first.handle.stop();
    const restarted = start({ now: DUE_AT });
    await restarted.fire(channel.nextAttemptAt!);
    expect(restarted.model).not.toHaveBeenCalled();
    expect(restarted.send).toHaveBeenCalledTimes(1);
    expect(restarted.postWebhook).not.toHaveBeenCalled();
    expect((await readCronFile(workspace)).tasks).toEqual([]);
  });

  test.each([
    { acknowledgments: 0, changed: false },
    { acknowledgments: 1, changed: false },
    { acknowledgments: 2, changed: false },
    { acknowledgments: 2, changed: true },
  ])("recovers persisted acknowledgments=$acknowledgments, task changed=$changed", async ({ acknowledgments, changed }) => {
    const store = new CronDeliveryOutboxStore(workspace);
    await store.withClaim("delivery", () => DUE_AT, async (claim) => {
      await store.beginAttempt(claim, "model", DUE_AT);
      const payload: CronDeliveryPayload = {
        taskId: "delivery", occurrenceId: claim.key, cron: "* * * * *",
        prompt: "scheduled prompt", finalMessage: "saved result",
        stopReason: "completed", firedAt: new Date(DUE_AT).toISOString(),
      };
      await store.persistResult(claim, payload);
      for (const phase of (["channel", "webhook"] as const).slice(0, acknowledgments)) {
        await store.beginAttempt(claim, phase, DUE_AT);
        await store.markDelivered(claim, phase);
      }
    });
    expect((await readCronFile(workspace)).tasks).toHaveLength(1);
    if (changed) {
      await mutateCronFile(workspace, (state) => {
        state.tasks[0]!.prompt = "new task contents";
      });
    }
    const runner = start({ now: DUE_AT });
    await runner.fire(DUE_AT + 1_000);
    expect(runner.model).not.toHaveBeenCalled();
    expect(runner.send).toHaveBeenCalledTimes(acknowledgments >= 1 ? 0 : 1);
    expect(runner.postWebhook).toHaveBeenCalledTimes(acknowledgments >= 2 ? 0 : 1);
    const recovered = await readCronFile(workspace);
    if (changed) {
      expect(recovered.tasks).toHaveLength(1);
      expect(recovered.deliveryOutbox?.occurrences[0]?.blockedReason).toBe("task_changed");
      expect(runner.scheduledAt).toBe(DUE_AT + 1_000 + 5 * 60_000);
    } else {
      expect(recovered.tasks).toEqual([]);
    }
  });

  test("coalesces missed recurring slots through successful completion", async () => {
    await mutateCronFile(workspace, (state) => { state.tasks[0]!.recurring = true; });
    const late = DUE_AT + 3 * 60 * 60_000;
    const runner = start({ now: late });
    await runner.fire(late);
    let state = await readCronFile(workspace);
    expect(state.tasks[0]?.lastFiredAt).toBe(late);
    expect(state.deliveryOutbox?.occurrences[0]?.dueAt).toBe(DUE_AT);
    expect(runner.model).toHaveBeenCalledTimes(1);
    await runner.fire(late + 1_000);
    expect(runner.model).toHaveBeenCalledTimes(1);
    await runner.fire(late + 60_000);
    state = await readCronFile(workspace);
    expect(runner.model).toHaveBeenCalledTimes(2);
    expect(state.tasks[0]?.lastFiredAt).toBe(late + 60_000);
  });

  test("does not deliver or recreate a task deleted while its model turn runs", async () => {
    let finish!: (value: GatewayPromptResult) => void;
    const pending = new Promise<GatewayPromptResult>((resolve) => { finish = resolve; });
    const runner = start({ prompt: () => pending });
    const firing = runner.fire();
    await vi.waitFor(() => expect(runner.model).toHaveBeenCalledTimes(1));
    await removeCronTasks(["delivery"], workspace);
    finish(result());
    await firing;
    expect(runner.send).not.toHaveBeenCalled();
    expect(runner.postWebhook).not.toHaveBeenCalled();
    expect((await readCronFile(workspace)).tasks).toEqual([]);
  });

  test("keeps oversized results as terminal failures without external delivery", async () => {
    const runner = start({ prompt: async () => result("x".repeat(MAX_CRON_PAYLOAD_BYTES)) });
    await runner.fire();
    const state = await readCronFile(workspace);
    expect(state.tasks).toHaveLength(1);
    expect(state.deliveryOutbox?.occurrences[0]?.model).toMatchObject({ status: "terminal", lastError: "payload_too_large" });
    expect(state.deliveryOutbox?.occurrences[0]?.payload).toBeUndefined();
    expect(runner.send).not.toHaveBeenCalled();
    expect(runner.postWebhook).not.toHaveBeenCalled();
  });

  test("bounds destination attempts and retains exhausted failures for operators", async () => {
    const runner = start({ postWebhook: async () => { throw new Error("still failing"); } });
    await runner.fire();
    for (let attempt = 1; attempt < MAX_CRON_DELIVERY_ATTEMPTS; attempt += 1) {
      const phase = (await readCronFile(workspace)).deliveryOutbox!.occurrences[0]!.webhook!;
      await runner.fire(phase.nextAttemptAt!);
    }
    const state = await readCronFile(workspace);
    expect(state.tasks).toHaveLength(1);
    expect(state.deliveryOutbox?.occurrences[0]?.webhook).toMatchObject({ status: "terminal", attempts: MAX_CRON_DELIVERY_ATTEMPTS });
    expect(runner.model).toHaveBeenCalledTimes(1);
    expect(runner.send).toHaveBeenCalledTimes(1);
    expect(runner.postWebhook).toHaveBeenCalledTimes(MAX_CRON_DELIVERY_ATTEMPTS);
    expect(runner.lines.at(-1)).toContain("requires operator action");
    await runner.fire(runner.scheduledAt);
    expect(runner.postWebhook).toHaveBeenCalledTimes(MAX_CRON_DELIVERY_ATTEMPTS);
  });

  test.each([false, true])("bounds outbox records without evicting unresolved entries, completed=%s", async (completed) => {
    await mutateCronFile(workspace, (state) => {
      state.deliveryOutbox = {
        version: 1,
        occurrences: Array.from({ length: MAX_CRON_OUTBOX_ENTRIES }, (_, ordinal) => {
          const taskId = "retained-" + ordinal;
          const key = taskId + ":" + DUE_AT;
          return {
            taskId, key, dueAt: DUE_AT, coalescedAt: DUE_AT,
            taskFingerprint: "a".repeat(64),
            model: { status: completed ? "delivered" as const : "pending" as const, attempts: completed ? 1 : 0 },
            webhook: { status: completed ? "delivered" as const : "pending" as const, attempts: completed ? 1 : 0 },
            ...(completed ? {
              completedAt: DUE_AT,
              payload: {
                taskId, occurrenceId: key, cron: "* * * * *", prompt: "old prompt",
                finalMessage: "old result", stopReason: "completed" as const,
                firedAt: new Date(DUE_AT).toISOString(),
              },
            } : {}),
          };
        }),
      };
    });
    const runner = start({});
    await runner.fire();
    const state = await readCronFile(workspace);
    expect(runner.model).toHaveBeenCalledTimes(completed ? 1 : 0);
    expect(state.deliveryOutbox?.occurrences).toHaveLength(completed ? 1 : MAX_CRON_OUTBOX_ENTRIES);
    expect(state.tasks).toHaveLength(completed ? 0 : 1);
  });
});
