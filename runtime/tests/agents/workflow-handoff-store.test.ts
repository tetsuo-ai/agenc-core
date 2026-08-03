import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_ARTIFACT_BYTES_GLOBAL,
  MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN,
  MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
  MAX_WORKFLOW_ARTIFACTS_GLOBAL,
  MAX_WORKFLOW_ARTIFACTS_PER_RUN,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  MAX_WORKFLOW_STEP_RESULT_TOKENS,
  WORKFLOW_HANDOFF_ARTIFACT_KIND,
  type WorkflowHandoffOwner,
} from "../../src/agents/workflow-handoff-schema.js";
import {
  WorkflowHandoffArtifactStore,
  WorkflowHandoffStoreError,
  type WorkflowHandoffStoreHooks,
} from "../../src/agents/workflow-handoff-store.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { __setAtomicArtifactOperationForTesting } from "../../src/durability/atomic-artifact.js";

const OWNER: WorkflowHandoffOwner = Object.freeze({
  run_id: "run-one",
  workflow_id: "workflow-one",
  producer_step_id: "step-one",
});

let temporaryDirectory: string;
let driver: StateSqliteDriver;
let artifactRoot: string;
let now: number;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agenc-handoff-store-"));
  artifactRoot = join(temporaryDirectory, "handoffs");
  now = 1_000_000;
  driver = openStateDatabases({
    cwd: temporaryDirectory,
    agencHome: join(temporaryDirectory, "home"),
  });
});

