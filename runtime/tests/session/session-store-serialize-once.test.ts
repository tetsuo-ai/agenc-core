import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("rollout flush serialization", () => {
  let home = "";
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-serialize-once-"));
    origHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = home;
  });

  afterEach(() => {
    vi.doUnmock("../../src/session/rollout-item.js");
    vi.resetModules();
    if (origHome === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a flush serializes each item once and indexes the bytes it wrote", async () => {
    const serializeCalls = { count: 0 };
    // The shared setup file already loaded the session modules, so count
    // serializations in a fresh module graph.
    vi.resetModules();
    vi.doMock("../../src/session/rollout-item.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../src/session/rollout-item.js")>();
      return {
        ...actual,
        serializeRolloutItem: (
          item: Parameters<typeof actual.serializeRolloutItem>[0],
        ) => {
          serializeCalls.count += 1;
          return actual.serializeRolloutItem(item);
        },
      };
    });
    const { SessionStore } = await import("../../src/session/session-store.js");

    const cwd = join(home, "workspace");
    const store = new SessionStore({
      cwd,
      sessionId: "sess-serialize-once",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-serialize-once",
      timestamp: new Date().toISOString(),
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    serializeCalls.count = 0;

    store.append({
      id: "1",
      seq: 1,
      msg: { type: "warning", payload: { cause: "first", message: "plain" } },
    });
    // Redaction changes this line's length, so an offset taken from a
    // different serialization than the written bytes would land mid-line.
    store.append({
      id: "2",
      seq: 2,
      msg: {
        type: "warning",
        payload: {
          cause: "second",
          message: "api_key=sk-live-0123456789abcdefghijklmnop was pasted",
        },
      },
    });
    store.append(
      { id: "3", seq: 3, msg: { type: "turn_complete", payload: { turnId: "t" } } },
      { durable: true },
    );

    expect(serializeCalls.count).toBe(3);

    const raw = readFileSync(store.rolloutPath);
    for (const seq of [1, 2, 3]) {
      const offset = store.getByteOffsetForSeq(seq);
      expect(offset).toBeTypeOf("number");
      const end = raw.indexOf(0x0a, offset);
      const line = JSON.parse(raw.subarray(offset, end).toString("utf8")) as {
        readonly payload: { readonly seq: number };
      };
      expect(line.payload.seq).toBe(seq);
    }
    expect(raw.toString("utf8")).not.toContain(
      "sk-live-0123456789abcdefghijklmnop",
    );
    store.close();
  });
});
