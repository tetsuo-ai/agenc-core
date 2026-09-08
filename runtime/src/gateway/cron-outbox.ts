import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getCronFilePath,
  mutateCronFile,
  nextCronRunMs,
  readCronFile,
  type CronFile,
  type CronTask,
} from "../utils/cronTasks.js";
import { acquireLocalSqliteLock } from "../utils/sqlite-lock.js";
import {
  CRON_DELIVERY_LEASE_MS,
  CRON_DELIVERY_RETRY_BASE_MS,
  CRON_DELIVERY_RETRY_CAP_MS,
  MAX_CRON_DELIVERY_ATTEMPTS,
  MAX_CRON_OUTBOX_ENTRIES,
  type CronDeliveryAttempt,
  type CronDeliveryErrorClass,
  type CronDeliveryOccurrence,
  type CronDeliveryPayload,
} from "../utils/cron-delivery-state.js";

export type CronDeliveryPhase = "model" | "channel" | "webhook";

export interface CronOccurrenceClaim {
  readonly key: string;
  readonly token: string;
  readonly task: CronTask;
  readonly occurrence: CronDeliveryOccurrence;
}

function taskFingerprint(task: CronTask): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex");
}

function attemptTime(attempt: CronDeliveryAttempt | undefined): number {
  if (
    attempt === undefined ||
    attempt.status === "delivered" || attempt.status === "terminal"
  ) {
    return Infinity;
  }
  return attempt.nextAttemptAt ?? 0;
}

function allDestinationsDelivered(entry: CronDeliveryOccurrence): boolean {
  return [entry.channel, entry.webhook].every(
    (attempt) => attempt === undefined || attempt.status === "delivered",
  );
}

function occurrenceTime(entry: CronDeliveryOccurrence): number {
  if (entry.blockedReason !== undefined) return Infinity;
  const next = entry.model.status !== "delivered"
    ? attemptTime(entry.model)
    : allDestinationsDelivered(entry)
      ? 0
      : Math.min(attemptTime(entry.channel), attemptTime(entry.webhook));
  return Math.max(next, entry.lease?.expiresAt ?? 0);
}

function retryTime(
  key: string,
  phase: CronDeliveryPhase,
  attempts: number,
  now: number,
): number {
  const digest = createHash("sha256")
    .update(`${key}:${phase}:${attempts}`)
    .digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  const base = Math.min(
    CRON_DELIVERY_RETRY_CAP_MS,
    CRON_DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1),
  );
  return now + Math.floor(
    Math.min(CRON_DELIVERY_RETRY_CAP_MS, base * (0.75 + fraction / 2)),
  );
}

export class CronDeliveryOutboxStore {
  constructor(readonly workspaceDir: string) {}

  async schedule(): Promise<readonly { taskId: string; at: number }[]> {
    const state = await readCronFile(this.workspaceDir);
    return state.tasks.filter((task) => task.deliver !== undefined).flatMap((task) => {
      const active = state.deliveryOutbox?.occurrences.find(
        (entry) => entry.taskId === task.id && entry.completedAt === undefined,
      );
      const at = active !== undefined
        ? occurrenceTime(active)
        : nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
      return at === null || !Number.isFinite(at) ? [] : [{ taskId: task.id, at }];
    });
  }

  async withClaim(
    taskId: string,
    now: () => number,
    operation: (claim: CronOccurrenceClaim) => Promise<void>,
  ): Promise<void> {
    const directory = dirname(getCronFilePath(this.workspaceDir));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    const stripe = createHash("sha256").update(taskId).digest()[0]! % 16;
    const release = await acquireLocalSqliteLock(
      join(canonicalDirectory, `cron-delivery-${stripe}.lock.sqlite`),
      { timeoutMs: 1_000, label: "cron occurrence execution" },
    );
    try {
      const claim = await this.claim(taskId, now());
      if (claim === undefined) return;
      try {
        await operation(claim);
      } finally {
        await mutateCronFile(this.workspaceDir, (state) => {
          const entry = state.deliveryOutbox?.occurrences.find(
            (candidate) => candidate.key === claim.key,
          );
          if (entry?.lease?.token === claim.token) delete entry.lease;
        });
      }
    } finally {
      release();
    }
  }

