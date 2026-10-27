/**
 * Child process used by the M4 crash/restart acceptance matrix.
 *
 * The crash command is always run with the guarded production failpoint token
 * and therefore dies by SIGKILL. The recover command opens the same on-disk
 * state in a fresh process and emits a JSON report for the parent test.
 */

import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { M4DurabilityFailpoint } from "../../../src/durability/failpoints.js";
import type { Event } from "../../../src/session/event-log.js";

const RUN_ID = "m4-failure-matrix-run";
const TOOL_STEP_ID = "tool:turn-1:call-1";
const OPENED_AT = "2026-07-18T00:00:00.000Z";
const FINISHED_AT = "2026-07-18T00:00:01.000Z";

type Command = "crash" | "recover" | "steps" | "recover-steps";

/**
 * Power-loss variant (turn-scoped durability): the crash child runs inside one
 * turn scope and logs the journal size at every fsync, so the parent can cut
 * the journal back to its last synced byte, as an OS crash or power loss
 * would, before recovery runs. SQLite keeps every commit (FULL).
 */
const POWER_LOSS_LOG_ENV = "AGENC_TEST_TURN_POWER_LOSS_LOG";

/**
 * Mirror variant: the steps child also keeps the SQLite mirror of its rollout
 * (`thread_rollout_items`) current, as FileThreadStore does for a live
 * recorder: one index when it binds, then one after every rollout commit.
 * Every projection that commits at synchronous=NORMAL ("rebuildable") is
 * logged with the WAL bytes before and after it, so the parent can find the
 * WAL bytes a power loss keeps (the end of the last FULL commit) and cut the
 * WAL there. The recover-steps child then reports the mirror against a fresh
 * projection of the journal, before and after production recovery.
 */
const MIRROR_WAL_LOG_ENV = "AGENC_TEST_MIRROR_WAL_LOG";
const MIRROR_RECOVERY_ENV = "AGENC_TEST_MIRROR_RECOVERY";

interface FixturePaths {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly modelReceipt: string;
  readonly toolReceipt: string;
  readonly liveObservations: string;
}

interface CanonicalEvent extends Event {
  readonly eventId: string;
  readonly seq: number;
}

function requireArgument(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function pathsFor(root: string): FixturePaths {
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  process.env.AGENC_HOME = home;
  return {
    root,
    home,
    cwd,
    modelReceipt: join(root, "physical", "model-response.jsonl"),
    toolReceipt: join(root, "physical", "tool-invocation.jsonl"),
    liveObservations: join(root, "transport", "live-observations.jsonl"),
  };
}

function appendJsonDurably(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function canonicalEvents(paths: FixturePaths): CanonicalEvent[] {
  return walkFiles(paths.home)
    .filter((path) => /rollout-.*\.jsonl$/.test(path))
    .flatMap((path) => readJsonLines(path))
    .flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        (item as { type?: unknown }).type !== "event_msg"
      ) {
        return [];
      }
      const event = (item as { payload?: unknown }).payload;
      if (
        typeof event !== "object" ||
        event === null ||
        !Number.isSafeInteger((event as { seq?: unknown }).seq) ||
        typeof (event as { eventId?: unknown }).eventId !== "string" ||
        (event as { eventId: string }).eventId.length === 0
      ) {
        throw new Error(`canonical event lacks durable coordinates in ${path}`);
      }
      return [event as CanonicalEvent];
    })
    .sort((left, right) => left.seq - right.seq);
}

/** Size of a WAL file and its header salts (they change when the WAL restarts). */
function walMark(walPath: string): { readonly bytes: number; readonly salt: string } {
  if (!existsSync(walPath)) return { bytes: 0, salt: "" };
  const fd = openSync(walPath, "r");
  try {
    const salt = Buffer.alloc(8);
    const read = readSync(fd, salt, 0, 8, 16);
    return { bytes: fstatSync(fd).size, salt: read === 8 ? salt.toString("hex") : "" };
  } finally {
    closeSync(fd);
  }
}

interface RolloutCommitSource {
  readonly rolloutPath: string;
  setOnRolloutCommitted(listener: ((rolloutPath: string) => void) | undefined): void;
}

/**
 * Keep the rollout's SQLite mirror current exactly as FileThreadStore does
 * for a live recorder (prepareLiveRecorder, then bindLiveRecorder): index the
 * file once, then after every rollout commit. With `walLog`, every top-level
 * rebuildable (NORMAL) projection commit is logged with its WAL bytes.
 */
