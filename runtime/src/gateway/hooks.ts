/**
 * Inbound webhooks — `POST /hooks/agent` (TODO task 17).
 *
 * A loopback HTTP trigger surface: an authenticated POST turns its `message`
 * into ONE agent turn, optionally delivering the result to a channel. This is
 * the automation entry point (CI alerts, monitors, home automation → agent →
 * Telegram/Discord/Slack reply), not a conversation surface — there is no
 * pairing dance because the bearer token IS the auth.
 *
 * Security posture (the load-bearing part):
 *  - DISABLED by default. Starts only when enabled via gateway config or the
 *    `--hooks` flag, and always with a token.
 *  - Binds loopback and REFUSES a non-loopback host without an explicit
 *    `allowNonLoopback` (prefer a tailnet/SSH tunnel).
 *  - Bearer token in the `Authorization` header ONLY, compared with
 *    `timingSafeEqual`. A token-looking QUERY parameter is rejected outright
 *    (401) even when the header is also valid: query strings leak into shell
 *    history, proxy logs, and browser history — refusing teaches callers the
 *    safe shape. `agenc security audit` flags hooks-enabled-without-token.
 *  - The payload `message` is untrusted work data: it is sanitized + framed
 *    (task-11 machinery) before it ever reaches `session.prompt`, exactly
 *    like channel text. It can never change permission mode or tool policy;
 *    hook turns DENY permission requests (autonomous, nobody watching).
 *  - Hook turns are autonomous spend: every request passes the task-15
 *    budget envelope (admit → turn → reconcile); a refusal is a 429, never
 *    a silent skip or silent spend.
 *
 * Request:  POST /hooks/agent
 *           Authorization: Bearer <token>
 *           { "message": "...",            required — the prompt text
 *             "name": "ci",                optional hook identity (peer id)
 *             "agent": "default",          optional session-scope label
 *             "sessionKey": "deploys",     optional continuity key — same key
 *                                          = same daemon session
 *             "deliver": { "channel": "telegram", "to": "<chat>" } }
 * Response: with `deliver` → 202 immediately; the turn runs async and the
 *           final message streams to that channel (edit-in-place capable).
 *           without `deliver` → waits for the turn, 200 with
 *           { ok, sessionKey, finalMessage, stopReason }.
 */

import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP, type AddressInfo } from "node:net";

import type { AgenCConfig } from "../config/schema.js";
import {
  BudgetEnforcer,
  BudgetLedger,
  createModelPriceResolver,
  resolveBudgetPolicy,
} from "../budget/index.js";
import { SessionRouter } from "./session-router.js";
import { frameChannelMessage } from "./untrusted.js";
import type { ChannelAdapter, GatewayDaemonClient } from "./types.js";

export const HOOKS_CHANNEL_ID = "hooks";
export const HOOKS_PATH = "/hooks/agent";
/** Default bind port when enabled via config without an explicit port. */
export const HOOKS_DEFAULT_PORT = 8377;

/** Raw request body cap. */
const MAX_BODY_BYTES = 64 * 1024;
/** Post-parse message cap (chars). */
const MAX_MESSAGE_CHARS = 32 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** Identifier fields (name/agent/sessionKey) share one conservative shape. */
const IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Query parameters that smell like credentials. Their PRESENCE fails the
 * request — tokens must never ride the query string.
 */
const FORBIDDEN_QUERY_PARAMS = [
  "token",
  "access_token",
  "auth",
  "bearer",
  "key",
  "apikey",
  "api_key",
] as const;

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const fam = isIP(h);
  if (fam === 4) return h.startsWith("127.");
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Deterministic ~chars/4 token estimate (mirrors heartbeat/cron). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Swallows channel output for no-deliver turns. */
const NULL_ADAPTER: ChannelAdapter = {
  id: "hooks-null",
  supportsEdit: false,
  async start() {},
  async stop() {},
  async send() {
    return "hooks-null";
  },
};

export interface HooksServerOptions {
  readonly agencHome: string;
  readonly token: string;
  readonly client: GatewayDaemonClient;
  /** Channel adapters available as `deliver` targets. */
  readonly adapters: readonly ChannelAdapter[];
  /** Main config (budget envelope). */
  readonly config: AgenCConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Session-scope label when the request has no `agent`. */
  readonly defaultAgent?: string;
  readonly host?: string;
  readonly port?: number;
  readonly allowNonLoopback?: boolean;
  readonly log?: (line: string) => void;
}