  private async claim(
    taskId: string,
    now: number,
  ): Promise<CronOccurrenceClaim | undefined> {
    return mutateCronFile(this.workspaceDir, (state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task?.deliver === undefined) return undefined;
      state.deliveryOutbox ??= { version: 1, occurrences: [] };
      const outbox = state.deliveryOutbox;
      let entry = outbox.occurrences.find(
        (candidate) =>
          candidate.taskId === task.id && candidate.completedAt === undefined,
      );
      if (entry === undefined) {
        const dueAt = nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
        if (dueAt === null || dueAt > now) return undefined;
        if (outbox.occurrences.length >= MAX_CRON_OUTBOX_ENTRIES) {
          outbox.occurrences = outbox.occurrences.filter(
            (candidate) => candidate.completedAt === undefined,
          );
        }
        if (outbox.occurrences.length >= MAX_CRON_OUTBOX_ENTRIES) {
          throw new Error(
            "Cron delivery outbox is full; resolve pending deliveries first",
          );
        }
        entry = {
          key: `${task.id}:${dueAt}`,
          taskId: task.id,
          dueAt,
          coalescedAt: now,
          taskFingerprint: taskFingerprint(task),
          model: { status: "pending", attempts: 0 },
          ...(task.deliver.channel !== undefined
            ? { channel: { status: "pending" as const, attempts: 0 } }
            : {}),
          ...(task.deliver.webhook !== undefined
            ? { webhook: { status: "pending" as const, attempts: 0 } }
            : {}),
        };
        outbox.occurrences.push(entry);
      }
      if (entry.taskFingerprint !== taskFingerprint(task)) {
        entry.blockedReason = "task_changed";
        for (const attempt of [entry.model, entry.channel, entry.webhook]) {
          if (attempt !== undefined && attempt.status !== "delivered") {
            attempt.status = "terminal";
            attempt.lastError = "task_changed";
            delete attempt.nextAttemptAt;
          }
        }
        delete entry.lease;
        return undefined;
      }
      if (occurrenceTime(entry) > now) return undefined;
      const token = randomUUID();
      entry.lease = { token, expiresAt: now + CRON_DELIVERY_LEASE_MS };
      return {
        key: entry.key,
        token,
        task: structuredClone(task),
        occurrence: structuredClone(entry),
      };
    });
  }

  private async update(
    claim: CronOccurrenceClaim,
    mutate: (
      entry: CronDeliveryOccurrence,
      task: CronTask,
      state: CronFile,
    ) => void,
  ): Promise<CronDeliveryOccurrence | undefined> {
    return mutateCronFile(this.workspaceDir, (state) => {
      const entry = state.deliveryOutbox?.occurrences.find(
        (candidate) => candidate.key === claim.key,
      );
      const task = state.tasks.find((candidate) => candidate.id === claim.task.id);
      if (
        entry?.lease?.token !== claim.token ||
        entry.blockedReason !== undefined ||
        task === undefined ||
        entry.taskFingerprint !== taskFingerprint(task)
      ) {
        return undefined;
      }
      mutate(entry, task, state);
      return structuredClone(entry);
    });
  }

  async beginAttempt(
    claim: CronOccurrenceClaim,
    phase: CronDeliveryPhase,
    now: number,
  ): Promise<CronDeliveryOccurrence | undefined> {
    let started = false;
    const entry = await this.update(claim, (current) => {
      const attempt = current[phase];
      if (attemptTime(attempt) > now || attempt === undefined) return;
      if (attempt.attempts >= MAX_CRON_DELIVERY_ATTEMPTS) {
        attempt.status = "terminal";
        attempt.lastError ??= "interrupted";
        delete attempt.nextAttemptAt;
        return;
      }
      attempt.attempts += 1;
      attempt.status = "retryable";
      attempt.lastError = "interrupted";
      attempt.nextAttemptAt = retryTime(claim.key, phase, attempt.attempts, now);
      started = true;
    });
    return started ? entry : undefined;
  }

  async beginAdmissionNotice(
    claim: CronOccurrenceClaim,
    now: number,
  ): Promise<boolean> {
    let started = false;
    await this.update(claim, (entry) => {
      if (entry.admissionNoticeAttemptedAt !== undefined) return;
      entry.admissionNoticeAttemptedAt = now;
      started = true;
    });
    return started;
  }

  async persistResult(
    claim: CronOccurrenceClaim,
    payload: CronDeliveryPayload,
  ): Promise<boolean> {
    return (await this.update(claim, (entry) => {
      entry.payload = payload;
      entry.model.status = "delivered";
      delete entry.model.lastError;
      delete entry.model.nextAttemptAt;
    })) !== undefined;
  }

  async failAttempt(
    claim: CronOccurrenceClaim,
    phase: CronDeliveryPhase,
    error: CronDeliveryErrorClass,
    now: number,
    terminal = false,
  ): Promise<CronDeliveryAttempt["status"] | undefined> {
    const updated = await this.update(claim, (entry) => {
      const attempt = entry[phase];
      if (attempt === undefined) return;
      attempt.lastError = error;
      if (terminal || attempt.attempts >= MAX_CRON_DELIVERY_ATTEMPTS) {
        attempt.status = "terminal";
        delete attempt.nextAttemptAt;
      } else {
        attempt.nextAttemptAt = retryTime(claim.key, phase, attempt.attempts, now);
      }
    });
    return updated?.[phase]?.status;
  }

  async markDelivered(
    claim: CronOccurrenceClaim,
    phase: "channel" | "webhook",
  ): Promise<void> {
    await this.update(claim, (entry) => {
      const attempt = entry[phase];
      if (attempt === undefined) return;
      attempt.status = "delivered";
      delete attempt.lastError;
      delete attempt.nextAttemptAt;
    });
  }

  async complete(claim: CronOccurrenceClaim, now: number): Promise<boolean> {
    let completed = false;
    await this.update(claim, (entry, task, state) => {
      if (
        entry.model.status !== "delivered" || !allDestinationsDelivered(entry)
      ) return;
      if (task.recurring === true) {
        task.lastFiredAt = Math.max(now, entry.coalescedAt);
      } else {
        state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
      }
      entry.completedAt = now;
      delete entry.lease;
      completed = true;
    });
    return completed;
  }
}