async function bindRolloutMirror(
  paths: FixturePaths,
  source: RolloutCommitSource,
  walLog?: string,
) {
  const [{ openStateDatabases }, { StateThreadRepository }, { backfillRolloutFile }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/threads.js"),
      import("../../../src/state/backfill.js"),
    ]);
  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  if (walLog !== undefined) {
    const wal = `${driver.stateDbPath}-wal`;
    const commit = driver.transactionImmediate.bind(driver);
    driver.transactionImmediate = ((fn: () => unknown, durability?: "full" | "rebuildable") => {
      // A nested call commits with its outer transaction, at that level.
      if (durability !== "rebuildable" || driver.state.inTransaction) return commit(fn, durability);
      const before = walMark(wal);
      const result = commit(fn, durability);
      const after = walMark(wal);
      appendJsonDurably(walLog, {
        before: before.bytes,
        after: after.bytes,
        saltBefore: before.salt,
        salt: after.salt,
      });
      return result;
    }) as typeof driver.transactionImmediate;
  }
  const threads = new StateThreadRepository(driver);
  const index = (): void => {
    backfillRolloutFile({ rolloutPath: source.rolloutPath, threads });
  };
  index();
  source.setOnRolloutCommitted(() => index());
  return {
    stateDbPath: driver.stateDbPath,
    close(): void {
      source.setOnRolloutCommitted(undefined);
      driver.close();
    },
  };
}

interface MirrorRow {
  readonly line_number: number;
  readonly byte_offset: number;
  readonly item_index: number;
  readonly item_type: string;
  readonly event_version: number | null;
  readonly event_id: string | null;
  readonly event_seq: number | null;
  readonly payload_json: string;
  readonly line_hash: string;
}

const MIRROR_ROW_SQL = `SELECT line_number, byte_offset, item_index, item_type, event_version,
  event_id, event_seq, payload_json, line_hash
  FROM thread_rollout_items WHERE source_path = ? ORDER BY line_number`;

/**
 * The mirror's rows for one rollout against a fresh projection of the
 * journal's current bytes into an empty database (the oracle).
 */
async function compareMirror(paths: FixturePaths, rolloutPath: string) {
  const [{ openStateDatabases }, { StateThreadRepository }, { backfillRolloutFile }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/threads.js"),
      import("../../../src/state/backfill.js"),
    ]);
  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  let mirror: MirrorRow[];
  try {
    mirror = driver.prepareState<[string], MirrorRow>(MIRROR_ROW_SQL).all(rolloutPath);
  } finally {
    driver.close();
  }
  const oracleRoot = join(paths.root, `mirror-oracle-${process.pid}`);
  const oracleCwd = join(oracleRoot, "workspace");
  mkdirSync(join(oracleCwd, ".git"), { recursive: true });
  const oracle = openStateDatabases({ cwd: oracleCwd, agencHome: join(oracleRoot, "home") });
  let journal: MirrorRow[];
  try {
    backfillRolloutFile({ rolloutPath, threads: new StateThreadRepository(oracle) });
    journal = oracle.prepareState<[string], MirrorRow>(MIRROR_ROW_SQL).all(rolloutPath);
  } finally {
    oracle.close();
    rmSync(oracleRoot, { recursive: true, force: true });
  }
  const key = (row: MirrorRow) => JSON.stringify(row);
  const mirrorKeys = new Set(mirror.map(key));
  const journalKeys = new Set(journal.map(key));
  return {
    journalRows: journal.length,
    mirrorRows: mirror.length,
    /** Journal rows the mirror lacks (a projection a power loss dropped). */
    missing: journal.filter((row) => !mirrorKeys.has(key(row))).length,
    /** Mirror rows the journal lacks (journal bytes a power loss dropped). */
    extra: mirror.filter((row) => !journalKeys.has(key(row))).length,
    equal: mirror.length === journal.length && mirror.every((row, index) => key(row) === key(journal[index]!)),
  };
}

