import { z } from "zod/v4";

export const MAX_CRON_OUTBOX_ENTRIES = 128;
export const MAX_CRON_PAYLOAD_BYTES = 64 * 1024;
export const MAX_CRON_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_CRON_DELIVERY_ATTEMPTS = 10;
export const CRON_DELIVERY_LEASE_MS = 60_000;
export const CRON_DELIVERY_RETRY_BASE_MS = 30_000;
export const CRON_DELIVERY_RETRY_CAP_MS = 5 * 60_000;

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(256);
const errorClass = z.enum([
  "turn_error",
  "admission_pause",
  "turn_errored",
  "turn_stopped",
  "unsupported_result",
  "payload_too_large",
  "missing_adapter",
  "channel_error",
  "webhook_error",
  "interrupted",
  "task_changed",
]);

const attemptSchema = z.strictObject({
  status: z.enum(["pending", "delivered", "retryable", "terminal"]),
  attempts: z.number().int().min(0).max(MAX_CRON_DELIVERY_ATTEMPTS),
  nextAttemptAt: timestamp.optional(),
  lastError: errorClass.optional(),
}).refine((attempt) => {
  if (attempt.status === "retryable") {
    return attempt.attempts > 0 &&
      attempt.nextAttemptAt !== undefined && attempt.lastError !== undefined;
  }
  if (attempt.status === "terminal") {
    return attempt.nextAttemptAt === undefined && attempt.lastError !== undefined;
  }
  return attempt.nextAttemptAt === undefined && attempt.lastError === undefined &&
    (attempt.status === "pending" ? attempt.attempts === 0 : attempt.attempts > 0);
}, "cron delivery attempt state is inconsistent");

const payloadSchema = z.strictObject({
  taskId: identifier,
  occurrenceId: identifier,
  cron: z.string().max(256),
  prompt: z.string().max(MAX_CRON_PAYLOAD_BYTES),
  finalMessage: z.string().max(MAX_CRON_PAYLOAD_BYTES),
  stopReason: z.literal("completed"),
  firedAt: z.iso.datetime(),
}).refine(
  (payload) =>
    Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_CRON_PAYLOAD_BYTES,
  "cron delivery payload exceeds its byte limit",
);

const occurrenceSchema = z.strictObject({
  key: identifier,
  taskId: identifier,
  dueAt: timestamp,
  coalescedAt: timestamp,
  taskFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  blockedReason: z.literal("task_changed").optional(),
  admissionNoticeAttemptedAt: timestamp.optional(),
  lease: z.strictObject({
    token: identifier,
    expiresAt: timestamp,
  }).optional(),
  model: attemptSchema,
  channel: attemptSchema.optional(),
  webhook: attemptSchema.optional(),
  payload: payloadSchema.optional(),
  completedAt: timestamp.optional(),
}).refine((entry) => {
  if (entry.channel === undefined && entry.webhook === undefined) return false;
  if (entry.coalescedAt < entry.dueAt) return false;
  if (entry.model.status === "delivered") {
    if (
      entry.payload === undefined ||
      entry.payload.taskId !== entry.taskId ||
      entry.payload.occurrenceId !== entry.key
    ) return false;
  } else if (entry.payload !== undefined) {
    return false;
  }
  if (entry.completedAt !== undefined) {
    return entry.lease === undefined && entry.model.status === "delivered" &&
      [entry.channel, entry.webhook].every(
        (attempt) => attempt === undefined || attempt.status === "delivered",
      );
  }
  return true;
}, "cron delivery occurrence state is inconsistent");

const outboxSchema = z.strictObject({
  version: z.literal(1),
  occurrences: z.array(occurrenceSchema).max(MAX_CRON_OUTBOX_ENTRIES),
}).refine(
  (outbox) =>
    new Set(outbox.occurrences.map((entry) => entry.key)).size ===
    outbox.occurrences.length,
  "cron delivery occurrence keys must be unique",
).refine(
  (outbox) => {
    const pending = outbox.occurrences.filter(
      (entry) => entry.completedAt === undefined,
    );
    return new Set(pending.map((entry) => entry.taskId)).size === pending.length;
  },
  "a task cannot have multiple pending occurrences",
);

export type CronDeliveryAttempt = z.infer<typeof attemptSchema>;
export type CronDeliveryErrorClass = z.infer<typeof errorClass>;
export type CronDeliveryPayload = z.infer<typeof payloadSchema>;
export type CronDeliveryOccurrence = z.infer<typeof occurrenceSchema>;
export type CronDeliveryOutbox = z.infer<typeof outboxSchema>;

export function parseCronDeliveryOutbox(value: unknown): CronDeliveryOutbox {
  const parsed = outboxSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Invalid cron delivery outbox; preserve the task file for recovery",
    );
  }
  return parsed.data;
}
