// Telegram adapter update dispatch (#3439): pollOnce() hands updates over
// without waiting for the agent turn. One conversation stays in arrival
// order, different conversations run side by side under a limit, a
// owner control command is never held back, and stop() waits for what is
// running. Handlers are held open with promises the test settles, so nothing
// here waits on a clock.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TelegramOwnerControl } from "../../src/gateway/control-plane.js";
import { ChannelGateway } from "../../src/gateway/gateway.js";
import {
  TelegramChannelAdapter,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/gateway/telegram-channel.js";
import type {
  ChannelAdapterContext,
  GatewayDaemonClient,
  GatewayPromptResult,
  GatewaySession,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

const GROUP_A = -1001;
const GROUP_B = -1002;
const GROUP_C = -1003;
const OWNER = 555;
const STRANGER = 777;

/** Stands in for the owner control plane: the owner's private-chat commands. */
const ownerCommands = (message: InboundChannelMessage): boolean =>
  message.sender.peerId === String(OWNER);

function update(
  id: number,
  chatId: number,
  text: string | undefined,
  threadId?: number,
): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: chatId > 0 ? chatId : 7000 + id, first_name: `user${id}` },
      chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
      ...(text !== undefined ? { text } : {}),
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Fake Bot API whose getUpdates answers from a list the test fills. */
class BatchTransport implements TelegramTransport {
  readonly batches: TelegramUpdate[][] = [];
  readonly offsets: number[] = [];
  readonly sent: { chatId: string; text: string }[] = [];

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    return this.batches.shift() ?? [];
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { message_id: 100 + this.sent.length };
  }
  async editMessageText(): Promise<void> {}
}

/**
 * Fake Bot API with a real long poll: getUpdates stays pending until the
 * test pushes a batch, which is how the background loop is driven.
 */
class LongPollTransport implements TelegramTransport {
  readonly offsets: number[] = [];
  readonly #ready: TelegramUpdate[][] = [];
  readonly #waiting: ((updates: TelegramUpdate[]) => void)[] = [];

  getUpdates(offset: number): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    const ready = this.#ready.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
  push(batch: TelegramUpdate[]): void {
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) waiting(batch);
    else this.#ready.push(batch);
  }
  async sendMessage() {
    return { message_id: 1 };
  }
  async editMessageText(): Promise<void> {}
}

/** A gateway stand-in whose handlers stay pending until the test settles them. */
function heldHandlers() {
  const started: string[] = [];
  const finished: string[] = [];
  const gates = new Map<string, Deferred<void>>();
  let running = 0;
  let peak = 0;
  const gate = (text: string): Deferred<void> => {
    const found = gates.get(text);
    if (found === undefined) throw new Error(`no handler started for "${text}"`);
    return found;
  };
  const context: ChannelAdapterContext = {
    async onMessage(message: InboundChannelMessage) {
      started.push(message.text);
      const held = deferred<void>();
      gates.set(message.text, held);
      running += 1;
      peak = Math.max(peak, running);
      try {
        await held.promise;
        finished.push(message.text);
      } finally {
        running -= 1;
      }
    },
  };
  return {
    context,
    /** Message texts in the order their handlers started. */
    started,
    /** Message texts in the order their handlers finished. */
    finished,
    /** Most handlers that were ever running at the same moment. */
    peak: () => peak,
    async release(text: string): Promise<void> {
      gate(text).resolve();
      await nextEventLoopTurn();
    },
    async fail(text: string, error: unknown): Promise<void> {
      gate(text).reject(error);
      await nextEventLoopTurn();
    },
    releaseAll(): void {
      for (const held of gates.values()) held.resolve();
    },
  };
}

/** One poll, then one turn of the event loop so every handed-over update has started. */
async function poll(adapter: TelegramChannelAdapter): Promise<void> {
  await adapter.pollOnce();
  await nextEventLoopTurn();
}