async function openRolloutSession(
  paths: FixturePaths,
  options: { readonly resume?: boolean; readonly observeLive?: boolean } = {},
) {
  const [{ EventLog, isDurableEvent }, { RolloutStore }, { hitM4DurabilityFailpoint }] = await Promise.all([
    import("../../../src/session/event-log.js"),
    import("../../../src/session/rollout-store.js"),
    import("../../../src/durability/failpoints.js"),
  ]);
  const rolloutStore = new RolloutStore({
    cwd: paths.cwd,
    sessionId: RUN_ID,
    agencVersion: "0.6.2",
    sessionTempRoot: paths.root,
    autoStartScheduler: false,
    ...(options.resume === true ? { resume: true } : {}),
  });
  rolloutStore.open({
    sessionId: RUN_ID,
    timestamp: OPENED_AT,
    cwd: paths.cwd,
    originator: "m4-failure-matrix",
    agencVersion: "0.6.2",
  });
  const powerLossLog = process.env[POWER_LOSS_LOG_ENV];
  if (options.resume !== true && powerLossLog !== undefined) {
    // The header was fsynced by open(); every later sync is logged as it happens.
    const syncedAtOpen = statSync(rolloutStore.rolloutPath).size;
    appendJsonDurably(powerLossLog, { path: rolloutStore.rolloutPath, size: syncedAtOpen });
    rolloutStore.store.setFsyncImplForTest((fd) => {
      fsyncSync(fd);
      appendJsonDurably(powerLossLog, { path: rolloutStore.rolloutPath, size: fstatSync(fd).size });
    });
    rolloutStore.deferSyncsForTurn();
  }
  const [{ openStateDatabases }, { StateRunDurabilityRepository }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/run-durability.js"),
    ]);
  const stateDriver = openStateDatabases({
    cwd: paths.cwd,
    agencHome: paths.home,
  });
  try {
    const durability = new StateRunDurabilityRepository(stateDriver);
    durability.ensureInitialEpoch({ runId: RUN_ID, openedAt: OPENED_AT });
    if (durability.getJournalBinding(rolloutStore.rolloutPath) === undefined) {
      durability.bindJournalSource({
        runId: RUN_ID,
        epoch: 1,
        childRunId: RUN_ID,
        sessionId: RUN_ID,
        sourcePath: rolloutStore.rolloutPath,
        active: true,
        boundAt: OPENED_AT,
      });
    }
  } finally {
    stateDriver.close();
  }
  const eventLog = new EventLog();
  const existing = canonicalEvents(paths);
  eventLog.seedCanonicalHistory(existing);
  if (options.observeLive === true) {
    eventLog.subscribe((event) => {
      appendJsonDurably(paths.liveObservations, {
        surface: "event_log",
        eventId: event.eventId,
        sequence: event.seq,
      });
    });
  }
  const session = {
    conversationId: RUN_ID,
    eventLog,
    rolloutStore,
    activeTurn: { unsafePeek: () => undefined },
    txEvent: {
      send: (event: Event) => {
        if (options.observeLive === true) {
          appendJsonDurably(paths.liveObservations, {
            surface: "tx_event",
            eventId: event.eventId,
            sequence: event.seq,
          });
        }
        return true;
      },
    },
    isRolloutPersistenceSuspended: () => false,
    emit(event: Event, appendOptions: { readonly durable?: boolean } = {}) {
      const stamped = eventLog.stamp(event);
      const durable = isDurableEvent(stamped) || appendOptions.durable === true;
      const committed = rolloutStore.append(stamped, { durable });
      if (durable && committed === false) {
        throw new Error(
          `durable event ${stamped.msg.type} sequence ${stamped.seq ?? "unassigned"} was not fsync-committed`,
        );
      }
      hitM4DurabilityFailpoint("before_event_publish");
      eventLog.publish(stamped);
      session.txEvent.send(stamped);
      hitM4DurabilityFailpoint("after_event_publish");
      return stamped;
    },
  };
  return { eventLog, rolloutStore, session };
}

async function crashReservation(paths: FixturePaths): Promise<never> {
  const [rollout, { ExecutionAdmissionKernel }, { bindExecutionAdmissionJournal }] =
    await Promise.all([
      openRolloutSession(paths),
      import("../../../src/budget/execution-admission-kernel.js"),
      import("../../../src/session/execution-admission-journal.js"),
    ]);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: paths.home,
    ownerId: `failure-matrix:${process.pid}`,
    ownerPid: process.pid,
  });
  const client = kernel.bindClient({
    cwd: paths.cwd,
    scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
  });
  bindExecutionAdmissionJournal(rollout.session as never, client);
  await client.acquire({
    stepId: "reservation-step",
    kind: "model_turn",
    model: "grok-4.5",
    provider: "grok",
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: 0,
  });
  throw new Error("reservation failpoint did not terminate the child");
}

