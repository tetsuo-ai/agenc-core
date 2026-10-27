import { expect, test, vi } from "vitest";
import { observeStreamTransportActivity, withStreamTransportActivity } from "../../src/llm/stream-transport-activity.js";

test("leaves responses outside a sampling attempt untouched", () => {
  const response = new Response("hello");
  expect(observeStreamTransportActivity(response)).toBe(response);
});

test("concurrent response consumers retain their own observer outside the async scope", async () => {
  const first = vi.fn(); const second = vi.fn();
  const wrap = (observer: () => void, content: string) => withStreamTransportActivity(observer, async () => {
    await Promise.resolve();
    const response = new Response(content, { headers: { "content-type": "text/event-stream" } });
    Object.defineProperty(response, "url", { value: "https://provider.test/stream" });
    return observeStreamTransportActivity(response);
  });
  const [a, b] = await Promise.all([wrap(first, ": keepalive\n\n"), wrap(second, ": ping\n\n")]);
  expect(first).toHaveBeenCalledTimes(1); // Headers.
  expect(second).toHaveBeenCalledTimes(1);
  expect(await a.text()).toBe(": keepalive\n\n");
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(1);
  expect(await b.text()).toBe(": ping\n\n");
  expect(second).toHaveBeenCalledTimes(2);
  expect(a.url).toBe("https://provider.test/stream");
  expect(a.headers.get("content-type")).toBe("text/event-stream");
});

test("does not prefetch and forwards cancellation to the original body", async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array([58])));
  const cancel = vi.fn();
  const onBytes = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const response = await withStreamTransportActivity(onBytes, async () => observeStreamTransportActivity(new Response(body)));
  expect(pull).not.toHaveBeenCalled();
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([58]));
  expect(pull).toHaveBeenCalledTimes(1);
  await reader.cancel("user stop");
  expect(cancel).toHaveBeenCalledWith("user stop");
  expect(body.locked).toBe(false);
});
