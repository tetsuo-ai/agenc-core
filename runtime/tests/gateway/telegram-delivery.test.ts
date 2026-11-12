// Telegram reply delivery (#3440): a reply longer than one message is split
// and kept up to date part by part, and a failed edit is no longer reported
// as delivered. The fake Bot API keeps the chat as a list of messages and
// refuses what the real one refuses: text over 4096 characters, empty text,
// and an edit that changes nothing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SessionRouter } from "../../src/gateway/session-router.js";
import {
  FetchTelegramTransport,
  TELEGRAM_MESSAGE_LIMIT,
  TelegramBotApiError,
  TelegramChannelAdapter,
  splitTelegramText,
  type TelegramRichMessageOptions,
  type TelegramSendOptions,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/gateway/telegram-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPromptResult,
  GatewaySession,
} from "../../src/gateway/types.js";

const GROUP = "-1001";
const PRIVATE = "42";
/** In a list of scripted rejections: let this call through. */
const PASS = undefined;

function botError(
  method: string,
  errorCode: number,
  description: string,
  retryAfterSeconds?: number,
): TelegramBotApiError {
  return new TelegramBotApiError(`Telegram ${method} failed: ${description}`, {
    errorCode,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

function rateLimited(seconds: number): TelegramBotApiError {
  return botError(
    "editMessageText",
    429,
    `Too Many Requests: retry after ${seconds}`,
    seconds,
  );
}

function checkText(method: string, text: string): void {
  if (text.trim().length === 0) {
    throw botError(method, 400, "Bad Request: message text is empty");
  }
  if (text.length > TELEGRAM_MESSAGE_LIMIT) {
    throw botError(method, 400, "Bad Request: message is too long");
  }
}

/** Take the next scripted outcome of a call and throw it unless it is PASS. */
function rejectIfScripted(script: unknown[]): void {
  const rejection = script.shift();
  if (rejection !== PASS) throw rejection;
}

interface ChatMessage {
  readonly id: number;
  readonly chatId: string;
  readonly threadId?: number;
  text: string;
  parseMode?: "HTML";
  /** True when the text arrived as Rich Message Markdown. */
  rich: boolean;
}

/** Bot API stand-in without Rich Messages: sendMessage and editMessageText only. */
class FakeBotApi implements TelegramTransport {
  readonly messages: ChatMessage[] = [];
  /** Every attempt in call order: "send", "edit:<id>", "rich-send", "rich-edit:<id>". */
  readonly calls: string[] = [];
  /** Scripted outcome of the next editMessageText calls: a rejection or PASS. */
  readonly editErrors: unknown[] = [];
  /** Scripted outcome of the next sendMessage calls: a rejection or PASS. */
  readonly sendErrors: unknown[] = [];
  #nextId = 100;

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendOptions = {},
  ) {
    this.calls.push("send");
    rejectIfScripted(this.sendErrors);
    checkText("sendMessage", text);
    return this.add(chatId, text, options.messageThreadId, false, options.parseMode);
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramSendOptions = {},
  ): Promise<void> {
    this.calls.push(`edit:${messageId}`);
    rejectIfScripted(this.editErrors);
    checkText("editMessageText", text);
    const message = this.find("editMessageText", chatId, messageId);
    if (message.text === text && !message.rich) {
      throw botError(
        "editMessageText",
        400,
        "Bad Request: message is not modified",
      );
    }
    message.text = text;
    message.rich = false;
    if (options.parseMode !== undefined) message.parseMode = options.parseMode;
    else delete message.parseMode;
  }

  protected add(
    chatId: string,
    text: string,
    threadId: number | undefined,
    rich: boolean,
    parseMode?: "HTML",
  ): { message_id: number } {
    const message: ChatMessage = {
      id: ++this.#nextId,
      chatId,
      text,
      rich,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(parseMode !== undefined ? { parseMode } : {}),
    };
    this.messages.push(message);
    return { message_id: message.id };
  }

  protected find(method: string, chatId: string, messageId: number): ChatMessage {
    const message = this.messages.find(
      (candidate) => candidate.chatId === chatId && candidate.id === messageId,
    );
    if (message === undefined) {
      throw botError(method, 400, "Bad Request: message to edit not found");
    }
    return message;
  }

  /** The texts a reader of the chat sees now, oldest message first. */
  texts(chatId: string): string[] {
    return this.messages
      .filter((message) => message.chatId === chatId)
      .map((message) => message.text);
  }
}

/** The same stand-in with Rich Messages, as private chats use them. */
class RichBotApi extends FakeBotApi {
  /** Scripted outcome of the next editRichMessage calls: a rejection or PASS. */
  readonly richEditErrors: unknown[] = [];

  async sendRichMessage(
    chatId: string,
    markdown: string,
    options: TelegramRichMessageOptions = {},
  ) {
    this.calls.push("rich-send");
    checkText("sendRichMessage", markdown);
    return this.add(chatId, markdown, options.messageThreadId, true);
  }

  async editRichMessage(
    chatId: string,
    messageId: number,
    markdown: string,
  ): Promise<void> {
    this.calls.push(`rich-edit:${messageId}`);
    rejectIfScripted(this.richEditErrors);
    checkText("editMessageText", markdown);
    const message = this.find("editMessageText", chatId, messageId);
    message.text = markdown;
    message.rich = true;
    delete message.parseMode;
  }
}

/** Numbered lines of plain words: the HTML rendering is the text itself. */
function longAnswer(length: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let line = 1; size < length; line += 1) {
    const text = `${String(line).padStart(4, "0")} lorem ipsum dolor sit amet consectetur`;
    lines.push(text);
    size += text.length + 1;
  }
  return lines.join("\n").slice(0, length);
}

function setup(transport: TelegramTransport = new FakeBotApi()) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const adapter = new TelegramChannelAdapter({
    transport,
    autoPoll: false,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { adapter, logs, sleeps };
}

describe("splitTelegramText", () => {
  test("a reply that fits stays one part with its HTML rendering", () => {
    expect(splitTelegramText("**Hello** <world>")).toEqual([
      { markdown: "**Hello** <world>", html: "<b>Hello</b> &lt;world&gt;" },
    ]);
    // Right up to the limit nothing is split, whatever the raw budget is.
    const full = longAnswer(TELEGRAM_MESSAGE_LIMIT);
    expect(splitTelegramText(full)).toEqual([{ markdown: full, html: full }]);
  });

  test("a longer reply is cut at line breaks and loses nothing", () => {
    const answer = longAnswer(5000);
    const parts = splitTelegramText(answer);

    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      // Whole lines only: no part starts in the middle of one.
      expect(part.markdown).toMatch(/^\d{4} lorem/);
    }
    expect(parts[0].markdown).toMatch(/consectetur$/);
    expect(parts[0].markdown.length).toBeLessThanOrEqual(3600);
    expect(parts.map((part) => part.markdown).join("\n")).toBe(answer);
  });

  test("a line with no break in reach is cut at a space", () => {
    const words = Array.from({ length: 1200 }, (_, index) => `w${index}`);
    const answer = ["abc", ...words].join(" ");
    // The raw budget ends inside a word, so only the space rule keeps it whole.
    expect(answer.slice(3599, 3601)).toMatch(/^\S\S$/);
    const parts = splitTelegramText(answer);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(part.markdown).toMatch(/^\w+( \w+)*$/);
    }
    expect(parts.map((part) => part.markdown).join(" ")).toBe(answer);
  });

  test("text without any break is cut mid-word, never inside a surrogate pair", () => {
    const solid = "x".repeat(5000);
    const solidParts = splitTelegramText(solid);
    expect(solidParts.map((part) => part.markdown.length)).toEqual([3600, 1400]);
    expect(solidParts.map((part) => part.markdown).join("")).toBe(solid);

    // An emoji is two UTF-16 units; the cut would land between them.
    const emoji = `${"x".repeat(3599)}${"\u{1F600}".repeat(400)}`;
    const emojiParts = splitTelegramText(emoji);
    expect(emojiParts[0].markdown).toBe("x".repeat(3599));
    for (const part of emojiParts) {
      expect(() => encodeURIComponent(part.markdown)).not.toThrow();
    }
    expect(emojiParts.map((part) => part.markdown).join("")).toBe(emoji);
  });

  test("the earlier parts of a growing reply do not change", () => {
    // Prose, then markup that renders much longer than its source: the kind
    // of answer whose parts have to be cut by their rendering.
    const answer = [
      longAnswer(3000),
      ...Array.from({ length: 150 }, (_, index) => `<li key={${index}}>&nbsp;<b>item</b></li>`),
      longAnswer(3000),
    ].join("\n");
    const complete = splitTelegramText(answer);
    expect(complete.length).toBeGreaterThan(3);

    let previous = splitTelegramText(answer.slice(0, 100));
    for (let length = 350; length < answer.length; length += 250) {
      const partial = splitTelegramText(answer.slice(0, length));
      // Only the last part grows; everything before it is already final.
      expect(partial.length).toBeGreaterThanOrEqual(previous.length);
      expect(partial.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
      expect(partial.slice(0, -1)).toEqual(complete.slice(0, partial.length - 1));
      previous = partial;
    }
  });

  test("a part is cut shorter when its HTML would be over the limit", () => {
    // 3,000 raw characters are under the raw budget, but every "<" becomes
    // "&lt;": 110 lines are the most whose rendering fits one message.
    const answer = Array.from({ length: 300 }, () => "<<<<<<<<<").join("\n");
    expect(answer.length).toBeLessThan(3600);
    const parts = splitTelegramText(answer);

    expect(parts.map((part) => part.markdown.split("\n").length)).toEqual([
      110, 110, 80,
    ]);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(part.html).toBe(part.markdown.replaceAll("<", "&lt;"));
    }
    expect(parts.map((part) => part.markdown).join("\n")).toBe(answer);
  });

  test("text that renders five times its length is cut where the rendering fits", () => {
    // No break anywhere and five characters of HTML for each "&".
    expect(splitTelegramText("&".repeat(1000))).toEqual([
      { markdown: "&".repeat(819), html: "&amp;".repeat(819) },
      { markdown: "&".repeat(181), html: "&amp;".repeat(181) },
    ]);
    // 819 is the most that fits, whatever length the search starts from.
    for (let length = 820; length <= 900; length += 1) {
      expect(splitTelegramText("&".repeat(length))[0].markdown).toHaveLength(819);
    }
  });

  test("a table that renders wider than its source is cut by its rendering", () => {
    // Every row is padded to the widest cell, so the <pre> block is about
    // four times as long as the Markdown.
    const answer = [
      "| key | value |",
      "|---|---|",
      `| ${"wide".repeat(10)} | v |`,
      ...Array.from({ length: 200 }, (_, index) => `| r${index} | v |`),
    ].join("\n");
    expect(answer.length).toBeLessThan(3600);
    const parts = splitTelegramText(answer);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].html).toMatch(/^<pre>key {38}\| value\n/);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(parts.map((part) => part.markdown).join("\n")).toBe(answer);
  });

  test("a cut that would render longer than what was measured is not taken", () => {
    // A padded table header renders short once its separator line follows.
    // Cutting at the line break before the separator leaves the header as
    // 1,700 characters of plain text, which no longer fits with the rest.
    const markup = Array.from({ length: 10 }, () => "<".repeat(60)).join("\n");
    const header = `| a${" ".repeat(1700)}| b |`;
    const separator = `|${"---|".repeat(400)}`;
    const answer = [markup, header, separator, "y".repeat(2000)].join("\n");
    const parts = splitTelegramText(answer);

    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    // The first part is the measured 3,600 characters, table included.
    expect(parts[0].markdown).toBe(answer.slice(0, 3600));
    expect(parts[0].html.endsWith("<pre>a | b\n--- | ---</pre>")).toBe(true);
    expect(parts.map((part) => part.markdown).join("")).toBe(answer);
  });

  test("blank space at a cut is dropped, a blank reply stays one blank part", () => {
    const head = "a".repeat(3590);
    const parts = splitTelegramText(`${head}\r\n\r\n\n${"b".repeat(1000)}`);
    expect(parts.map((part) => part.markdown)).toEqual([head, "b".repeat(1000)]);

    // The same when the blank lines begin exactly where the budget ends.
    const full = "a".repeat(3600);
    const straddling = splitTelegramText(`${full}\n\r\n\n${"b".repeat(1000)}`);
    expect(straddling.map((part) => part.markdown)).toEqual([full, "b".repeat(1000)]);

    // What is left after the cut is only spaces: no empty message for it.
    const padded = splitTelegramText(`${"x".repeat(3600)}${" ".repeat(600)}`);
    expect(padded.map((part) => part.markdown)).toEqual(["x".repeat(3600)]);

    // Nothing to show at all: one part, for Telegram to refuse.
    const blank = splitTelegramText(" ".repeat(5000));
    expect(blank).toHaveLength(1);
    expect(blank[0].markdown.trim()).toBe("");
    expect(splitTelegramText("")).toEqual([{ markdown: "", html: "" }]);
  });
});