async function crashModel(paths: FixturePaths): Promise<never> {
  const [
    rollout,
    { runAdmittedModelCall },
    { ExecutionAdmissionKernel },
    { bindExecutionAdmissionJournal },
    { runWithStartupProviderSelection },
  ] =
    await Promise.all([
      openRolloutSession(paths),
      import("../../../src/budget/admitted-model-call.js"),
      import("../../../src/budget/execution-admission-kernel.js"),
      import("../../../src/session/execution-admission-journal.js"),
      import("../../../src/utils/model/providers.js"),
    ]);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: paths.home,
    ownerId: `failure-matrix:${process.pid}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: paths.cwd,
    scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
  });
  bindExecutionAdmissionJournal(rollout.session as never, executionAdmission);
  const session = {
    ...rollout.session,
    conversationId: RUN_ID,
    services: {
      executionAdmission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: async () => undefined },
    },
    abortTerminal: () => undefined,
  };
  const provider = {
    name: "grok",
    getExecutionProfile: async () => ({
      provider: "grok",
      model: "grok-4.5",
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
  };
  await runWithStartupProviderSelection(
    { provider: "grok", model: "grok-4.5", environment: {} },
    () =>
      runAdmittedModelCall({
        session: session as never,
        provider: provider as never,
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 32 },
        stepId: "model-step",
        model: "grok-4.5",
        providerName: "grok",
        invoke: async () => {
          appendJsonDurably(paths.modelReceipt, { attempt: 1, response: "ok" });
          return {
            content: "ok",
            toolCalls: [],
            model: "grok-4.5",
            finishReason: "stop",
            usage: {
              promptTokens: 8,
              completionTokens: 4,
              totalTokens: 12,
              availability: "reported",
              provenance: "provider",
            },
          };
        },
      }),
  );
  throw new Error("model failpoint did not terminate the child");
}

async function createEffectProjection(paths: FixturePaths) {
  const [{ openStateDatabases }, { StateRunDurabilityRepository }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/run-durability.js"),
    ]);
  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  const repository = new StateRunDurabilityRepository(driver);
  repository.ensureInitialEpoch({
    runId: RUN_ID,
    openedAt: OPENED_AT,
  });
  return {
    driver,
    repository,
    recordEffectEvent(event: Event): void {
      const sequence = event.seq;
      if (sequence === undefined) throw new Error("effect event lacks sequence");
      if (event.msg.type === "effect_intent") {
        const payload = event.msg.payload;
        if (event.eventId === undefined) {
          throw new Error("effect intent lacks canonical event identity");
        }
        repository.beginEffect({
          runId: payload.runId,
          epoch: 1,
          stepId: payload.stepId,
          sessionId: RUN_ID,
          toolName: payload.toolName,
          recoveryCategory: payload.recoveryCategory,
          ...(payload.idempotencyKey !== undefined
            ? { idempotencyKey: payload.idempotencyKey }
            : {}),
          intentDigest: payload.intentDigest,
          eventId: event.eventId,
          eventSequence: sequence,
          intentAt: payload.recordedAt,
        });
        return;
      }
      if (event.msg.type === "effect_result") {
        const payload = event.msg.payload;
        if (event.eventId === undefined) {
          throw new Error("effect result lacks canonical event identity");
        }
        repository.completeEffect({
          runId: payload.runId,
          stepId: payload.stepId,
          outcome: payload.outcome,
          effectBoundary: payload.effectBoundary ?? "crossed",
          ...(payload.noEffectEvidence !== undefined
            ? { noEffectEvidence: payload.noEffectEvidence }
            : {}),
          eventId: event.eventId,
          eventSequence: sequence,
          ...(payload.resultDigest !== undefined
            ? { resultDigest: payload.resultDigest }
            : {}),
          ...(payload.evidence !== undefined
            ? { evidence: payload.evidence }
            : {}),
          completedAt: payload.recordedAt,
        });
        return;
      }
      if (event.msg.type === "effect_unknown_outcome") {
        const payload = event.msg.payload;
        if (event.eventId === undefined) {
          throw new Error("unknown effect lacks canonical event identity");
        }
        repository.markEffectUnknown({
          runId: payload.runId,
          stepId: payload.stepId,
          eventId: event.eventId,
          eventSequence: sequence,
          reason: payload.reason,
          observedAt: payload.recordedAt,
        });
      }
    },
  };
}

async function crashTool(paths: FixturePaths): Promise<never> {
  const [
    rollout,
    { runAdmittedToolCall },
    { ExecutionAdmissionKernel },
    { bindExecutionAdmissionJournal },
  ] =
    await Promise.all([
      openRolloutSession(paths),
      import("../../../src/budget/admitted-tool-call.js"),
      import("../../../src/budget/execution-admission-kernel.js"),
      import("../../../src/session/execution-admission-journal.js"),
    ]);
  const kernel = new ExecutionAdmissionKernel({
    agencHome: paths.home,
    ownerId: `failure-matrix:${process.pid}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: paths.cwd,
    scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
  });
  bindExecutionAdmissionJournal(rollout.session as never, executionAdmission);
  const session = {
    ...rollout.session,
    services: {
      executionAdmission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: async () => undefined },
    },
    abortTerminal: () => undefined,
  };
  const tool = {
    name: "failure-matrix-side-effect",
    recoveryCategory: "side-effecting" as const,
    admissionEstimate: () => ({
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    }),
  };
  await runAdmittedToolCall({
    session: session as never,
    turnId: "turn-1",
    callId: "call-1",
    tool: tool as never,
    args: { value: "one physical effect" },
    invoke: async ({ crossEffectBoundary }) => {
      crossEffectBoundary();
      appendJsonDurably(paths.toolReceipt, { invocation: 1 });
      return {
        content: "ok",
        admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  });
  throw new Error("tool failpoint did not terminate the child");
}

async function crashArtifact(paths: FixturePaths): Promise<never> {
  const rollout = await openRolloutSession(paths);
  const [bootstrap, ids, currentSession, storage] = await Promise.all([
    import("../../../src/bootstrap/state.js"),
    import("../../../src/types/ids.js"),
    import("../../../src/session/current-session.js"),
    import("../../../src/utils/toolResultStorage.js"),
  ]);
  bootstrap.setOriginalCwd(paths.cwd);
  bootstrap.switchSession(ids.asSessionId(RUN_ID));
  await currentSession.runWithCurrentRuntimeSession(
    rollout.session as never,
    () =>
      storage.persistToolResult(
        "complete artifact bytes",
        "failure-matrix-artifact",
      ),
  );
  throw new Error("artifact failpoint did not terminate the child");
}

async function crashEventPublish(paths: FixturePaths): Promise<never> {
  const { session } = await openRolloutSession(paths, { observeLive: true });
  session.emit(
    {
      eventId: "publish-event-1",
      id: "publish-event-1",
      msg: {
        type: "warning",
        payload: {
          cause: "m4_failure_matrix",
          message: "durable before publication",
        },
      },
    },
    { durable: true },
  );
  throw new Error("event publication failpoint did not terminate the child");
}

async function crashTerminal(paths: FixturePaths): Promise<never> {
  const [projection, rollout, { hitM4DurabilityFailpoint }] = await Promise.all([
    createEffectProjection(paths),
    openRolloutSession(paths),
    import("../../../src/durability/failpoints.js"),
  ]);
  const event = rollout.session.emit({
    eventId: "run-terminal-1",
    id: "run-terminal-1",
    msg: {
      type: "run_terminal",
      payload: {
        runId: RUN_ID,
        epoch: 1,
        status: "completed",
        exitCode: 0,
        stopReason: "end_turn",
        finalMessage: "finished once",
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
          costUsd: 0.01,
        },
        lastSequenceBeforeTerminal: rollout.eventLog.lastSeq,
        finishedAt: FINISHED_AT,
      },
    },
  });
  if (event.eventId === undefined) {
    throw new Error("canonical terminal event lacks eventId");
  }
  hitM4DurabilityFailpoint("before_terminal_commit");
  projection.repository.recordTerminalResult({
    epoch: 1,
    eventId: event.eventId,
    result: {
      runId: RUN_ID,
      status: "completed",
      exitCode: 0,
      stopReason: "end_turn",
      finalMessage: "finished once",
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
        costUsd: 0.01,
      },
      lastSequence: event.seq ?? null,
      finishedAt: FINISHED_AT,
    },
  });
  hitM4DurabilityFailpoint("after_terminal_commit");
  throw new Error("terminal failpoint did not terminate the child");
}

