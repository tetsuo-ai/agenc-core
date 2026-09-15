import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSameExecutionEnvironment, executionEnvironmentFromSessionMeta, readExecutionEnvironmentBinding } from "../../src/execution/binding.js";
import { SessionStore, readAndValidateSchemaVersion } from "../../src/session/session-store.js";
import { readTurnCheckpoint } from "../../src/session/durable-checkpoint-reader.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import type { Event, SessionMetaLine } from "../../src/session/event-log.js";
import { isCanonicalEventPayload, isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";
import { runTurnKernel } from "../../src/session/run-turn.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";

const binding = { kind: "docker" as const, containerId: "a".repeat(64), generation: "b".repeat(64), processHandleNamespace: "c".repeat(32) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const checkpoint = {
  turnId: "turn", iterationIndex: 0, boundary: "iteration" as const, checkpointSeq: 1,
  persistedMessageCount: 0, prefixHash: "d".repeat(64), checkpointVersion: 5 as const,
  prefixHashVersion: 3 as const, toolResultIntegrityVersion: 1 as const, executionEnvironment: binding,
  executionProcesses: { version: 1 as const, binding, ownerId: "session", authorityRevision: 0, admission: "open" as const, entries: [] },
  resumableState: { turnCount: 0, recoveryReentryCount: 0, maxOutputTokensRecoveryCount: 0,
    continuationNudgeCount: 0, stopHookBlockingCount: 0, taskBudgetRemaining: 4242 },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agenc-execution-binding-")); roots.push(root);
  const meta = { sessionId: "session", timestamp: new Date().toISOString(), cwd: root,
    originator: "test", agencVersion: "0.17.0", executionEnvironment: binding };
  const options = { sessionId: meta.sessionId, cwd: root, agencHome: root, agencVersion: meta.agencVersion };
  return { meta, options, store: new SessionStore(options) };
}

it("round-trips a v5 binding and freezes a copy without credentials or selectors", () => {
  const payload = JSON.parse(JSON.stringify(checkpoint));
  const read = readTurnCheckpoint(payload);
  expect(read).toMatchObject({ version: 5, sourceVersion: 5, checkpoint: { executionEnvironment: binding } });
  if (read.version !== 5) throw new Error("Expected checkpoint v5");
  payload.executionEnvironment.generation = "e".repeat(64);
  expect(read.checkpoint.executionEnvironment).toEqual(binding);
  expect(Object.isFrozen(read.checkpoint.executionEnvironment)).toBe(true);
  expect(Object.isFrozen(read.checkpoint.executionProcesses?.entries)).toBe(true);
  for (const executionEnvironment of [undefined, { kind: "docker", container: "task" },
    { ...binding, processHandleNamespace: undefined }, { ...binding, controlSocket: "/private" },
    { ...binding, generation: "b\n" }, { kind: "local", containerId: binding.containerId }]) {
    expect(() => readTurnCheckpoint({ ...checkpoint, executionEnvironment })).toThrow(/environment|unversioned/);
  }
});

it("requires original process recovery state for container checkpoints and forbids it on local or legacy checkpoints", () => {
  for (const executionProcesses of [undefined, { ...checkpoint.executionProcesses, binding: { ...binding, generation: "e".repeat(64) } },
    { ...checkpoint.executionProcesses, admission: "open", failure: { code: "unknown_outcome", message: "input lost", requestSent: true } }]) {
    expect(() => readTurnCheckpoint({ ...checkpoint, executionProcesses })).toThrow(/process recovery/);
  }
  expect(() => readTurnCheckpoint({ ...checkpoint, executionEnvironment: { kind: "local" } })).toThrow(/process recovery/);
  expect(() => readTurnCheckpoint({ ...checkpoint, checkpointVersion: 4 })).toThrow(/unversioned/);
  expect(isCanonicalEventPayload("turn_checkpoint", checkpoint)).toBe(true);
});

it("keeps legacy rollouts local and rejects a new missing identity or a replaced generation/store", () => {
  for (const rolloutSchemaVersion of [0, 1, 2, 3, 4, 5]) {
    expect(executionEnvironmentFromSessionMeta({ rolloutSchemaVersion })).toEqual({ kind: "local" });
    expect(() => executionEnvironmentFromSessionMeta({ rolloutSchemaVersion, executionEnvironment: binding })).toThrow(/Legacy/);
  }
  expect(() => executionEnvironmentFromSessionMeta({ rolloutSchemaVersion: 6 })).toThrow(/missing or invalid/);
  for (const changed of [{ kind: "local" } as const, { ...binding, containerId: "e".repeat(64) },
    { ...binding, generation: "e".repeat(64) }, { ...binding, processHandleNamespace: "e".repeat(32) }]) {
    expect(() => assertSameExecutionEnvironment(binding, changed)).toThrow(/Original execution environment/);
  }
  expect(readExecutionEnvironmentBinding({ ...binding })).toEqual(binding);
});

it("writes schema 6 and refuses a mismatched resume before repairing the original journal tail", async () => {
  const { store, options, meta } = fixture();
  store.open(meta);
  const path = store.rolloutPath;
  await store.close();
  expect(readAndValidateSchemaVersion(path)).toMatchObject({ rolloutSchemaVersion: 6, executionEnvironment: binding });
  appendFileSync(path, '{"incomplete":');
  const original = readFileSync(path);
  for (const executionEnvironment of [undefined, { ...binding, generation: "e".repeat(64) },
    { ...binding, processHandleNamespace: "e".repeat(32) }]) {
    const resumed = new SessionStore({ ...options, resume: true, resumeRolloutPath: path });
    expect(() => resumed.open({ ...meta, executionEnvironment })).toThrow(/Original execution environment/);
    expect(readFileSync(path)).toEqual(original);
    await resumed.close();
  }
  const resumed = new SessionStore({ ...options, resume: true, resumeRolloutPath: path });
  try { resumed.open(meta); expect(readFileSync(path).length).toBeLessThan(original.length); }
  finally { await resumed.close(); }
});

it("refuses checkpoint and metadata identity changes through both canonical append entrypoints", async () => {
  const { store, meta } = fixture(); store.open(meta);
  const event: Event = { id: "cp", msg: { type: "turn_checkpoint", payload: checkpoint } };
  try {
    expect(store.append(event)).toBe(true);
    const changed: Event = { id: "wrong", msg: { type: "turn_checkpoint", payload: { ...checkpoint, executionEnvironment: { kind: "local" } } } };
    expect(() => store.append(changed)).toThrow(/Original execution environment/);
    expect(() => store.appendRollout({ type: "event_msg", payload: changed })).toThrow(/Original execution environment/);
    expect(() => store.appendRollout({ type: "session_meta", payload: { ...meta, rolloutSchemaVersion: 6, executionEnvironment: { kind: "local" } } })).toThrow(/Original execution environment/);
    expect(() => store.appendRollout({ type: "session_meta", payload: { ...meta, rolloutSchemaVersion: 5 } })).toThrow(/Legacy/);
    expect(() => store.append({ id: "wrong-meta", msg: { type: "session_meta", payload: { ...meta,
      rolloutSchemaVersion: 6, executionEnvironment: { kind: "local" } } } })).toThrow(/Original execution environment/);
  } finally { await store.close(); }
});

it("preserves binding during reconstruction and refuses conflicting metadata even outside the replay suffix", () => {
  const meta: SessionMetaLine = { sessionId: "session", timestamp: new Date().toISOString(), cwd: "/app",
    originator: "test", agencVersion: "0.17.0", rolloutSchemaVersion: 6, executionEnvironment: binding };
  expect(reconstructFromRollout([{ type: "session_meta", payload: meta }]).executionEnvironment).toEqual(binding);
  expect(() => reconstructFromRollout([{ type: "session_meta", payload: meta },
    { type: "session_meta", payload: { ...meta, executionEnvironment: { kind: "local" } } }])).toThrow(/Original execution environment/);
  expect(() => reconstructFromRollout([{ type: "session_meta", payload: { ...meta, executionEnvironment: undefined } }])).toThrow(/missing or invalid/);
  expect(isCanonicalEventPayload("session_meta", meta)).toBe(true);
  expect(isCanonicalRolloutPayload("session_meta", meta)).toBe(true);
  expect(isCanonicalRolloutPayload("session_meta", { ...meta, executionEnvironment: undefined })).toBe(false);
  expect(isCanonicalEventPayload("session_meta", { ...meta, executionEnvironment: { ...binding, container: "mutable-name" } })).toBe(false);
  expect(isCanonicalRolloutPayload("session_meta", { ...meta, rolloutSchemaVersion: 5 })).toBe(false);
  const { executionEnvironment: _binding, ...legacy } = meta;
  expect(isCanonicalRolloutPayload("session_meta", { ...legacy, rolloutSchemaVersion: 5 })).toBe(true);
});

it("rejects resumed execution before entering turn work when a binding is missing or changed", async () => {
  for (const [selected, persisted] of [[{ kind: "local" } as const, binding], [binding, undefined],
    [binding, { ...binding, processHandleNamespace: "e".repeat(32) }]] as const) {
    const session = new Proxy({ services: { unifiedExecManager: { executionEnvironmentBinding: selected } } }, {
      get(target, key) { if (key !== "services") throw new Error("Turn work started before checking execution identity"); return target.services; },
    }) as unknown as Session;
    const turn = runTurnKernel(session, {} as TurnContext, "", { resume: { turnId: "turn", fromIteration: 0,
      fromCheckpointSeq: 1, persistedMessageCount: 0, restoreSlice: checkpoint.resumableState, executionEnvironment: persisted } });
    await expect(turn.next()).rejects.toMatchObject({ code: "execution_environment_changed" });
  }
});
