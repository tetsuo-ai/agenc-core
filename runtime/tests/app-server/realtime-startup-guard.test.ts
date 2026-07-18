import { describe, expect, test } from "vitest";
import { AsyncQueue } from "../utils/async-queue.js";
import {
  RealtimeConversationManager,
  type RealtimeAudioFrame,
  type RealtimeEvent,
  type RealtimeTransportRequest,
  type RealtimeWriter,
} from "../conversation/realtime/conversation.js";
import { type JsonObject } from "./protocol/index.js";
import {
  AgenCRealtimeRpcService,
  TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
} from "./realtime.js";

describe("AgenC realtime startup guard", () => {
  test("stop() during deferred startup cancels cleanly without orphaning the session", async () => {
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    // Fire a stop() at the moment the transport connects: by then the deferred
    // startup has passed its initial cancellation check and brought the session
    // up, so the post-registration guard check must tear it back down.
    const binding = createRealtimeBinding({
      onConnect: () => {
        void realtime.stop({ threadId: "thread_1" });
      },
    });
    realtime.registerThread(binding.thread);

    const notifications: JsonObject[] = [];
    await realtime.start(
      { threadId: "thread_1", outputModality: "audio" },
      { sendNotification: (notification) => notifications.push(notification) },
    );

    // The deferred startup runs on the next tick. It should observe the
    // cancellation and tear the session down rather than orphaning it.
    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === "thread/realtime/closed" &&
            (notification.params as JsonObject).reason === "requested",
        ),
      "closed notification with requested reason",
    );

    // No orphaned session: the conversation is not running and the transport
    // event stream has been closed.
    await expect(binding.thread.conversation.runningState()).resolves.toBe(
      undefined,
    );
    expect(binding.events.isClosed).toBe(true);
    // Exactly one transport connection was opened and then closed.
    expect(binding.transportRequests).toHaveLength(1);
    // No spurious "started" notification was delivered for the cancelled run.
    expect(
      notifications.filter(
        (notification) => notification.method === "thread/realtime/started",
      ),
    ).toHaveLength(0);
  });

  test("stop() before deferred startup connects short-circuits the startup", async () => {
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    const binding = createRealtimeBinding({ blockConnect: true });
    realtime.registerThread(binding.thread);

    const notifications: JsonObject[] = [];
    await realtime.start(
      { threadId: "thread_1", outputModality: "audio" },
      { sendNotification: (notification) => notifications.push(notification) },
    );
    await realtime.stop({ threadId: "thread_1" });

    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === "thread/realtime/closed" &&
            (notification.params as JsonObject).reason === "requested",
        ),
      "closed notification with requested reason",
    );

    // The transport was never asked to connect because the guard was already
    // cancelled when the deferred startup ran.
    expect(binding.transportRequests).toHaveLength(0);
    await expect(binding.thread.conversation.runningState()).resolves.toBe(
      undefined,
    );
  });
});

function createRealtimeBinding(
  options: {
    readonly blockConnect?: boolean;
    readonly onConnect?: () => void;
  } = {},
) {
  const events = new AsyncQueue<RealtimeEvent>();
  const transportRequests: RealtimeTransportRequest[] = [];
  const writer = createRealtimeWriter();
  const conversation = new RealtimeConversationManager();
  return {
    events,
    transportRequests,
    writer,
    thread: {
      threadId: "thread_1",
      conversation,
      connectTransport: (request: RealtimeTransportRequest) => {
        transportRequests.push(request);
        if (options.blockConnect === true) {
          // Never resolves; the guard cancellation must short-circuit before
          // we even attempt to connect, so this should not be reached.
          return new Promise<never>(() => {});
        }
        options.onConnect?.();
        return {
          writer,
          providerSdp: request.providerSdp,
          nextEvent: () => events.recv(),
          close: () => events.close(),
        };
      },
    },
  };
}

function createRealtimeWriter(): RealtimeWriter & {
  readonly audioFrames: RealtimeAudioFrame[];
  readonly textItems: string[];
} {
  const audioFrames: RealtimeAudioFrame[] = [];
  const textItems: string[] = [];
  return {
    audioFrames,
    textItems,
    sendAudioFrame: (frame) => {
      audioFrames.push(frame);
    },
    sendConversationItemCreate: (text) => {
      textItems.push(text);
    },
    sendConversationFunctionCallOutput: () => {},
    sendResponseCreate: () => {},
    sendPayload: () => {},
  };
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
