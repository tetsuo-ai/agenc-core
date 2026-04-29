/**
 * Wave 3-C: paste-store tests.
 *
 * Uses vitest fake timers to drive the 500 ms idle window deterministically.
 * Each test starts from a freshly-reset singleton so burst state cannot leak
 * across cases. I-67 coverage lives at the bottom of the suite and checks
 * both C0 and C1 stripping plus the `\n`/`\t` preservation carve-outs.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  __resetPasteStoreForTesting,
  getPasteStore,
  type PasteEvent,
} from "./paste-store.js";

/** Small helper: subscribe to the current singleton and collect events. */
function collectEvents(): {
  events: PasteEvent[];
  unsubscribe: () => void;
} {
  const events: PasteEvent[] = [];
  const unsubscribe = getPasteStore().subscribe((e) => {
    events.push(e);
  });
  return { events, unsubscribe };
}

beforeEach(() => {
  __resetPasteStoreForTesting();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  __resetPasteStoreForTesting();
});

describe("PasteStore", () => {
  test("fresh store reports not in-flight and empty buffer", () => {
    const store = getPasteStore();
    expect(store.isInFlight()).toBe(false);
    expect(store.consumeBuffer()).toBe("");
  });

  test("first pushChunk emits paste-start and marks in-flight", () => {
    const store = getPasteStore();
    const { events } = collectEvents();
    store.pushChunk("hi");
    expect(store.isInFlight()).toBe(true);
    expect(events).toEqual([{ kind: "paste-start" }]);
  });

  test("multiple pushChunks append to the internal buffer", () => {
    const store = getPasteStore();
    store.pushChunk("hello ");
    store.pushChunk("world");
    // Buffer not yet drained — in-flight and idle timer still pending.
    expect(store.isInFlight()).toBe(true);
    expect(store.consumeBuffer()).toBe("hello world");
  });

  test("paste-complete fires after 500 ms idle and carries total bytes", () => {
    const store = getPasteStore();
    const { events } = collectEvents();
    store.pushChunk("12345");
    vi.advanceTimersByTime(500);
    expect(events).toContainEqual({ kind: "paste-complete", bytes: 5 });
  });

  test("paste-complete transitions in-flight back to false", () => {
    const store = getPasteStore();
    store.pushChunk("abc");
    expect(store.isInFlight()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(store.isInFlight()).toBe(false);
  });

  test("consumeBuffer drains accumulated chunks and clears the buffer", () => {
    const store = getPasteStore();
    store.pushChunk("foo");
    store.pushChunk("bar");
    expect(store.consumeBuffer()).toBe("foobar");
    expect(store.consumeBuffer()).toBe("");
  });

  test("C0 controls are stripped and reported via paste-sanitized", () => {
    const store = getPasteStore();
    const { events } = collectEvents();
    store.pushChunk("\x01\x02abc\x03");
    vi.advanceTimersByTime(500);
    expect(store.consumeBuffer()).toBe("abc");
    const sanitized = events.find((e) => e.kind === "paste-sanitized");
    expect(sanitized).toEqual({
      kind: "paste-sanitized",
      strippedBytes: 3,
    });
  });

  test("newline and tab are preserved (not stripped as C0)", () => {
    const store = getPasteStore();
    const { events } = collectEvents();
    store.pushChunk("a\nb\tc");
    vi.advanceTimersByTime(500);
    expect(store.consumeBuffer()).toBe("a\nb\tc");
    expect(events.some((e) => e.kind === "paste-sanitized")).toBe(false);
  });

  test("C1 controls (0x80-0x9F) are stripped", () => {
    const store = getPasteStore();
    const { events } = collectEvents();
    // Span three C1 code points (\x80, \x90, \x9F) surrounding ASCII.
    store.pushChunk("x\x80y\x90z\x9F");
    vi.advanceTimersByTime(500);
    expect(store.consumeBuffer()).toBe("xyz");
    const sanitized = events.find((e) => e.kind === "paste-sanitized");
    expect(sanitized).toEqual({
      kind: "paste-sanitized",
      strippedBytes: 3,
    });
  });
});
