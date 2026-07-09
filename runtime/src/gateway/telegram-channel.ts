/**
 * Telegram channel adapter (TODO task 7).
 *
 * Official Bot API (https://core.telegram.org/bots/api) via long polling —
 * no reverse-engineered client, no account-ban risk. Streaming replies use
 * editMessageText so a turn updates one message in place (`supportsEdit`).
 *
 * The HTTP transport is injectable so the adapter logic is unit-tested
 * against a fake Bot API. The production transport uses global fetch (Node
 * 25); no HTTP dependency.
 */

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  OutboundChannelMessage,
} from "./types.js";

export const TELEGRAM_CHANNEL_ID = "telegram";

// ---- Bot API transport ----------------------------------------------------

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly from?: { readonly id: number; readonly username?: string; readonly first_name?: string };
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
  };
}

export interface TelegramSentMessage {
  readonly message_id: number;
}

/** The slice of the Bot API the adapter uses. */
export interface TelegramTransport {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<TelegramSentMessage>;
  sendPhoto?(
    chatId: string,
    photoUrl: string,
    caption?: string,
  ): Promise<TelegramSentMessage>;
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
}

interface BotApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

export class TelegramBotApiError extends Error {}

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
    if (!json.ok) {
      throw new TelegramBotApiError(
        `Telegram ${method} failed: ${json.description ?? res.status}`,
      );
    }
    return json.result as T;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption?: string,
  ): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      ...(caption !== undefined && caption.length > 0
        ? { caption: caption.slice(0, 1024) }
        : {}),
    });
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
    await this.#call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
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
  /**
   * Launch the background long-poll loop on start(). Default true. Tests set
   * false to drive pollOnce() deterministically without a competing loop.
   */
  readonly autoPoll?: boolean;
}

/** Maps a Telegram sent-message id back to its chat for later edits. */
interface EditTarget {
  readonly chatId: string;
  readonly messageId: number;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = true;
  readonly #transport: TelegramTransport;
  readonly #pollTimeout: number;
  readonly #backoffMs: number;
  readonly #log: (line: string) => void;
  readonly #autoPoll: boolean;
  readonly #editTargets = new Map<string, EditTarget>();
  #context: ChannelAdapterContext | null = null;
  #offset = 0;
  #running = false;
  #loop: Promise<void> | null = null;
  #outCounter = 0;

  constructor(options: TelegramChannelOptions) {
    this.id = options.id ?? TELEGRAM_CHANNEL_ID;
    this.#transport = options.transport;
    this.#pollTimeout = options.pollTimeoutSeconds ?? 30;
    this.#backoffMs = options.errorBackoffMs ?? 1000;
    this.#log = options.log ?? (() => {});
    this.#autoPoll = options.autoPoll ?? true;
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    if (this.#autoPoll) {
      this.#running = true;
      this.#loop = this.#pollLoop();
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#loop?.catch(() => {});
    this.#loop = null;
    this.#context = null;
  }

  /** Run one long-poll iteration; exposed for deterministic tests. */
  async pollOnce(): Promise<void> {
    const updates = await this.#transport.getUpdates(
      this.#offset,
      this.#pollTimeout,
    );
    for (const update of updates) {
      this.#offset = Math.max(this.#offset, update.update_id + 1);
      await this.#handleUpdate(update);
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

  async #handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (
      this.#context === null ||
      message === undefined ||
      message.text === undefined ||
      message.from === undefined
    ) {
      return;
    }
    const peerId = String(message.from.id);
    const chatId = String(message.chat.id);
    const isGroup =
      message.chat.type === "group" || message.chat.type === "supergroup";
    await this.#context.onMessage({
      channelId: this.id,
      sender: {
        peerId,
        ...(message.from.username !== undefined
          ? { displayName: message.from.username }
          : message.from.first_name !== undefined
            ? { displayName: message.from.first_name }
            : {}),
      },
      conversation: { kind: isGroup ? "group" : "dm", id: chatId },
      text: message.text,
    });
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    // Conversation id IS the Telegram chat id.
    const chatId = message.conversationId;
    if (message.editMessageId !== undefined) {
      const target = this.#editTargets.get(message.editMessageId);
      if (target !== undefined) {
        try {
          await this.#transport.editMessageText(
            target.chatId,
            target.messageId,
            message.text,
          );
          return message.editMessageId;
        } catch (error) {
          // Telegram rejects a no-op edit ("message is not modified"); treat
          // as a successful non-update rather than failing the turn.
          this.#log(`telegram: edit skipped: ${String(error)}`);
          return message.editMessageId;
        }
      }
    }
    const sent =
      message.photoUrl !== undefined && this.#transport.sendPhoto !== undefined
        ? await this.#transport.sendPhoto(
            chatId,
            message.photoUrl,
            message.caption ?? message.text,
          )
        : await this.#transport.sendMessage(chatId, message.text);
    const handle = `${this.id}-out-${++this.#outCounter}`;
    this.#editTargets.set(handle, { chatId, messageId: sent.message_id });
    return handle;
  }
}