afterEach(async () => {
  __setAtomicArtifactOperationForTesting(undefined);
  driver.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function store(hooks?: WorkflowHandoffStoreHooks): WorkflowHandoffArtifactStore {
  return new WorkflowHandoffArtifactStore({
    driver,
    trustedRoot: artifactRoot,
    now: () => now,
    retentionMs: 100,
    intentRecoveryGraceMs: 0,
    ...(hooks === undefined ? {} : { hooks }),
  });
}

async function publish(
  artifactStore: WorkflowHandoffArtifactStore,
  idempotencyKey: string,
  text = `body-${idempotencyKey}`,
  owner = OWNER,
) {
  return artifactStore.publish({
    owner,
    idempotencyKey,
    bytes: Buffer.from(text),
    tokenCount: 1,
  });
}

function artifactPath(artifactId: string): string {
  return join(artifactRoot, `${artifactId}.handoff`);
}

function expectStoreCode(
  operation: () => unknown | Promise<unknown>,
  code: WorkflowHandoffStoreError["code"],
): Promise<void> {
  return expect(operation()).rejects.toMatchObject({ code }) as Promise<void>;
}

function seedIntents(options: {
  readonly count: number;
  readonly runId: (index: number) => string;
  readonly byteLength: number;
  readonly startingIndex?: number;
}): void {
  const insert = driver.prepareState<
    [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      number,
    ]
  >(
    `INSERT INTO workflow_handoff_artifacts (
       artifact_id, format_version, kind, compatibility_epoch,
       idempotency_key, run_id, workflow_id, producer_step_id, digest,
       byte_length, token_count, storage_ref, status, preview,
       preview_truncated, created_at_ms, last_access_at_ms, unreferenced_at_ms
     ) VALUES (
       ?, 1, 'workflow_handoff', 'workflow_handoff.v1/state-schema.22',
       ?, ?, 'workflow', 'step',
       'sha256:0000000000000000000000000000000000000000000000000000000000000000',
       ?, 0, ?, 'intent', '', ?, ?, ?, ?
     )`,
  );
  driver.transactionImmediate(() => {
    for (let offset = 0; offset < options.count; offset += 1) {
      const index = (options.startingIndex ?? 1) + offset;
      const artifactId = `wh_${index.toString(16).padStart(48, "0")}`;
      const created = index + 1;
      insert.run(
        artifactId,
        `seed-${index}`,
        options.runId(index),
        options.byteLength,
        `workflow-handoff:${artifactId}`,
        options.byteLength === 0 ? 0 : 1,
        created,
        created,
        created,
      );
    }
  });
}

describe("workflow handoff publication and integrity", () => {
  it("publishes immutable digest-bound bytes and reads only for the owner", async () => {
    const artifactStore = store();
    const body = "x".repeat(MAX_WORKFLOW_STEP_PREVIEW_BYTES) + "🙂tail";
    const artifact = await artifactStore.publish({
      owner: OWNER,
      idempotencyKey: "publish",
      bytes: Buffer.from(body),
      tokenCount: MAX_WORKFLOW_STEP_RESULT_TOKENS,
    });

    expect(artifact.kind).toBe(WORKFLOW_HANDOFF_ARTIFACT_KIND);
    expect(Buffer.byteLength(artifact.preview)).toBe(MAX_WORKFLOW_STEP_PREVIEW_BYTES);
    expect(artifact.preview_truncated).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(artifactRoot)).mode & 0o077).toBe(0);
      expect((await stat(artifactPath(artifact.artifact_id))).mode & 0o077).toBe(0);
    }
    await expect(
      artifactStore.read(artifact.storage_ref, { expectedOwner: OWNER }),
    ).resolves.toMatchObject({ artifact });
    await expectStoreCode(
      () =>
        artifactStore.read(artifact.artifact_id, {
          expectedOwner: { ...OWNER, producer_step_id: "other" },
        }),
      "WORKFLOW_HANDOFF_OWNER_MISMATCH",
    );
  });

  it("accepts exact artifact/token limits and rejects plus one", async () => {
    const artifactStore = store();
    const bytes = Buffer.alloc(MAX_WORKFLOW_ARTIFACT_BYTES, 0x61);
    await expect(
      artifactStore.publish({
        owner: OWNER,
        idempotencyKey: "exact",
        bytes,
        tokenCount: MAX_WORKFLOW_STEP_RESULT_TOKENS,
      }),
    ).resolves.toMatchObject({
      byte_length: MAX_WORKFLOW_ARTIFACT_BYTES,
      token_count: MAX_WORKFLOW_STEP_RESULT_TOKENS,
    });
    await expectStoreCode(
      () =>
        artifactStore.publish({
          owner: { ...OWNER, producer_step_id: "plus-byte" },
          idempotencyKey: "plus-byte",
          bytes: Buffer.alloc(MAX_WORKFLOW_ARTIFACT_BYTES + 1),
          tokenCount: 1,
        }),
      "WORKFLOW_HANDOFF_QUOTA",
    );
    await expectStoreCode(
      () =>
        artifactStore.publish({
          owner: { ...OWNER, producer_step_id: "plus-token" },
          idempotencyKey: "plus-token",
          bytes: Buffer.from("x"),
          tokenCount: MAX_WORKFLOW_STEP_RESULT_TOKENS + 1,
        }),
      "WORKFLOW_HANDOFF_INVALID",
    );
  });

  it("is idempotent for two writers and rejects an idempotency conflict", async () => {
    const artifactStore = store();
    const options = {
      owner: OWNER,
      idempotencyKey: "race",
      bytes: Buffer.from("same"),
      tokenCount: 1,
    } as const;
    const [left, right] = await Promise.all([
      artifactStore.publish(options),
      artifactStore.publish(options),
    ]);
    expect(left).toEqual(right);
    expect(await readFile(artifactPath(left.artifact_id), "utf8")).toBe("same");
    await expectStoreCode(
      () =>
        artifactStore.publish({ ...options, bytes: Buffer.from("different") }),
      "WORKFLOW_HANDOFF_CONFLICT",
    );
  });

  it("length-prefixes identity components so embedded NUL tuples cannot collide", async () => {
    const artifactStore = store();
    const left = await publish(artifactStore, "e", "left", {
      run_id: "a",
      workflow_id: "b\u0000c",
      producer_step_id: "d",
    });
    const right = await publish(artifactStore, "e", "right", {
      run_id: "a\u0000b",
      workflow_id: "c",
      producer_step_id: "d",
    });

    expect(left.artifact_id).not.toBe(right.artifact_id);
    await expect(artifactStore.read(left.artifact_id)).resolves.toMatchObject({
      artifact: { owner: { run_id: "a", workflow_id: "b\u0000c" } },
    });
    await expect(artifactStore.read(right.artifact_id)).resolves.toMatchObject({
      artifact: { owner: { run_id: "a\u0000b", workflow_id: "c" } },
    });
  });

  it("samples commit time after artifact installation completes", async () => {
    const artifactStore = store({
      afterArtifactInstalled() {
        now = 2_000_000;
      },
    });

    const artifact = await publish(artifactStore, "delayed-install");

    expect(artifact.created_at_ms).toBe(1_000_000);
    expect(artifact.committed_at_ms).toBe(2_000_000);
  });

  it("fails closed for corrupt bytes, mode changes, and unknown kinds", async () => {
    const artifactStore = store();
    const artifact = await publish(artifactStore, "corrupt", "expected");
    await writeFile(artifactPath(artifact.artifact_id), "tampered");
    await expectStoreCode(
      () => artifactStore.read(artifact.artifact_id),
      "WORKFLOW_HANDOFF_CORRUPT",
    );
    await writeFile(artifactPath(artifact.artifact_id), "expected");
    if (process.platform !== "win32") {
      await chmod(artifactPath(artifact.artifact_id), 0o644);
      await expectStoreCode(
        () => artifactStore.read(artifact.artifact_id),
        "WORKFLOW_HANDOFF_CORRUPT",
      );
    }
    expect(() =>
      driver
        .prepareState<[string]>(
          "UPDATE workflow_handoff_artifacts SET kind = 'future_kind' WHERE artifact_id = ?",
        )
        .run(artifact.artifact_id),
    ).toThrow();
    expect(await readFile(artifactPath(artifact.artifact_id), "utf8")).toBe("expected");
  });

  it("rejects an artifact symlink without reading or deleting its target", async () => {
    if (process.platform === "win32") {
      expect(process.platform).toBe("win32");
      return;
    }
    const artifactStore = store();
    const artifact = await publish(artifactStore, "symlink", "expected");
    const outside = join(temporaryDirectory, "outside.txt");
    await writeFile(outside, "outside-preserved", { mode: 0o600 });
    await unlink(artifactPath(artifact.artifact_id));
    await symlink(outside, artifactPath(artifact.artifact_id));

    await expectStoreCode(
      () => artifactStore.read(artifact.artifact_id),
      "WORKFLOW_HANDOFF_CORRUPT",
    );
    now += 101;
    expect(await artifactStore.cleanupExpired()).toMatchObject({ conflicts: 1 });
    expect(await readFile(outside, "utf8")).toBe("outside-preserved");
  });

  it("detects trusted-root replacement during POSIX atomic publication", async () => {
    if (process.platform === "win32") {
      // The Windows lane exercises the ACL/identity publication path in every
      // publication test above; this failpoint belongs to the POSIX helper.
      expect(process.platform).toBe("win32");
      return;
    }
    const artifactStore = store();
    const movedRoot = `${artifactRoot}.moved`;
    __setAtomicArtifactOperationForTesting(async ({ operation }) => {
      if (operation !== "commit") return;
      await rename(artifactRoot, movedRoot);
      await mkdir(artifactRoot, { mode: 0o700 });
    });

    await expect(publish(artifactStore, "root-race", "must-not-escape")).rejects.toThrow();
    expect((await readdir(artifactRoot)).filter((name) => name.endsWith(".handoff"))).toEqual([]);
  });
});

