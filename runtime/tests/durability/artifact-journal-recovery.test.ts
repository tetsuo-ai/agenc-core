import { createHash } from "node:crypto";
import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getOriginalCwd,
  getSessionId,
  setOriginalCwd,
  switchSession,
} from "../../src/bootstrap/state.js";
import {
  __setAtomicArtifactOperationForTesting,
  AtomicArtifactUnsafePathError,
  commitArtifactAtomically,
} from "../../src/durability/atomic-artifact.js";
import {
  EventLog,
  type ArtifactIntentEvent,
  type Event,
} from "../../src/session/event-log.js";
import { runWithCurrentRuntimeSession } from "../../src/session/current-session.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import type { Session } from "../../src/session/session.js";
import { asSessionId } from "../../src/types/ids.js";
import {
  getToolResultPath,
  getToolResultsDir,
  persistToolResult,
} from "../../src/utils/toolResultStorage.js";

const OPENED_AT = "2026-07-18T00:00:00.000Z";
const HAS_DESCRIPTOR_CHILD_PATHS =
  process.platform === "linux" || process.platform === "darwin";
const created: string[] = [];
let previousAgencHome: string | undefined;
let previousCwd: string;
let previousSessionId: ReturnType<typeof getSessionId>;

beforeEach(() => {
  previousAgencHome = process.env.AGENC_HOME;
  previousCwd = getOriginalCwd();
  previousSessionId = getSessionId();
});

