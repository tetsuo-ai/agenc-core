/**
 * Slack channel adapter (TODO task 9) — official Slack APIs only.
 *
 * Inbound rides Socket Mode: `apps.connections.open` (app-level token) mints
 * a WebSocket URL, events arrive as envelopes that MUST be acked by
 * `envelope_id` (unacked envelopes are redelivered, then the app is flagged).
 * Socket Mode is chosen over the Events API deliberately: it opens NO inbound
 * listener, matching the gateway's loopback-only security posture. Outbound
 * rides the Web API (`chat.postMessage` / `chat.update`) with the bot token,
 * so `supportsEdit` streaming coalescing works.
 *
 * The transport (socket + Web API) is injected — unit tests drive a scripted
 * fake; the production transport uses global `WebSocket` + `fetch`, zero deps.
 *
 * Mapping:
 *  - `channel_type: "im"`          → conversation kind "dm", id = channel id.
 *  - channels/groups/mpim          → kind "group". Workspace-channel bindings
 *    use the Slack channel id as `groupId`.
 *  - Threads: a message with `thread_ts` maps to conversation id
 *    `<channel>:<thread_ts>` so each thread gets its own session, and
 *    replies post with that `thread_ts` (they stay in-thread).
 *  - Group addressing defaults to "mentions": only <@bot> mentions reach the
 *    agent. `app_mention` events are ignored entirely (the `message` event
 *    for the same text already covers it — reacting to both double-fires).
 */

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  OutboundChannelMessage,
} from "./types.js";

export const SLACK_CHANNEL_ID = "slack";

/** Practical per-message cap (Slack rejects ~40k chars). */
export const SLACK_MESSAGE_LIMIT = 39_000;

export interface SlackEnvelope {
  readonly type: string;
  readonly envelope_id?: string;
  readonly payload?: {
    readonly event?: SlackMessageEvent;
  };
  readonly reason?: string;
}

export interface SlackMessageEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
}

export interface SlackSocketHandlers {
  onEnvelope(envelope: SlackEnvelope): void;
  onClose(code?: number): void;
}

export interface SlackSocket {
  /** Ack an envelope (`{envelope_id}`) or send any raw frame. */
  send(frame: Record<string, unknown>): void;
  close(): void;
}

export interface SlackTransport {
  /** `apps.connections.open` (app-level token) → wss url. */
  openSocketUrl(): Promise<string>;
  connect(url: string, handlers: SlackSocketHandlers): Promise<SlackSocket>;
  /** `auth.test` (bot token) → the bot's own user id, for mention gating. */
  authTest(): Promise<{ userId: string }>;
  /** `chat.postMessage` → message ts. */
  postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string }>;
  /** `chat.update` */
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
}

export class SlackApiError extends Error {}

const SLACK_API = "https://slack.com/api";

// Upper bound on retained edit-in-place targets (edits only ever hit a recent
// message; older handles are evicted oldest-first so the map cannot grow forever).
const MAX_EDIT_TARGETS = 512;

/** Production transport: fetch Web API + global WebSocket, zero deps. */
export class FetchSlackTransport implements SlackTransport {
  readonly #botToken: string;
  readonly #appToken: string;

  constructor(options: { readonly botToken: string; readonly appToken: string }) {
    this.#botToken = options.botToken;
    this.#appToken = options.appToken;
  }

