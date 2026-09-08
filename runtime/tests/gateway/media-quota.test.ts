import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { XaiMemeFeature } from "../../src/gateway/meme.js";
import { XaiVoiceFeature } from "../../src/gateway/voice.js";
import { acquireLocalSqliteLock } from "../../src/utils/sqlite-lock.js";

type MediaKind = "meme" | "voice";

describe("gateway media quota reservations", () => {
  let home: string;
  let usageFile: string;
  let now: number;
  let providerCalls: string[];
  let providerGate: Promise<void> | undefined;
  let firstProvider: ReturnType<typeof Promise.withResolvers<void>>;
  let failProvider: boolean;
  let pending: Promise<unknown>[];
  let gates: ReturnType<typeof Promise.withResolvers<void>>[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-media-quota-"));
    usageFile = join(home, "usage.json");
    now = Date.parse("2026-09-08T23:59:59Z");
    providerCalls = [];
    providerGate = undefined;
    firstProvider = Promise.withResolvers<void>();
    failProvider = false;
    pending = [];
    gates = [];
  });

  afterEach(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    rmSync(home, { recursive: true, force: true });
  });

  function usage(path = usageFile): { day: string; count: number } {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  function request(kind: MediaKind, options: {
    readonly limit?: number;
    readonly path?: string;
    readonly text?: string;
    readonly reply?: () => Promise<string>;
  } = {}): Promise<boolean> {
    const fetchImpl: typeof fetch = async (input) => {
      providerCalls.push(String(input));
      firstProvider.resolve();
      await providerGate;
      if (failProvider) throw new Error("uncertain provider outcome");
      return String(input).endsWith("/tts")
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })
        : Response.json({ data: [{ url: "https://image.example/fake.png" }] });
    };
    const configuration = {
      apiKey: "fake-provider-only",
      usageFile: options.path ?? usageFile,
      dailyLimit: options.limit ?? 1,
      now: () => now,
      fetchImpl,
    };
    const feature = kind === "meme"
      ? new XaiMemeFeature(configuration)
      : new XaiVoiceFeature(configuration);
    const result = feature.handle({
      text: options.text ?? `/${kind} test`,
      reply: options.reply ?? (async () => "reply-id"),
    });
    pending.push(result);
    void result.catch(() => undefined);
    return result;
  }

  it.each<MediaKind>(["meme", "voice"])("admits only one of two concurrent %s instances", async (kind) => {
    await Promise.all([request(kind), request(kind)]);
    expect(providerCalls).toHaveLength(1);
    expect(usage()).toEqual({ day: "2026-09-08", count: 1 });
  });

  it("shares one ledger across meme and voice instances", async () => {
    await Promise.all([request("meme"), request("voice")]);
    expect(providerCalls).toHaveLength(1);
    expect(usage().count).toBe(1);
  });

  it("does not exceed the remaining quota during a larger burst", async () => {
    writeFileSync(usageFile, JSON.stringify({ day: "2026-09-08", count: 3 }), { mode: 0o600 });
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      request(index % 2 === 0 ? "meme" : "voice", { limit: 5 }),
    ));
    expect(providerCalls).toHaveLength(2);
    expect(usage().count).toBe(5);
  });

  it("keeps independent ledgers independent", async () => {
    const second = join(home, "voice.json");
    await Promise.all([request("meme"), request("voice", { path: second })]);
    expect(providerCalls).toHaveLength(2);
    expect(usage().count).toBe(1);
    expect(usage(second).count).toBe(1);
  });

  it("reserves durably before entering a pending provider call", async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    providerGate = gate.promise;
    const result = request("meme");
    await firstProvider.promise;
    expect(existsSync(usageFile)).toBe(true);
    expect(usage().count).toBe(1);
    gate.resolve();
    await result;
  });

  it.each<MediaKind>(["meme", "voice"])("keeps uncertain %s provider failures charged", async (kind) => {
    failProvider = true;
    await request(kind);
    await request(kind);
    expect(providerCalls).toHaveLength(1);
    expect(usage().count).toBe(1);
  });

  it("keeps a committed slot when the initial reply fails before provider entry", async () => {
    const failure = new Error("reply failed");
    await expect(request("voice", { reply: async () => { throw failure; } })).rejects.toBe(failure);
    expect(providerCalls).toHaveLength(0);
    expect(usage().count).toBe(1);
    await request("voice");
    expect(providerCalls).toHaveLength(0);
  });

  it("keeps a slot when delivering the generated media fails", async () => {
    let replies = 0;
    await request("meme", { reply: async () => {
      replies += 1;
      if (replies === 2) throw new Error("media delivery failed");
      return "reply-id";
    } });
    expect(providerCalls).toHaveLength(1);
    expect(usage().count).toBe(1);
    await request("meme");
    expect(providerCalls).toHaveLength(1);
  });

  it.each<MediaKind>(["meme", "voice"])("does not charge an empty or unrelated %s request", async (kind) => {
    await request(kind, { text: `/${kind}` });
    await expect(request(kind, { text: "ordinary question" })).resolves.toBe(false);
    expect(providerCalls).toHaveLength(0);
    expect(existsSync(usageFile)).toBe(false);
  });

  it("rolls the UTC day forward without overspending the new bucket", async () => {
    await request("meme");
    now = Date.parse("2026-09-09T00:00:00Z");
    await Promise.all([request("meme"), request("voice")]);
    expect(providerCalls).toHaveLength(2);
    expect(usage()).toEqual({ day: "2026-09-09", count: 1 });
  });

  it("does not reopen an earlier bucket after clock rollback", async () => {
    await request("voice");
    now = Date.parse("2026-09-07T00:00:00Z");
    await request("meme");
    expect(providerCalls).toHaveLength(1);
    expect(usage()).toEqual({ day: "2026-09-08", count: 1 });
  });

  it("samples the day after waiting for the reservation lock", async () => {
    const release = await acquireLocalSqliteLock(`${usageFile}.lock.sqlite`);
    let result: Promise<boolean>;
    try {
      result = request("meme");
      await nextEventLoopTurn();
      now = Date.parse("2026-09-09T00:00:00Z");
    } finally {
      release();
    }
    await result;
    expect(usage()).toEqual({ day: "2026-09-09", count: 1 });
  });

  it("does not let an older in-flight provider overwrite a new day's usage", async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    providerGate = gate.promise;
    const older = request("meme");
    await firstProvider.promise;
    providerGate = undefined;
    now = Date.parse("2026-09-09T00:00:00Z");
    await request("voice");
    expect(usage()).toEqual({ day: "2026-09-09", count: 1 });
    gate.resolve();
    await older;
    expect(usage()).toEqual({ day: "2026-09-09", count: 1 });
    expect(providerCalls).toHaveLength(2);
  });

  it.each(["{", "null", '{"day":"2026-09-08","count":-1}', '{"day":"2026-09-08","count":1.5}', '{"day":"2026-02-30","count":0}'])(
    "fails closed on an invalid usage ledger (%s)", async (contents) => {
      writeFileSync(usageFile, contents, { mode: 0o600 });
      await expect(request("meme")).rejects.toThrow();
      expect(providerCalls).toHaveLength(0);
      expect(readFileSync(usageFile, "utf8")).toBe(contents);
    },
  );

  it.each([NaN, Infinity, -1, 1.5])("rejects an invalid daily limit (%s) before provider entry", async (limit) => {
    await expect(request("voice", { limit })).rejects.toThrow();
    expect(providerCalls).toHaveLength(0);
    expect(existsSync(usageFile)).toBe(false);
  });

  it("blocks provider calls when the ledger is not a regular file", async () => {
    mkdirSync(usageFile);
    await expect(request("meme")).rejects.toThrow();
    expect(providerCalls).toHaveLength(0);
  });

  it("uses one lock through two aliases of the ledger parent", async () => {
    const alias = join(home, "alias");
    const directory = join(home, "ledger");
    mkdirSync(directory, { mode: 0o700 });
    symlinkSync(directory, alias, "junction");
    const directPath = join(directory, "usage.json");
    await Promise.all([
      request("meme", { path: directPath }),
      request("voice", { path: join(alias, "usage.json") }),
    ]);
    expect(providerCalls).toHaveLength(1);
    expect(usage(directPath).count).toBe(1);
  });
});