describe("TelegramChannelAdapter long replies", () => {
  test("a 5,000-character answer arrives complete and in order", async () => {
    const api = new FakeBotApi();
    const { adapter, logs } = setup(api);
    const answer = longAnswer(5000);

    await adapter.send({ conversationId: GROUP, text: answer });

    expect(api.calls).toEqual(["send", "send"]);
    expect(api.messages.map((message) => message.id)).toEqual([101, 102]);
    expect(api.messages.every((message) => message.parseMode === "HTML")).toBe(true);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
    expect(logs).toEqual([]);
  });

  test("the final edit of a streamed answer spills into a follow-up message", async () => {
    const api = new FakeBotApi();
    const { adapter, logs } = setup(api);
    const answer = longAnswer(5000);

    const handle = await adapter.send({
      conversationId: GROUP,
      text: "partial answer",
    });
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: answer,
        editMessageId: handle,
        final: true,
      }),
    ).resolves.toBe(handle);

    // The first message was edited in place, the rest follows it.
    expect(api.calls).toEqual(["send", "edit:101", "send"]);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
    expect(logs).toEqual([]);
  });

  test("follow-up messages stay in the forum topic of the reply", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const answer = longAnswer(9000);

    const handle = await adapter.send({
      conversationId: `${GROUP}:77`,
      text: answer.slice(0, 5000),
    });
    await adapter.send({
      conversationId: `${GROUP}:77`,
      text: answer,
      editMessageId: handle,
    });

    expect(api.messages.length).toBeGreaterThan(2);
    expect(api.messages.every((message) => message.threadId === 77)).toBe(true);
    expect(api.messages.every((message) => message.chatId === GROUP)).toBe(true);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
  });

  test("only the parts that changed are edited", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const answer = longAnswer(9000);

    const handle = await adapter.send({
      conversationId: GROUP,
      text: answer.slice(0, 5000),
    });
    expect(api.calls).toEqual(["send", "send"]);

    // Growing inside the second message: the first one is left alone.
    await adapter.send({
      conversationId: GROUP,
      text: answer.slice(0, 6000),
      editMessageId: handle,
    });
    expect(api.calls.slice(2)).toEqual(["edit:102"]);

    // Growing past it: the second message is completed and a third one sent.
    await adapter.send({
      conversationId: GROUP,
      text: answer,
      editMessageId: handle,
    });
    expect(api.calls.slice(3)).toEqual(["edit:102", "send"]);
    expect(api.texts(GROUP).join("\n")).toBe(answer);

    // The same text again changes nothing and calls nothing.
    await adapter.send({
      conversationId: GROUP,
      text: answer,
      editMessageId: handle,
      final: true,
    });
    expect(api.calls).toHaveLength(5);
  });

  test("a shorter final text leaves the extra messages in place", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const draft = longAnswer(5000);

    const handle = await adapter.send({ conversationId: GROUP, text: draft });
    await adapter.send({
      conversationId: GROUP,
      text: "short final answer",
      editMessageId: handle,
      final: true,
    });

    // Nothing is deleted: the first message carries the final text.
    expect(api.calls).toEqual(["send", "send", "edit:101"]);
    expect(api.texts(GROUP)).toEqual([
      "short final answer",
      splitTelegramText(draft)[1].markdown,
    ]);
  });

  test("text that renders much longer than its source still goes out as HTML", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);

    await adapter.send({ conversationId: GROUP, text: "&".repeat(1000) });

    expect(api.messages.map((message) => message.parseMode)).toEqual([
      "HTML",
      "HTML",
    ]);
    expect(api.texts(GROUP)).toEqual(["&amp;".repeat(819), "&amp;".repeat(181)]);
  });

  test("a blank reply is refused by Telegram, not dropped", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);

    await expect(
      adapter.send({ conversationId: GROUP, text: " ".repeat(5000) }),
    ).rejects.toThrow("message text is empty");
    expect(api.messages).toEqual([]);
  });

  test("private chats get each part as a Rich Message", async () => {
    const api = new RichBotApi();
    const { adapter } = setup(api);
    const answer = longAnswer(9000);

    const handle = await adapter.send({
      conversationId: PRIVATE,
      text: answer.slice(0, 5000),
    });
    await adapter.send({
      conversationId: PRIVATE,
      text: answer,
      editMessageId: handle,
      final: true,
    });

    expect(api.calls).toEqual([
      "rich-send",
      "rich-send",
      "rich-edit:102",
      "rich-send",
    ]);
    expect(api.messages.every((message) => message.rich)).toBe(true);
    expect(api.texts(PRIVATE).join("\n")).toBe(answer);
  });
});

