import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";

import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";

test("a second DeepSeek POST finishes while the first HTTPS stream remains open", async () => {
  // Public test-only credentials, never used outside this loopback server.
  const cert = readFileSync(new URL("./fixtures/localhost.crt", import.meta.url));
  const key = readFileSync(new URL("./fixtures/localhost.key", import.meta.url));
  const server = createSecureServer({ cert, key, allowHTTP1: true });
  const protocols: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const model = "deepseek-v4-pro";
  const frame = (text: string, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: "concurrent", model, choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }] })}\n\n`;
  server.on("request", (request, response) => {
    protocols.push(request.httpVersion);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame("ready"));
      const finish = () => response.end(frame("", "stop") + "data: [DONE]\n\n");
      if (!releaseFirst) {
        releaseFirst = finish;
        firstStarted();
      } else {
        finish();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = getGlobalDispatcher();
  // Advertise HTTP/2 as the default and retain verified TLS trust. Before the
  // fix, Node fetch queues the second request body until releaseFirst runs.
  const dispatcher = new Agent({ allowH2: true, connect: { ca: cert } });
  setGlobalDispatcher(dispatcher);
  const controller = new AbortController();
  let first: Promise<unknown> | undefined;
  try {
    const provider = new DeepSeekProvider({
      apiKey: "local-test-only",
      model,
      baseURL: `https://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    const options = { reasoningEffort: "low", singleWireAttempt: true, signal: controller.signal };
    let firstFinished = false;
    first = provider.chatStream([{ role: "user", content: "first" }], () => undefined, options)
      .then(() => { firstFinished = true; });
    await Promise.race([started, first.then(() => { throw new Error("First stream ended before opening"); })]);
    const second = await provider.chatStream([{ role: "user", content: "second" }], () => undefined, {
      ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    });
    expect(second.content).toBe("ready");
    expect(firstFinished).toBe(false);
    expect(protocols).toEqual(["1.1", "1.1"]);
    expect(getGlobalDispatcher()).toBe(dispatcher);
    releaseFirst!();
    await first;
  } finally {
    controller.abort();
    releaseFirst?.();
    await first?.catch(() => undefined);
    setGlobalDispatcher(previous);
    await dispatcher.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);
