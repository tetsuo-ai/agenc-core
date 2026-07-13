/**
 * Discord channel adapter (TODO task 9) — official Discord API only.
 *
 * Inbound rides the Discord Gateway (WebSocket): HELLO → IDENTIFY (bot token
 * + GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT intents) → heartbeat
 * loop → MESSAGE_CREATE dispatches. Outbound rides the REST API
 * (create/edit message), so `supportsEdit` streaming coalescing works.
 *
 * The transport (gateway socket + REST) is injected — unit tests drive a
 * scripted fake and never open a network connection; the production
 * transport uses the global `WebSocket` (Node ≥ 22) and `fetch`, zero deps.
 *
 * Mapping:
 *  - DM (no `guild_id`)     → conversation kind "dm", id = channel id.
 *  - Guild message          → kind "group", id = channel id (a thread IS a
 *    channel in Discord, so thread messages get their own conversation and
 *    replies land in-thread automatically). Guild/channel bindings use this
 *    channel id as `groupId`.
 *  - Group addressing defaults to "mentions": only @bot mentions and replies
 *    to the bot reach the agent — never every message in a guild.
 *
 * Security: same posture as every channel — no listener is opened (the
 * gateway socket is outbound), senders go through the gateway pairing/
 * allowlist gate, and message text is untrusted (framed upstream).
 */

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  OutboundChannelMessage,
} from "./types.js";

export const DISCORD_CHANNEL_ID = "discord";

/** Discord hard limit per message. */
export const DISCORD_MESSAGE_LIMIT = 2000;

// Gateway opcodes (the slice we speak).
export const DISCORD_OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const);

/** GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export interface DiscordGatewayPayload {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

export interface DiscordUser {
  readonly id: string;
  readonly username?: string;
  readonly bot?: boolean;
}

export interface DiscordMessageEvent {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author?: DiscordUser;
  readonly content?: string;
  readonly mentions?: readonly DiscordUser[];
  readonly referenced_message?: { readonly author?: DiscordUser } | null;
}

export interface DiscordSocketHandlers {
  onPayload(payload: DiscordGatewayPayload): void;
  onClose(code?: number): void;
}

export interface DiscordSocket {
  send(payload: DiscordGatewayPayload): void;
  close(): void;
}

export interface DiscordTransport {
  /** GET /gateway/bot → wss url (also validates the token). */
  getGatewayUrl(): Promise<string>;
  connect(url: string, handlers: DiscordSocketHandlers): Promise<DiscordSocket>;
  /** POST /channels/{id}/messages */
  createMessage(channelId: string, text: string): Promise<{ id: string }>;
  /** PATCH /channels/{id}/messages/{messageId} */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
}

export class DiscordApiError extends Error {}

const DISCORD_API = "https://discord.com/api/v10";

// Upper bound on retained edit-in-place targets (evicted oldest-first).
const MAX_EDIT_TARGETS = 512;

/** Production transport: fetch REST + global WebSocket, zero dependencies. */
export class FetchDiscordTransport implements DiscordTransport {
  readonly #token: string;

  constructor(options: { readonly token: string }) {
    this.#token = options.token;
  }

  async #rest(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${this.#token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DiscordApiError(
        `discord api ${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 300)}`,
      );
    }
    return response.json();
  }

  async getGatewayUrl(): Promise<string> {
    const result = (await this.#rest("/gateway/bot", { method: "GET" })) as {
      url?: string;
    };
    if (typeof result.url !== "string" || result.url.length === 0) {
      throw new DiscordApiError("discord /gateway/bot returned no url");
    }
    return `${result.url}?v=10&encoding=json`;
  }

  async connect(
    url: string,
    handlers: DiscordSocketHandlers,
  ): Promise<DiscordSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new DiscordApiError("discord gateway connect failed")), { once: true });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        handlers.onPayload(JSON.parse(String(event.data)) as DiscordGatewayPayload);
      } catch {
        // Non-JSON frames are ignored.
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      handlers.onClose(event.code);
    });
    return {
      send: (payload) => socket.send(JSON.stringify(payload)),
      close: () => socket.close(),
    };
  }

  async createMessage(channelId: string, text: string): Promise<{ id: string }> {
    const result = (await this.#rest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    })) as { id?: string };
    if (typeof result.id !== "string") {
      throw new DiscordApiError("discord createMessage returned no id");
    }
    return { id: result.id };
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.#rest(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: text }),
    });
  }
}

