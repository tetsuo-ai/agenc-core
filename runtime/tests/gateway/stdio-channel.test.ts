// Stdio dev channel (TODO task 7): line-in → inbound message, outbound → prefixed lines.

import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { StdioChannelAdapter } from "../../src/gateway/stdio-channel.js";
import type {
  ChannelAdapterContext,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

function collector(): {
  ctx: ChannelAdapterContext;
  messages: InboundChannelMessage[];
} {
  const messages: InboundChannelMessage[] = [];
  return {
    messages,
    ctx: {
      async onMessage(message) {
        messages.push(message);
      },
    },
  };
}

describe("StdioChannelAdapter", () => {
  test("each stdin line becomes one inbound DM from the local sender", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new StdioChannelAdapter({ input, output });
    const { ctx, messages } = collector();
    await adapter.start(ctx);

    input.write("hello\n");
    input.write("   \n"); // blank line ignored
    input.write("second line\n");
    await new Promise((r) => setTimeout(r, 10));
    await adapter.stop();

    expect(messages.map((m) => m.text)).toEqual(["hello", "second line"]);
    expect(messages[0]).toMatchObject({
      channelId: "stdio",
      sender: { peerId: "local" },
      conversation: { kind: "dm", id: "stdio" },
    });
  });

  test("outbound is written with the prefix, one line per newline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    const adapter = new StdioChannelAdapter({ input, output });
    await adapter.start(collector().ctx);

    await adapter.send({ conversationId: "stdio", text: "line one\nline two" });
    await adapter.stop();

    const out = chunks.join("");
    expect(out).toBe("agent> line one\nagent> line two\n");
  });
});
