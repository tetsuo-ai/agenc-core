/**
 * Telegram channel adapter (TODO task 7).
 *
 * Official Bot API (https://core.telegram.org/bots/api) via long polling —
 * no reverse-engineered client, no account-ban risk. Streaming replies use
 * editMessageText so a turn updates one message in place (`supportsEdit`).
 * A reply longer than one Telegram message continues in follow-up messages.
 *
 * The HTTP transport is injectable so the adapter logic is unit-tested
 * against a fake Bot API. The production transport uses global fetch (Node
 * 25); no HTTP dependency.
 *
 * Inbound updates are handed to the gateway without waiting for the agent
 * turn: one conversation (chat + topic) is handled in arrival order, different
 * conversations run side by side up to a fixed limit, and a private-chat
 * command such as the owner's /stop is never held behind running turns.
 */

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types.js";

export const TELEGRAM_CHANNEL_ID = "telegram";

// ---- Bot API transport ----------------------------------------------------

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly channel_post?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly edited_channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  readonly date?: number;
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly from?: {
    readonly id: number;
    readonly is_bot?: boolean;
    readonly username?: string;
    readonly first_name?: string;
  };
  readonly sender_chat?: {
    readonly id: number;
    readonly type: string;
    readonly username?: string;
    readonly title?: string;
  };
  readonly chat: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption?: string;
  readonly caption_entities?: readonly TelegramMessageEntity[];
  readonly reply_to_message?: {
    readonly text?: string;
    readonly caption?: string;
    readonly from?: {
      readonly id: number;
      readonly is_bot?: boolean;
      readonly username?: string;
      readonly first_name?: string;
    };
    readonly sender_chat?: {
      readonly id: number;
      readonly type: string;
      readonly username?: string;
      readonly title?: string;
    };
  };
}

export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly user?: {
    readonly id: number;
    readonly is_bot?: boolean;
    readonly username?: string;
    readonly first_name?: string;
  };
}

export interface TelegramSentMessage {
  readonly message_id: number;
}

export interface TelegramBotIdentity {
  readonly id: number;
  readonly username?: string;
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramBotCommandScope {
  readonly type: string;
  readonly chat_id?: string | number;
}

export interface TelegramSendOptions {
  readonly messageThreadId?: number;
  readonly parseMode?: "HTML";
}

export interface TelegramRichMessageOptions {
  readonly messageThreadId?: number;
  readonly skipEntityDetection?: boolean;
}

export type TelegramRichMessageMode = "all" | "private" | "off";

export interface TelegramAudioOptions extends TelegramSendOptions {
  readonly caption?: string;
  readonly contentType?: string;
  readonly fileName?: string;
  readonly title?: string;
  readonly performer?: string;
}

export interface TelegramCommandMenu {
  readonly commands: readonly TelegramBotCommand[];
  readonly scope: TelegramBotCommandScope;
}

/** The slice of the Bot API the adapter uses. */
export interface TelegramTransport {
  getMe?(): Promise<TelegramBotIdentity>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSentMessage>;
  sendRichMessage?(
    chatId: string,
    markdown: string,
    options?: TelegramRichMessageOptions,
  ): Promise<TelegramSentMessage>;
  setMyCommands?(
    commands: readonly TelegramBotCommand[],
    scope?: TelegramBotCommandScope,
  ): Promise<void>;
  sendPhoto?(
    chatId: string,
    photoUrl: string,
    caption?: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSentMessage>;
  sendAudio?(
    chatId: string,
    audioBytes: Uint8Array,
    options?: TelegramAudioOptions,
  ): Promise<TelegramSentMessage>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<void>;
  editRichMessage?(
    chatId: string,
    messageId: number,
    markdown: string,
    options?: TelegramRichMessageOptions,
  ): Promise<void>;
}

interface BotApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: number };
}