  async #call(
    method: string,
    token: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = (await response.json()) as Record<string, unknown> & {
      ok?: boolean;
      error?: string;
    };
    if (result.ok !== true) {
      throw new SlackApiError(
        `slack api ${method} failed: ${result.error ?? response.status}`,
      );
    }
    return result;
  }

  async openSocketUrl(): Promise<string> {
    const result = await this.#call("apps.connections.open", this.#appToken, undefined);
    const url = result.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new SlackApiError("slack apps.connections.open returned no url");
    }
    return url;
  }

  async connect(
    url: string,
    handlers: SlackSocketHandlers,
  ): Promise<SlackSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new SlackApiError("slack socket connect failed")), { once: true });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        handlers.onEnvelope(JSON.parse(String(event.data)) as SlackEnvelope);
      } catch {
        // Non-JSON frames are ignored.
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      handlers.onClose(event.code);
    });
    return {
      send: (frame) => socket.send(JSON.stringify(frame)),
      close: () => socket.close(),
    };
  }

  async authTest(): Promise<{ userId: string }> {
    const result = await this.#call("auth.test", this.#botToken, undefined);
    const userId = result.user_id;
    if (typeof userId !== "string") {
      throw new SlackApiError("slack auth.test returned no user_id");
    }
    return { userId };
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ts: string }> {
    const result = await this.#call("chat.postMessage", this.#botToken, {
      channel,
      text,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    });
    const ts = result.ts;
    if (typeof ts !== "string") {
      throw new SlackApiError("slack chat.postMessage returned no ts");
    }
    return { ts };
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.#call("chat.update", this.#botToken, { channel, ts, text });
  }
}

export interface SlackChannelOptions {
  readonly transport: SlackTransport;
  readonly id?: string;
  readonly log?: (line: string) => void;
  /**
   * In channels, "mentions" (default) means only <@bot> mentions reach the
   * agent. "all" turns every channel message into a turn — broadcast rooms
   * only. DMs always reach the (pairing-gated) agent.
   */
  readonly groupAddressing?: "all" | "mentions";
  /** Bounded backoff between reconnect attempts, ms. */
  readonly reconnectBackoffMs?: number;
  /** Test seam: injectable reconnect timer. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Launch the socket connection on start(). Tests set false and drive
   *  envelopes through handleEnvelope deterministically. */
  readonly autoConnect?: boolean;
}

interface EditTarget {
  readonly channel: string;
  readonly ts: string;
}

