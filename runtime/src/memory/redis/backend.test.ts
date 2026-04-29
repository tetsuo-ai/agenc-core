import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryConnectionError,
  MemorySerializationError,
  MemoryBackendError,
} from "../errors.js";
import { isTranscriptCapableMemoryBackend } from "../transcript.js";

// Mock ioredis
const mockZadd = vi.fn().mockResolvedValue(1);
const mockSadd = vi.fn().mockResolvedValue(1);
const mockPexpire = vi.fn().mockResolvedValue(1);
const mockZrangebyscore = vi.fn().mockResolvedValue([]);
const mockZrevrangebyscore = vi.fn().mockResolvedValue([]);
const mockZcard = vi.fn().mockResolvedValue(0);
const mockDel = vi.fn().mockResolvedValue(1);
const mockSrem = vi.fn().mockResolvedValue(1);
const mockSmembers = vi.fn().mockResolvedValue([]);
const mockSet = vi.fn().mockResolvedValue("OK");
const mockGet = vi.fn().mockResolvedValue(null);
const mockExists = vi.fn().mockResolvedValue(0);
const mockKeys = vi.fn().mockResolvedValue([]);
// `scan` replaces `keys` for production safety on large keysets. The mock
// returns one batch then signals completion with cursor "0", matching the
// shape `[nextCursor, batchKeys]` that ioredis emits.
const mockScan = vi.fn().mockResolvedValue(["0", []]);
const mockPing = vi.fn().mockResolvedValue("PONG");
const mockQuit = vi.fn().mockResolvedValue("OK");
const mockConnect = vi.fn().mockResolvedValue(undefined);

const mockClient = {
  zadd: mockZadd,
  sadd: mockSadd,
  pexpire: mockPexpire,
  zrangebyscore: mockZrangebyscore,
  zrevrangebyscore: mockZrevrangebyscore,
  zcard: mockZcard,
  del: mockDel,
  srem: mockSrem,
  smembers: mockSmembers,
  set: mockSet,
  get: mockGet,
  exists: mockExists,
  keys: mockKeys,
  scan: mockScan,
  ping: mockPing,
  quit: mockQuit,
  connect: mockConnect,
};

const MockRedis = vi.fn(function (this: any) {
  Object.assign(this, mockClient);
});

vi.mock("ioredis", () => {
  return { default: MockRedis };
});

// Import after mock
import { RedisBackend } from "./backend.js";

function installTranscriptRedisStore(): void {
  type StoredTranscriptEvent = {
    seq: number;
    json: string;
  };

  const transcriptEntries = new Map<string, StoredTranscriptEvent[]>();
  const transcriptStreams = new Set<string>();

  mockZadd.mockImplementation(async (key: string, score: number, member: string) => {
    const stream = transcriptEntries.get(key) ?? [];
    stream.push({ seq: score, json: member });
    stream.sort((a, b) => a.seq - b.seq);
    transcriptEntries.set(key, stream);
    return 1;
  });

  mockSadd.mockImplementation(async (key: string, value: string) => {
    if (key.includes("transcript-streams")) {
      transcriptStreams.add(value);
    }
    return 1;
  });

  mockZrangebyscore.mockImplementation(
    async (key: string, min: string, max: string) => {
      if (!key.includes("transcript:")) return [];
      const stream = transcriptEntries.get(key) ?? [];
      const minSeq = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
      const maxSeq = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
      return stream
        .filter((entry) => entry.seq >= minSeq && entry.seq <= maxSeq)
        .map((entry) => entry.json);
    },
  );

  mockZrevrangebyscore.mockImplementation(async (key: string) => {
    if (!key.includes("transcript:")) return [];
    const stream = [...(transcriptEntries.get(key) ?? [])].sort(
      (a, b) => b.seq - a.seq,
    );
    return stream.map((entry) => entry.json);
  });

  mockZcard.mockImplementation(async (key: string) => {
    if (!key.includes("transcript:")) return 0;
    return (transcriptEntries.get(key) ?? []).length;
  });

  mockDel.mockImplementation(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (key.includes("transcript:")) {
        removed += transcriptEntries.get(key)?.length ?? 0;
        transcriptEntries.delete(key);
      } else if (key.includes("transcript-streams")) {
        transcriptStreams.clear();
        removed += 1;
      }
    }
    return removed || 1;
  });

  mockSrem.mockImplementation(async (key: string, value: string) => {
    if (key.includes("transcript-streams")) {
      transcriptStreams.delete(value);
    }
    return 1;
  });

  mockSmembers.mockImplementation(async (key: string) => {
    if (key.includes("transcript-streams")) {
      return [...transcriptStreams.values()];
    }
    return [];
  });
}