describe("TelegramChannelAdapter update dispatch", () => {
  test("pollOnce() returns while the turn is still running", async () => {
    const transport = new BatchTransport();
    transport.batches.push([update(1, GROUP_A, "question")]);
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["question"]);
    expect(held.finished).toEqual([]);

    let idle = false;
    const whenIdle = adapter.whenIdle().then(() => {
      idle = true;
    });
    await nextEventLoopTurn();
    expect(idle).toBe(false);

    await held.release("question");
    await whenIdle;
    expect(held.finished).toEqual(["question"]);
    await adapter.stop();
  });

  test("whenIdle() resolves at once when nothing is pending", async () => {
    const adapter = new TelegramChannelAdapter({
      transport: new BatchTransport(),
      autoPoll: false,
    });
    await adapter.start(heldHandlers().context);
    await expect(adapter.whenIdle()).resolves.toBeUndefined();
    await adapter.stop();
  });

  test("different conversations run at the same time", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "group A"),
      update(2, GROUP_B, "group B"),
      update(3, GROUP_C, "topic 7", 7),
      update(4, GROUP_C, "topic 8", 8),
    ]);
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    // All four are running before any of them has finished.
    expect(held.started).toEqual(["group A", "group B", "topic 7", "topic 8"]);
    expect(held.finished).toEqual([]);
    expect(held.peak()).toBe(4);

    held.releaseAll();
    await adapter.whenIdle();
    expect(held.finished).toHaveLength(4);
    await adapter.stop();
  });

  test("one conversation is handled strictly in arrival order", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [
        update(1, GROUP_A, "a1"),
        update(2, GROUP_B, "b1"),
        update(3, GROUP_A, "a2"),
        update(4, GROUP_C, "t7-1", 7),
        update(5, GROUP_C, "t7-2", 7),
      ],
      [update(6, GROUP_A, "a3")],
    );
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    await poll(adapter);
    // The second message of a chat, and of a topic, waits for the first.
    expect(held.started).toEqual(["a1", "b1", "t7-1"]);

    // Finishing another conversation does not let a2 jump ahead of a1.
    await held.release("b1");
    expect(held.started).toEqual(["a1", "b1", "t7-1"]);

    await held.release("a1");
    expect(held.started).toEqual(["a1", "b1", "t7-1", "a2"]);
    await held.release("t7-1");
    expect(held.started).toEqual(["a1", "b1", "t7-1", "a2", "t7-2"]);
    await held.release("a2");
    expect(held.started).toEqual(["a1", "b1", "t7-1", "a2", "t7-2", "a3"]);

    held.releaseAll();
    await adapter.whenIdle();
    expect(held.finished).toEqual(["b1", "a1", "t7-1", "a2", "t7-2", "a3"]);
    await adapter.stop();
  });

  test("the owner's private /stop is handled while another chat's turn is still running", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [update(1, GROUP_A, "long question"), update(2, GROUP_B, "queued question")],
      [update(3, OWNER, "/stop")],
    );
    // One slot only: the group turn fills it and a second chat is waiting.
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      isControlMessage: ownerCommands,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["long question"]);

    await poll(adapter);
    // /stop started although the slot is taken and an older update waits.
    expect(held.started).toEqual(["long question", "/stop"]);
    await held.release("/stop");
    expect(held.finished).toEqual(["/stop"]);
    // The command did not use the slot, so it frees none either.
    expect(held.started).toEqual(["long question", "/stop"]);

    await held.release("long question");
    expect(held.started).toEqual(["long question", "/stop", "queued question"]);
    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("an owner command does not wait for its own chat either", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, OWNER, "summarize the repo"),
      update(2, OWNER, "and the tests"),
      update(3, OWNER, "  /status"),
    ]);
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      isControlMessage: ownerCommands,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    // Plain private messages keep their order; the command goes straight in.
    expect(held.started).toEqual(["summarize the repo", "  /status"]);

    await held.release("  /status");
    expect(held.started).toEqual(["summarize the repo", "  /status"]);
    await held.release("summarize the repo");
    expect(held.started).toEqual([
      "summarize the repo",
      "  /status",
      "and the tests",
    ]);
    await held.release("and the tests");
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("a group command takes its turn like any other group message", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "long question"),
      update(2, GROUP_B, "/stop"),
    ]);
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["long question"]);
    await held.release("long question");
    expect(held.started).toEqual(["long question", "/stop"]);

    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("a private command from anyone else takes its turn", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "long question"),
      update(2, STRANGER, "/stop"),
      update(3, OWNER, "/stop"),
    ]);
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      isControlMessage: ownerCommands,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    // Only the owner's command skips the limit; the stranger's waits.
    expect(held.started).toEqual(["long question", "/stop"]);
    expect(held.peak()).toBe(2);

    held.releaseAll();
    await nextEventLoopTurn();
    held.releaseAll();
    await adapter.whenIdle();
    expect(held.finished).toHaveLength(3);
    await adapter.stop();
  });

  test("without a control predicate no message skips the limit", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "long question"),
      update(2, OWNER, "/stop"),
    ]);
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["long question"]);
    await held.release("long question");
    expect(held.started).toEqual(["long question", "/stop"]);

    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("a flood of private commands from strangers stays within the limit and the queue", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      Array.from({ length: 50 }, (_, index) =>
        update(index + 1, 9000 + index, `/x${index}`),
      ),
    );
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      maxQueuedUpdates: 0,
      isControlMessage: ownerCommands,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["/x0"]);
    expect(held.peak()).toBe(1);
    expect(logs).toHaveLength(49);
    expect(logs[0]).toBe(
      "telegram: update queue full (0 waiting), dropped update 2",
    );

    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("the control predicate is asked only about private-chat commands", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "/stop"),
      update(2, OWNER, "plain text"),
      update(3, OWNER, "/status"),
    ]);
    const asked: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      isControlMessage: (message) => {
        asked.push(`${message.conversation.kind}:${message.text}`);
        return false;
      },
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(asked).toEqual(["dm:/status"]);
    // Refused by the predicate, so it keeps its place behind "plain text".
    expect(held.started).toEqual(["/stop", "plain text"]);

    held.releaseAll();
    await nextEventLoopTurn();
    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("at most maxConcurrentUpdates handlers run at once", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [1, 2, 3, 4, 5].map((id) => update(id, -2000 - id, `chat ${id}`)),
    );
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 2,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["chat 1", "chat 2"]);

    // Each finished turn admits exactly one waiting update, oldest first.
    await held.release("chat 2");
    expect(held.started).toEqual(["chat 1", "chat 2", "chat 3"]);
    await held.release("chat 1");
    expect(held.started).toEqual(["chat 1", "chat 2", "chat 3", "chat 4"]);
    await held.release("chat 3");
    await held.release("chat 4");
    await held.release("chat 5");
    await adapter.whenIdle();

    expect(held.finished).toHaveLength(5);
    expect(held.peak()).toBe(2);
    await adapter.stop();
  });

  test("four handlers run at once by default", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [1, 2, 3, 4, 5, 6].map((id) => update(id, -2000 - id, `chat ${id}`)),
    );
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["chat 1", "chat 2", "chat 3", "chat 4"]);

    for (const id of [1, 2, 3, 4, 5, 6]) await held.release(`chat ${id}`);
    await adapter.whenIdle();
    expect(held.finished).toHaveLength(6);
    expect(held.peak()).toBe(4);
    await adapter.stop();
  });

  test("a limit below one still lets one handler run", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "first"),
      update(2, GROUP_B, "second"),
    ]);
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 0,
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["first"]);
    await held.release("first");
    expect(held.started).toEqual(["first", "second"]);

    held.releaseAll();
    await adapter.whenIdle();
    expect(held.peak()).toBe(1);
    await adapter.stop();
  });

  test("a full waiting queue drops the newest update with one log line and no reply", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [1, 2, 3, 4, 5].map((id) => update(id, -2000 - id, `chat ${id}`)),
    );
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      maxQueuedUpdates: 2,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    // One running, two waiting, the two newest dropped.
    expect(held.started).toEqual(["chat 1"]);
    expect(logs).toEqual([
      "telegram: update queue full (2 waiting), dropped update 4",
      "telegram: update queue full (2 waiting), dropped update 5",
    ]);

    await held.release("chat 1");
    await held.release("chat 2");
    await held.release("chat 3");
    await adapter.whenIdle();
    expect(held.started).toEqual(["chat 1", "chat 2", "chat 3"]);
    expect(transport.sent).toEqual([]);
    expect(logs).toHaveLength(2);

    // The queue has room again, and the dropped updates are not fetched twice.
    transport.batches.push([update(6, GROUP_A, "after the flood")]);
    await poll(adapter);
    expect(transport.offsets).toEqual([0, 6]);
    expect(held.started).toEqual(["chat 1", "chat 2", "chat 3", "after the flood"]);
    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("a queue bound of zero keeps nothing waiting", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "first"),
      update(2, GROUP_A, "second"),
    ]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxQueuedUpdates: 0,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["first"]);
    expect(logs).toEqual([
      "telegram: update queue full (0 waiting), dropped update 2",
    ]);

    held.releaseAll();
    await adapter.whenIdle();
    expect(held.started).toEqual(["first"]);
    await adapter.stop();
  });

  test("a chat that floods the queue loses its own messages, not the other chats'", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "A1"),
      update(2, GROUP_A, "A2", 11),
      update(3, GROUP_A, "A3", 12),
      update(4, GROUP_A, "A4", 13),
      // The queue (3 places) is full of group A, two of them in forum topics.
      update(5, GROUP_B, "B1"),
      update(6, GROUP_C, "C1"),
      // Now A, B and C hold one place each: the newcomer's own chat is as
      // busy as any other, so the newcomer is the one dropped.
      update(7, GROUP_B, "B2"),
      update(8, OWNER, "plain owner text"),
    ]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      maxQueuedUpdates: 3,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["A1"]);
    expect(logs).toEqual([
      // B1 arrives: group A holds 3 places, so its newest (A4) goes.
      "telegram: update queue full (3 waiting), dropped update 4",
      // C1 arrives: group A still holds 2, so A3 goes.
      "telegram: update queue full (3 waiting), dropped update 3",
      "telegram: update queue full (3 waiting), dropped update 7",
      "telegram: update queue full (3 waiting), dropped update 8",
    ]);

    // What is left runs in arrival order.
    await held.release("A1");
    await held.release("A2");
    await held.release("B1");
    await held.release("C1");
    await adapter.whenIdle();
    expect(held.started).toEqual(["A1", "A2", "B1", "C1"]);
    await adapter.stop();
  });

  test("by default a hundred updates wait and the next one is dropped", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      Array.from({ length: 105 }, (_, index) =>
        update(index + 1, -5000 - index, `chat ${index + 1}`),
      ),
    );
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toHaveLength(4);
    expect(logs).toEqual([
      "telegram: update queue full (100 waiting), dropped update 105",
    ]);

    // The hundred that waited all run once slots free up.
    for (let round = 0; round < 110 && held.finished.length < 104; round += 1) {
      held.releaseAll();
      await nextEventLoopTurn();
    }
    await adapter.whenIdle();
    expect(held.finished).toHaveLength(104);
    expect(held.peak()).toBe(4);
    await adapter.stop();
  });

  test("the offset advances once per update, whatever happens to the update", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(10, GROUP_A, undefined), // ignored: no text
      update(11, GROUP_A, "handled"),
      update(12, GROUP_A, "dropped"),
      update(13, OWNER, "/status"), // control lane
      update(14, GROUP_B, "dropped too"),
    ]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      maxQueuedUpdates: 0,
      isControlMessage: ownerCommands,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    // The next request confirms all five although a handler is still running.
    await poll(adapter);
    expect(transport.offsets).toEqual([0, 15]);
    expect(held.started).toEqual(["handled", "/status"]);
    expect(logs).toEqual([
      "telegram: update queue full (0 waiting), dropped update 12",
      "telegram: update queue full (0 waiting), dropped update 14",
    ]);

    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("a failing handler is logged once and the next updates still run", async () => {
    const transport = new BatchTransport();
    transport.batches.push(
      [update(1, GROUP_A, "boom"), update(2, GROUP_A, "after boom")],
      [update(3, GROUP_B, "next poll")],
    );
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    await held.fail("boom", new Error("turn exploded"));
    expect(logs).toEqual([
      "telegram: update 1 handler failed: Error: turn exploded",
    ]);
    // The failure released the conversation: its next message is running.
    expect(held.started).toEqual(["boom", "after boom"]);

    await poll(adapter);
    expect(held.started).toEqual(["boom", "after boom", "next poll"]);
    expect(transport.offsets).toEqual([0, 3]);

    held.releaseAll();
    await adapter.whenIdle();
    expect(held.finished).toEqual(["after boom", "next poll"]);
    expect(logs).toHaveLength(1);
    await adapter.stop();
  });

  test("a handler that throws before returning a promise is contained too", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "throws"),
      update(2, GROUP_A, "survives"),
    ]);
    const logs: string[] = [];
    const seen: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      log: (line) => logs.push(line),
    });
    await adapter.start({
      onMessage(message) {
        seen.push(message.text);
        if (message.text === "throws") throw new Error("not even a promise");
        return Promise.resolve();
      },
    });

    await expect(adapter.pollOnce()).resolves.toBeUndefined();
    await adapter.whenIdle();
    expect(seen).toEqual(["throws", "survives"]);
    expect(logs).toEqual([
      "telegram: update 1 handler failed: Error: not even a promise",
    ]);
    await adapter.stop();
  });

  test("a malformed update is logged and the rest of the batch still runs", async () => {
    const transport = new BatchTransport();
    const malformed = {
      update_id: 1,
      message: { message_id: 1, from: { id: 9 }, text: "no chat" },
    } as unknown as TelegramUpdate;
    transport.batches.push([malformed, update(2, GROUP_A, "well formed")]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(held.started).toEqual(["well formed"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^telegram: update 1 skipped: TypeError: /);

    held.releaseAll();
    await adapter.whenIdle();
    await poll(adapter);
    expect(transport.offsets).toEqual([0, 3]);
    await adapter.stop();
  });

  test("a malformed update at the end of a batch is not fetched again", async () => {
    const transport = new BatchTransport();
    const malformed = {
      update_id: 2,
      message: { message_id: 2, from: { id: 9 }, text: "no chat" },
    } as unknown as TelegramUpdate;
    transport.batches.push([update(1, GROUP_A, "well formed"), malformed]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);

    await poll(adapter);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^telegram: update 2 skipped: TypeError: /);
    // Nothing after the malformed update moves the offset past it: it has to
    // have moved before the update was looked at.
    await poll(adapter);
    expect(transport.offsets).toEqual([0, 3]);

    held.releaseAll();
    await adapter.whenIdle();
    await adapter.stop();
  });

  test("the poll loop keeps polling during a turn and after a handler error", async () => {
    const transport = new LongPollTransport();
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);
    await nextEventLoopTurn();
    expect(transport.offsets).toEqual([0]);

    transport.push([update(1, GROUP_A, "slow turn"), update(2, GROUP_B, "boom")]);
    await nextEventLoopTurn();
    // The loop is already asking for more while both turns are still open.
    expect(transport.offsets).toEqual([0, 3]);
    expect(held.finished).toEqual([]);

    await held.fail("boom", new Error("turn exploded"));
    transport.push([update(3, GROUP_C, "second batch")]);
    await nextEventLoopTurn();
    expect(held.started).toEqual(["slow turn", "boom", "second batch"]);
    expect(transport.offsets).toEqual([0, 3, 4]);
    expect(logs).toEqual([
      "telegram: update 2 handler failed: Error: turn exploded",
    ]);

    held.releaseAll();
    const stopping = adapter.stop();
    transport.push([]);
    await stopping;
    expect(held.finished).toEqual(["slow turn", "second batch"]);
  });

  test("stop() drops waiting updates and waits for running handlers", async () => {
    const transport = new BatchTransport();
    transport.batches.push([
      update(1, GROUP_A, "running"),
      update(2, GROUP_A, "waiting behind it"),
      update(3, GROUP_B, "waiting for a slot"),
      update(4, OWNER, "/status"),
    ]);
    const logs: string[] = [];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      isControlMessage: ownerCommands,
      log: (line) => logs.push(line),
    });
    const held = heldHandlers();
    await adapter.start(held.context);
    await poll(adapter);
    expect(held.started).toEqual(["running", "/status"]);

    let stopped = false;
    const stopping = adapter.stop().then(() => {
      stopped = true;
    });
    await nextEventLoopTurn();
    expect(stopped).toBe(false);
    expect(logs).toEqual(["telegram: stop dropped 2 waiting update(s)"]);

    // Both running handlers, the command included, hold stop() open.
    await held.release("running");
    expect(stopped).toBe(false);
    await held.release("/status");
    await stopping;
    expect(stopped).toBe(true);

    // Nothing that was only waiting ever reached the gateway.
    expect(held.started).toEqual(["running", "/status"]);
    expect(held.finished).toEqual(["running", "/status"]);
  });

  test("a batch that arrives after stop() is left for the next start", async () => {
    const transport = new LongPollTransport();
    const adapter = new TelegramChannelAdapter({ transport });
    const held = heldHandlers();
    await adapter.start(held.context);
    await nextEventLoopTurn();
    expect(transport.offsets).toEqual([0]);

    // The long poll is in flight when stop() is called, then answers.
    const stopping = adapter.stop();
    transport.push([update(1, GROUP_A, "arrived during stop")]);
    await stopping;
    expect(held.started).toEqual([]);

    // Same offset again: Telegram would deliver the update a second time.
    await adapter.start(held.context);
    await nextEventLoopTurn();
    expect(transport.offsets).toEqual([0, 0]);
    transport.push([update(1, GROUP_A, "arrived during stop")]);
    await nextEventLoopTurn();
    expect(held.started).toEqual(["arrived during stop"]);
    expect(transport.offsets).toEqual([0, 0, 2]);

    held.releaseAll();
    const stoppingAgain = adapter.stop();
    transport.push([]);
    await stoppingAgain;
    expect(held.finished).toEqual(["arrived during stop"]);
  });
});