describe("workflow handoff restart recovery", () => {
  it("removes a reserved intent whose bytes were never installed", async () => {
    const crashing = store({
      afterIntentReserved() {
        throw new Error("crash after reservation");
      },
    });
    await expect(publish(crashing, "reserved")).rejects.toThrow(
      "crash after reservation",
    );
    expect(crashing.listForOperator().entries).toMatchObject([
      { status: "intent" },
    ]);

    const recovered = await store().recoverIntents();
    expect(recovered).toMatchObject({ inspected: 1, removedMissing: 1 });
    expect(store().listForOperator().entries).toEqual([]);
  });

  it("commits a digest-matching installed file exactly once after restart", async () => {
    const crashing = store({
      afterArtifactInstalled() {
        throw new Error("crash after install");
      },
    });
    await expect(publish(crashing, "installed", "durable")).rejects.toThrow(
      "crash after install",
    );

    const restarted = store();
    expect(await restarted.recoverIntents()).toMatchObject({
      inspected: 1,
      committed: 1,
    });
    expect(await restarted.recoverIntents()).toMatchObject({ inspected: 0 });
    const [entry] = restarted.listForOperator().entries;
    expect(entry).toMatchObject({ status: "committed", commit_sequence: 1 });
    const recovered = await restarted.read(entry!.artifact_id);
    expect(Buffer.from(recovered.bytes).toString("utf8")).toBe("durable");
  });

  it("marks a mismatched installed intent as conflict and preserves its bytes", async () => {
    let artifactId = "";
    const crashing = store({
      afterArtifactInstalled(installedArtifactId) {
        artifactId = installedArtifactId;
        throw new Error("crash after install");
      },
    });
    await expect(publish(crashing, "mismatch", "expected")).rejects.toThrow();
    await writeFile(artifactPath(artifactId), "tampered");

    expect(await store().recoverIntents()).toMatchObject({
      inspected: 1,
      conflicts: 1,
    });
    expect(store().inspectForOperator(artifactId).status).toBe("conflict");
    expect(await readFile(artifactPath(artifactId), "utf8")).toBe("tampered");
  });

  it("resumes cleanup after reservation and after unlink", async () => {
    const initial = store();
    const first = await publish(initial, "cleanup-reserved");
    now += 101;
    const reserveCrash = store({
      afterCleanupReserved() {
        throw new Error("crash after cleanup reservation");
      },
    });
    await expect(reserveCrash.cleanupExpired()).rejects.toThrow(
      "crash after cleanup reservation",
    );
    expect(reserveCrash.inspectForOperator(first.artifact_id).status).toBe("deleting");
    expect(await store().cleanupExpired()).toMatchObject({ removed: 1 });

    const second = await publish(store(), "cleanup-unlinked");
    now += 101;
    const unlinkCrash = store({
      afterCleanupFileRemoved() {
        throw new Error("crash after unlink");
      },
    });
    await expect(unlinkCrash.cleanupExpired()).rejects.toThrow(
      "crash after unlink",
    );
    expect(unlinkCrash.inspectForOperator(second.artifact_id).status).toBe("deleting");
    expect(await store().cleanupExpired()).toMatchObject({ missing: 1 });
    expect(store().listForOperator().entries).toEqual([]);
  });
});

