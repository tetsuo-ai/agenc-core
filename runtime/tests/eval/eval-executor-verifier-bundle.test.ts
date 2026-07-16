import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  decodeVerifierBundle,
  loadPilotSourceLock,
  readPilotArtifact,
} from "../../src/eval-executor/index.js";

const committedLock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json",
);

async function committedBundleBytes(): Promise<{ bytes: Uint8Array; instanceId: string }> {
  const loaded = await loadPilotSourceLock(committedLock);
  const task = loaded.lock.tasks[0]!;
  return {
    bytes: await readPilotArtifact(loaded, task.artifacts.verifierBundle),
    instanceId: task.instanceId,
  };
}

describe("eval executor verifier-bundle decoding", () => {
  test("decodes every committed pilot verifier bundle", async () => {
    const loaded = await loadPilotSourceLock(committedLock);
    for (const task of loaded.lock.tasks) {
      const bundle = decodeVerifierBundle(
        await readPilotArtifact(loaded, task.artifacts.verifierBundle),
        task.instanceId,
      );
      expect(bundle.instanceId).toBe(task.instanceId);
      expect(bundle.failToPass.length).toBeGreaterThan(0);
      expect(bundle.testCommands.length).toBeGreaterThan(0);
      expect(bundle.logParser).toContain("def parser");
    }
  });

  test("rejects a bundle bound to a different task", async () => {
    const { bytes } = await committedBundleBytes();
    expect(() => decodeVerifierBundle(bytes, "Other__task-1")).toThrow(/does not match task/u);
  });

  test("rejects bytes that are not gzip", async () => {
    expect(() => decodeVerifierBundle(new TextEncoder().encode("{}"), "x")).toThrow(
      /bounded gunzip/u,
    );
  });

  test("rejects a decompression bomb above the pilot artifact bound", async () => {
    const bomb = gzipSync(Buffer.alloc(20_000_000, 0));
    expect(() => decodeVerifierBundle(bomb, "x")).toThrow(/bounded gunzip/u);
  });

  test("rejects a bundle with a missing log parser", async () => {
    const { bytes, instanceId } = await committedBundleBytes();
    const value = JSON.parse(Buffer.from(gunzipSync(bytes)).toString("utf8")) as Record<
      string,
      unknown
    >;
    delete value.logParser;
    const repacked = gzipSync(Buffer.from(JSON.stringify(value)));
    expect(() => decodeVerifierBundle(repacked, instanceId)).toThrow(/logParser/u);
  });

  test("rejects an empty failToPass set", async () => {
    const { bytes, instanceId } = await committedBundleBytes();
    const value = JSON.parse(Buffer.from(gunzipSync(bytes)).toString("utf8")) as Record<
      string,
      unknown
    >;
    value.failToPass = [];
    const repacked = gzipSync(Buffer.from(JSON.stringify(value)));
    expect(() => decodeVerifierBundle(repacked, instanceId)).toThrow(/failToPass/u);
  });
});
