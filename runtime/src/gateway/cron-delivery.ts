/**
 * Durable gateway delivery for scheduled prompts.
 *
 * Delivery-tagged tasks use isolated daemon sessions. Completed model results
 * and destination retry state are persisted before external delivery. The
 * task advances or is removed only after every destination acknowledges it.
 * Process locks prevent overlapping execution, and persisted leases and
 * backoff allow recovery after a gateway restart. Tool permissions are denied;
 * model and tool calls still pass through daemon-owned execution admission.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type { AgenCConfig } from "../config/schema.js";
import {
  BrowserSsrfError,
  resolveAllowedAddress,
  type HostLookup,
} from "../browser/ssrf.js";
import {
  MAX_CRON_PAYLOAD_BYTES,
  type CronDeliveryPayload,
} from "../utils/cron-delivery-state.js";
import {
  CronDeliveryOutboxStore,
  type CronOccurrenceClaim,
} from "./cron-outbox.js";
import { SessionRouter } from "./session-router.js";
import type {
  ChannelAdapter,
  GatewayDaemonClient,
  GatewayPromptResult,
} from "./types.js";
import { frameChannelMessage } from "./untrusted.js";
import {
  executionAdmissionErrorMessage,
  isExecutionAdmissionDenied,
} from "./admission-errors.js";

/** Upper bound on one sleep so externally-added tasks are noticed. */
export const CRON_DELIVERY_SCAN_CAP_MS = 5 * 60 * 1000;
export const CRON_WEBHOOK_TIMEOUT_MS = 15_000;
export const CRON_WEBHOOK_MAX_REDIRECTS = 5;

export interface CronDeliveryClock {
  now(): Date;
  setTimer(
    fn: () => void | Promise<void>,
    ms: number,
  ): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

const REAL_CLOCK: CronDeliveryClock = {
  now: () => new Date(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
};

export interface StartCronDeliveryOptions {
  readonly agencHome: string;
  /** Workspace holding `.agenc/scheduled_tasks.json`. */
  readonly workspaceDir: string;
  /** Main config retained on the gateway construction contract. */
  readonly config: AgenCConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly client: GatewayDaemonClient;
  readonly adapters: readonly ChannelAdapter[];
  readonly log?: (line: string) => void;
  /** Test seam: real timers by default. */
  readonly clock?: CronDeliveryClock;
  /** Test seam: webhook transport (address-pinned HTTP client by default). */
  readonly postWebhook?: (
    url: string,
    body: unknown,
    deliveryKey?: string,
  ) => Promise<void>;
}

export interface CronDeliveryHandle {
  /** True while a delivery turn is in flight (heartbeat skip-when-busy seam). */
  isRunning(): boolean;
  stop(): Promise<void>;
}

interface ResolvedCronWebhookTarget {
  readonly url: URL;
  readonly address: string;
}

export interface CronWebhookRequest {
  readonly url: URL;
  /** Exact policy-approved address to dial; never resolve `url.hostname` again. */
  readonly address: string;
  readonly method: "GET" | "POST";
  readonly body?: Uint8Array;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
}

export interface CronWebhookResponse {
  readonly statusCode: number;
  readonly location?: string;
}

export type CronWebhookRequester = (
  request: CronWebhookRequest,
) => Promise<CronWebhookResponse>;

export interface PostCronWebhookOptions {
  /** Test seam: deterministic DNS resolver. */
  readonly lookup?: HostLookup;
  /** Test seam: transport that must dial `request.address` directly. */
  readonly request?: CronWebhookRequester;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly idempotencyKey?: string;
}

function stripHostBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

async function resolveCronWebhookTarget(
  rawUrl: string,
  lookup?: HostLookup,
): Promise<ResolvedCronWebhookTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("cron webhook: invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("cron webhook: URL must be http(s)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("cron webhook: URL credentials are not allowed");
  }

  const host = stripHostBrackets(parsed.hostname);
  if (host === "") throw new Error("cron webhook: URL has no host");
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error("cron webhook: localhost blocked");
  }

