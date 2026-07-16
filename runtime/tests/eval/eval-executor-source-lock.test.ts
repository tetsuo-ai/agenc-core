import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EvalExecutorError,
  findPilotTask,
  loadPilotSourceLock,
  readPilotArtifact,
} from "../../src/eval-executor/index.js";

const committedLock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json",
);

describe("eval executor pilot source-lock loader", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "agenc-eval-executor-lock-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("loads the committed frozen lock and resolves its CAS root", async () => {
    const loaded = await loadPilotSourceLock(committedLock);
    expect(loaded.lock.kind).toBe("agenc.eval.pilot-source-lock");
    expect(loaded.lock.tasks).toHaveLength(30);
    expect(loaded.casShaRoot.endsWith(path.join("cas", "sha256"))).toBe(true);
    const task = loaded.lock.tasks[0]!;
    const bytes = await readPilotArtifact(loaded, task.artifacts.sourceEvidence);
    expect(bytes.byteLength).toBe(task.artifacts.sourceEvidence.sizeBytes);
  });

  test("finds tasks by instanceId and rejects unknown tasks", async () => {
    const loaded = await loadPilotSourceLock(committedLock);
    const known = loaded.lock.tasks[0]!.instanceId;
    expect(findPilotTask(loaded.lock, known).instanceId).toBe(known);
    expect(() => findPilotTask(loaded.lock, "not-a-task")).toThrow(EvalExecutorError);
  });

  test("rejects a lock whose bytes drifted from the recorded document digest", async () => {
    const document = JSON.parse(await readFile(committedLock, "utf8")) as {
      tasks: Array<{ issueText: string }>;
    };
    document.tasks[0]!.issueText = "tampered issue text";
    const tampered = path.join(scratch, "source-lock.json");
    await writeFile(tampered, JSON.stringify(document));
    await expect(loadPilotSourceLock(tampered)).rejects.toThrow(/documentDigest mismatch/u);
  });

  test("rejects a task image that is not pinned by manifest digest", async () => {
    const document = JSON.parse(await readFile(committedLock, "utf8")) as {
      tasks: Array<{ image: string }>;
    };
    document.tasks[0]!.image = "starryzhang/sweb.eval.x86_64.some-task:latest";
    const tampered = path.join(scratch, "source-lock.json");
    await writeFile(tampered, JSON.stringify(document));
    await expect(loadPilotSourceLock(tampered)).rejects.toThrow(/immutable @sha256/u);
  });

  test("rejects CAS bytes that do not match their pinned digest", async () => {
    const original = JSON.parse(await readFile(committedLock, "utf8")) as Record<string, unknown>;
    const lockCopy = path.join(scratch, "source-lock.json");
    await writeFile(lockCopy, JSON.stringify(original));
    const casDir = path.join(scratch, "cas", "sha256");
    await mkdir(casDir, { recursive: true });
    const loadedCommitted = await loadPilotSourceLock(committedLock);
    const task = loadedCommitted.lock.tasks[0]!;
    const evidence = task.artifacts.sourceEvidence;
    await writeFile(
      path.join(casDir, evidence.digest.slice("sha256:".length)),
      Buffer.alloc(evidence.sizeBytes, 0x41),
    );
    const loaded = await loadPilotSourceLock(lockCopy);
    await expect(readPilotArtifact(loaded, evidence)).rejects.toThrow(/digest mismatch/u);
  });
});