async function crash(
  failpoint: M4DurabilityFailpoint,
  paths: FixturePaths,
): Promise<never> {
  if (
    failpoint === "after_admission_sqlite_commit_before_canonical_append" ||
    failpoint.includes("reservation_commit")
  ) {
    return crashReservation(paths);
  }
  if (failpoint.includes("model_response_commit")) return crashModel(paths);
  if (failpoint.includes("tool_")) return crashTool(paths);
  if (failpoint.includes("artifact_commit")) return crashArtifact(paths);
  if (failpoint.includes("event_publish")) return crashEventPublish(paths);
  if (failpoint.includes("terminal_commit")) return crashTerminal(paths);
  throw new Error(`unsupported failpoint: ${failpoint}`);
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function recoverAdmissionAndEffects(
  failpoint: M4DurabilityFailpoint,
  paths: FixturePaths,
) {
  const [{ openStateDatabases }, { ExecutionAdmissionRepository }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/execution-admission.js"),
    ]);
  let effectRecovery = "not_applicable";
  if (failpoint.includes("tool_")) {
    // Production RolloutStore recovery is the sole authority for classifying a
    // dangling intent. The fixture only inspects its canonical event and
    // projection; it must not synthesize a competing recovery transition.
    const resumed = await openRolloutSession(paths, { resume: true });
    resumed.rolloutStore.close();
    const projection = await createEffectProjection(paths);
    const effect = projection.repository.getEffect(RUN_ID, TOOL_STEP_ID);
    const auditDriver = openStateDatabases({
      cwd: paths.cwd,
      agencHome: paths.home,
    });
    const audit = new ExecutionAdmissionRepository(auditDriver, {
      ownerId: "failure-matrix-pre-recovery",
      ownerPid: process.pid,
    });
    const reservation = audit.listReservations({ runId: RUN_ID, limit: 2 })[0];
    if (effect?.outcome === "cancelled") {
      effectRecovery = "cancelled_before_dispatch";
    } else if (effect?.outcome === "unknown_outcome") {
      effectRecovery = "review_locked_unknown_outcome";
    } else if (
      effect?.outcome === "committed" &&
      reservation?.status === "dispatched"
    ) {
      audit.reconcile(reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        reason: "durable_effect_result_recovered",
      });
      effectRecovery = "acknowledged_from_durable_result";
    } else {
      effectRecovery = effect?.outcome ?? "no_effect";
    }
    auditDriver.close();
    projection.driver.close();
  }

  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  const repository = new ExecutionAdmissionRepository(driver, {
    ownerId: "failure-matrix-recovery",
    ownerPid: process.pid,
  });
  const firstRecovery = repository.recover({ activeOwnerIds: new Set() });
  const secondRecovery = repository.recover({ activeOwnerIds: new Set() });
  const reservations = repository.listReservations({ runId: RUN_ID, limit: 10 });
  const jobs = repository.list({ runId: RUN_ID, limit: 10 });
  const journal = repository.listJournal({ runId: RUN_ID, limit: 100 });
  driver.close();

  let effect;
  let pendingEffectReviews = 0;
  if (failpoint.includes("tool_")) {
    const projection = await createEffectProjection(paths);
    effect = projection.repository.getEffect(RUN_ID, TOOL_STEP_ID);
    pendingEffectReviews = projection.repository.listPendingEffectReviews(RUN_ID).length;
    projection.driver.close();
  }
  return {
    effect,
    effectRecovery,
    firstRecovery,
    secondRecovery,
    pendingEffectReviews,
    jobs: jobs.map((job) => ({ id: job.id, status: job.status })),
    reservations: reservations.map((reservation) => ({
      id: reservation.reservationId,
      status: reservation.status,
    })),
    journalCounts: countBy(journal.map((event) => event.event)),
  };
}