  try {
    const address =
      lookup === undefined
        ? await resolveAllowedAddress(host, { allowPrivateNetwork: false })
        : await resolveAllowedAddress(
            host,
            { allowPrivateNetwork: false },
            lookup,
          );
    parsed.hash = "";
    return { url: parsed, address };
  } catch (error) {
    if (error instanceof BrowserSsrfError) {
      throw new Error(`cron webhook: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Fail-closed SSRF gate for cron webhooks. Every resolved address must be an
 * ordinary public address. Delivery performs the same check immediately
 * before opening its socket; this export also supports early configuration
 * validation without making that preflight the enforcement boundary.
 */
export async function assertCronWebhookUrlSafe(
  url: string,
  lookup?: HostLookup,
): Promise<void> {
  await resolveCronWebhookTarget(url, lookup);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("cron webhook: delivery aborted"), {
    name: "AbortError",
  });
}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function requestPinnedCronWebhook(
  input: CronWebhookRequest,
): Promise<CronWebhookResponse> {
  const originalHost = stripHostBrackets(input.url.hostname);
  const headers: Record<string, string | number> = {
    host: input.url.host,
    connection: "close",
  };
  if (input.idempotencyKey !== undefined) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = input.body.byteLength;
  }

  const requestOptions = {
    protocol: input.url.protocol,
    hostname: input.address,
    port:
      input.url.port === ""
        ? input.url.protocol === "https:"
          ? 443
          : 80
        : Number(input.url.port),
    method: input.method,
    path: `${input.url.pathname}${input.url.search}`,
    headers,
    signal: input.signal,
    agent: false as const,
    ...(input.url.protocol === "https:" && isIP(originalHost) === 0
      ? { servername: originalHost }
      : {}),
  };

  return new Promise<CronWebhookResponse>((resolve, reject) => {
    const transport =
      input.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(requestOptions, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      response.once("error", reject);
      response.once("aborted", () =>
        reject(new Error("cron webhook: response aborted")),
      );
      response.once("end", () =>
        resolve({
          statusCode,
          ...(location !== undefined ? { location } : {}),
        }),
      );
      response.resume();
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

function isRedirectStatus(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

export async function postCronWebhook(
  url: string,
  body: unknown,
  options: PostCronWebhookOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? CRON_WEBHOOK_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? CRON_WEBHOOK_MAX_REDIRECTS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("cron webhook: timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("cron webhook: max redirects must be a non-negative integer");
  }
  if (
    options.idempotencyKey !== undefined &&
    !/^[a-zA-Z0-9:_-]{1,256}$/.test(options.idempotencyKey)
  ) {
    throw new Error("cron webhook: invalid idempotency key");
  }

  const requester = options.request ?? requestPinnedCronWebhook;
  const serializedBody = JSON.stringify(body);
  const encodedBody =
    serializedBody === undefined
      ? undefined
      : Buffer.from(serializedBody, "utf8");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("cron webhook: delivery timed out")),
    timeoutMs,
  );
  try {
    let currentUrl = url;
    let method: "GET" | "POST" = "POST";
    let requestBody: Uint8Array | undefined = encodedBody;
    let redirects = 0;

    for (;;) {
      const target = await waitForAbort(
        resolveCronWebhookTarget(currentUrl, options.lookup),
        controller.signal,
      );
      const response = await waitForAbort(
        requester({
          url: target.url,
          address: target.address,
          method,
          ...(requestBody !== undefined ? { body: requestBody } : {}),
          signal: controller.signal,
          ...(options.idempotencyKey !== undefined
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        }),
        controller.signal,
      );
      if (!isRedirectStatus(response.statusCode)) {
        if (
          Number.isInteger(response.statusCode) &&
          response.statusCode >= 200 &&
          response.statusCode < 300
        ) return;
        throw new Error("cron webhook: unsuccessful HTTP response");
      }
      if (response.location === undefined) {
        throw new Error("cron webhook: redirect missing Location header");
      }
      if (redirects >= maxRedirects) {
        throw new Error(
          `cron webhook: too many redirects (maximum ${maxRedirects})`,
        );
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(response.location, target.url);
      } catch {
        throw new Error("cron webhook: invalid redirect URL");
      }
      if (redirectUrl.protocol !== target.url.protocol) {
        throw new Error("cron webhook: redirect protocol changes are not allowed");
      }

      redirects += 1;
      currentUrl = redirectUrl.toString();
      if (response.statusCode !== 307 && response.statusCode !== 308) {
        method = "GET";
        requestBody = undefined;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function defaultPostWebhook(
  url: string,
  body: unknown,
  deliveryKey?: string,
): Promise<void> {
  await postCronWebhook(url, body, {
    ...(deliveryKey !== undefined ? { idempotencyKey: deliveryKey } : {}),
  });
}

/** Suppresses streaming until the completed result is durably recorded. */
const NULL_ADAPTER: ChannelAdapter = {
  id: "cron-webhook-null",
  supportsEdit: false,
  async start() {},
  async stop() {},
  async send() {
    return "cron-null";
  },
};

export function startCronDelivery(
  options: StartCronDeliveryOptions,
): CronDeliveryHandle {
  const log = options.log ?? (() => {});
  const clock = options.clock ?? REAL_CLOCK;
  const postWebhook = options.postWebhook ?? defaultPostWebhook;
  const adaptersById = new Map(
    options.adapters.map((adapter) => [adapter.id, adapter]),
  );
  const outbox = new CronDeliveryOutboxStore(options.workspaceDir);
  const router = new SessionRouter({
    agencHome: options.agencHome,
    client: options.client,
  });

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeTick: Promise<void> | undefined;
  let retryFloorAt = 0;
  const now = (): number => clock.now().getTime();

  const fireTask = async (claim: CronOccurrenceClaim): Promise<void> => {
    const task = claim.task;
    const deliver = task.deliver;
    if (deliver === undefined) return;
    let payload = claim.occurrence.payload;
    if (payload === undefined) {
      if (
        stopped ||
        (await outbox.beginAttempt(claim, "model", now())) === undefined
      ) return;
      if (stopped) return;
      let result: GatewayPromptResult;
      try {
        result = await router.runTurn({
          key: SessionRouter.conversationKey({
            channelId: "cron",
            agent: "default",
            conversationId: task.id,
          }),
          text: frameChannelMessage({
            channelId: "cron",
            peerId: "cron:" + task.id,
            text: task.prompt,
          }),
          adapter: NULL_ADAPTER,
          conversationId: "cron",
          onPermissionRequest: async () => ({
            behavior: "deny",
            reason: "cron delivery turns do not grant tool permissions",
          }),
        });
      } catch (error) {
        const admission = isExecutionAdmissionDenied(error);
        const errorClass = admission ? "admission_pause" : "turn_error";
        const status = await outbox.failAttempt(claim, "model", errorClass, now());
        const action = status === "terminal"
          ? " requires operator action"
          : " retry pending";
        log("cron: task " + JSON.stringify(task.id) + action + " (" + errorClass + ")");
        if (
          admission && !stopped &&
          deliver.channel !== undefined && deliver.to !== undefined
        ) {
          const adapter = adaptersById.get(deliver.channel);
          if (
            adapter === undefined ||
            !(await outbox.beginAdmissionNotice(claim, now())) || stopped
          ) return;
          const reason = executionAdmissionErrorMessage(error).includes("budget_exceeded")
            ? "budget_exceeded"
            : "admission_denied";
          await adapter.send({
            conversationId: deliver.to,
            text: "⏸ cron task " + task.id + " paused: " + reason,
            idempotencyKey: createHash("sha256")
              .update(claim.key + ":admission-notice")
              .digest("hex"),
          }).catch(() => log("cron: admission pause notice failed"));
        }
        return;
      }
      if (result.stopReason !== "completed") {
        const errorClass = result.stopReason === "errored"
          ? "turn_errored"
          : result.stopReason === "stopped"
            ? "turn_stopped"
            : "unsupported_result";
        await outbox.failAttempt(
          claim, "model", errorClass, now(), errorClass === "unsupported_result",
        );
        log("cron: task " + JSON.stringify(task.id) + " result not deliverable (" + errorClass + ")");
        return;
      }
      if (typeof result.finalMessage !== "string") {
        await outbox.failAttempt(claim, "model", "unsupported_result", now(), true);
        return;
      }
      const completedPayload: CronDeliveryPayload = {
        taskId: task.id,
        occurrenceId: claim.key,
        cron: task.cron,
        prompt: task.prompt,
        finalMessage: result.finalMessage,
        stopReason: "completed",
        firedAt: clock.now().toISOString(),
      };
      if (
        Buffer.byteLength(JSON.stringify(completedPayload), "utf8") >
        MAX_CRON_PAYLOAD_BYTES
      ) {
        await outbox.failAttempt(claim, "model", "payload_too_large", now(), true);
        log("cron: task " + JSON.stringify(task.id) + " requires operator action (payload_too_large)");
        return;
      }
      if (!(await outbox.persistResult(claim, completedPayload))) return;
      payload = completedPayload;
    }

    for (const phase of ["channel", "webhook"] as const) {
      if (
        stopped ||
        (await outbox.beginAttempt(claim, phase, now())) === undefined
      ) continue;
      if (stopped) return;
      const deliveryKey = createHash("sha256")
        .update(claim.key + ":" + phase)
        .digest("hex");
      try {
        if (phase === "channel") {
          const adapter = deliver.channel === undefined
            ? undefined
            : adaptersById.get(deliver.channel);
          if (adapter === undefined || deliver.to === undefined) {
            const status = await outbox.failAttempt(
              claim, phase, "missing_adapter", now(),
            );
            const action = status === "terminal"
              ? "requires operator action"
              : "delivery retry pending";
            log("cron: unknown channel for task " + JSON.stringify(task.id) + "; " + action);
            continue;
          }
          await adapter.send({
            conversationId: deliver.to,
            text: payload.finalMessage,
            idempotencyKey: deliveryKey,
          });
        } else {
          if (deliver.webhook === undefined) continue;
          await postWebhook(deliver.webhook, payload, deliveryKey);
        }
      } catch {
        const status = await outbox.failAttempt(
          claim, phase, phase === "channel" ? "channel_error" : "webhook_error", now(),
        );
        const action = status === "terminal"
          ? " requires operator action"
          : " delivery retry pending";
        log("cron: task " + JSON.stringify(task.id) + " " + phase + action);
        continue;
      }
      await outbox.markDelivered(claim, phase);
    }
    if (await outbox.complete(claim, now())) {
      log("cron: task " + JSON.stringify(task.id) + " delivered (completed)");
    }
  };

  const arm = async (): Promise<void> => {
    if (stopped) return;
    if (timer !== null) clock.clearTimer(timer);
    let sleep = CRON_DELIVERY_SCAN_CAP_MS;
    try {
      let earliest = Infinity;
      for (const entry of await outbox.schedule()) {
        earliest = Math.min(earliest, entry.at);
      }
      sleep = Math.min(
        CRON_DELIVERY_SCAN_CAP_MS,
        Math.max(0, Math.max(retryFloorAt, earliest) - now()),
      );
    } catch {
      log("cron: delivery state unavailable; inspect the task file and directory permissions");
    }
    if (stopped) return;
    timer = clock.setTimer(() => {
      activeTick = tick();
      return activeTick;
    }, sleep);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      for (const entry of await outbox.schedule()) {
        if (stopped) break;
        if (entry.at > now()) continue;
        try {
          await outbox.withClaim(entry.taskId, now, fireTask);
        } catch {
          retryFloorAt = now() + 1_000;
          log("cron: task " + JSON.stringify(entry.taskId) + " delivery deferred; inspect persisted state");
        }
      }
    } catch {
      log("cron: delivery state unavailable; inspect the task file and directory permissions");
    } finally {
      running = false;
      await arm();
    }
  };

  const initialArm = arm();
  log("cron: gateway delivery armed");
  return {
    isRunning: () => running,
    async stop() {
      stopped = true;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
      await initialArm;
      await activeTick;
    },
  };
}
