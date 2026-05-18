import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  AgenCStdioTransport,
  encodeJsonLine,
  parseJsonObjectLine,
  writeJsonLine,
} from "./transport/stdio.js";

function nextChunk(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    stream.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

describe("AgenC stdio transport", () => {
  it("encodes one compact JSON message per newline", () => {
    const line = encodeJsonLine({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });
  });

  it("parses JSON object lines and rejects malformed frames", () => {
    expect(
      parseJsonObjectLine(
        '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}',
      ),
    ).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "agent.list",
      params: {},
    });

    expect(() => parseJsonObjectLine("")).toThrow(/empty JSON line/);
    expect(() => parseJsonObjectLine("[]")).toThrow(/expected a JSON object/);
    expect(() => parseJsonObjectLine("{")).toThrow(SyntaxError);
  });

  it("reads newline-delimited requests from input and writes responses to output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
      });
      transport.start();
    });

    input.write(
      '{"jsonrpc":"2.0","id":7,"method":"message.send","params":{"sessionId":"session_1","content":"hello"}}\n',
    );

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      method: "message.send",
      params: { sessionId: "session_1", content: "hello" },
    });

    await writeJsonLine(output, {
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      result: { messageId: "message_1", acceptedAt: "now" },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"messageId":"message_1","acceptedAt":"now"}}\n',
    );
  });

  it("reports bad input lines without stopping subsequent valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: readonly Error[] = [];
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
        onError: (error) => {
          (errors as Error[]).push(error);
        },
      });
      transport.start();
    });

    input.write("not-json\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"auth.whoami"}\n');

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      method: "auth.whoami",
    });
    expect(errors).toHaveLength(1);
  });

  it("can send through the transport instance", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: () => {},
    });

    await transport.send({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      result: { authenticated: false },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":3,"result":{"authenticated":false}}\n',
    );
  });
});
