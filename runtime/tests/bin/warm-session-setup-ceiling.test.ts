import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWarmSessionSetupCeiling } from "./warm-session-setup-ceiling.js";

const homes: string[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "fx-warm-")); homes.push(path); return path; }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("warm daemon session setup ceiling", () => {
  it("journals the exact body before dispatch and holds the response until setup completes", async () => {
    const dir = home();
    const ceiling = createWarmSessionSetupCeiling(dir, "one");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const setup = vi.fn(async () => { entered(); await ready; });
    ceiling.register(setup);
    const body = '{"model":"deepseek-flash","messages":[]}';
    const response = new Response("ok");
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      const journal = JSON.parse(readFileSync(join(dir, "fx-warm-request-one.jsonl"), "utf8"));
      expect(journal.body).toBe(body);
      expect(journal).not.toHaveProperty("headers");
      expect(statSync(join(dir, "fx-warm-request-one.jsonl")).mode & 0o777).toBe(0o600);
      expect(init?.body).toBe(body);
      expect(setup).not.toHaveBeenCalled();
      return response;
    });
    const fetch = ceiling.wrap(transport);
    let exposed = false;
    const pending = fetch("https://provider.invalid/v1/chat/completions", {
      method: "POST", body, headers: { authorization: "test-secret" },
    }).then((value) => { exposed = true; return value; });
    await started;
    expect(setup).toHaveBeenCalledOnce();
    expect(exposed).toBe(false);
    release();
    expect(await pending).toBe(response);
    await expect(ceiling.wrap(vi.fn<typeof fetch>().mockResolvedValue(new Response("second")))(
      "https://provider.invalid", { method: "POST", body },
    )).resolves.toBeInstanceOf(Response);
    expect(setup).toHaveBeenCalledOnce();
  });

  it("does not consume setup for GET or cross into another session", async () => {
    const dir = home();
    const a = createWarmSessionSetupCeiling(dir, "a");
    const b = createWarmSessionSetupCeiling(dir, "b");
    const setupA = vi.fn(async () => {}); const setupB = vi.fn(async () => {});
    a.register(setupA); b.register(setupB);
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok"));
    await a.wrap(transport)("https://provider.invalid/models");
    expect(setupA).not.toHaveBeenCalled();
    await a.wrap(transport)("https://provider.invalid/chat", { method: "POST", body: "{}" });
    expect(setupA).toHaveBeenCalledOnce(); expect(setupB).not.toHaveBeenCalled();
    await b.wrap(transport)("https://provider.invalid/chat", { method: "POST", body: "{}" });
    expect(setupB).toHaveBeenCalledOnce();
  });

  it("rejects setup failure, cancels the stream and fences later requests", async () => {
    const ceiling = createWarmSessionSetupCeiling(home(), "failure");
    const failure = new Error("setup failed");
    ceiling.register(async () => { throw failure; });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const fetch = ceiling.wrap(transport);
    await expect(fetch("https://provider.invalid/chat", { method: "POST", body: "{}" })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(fetch("https://provider.invalid/chat", { method: "POST", body: "{}" })).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("does not run setup if transport fails", async () => {
    const ceiling = createWarmSessionSetupCeiling(home(), "transport");
    const setup = vi.fn(async () => {}); ceiling.register(setup);
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(ceiling.wrap(transport)("https://provider.invalid/chat", { method: "POST", body: "{}" })).rejects.toThrow("offline");
    expect(setup).not.toHaveBeenCalled();
  });
  it("closes admission synchronously and cancels a late transport without starting setup", async () => {
    const ceiling = createWarmSessionSetupCeiling(home(), "late-transport");
    const setup = vi.fn(async () => {}); ceiling.register(setup);
    let release!: (response: Response) => void;
    const responseReady = new Promise<Response>(resolve => { release = resolve; });
    let signal: AbortSignal | null | undefined;
    const transport = vi.fn<typeof fetch>((_input, init) => { signal = init?.signal; return responseReady; });
    const fetch = ceiling.wrap(transport);
    const pending = fetch("https://provider.invalid/chat", { method: "POST", body: "{}" });
    const rejected = expect(pending).rejects.toThrow("session setup closed");
    await ceiling.close();
    expect(signal?.aborted).toBe(true);
    expect(() => ceiling.register(async () => {})).toThrow("session setup closed");
    await expect(fetch("https://provider.invalid/chat", { method: "POST", body: "{}" })).rejects.toThrow("session setup closed");
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel })));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(setup).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("joins an already running callback and prevents subsequent setup and response delivery", async () => {
    const ceiling = createWarmSessionSetupCeiling(home(), "in-flight");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    ceiling.register(async () => { entered(); await gate; });
    const next = vi.fn(async () => {}); ceiling.register(next);
    const cancel = vi.fn();
    const fetch = ceiling.wrap(vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const rejected = expect(fetch("https://provider.invalid/chat", { method: "POST", body: "{}" })).rejects.toThrow("session setup closed");
    await started;
    let closed = false;
    const closing = ceiling.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await closing; await rejected;
    expect(next).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    await expect(ceiling.close()).resolves.toBeUndefined();
  });

  it("publishes the drain before reentrant closure and preserves caller/session signal isolation", async () => {
    const dir = home(); const a = createWarmSessionSetupCeiling(dir, "reentrant");
    const b = createWarmSessionSetupCeiling(dir, "independent");
    let closing: Promise<void> | undefined, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let closed = false;
    a.register(async () => { closing = a.close().then(() => { closed = true; }); entered(); await gate; });
    const caller = new AbortController(); let combined: AbortSignal | null | undefined;
    const transport = vi.fn<typeof fetch>(async (_input, init) => { combined = init?.signal; return new Response("ok"); });
    const rejected = expect(a.wrap(transport)("https://provider.invalid/chat", { method: "POST", body: "{}", signal: caller.signal })).rejects.toThrow("session setup closed");
    await started;
    expect(closed).toBe(false); expect(combined?.aborted).toBe(true); expect(caller.signal.aborted).toBe(false);
    await expect(b.wrap(transport)("https://provider.invalid/chat", { method: "POST", body: "{}" })).resolves.toBeInstanceOf(Response);
    expect(combined?.aborted).toBe(false);
    release(); await closing; await rejected;
  });

});