describe("Telegram owner control through the gateway", () => {
  let home: string | undefined;

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  test("the owner's /stop pauses public replies while a group turn is still running", async () => {
    home = mkdtempSync(join(tmpdir(), "agenc-telegram-dispatch-"));
    const promptStarted = deferred<void>();
    const finishPrompt = deferred<GatewayPromptResult>();
    const prompts: string[] = [];
    const session: GatewaySession = {
      sessionId: "group-session",
      prompt: async (text) => {
        prompts.push(text);
        promptStarted.resolve();
        return finishPrompt.promise;
      },
    };
    const client: GatewayDaemonClient = {
      createSession: async () => session,
      attachSession: async () => session,
      close: async () => {},
    };
    const transport = new BatchTransport();
    const controlLogs: string[] = [];
    const controlPlane = new TelegramOwnerControl({
      agencHome: home,
      adminPeerIds: [String(OWNER)],
      log: (line) => controlLogs.push(line),
    });
    // One slot, held by the group turn: only the control lane gets /stop in.
    // Wired as in run.ts: the control plane says what an owner command is.
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      maxConcurrentUpdates: 1,
      isControlMessage: (message) => controlPlane.isOwnerControlMessage(message),
    });
    const gateway = new ChannelGateway({
      agencHome: home,
      client,
      config: { channels: {}, bindings: [], defaultAgent: "default" },
      controlPlane,
    });
    await gateway.registerAdapter(adapter);
    const publicEnabled = (): unknown =>
      (
        JSON.parse(
          readFileSync(join(home ?? "", "gateway", "control.json"), "utf8"),
        ) as { publicEnabled?: unknown }
      ).publicEnabled;

    // A group member starts a turn that does not finish.
    transport.batches.push([update(1, GROUP_A, "a very long question")]);
    await adapter.pollOnce();
    await promptStarted.promise;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("a very long question");

    // A stranger's private /stop is not an owner command: it waits for the
    // slot like any other message, so nobody has looked at it yet.
    transport.batches.push([update(9, STRANGER, "/stop")]);
    await adapter.pollOnce();
    await nextEventLoopTurn();
    expect(controlLogs).toEqual([]);
    expect(transport.sent).toEqual([]);

    // The owner pauses the bot from the private chat. The reply and the
    // saved state are there although the group turn is still open.
    transport.batches.push([update(2, OWNER, "/stop")]);
    await adapter.pollOnce();
    await vi.waitFor(() => {
      expect(transport.sent).toEqual([
        {
          chatId: String(OWNER),
          text: "Public group replies are PAUSED. Use /start to resume.",
        },
      ]);
    });
    expect(publicEnabled()).toBe(false);

    // While paused, a message from another group starts no turn.
    transport.batches.push([update(3, GROUP_B, "anyone there?")]);
    await adapter.pollOnce();

    finishPrompt.resolve({ stopReason: "completed", finalMessage: "the answer" });
    await adapter.whenIdle();
    expect(prompts).toHaveLength(1);
    expect(transport.sent).toEqual([
      {
        chatId: String(OWNER),
        text: "Public group replies are PAUSED. Use /start to resume.",
      },
      { chatId: String(GROUP_A), text: "the answer" },
    ]);
    // The stranger's command got its turn after the group turn, and was
    // refused there without a reply.
    expect(controlLogs).toEqual([
      `telegram-control: denied owner command '/stop' from '${STRANGER}'`,
    ]);
    await gateway.stop();
  });
});