export class TelegramBotApiError extends Error {
  /** Bot API `error_code`, for example 429, when the API reported one. */
  readonly errorCode?: number;
  /** Bot API `parameters.retry_after`: seconds to wait after a flood limit. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    details: {
      readonly errorCode?: number;
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    if (details.errorCode !== undefined) this.errorCode = details.errorCode;
    if (details.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = details.retryAfterSeconds;
    }
  }
}

function telegramBotApiError<T>(
  method: string,
  json: BotApiResponse<T>,
  status: number,
): TelegramBotApiError {
  const retryAfter = json.parameters?.retry_after;
  return new TelegramBotApiError(
    `Telegram ${method} failed: ${json.description ?? status}`,
    {
      ...(typeof json.error_code === "number"
        ? { errorCode: json.error_code }
        : {}),
      ...(typeof retryAfter === "number"
        ? { retryAfterSeconds: retryAfter }
        : {}),
    },
  );
}

/** Production transport over the official Bot API using global fetch. */
export class FetchTelegramTransport implements TelegramTransport {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly token: string; readonly fetchImpl?: typeof fetch }) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(options.token)) {
      throw new TelegramBotApiError("invalid Telegram bot token format");
    }
    this.#base = `https://api.telegram.org/bot${options.token}`;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(`${this.#base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as BotApiResponse<T>;
    if (!json.ok) throw telegramBotApiError(method, json, res.status);
    return json.result as T;
  }

  async #callMultipart<T>(
    method: string,
    fields: Record<string, string | number | undefined>,
    files: readonly {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly contentType: string;
    }[],
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, String(value));
    }
    for (const file of files) {
      const bytes = new ArrayBuffer(file.bytes.byteLength);
      new Uint8Array(bytes).set(file.bytes);
      form.append(
        file.name,
        new Blob([bytes], { type: file.contentType }),
        file.fileName,
      );
    }
    const res = await this.#fetch(`${this.#base}/${method}`, {
      method: "POST",
      body: form,
    });
    const json = (await res.json()) as BotApiResponse<T>;
    if (!json.ok) throw telegramBotApiError(method, json, res.status);
    return json.result as T;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: [
        "message",
        "channel_post",
        "edited_message",
        "edited_channel_post",
      ],
    });
  }

  async getMe(): Promise<TelegramBotIdentity> {
    return this.#call<TelegramBotIdentity>("getMe", {});
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendOptions = {},
  ): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
      ...(options.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
    });
  }

  async sendRichMessage(
    chatId: string,
    markdown: string,
    options: TelegramRichMessageOptions = {},
  ): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendRichMessage", {
      chat_id: chatId,
      rich_message: {
        markdown,
        ...(options.skipEntityDetection === true
          ? { skip_entity_detection: true }
          : {}),
      },
      ...(options.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
    });
  }

  async setMyCommands(
    commands: readonly TelegramBotCommand[],
    scope?: TelegramBotCommandScope,
  ): Promise<void> {
    await this.#call("setMyCommands", {
      commands,
      ...(scope !== undefined ? { scope } : {}),
    });
  }

  async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption?: string,
    options: TelegramSendOptions = {},
  ): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      ...(options.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
      ...(caption !== undefined && caption.length > 0
        ? { caption: caption.slice(0, 1024) }
        : {}),
    });
  }

  async sendAudio(
    chatId: string,
    audioBytes: Uint8Array,
    options: TelegramAudioOptions = {},
  ): Promise<TelegramSentMessage> {
    return this.#callMultipart<TelegramSentMessage>(
      "sendAudio",
      {
        chat_id: chatId,
        ...(options.messageThreadId !== undefined
          ? { message_thread_id: options.messageThreadId }
          : {}),
        ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
        ...(options.caption !== undefined && options.caption.length > 0
          ? { caption: options.caption.slice(0, 1024) }
          : {}),
        ...(options.title !== undefined && options.title.length > 0
          ? { title: options.title.slice(0, 64) }
          : {}),
        ...(options.performer !== undefined && options.performer.length > 0
          ? { performer: options.performer.slice(0, 64) }
          : {}),
      },
      [
        {
          name: "audio",
          bytes: audioBytes,
          fileName: options.fileName ?? "agenc-audio.mp3",
          contentType: options.contentType ?? "audio/mpeg",
        },
      ],
    );
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramSendOptions = {},
  ): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
    });
  }

  async editRichMessage(
    chatId: string,
    messageId: number,
    markdown: string,
    options: TelegramRichMessageOptions = {},
  ): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      rich_message: {
        markdown,
        ...(options.skipEntityDetection === true
          ? { skip_entity_detection: true }
          : {}),
      },
      ...(options.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
    });
  }
}

// ---- adapter --------------------------------------------------------------

export interface TelegramChannelOptions {
  readonly transport: TelegramTransport;
  readonly id?: string;
  readonly pollTimeoutSeconds?: number;
  /** Bounded backoff after a transport error, ms. */
  readonly errorBackoffMs?: number;
  readonly log?: (line: string) => void;
  readonly commands?: readonly TelegramBotCommand[];
  readonly commandMenus?: readonly TelegramCommandMenu[];
  /** Log sanitized inbound update routing metadata, never raw text or ids. */
  readonly debugUpdates?: boolean;
  /**
   * In groups, "mentions" means only slash commands, @bot mentions, and
   * replies to this bot reach the agent. Use "all" for broadcast rooms.
   */
  readonly groupAddressing?: "all" | "mentions";
  /** Optional bot username override, without @. */
  readonly botUsername?: string;
  /**
   * Telegram Rich Messages are still rolling out across clients. "private"
   * keeps the richer DM experience while avoiding unsupported-message banners
   * in public groups. Default: "private".
   */
  readonly richMessages?: TelegramRichMessageMode;
  /**
   * Launch the background long-poll loop on start(). Default true. Tests set
   * false to drive pollOnce() deterministically without a competing loop.
   */
  readonly autoPoll?: boolean;
  /**
   * Most update handlers (agent turns) running at the same time. Commands
   * from a private chat are not counted. Default 4.
   */
  readonly maxConcurrentUpdates?: number;
  /**
   * Most accepted updates waiting for a free handler or for an earlier update
   * of their own conversation. When full, the newest update is dropped with
   * one log line and no reply. Default 100.
   */
  readonly maxQueuedUpdates?: number;
  /** Test seam: the wait before the one retry of a rate-limited final edit. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_CONCURRENT_UPDATES = 4;
const DEFAULT_MAX_QUEUED_UPDATES = 100;

/** An update that passed addressing and is waiting for, or running, its handler. */
interface PendingUpdate {
  readonly updateId: number;
  readonly message: InboundChannelMessage;
}

// Upper bound on retained edit-in-place targets (evicted oldest-first).
const MAX_EDIT_TARGETS = 512;

/** Bot API limit on the text of sendMessage and editMessageText. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/**
 * Most raw text per message when a reply has to be split. The HTML rendering
 * escapes characters and pads tables, so the raw text is cut with room to
 * grow; a piece whose rendering is still too long is cut shorter.
 */
const TELEGRAM_PART_BUDGET = 3600;
/**
 * Most raw text that is rendered as a whole to see whether it fits one
 * message. Longer text is cut without that check: only heavy padding in a
 * table could make it fit, and rendering all that is left once per part would
 * be quadratic work on a long reply.
 */
const TELEGRAM_WHOLE_FIT_CHECK = 2 * TELEGRAM_MESSAGE_LIMIT;
/** Longest wait before the one retry of a rate-limited final edit. */
const TELEGRAM_MAX_RETRY_WAIT_MS = 10_000;
/** Wait used when a flood-limit error names no retry_after. */
const TELEGRAM_DEFAULT_RETRY_WAIT_MS = 1_000;

/** The share of a reply that goes into one Telegram message. */
export interface TelegramTextPart {
  /** Raw Markdown of this part; Rich Messages receive it as is. */
  readonly markdown: string;
  /** Its HTML rendering, for sendMessage and editMessageText. */
  readonly html: string;
}

/** One Telegram message that carries part of a reply. */
interface DeliveredPart {
  readonly messageId: number;
  /** Raw text the message shows now; an edit to the same text is skipped. */
  markdown: string;
}

/** What an edit handle points at: the messages of one reply, in reading order. */
interface EditTarget {
  readonly chatId: string;
  readonly messageThreadId?: number;
  readonly messages: DeliveredPart[];
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = true;
  readonly #transport: TelegramTransport;
  readonly #pollTimeout: number;
  readonly #backoffMs: number;
  readonly #log: (line: string) => void;
  readonly #autoPoll: boolean;
  readonly #commandMenus: readonly TelegramCommandMenu[];
  readonly #debugUpdates: boolean;
  readonly #groupAddressing: "all" | "mentions";
  readonly #richMessages: TelegramRichMessageMode;
  readonly #maxConcurrentUpdates: number;
  readonly #maxQueuedUpdates: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #editTargets = new Map<string, EditTarget>();
  /** Accepted updates that could not start yet, oldest first. */
  readonly #waitingUpdates: PendingUpdate[] = [];
  /** Conversations whose handler holds one of the counted slots. */
  readonly #busyConversations = new Set<string>();
  /** Every handler still running, private-chat commands included. */
  readonly #handlers = new Set<Promise<void>>();
  #botIdentity: TelegramBotIdentity | null = null;
  #context: ChannelAdapterContext | null = null;
  #offset = 0;
  #running = false;
  #stopped = false;
  #loop: Promise<void> | null = null;
  #outCounter = 0;