export interface DiscordChannelOptions {
  readonly transport: DiscordTransport;
  readonly token: string;
  readonly id?: string;
  readonly log?: (line: string) => void;
  /**
   * In guilds, "mentions" (default) means only @bot mentions and replies to
   * the bot reach the agent. "all" turns every guild message into a turn —
   * broadcast rooms only.
   */
  readonly groupAddressing?: "all" | "mentions";
  /** Bounded backoff between reconnect attempts, ms. */
  readonly reconnectBackoffMs?: number;
  /** Test seam: injectable timers for the heartbeat loop. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Launch the gateway connection on start(). Tests set false and drive
   *  payloads through the fake socket deterministically. */
  readonly autoConnect?: boolean;
}

interface EditTarget {
  readonly channelId: string;
  readonly messageId: string;
}

/** Split text into Discord-sized chunks at line boundaries when possible. */
export function chunkDiscordText(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > DISCORD_MESSAGE_LIMIT) {
    const window = rest.slice(0, DISCORD_MESSAGE_LIMIT);
    const cut = window.lastIndexOf("\n");
    const at = cut > DISCORD_MESSAGE_LIMIT / 2 ? cut : DISCORD_MESSAGE_LIMIT;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = true;
  readonly #transport: DiscordTransport;
  readonly #token: string;
  readonly #log: (line: string) => void;
  readonly #groupAddressing: "all" | "mentions";
  readonly #backoffMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  readonly #autoConnect: boolean;
  readonly #editTargets = new Map<string, EditTarget>();
  #context: ChannelAdapterContext | null = null;
  #socket: DiscordSocket | null = null;
  #running = false;
  #selfId: string | null = null;
  #sequence: number | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingAck = false;
  #outCounter = 0;

  constructor(options: DiscordChannelOptions) {
    this.id = options.id ?? DISCORD_CHANNEL_ID;
    this.#transport = options.transport;
    this.#token = options.token;
    this.#log = options.log ?? (() => {});
    this.#groupAddressing = options.groupAddressing ?? "mentions";
    this.#backoffMs = options.reconnectBackoffMs ?? 2000;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.#autoConnect = options.autoConnect ?? true;
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    this.#running = true;
    if (this.#autoConnect) await this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopHeartbeat();
    this.#socket?.close();
    this.#socket = null;
    this.#context = null;
  }

  async #connect(): Promise<void> {
    const url = await this.#transport.getGatewayUrl();
    this.#socket = await this.#transport.connect(url, {
      onPayload: (payload) => this.handleGatewayPayload(payload),
      onClose: (code) => {
        this.#stopHeartbeat();
        this.#socket = null;
        if (!this.#running) return;
        this.#log(`discord: gateway closed (${code ?? "?"}) — reconnecting`);
        this.#setTimer(() => {
          if (!this.#running) return;
          void this.#connect().catch((error) => {
            this.#log(`discord: reconnect failed: ${String(error)}`);
            this.#scheduleReconnect();
          });
        }, this.#backoffMs);
      },
    });
  }

  #scheduleReconnect(): void {
    if (!this.#running) return;
    this.#setTimer(() => {
      if (!this.#running) return;
      void this.#connect().catch((error) => {
        this.#log(`discord: reconnect failed: ${String(error)}`);
        this.#scheduleReconnect();
      });
    }, this.#backoffMs);
  }

  /** Exposed for deterministic tests (fake socket feeds payloads here). */
  handleGatewayPayload(payload: DiscordGatewayPayload): void {
    if (typeof payload.s === "number") this.#sequence = payload.s;
    switch (payload.op) {
      case DISCORD_OP.HELLO: {
        const interval =
          (payload.d as { heartbeat_interval?: number } | undefined)
            ?.heartbeat_interval ?? 41_250;
        this.#identify();
        this.#startHeartbeat(interval);
        return;
      }
      case DISCORD_OP.HEARTBEAT: {
        // Immediate heartbeat request from the gateway.
        this.#sendHeartbeat();
        return;
      }
      case DISCORD_OP.HEARTBEAT_ACK: {
        this.#awaitingAck = false;
        return;
      }
      case DISCORD_OP.RECONNECT:
      case DISCORD_OP.INVALID_SESSION: {
        this.#log("discord: gateway requested reconnect");
        this.#socket?.close();
        return;
      }
      case DISCORD_OP.DISPATCH: {
        if (payload.t === "READY") {
          const user = (payload.d as { user?: DiscordUser } | undefined)?.user;
          if (user?.id !== undefined) this.#selfId = user.id;
          this.#log("discord: gateway ready");
          return;
        }
        if (payload.t === "MESSAGE_CREATE") {
          void this.#handleMessage(payload.d as DiscordMessageEvent);
        }
        return;
      }
      default:
        return;
    }
  }

  #identify(): void {
    this.#socket?.send({
      op: DISCORD_OP.IDENTIFY,
      d: {
        token: this.#token,
        intents: DISCORD_INTENTS,
        properties: { os: "linux", browser: "agenc", device: "agenc" },
      },
    });
  }

  #startHeartbeat(intervalMs: number): void {
    this.#stopHeartbeat();
    this.#awaitingAck = false;
    const beat = () => {
      if (this.#socket === null) return;
      if (this.#awaitingAck) {
        // Zombied connection: the previous heartbeat was never ACKed.
        this.#log("discord: heartbeat ACK missed — recycling connection");
        this.#socket.close();
        return;
      }
      this.#sendHeartbeat();
      this.#heartbeatTimer = this.#setTimer(beat, intervalMs);
    };
    this.#heartbeatTimer = this.#setTimer(beat, intervalMs);
  }

  #sendHeartbeat(): void {
    this.#awaitingAck = true;
    this.#socket?.send({ op: DISCORD_OP.HEARTBEAT, d: this.#sequence });
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) this.#clearTimer(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#awaitingAck = false;
  }

  async #handleMessage(event: DiscordMessageEvent): Promise<void> {
    if (this.#context === null) return;
    const author = event.author;
    if (author === undefined) return;
    // Never react to bots (including ourselves) — echo-loop prevention.
    if (author.bot === true || author.id === this.#selfId) return;
    const text = (event.content ?? "").trim();
    if (text.length === 0) return;

    const isGuild = event.guild_id !== undefined;
    if (isGuild && this.#groupAddressing === "mentions") {
      const mentioned =
        (this.#selfId !== null &&
          (event.mentions?.some((user) => user.id === this.#selfId) === true ||
            text.includes(`<@${this.#selfId}>`) ||
            text.includes(`<@!${this.#selfId}>`))) ||
        event.referenced_message?.author?.id === this.#selfId;
      if (mentioned !== true) return;
    }

    const cleaned =
      this.#selfId !== null
        ? text
            .replaceAll(`<@${this.#selfId}>`, "")
            .replaceAll(`<@!${this.#selfId}>`, "")
            .trim()
        : text;
    if (cleaned.length === 0) return;

    await this.#context.onMessage({
      channelId: this.id,
      sender: {
        peerId: author.id,
        ...(author.username !== undefined
          ? { displayName: author.username }
          : {}),
      },
      conversation: {
        kind: isGuild ? "group" : "dm",
        // Threads are channels in Discord: thread messages carry the thread's
        // channel id, so replies land in-thread with no extra bookkeeping.
        id: event.channel_id,
      },
      text: cleaned,
    });
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    const chunks = chunkDiscordText(message.text);
    if (message.editMessageId !== undefined) {
      const target = this.#editTargets.get(message.editMessageId);
      if (target !== undefined) {
        try {
          await this.#transport.editMessage(
            target.channelId,
            target.messageId,
            chunks[0],
          );
          // Overflow beyond the edited message goes out as fresh messages —
          // only the final flush is ever this long in practice.
          for (const chunk of chunks.slice(1)) {
            await this.#transport.createMessage(target.channelId, chunk);
          }
        } catch (error) {
          this.#log(`discord: edit failed: ${String(error)}`);
        }
        return message.editMessageId;
      }
    }
    let firstId: string | null = null;
    for (const chunk of chunks) {
      const sent = await this.#transport.createMessage(
        message.conversationId,
        chunk,
      );
      if (firstId === null) firstId = sent.id;
    }
    const handle = `${this.id}-out-${++this.#outCounter}`;
    this.#editTargets.set(handle, {
      channelId: message.conversationId,
      messageId: firstId ?? "",
    });
    // Bound the map (see slack-channel.ts): evict oldest edit targets so it can't
    // grow one entry per send forever.
    while (this.#editTargets.size > MAX_EDIT_TARGETS) {
      const oldest = this.#editTargets.keys().next().value;
      if (oldest === undefined) break;
      this.#editTargets.delete(oldest);
    }
    return handle;
  }
}
