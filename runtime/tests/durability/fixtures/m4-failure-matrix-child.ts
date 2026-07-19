/**
 * Child process used by the M4 crash/restart acceptance matrix.
 *
 * The crash command is always run with the guarded production failpoint token
 * and therefore dies by SIGKILL. The recover command opens the same on-disk
 * state in a fresh process and emits a JSON report for the parent test.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { M4DurabilityFailpoint } from "../../../src/durability/failpoints.js";
import type { Event } from "../../../src/session/event-log.js";

const RUN_ID = "m4-failure-matrix-run";
const TOOL_STEP_ID = "tool:turn-1:call-1";
const OPENED_AT = "2026-07-18T00:00:00.000Z";
const FINISHED_AT = "2026-07-18T00:00:01.000Z";

type Command = "crash" | "recover";

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
  ] =
    await Promise.all([
      openRolloutSession(paths),
      import("../../../src/budget/admitted-model-call.js"),
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
  await runAdmittedModelCall({
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
  });
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
    invoke: async () => {
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
} else {
  throw new Error(`unsupported command: ${command}`);
}