  constructor(options: TelegramChannelOptions) {
    this.id = options.id ?? TELEGRAM_CHANNEL_ID;
    this.#transport = options.transport;
    this.#pollTimeout = options.pollTimeoutSeconds ?? 30;
    this.#backoffMs = options.errorBackoffMs ?? 1000;
    this.#log = options.log ?? (() => {});
    this.#autoPoll = options.autoPoll ?? true;
    this.#commandMenus =
      options.commandMenus ??
      (options.commands !== undefined
        ? [
            { commands: options.commands, scope: { type: "all_private_chats" } },
            { commands: options.commands, scope: { type: "all_group_chats" } },
          ]
        : []);
    this.#debugUpdates = options.debugUpdates ?? false;
    this.#groupAddressing = options.groupAddressing ?? "all";
    this.#richMessages = options.richMessages ?? "private";
    this.#maxConcurrentUpdates = countOption(
      options.maxConcurrentUpdates,
      DEFAULT_MAX_CONCURRENT_UPDATES,
      1,
    );
    this.#maxQueuedUpdates = countOption(
      options.maxQueuedUpdates,
      DEFAULT_MAX_QUEUED_UPDATES,
      0,
    );
    this.#sleep = options.sleep ?? sleepDefault;
    const configuredBotUsername = options.botUsername?.trim().replace(/^@/, "");
    if (configuredBotUsername !== undefined && configuredBotUsername.length > 0) {
      this.#botIdentity = { id: -1, username: configuredBotUsername };
    }
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    this.#stopped = false;
    await this.#resolveBotIdentity();
    await this.#installCommands();
    if (this.#autoPoll) {
      this.#running = true;
      this.#loop = this.#pollLoop();
    }
  }

  /**
   * Stop polling, drop the updates that have not started, and wait for the
   * handlers that are running.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    const dropped = this.#waitingUpdates.splice(0).length;
    if (dropped > 0) {
      this.#log(`telegram: stop dropped ${dropped} waiting update(s)`);
    }
    await this.#loop?.catch(() => {});
    this.#loop = null;
    await this.whenIdle();
    this.#context = null;
  }

  /**
   * Run one long-poll iteration; exposed for deterministic tests. Resolves
   * once the batch is handed over, not when its turns finish: await
   * whenIdle() for that.
   */
  async pollOnce(): Promise<void> {
    const updates = await this.#transport.getUpdates(
      this.#offset,
      this.#pollTimeout,
    );
    // stop() ran while this request was in flight. The offset stays put, so
    // Telegram delivers the batch again after the next start.
    if (this.#stopped) return;
    for (const update of updates) {
      // The offset moves exactly once per update, in arrival order, before
      // anything can go wrong with it: a failing update is never fetched twice.
      this.#offset = Math.max(this.#offset, update.update_id + 1);
      try {
        this.#acceptUpdate(update);
      } catch (error) {
        this.#log(
          `telegram: update ${update.update_id} skipped: ${String(error)}`,
        );
      }
    }
  }

  /** Resolves once no update is waiting or being handled. */
  async whenIdle(): Promise<void> {
    // A finished handler may start a waiting one, so look again after each wait.
    while (this.#handlers.size > 0) {
      await Promise.all(this.#handlers);
    }
  }

  async #installCommands(): Promise<void> {
    if (
      this.#commandMenus.length === 0 ||
      this.#transport.setMyCommands === undefined
    ) {
      return;
    }
    try {
      for (const menu of this.#commandMenus) {
        await this.#transport.setMyCommands(menu.commands, menu.scope);
      }
    } catch (error) {
      this.#log(`telegram: command menu setup failed: ${String(error)}`);
    }
  }

  async #resolveBotIdentity(): Promise<void> {
    if (
      this.#groupAddressing !== "mentions" ||
      this.#transport.getMe === undefined
    ) {
      return;
    }
    try {
      const configuredUsername = this.#botIdentity?.username;
      const resolved = await this.#transport.getMe();
      this.#botIdentity = {
        id: resolved.id,
        ...(resolved.username !== undefined
          ? { username: resolved.username }
          : configuredUsername !== undefined
            ? { username: configuredUsername }
            : {}),
      };
      if (this.#debugUpdates) {
        this.#log(
          [
            "telegram: bot identity resolved",
            `idResolved=${resolved.id > 0}`,
            `hasUsername=${this.#botIdentity.username !== undefined}`,
          ].join(" "),
        );
      }
    } catch (error) {
      this.#log(`telegram: getMe failed: ${String(error)}`);
    }
  }

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.#log(`telegram: poll error: ${String(error)}`);
        await new Promise((r) => setTimeout(r, this.#backoffMs));
      }
    }
  }

  /** Route one update: ignore it, run it now, queue it, or drop it. */
  #acceptUpdate(update: TelegramUpdate): void {
    const inbound = this.#inboundFromUpdate(update);
    if (inbound === null) return;
    const pending: PendingUpdate = {
      updateId: update.update_id,
      message: inbound.message,
    };
    if (inbound.control) {
      // Owner controls such as /stop exist to interrupt running work, so a
      // private-chat command skips the limit, the queue and its own
      // conversation's order.
      this.#runUpdate(pending, "control");
      return;
    }
    if (this.#canRunNow(pending)) {
      this.#runUpdate(pending, "counted");
      return;
    }
    if (this.#waitingUpdates.length >= this.#maxQueuedUpdates) {
      this.#log(
        `telegram: update queue full (${this.#maxQueuedUpdates} waiting), dropped update ${pending.updateId}`,
      );
      return;
    }
    this.#waitingUpdates.push(pending);
  }

  #canRunNow(pending: PendingUpdate): boolean {
    return (
      this.#busyConversations.size < this.#maxConcurrentUpdates &&
      !this.#busyConversations.has(pending.message.conversation.id)
    );
  }

  /**
   * Hand one update to the gateway without awaiting the turn. A "counted"
   * handler holds its conversation and one of the limited slots until it
   * settles; a "control" handler holds neither.
   */
  #runUpdate(pending: PendingUpdate, lane: "counted" | "control"): void {
    const context = this.#context;
    if (context === null) return;
    const conversationId = pending.message.conversation.id;
    if (lane === "counted") this.#busyConversations.add(conversationId);
    const handler: Promise<void> = Promise.resolve()
      .then(() => context.onMessage(pending.message))
      .catch((error: unknown) => {
        this.#log(
          `telegram: update ${pending.updateId} handler failed: ${String(error)}`,
        );
      })
      // Whatever happened above, even a throwing logger, the slot is returned.
      .catch(() => {})
      .then(() => {
        this.#handlers.delete(handler);
        if (lane === "counted") {
          this.#busyConversations.delete(conversationId);
          this.#startWaitingUpdates();
        }
      });
    this.#handlers.add(handler);
  }

  /**
   * Start the waiting updates that now have a free slot and an idle
   * conversation. Scanning oldest first keeps one conversation in arrival
   * order while a busy conversation never holds back the others.
   */
  #startWaitingUpdates(): void {
    let index = 0;
    while (
      index < this.#waitingUpdates.length &&
      this.#busyConversations.size < this.#maxConcurrentUpdates
    ) {
      const pending = this.#waitingUpdates[index];
      if (this.#busyConversations.has(pending.message.conversation.id)) {
        index += 1;
        continue;
      }
      this.#waitingUpdates.splice(index, 1);
      this.#runUpdate(pending, "counted");
    }
  }

  /** Map an update to the gateway's inbound shape, or null to ignore it. */
  #inboundFromUpdate(
    update: TelegramUpdate,
  ): { readonly message: InboundChannelMessage; readonly control: boolean } | null {
    const updateKind = telegramUpdateKind(update);
    const message =
      update.message ??
      update.channel_post ??
      update.edited_message ??
      update.edited_channel_post;
    const rawText = message?.text ?? message?.caption;
    this.#debugUpdate(updateKind, message, rawText);
    if (
      this.#context === null ||
      message === undefined ||
      rawText === undefined
    ) {
      return null;
    }
    const sender = message.from;
    const senderChat = message.sender_chat;
    if (sender === undefined && senderChat === undefined) {
      return null;
    }
    const peerId = String(sender?.id ?? senderChat?.id);
    const chatId = String(message.chat.id);
    const isPrivate = message.chat.type === "private";
    const conversationId = telegramConversationId(
      chatId,
      isPrivate ? undefined : message.message_thread_id,
    );
    const text = this.#normalizedTextForAddressing(rawText, message);
    if (text === null) return null;
    return {
      control: isPrivate && text.trimStart().startsWith("/"),
      message: {
        channelId: this.id,
        sender: {
          peerId,
          ...(sender?.username !== undefined
            ? { displayName: sender.username }
            : sender?.first_name !== undefined
              ? { displayName: sender.first_name }
              : senderChat?.username !== undefined
                ? { displayName: senderChat.username }
                : senderChat?.title !== undefined
                  ? { displayName: senderChat.title }
                  : {}),
        },
        conversation: { kind: isPrivate ? "dm" : "group", id: conversationId },
        text,
      },
    };
  }

  #debugUpdate(
    updateKind: string,
    message: TelegramMessage | undefined,
    rawText: string | undefined,
  ): void {
    if (!this.#debugUpdates) return;
    const entities =
      rawText !== undefined && message !== undefined
        ? telegramEntitiesForText(message, rawText)
        : [];
    const username = this.#botIdentity?.username?.toLowerCase();
    const normalizedText = rawText?.toLowerCase();
    const hasMention =
      rawText !== undefined &&
      message !== undefined &&
      telegramMentionsBot(rawText, message, this.#botIdentity);
    const isCommand = rawText?.trimStart().startsWith("/") ?? false;
    this.#log(
      [
        "telegram: update",
        `kind=${updateKind}`,
        `chatType=${message?.chat.type ?? "none"}`,
        `hasText=${message?.text !== undefined}`,
        `hasCaption=${message?.caption !== undefined}`,
        `hasFrom=${message?.from !== undefined}`,
        `hasSenderChat=${message?.sender_chat !== undefined}`,
        `isCommand=${isCommand}`,
        `mentionsBot=${hasMention}`,
        `botIdResolved=${(this.#botIdentity?.id ?? -1) > 0}`,
        `entityTypes=${entities.map((entity) => entity.type).join(",") || "none"}`,
        `startsWithAt=${rawText?.trimStart().startsWith("@") ?? false}`,
        `containsBotUsername=${
          username !== undefined && normalizedText !== undefined
            ? normalizedText.includes(`@${username}`)
            : false
        }`,
      ].join(" "),
    );
  }

  #normalizedTextForAddressing(
    text: string,
    message: TelegramMessage,
  ): string | null {
    const isPrivate = message.chat.type === "private";
    if (isPrivate || this.#groupAddressing === "all") return text;
    if (text.trimStart().startsWith("/")) return text;

    const username = this.#botIdentity?.username;
    if (telegramMentionsBot(text, message, this.#botIdentity)) {
      const stripped = stripTelegramBotMentions(
        text,
        message,
        this.#botIdentity,
      );
      return withTelegramReplyContext(
        message,
        stripped.length > 0
          ? stripped
          : "User mentioned the bot while replying to this message.",
      );
    }

    const replyFrom = message.reply_to_message?.from;
    if (
      replyFrom !== undefined &&
      (replyFrom.id === this.#botIdentity?.id ||
        (username !== undefined &&
          replyFrom.username?.toLowerCase() === username.toLowerCase()))
    ) {
      return text;
    }
    return null;
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    if (message.editMessageId !== undefined) {
      const reply = this.#editTargets.get(message.editMessageId);
      if (reply !== undefined) {
        await this.#editReply(reply, message.text, message.final === true);
        return message.editMessageId;
      }
    }
    // Conversation id is Telegram chat id, optionally suffixed with the forum
    // topic thread id. Replies must stay in-topic or users never see them.
    const reply: EditTarget = {
      ...parseTelegramConversationId(message.conversationId),
      messages: [],
    };
    const sendOptions = telegramHtmlOptions(reply.messageThreadId);
    if (
      message.audioBytes !== undefined &&
      this.#transport.sendAudio !== undefined
    ) {
      const sent = await this.#transport.sendAudio(
        reply.chatId,
        message.audioBytes,
        {
          ...sendOptions,
          caption: telegramRichText(message.caption ?? message.text),
          ...(message.audioFileName !== undefined
            ? { fileName: message.audioFileName }
            : {}),
          ...(message.audioContentType !== undefined
            ? { contentType: message.audioContentType }
            : {}),
          ...(message.audioTitle !== undefined
            ? { title: message.audioTitle }
            : {}),
          ...(message.audioPerformer !== undefined
            ? { performer: message.audioPerformer }
            : {}),
        },
      );
      reply.messages.push({
        messageId: sent.message_id,
        markdown: message.caption ?? message.text,
      });
    } else if (
      message.photoUrl !== undefined &&
      this.#transport.sendPhoto !== undefined
    ) {
      const sent = await this.#transport.sendPhoto(
        reply.chatId,
        message.photoUrl,
        telegramRichText(message.caption ?? message.text),
        sendOptions,
      );
      reply.messages.push({
        messageId: sent.message_id,
        markdown: message.caption ?? message.text,
      });
    } else {
      // One Telegram message per part, in reading order.
      for (const part of splitTelegramText(message.text)) {
        reply.messages.push(await this.#sendPart(reply, part));
      }
    }
    const handle = `${this.id}-out-${++this.#outCounter}`;
    this.#editTargets.set(handle, reply);
    // Bound the map (see slack-channel.ts): evict oldest edit targets.
    while (this.#editTargets.size > MAX_EDIT_TARGETS) {
      const oldest = this.#editTargets.keys().next().value;
      if (oldest === undefined) break;
      this.#editTargets.delete(oldest);
    }
    return handle;
  }

  /**
   * Bring an already sent reply up to `text`: edit the messages whose part
   * changed, send parts that have no message yet as follow-ups in the same
   * thread, and never delete a message.
   *
   * A streaming edit is best effort, because the next edit carries newer
   * text: a failure is logged and skipped. The final edit must land: a
   * rate-limited edit is retried once, and if it still fails the text from
   * that part on is sent as new messages. Only when that fails too does the
   * error reach the caller, which records the turn as not delivered.
   */
  async #editReply(
    reply: EditTarget,
    text: string,
    final: boolean,
  ): Promise<void> {
    const parts = splitTelegramText(text);
    for (const [index, part] of parts.entries()) {
      const delivered = reply.messages[index];
      if (delivered === undefined) {
        try {
          reply.messages.push(await this.#sendPart(reply, part));
        } catch (error) {
          if (final) throw error;
          // Stop here so the parts stay in order; the next edit sends them.
          this.#log(`telegram: follow-up skipped: ${String(error)}`);
          return;
        }
        continue;
      }
      if (delivered.markdown === part.markdown) continue;
      try {
        if (final) {
          await this.#editPartOrRetry(reply, delivered.messageId, part);
        } else {
          await this.#editPart(reply, delivered.messageId, part);
        }
        delivered.markdown = part.markdown;
      } catch (error) {
        if (!final) {
          this.#log(`telegram: edit skipped: ${String(error)}`);
          continue;
        }
        this.#log(
          `telegram: final edit failed, sending the rest as new messages: ${String(error)}`,
        );
        const resent: DeliveredPart[] = [];
        for (const rest of parts.slice(index)) {
          resent.push(await this.#sendPart(reply, rest));
        }
        // The messages that could not be edited stay in the chat as they are;
        // the handle now points at the ones that carry the final text.
        reply.messages.splice(index, reply.messages.length - index, ...resent);
        return;
      }
    }
  }

  /** Send one part as a new message: Rich Messages first where enabled. */
  async #sendPart(
    reply: EditTarget,
    part: TelegramTextPart,
  ): Promise<DeliveredPart> {
    const sent = await sendTelegramTextMessage(
      this.#transport,
      reply.chatId,
      part.markdown,
      part.html,
      telegramRichOptions(reply.messageThreadId),
      telegramHtmlOptions(reply.messageThreadId),
      this.#log,
      shouldUseTelegramRichMessages(this.#richMessages, reply.chatId),
    );
    return { messageId: sent.message_id, markdown: part.markdown };
  }

  /** Edit one message to one part. Throws unless the message now shows it. */
  async #editPart(
    reply: EditTarget,
    messageId: number,
    part: TelegramTextPart,
  ): Promise<void> {
    if (
      shouldUseTelegramRichMessages(this.#richMessages, reply.chatId) &&
      this.#transport.editRichMessage !== undefined
    ) {
      try {
        await this.#transport.editRichMessage(
          reply.chatId,
          messageId,
          part.markdown,
          telegramRichOptions(reply.messageThreadId),
        );
        return;
      } catch (error) {
        if (isTelegramNoopEdit(error)) return;
        this.#log(`telegram: rich edit fallback: ${String(error)}`);
      }
    }
    try {
      await this.#transport.editMessageText(
        reply.chatId,
        messageId,
        part.html,
        telegramHtmlOptions(reply.messageThreadId),
      );
    } catch (error) {
      // Telegram rejects an edit that changes nothing ("message is not
      // modified"). The message already shows this text, so that is success;
      // every other rejection is a real failure.
      if (!isTelegramNoopEdit(error)) throw error;
    }
  }

  /** The final edit of one message: wait out a flood limit and retry once. */
  async #editPartOrRetry(
    reply: EditTarget,
    messageId: number,
    part: TelegramTextPart,
  ): Promise<void> {
    try {
      await this.#editPart(reply, messageId, part);
    } catch (error) {
      const waitMs = telegramRetryWaitMs(error);
      if (waitMs === null) throw error;
      this.#log(`telegram: final edit rate limited, retrying in ${waitMs} ms`);
      await this.#sleep(waitMs);
      await this.#editPart(reply, messageId, part);
    }
  }
}