afterEach(() => {
  __setAtomicArtifactOperationForTesting(undefined);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  setOriginalCwd(previousCwd);
  switchSession(previousSessionId);
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function workspace(runId: string): { cwd: string; rollout: RolloutStore } {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-m4-artifact-journal-"));
  created.push(cwd);
  process.env.AGENC_HOME = join(cwd, ".agenc-home");
  setOriginalCwd(cwd);
  switchSession(asSessionId(runId));
  return { cwd, rollout: openStore(cwd, runId) };
}

function openStore(cwd: string, runId: string, resume = false): RolloutStore {
  const rollout = new RolloutStore({
    cwd,
    sessionId: runId,
    agencVersion: "0.6.2",
    autoStartScheduler: false,
    ...(resume ? { resume: true } : {}),
  });
  rollout.open({
    sessionId: runId,
    timestamp: OPENED_AT,
    cwd,
    originator: "m4-artifact-journal-test",
    agencVersion: "0.6.2",
  });
  return rollout;
}

function sessionFor(rollout: RolloutStore): Session {
  const eventLog = new EventLog();
  return {
    conversationId: rollout.sessionId,
    rolloutStore: rollout,
    eventLog,
    emit(event: Event): Event {
      const stamped = eventLog.stamp(event);
      if (!rollout.append(stamped, { durable: true })) {
        throw new Error("test journal append failed");
      }
      eventLog.publish(stamped);
      return stamped;
    },
  } as unknown as Session;
}

function artifactEvents(rollout: RolloutStore): Event[] {
  return rollout
    .readAll()
    .filter((item) => item.type === "event_msg")
    .map((item) => item.payload);
}

function intentPayload(
  runId: string,
  targetPath: string,
  content: string,
): ArtifactIntentEvent {
  const bytes = Buffer.from(content, "utf8");
  return {
    runId,
    artifactId: `artifact-${runId}`,
    kind: "tool_result",
    sourceCallId: "call-1",
    targetPath,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    recordedAt: OPENED_AT,
  };
}

async function publishArtifact(
  targetPath: string,
  content: string,
): Promise<void> {
  const trustedRoot = dirname(targetPath);
  mkdirSync(trustedRoot, { recursive: true });
  await commitArtifactAtomically(targetPath, content, { trustedRoot });
}

describe("M4 artifact journal recovery", () => {
  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "journals immutable tool-result intent before publication and acknowledgement after it",
    async () => {
      const runId = "run-artifact-normal";
      const { rollout } = workspace(runId);
      const session = sessionFor(rollout);

      const result = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("durable bytes", "call-normal"),
      );
      expect(result).not.toHaveProperty("error");
      let retryTailSyncs = 0;
      rollout.store.setFsyncImplForTest((fd) => {
        retryTailSyncs += 1;
        fsyncSync(fd);
      });
      const replay = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("durable bytes", "call-normal"),
      );
      expect(replay).toEqual(result);
      expect(retryTailSyncs).toBe(2);
      rollout.store.setFsyncImplForTest(fsyncSync);
      const events = artifactEvents(rollout);
      expect(events.map((event) => event.msg.type)).toEqual([
        "artifact_intent",
        "artifact_committed",
      ]);
      expect(events.map((event) => event.eventId)).toEqual(
        events.map((event) => event.id),
      );
      expect(events[1]).toMatchObject({
        id:
          events[0]?.msg.type === "artifact_intent"
            ? `artifact-committed:${events[0].msg.payload.artifactId}`
            : "missing-artifact-intent",
        msg: {
          payload: {
            intentEventSeq: events[0]!.seq,
            outcome: "committed",
            byteLength: Buffer.byteLength("durable bytes"),
          },
        },
      });
      expect(
        readFileSync(getToolResultPath("call-normal", false), "utf8"),
      ).toBe("durable bytes");
      rollout.close();
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "keys artifact idempotency by canonical eventId, not reusable correlation id",
    async () => {
      const runId = "run-artifact-correlation-collision";
      const callId = "call-correlation-collision";
      const { rollout } = workspace(runId);
      const session = sessionFor(rollout);
      const artifactId = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            runId,
            kind: "tool_result",
            sourceCallId: callId,
          }),
          "utf8",
        )
        .digest("hex");
      session.emit({
        eventId: "unrelated-intent-canonical",
        id: `artifact-intent:${artifactId}`,
        msg: {
          type: "user_message",
          payload: { message: "correlation ids are reusable" },
        },
      });
      session.emit({
        eventId: "unrelated-commit-canonical",
        id: `artifact-committed:${artifactId}`,
        msg: {
          type: "user_message",
          payload: { message: "correlation ids are reusable" },
        },
      });

      const result = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("durable bytes", callId),
      );
      expect(result).not.toHaveProperty("error");
      const artifactLifecycle = artifactEvents(rollout).filter(
        (event) =>
          event.msg.type === "artifact_intent" ||
          event.msg.type === "artifact_committed",
      );
      expect(artifactLifecycle.map((event) => event.eventId)).toEqual([
        `artifact-intent:${artifactId}`,
        `artifact-committed:${artifactId}`,
      ]);
      rollout.close();
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "rejects different bytes for the same logical artifact without a second transition",
    async () => {
      const runId = "run-artifact-content-conflict";
      const { rollout } = workspace(runId);
      const session = sessionFor(rollout);

      const first = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("first bytes", "call-conflict"),
      );
      expect(first).not.toHaveProperty("error");
      const conflict = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("different bytes", "call-conflict"),
      );

      expect(conflict).toMatchObject({
        error: expect.stringContaining("conflicting journal evidence"),
      });
      expect(artifactEvents(rollout).map((event) => event.msg.type)).toEqual([
        "artifact_intent",
        "artifact_committed",
      ]);
      expect(
        readFileSync(getToolResultPath("call-conflict", false), "utf8"),
      ).toBe("first bytes");
      rollout.close();
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "keeps provider-controlled call ids inside the tool-result directory",
    async () => {
      const runId = "run-artifact-unsafe-call-id";
      const { rollout } = workspace(runId);
      const session = sessionFor(rollout);

      const result = await runWithCurrentRuntimeSession(session, () =>
        persistToolResult("contained bytes", "../../escaped/tool"),
      );
      if ("error" in result) throw new Error(result.error);

      expect(dirname(result.filepath)).toBe(getToolResultsDir());
      expect(readFileSync(result.filepath, "utf8")).toBe("contained bytes");
      expect(artifactEvents(rollout)[0]).toMatchObject({
        msg: {
          type: "artifact_intent",
          payload: {
            sourceCallId: "../../escaped/tool",
            targetPath: result.filepath,
          },
        },
      });
      rollout.close();
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "proves a published artifact from bytes when its acknowledgement was lost",
    async () => {
      const runId = "run-artifact-recovered";
      const { cwd, rollout } = workspace(runId);
      const targetPath = getToolResultPath("call-1", false);
      const payload = intentPayload(runId, targetPath, "complete bytes");
      expect(
        rollout.append(
          {
            id: "artifact-intent-1",
            seq: 1,
            msg: { type: "artifact_intent", payload },
          },
          { durable: true },
        ),
      ).toBe(true);
      await publishArtifact(targetPath, "complete bytes");
      rollout.close();

      const resumed = openStore(cwd, runId, true);
      expect(artifactEvents(resumed).at(-1)).toMatchObject({
        msg: {
          type: "artifact_committed",
          payload: {
            intentEventSeq: 1,
            outcome: "recovered",
            contentSha256: payload.contentSha256,
          },
        },
      });
      resumed.close();
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "never journals external matching bytes after the artifact root is swapped",
    () => {
      const runId = "run-artifact-observation-root-swap";
      const { cwd, rollout } = workspace(runId);
      const targetPath = getToolResultPath("call-1", false);
      const trustedRoot = dirname(targetPath);
      const movedRoot = `${trustedRoot}-original`;
      const externalRoot = join(cwd, "external-artifacts");
      const content = "external matching bytes";
      const payload = intentPayload(runId, targetPath, content);
      const journalPath = rollout.rolloutPath;
      rollout.append(
        {
          eventId: "canonical-artifact-observation-swap",
          id: "artifact-observation-swap",
          seq: 1,
          msg: { type: "artifact_intent", payload },
        },
        { durable: true },
      );
      mkdirSync(trustedRoot, { recursive: true });
      mkdirSync(externalRoot, { recursive: true });
      writeFileSync(join(externalRoot, "call-1.txt"), content);
      rollout.close();
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "observe") return;
        renameSync(trustedRoot, movedRoot);
        symlinkSync(externalRoot, trustedRoot, "dir");
      });

      expect(() => openStore(cwd, runId, true)).toThrow(
        AtomicArtifactUnsafePathError,
      );

      const journal = readFileSync(journalPath, "utf8");
      expect(journal).not.toContain('\"type\":\"artifact_committed\"');
      expect(readFileSync(join(externalRoot, "call-1.txt"), "utf8")).toBe(
        content,
      );
    },
  );

  it("defers a safe retry when publication never happened", () => {
    const runId = "run-artifact-missing";
    const { cwd, rollout } = workspace(runId);
    const payload = intentPayload(
      runId,
      getToolResultPath("call-1", false),
      "not published",
    );
    rollout.append(
      {
        id: "artifact-intent-missing",
        seq: 1,
        msg: { type: "artifact_intent", payload },
      },
      { durable: true },
    );
    rollout.close();

    const resumed = openStore(cwd, runId, true);
    expect(artifactEvents(resumed).at(-1)).toMatchObject({
      msg: {
        type: "recovery_decision",
        payload: {
          decision: "artifact_retry_safe_deferred",
          evidenceEventSeq: 1,
        },
      },
    });
    resumed.close();
  });

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "records a matching commit after an earlier deferred retry decision",
    async () => {
      const runId = "run-artifact-deferred-then-published";
      const { cwd, rollout } = workspace(runId);
      const targetPath = getToolResultPath("call-1", false);
      const payload = intentPayload(
        runId,
        targetPath,
        "published on explicit retry",
      );
      rollout.append(
        {
          eventId: "canonical-artifact-intent-retry",
          id: "artifact-intent-retry",
          seq: 1,
          msg: { type: "artifact_intent", payload },
        },
        { durable: true },
      );
      rollout.close();

      const deferred = openStore(cwd, runId, true);
      expect(artifactEvents(deferred).at(-1)).toMatchObject({
        msg: {
          type: "recovery_decision",
          payload: {
            decision: "artifact_retry_safe_deferred",
            evidenceEventSeq: 1,
          },
        },
      });
      deferred.close();

      // An explicit owner safely retries publication, then dies before it can
      // append artifact_committed. The old deferred decision must not suppress
      // the newly observable matching target on the next recovery.
      await publishArtifact(targetPath, "published on explicit retry");
      const recovered = openStore(cwd, runId, true);
      const events = artifactEvents(recovered);
      expect(events.map((event) => event.msg.type)).toEqual([
        "artifact_intent",
        "recovery_decision",
        "artifact_committed",
      ]);
      expect(events.at(-1)).toMatchObject({
        msg: {
          type: "artifact_committed",
          payload: {
            intentEventSeq: 1,
            outcome: "recovered",
            contentSha256: payload.contentSha256,
          },
        },
      });
      recovered.close();
    },
  );

  it("allocates one contiguous recovery sequence across artifacts and effects", () => {
    const runId = "run-artifact-and-effect-recovery";
    const { cwd, rollout } = workspace(runId);
    const payload = intentPayload(
      runId,
      getToolResultPath("call-artifact", false),
      "not published",
    );
    rollout.append(
      {
        id: "artifact-intent-combined",
        seq: 1,
        msg: { type: "artifact_intent", payload },
      },
      { durable: true },
    );
    rollout.append(
      {
        id: "effect-intent-combined",
        seq: 2,
        msg: {
          type: "effect_intent",
          payload: {
            runId,
            stepId: "tool:turn-1:call-effect",
            callId: "call-effect",
            toolName: "side-effect-test",
            recoveryCategory: "side-effecting",
            intentDigest: "sha256:combined-effect",
            attempt: 1,
            recordedAt: OPENED_AT,
          },
        },
      },
      { durable: true },
    );
    rollout.close();

    const resumed = openStore(cwd, runId, true);
    const events = artifactEvents(resumed);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.msg.type)).toEqual([
      "artifact_intent",
      "effect_intent",
      "recovery_decision",
      "effect_unknown_outcome",
    ]);
    resumed.close();

    const replayed = openStore(cwd, runId, true);
    expect(artifactEvents(replayed).map((event) => event.seq)).toEqual([
      1, 2, 3, 4,
    ]);
    replayed.close();
  });

  it("never overwrites mismatched artifact evidence and requires review", () => {
    const runId = "run-artifact-conflict";
    const { cwd, rollout } = workspace(runId);
    const targetPath = getToolResultPath("call-1", false);
    const payload = intentPayload(runId, targetPath, "expected");
    rollout.append(
      {
        id: "artifact-intent-conflict",
        seq: 1,
        msg: { type: "artifact_intent", payload },
      },
      { durable: true },
    );
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "different");
    rollout.close();

    const resumed = openStore(cwd, runId, true);
    expect(artifactEvents(resumed).at(-1)).toMatchObject({
      msg: {
        type: "recovery_decision",
        payload: { decision: "artifact_conflict_review_required" },
      },
    });
    expect(readFileSync(targetPath, "utf8")).toBe("different");
    resumed.close();
  });
});