async function recoverArtifact(paths: FixturePaths) {
  const firstResume = await openRolloutSession(paths, { resume: true });
  firstResume.rolloutStore.close();
  const secondResume = await openRolloutSession(paths, { resume: true });
  secondResume.rolloutStore.close();
  const events = canonicalEvents(paths);
  const intents = events.filter(
    (event) => event.msg.type === "artifact_intent",
  );
  if (intents.length !== 1 || intents[0]!.msg.type !== "artifact_intent") {
    throw new Error(`expected one artifact intent, got ${intents.length}`);
  }
  const targetPath = intents[0]!.msg.payload.targetPath;
  const files = walkFiles(dirname(targetPath));
  const committed = events.filter(
    (event) => event.msg.type === "artifact_committed",
  );
  const decisions = events.filter(
    (event) => event.msg.type === "recovery_decision",
  );
  return {
    targetState: existsSync(targetPath) ? "complete" : "missing",
    ...(existsSync(targetPath)
      ? { bytes: readFileSync(targetPath, "utf8") }
      : {}),
    visibleTargets: files.filter((file) => file === targetPath).length,
    orphanTemps: files.filter(
      (file) => file.startsWith(`${targetPath}.`) && file.endsWith(".tmp"),
    ).length,
    intentSequences: intents.map((event) => event.seq),
    committedOutcomes: committed.flatMap((event) =>
      event.msg.type === "artifact_committed" ? [event.msg.payload.outcome] : [],
    ),
    committedIntentSequences: committed.flatMap((event) =>
      event.msg.type === "artifact_committed"
        ? [event.msg.payload.intentEventSeq]
        : [],
    ),
    recoveryDecisions: decisions.flatMap((event) =>
      event.msg.type === "recovery_decision"
        ? [event.msg.payload.decision]
        : [],
    ),
    recoveryEvidenceSequences: decisions.flatMap((event) =>
      event.msg.type === "recovery_decision"
        ? [event.msg.payload.evidenceEventSeq]
        : [],
    ),
  };
}

async function recoverPublishedEvent(paths: FixturePaths) {
  const rollout = await openRolloutSession(paths, { resume: true });
  rollout.rolloutStore.close();
  const eventsAfter = canonicalEvents(paths).filter(
    (event) => event.id === "publish-event-1",
  );
  const replayedTwice = [...eventsAfter, ...eventsAfter];
  const reconnectKeys = new Set(
    replayedTwice.map((event) => `${event.seq}:${event.eventId}`),
  );
  return {
    canonicalCount: eventsAfter.length,
    canonicalCoordinates: eventsAfter.map((event) => ({
      eventId: event.eventId,
      sequence: event.seq,
    })),
    liveObservations: readJsonLines(paths.liveObservations),
    reconnectUniqueDeliveries: reconnectKeys.size,
  };
}

async function recoverTerminal(paths: FixturePaths) {
  const [{ openStateDatabases }, { StateRunDurabilityRepository }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/run-durability.js"),
    ]);
  const events = canonicalEvents(paths).filter(
    (event) => event.msg.type === "run_terminal",
  );
  if (events.length !== 1 || events[0]!.msg.type !== "run_terminal") {
    throw new Error(`expected one canonical terminal event, got ${events.length}`);
  }
  const event = events[0]!;
  const payload = event.msg.payload;
  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  const repository = new StateRunDurabilityRepository(driver);
  repository.ensureInitialEpoch({
    runId: RUN_ID,
    openedAt: OPENED_AT,
  });
  if (event.eventId === undefined) {
    throw new Error("canonical terminal event lacks eventId");
  }
  const input = {
    epoch: payload.epoch,
    eventId: event.eventId,
    result: {
      runId: payload.runId,
      status: payload.status,
      exitCode: payload.exitCode,
      stopReason: payload.stopReason,
      finalMessage: payload.finalMessage,
      usage: payload.usage,
      lastSequence: event.seq,
      finishedAt: payload.finishedAt,
    },
  } as const;
  const firstProjection = repository.recordTerminalResult(input);
  const secondProjection = repository.recordTerminalResult(input);
  const history = repository.listTerminalHistory(RUN_ID);
  driver.close();
  return {
    canonicalCount: events.length,
    firstProjectionApplied: firstProjection.applied,
    secondProjectionApplied: secondProjection.applied,
    history,
  };
}