/** A count option: the fallback when unset or NaN, never below `minimum`. */
function countOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function telegramMentionsBot(
  text: string,
  message: TelegramMessage,
  identity: TelegramBotIdentity | null | undefined,
): boolean {
  return telegramBotMentionRanges(text, message, identity).length > 0;
}

function stripTelegramBotMentions(
  text: string,
  message: TelegramMessage,
  identity: TelegramBotIdentity | null | undefined,
): string {
  const ranges = telegramBotMentionRanges(text, message, identity);
  if (ranges.length === 0) return text.trim();
  let stripped = text;
  for (const range of [...ranges].sort((a, b) => b.offset - a.offset)) {
    stripped =
      stripped.slice(0, range.offset) +
      " " +
      stripped.slice(range.offset + range.length);
  }
  return stripped.replace(/\s+/g, " ").trim();
}

function telegramBotMentionRanges(
  text: string,
  message: TelegramMessage,
  identity: TelegramBotIdentity | null | undefined,
): Array<{ offset: number; length: number }> {
  if (identity == null) return [];
  const ranges: Array<{ offset: number; length: number }> = [];
  const username = identity.username?.toLowerCase();
  const entities = telegramEntitiesForText(message, text);
  for (const entity of entities) {
    if (!isValidTelegramEntityRange(text, entity)) continue;
    if (entity.type === "text_mention") {
      const mentionedUsername = entity.user?.username?.toLowerCase();
      if (
        entity.user?.id === identity.id ||
        (username !== undefined && mentionedUsername === username)
      ) {
        ranges.push({ offset: entity.offset, length: entity.length });
      }
      continue;
    }
    if (entity.type !== "mention" || username === undefined) continue;
    const mentionText = text
      .slice(entity.offset, entity.offset + entity.length)
      .toLowerCase();
    if (mentionText === `@${username}`) {
      ranges.push({ offset: entity.offset, length: entity.length });
    }
  }
  if (ranges.length > 0 || username === undefined || username.length === 0) {
    return ranges;
  }

  const mention = new RegExp(
    `@${escapeRegExp(username)}(?=$|[^A-Za-z0-9_])`,
    "gi",
  );
  for (const match of text.matchAll(mention)) {
    const offset = match.index ?? -1;
    if (offset < 0) continue;
    const before = offset === 0 ? "" : text[offset - 1];
    if (before !== "" && /[A-Za-z0-9_]/.test(before)) continue;
    ranges.push({ offset, length: match[0].length });
  }
  return ranges;
}

