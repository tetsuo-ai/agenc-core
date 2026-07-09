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
  readonly message?: TelegramMessage;
  readonly channel_post?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly edited_channel_post?: TelegramMessage;
}

export interface TelegramMessage {
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
  readonly caption?: string;
  readonly reply_to_message?: {
    readonly from?: {
      readonly id: number;
      readonly is_bot?: boolean;
      readonly username?: string;
    };
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
  readonly #commandMenus: readonly TelegramCommandMenu[];
  readonly #debugUpdates: boolean;
  readonly #groupAddressing: "all" | "mentions";
  readonly #editTargets = new Map<string, EditTarget>();
  #botIdentity: TelegramBotIdentity | null = null;
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
    if (options.botUsername !== undefined && options.botUsername.length > 0) {
      this.#botIdentity = { id: -1, username: options.botUsername.replace(/^@/, "") };
    }
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
    await this.#resolveBotIdentity();
    await this.#installCommands();
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
      this.#botIdentity !== null ||
      this.#transport.getMe === undefined
    ) {
      return;
    }
    try {
      this.#botIdentity = await this.#transport.getMe();
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

  async #handleUpdate(update: TelegramUpdate): Promise<void> {
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
      return;
    }
    const sender = message.from;
    const senderChat = message.sender_chat;
    if (sender === undefined && senderChat === undefined) {
      return;
    }
    const peerId = String(sender?.id ?? senderChat?.id);
    const chatId = String(message.chat.id);
    const isPrivate = message.chat.type === "private";
    const conversationId = telegramConversationId(
      chatId,
      isPrivate ? undefined : message.message_thread_id,
    );
    const text = this.#normalizedTextForAddressing(rawText, message);
    if (text === null) return;
    await this.#context.onMessage({
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
    });
  }

  #debugUpdate(
    updateKind: string,
    message: TelegramMessage | undefined,
    rawText: string | undefined,
  ): void {
    if (!this.#debugUpdates) return;
    const username = this.#botIdentity?.username;
    const hasMention =
      username !== undefined &&
      rawText !== undefined &&
      new RegExp(`(^|\\s)@${escapeRegExp(username)}\\b`, "i").test(rawText);
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
    if (username !== undefined && username.length > 0) {
      const mention = new RegExp(`(^|\\s)@${escapeRegExp(username)}\\b`, "i");
      if (mention.test(text)) {
        const stripped = text.replace(mention, " ").replace(/\s+/g, " ").trim();
        return stripped.length > 0 ? stripped : text;
      }
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
    // Conversation id is Telegram chat id, optionally suffixed with the forum
    // topic thread id. Replies must stay in-topic or users never see them.
    const target = parseTelegramConversationId(message.conversationId);
    const richOptions: TelegramRichMessageOptions = {
      ...(target.messageThreadId !== undefined
        ? { messageThreadId: target.messageThreadId }
        : {}),
      skipEntityDetection: true,
    };
    const sendOptions: TelegramSendOptions = {
      ...(target.messageThreadId !== undefined
        ? { messageThreadId: target.messageThreadId }
        : {}),
      parseMode: "HTML",
    };
    const formattedText = telegramRichText(message.text);
    if (message.editMessageId !== undefined) {
      const target = this.#editTargets.get(message.editMessageId);
      if (target !== undefined) {
        if (this.#transport.editRichMessage !== undefined) {
          try {
            await this.#transport.editRichMessage(
              target.chatId,
              target.messageId,
              message.text,
              richOptions,
            );
            return message.editMessageId;
          } catch (error) {
            if (isTelegramNoopEdit(error)) return message.editMessageId;
            this.#log(`telegram: rich edit fallback: ${String(error)}`);
          }
        }
        try {
          await this.#transport.editMessageText(
            target.chatId,
            target.messageId,
            formattedText,
            sendOptions,
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
      message.audioBytes !== undefined && this.#transport.sendAudio !== undefined
        ? await this.#transport.sendAudio(target.chatId, message.audioBytes, {
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
          })
        :
      message.photoUrl !== undefined && this.#transport.sendPhoto !== undefined
        ? await this.#transport.sendPhoto(
            target.chatId,
            message.photoUrl,
            telegramRichText(message.caption ?? message.text),
            sendOptions,
          )
        : await sendTelegramTextMessage(
            this.#transport,
            target.chatId,
            message.text,
            formattedText,
            richOptions,
            sendOptions,
            this.#log,
          );
    const handle = `${this.id}-out-${++this.#outCounter}`;
    this.#editTargets.set(handle, {
      chatId: target.chatId,
      messageId: sent.message_id,
    });
    return handle;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendTelegramTextMessage(
  transport: TelegramTransport,
  chatId: string,
  markdown: string,
  fallbackHtml: string,
  richOptions: TelegramRichMessageOptions,
  fallbackOptions: TelegramSendOptions,
  log: (line: string) => void,
): Promise<TelegramSentMessage> {
  if (transport.sendRichMessage !== undefined) {
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