describe("workflow handoff reachability, cleanup, quotas, and operator output", () => {
  it("never evicts an active reference and ages from the final release", async () => {
    const artifactStore = store();
    const artifact = await publish(artifactStore, "retained");
    artifactStore.retain(artifact.artifact_id, "consumer-step", "consumer-run");
    now += 1_000;
    expect(await artifactStore.cleanupExpired()).toMatchObject({ inspected: 0 });
    expect(artifactStore.inspectForOperator(artifact.artifact_id).reference_count).toBe(1);
    expect(
      artifactStore.release(
        artifact.artifact_id,
        "consumer-step",
        "consumer-run",
      ),
    ).toBe(true);
    expect(await artifactStore.cleanupExpired()).toMatchObject({ inspected: 0 });
    now += 101;
    expect(await artifactStore.cleanupExpired()).toMatchObject({ removed: 1 });
  });

  it("binds release to the stored consumer and survives clock rollback", async () => {
    const artifactStore = store();
    const artifact = await publish(artifactStore, "bound-release");
    now = 2_000_000;
    artifactStore.retain(artifact.artifact_id, "consumer-step", "consumer-run");

    expect(() =>
      artifactStore.release(
        artifact.artifact_id,
        "consumer-step",
        "other-run",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "WORKFLOW_HANDOFF_OWNER_MISMATCH" }),
    );
    expect(artifactStore.inspectForOperator(artifact.artifact_id).reference_count).toBe(1);

    now = 500_000;
    expect(
      artifactStore.release(
        artifact.artifact_id,
        "consumer-step",
        "consumer-run",
      ),
    ).toBe(true);
    expect(artifactStore.inspectForOperator(artifact.artifact_id)).toMatchObject({
      last_access_at_ms: 2_000_000,
      unreferenced_at_ms: 2_000_000,
      reference_count: 0,
    });
  });

  it("makes cleanup reservation win atomically over a racing retain", async () => {
    const artifactStore = store();
    const artifact = await publish(artifactStore, "retain-race");
    now += 101;

    const cleanup = artifactStore.cleanupExpired();
    expect(() =>
      artifactStore.retain(artifact.artifact_id, "late-ref", "consumer"),
    ).toThrowError(expect.objectContaining({ code: "WORKFLOW_HANDOFF_NOT_COMMITTED" }));
    await expect(cleanup).resolves.toMatchObject({ removed: 1 });
  });

  it("uses bounded keyset cleanup pages at 256/257", async () => {
    const artifactStore = store();
    for (let index = 0; index < MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH + 1; index += 1) {
      await publish(
        artifactStore,
        `page-${index}`,
        "x",
        { ...OWNER, producer_step_id: `step-${index}` },
      );
    }
    now += 101;
    expect(await artifactStore.cleanupExpired()).toMatchObject({
      inspected: MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
      removed: MAX_WORKFLOW_ARTIFACT_CLEANUP_BATCH,
      truncated: true,
    });
    expect(await artifactStore.cleanupExpired()).toMatchObject({
      inspected: 1,
      removed: 1,
      truncated: false,
    });
  });

  it("enforces exact per-run and global byte quotas without creating bytes", async () => {
    seedIntents({
      count: MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN / MAX_WORKFLOW_ARTIFACT_BYTES,
      runId: () => OWNER.run_id,
      byteLength: MAX_WORKFLOW_ARTIFACT_BYTES,
    });
    expect(
      driver
        .prepareState<[], { readonly bytes: number }>(
          "SELECT SUM(byte_length) AS bytes FROM workflow_handoff_artifacts",
        )
        .get()?.bytes,
    ).toBe(MAX_WORKFLOW_ARTIFACT_BYTES_PER_RUN);
    await expectStoreCode(
      () => publish(store(), "per-run-plus-one", "x"),
      "WORKFLOW_HANDOFF_QUOTA",
    );

    driver.prepareState("DELETE FROM workflow_handoff_artifacts").run();
    seedIntents({
      count: MAX_WORKFLOW_ARTIFACT_BYTES_GLOBAL / MAX_WORKFLOW_ARTIFACT_BYTES,
      runId: (index) => `global-run-${index}`,
      byteLength: MAX_WORKFLOW_ARTIFACT_BYTES,
    });
    await expectStoreCode(
      () =>
        publish(store(), "global-plus-one", "x", {
          ...OWNER,
          run_id: "new-global-run",
        }),
      "WORKFLOW_HANDOFF_QUOTA",
    );
  });

  it("enforces exact per-run and global artifact-count quotas", async () => {
    seedIntents({
      count: MAX_WORKFLOW_ARTIFACTS_PER_RUN,
      runId: () => OWNER.run_id,
      byteLength: 0,
    });
    await expectStoreCode(
      () => publish(store(), "per-run-count-plus-one", ""),
      "WORKFLOW_HANDOFF_QUOTA",
    );

    driver.prepareState("DELETE FROM workflow_handoff_artifacts").run();
    seedIntents({
      count: MAX_WORKFLOW_ARTIFACTS_GLOBAL,
      runId: (index) => `count-run-${index}`,
      byteLength: 0,
    });
    await expectStoreCode(
      () =>
        publish(store(), "global-count-plus-one", "", {
          ...OWNER,
          run_id: "new-count-run",
        }),
      "WORKFLOW_HANDOFF_QUOTA",
    );
    expect(
      driver
        .prepareState<[], { readonly artifact_count: number }>(
          `SELECT artifact_count FROM workflow_handoff_quota_global
           WHERE singleton = 1`,
        )
        .get()?.artifact_count,
    ).toBe(MAX_WORKFLOW_ARTIFACTS_GLOBAL);
    const plans = [
      ...driver
        .prepareState<[], { readonly detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT artifact_count, artifact_bytes
           FROM workflow_handoff_quota_global WHERE singleton = 1`,
        )
        .all(),
      ...driver
        .prepareState<[string], { readonly detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT artifact_count, artifact_bytes
           FROM workflow_handoff_quota_runs WHERE run_id = ?`,
        )
        .all("count-run-1"),
    ];
    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => !plan.detail.includes("SCAN"))).toBe(true);
  });

  it("pages content-free operator metadata without reading output bytes", async () => {
    const artifactStore = store();
    const left = await publish(artifactStore, "operator-a", "SECRET-A");
    await publish(artifactStore, "operator-b", "SECRET-B");
    artifactStore.retain(left.artifact_id, "ref", "consumer");

    const first = artifactStore.listForOperator(1);
    expect(first.entries).toHaveLength(1);
    expect(first.next_artifact_id).toBe(first.entries[0]!.artifact_id);
    expect(first.entries[0]).not.toHaveProperty("preview");
    expect(first.entries[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(first)).not.toContain("SECRET");
    const second = artifactStore.listForOperator(1, first.next_artifact_id);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.artifact_id).not.toBe(first.entries[0]!.artifact_id);
  });
});