function telegramEntitiesForText(
  message: TelegramMessage,
  text: string,
): readonly TelegramMessageEntity[] {
  if (message.text === text) return message.entities ?? [];
  if (message.caption === text) return message.caption_entities ?? [];
  return [];
}

function isValidTelegramEntityRange(
  text: string,
  entity: TelegramMessageEntity,
): boolean {
  return (
    Number.isInteger(entity.offset) &&
    Number.isInteger(entity.length) &&
    entity.offset >= 0 &&
    entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
}

async function sendTelegramTextMessage(
  transport: TelegramTransport,
  chatId: string,
  markdown: string,
  fallbackHtml: string,
  richOptions: TelegramRichMessageOptions,
  fallbackOptions: TelegramSendOptions,
  log: (line: string) => void,
  useRichMessages: boolean,
): Promise<TelegramSentMessage> {
  if (useRichMessages && transport.sendRichMessage !== undefined) {
    try {
      return await transport.sendRichMessage(chatId, markdown, richOptions);
    } catch (error) {
      log(`telegram: rich send fallback: ${String(error)}`);
    }
  }
  return transport.sendMessage(chatId, fallbackHtml, fallbackOptions);
}

function isTelegramNoopEdit(error: unknown): boolean {
  return /message is not modified/i.test(String(error));
}

/**
 * How long to wait before retrying after a flood limit (Bot API error 429),
 * capped, or null when the error is something else.
 */
function telegramRetryWaitMs(error: unknown): number | null {
  if (!(error instanceof TelegramBotApiError) || error.errorCode !== 429) {
    return null;
  }
  if (error.retryAfterSeconds === undefined) {
    return TELEGRAM_DEFAULT_RETRY_WAIT_MS;
  }
  return Math.min(
    Math.max(error.retryAfterSeconds, 0) * 1000,
    TELEGRAM_MAX_RETRY_WAIT_MS,
  );
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramRichOptions(
  messageThreadId: number | undefined,
): TelegramRichMessageOptions {
  return {
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    skipEntityDetection: true,
  };
}

function telegramHtmlOptions(
  messageThreadId: number | undefined,
): TelegramSendOptions {
  return {
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    parseMode: "HTML",
  };
}

function fitsTelegramMessage(html: string): boolean {
  return html.length <= TELEGRAM_MESSAGE_LIMIT;
}

/**
 * Split a reply into parts that each fit one Telegram message. A reply whose
 * rendering already fits stays one part.
 *
 * The raw text is cut, not the HTML, and each part is rendered on its own, so
 * every part is valid HTML whatever the cut went through. A part is the
 * longest start of the remaining text that stays within the raw budget and
 * whose rendering fits, ended at a line break where possible.
 *
 * A cut depends only on the text before it. While a streamed reply grows,
 * its earlier parts therefore stay the same and only the last one changes,
 * so their messages need no further edit.
 */
export function splitTelegramText(text: string): TelegramTextPart[] {
  const parts: TelegramTextPart[] = [];
  let rest = text;
  for (;;) {
    if (rest.length <= TELEGRAM_WHOLE_FIT_CHECK) {
      const html = telegramRichText(rest);
      if (fitsTelegramMessage(html)) {
        // Blank space left over after a cut is not worth a message. A reply
        // that is blank altogether is passed on for Telegram to refuse.
        if (rest.trim().length > 0 || parts.length === 0) {
          parts.push({ markdown: rest, html });
        }
        return parts;
      }
    }
    const taken = takeTelegramPart(rest);
    if (taken.markdown.length > 0) {
      parts.push({ markdown: taken.markdown, html: taken.html });
    }
    rest = rest.slice(taken.next);
  }
}

/**
 * The next part of text that does not fit one message, and where the text
 * goes on after it.
 */
function takeTelegramPart(text: string): {
  readonly markdown: string;
  readonly html: string;
  readonly next: number;
} {
  const limit = telegramFittingLength(text);
  const cut = telegramCut(text, limit);
  const markdown = text.slice(0, cut.end).trimEnd();
  const html = telegramRichText(markdown);
  if (fitsTelegramMessage(html)) return { markdown, html, next: cut.next };
  // Rendering is not strictly additive: a table header renders shorter once
  // its separator line follows, so the piece cut before that line can come
  // out longer than the measured start. The measured start always fits.
  const measured = text.slice(0, limit);
  return { markdown: measured, html: telegramRichText(measured), next: limit };
}

/**
 * Where to end a part within the first `limit` characters of `text`: at the
 * last line break in their second half, else at the last space there, else
 * at `limit`. `end` closes the part, `next` opens the one after it.
 */
function telegramCut(
  text: string,
  limit: number,
): { readonly end: number; readonly next: number } {
  const window = text.slice(0, limit + 1);
  const half = Math.floor(limit / 2);
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= half) {
    let next = lineBreak + 1;
    while (text[next] === "\n" || text[next] === "\r") next += 1;
    return { end: lineBreak, next };
  }
  const space = window.lastIndexOf(" ");
  if (space >= half) return { end: space, next: space + 1 };
  // No break in reach: cut mid-word, but not between the two halves of a
  // surrogate pair.
  const last = text.charCodeAt(limit - 1);
  const end = limit > 1 && last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return { end, next: end };
}

/**
 * How many characters from the start of `text` may go into one message: the
 * raw budget, or fewer when the rendering of that many is over the limit.
 * Never less than one, so a split always moves forward.
 */
function telegramFittingLength(text: string): number {
  const fits = (length: number): boolean =>
    fitsTelegramMessage(telegramRichText(text.slice(0, length)));
  const budget = Math.min(text.length, TELEGRAM_PART_BUDGET);
  if (fits(budget)) return budget;
  // `fitting` characters fit (one always does), `tooMany` do not: close in.
  let fitting = 1;
  let tooMany = budget;
  while (tooMany - fitting > 1) {
    const middle = Math.floor((fitting + tooMany) / 2);
    if (fits(middle)) fitting = middle;
    else tooMany = middle;
  }
  return fitting;
}

function shouldUseTelegramRichMessages(
  mode: TelegramRichMessageMode,
  chatId: string,
): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return !chatId.startsWith("-");
}