async function recover(
  failpoint: M4DurabilityFailpoint,
  paths: FixturePaths,
): Promise<unknown> {
  const base = {
    failpoint,
    canonicalEventCounts: countBy(
      canonicalEvents(paths).map((event) => event.msg.type),
    ),
    modelPhysicalAttempts: readJsonLines(paths.modelReceipt).length,
    toolPhysicalAttempts: readJsonLines(paths.toolReceipt).length,
  };
  if (
    failpoint === "after_admission_sqlite_commit_before_canonical_append" ||
    failpoint.includes("reservation_commit") ||
    failpoint.includes("model_response_commit") ||
    failpoint.includes("tool_")
  ) {
    const admission = await recoverAdmissionAndEffects(failpoint, paths);
    return {
      ...base,
      canonicalEventCounts: countBy(
        canonicalEvents(paths).map((event) => event.msg.type),
      ),
      admission,
    };
  }
  if (failpoint.includes("artifact_commit")) {
    const artifact = await recoverArtifact(paths);
    return {
      ...base,
      canonicalEventCounts: countBy(
        canonicalEvents(paths).map((event) => event.msg.type),
      ),
      artifact,
    };
  }
  if (failpoint.includes("event_publish")) {
    return { ...base, publication: await recoverPublishedEvent(paths) };
  }
  if (failpoint.includes("terminal_commit")) {
    return { ...base, terminal: await recoverTerminal(paths) };
  }
  throw new Error(`unsupported failpoint: ${failpoint}`);
}

const STEP_COUNT = 3;

function stepToolId(step: number): string {
  return `tool:turn-1:call-${step}`;
}

function lastSyncedSize(log: string, rolloutPath: string): number {
  return readJsonLines(log)
    .filter((entry) => (entry as { path?: string }).path === rolloutPath)
    .reduce<number>((max, entry) => Math.max(max, (entry as { size: number }).size), 0);
}

/**
 * One turn of STEP_COUNT model and tool steps inside a turn scope, imaged
 * after each step (P1..Pn: home, workspace and receipts, with the journal's
 * last synced size), then killed during the next tool's effect (F).
 */
async function runSteps(paths: FixturePaths): Promise<never> {
  const log = process.env[POWER_LOSS_LOG_ENV];
  if (log === undefined) throw new Error(`${POWER_LOSS_LOG_ENV} is required`);
  const [
    rollout,
    { runAdmittedModelCall },
    { runAdmittedToolCall },
    { ExecutionAdmissionKernel },
    { bindExecutionAdmissionJournal },
    { runWithStartupProviderSelection },
  ] = await Promise.all([
    openRolloutSession(paths),
    import("../../../src/budget/admitted-model-call.js"),
    import("../../../src/budget/admitted-tool-call.js"),
    import("../../../src/budget/execution-admission-kernel.js"),
    import("../../../src/session/execution-admission-journal.js"),
    import("../../../src/utils/model/providers.js"),
  ]);
  const walLog = process.env[MIRROR_WAL_LOG_ENV];
  const mirror = walLog === undefined
    ? undefined
    : await bindRolloutMirror(paths, rollout.rolloutStore, walLog);
  const mirrorMeta = () =>
    mirror === undefined || walLog === undefined
      ? {}
      : { stateDbPath: mirror.stateDbPath, walLogEntries: readJsonLines(walLog).length };
  const kernel = new ExecutionAdmissionKernel({
    agencHome: paths.home,
    ownerId: `failure-matrix:${process.pid}`,
    ownerPid: process.pid,
  });
  const executionAdmission = kernel.bindClient({
    cwd: paths.cwd,
    scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false },
  });
  bindExecutionAdmissionJournal(rollout.session as never, executionAdmission);
  const session = {
    ...rollout.session,
    conversationId: RUN_ID,
    services: {
      executionAdmission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: async () => undefined },
    },
    abortTerminal: () => undefined,
  };
  const provider = {
    name: "grok",
    getExecutionProfile: async () => ({
      provider: "grok",
      model: "grok-4.5",
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
    }),
  };
  const tool = {
    name: "failure-matrix-side-effect",
    recoveryCategory: "side-effecting" as const,
    admissionEstimate: () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }),
  };
  const modelStep = (step: number) =>
    runWithStartupProviderSelection(
      { provider: "grok", model: "grok-4.5", environment: {} },
      () =>
        runAdmittedModelCall({
          session: session as never,
          provider: provider as never,
          messages: [{ role: "user", content: `step ${step}` }],
          options: { maxOutputTokens: 32 },
          stepId: `model-step-${step}`,
          model: "grok-4.5",
          providerName: "grok",
          invoke: async () => {
            appendJsonDurably(paths.modelReceipt, { attempt: step, response: "tool" });
            return {
              content: "",
              toolCalls: [],
              model: "grok-4.5",
              finishReason: "stop",
              usage: {
                promptTokens: 8,
                completionTokens: 4,
                totalTokens: 12,
                availability: "reported",
                provenance: "provider",
              },
            };
          },
        }),
    );
  const toolStep = (step: number, crash: boolean) =>
    runAdmittedToolCall({
      session: session as never,
      turnId: "turn-1",
      callId: `call-${step}`,
      tool: tool as never,
      args: { value: `physical effect ${step}` },
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        appendJsonDurably(paths.toolReceipt, { invocation: step });
        if (crash) process.kill(process.pid, "SIGKILL");
        return {
          content: "ok",
          admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    });
  for (let step = 1; step <= STEP_COUNT; step += 1) {
    await modelStep(step);
    await toolStep(step, false);
    const image = join(paths.root, "images", `P${step}`);
    mkdirSync(image, { recursive: true });
    for (const name of ["home", "workspace", "physical"]) {
      const source = join(paths.root, name);
      if (existsSync(source)) cpSync(source, join(image, name), { recursive: true });
    }
    writeFileSync(join(image, "journal.json"), JSON.stringify({
      rolloutPath: rollout.rolloutStore.rolloutPath,
      syncedSize: lastSyncedSize(log, rollout.rolloutStore.rolloutPath),
      size: statSync(rollout.rolloutStore.rolloutPath).size,
      ...mirrorMeta(),
    }));
  }
  writeFileSync(join(paths.root, "journal.json"), JSON.stringify({
    rolloutPath: rollout.rolloutStore.rolloutPath,
    ...mirrorMeta(),
  }));
  await modelStep(STEP_COUNT + 1);
  await toolStep(STEP_COUNT + 1, true);
  throw new Error("the step crash did not terminate the child");
}