describe("TelegramChannelAdapter edit failures", () => {
  test("a streaming edit that is rejected is logged and does not fail the send", async () => {
    const api = new FakeBotApi();
    const { adapter, logs, sleeps } = setup(api);
    const rejection = rateLimited(30);

    const handle = await adapter.send({ conversationId: GROUP, text: "Hel" });
    api.editErrors.push(rejection);
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: "Hello wor",
        editMessageId: handle,
      }),
    ).resolves.toBe(handle);

    // No retry and no new message: the next edit carries newer text.
    expect(api.calls).toEqual(["send", "edit:101"]);
    expect(sleeps).toEqual([]);
    expect(api.texts(GROUP)).toEqual(["Hel"]);
    expect(logs).toEqual([`telegram: edit skipped: ${String(rejection)}`]);

    // The skipped text is not remembered as shown, so it is sent again.
    await adapter.send({
      conversationId: GROUP,
      text: "Hello wor",
      editMessageId: handle,
    });
    expect(api.calls).toEqual(["send", "edit:101", "edit:101"]);
    expect(api.texts(GROUP)).toEqual(["Hello wor"]);
  });

  test("a streaming follow-up that is rejected is retried by the next edit, in order", async () => {
    const api = new FakeBotApi();
    const { adapter, logs } = setup(api);
    const answer = longAnswer(9000);
    const rejection = botError("sendMessage", 429, "Too Many Requests: retry after 5", 5);

    const handle = await adapter.send({ conversationId: GROUP, text: "start" });
    api.sendErrors.push(rejection);
    await expect(
      adapter.send({ conversationId: GROUP, text: answer, editMessageId: handle }),
    ).resolves.toBe(handle);

    // The second part failed, so the third was not sent ahead of it.
    expect(api.calls).toEqual(["send", "edit:101", "send"]);
    expect(api.messages).toHaveLength(1);
    expect(logs).toEqual([`telegram: follow-up skipped: ${String(rejection)}`]);

    await adapter.send({
      conversationId: GROUP,
      text: answer,
      editMessageId: handle,
      final: true,
    });
    expect(api.calls.slice(3)).toEqual(["send", "send"]);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
  });

  test("a rate-limited final edit is retried once after retry_after", async () => {
    const api = new FakeBotApi();
    const { adapter, logs, sleeps } = setup(api);

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(rateLimited(3));
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: "the complete answer",
        editMessageId: handle,
        final: true,
      }),
    ).resolves.toBe(handle);

    expect(sleeps).toEqual([3000]);
    expect(api.calls).toEqual(["send", "edit:101", "edit:101"]);
    expect(api.texts(GROUP)).toEqual(["the complete answer"]);
    expect(logs).toEqual([
      "telegram: final edit rate limited, retrying in 3000 ms",
    ]);
  });

  test("a final edit that is still rejected after the retry falls back to a new message", async () => {
    const api = new FakeBotApi();
    const { adapter, logs, sleeps } = setup(api);
    const second = rateLimited(4);

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(rateLimited(4), second);
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: "the complete answer",
        editMessageId: handle,
        final: true,
      }),
    ).resolves.toBe(handle);

    // One wait, one retry, then the answer as a new message. The message
    // that could not be edited is left as it was.
    expect(sleeps).toEqual([4000]);
    expect(api.calls).toEqual(["send", "edit:101", "edit:101", "send"]);
    expect(api.texts(GROUP)).toEqual(["partial", "the complete answer"]);
    expect(logs).toEqual([
      "telegram: final edit rate limited, retrying in 4000 ms",
      `telegram: final edit failed, sending the rest as new messages: ${String(second)}`,
    ]);

    // The handle now points at the new message.
    await adapter.send({
      conversationId: GROUP,
      text: "the complete answer, amended",
      editMessageId: handle,
      final: true,
    });
    expect(api.calls.slice(4)).toEqual(["edit:102"]);
    expect(api.texts(GROUP)).toEqual(["partial", "the complete answer, amended"]);
  });

  test("the wait before the retry is capped at ten seconds", async () => {
    const api = new FakeBotApi();
    const { adapter, sleeps } = setup(api);

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(rateLimited(600));
    await adapter.send({
      conversationId: GROUP,
      text: "the complete answer",
      editMessageId: handle,
      final: true,
    });

    expect(sleeps).toEqual([10_000]);
    expect(api.texts(GROUP)).toEqual(["the complete answer"]);
  });

  test("a flood limit without retry_after waits one second", async () => {
    const api = new FakeBotApi();
    const { adapter, sleeps } = setup(api);

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(botError("editMessageText", 429, "Too Many Requests"));
    await adapter.send({
      conversationId: GROUP,
      text: "the complete answer",
      editMessageId: handle,
      final: true,
    });

    expect(sleeps).toEqual([1000]);
    expect(api.texts(GROUP)).toEqual(["the complete answer"]);
  });

  test("any other rejected final edit goes straight to a new message", async () => {
    const api = new FakeBotApi();
    const { adapter, logs, sleeps } = setup(api);
    const rejection = botError(
      "editMessageText",
      400,
      "Bad Request: message can't be edited",
    );

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(rejection);
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: "the complete answer",
        editMessageId: handle,
        final: true,
      }),
    ).resolves.toBe(handle);

    expect(sleeps).toEqual([]);
    expect(api.calls).toEqual(["send", "edit:101", "send"]);
    expect(api.texts(GROUP)).toEqual(["partial", "the complete answer"]);
    expect(logs).toEqual([
      `telegram: final edit failed, sending the rest as new messages: ${String(rejection)}`,
    ]);
  });

  test("the fallback resends everything from the failed part on, in order", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const draft = longAnswer(9000);
    const answer = draft.replaceAll("lorem", "LOREM");
    const draftParts = splitTelegramText(draft);
    const parts = splitTelegramText(answer);
    expect(parts).toHaveLength(3);

    const handle = await adapter.send({ conversationId: GROUP, text: draft });
    expect(api.calls).toEqual(["send", "send", "send"]);

    // The first message takes its final text, the second refuses the edit.
    api.editErrors.push(
      PASS,
      botError("editMessageText", 400, "Bad Request: message can't be edited"),
    );
    await adapter.send({
      conversationId: GROUP,
      text: answer,
      editMessageId: handle,
      final: true,
    });

    // The third message is not edited either: its part follows the second
    // one as a new message, so the final text reads in order.
    expect(api.calls.slice(3)).toEqual(["edit:101", "edit:102", "send", "send"]);
    expect(api.texts(GROUP)).toEqual([
      parts[0].html,
      draftParts[1].html,
      draftParts[2].html,
      parts[1].html,
      parts[2].html,
    ]);
    expect(parts.map((part) => part.html).join("\n")).toBe(answer);
  });

  test("when the edit and the fallback both fail the send rejects", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const fallbackError = botError(
      "sendMessage",
      403,
      "Forbidden: bot was kicked from the supergroup chat",
    );

    const handle = await adapter.send({ conversationId: GROUP, text: "partial" });
    api.editErrors.push(new Error("socket hang up"));
    api.sendErrors.push(fallbackError);
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: "the complete answer",
        editMessageId: handle,
        final: true,
      }),
    ).rejects.toBe(fallbackError);
    expect(api.texts(GROUP)).toEqual(["partial"]);
  });

  test("a final follow-up that is rejected rejects the send", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const rejection = botError("sendMessage", 429, "Too Many Requests: retry after 9", 9);

    const handle = await adapter.send({ conversationId: GROUP, text: "start" });
    api.sendErrors.push(rejection);
    await expect(
      adapter.send({
        conversationId: GROUP,
        text: longAnswer(5000),
        editMessageId: handle,
        final: true,
      }),
    ).rejects.toBe(rejection);
  });

  test("\"message is not modified\" counts as delivered, final or not", async () => {
    for (const final of [false, true]) {
      const api = new FakeBotApi();
      const { adapter, logs, sleeps } = setup(api);
      const handle = await adapter.send({ conversationId: GROUP, text: "a" });
      api.editErrors.push(
        botError("editMessageText", 400, "Bad Request: message is not modified"),
      );
      await expect(
        adapter.send({
          conversationId: GROUP,
          text: "b",
          editMessageId: handle,
          ...(final ? { final } : {}),
        }),
      ).resolves.toBe(handle);

      expect(api.calls).toEqual(["send", "edit:101"]);
      expect(logs).toEqual([]);
      expect(sleeps).toEqual([]);
      // Remembered as shown: the same text is not sent a second time.
      await adapter.send({ conversationId: GROUP, text: "b", editMessageId: handle });
      expect(api.calls).toEqual(["send", "edit:101"]);
    }
  });

  test("a rich edit refused as not modified counts as delivered without a fallback", async () => {
    const api = new RichBotApi();
    const { adapter, logs } = setup(api);

    const handle = await adapter.send({ conversationId: PRIVATE, text: "a" });
    api.richEditErrors.push(
      botError("editMessageText", 400, "Bad Request: message is not modified"),
    );
    await expect(
      adapter.send({ conversationId: PRIVATE, text: "b", editMessageId: handle }),
    ).resolves.toBe(handle);

    expect(api.calls).toEqual(["rich-send", "rich-edit:101"]);
    expect(logs).toEqual([]);
  });

  test("a rejected rich edit falls back to editMessageText before it counts as failed", async () => {
    const api = new RichBotApi();
    const { adapter, logs, sleeps } = setup(api);
    const richRejection = new Error("rich message rejected");

    const handle = await adapter.send({ conversationId: PRIVATE, text: "Hel" });
    api.richEditErrors.push(richRejection);
    await adapter.send({
      conversationId: PRIVATE,
      text: "**Hello**",
      editMessageId: handle,
      final: true,
    });

    expect(api.calls).toEqual(["rich-send", "rich-edit:101", "edit:101"]);
    expect(api.texts(PRIVATE)).toEqual(["<b>Hello</b>"]);
    expect(sleeps).toEqual([]);
    expect(logs).toEqual([
      `telegram: rich edit fallback: ${String(richRejection)}`,
    ]);
  });
});