function telegramRichText(value: string): string {
  const lines = value.split(/\r?\n/u);
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const table = readMarkdownTable(lines, index);
    if (table !== null) {
      output.push(`<pre>${escapeTelegramHtml(formatMarkdownTable(table.rows))}</pre>`);
      index = table.nextIndex;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length && readMarkdownTable(lines, index) === null) {
      index += 1;
    }
    output.push(telegramInlineRichText(lines.slice(start, index).join("\n")));
  }

  return output.join("\n");
}

function telegramInlineRichText(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("`", index)) {
      const end = value.indexOf("`", index + 1);
      if (end > index + 1) {
        output += `<code>${escapeTelegramHtml(value.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith("**", index)) {
      const end = value.indexOf("**", index + 2);
      if (end > index + 2) {
        output += `<b>${escapeTelegramHtml(value.slice(index + 2, end))}</b>`;
        index = end + 2;
        continue;
      }
    }

    if (value.startsWith("[", index)) {
      const labelEnd = value.indexOf("]", index + 1);
      const urlStart = labelEnd >= 0 ? labelEnd + 1 : -1;
      if (urlStart >= 0 && value.startsWith("(", urlStart)) {
        const urlEnd = value.indexOf(")", urlStart + 1);
        if (urlEnd > urlStart + 1) {
          const label = value.slice(index + 1, labelEnd);
          const url = value.slice(urlStart + 1, urlEnd);
          if (isSafeTelegramLink(url)) {
            output += `<a href="${escapeTelegramAttribute(url)}">${escapeTelegramHtml(label)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
      }
    }

    if (value.startsWith("*", index) && !value.startsWith("**", index)) {
      const end = value.indexOf("*", index + 1);
      const previous = index === 0 ? "\n" : value[index - 1] ?? "\n";
      const next = value[index + 1] ?? "";
      const beforeClose = end > 0 ? value[end - 1] ?? "" : "";
      if (
        end > index + 1 &&
        !/\s/u.test(next) &&
        !/\s/u.test(beforeClose) &&
        previous !== "\n" &&
        previous !== "\r"
      ) {
        output += `<i>${escapeTelegramHtml(value.slice(index + 1, end))}</i>`;
        index = end + 1;
        continue;
      }
    }

    output += escapeTelegramHtml(value[index] ?? "");
    index += 1;
  }
  return output;
}