/** Production recovery over a multi-step turn, reported for every step. */
async function recoverSteps(paths: FixturePaths) {
  const mirrored = process.env[MIRROR_RECOVERY_ENV] === "1";
  const rolloutPath = mirrored
    ? (JSON.parse(readFileSync(join(paths.root, "journal.json"), "utf8")) as { rolloutPath: string }).rolloutPath
    : undefined;
  // The mirror as the image left it, against the journal as the image left it.
  const mirrorBefore = mirrored ? await compareMirror(paths, rolloutPath!) : undefined;
  const resumed = await openRolloutSession(paths, { resume: true });
  // A resumed session's recorder is bound to the thread store again, which
  // indexes the file at once and after every commit (the production catch-up).
  const mirror = mirrored ? await bindRolloutMirror(paths, resumed.rolloutStore) : undefined;
  resumed.rolloutStore.close();
  mirror?.close();
  const [{ openStateDatabases }, { ExecutionAdmissionRepository }] =
    await Promise.all([
      import("../../../src/state/sqlite-driver.js"),
      import("../../../src/state/execution-admission.js"),
    ]);
  const projection = await createEffectProjection(paths);
  const effects = projection.repository.listEffects(RUN_ID).map((effect) => ({
    stepId: effect.stepId,
    outcome: effect.outcome ?? null,
    reviewStatus: effect.reviewStatus ?? null,
    intentEventId: effect.intentEventId,
  }));
  const pendingEffectReviews = projection.repository.listPendingEffectReviews(RUN_ID).length;
  const unsettledIntents = projection.repository.listUnsettledEffectIntents(RUN_ID).length;
  projection.driver.close();
  const driver = openStateDatabases({ cwd: paths.cwd, agencHome: paths.home });
  const repository = new ExecutionAdmissionRepository(driver, {
    ownerId: "failure-matrix-recovery",
    ownerPid: process.pid,
  });
  const firstRecovery = repository.recover({ activeOwnerIds: new Set() });
  const secondRecovery = repository.recover({ activeOwnerIds: new Set() });
  const reservations = repository.listReservations({ runId: RUN_ID, limit: 20 });
  driver.close();
  const events = canonicalEvents(paths);
  const intentEventIds = new Set(
    events.filter((event) => event.msg.type === "effect_intent").map((event) => event.eventId),
  );
  return {
    canonicalEventCounts: countBy(events.map((event) => event.msg.type)),
    duplicateEventIds: events.length - new Set(events.map((event) => event.eventId)).size,
    sequencesIncrease: events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq),
    effects,
    effectsWithoutJournalIntent: effects.filter((effect) => !intentEventIds.has(effect.intentEventId)).length,
    pendingEffectReviews,
    unsettledIntents,
    toolPhysicalAttempts: readJsonLines(paths.toolReceipt).length,
    reservations: countBy(reservations.map((reservation) => reservation.status)),
    firstRecovery,
    secondRecovery,
    ...(mirrored
      ? { mirror: { before: mirrorBefore, after: await compareMirror(paths, rolloutPath!) } }
      : {}),
  };
}

const command = requireArgument(process.argv[2], "command") as Command;
const failpoint = requireArgument(
  process.argv[3],
  "failpoint",
) as M4DurabilityFailpoint;
const paths = pathsFor(requireArgument(process.argv[4], "state directory"));

if (command === "crash") {
  await crash(failpoint, paths);
} else if (command === "recover") {
  process.stdout.write(`${JSON.stringify(await recover(failpoint, paths))}\n`);
} else if (command === "steps") {
  await runSteps(paths);
} else if (command === "recover-steps") {
  process.stdout.write(`${JSON.stringify(await recoverSteps(paths))}\n`);
} else {
  throw new Error(`unsupported command: ${command}`);
}
