import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOneShotRecoverable,
  beginOneShotWriter,
  consumeOneShotSeal,
  type OneShotWriterAuthority,
} from "../../src/durability/one-shot-durability.js";

const roots: string[] = [];
const writers: OneShotWriterAuthority[] = [];
afterEach(() => {
  for (const writer of writers.splice(0).reverse()) {
    try { writer.release(); } catch { /* already released */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(runId = "run") {
  const root = mkdtempSync(join(tmpdir(), "one-shot-writer-"));
  roots.push(root);
  const project = join(root, "project");
  const sessionDir = join(project, "sessions", runId);
  mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = join(sessionDir, "rollout.jsonl");
  writeFileSync(rolloutPath, "");
  return { root, project, runId, rolloutPath };
}

function markerPath(rolloutPath: string): string {
  return `${rolloutPath}.durability.json`;
}

function openWriter(rolloutPath: string, runId: string, hooks?: {
  readonly flushAndSync?: () => void;
  readonly checkpoint?: () => void;
}): OneShotWriterAuthority {
  const writer = beginOneShotWriter({
    rolloutPath,
    runId,
    flushAndSync: hooks?.flushAndSync ?? (() => {}),
    checkpoint: hooks?.checkpoint ?? (() => {}),
  });
  writers.push(writer);
  return writer;
}

describe("beginOneShotWriter and consumeOneShotSeal", () => {
  it("seals a uniquely bound run with a content proof", () => {
    const { rolloutPath, runId } = layout();
    const payload = '{"id":"event-1"}\n';
    const writer = openWriter(rolloutPath, runId, {
      flushAndSync: () => writeFileSync(rolloutPath, payload),
    });
    expect(JSON.parse(readFileSync(markerPath(rolloutPath), "utf8")).phase).toBe("active");
    writer.seal();
    const marker = JSON.parse(readFileSync(markerPath(rolloutPath), "utf8")) as {
      phase: string; bytes: number; sha256: string; runId: string; rollout: string;
    };
    expect(marker).toMatchObject({
      phase: "sealed",
      runId,
      rollout: "rollout.jsonl",
      bytes: Buffer.byteLength(payload),
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    writer.release();
    expect(() => assertOneShotRecoverable(rolloutPath)).not.toThrow();
  });

  it("refuses a second writer, a pre-existing marker, and a run-id mismatch", () => {
    const { rolloutPath, runId } = layout();
    openWriter(rolloutPath, runId);
    expect(() => beginOneShotWriter({
      rolloutPath, runId, flushAndSync: () => {}, checkpoint: () => {},
    })).toThrow("writer is not a fresh uniquely bound run");
    const other = layout();
    writeFileSync(markerPath(other.rolloutPath), "{}\n");
    expect(() => beginOneShotWriter({
      rolloutPath: other.rolloutPath, runId: other.runId,
      flushAndSync: () => {}, checkpoint: () => {},
    })).toThrow("writer is not a fresh uniquely bound run");
    const mismatched = layout("expected");
    expect(() => beginOneShotWriter({
      rolloutPath: mismatched.rolloutPath, runId: "other",
      flushAndSync: () => {}, checkpoint: () => {},
    })).toThrow("writer is not a fresh uniquely bound run");
  });

  it("consumes a sealed marker and refuses an active or mutated history", () => {
    const sealed = layout();
    writeFileSync(sealed.rolloutPath, "complete\n");
    const writer = openWriter(sealed.rolloutPath, sealed.runId);
    writer.seal();
    writer.release();
    consumeOneShotSeal(sealed.rolloutPath);
    expect(existsSync(markerPath(sealed.rolloutPath))).toBe(false);
    expect(() => assertOneShotRecoverable(sealed.rolloutPath)).not.toThrow();

    const active = layout();
    const activeWriter = openWriter(active.rolloutPath, active.runId);
    activeWriter.release();
    expect(() => consumeOneShotSeal(active.rolloutPath)).toThrow("no valid durable completion seal");

    const mutated = layout();
    writeFileSync(mutated.rolloutPath, "original\n");
    const sealedWriter = openWriter(mutated.rolloutPath, mutated.runId);
    sealedWriter.seal();
    sealedWriter.release();
    truncateSync(mutated.rolloutPath, 3);
    expect(() => consumeOneShotSeal(mutated.rolloutPath))
      .toThrow("differs from its durable completion seal");
    expect(existsSync(markerPath(mutated.rolloutPath))).toBe(true);
  });

  it("promote publishes the seal then drops the marker", () => {
    const { rolloutPath, runId } = layout();
    writeFileSync(rolloutPath, "done\n");
    const writer = openWriter(rolloutPath, runId);
    writer.promote();
    expect(existsSync(markerPath(rolloutPath))).toBe(false);
    writer.release();
    expect(() => assertOneShotRecoverable(rolloutPath)).not.toThrow();
  });
});