/** conversationId encoding: `<channel>` or `<channel>:<thread_ts>`. */
export function parseSlackConversationId(conversationId: string): {
  channel: string;
  threadTs?: string;
} {
  const at = conversationId.indexOf(":");
  if (at === -1) return { channel: conversationId };
  return {
    channel: conversationId.slice(0, at),
    threadTs: conversationId.slice(at + 1),
  };
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = true;
  readonly #transport: SlackTransport;
  readonly #log: (line: string) => void;
  readonly #groupAddressing: "all" | "mentions";
  readonly #backoffMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #autoConnect: boolean;
  readonly #editTargets = new Map<string, EditTarget>();
  #context: ChannelAdapterContext | null = null;
  #socket: SlackSocket | null = null;
  #running = false;
  #selfId: string | null = null;
  #outCounter = 0;

  constructor(options: SlackChannelOptions) {
    this.id = options.id ?? SLACK_CHANNEL_ID;
    this.#transport = options.transport;
    this.#log = options.log ?? (() => {});
    this.#groupAddressing = options.groupAddressing ?? "mentions";
    this.#backoffMs = options.reconnectBackoffMs ?? 2000;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#autoConnect = options.autoConnect ?? true;
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    this.#running = true;
    try {
      this.#selfId = (await this.#transport.authTest()).userId;
    } catch (error) {
      // Without a self id, mention gating cannot match — fail closed for
      // group traffic (DMs still work).
      this.#log(`slack: auth.test failed: ${String(error)}`);
    }
    if (this.#autoConnect) await this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#socket?.close();
    this.#socket = null;
    this.#context = null;
  }

  async #connect(): Promise<void> {
    const url = await this.#transport.openSocketUrl();
    this.#socket = await this.#transport.connect(url, {
      onEnvelope: (envelope) => this.handleEnvelope(envelope),
      onClose: (code) => {
        this.#socket = null;
        if (!this.#running) return;
        this.#log(`slack: socket closed (${code ?? "?"}) — reconnecting`);
        this.#scheduleReconnect();
      },
    });
  }

  #scheduleReconnect(): void {
    if (!this.#running) return;
    this.#setTimer(() => {
      if (!this.#running) return;
      void this.#connect().catch((error) => {
        this.#log(`slack: reconnect failed: ${String(error)}`);
        this.#scheduleReconnect();
      });
    }, this.#backoffMs);
  }

  /** Exposed for deterministic tests (fake socket feeds envelopes here). */
  handleEnvelope(envelope: SlackEnvelope): void {
    // ACK FIRST, unconditionally, for every acknowledgeable envelope — even
    // ones we drop. Slack redelivers unacked envelopes and eventually flags
    // the app; a dropped-but-acked message is correct, a processed-but-
    // unacked one is a duplicate turn.
    if (envelope.envelope_id !== undefined) {
      this.#socket?.send({ envelope_id: envelope.envelope_id });
    }
    if (envelope.type === "disconnect") {
      // Slack refreshes Socket Mode links periodically; recycle the socket
      // (a fresh apps.connections.open) instead of waiting for the close.
      this.#log(`slack: disconnect requested (${envelope.reason ?? "refresh"})`);
      this.#socket?.close();
      return;
    }
    if (envelope.type !== "events_api") return;
    const event = envelope.payload?.event;
    if (event === undefined) return;
    void this.#handleEvent(event);
  }

  async #handleEvent(event: SlackMessageEvent): Promise<void> {
    if (this.#context === null) return;
    // app_mention duplicates the message event for the same text.
    if (event.type !== "message") return;
    // Edits/joins/etc. arrive as subtyped messages; bots (including us)
    // carry bot_id. Both are dropped — echo-loop prevention.
    if (event.subtype !== undefined || event.bot_id !== undefined) return;
    if (event.user === undefined || event.user === this.#selfId) return;
    const text = (event.text ?? "").trim();
    if (text.length === 0 || event.channel === undefined) return;

    const isDm = event.channel_type === "im";
    if (!isDm && this.#groupAddressing === "mentions") {
      if (this.#selfId === null || !text.includes(`<@${this.#selfId}>`)) {
        return;
      }
    }

    const cleaned =
      this.#selfId !== null
        ? text.replaceAll(`<@${this.#selfId}>`, "").trim()
        : text;
    if (cleaned.length === 0) return;

    // Threads get their own conversation (and session); replies stay
    // in-thread via the encoded thread_ts.
    const conversationId =
      event.thread_ts !== undefined
        ? `${event.channel}:${event.thread_ts}`
        : event.channel;

    await this.#context.onMessage({
      channelId: this.id,
      sender: { peerId: event.user },
      conversation: { kind: isDm ? "dm" : "group", id: conversationId },
      text: cleaned,
    });
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    const text =
      message.text.length > SLACK_MESSAGE_LIMIT
        ? `${message.text.slice(0, SLACK_MESSAGE_LIMIT)}\n… (truncated)`
        : message.text;
    if (message.editMessageId !== undefined) {
      const target = this.#editTargets.get(message.editMessageId);
      if (target !== undefined) {
        try {
          await this.#transport.updateMessage(target.channel, target.ts, text);
        } catch (error) {
          this.#log(`slack: edit failed: ${String(error)}`);
        }
        return message.editMessageId;
      }
    }
    const parsed = parseSlackConversationId(message.conversationId);
    const sent = await this.#transport.postMessage(
      parsed.channel,
      text,
      parsed.threadTs,
    );
    const handle = `${this.id}-out-${++this.#outCounter}`;
    this.#editTargets.set(handle, { channel: parsed.channel, ts: sent.ts });
    // Bound the map: edit-in-place only ever targets a recent message, so old
    // handles are dead weight. Without this the map grows one entry per send
    // forever (a slow unbounded leak on a long-lived gateway).
    while (this.#editTargets.size > MAX_EDIT_TARGETS) {
      const oldest = this.#editTargets.keys().next().value;
      if (oldest === undefined) break;
      this.#editTargets.delete(oldest);
    }
    return handle;
  }
}