describe("RedisBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default returns
    mockZrangebyscore.mockResolvedValue([]);
    mockZrevrangebyscore.mockResolvedValue([]);
    mockSmembers.mockResolvedValue([]);
    mockGet.mockResolvedValue(null);
    mockExists.mockResolvedValue(0);
    mockKeys.mockResolvedValue([]);
    mockZcard.mockResolvedValue(0);
    mockConnect.mockResolvedValue(undefined);
    mockPing.mockResolvedValue("PONG");
  });

  describe("lazy loading", () => {
    it("connects on first operation", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1");

      expect(MockRedis).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("reuses existing client", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1");
      await backend.getThread("s2");

      expect(MockRedis).toHaveBeenCalledTimes(1);
    });

    it("passes URL when configured", async () => {
      const backend = new RedisBackend({ url: "redis://myhost:6380" });
      await backend.getThread("s1");

      expect(MockRedis).toHaveBeenCalledWith(
        "redis://myhost:6380",
        expect.objectContaining({ lazyConnect: true }),
      );
    });

    it("passes host/port when no URL", async () => {
      const backend = new RedisBackend({
        host: "myhost",
        port: 6380,
        password: "secret",
        db: 2,
      });
      await backend.getThread("s1");

      expect(MockRedis).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "myhost",
          port: 6380,
          password: "secret",
          db: 2,
          lazyConnect: true,
        }),
      );
    });
  });

  describe("missing dependency", () => {
    it("throws MemoryConnectionError when ioredis is missing", async () => {
      vi.doUnmock("ioredis");
      vi.doMock("ioredis", () => {
        throw new Error("Cannot find module");
      });

      const { RedisBackend: FreshRedis } = await import("./backend.js");
      const backend = new FreshRedis();

      await expect(backend.getThread("s1")).rejects.toThrow(
        MemoryConnectionError,
      );

      vi.doMock("ioredis", () => ({ default: MockRedis }));
    });
  });

  describe("connection error", () => {
    it("throws MemoryConnectionError when connect fails", async () => {
      mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const backend = new RedisBackend();
      await expect(backend.getThread("s1")).rejects.toThrow(
        MemoryConnectionError,
      );
    });
  });

  describe("addEntry", () => {
    it("uses ZADD with timestamp score", async () => {
      const backend = new RedisBackend({ keyPrefix: "test:" });
      const entry = await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "Hello",
      });

      expect(mockZadd).toHaveBeenCalledWith(
        "test:thread:s1",
        expect.any(Number),
        expect.stringContaining('"role":"user"'),
      );
      expect(mockSadd).toHaveBeenCalledWith("test:sessions", "s1");
      expect(entry.role).toBe("user");
      expect(entry.content).toBe("Hello");
    });

    it("sets PEXPIRE when ttlMs specified", async () => {
      const backend = new RedisBackend();
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "temp",
        ttlMs: 5000,
      });

      expect(mockPexpire).toHaveBeenCalledWith(
        expect.stringContaining("thread:s1"),
        5000,
      );
    });

    it("does not set PEXPIRE when no TTL", async () => {
      const backend = new RedisBackend();
      await backend.addEntry({
        sessionId: "s1",
        role: "user",
        content: "perm",
      });

      expect(mockPexpire).not.toHaveBeenCalled();
    });
  });

  describe("getThread", () => {
    it("uses ZRANGEBYSCORE for full thread", async () => {
      const entry = JSON.stringify({
        id: "1",
        sessionId: "s1",
        role: "user",
        content: "hi",
        timestamp: 100,
      });
      mockZrangebyscore.mockResolvedValueOnce([entry]);

      const backend = new RedisBackend();
      const thread = await backend.getThread("s1");

      expect(mockZrangebyscore).toHaveBeenCalledWith(
        expect.stringContaining("thread:s1"),
        "-inf",
        "+inf",
      );
      expect(thread).toHaveLength(1);
      expect(thread[0].content).toBe("hi");
    });

    it("uses ZREVRANGEBYSCORE with LIMIT for bounded query", async () => {
      const entries = [
        JSON.stringify({
          id: "2",
          sessionId: "s1",
          role: "user",
          content: "second",
          timestamp: 200,
        }),
        JSON.stringify({
          id: "1",
          sessionId: "s1",
          role: "user",
          content: "first",
          timestamp: 100,
        }),
      ];
      mockZrevrangebyscore.mockResolvedValueOnce(entries);

      const backend = new RedisBackend();
      const thread = await backend.getThread("s1", 2);

      expect(mockZrevrangebyscore).toHaveBeenCalledWith(
        expect.stringContaining("thread:s1"),
        "+inf",
        "-inf",
        "LIMIT",
        0,
        2,
      );
      // Should be in chronological order (reversed back)
      expect(thread[0].content).toBe("first");
      expect(thread[1].content).toBe("second");
    });
  });

  describe("query", () => {
    it("queries single session by sessionId", async () => {
      const entry = JSON.stringify({
        id: "1",
        sessionId: "s1",
        role: "user",
        content: "hi",
        timestamp: 100,
      });
      mockZrangebyscore.mockResolvedValueOnce([entry]);

      const backend = new RedisBackend();
      const results = await backend.query({ sessionId: "s1" });

      expect(results).toHaveLength(1);
    });

    it("queries all sessions when no sessionId", async () => {
      mockSmembers.mockResolvedValueOnce(["s1", "s2"]);
      const e1 = JSON.stringify({
        id: "1",
        sessionId: "s1",
        role: "user",
        content: "a",
        timestamp: 100,
      });
      const e2 = JSON.stringify({
        id: "2",
        sessionId: "s2",
        role: "user",
        content: "b",
        timestamp: 200,
      });
      mockZrangebyscore.mockResolvedValueOnce([e1]);
      mockZrangebyscore.mockResolvedValueOnce([e2]);

      const backend = new RedisBackend();
      const results = await backend.query({});

      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("a");
      expect(results[1].content).toBe("b");
    });

    it("filters by role", async () => {
      const entries = [
        JSON.stringify({ id: "1", role: "user", content: "a", timestamp: 100 }),
        JSON.stringify({
          id: "2",
          role: "assistant",
          content: "b",
          timestamp: 200,
        }),
      ];
      mockZrangebyscore.mockResolvedValueOnce(entries);

      const backend = new RedisBackend();
      const results = await backend.query({
        sessionId: "s1",
        role: "assistant",
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("b");
    });

    it("filters by taskPda", async () => {
      const entries = [
        JSON.stringify({
          id: "1",
          role: "user",
          content: "a",
          taskPda: "task-1",
          timestamp: 100,
        }),
        JSON.stringify({ id: "2", role: "user", content: "b", timestamp: 200 }),
      ];
      mockZrangebyscore.mockResolvedValueOnce(entries);

      const backend = new RedisBackend();
      const results = await backend.query({
        sessionId: "s1",
        taskPda: "task-1",
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("a");
    });

    it("supports time range and desc order", async () => {
      const entries = [
        JSON.stringify({ id: "1", role: "user", content: "a", timestamp: 100 }),
        JSON.stringify({ id: "2", role: "user", content: "b", timestamp: 200 }),
      ];
      mockZrangebyscore.mockResolvedValueOnce(entries);

      const backend = new RedisBackend();
      const results = await backend.query({
        sessionId: "s1",
        after: 50,
        before: 250,
        order: "desc",
      });

      expect(results[0].content).toBe("b");
      expect(results[1].content).toBe("a");
    });

    it("supports limit", async () => {
      const entries = [
        JSON.stringify({ id: "1", role: "user", content: "a", timestamp: 100 }),
        JSON.stringify({ id: "2", role: "user", content: "b", timestamp: 200 }),
        JSON.stringify({ id: "3", role: "user", content: "c", timestamp: 300 }),
      ];
      mockZrangebyscore.mockResolvedValueOnce(entries);

      const backend = new RedisBackend();
      const results = await backend.query({ sessionId: "s1", limit: 2 });

      expect(results).toHaveLength(2);
    });
  });

  describe("deleteThread", () => {
    it("deletes sorted set and removes from sessions", async () => {
      mockZcard.mockResolvedValueOnce(5);

      const backend = new RedisBackend();
      const count = await backend.deleteThread("s1");

      expect(count).toBe(5);
      expect(mockDel).toHaveBeenCalledWith(
        expect.stringContaining("thread:s1"),
      );
      expect(mockSrem).toHaveBeenCalledWith(
        expect.stringContaining("sessions"),
        "s1",
      );
    });

    it("returns 0 for empty thread", async () => {
      mockZcard.mockResolvedValueOnce(0);

      const backend = new RedisBackend();
      const count = await backend.deleteThread("s1");

      expect(count).toBe(0);
      expect(mockDel).not.toHaveBeenCalled();
    });
  });

  describe("listSessions", () => {
    it("returns all sessions from set", async () => {
      mockSmembers.mockResolvedValueOnce(["s1", "s2", "s3"]);

      const backend = new RedisBackend();
      const sessions = await backend.listSessions();

      expect(sessions).toEqual(["s1", "s2", "s3"]);
    });

    it("filters by prefix", async () => {
      mockSmembers.mockResolvedValueOnce(["task-1", "task-2", "other"]);

      const backend = new RedisBackend();
      const sessions = await backend.listSessions("task-");

      expect(sessions).toEqual(["task-1", "task-2"]);
    });
  });

  describe("transcript capability", () => {
    it("advertises transcript support", () => {
      const backend = new RedisBackend();
      expect(isTranscriptCapableMemoryBackend(backend)).toBe(true);
    });

    it("round-trips transcript events", async () => {
      installTranscriptRedisStore();
      const backend = new RedisBackend();

      const appended = await backend.appendTranscript("stream-1", [
        {
          eventId: "evt-1",
          kind: "message",
          payload: { role: "user", content: "hello" },
          timestamp: 100,
        },
        {
          eventId: "evt-2",
          kind: "context_collapse",
          payload: { collapseId: "c-1", summary: "summary" },
          timestamp: 200,
        },
      ]);

      expect(appended.map((event) => event.seq)).toEqual([1, 2]);
      expect(await backend.loadTranscript("stream-1")).toEqual(appended);
      expect(await backend.listTranscriptStreams()).toEqual(["stream-1"]);
    });

    it("deduplicates transcript events by event id", async () => {
      installTranscriptRedisStore();
      const backend = new RedisBackend();

      const first = await backend.appendTranscript("stream-1", [
        {
          eventId: "evt-1",
          kind: "message",
          payload: { role: "assistant", content: "hi" },
        },
      ]);
      const second = await backend.appendTranscript("stream-1", [
        {
          eventId: "evt-1",
          kind: "message",
          payload: { role: "assistant", content: "hi" },
        },
      ]);

      expect(second).toEqual(first);
      expect(await backend.loadTranscript("stream-1")).toHaveLength(1);
    });
  });

  describe("KV operations", () => {
    it("set with TTL uses PX flag", async () => {
      const backend = new RedisBackend();
      await backend.set("key", { foo: "bar" }, 5000);

      expect(mockSet).toHaveBeenCalledWith(
        expect.stringContaining("kv:key"),
        '{"foo":"bar"}',
        "PX",
        5000,
      );
    });

    it("set without TTL omits PX flag", async () => {
      const backend = new RedisBackend();
      await backend.set("key", "value");

      expect(mockSet).toHaveBeenCalledWith(
        expect.stringContaining("kv:key"),
        '"value"',
      );
    });

    it("get parses JSON value", async () => {
      mockGet.mockResolvedValueOnce('{"foo":"bar"}');

      const backend = new RedisBackend();
      const result = await backend.get<{ foo: string }>("key");

      expect(result).toEqual({ foo: "bar" });
    });

    it("get returns undefined for missing key", async () => {
      mockGet.mockResolvedValueOnce(null);

      const backend = new RedisBackend();
      const result = await backend.get("missing");

      expect(result).toBeUndefined();
    });

    it("delete returns true when key deleted", async () => {
      mockDel.mockResolvedValueOnce(1);

      const backend = new RedisBackend();
      expect(await backend.delete("key")).toBe(true);
    });

    it("delete returns false when no key", async () => {
      mockDel.mockResolvedValueOnce(0);

      const backend = new RedisBackend();
      expect(await backend.delete("missing")).toBe(false);
    });

    it("has uses EXISTS", async () => {
      mockExists.mockResolvedValueOnce(1);

      const backend = new RedisBackend();
      expect(await backend.has("key")).toBe(true);
    });

    it("listKeys strips prefix", async () => {
      // listKeys now uses cursor-based scan() instead of keys() to avoid
      // blocking Redis on large keysets. Mock the scan response shape:
      // `[nextCursor, batchKeys]` with cursor "0" indicating completion.
      mockScan.mockResolvedValueOnce([
        "0",
        ["agenc:memory:kv:a", "agenc:memory:kv:b"],
      ]);

      const backend = new RedisBackend();
      const keys = await backend.listKeys();

      expect(keys).toEqual(["a", "b"]);
    });

    it("listKeys with prefix filters pattern", async () => {
      mockScan.mockResolvedValueOnce(["0", ["agenc:memory:kv:cache:1"]]);

      const backend = new RedisBackend();
      await backend.listKeys("cache:");

      expect(mockScan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "agenc:memory:kv:cache:*",
        "COUNT",
        100,
      );
    });
  });

  describe("lifecycle", () => {
    it("clear deletes all thread and KV keys", async () => {
      mockSmembers.mockResolvedValueOnce(["s1", "s2"]).mockResolvedValueOnce([]);
      mockScan.mockResolvedValueOnce([
        "0",
        ["agenc:memory:kv:a", "agenc:memory:kv:b"],
      ]);

      const backend = new RedisBackend();
      await backend.clear();

      // Delete thread keys + sessions key
      expect(mockDel).toHaveBeenCalledWith(
        expect.stringContaining("thread:s1"),
      );
      expect(mockDel).toHaveBeenCalledWith(
        expect.stringContaining("thread:s2"),
      );
      expect(mockDel).toHaveBeenCalledWith(expect.stringContaining("sessions"));
      // Delete KV keys
      expect(mockDel).toHaveBeenCalledWith(
        "agenc:memory:kv:a",
        "agenc:memory:kv:b",
      );
    });

    it("close calls quit", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1"); // init
      await backend.close();

      expect(mockQuit).toHaveBeenCalled();
    });

    it("operations throw after close", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1"); // init
      await backend.close();

      await expect(
        backend.addEntry({ sessionId: "s1", role: "user", content: "x" }),
      ).rejects.toThrow(MemoryBackendError);
    });

    it("healthCheck returns true on PONG", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1"); // init

      expect(await backend.healthCheck()).toBe(true);
    });

    it("healthCheck returns false when closed", async () => {
      const backend = new RedisBackend();
      await backend.close();

      expect(await backend.healthCheck()).toBe(false);
    });

    it("healthCheck returns false on ping failure", async () => {
      const backend = new RedisBackend();
      await backend.getThread("s1"); // init
      mockPing.mockRejectedValueOnce(new Error("connection lost"));

      expect(await backend.healthCheck()).toBe(false);
    });
  });

  describe("serialization errors", () => {
    it("throws MemorySerializationError for non-serializable entry", async () => {
      const backend = new RedisBackend();

      const circular: any = {};
      circular.self = circular;

      await expect(
        backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "x",
          metadata: circular,
        }),
      ).rejects.toThrow(MemorySerializationError);
    });

    it("throws MemorySerializationError for non-serializable KV value", async () => {
      const backend = new RedisBackend();

      const circular: any = {};
      circular.self = circular;

      await expect(backend.set("key", circular)).rejects.toThrow(
        MemorySerializationError,
      );
    });
  });
});