describe("Telegram delivery through SessionRouter", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-telegram-delivery-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A turn that streams `deltas`, one flush each, then completes. */
  function runTurn(
    adapter: TelegramChannelAdapter,
    deltas: readonly string[],
    finalMessage: string,
  ): { readonly outcome: Promise<GatewayPromptResult>; readonly prompts: () => number } {
    let prompts = 0;
    const session: GatewaySession = {
      sessionId: "delivery-session",
      prompt: async (_text, handlers) => {
        prompts += 1;
        for (const delta of deltas) {
          await handlers.onEvent({ type: "text", delta });
          await nextEventLoopTurn();
        }
        return { stopReason: "completed", finalMessage };
      },
    };
    const client: GatewayDaemonClient = {
      createSession: async () => session,
      attachSession: async () => session,
      close: async () => {},
    };
    const router = new SessionRouter({
      agencHome: home,
      client,
      flushIntervalMs: 0,
    });
    const outcome = router.runTurn({
      key: `telegram|default|${GROUP}`,
      text: "request",
      conversationId: GROUP,
      adapter,
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });
    return { outcome, prompts: () => prompts };
  }

  function chunks(text: string, size: number): string[] {
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += size) {
      pieces.push(text.slice(at, at + size));
    }
    return pieces;
  }

  test("a streamed 5,000-character answer arrives complete and in order", async () => {
    const api = new FakeBotApi();
    const { adapter, logs } = setup(api);
    const answer = longAnswer(5000);

    const turn = runTurn(adapter, chunks(answer, 500), answer);
    await expect(turn.outcome).resolves.toEqual({
      stopReason: "completed",
      finalMessage: answer,
    });

    expect(api.messages.map((message) => message.id)).toEqual([101, 102]);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
    // Once the answer spilled into the second message, the first one was
    // final: only the second is edited from then on.
    const spill = api.calls.lastIndexOf("send");
    expect(spill).toBeGreaterThan(0);
    expect(api.calls.slice(spill + 1)).toEqual(["edit:102"]);
    expect(logs).toEqual([]);
  });

  test("a 5,000-character answer that was not streamed arrives complete and in order", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    const answer = longAnswer(5000);

    const turn = runTurn(adapter, [], answer);
    await expect(turn.outcome).resolves.toEqual({
      stopReason: "completed",
      finalMessage: answer,
    });

    expect(api.calls).toEqual(["send", "send"]);
    expect(api.texts(GROUP).join("\n")).toBe(answer);
  });

  test("a rejected streaming edit does not fail the turn", async () => {
    const api = new FakeBotApi();
    const { adapter, logs } = setup(api);
    const rejection = rateLimited(20);
    api.editErrors.push(rejection);

    const turn = runTurn(adapter, ["The answer", " is forty", "-two."], "The answer is forty-two.");
    await expect(turn.outcome).resolves.toEqual({
      stopReason: "completed",
      finalMessage: "The answer is forty-two.",
    });

    expect(logs).toEqual([`telegram: edit skipped: ${String(rejection)}`]);
    expect(api.texts(GROUP)).toEqual(["The answer is forty-two."]);
  });

  test("a rejected final edit is retried after retry_after, then delivered as a new message", async () => {
    const api = new FakeBotApi();
    const { adapter, sleeps } = setup(api);

    // The only edit of this turn is the final one: the prompt streams one
    // delta and completes with a longer final message.
    api.editErrors.push(rateLimited(2), rateLimited(2));
    const turn = runTurn(adapter, ["The answer"], "The answer is forty-two.");
    await expect(turn.outcome).resolves.toEqual({
      stopReason: "completed",
      finalMessage: "The answer is forty-two.",
    });

    expect(sleeps).toEqual([2000]);
    expect(api.calls).toEqual(["send", "edit:101", "edit:101", "send"]);
    expect(api.texts(GROUP)).toEqual(["The answer", "The answer is forty-two."]);
  });

  test("when the final edit and its fallback both fail the turn is a delivery failure", async () => {
    const api = new FakeBotApi();
    const { adapter } = setup(api);
    // Shaped like the daemon's "agent gone" error on purpose: the router
    // replays a prompt that failed this way on a fresh session, and must not
    // do that for a failed delivery.
    const fallbackError = Object.assign(new Error("agent not found"), {
      data: { code: "AGENT_NOT_FOUND" },
    });
    api.editErrors.push(new Error("socket hang up"));
    // The streamed delta is sent; the fallback for the final text is refused.
    api.sendErrors.push(PASS, fallbackError);

    const turn = runTurn(adapter, ["The answer"], "The answer is forty-two.");
    await expect(turn.outcome).rejects.toBe(fallbackError);

    expect(turn.prompts()).toBe(1);
    expect(api.calls).toEqual(["send", "edit:101", "send"]);
    expect(api.texts(GROUP)).toEqual(["The answer"]);
  });
});