function readMarkdownTable(
  lines: readonly string[],
  startIndex: number,
): { readonly rows: readonly (readonly string[])[]; readonly nextIndex: number } | null {
  if (
    startIndex + 1 >= lines.length ||
    !looksLikeMarkdownTableRow(lines[startIndex] ?? "") ||
    !isMarkdownTableSeparator(lines[startIndex + 1] ?? "")
  ) {
    return null;
  }

  const rows: string[][] = [parseMarkdownTableRow(lines[startIndex] ?? "")];
  let index = startIndex + 2;
  while (index < lines.length && looksLikeMarkdownTableRow(lines[index] ?? "")) {
    rows.push(parseMarkdownTableRow(lines[index] ?? ""));
    index += 1;
  }

  return { rows, nextIndex: index };
}

function looksLikeMarkdownTableRow(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("|") && parseMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownTableSeparator(value: string): boolean {
  const cells = parseMarkdownTableRow(value);
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()))
  );
}

function parseMarkdownTableRow(value: string): string[] {
  let trimmed = value.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function formatMarkdownTable(rows: readonly (readonly string[])[]): string {
  const widthCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: widthCount }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderedRows = rows.map((row) =>
    widths
      .map((width, column) => (row[column] ?? "").padEnd(width))
      .join(" | ")
      .trimEnd(),
  );
  const separator = widths.map((width) => "-".repeat(Math.max(width, 3))).join(" | ");
  return [renderedRows[0], separator, ...renderedRows.slice(1)].join("\n");
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramAttribute(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;");
}

function isSafeTelegramLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function withTelegramReplyContext(
  message: TelegramMessage,
  text: string,
): string {
  const reply = message.reply_to_message;
  const replyText = reply?.text ?? reply?.caption;
  if (reply === undefined || replyText === undefined || replyText.trim().length === 0) {
    return text;
  }
  if (reply.from?.is_bot === true) return text;
  const displayName =
    reply.from?.username ??
    reply.from?.first_name ??
    reply.sender_chat?.username ??
    reply.sender_chat?.title ??
    "replied message";
  return [
    "Context from the message this user replied to:",
    `${displayName}: ${replyText.trim()}`,
    "",
    "User message:",
    text,
  ].join("\n");
}

function telegramUpdateKind(update: TelegramUpdate): string {
  if (update.message !== undefined) return "message";
  if (update.channel_post !== undefined) return "channel_post";
  if (update.edited_message !== undefined) return "edited_message";
  if (update.edited_channel_post !== undefined) return "edited_channel_post";
  return "unknown";
}

function telegramConversationId(
  chatId: string,
  messageThreadId: number | undefined,
): string {
  return messageThreadId === undefined ? chatId : `${chatId}:${messageThreadId}`;
}

function parseTelegramConversationId(value: string): {
  readonly chatId: string;
  readonly messageThreadId?: number;
} {
  const match = /^(?<chatId>-?\d+):(?<threadId>\d+)$/u.exec(value);
  if (match?.groups === undefined) return { chatId: value };
  return {
    chatId: match.groups.chatId,
    messageThreadId: Number.parseInt(match.groups.threadId, 10),
  };
}