interface HookRequest {
  readonly message: string;
  readonly name: string;
  readonly agent: string;
  readonly sessionKey: string;
  readonly deliver?: { readonly channel: string; readonly to: string };
}

export class HooksServer {
  readonly #token: string;
  readonly #host: string;
  readonly #port: number;
  readonly #log: (line: string) => void;
  readonly #router: SessionRouter;
  readonly #adaptersById: Map<string, ChannelAdapter>;
  readonly #enforcer: BudgetEnforcer;
  readonly #defaultAgent: string;
  #server: Server | null = null;
  #boundPort = 0;

  constructor(options: HooksServerOptions) {
    this.#token = options.token;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? HOOKS_DEFAULT_PORT;
    this.#log = options.log ?? (() => {});
    this.#defaultAgent = options.defaultAgent ?? "default";
    if (!isLoopbackHost(this.#host) && options.allowNonLoopback !== true) {
      throw new Error(
        `hooks: refusing non-loopback host '${this.#host}' without allowNonLoopback (prefer a tailnet/SSH tunnel)`,
      );
    }
    if (this.#token.length < 16) {
      throw new Error("hooks: token must be at least 16 characters");
    }
    this.#router = new SessionRouter({
      agencHome: options.agencHome,
      client: options.client,
    });
    this.#adaptersById = new Map(options.adapters.map((a) => [a.id, a]));
    const { policy } = resolveBudgetPolicy(options.config.budget, options.env ?? {});
    this.#enforcer = new BudgetEnforcer({
      policy,
      ledger: new BudgetLedger({ agencHome: options.agencHome }),
      priceOf: createModelPriceResolver(),
      notify: (e) => this.#log(`hooks/budget: ${e.message}`),
    });
  }

  get port(): number {
    return this.#boundPort;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        this.#json(res, 500, { error: `hooks: ${String(error)}` });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.#server;
      if (server === null) return reject(new Error("server not created"));
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        const addr = server.address() as AddressInfo | null;
        this.#boundPort = addr?.port ?? this.#port;
        server.off("error", reject);
        resolve();
      });
    });
    this.#log(
      `hooks: POST http://${this.#host}:${this.#boundPort}${HOOKS_PATH} (bearer token required)`,
    );
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  #json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Header-only auth, checked FIRST: a token-looking query parameter fails
    // the request outright — even alongside a valid header — because query
    // strings leak into logs and histories. Never compared, never accepted.
    for (const param of FORBIDDEN_QUERY_PARAMS) {
      if (url.searchParams.has(param)) {
        this.#log("hooks: rejected request carrying a query-string credential");
        this.#json(res, 401, {
          error:
            "credentials must be sent via 'Authorization: Bearer <token>' only — never in the query string",
        });
        return;
      }
    }
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (bearer.length === 0 || !safeEqual(bearer, this.#token)) {
      this.#json(res, 401, { error: "missing or invalid bearer token" });
      return;
    }

    if (url.pathname !== HOOKS_PATH) {
      this.#json(res, 404, { error: `unknown path (expected ${HOOKS_PATH})` });
      return;
    }
    if (req.method !== "POST") {
      this.#json(res, 405, { error: "POST only" });
      return;
    }

    const body = await this.#readBody(req);
    if (body === null) {
      this.#json(res, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
      return;
    }
    const parsed = this.#parseRequest(body);
    if (typeof parsed === "string") {
      this.#json(res, 400, { error: parsed });
      return;
    }

    const deliverAdapter =
      parsed.deliver !== undefined
        ? this.#adaptersById.get(parsed.deliver.channel)
        : undefined;
    if (parsed.deliver !== undefined && deliverAdapter === undefined) {
      this.#json(res, 400, {
        error: `deliver.channel '${parsed.deliver.channel}' is not a running channel (have: ${[...this.#adaptersById.keys()].join(", ") || "none"})`,
      });
      return;
    }

    // Budget pre-flight: hook turns are autonomous spend. A refusal is a
    // visible 429, never a silent skip.
    const admit = this.#enforcer.admit({
      agentId: `hook:${parsed.name}`,
      model: "unknown",
      autonomous: true,
      estInputTokens: estimateTokens(parsed.message),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    if (!admit.ok) {
      this.#json(res, 429, { error: `budget: ${admit.message}` });
      return;
    }

    // The payload is untrusted work data — sanitize + frame (task 11)
    // before it reaches session.prompt, exactly like channel text.
    const framedText = frameChannelMessage({
      channelId: HOOKS_CHANNEL_ID,
      peerId: `hook:${parsed.name}`,
      text: parsed.message,
    });
    const key = SessionRouter.conversationKey({
      channelId: HOOKS_CHANNEL_ID,
      agent: parsed.agent,
      conversationId: parsed.sessionKey,
    });

    const runTurn = () =>
      this.#router.runTurn({
        key,
        text: framedText,
        adapter: deliverAdapter ?? NULL_ADAPTER,
        conversationId: parsed.deliver?.to ?? parsed.sessionKey,
        // Autonomous, nobody watching → deny permission requests (fail safe).
        onPermissionRequest: async () => ({
          behavior: "deny",
          reason: "hook turns do not grant tool permissions",
        }),
      });

    if (deliverAdapter !== undefined) {
      // Fire-and-deliver: acknowledge now, stream the turn to the channel.
      this.#json(res, 202, { ok: true, sessionKey: parsed.sessionKey });
      try {
        const result = await runTurn();
        this.#enforcer.reconcile(
          admit.hold,
          result.usage ?? { inputTokens: 0, outputTokens: 0 },
        );
        this.#log(`hooks: '${parsed.name}' delivered (${result.stopReason})`);
      } catch (error) {
        this.#enforcer.reconcile(admit.hold, { inputTokens: 0, outputTokens: 0 });
        this.#log(`hooks: '${parsed.name}' turn failed: ${String(error)}`);
      }
      return;
    }

    // Synchronous mode: the caller wants the answer in the response.
    try {
      const result = await runTurn();
      this.#enforcer.reconcile(
        admit.hold,
        result.usage ?? { inputTokens: 0, outputTokens: 0 },
      );
      this.#json(res, 200, {
        ok: true,
        sessionKey: parsed.sessionKey,
        finalMessage: result.finalMessage,
        stopReason: result.stopReason,
      });
    } catch (error) {
      this.#enforcer.reconcile(admit.hold, { inputTokens: 0, outputTokens: 0 });
      this.#json(res, 500, { error: `turn failed: ${String(error)}` });
    }
  }

  async #readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  #parseRequest(body: string): HookRequest | string {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return "body must be JSON";
    }
    if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
    const record = raw as Record<string, unknown>;

    const message = record.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return "'message' (non-empty string) is required";
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return `'message' exceeds ${MAX_MESSAGE_CHARS} characters`;
    }

    const identifier = (field: string, fallback: string): string | null => {
      const value = record[field];
      if (value === undefined) return fallback;
      if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) return null;
      return value;
    };
    const name = identifier("name", "default");
    if (name === null) return "'name' must match [A-Za-z0-9._-]{1,128}";
    const agent = identifier("agent", this.#defaultAgent);
    if (agent === null) return "'agent' must match [A-Za-z0-9._-]{1,128}";
    const sessionKey = identifier("sessionKey", name);
    if (sessionKey === null) {
      return "'sessionKey' must match [A-Za-z0-9._-]{1,128}";
    }

    let deliver: HookRequest["deliver"];
    if (record.deliver !== undefined) {
      const d = record.deliver;
      if (typeof d !== "object" || d === null) {
        return "'deliver' must be an object {channel, to}";
      }
      const channel = (d as Record<string, unknown>).channel;
      const to = (d as Record<string, unknown>).to;
      if (
        typeof channel !== "string" ||
        channel.length === 0 ||
        typeof to !== "string" ||
        to.length === 0
      ) {
        return "'deliver' requires non-empty string fields 'channel' and 'to'";
      }
      deliver = { channel, to };
    }

    return {
      message,
      name,
      agent,
      sessionKey,
      ...(deliver !== undefined ? { deliver } : {}),
    };
  }
}
