/**
 * Gateway cron delivery (TODO task 16).
 *
 * Runs delivery-tagged cron tasks (`CronTask.deliver` set) in ISOLATED
 * gateway daemon sessions — heartbeat parity — and routes each result to a
 * channel adapter and/or a webhook POST. The in-session cron scheduler skips
 * these tasks (cronScheduler loadRunnableTasks), so the gateway is their
 * exclusive executor and a fire is never double-run.
 *
 * Scheduling: sleep-until-earliest-due with a scan cap. Every wake re-reads
 * `.agenc/scheduled_tasks.json` (cheap, non-model), fires the due tasks
 * (each past-due schedule coalesces to ONE fire), stamps `lastFiredAt` /
 * deletes one-shots, and re-arms. The scan cap bounds how stale the armed
 * timer can get when tasks are added by another process — the model is still
 * only invoked when a task is concretely due.
 *
 * Turns reuse the SessionRouter: one persistent daemon session per task
 * (`cron|<id>`), dead-agent retry, and channel streaming for free. Turns are
 * autonomous: permission requests are DENIED and the daemon-owned execution
 * admission kernel gates every model/tool boundary (refusal delivers a paused
 * notice, never silent).
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { AgenCConfig } from "../config/schema.js";
import {
  BrowserSsrfError,
  resolveAllowedAddress,
  type HostLookup,
} from "../browser/ssrf.js";
import {
  listAllCronTasks,
  markCronTasksFired,
  nextCronRunMs,
  removeCronTasks,
  type CronTask,
} from "../utils/cronTasks.js";
import { SessionRouter } from "./session-router.js";
import type { ChannelAdapter, GatewayDaemonClient } from "./types.js";
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
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
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
  readonly postWebhook?: (url: string, body: unknown) => Promise<void>;
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
        }),
        controller.signal,
      );
      if (!isRedirectStatus(response.statusCode)) return;
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

async function defaultPostWebhook(url: string, body: unknown): Promise<void> {
  await postCronWebhook(url, body);
}

/** Adapter used when a task delivers to a webhook only — swallows channel output. */
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
  const adaptersById = new Map(options.adapters.map((a) => [a.id, a]));

  const router = new SessionRouter({
    agencHome: options.agencHome,
    client: options.client,
  });

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deliveredTasks = async (): Promise<CronTask[]> => {
    const tasks = await listAllCronTasks(options.workspaceDir);
    return tasks.filter((t) => t.deliver !== undefined);
  };

  const fireTask = async (task: CronTask): Promise<void> => {
    const deliver = task.deliver;
    if (deliver === undefined) return;
    const adapter =
      deliver.channel !== undefined
        ? adaptersById.get(deliver.channel)
        : undefined;
    if (deliver.channel !== undefined && adapter === undefined) {
      log(
        `cron: task ${task.id} targets unknown channel '${deliver.channel}' — skipping channel delivery this fire`,
      );
    }
    const routeAdapter = adapter ?? NULL_ADAPTER;
    const conversationId = adapter !== undefined ? deliver.to ?? "" : "cron";

    // Admission/reservation/reconciliation belongs to the daemon session at
    // the actual model/tool boundary. The gateway owns only scheduling and
    // delivery, never a second outer-turn spend ledger.
    try {
      // Frame scheduled prompts as untrusted work data (parity with hooks/channels, todo-126).
      const framedPrompt = frameChannelMessage({
        channelId: "cron",
        peerId: `cron:${task.id}`,
        text: task.prompt,
      });
      const result = await router.runTurn({
        key: SessionRouter.conversationKey({
          channelId: "cron",
          agent: "default",
          conversationId: task.id,
        }),
        text: framedPrompt,
        adapter: routeAdapter,
        conversationId,
        // Autonomous, no human watching → deny permission requests (fail safe).
        onPermissionRequest: async () => ({
          behavior: "deny",
          reason: "cron delivery turns do not grant tool permissions",
        }),
      });

      if (deliver.webhook !== undefined) {
        await postWebhook(deliver.webhook, {
          taskId: task.id,
          cron: task.cron,
          prompt: task.prompt,
          finalMessage: result.finalMessage,
          stopReason: result.stopReason,
          firedAt: clock.now().toISOString(),
        }).catch((error: unknown) =>
          log(`cron: webhook POST failed for task ${task.id}: ${String(error)}`),
        );
      }
      log(`cron: task ${task.id} delivered (${result.stopReason})`);
    } catch (error) {
      if (!isExecutionAdmissionDenied(error)) throw error;
      const notice =
        `⏸ cron task ${task.id} paused: ` +
        executionAdmissionErrorMessage(error);
      log(`cron: ${notice}`);
      if (adapter !== undefined && deliver.to !== undefined) {
        await adapter
          .send({ conversationId: deliver.to, text: notice })
          .catch((noticeError: unknown) =>
            log(`cron: notice failed: ${String(noticeError)}`),
          );
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const now = clock.now().getTime();
      const tasks = await deliveredTasks();
      const firedRecurring: CronTask[] = [];
      const firedOneShots: string[] = [];
      for (const task of tasks) {
        // Anchor from the last fire (or creation) — a past-due schedule
        // coalesces to ONE fire regardless of how many slots were missed.
        const due = nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
        if (due === null || due > now) continue;
        try {
          await fireTask(task);
        } catch (error) {
          log(`cron: task ${task.id} failed: ${String(error)}`);
        }
        if (task.recurring === true) firedRecurring.push(task);
        else firedOneShots.push(task.id);
      }
      if (firedRecurring.length > 0) {
        await markCronTasksFired(
          firedRecurring.map((t) => t.id),
          now,
          options.workspaceDir,
        );
      }
      if (firedOneShots.length > 0) {
        await removeCronTasks(firedOneShots, options.workspaceDir);
      }
    } finally {
      running = false;
    }
    arm();
  };

  const arm = (): void => {
    if (stopped) return;
    if (timer !== null) clock.clearTimer(timer);
    void (async () => {
      const now = clock.now().getTime();
      let earliest: number | null = null;
      for (const task of await deliveredTasks()) {
        const due = nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
        if (due === null) continue;
        if (earliest === null || due < earliest) earliest = due;
      }
      if (stopped) return;
      const sleep = Math.min(
        earliest === null ? CRON_DELIVERY_SCAN_CAP_MS : Math.max(0, earliest - now),
        CRON_DELIVERY_SCAN_CAP_MS,
      );
      timer = clock.setTimer(() => void tick(), sleep);
    })();
  };

  arm();
  log("cron: gateway delivery armed");

  return {
    isRunning: () => running,
    async stop() {
      stopped = true;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
  };
}
