import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitTracePayloadDrain,
  persistTracePayloadArtifact,
  tracePayloadActiveChainCount,
} from "./trace-payload-store.js";

const TRACE_PAYLOAD_ROOT = join(homedir(), ".agenc", "trace-payloads");

interface JsonlLine {
  readonly sha256: string;
  readonly eventName: string;
  readonly traceId: string;
  readonly capturedAt: string;
  readonly payload: Record<string, unknown>;
}

function parseAnchoredPath(input: string): {
  filePath: string;
  sha256: string;
} {
  const idx = input.indexOf("#sha256=");
  if (idx === -1) throw new Error(`expected anchored path, got ${input}`);
  return {
    filePath: input.slice(0, idx),
    sha256: input.slice(idx + "#sha256=".length),
  };
}

function readJsonlLines(filePath: string): JsonlLine[] {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonlLine);
}

function findLineBySha(filePath: string, sha256: string): JsonlLine {
  const matches = readJsonlLines(filePath).filter(
    (line) => line.sha256 === sha256,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one line for sha=${sha256}, got ${matches.length}`,
    );
  }
  return matches[0]!;
}

function cleanupTrace(traceId: string): void {
  const filePath = join(TRACE_PAYLOAD_ROOT, `${traceId}.jsonl`);
  if (existsSync(filePath)) rmSync(filePath, { force: true });
}

describe("persistTracePayloadArtifact (per-traceId JSONL)", () => {
  const owned: string[] = [];

  afterEach(async () => {
    await awaitTracePayloadDrain();
    while (owned.length > 0) {
      const id = owned.pop()!;
      cleanupTrace(id);
    }
  });

  it("returns an anchored ref path with sha256 fragment", async () => {
    const traceId = "trace-store-anchor";
    owned.push(traceId);
    const ref = persistTracePayloadArtifact({
      traceId,
      eventName: "webchat.provider.request",
      payload: { message: "hello" },
    });
    expect(ref).toBeDefined();
    expect(ref!.path).toMatch(/#sha256=[0-9a-f]{64}$/);
    expect(ref!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref!.bytes).toBeGreaterThan(0);
  });

  it("round-trips a single payload through the JSONL line", async () => {
    const traceId = "trace-store-roundtrip";
    owned.push(traceId);
    const ref = persistTracePayloadArtifact({
      traceId,
      eventName: "webchat.provider.request",
      payload: { message: "hello", image: "data:image/png;base64,AAAA" },
    });
    expect(ref).toBeDefined();
    await awaitTracePayloadDrain(traceId);

    const { filePath, sha256 } = parseAnchoredPath(ref!.path);
    const line = findLineBySha(filePath, sha256);
    expect(line.sha256).toBe(ref!.sha256);
    expect(line.eventName).toBe("webchat.provider.request");
    expect(line.traceId).toBe(traceId);
    expect(line.payload.message).toBe("hello");
    // sanitizeTracePayloadForArtifact replaces base64 data URLs.
    expect((line.payload.image as Record<string, unknown>).kind).toBe(
      "data_url_base64",
    );
  });

  it("preserves repeated array references and replaces true cycles", async () => {
    const traceId = "trace-store-duplicates";
    owned.push(traceId);
    const shared = ["mcp.example.start"];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const ref = persistTracePayloadArtifact({
      traceId,
      eventName: "webchat.provider.request",
      payload: {
        requestedToolNames: shared,
        missingRequestedToolNames: shared,
        cyclic,
      },
    });
    await awaitTracePayloadDrain(traceId);
    const { filePath, sha256 } = parseAnchoredPath(ref!.path);
    const line = findLineBySha(filePath, sha256);
    expect(line.payload.requestedToolNames).toEqual(["mcp.example.start"]);
    expect(line.payload.missingRequestedToolNames).toEqual([
      "mcp.example.start",
    ]);
    expect((line.payload.cyclic as { self: string }).self).toBe("[circular]");
  });

  it("appends multiple events for the same traceId into one JSONL file", async () => {
    const traceId = "trace-store-many-events";
    owned.push(traceId);
    const refs = [
      persistTracePayloadArtifact({
        traceId,
        eventName: "evt.one",
        payload: { idx: 1 },
      })!,
      persistTracePayloadArtifact({
        traceId,
        eventName: "evt.two",
        payload: { idx: 2 },
      })!,
      persistTracePayloadArtifact({
        traceId,
        eventName: "evt.three",
        payload: { idx: 3 },
      })!,
    ];
    await awaitTracePayloadDrain(traceId);

    const filePath = parseAnchoredPath(refs[0].path).filePath;
    const lines = readJsonlLines(filePath);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.eventName)).toEqual(["evt.one", "evt.two", "evt.three"]);
    expect(lines.map((l) => l.payload.idx)).toEqual([1, 2, 3]);
    // Each ref's sha matches the line at that position.
    refs.forEach((ref, i) => {
      expect(lines[i]!.sha256).toBe(ref.sha256);
    });
  });

  it("serializes 5 concurrent writes to the same traceId without interleaving", async () => {
    const traceId = "trace-store-concurrent";
    owned.push(traceId);
    const concurrentRefs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(
          persistTracePayloadArtifact({
            traceId,
            eventName: `evt.${i}`,
            // Make each line large enough to exceed PIPE_BUF (4 KB)
            // so a non-serialized append could plausibly interleave.
            // Vary content so the sanitizer doesn't treat it as a
            // repeated/binary blob.
            payload: { idx: i, fill: `chunk-${i}-${"abc".repeat(3000)}` },
          })!,
        ),
      ),
    );
    await awaitTracePayloadDrain(traceId);

    const filePath = parseAnchoredPath(concurrentRefs[0].path).filePath;
    const lines = readJsonlLines(filePath);
    expect(lines).toHaveLength(5);
    // Confirm payloads weren't truncated/interleaved.
    expect(
      lines.every((line) => {
        const fill = line.payload.fill as string;
        return (
          typeof fill === "string" &&
          fill.startsWith(`chunk-${line.payload.idx}-`)
        );
      }),
    ).toBe(true);
    // All sha256s match their refs (1:1).
    const sortedRefShas = [...concurrentRefs.map((r) => r.sha256)].sort();
    const sortedLineShas = [...lines.map((l) => l.sha256)].sort();
    expect(sortedLineShas).toEqual(sortedRefShas);
  });

  it("isolates distinct traceIds into separate JSONL files", async () => {
    const a = "trace-store-iso-a";
    const b = "trace-store-iso-b";
    owned.push(a, b);
    const refA = persistTracePayloadArtifact({
      traceId: a,
      eventName: "evt.a",
      payload: { which: "a" },
    })!;
    const refB = persistTracePayloadArtifact({
      traceId: b,
      eventName: "evt.b",
      payload: { which: "b" },
    })!;
    await awaitTracePayloadDrain();

    const linesA = readJsonlLines(parseAnchoredPath(refA.path).filePath);
    const linesB = readJsonlLines(parseAnchoredPath(refB.path).filePath);
    expect(linesA).toHaveLength(1);
    expect(linesB).toHaveLength(1);
    expect(linesA[0]!.payload.which).toBe("a");
    expect(linesB[0]!.payload.which).toBe("b");
  });

  it("drains the per-traceId chain map after writes complete", async () => {
    const traceId = "trace-store-cleanup";
    owned.push(traceId);
    persistTracePayloadArtifact({
      traceId,
      eventName: "evt.cleanup",
      payload: {},
    });
    await awaitTracePayloadDrain(traceId);
    expect(tracePayloadActiveChainCount()).toBe(0);
  });
});