describe("TelegramBotApiError", () => {
  function transportAnswering(body: unknown): FetchTelegramTransport {
    const fakeFetch = (async () =>
      ({ status: 429, json: async () => body }) as Response) as unknown as typeof fetch;
    return new FetchTelegramTransport({ token: "1:AAA", fetchImpl: fakeFetch });
  }

  test("carries error_code and parameters.retry_after from the Bot API", async () => {
    const transport = transportAnswering({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 7",
      parameters: { retry_after: 7 },
    });

    const error = await transport.editMessageText("1", 2, "x").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TelegramBotApiError);
    expect(error).toMatchObject({
      message: "Telegram editMessageText failed: Too Many Requests: retry after 7",
      errorCode: 429,
      retryAfterSeconds: 7,
    });
  });

  test("leaves both unset when the response has neither", async () => {
    const error = await transportAnswering({ ok: false, description: "Unauthorized" })
      .sendMessage("1", "x")
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(TelegramBotApiError);
    expect((error as TelegramBotApiError).message).toBe(
      "Telegram sendMessage failed: Unauthorized",
    );
    expect((error as TelegramBotApiError).errorCode).toBeUndefined();
    expect((error as TelegramBotApiError).retryAfterSeconds).toBeUndefined();
  });

  test("ignores values of the wrong type", async () => {
    const error = await transportAnswering({
      ok: false,
      error_code: "429",
      parameters: { retry_after: "soon" },
    })
      .sendMessage("1", "x")
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect((error as TelegramBotApiError).message).toBe(
      "Telegram sendMessage failed: 429",
    );
    expect((error as TelegramBotApiError).errorCode).toBeUndefined();
    expect((error as TelegramBotApiError).retryAfterSeconds).toBeUndefined();
  });

  test("still works as a plain error with only a message", () => {
    const error = new TelegramBotApiError("invalid Telegram bot token format");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("invalid Telegram bot token format");
    expect(String(error)).toBe("Error: invalid Telegram bot token format");
    expect(error.errorCode).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});
