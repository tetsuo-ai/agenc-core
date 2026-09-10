import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import type { AgenCDelegateBackgroundAgentRunnerOptions } from "../../src/app-server/background-agent-runner/shared.js";
import { DAEMON_AGENT_CREATE_TIMEOUT_MS } from "../../src/app-server/operation-deadline.js";
import {
  bootstrapLocalRuntimeSession,
  type LocalRuntimeBootstrap,
} from "../../src/bin/bootstrap.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { resolveUnattendedPermissionDecision } from "../../src/permissions/unattended-policy.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import {
  currentBuildId,
  resetBuildIdForTestingOnly,
} from "../../src/session/durable-turns.js";
import {
  parseRolloutLine,
  type RolloutItem,
} from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import { VERSION } from "../../src/version.js";

/**
 * #2239 — a turn resumed after a daemon death ran with no approval resolver.
 *
 * The durable resume is driven from the startup prewarm INSIDE
 * `bootstrapLocalRuntimeSession`, so it completed before `restoreAgent` could
 * install `services.approvalResolver` (`#installDaemonApprovalBridge`) or
 * register the agent in `#active`. Every tool in the recovered turn that
 * needed approval hit the guardian arbiter's `default_deny`, the user was
 * never prompted, and the recovered turn was spent.
 *
 * These tests run the REAL bootstrap through the REAL runner: the session
 * under test is built by `buildBootstrapSessionServices`, so it carries every
 * service a production session carries (`guardianApprovalReviewer` included —
 * that service is set unconditionally and answers approvals only for
 * `approvalsReviewer: "auto_review"` turns, so its presence is NOT evidence
 * that anyone can answer a prompt).
 */

const CONVERSATION_ID = "session-durable-resume-approval";
const TURN_ID = "orphan-turn-2239";
const APPROVAL_REQUEST_ID = "resume-approval-probe";

interface ResumeObservation {
  readonly resume: boolean;
  readonly hasApprovalResolver: boolean;
  readonly hasGuardianApprovalReviewer: boolean;
}

/** The slice of `session.state` these tests read and republish. */
interface MutableSessionState {
  history?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * One started-but-never-terminated turn carrying a durable checkpoint whose
 * prefix is empty — the shape a SIGKILLed daemon leaves behind.
 */
function orphanRolloutItems(turnId: string): RolloutItem[] {
  return [
    {
      type: "event_msg",
      payload: {
        eventId: `${turnId}-started`,
        id: `${turnId}-started`,
        seq: 1,
        msg: {
          type: "turn_started",
          payload: { turnId, buildId: currentBuildId() },
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        eventId: `${turnId}-checkpoint`,
        id: `${turnId}-checkpoint`,
        seq: 2,
        msg: {
          type: "turn_checkpoint",
          payload: {
            turnId,
            iterationIndex: 1,
            boundary: "iteration",
            checkpointSeq: 1,
            persistedMessageCount: 0,
            prefixHash: computeCheckpointPrefixHashV3([], 0),
            checkpointVersion: 4,
            toolResultIntegrityVersion: 1,
            prefixHashVersion: 3,
            resumableState: {
              turnCount: 1,
              recoveryReentryCount: 0,
              maxOutputTokensRecoveryCount: 0,
              continuationNudgeCount: 0,
              stopHookBlockingCount: 0,
            },
          },
        },
      },
    },
  ] as unknown as RolloutItem[];
}

function readRollout(rolloutPath: string): RolloutItem[] {
  return readFileSync(rolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseRolloutLine(line))
    .filter((item): item is RolloutItem => item !== null);
}

describe("durable resume reaches the daemon approval bridge (#2239)", () => {
  let home = "";
  let workspace = "";
  let rolloutPath = "";
  let previousBuildId: string | undefined;
  /** Every option object the runner handed the real bootstrap, in order. */
  let bootstrapOptions: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    bootstrapOptions = [];
    home = mkdtempSync(join(tmpdir(), "agenc-2239-home-"));
    workspace = mkdtempSync(join(tmpdir(), "agenc-2239-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    previousBuildId = process.env.AGENC_BUILD_ID;
    process.env.AGENC_BUILD_ID = "resume-approval-build";
    resetBuildIdForTestingOnly();

    const seed = new RolloutStore({
      cwd: workspace,
      sessionId: CONVERSATION_ID,
      agencVersion: VERSION,
      agencHome: home,
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    seed.open({
      sessionId: CONVERSATION_ID,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      originator: "agenc-cli",
      source: "interactive-root",
      agencVersion: VERSION,
      model: "base-model",
      modelProvider: "grok",
    });
    for (const item of orphanRolloutItems(TURN_ID)) seed.appendRollout(item);
    rolloutPath = seed.rolloutPath;
    seed.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousBuildId === undefined) delete process.env.AGENC_BUILD_ID;
    else process.env.AGENC_BUILD_ID = previousBuildId;
    resetBuildIdForTestingOnly();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function stubProviderAndMcp(): void {
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  }

  async function stubProvider(): Promise<void> {
    const providerMod = await import("../../src/llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }),
        }) as never,
    );
  }

  function makeRunner(
    onBootstrapped?: (bootstrap: LocalRuntimeBootstrap) => void,
    extra: Partial<AgenCDelegateBackgroundAgentRunnerOptions> = {},
  ): AgenCDelegateBackgroundAgentRunner {
    return new AgenCDelegateBackgroundAgentRunner({
      bootstrap: async (options) => {
        bootstrapOptions.push(options as unknown as Record<string, unknown>);
        const bootstrap = await bootstrapLocalRuntimeSession(options);
        onBootstrapped?.(bootstrap);
        return bootstrap;
      },
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
      },
      ...extra,
    });
  }

  /** The daemon-recovered conversation the runner hydrates onto the session. */
  const RECOVERED_USER_MESSAGE = "PRIOR USER MESSAGE";
  const REPLAY_CALL_ID = "replay-1";

  /**
   * The session's mutable state cell. These tests both read the conversation
   * the restore hydrated and write the republication a resumed turn performs,
   * so they reach past the public type exactly where the runner does.
   */
  function sessionState(session: Session): {
    readonly with: <T>(fn: (state: MutableSessionState) => T) => Promise<T>;
  } {
    return (
      session as unknown as {
        readonly state: {
          readonly with: <T>(
            fn: (state: MutableSessionState) => T,
          ) => Promise<T>;
        };
      }
    ).state;
  }

  function sessionHistory(
    bootstrap: LocalRuntimeBootstrap,
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    return sessionState(bootstrap.session).with((state) => state.history ?? []);
  }

  /** The queued user message `#hydrateRecoveredAgentState` wrote. */
  function hasRecoveredUserMessage(
    history: ReadonlyArray<Record<string, unknown>>,
  ): boolean {
    return history.some(
      (message) =>
        message.role === "user" && message.content === RECOVERED_USER_MESSAGE,
    );
  }

  /** The result of the tool call the restore re-dispatched. */
  function hasReplayedToolResult(
    history: ReadonlyArray<Record<string, unknown>>,
  ): boolean {
    return history.some(
      (message) =>
        message.role === "tool" && message.toolCallId === REPLAY_CALL_ID,
    );
  }

  /**
   * Observe every event the session emits, from before bootstrap runs.
   * Subscribing to `session.eventLog` after `restoreAgent` returns would miss a
   * resume that already happened inside bootstrap, which is exactly the
   * ordering these tests compare against.
   */
  function spyOnEmittedEvents(
    observe: (event: Parameters<Session["emit"]>[0]) => void,
  ): void {
    const emit = Session.prototype.emit;
    vi.spyOn(Session.prototype, "emit").mockImplementation(function (
      this: Session,
      event: Parameters<Session["emit"]>[0],
      appendOpts?: Parameters<Session["emit"]>[1],
    ) {
      observe(event);
      return emit.call(this, event, appendOpts);
    });
  }

  function recordEmittedEventTypes(): string[] {
    const types: string[] = [];
    spyOnEmittedEvents((event) => {
      types.push(event.msg.type);
    });
    return types;
  }

  /**
   * Record every `warning` cause the session emits. The runner records why it
   * stopped waiting on a stalled resume through this channel, so it is durable
   * in the rollout and reaches a client on attach.
   */
  function recordEmittedWarnings(): Array<{
    readonly cause: string;
    readonly message: string;
  }> {
    const warnings: Array<{ readonly cause: string; readonly message: string }> =
      [];
    spyOnEmittedEvents((event) => {
      if (event.msg.type !== "warning") return;
      const payload = event.msg.payload as {
        readonly cause?: unknown;
        readonly message?: unknown;
      };
      warnings.push({
        cause: String(payload.cause ?? ""),
        message: String(payload.message ?? ""),
      });
    });
    return warnings;
  }

  async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function restoreParams(extra: Record<string, unknown> = {}): never {
    return {
      agentId: CONVERSATION_ID,
      objective: "resume after daemon death",
      cwd: workspace,
      resumeRolloutPath: rolloutPath,
      explicitColdResume: true,
      // The daemon snapshot is complete per client; keys absent from it are
      // cleared, so provider credentials must ride the override.
      envOverrides: { XAI_API_KEY: "test-key" },
      ...extra,
    } as never;
  }

  /**
   * Mark the seeded run as having a startup activation still pending, the
   * shape `restoreAgent` requires before it accepts
   * `resumeStartupActivationPending` (`currentCanonicalRuntimeStateFromRollout`
   * reads a `run_resumed` on the current epoch that no `run_startup_activated`
   * has closed).
   */
  function seedPendingStartupActivation(): void {
    const suspensionEventId = `run-suspended:${CONVERSATION_ID}:1`;
    const resumeEventId = `run-resumed:${CONVERSATION_ID}:1`;
    const lines = [
      {
        type: "event_msg",
        payload: {
          eventId: suspensionEventId,
          id: suspensionEventId,
          seq: 3,
          msg: {
            type: "run_suspended",
            payload: {
              runId: CONVERSATION_ID,
              epoch: 1,
              reason: "daemon_shutdown_idle",
              suspendedAt: new Date().toISOString(),
            },
          },
        },
        eventVersion: 1,
      },
      {
        type: "event_msg",
        payload: {
          eventId: resumeEventId,
          id: resumeEventId,
          seq: 4,
          msg: {
            type: "run_resumed",
            payload: {
              runId: CONVERSATION_ID,
              epoch: 1,
              suspensionEventId,
              reason: "daemon_startup_restore",
              resumedAt: new Date().toISOString(),
            },
          },
        },
        eventVersion: 1,
      },
    ];
    appendFileSync(
      rolloutPath,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      "utf8",
    );
  }

  /** The recovered-run state `daemon-cli` hands `restoreAgent` on a cold start. */
  function recoveredRunState(): Record<string, unknown> {
    return {
      currentSessionId: "recovered-session",
      initialMessages: [{ role: "user", content: RECOVERED_USER_MESSAGE }],
      replayToolCalls: [
        { callId: REPLAY_CALL_ID, toolName: "Glob", args: { pattern: "**/*" } },
      ],
    };
  }

  /**
   * A turn that yields nothing and reports itself completed: what every stub
   * below returns once it has done the one thing its test is about.
   */
  function completedTurn(): never {
    return (async function* () {
      return { reason: "completed" as const };
    })() as never;
  }

  /** Run `onTurn` for every turn the runner drives, then complete that turn. */
  function stubTurn(
    onTurn: (session: Session, isResume: boolean) => void,
  ): void {
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      onTurn(this, options?.resume !== undefined);
      return completedTurn();
    });
  }

  /**
   * Record which approval services the session carried on every turn the runner
   * drove. `onResume` runs from inside the recovered turn, where a real tool
   * would ask for its approval.
   */
  function recordResumeObservations(
    onResume?: (session: Session) => void,
  ): ResumeObservation[] {
    const observations: ResumeObservation[] = [];
    stubTurn((session, isResume) => {
      const services = session.services as {
        approvalResolver?: unknown;
        guardianApprovalReviewer?: unknown;
      };
      observations.push({
        resume: isResume,
        hasApprovalResolver: services.approvalResolver !== undefined,
        hasGuardianApprovalReviewer:
          services.guardianApprovalReviewer !== undefined,
      });
      if (isResume) onResume?.(session);
    });
    return observations;
  }

  /**
   * Replace the resumed turn with the two effects the runner reacts to: the
   * `syncSessionState` republication that erases the daemon-recovered
   * conversation (this fixture's checkpoint has `persistedMessageCount: 0`, so
   * the prefix is empty), and the `turn_resumed` event that releases the start
   * barrier. `settled` resolves once both have happened.
   */
  function stubResumedTurn(
    opts: { readonly throwAfterStart?: boolean } = {},
  ): { readonly settled: Promise<void> } {
    const settled = Promise.withResolvers<void>();
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      const session = this;
      const isResume = options?.resume !== undefined;
      return (async function* () {
        if (isResume) {
          await sessionState(session).with((state) => {
            state.history = [];
          });
          session.emit({
            id: session.nextInternalSubId(),
            msg: {
              type: "turn_resumed",
              payload: {
                turnId: TURN_ID,
                fromCheckpointSeq: 1,
                fromIteration: 1,
              },
            },
          } as never);
          settled.resolve();
          if (opts.throwAfterStart === true) {
            throw new Error("resume failed after re-opening the turn");
          }
        }
        return { reason: "completed" as const };
      })() as never;
    });
    return { settled: settled.promise };
  }

  /**
   * Stall the resume before any `turn_resumed` reaches the event log, which is
   * where the review measured the daemon-startup block. `finished` stays false
   * until `release` lets the stalled turn run on to completion.
   */
  function stubStalledResume(): {
    readonly entered: () => boolean;
    readonly finished: () => boolean;
    readonly release: () => void;
  } {
    const stalled = Promise.withResolvers<void>();
    let entered = false;
    let finished = false;
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      _input: unknown,
      options?: { readonly resume?: unknown },
    ) {
      const isResume = options?.resume !== undefined;
      return (async function* () {
        if (isResume) {
          entered = true;
          await stalled.promise;
          finished = true;
        }
        return { reason: "completed" as const };
      })() as never;
    });
    return {
      entered: () => entered,
      finished: () => finished,
      release: () => stalled.resolve(),
    };
  }

  /**
   * Observe the timers the runner installs. Both waits under test are timers:
   * the start wait is one `setTimeout(durableResumeTimeoutMs)` and the slot
   * poll is a run of `setTimeout(RECOVERED_HISTORY_SLOT_POLL_MS)` sleeps, so a
   * poll that never starts and a bound that changed are both directly visible
   * here instead of being asserted in prose.
   */
  function spyOnTimers(
    onSet: (ms: number, timer: object) => void,
    onClear?: (timer: object) => void,
  ): void {
    const realSetTimeout = globalThis.setTimeout as unknown as (
      ...args: readonly unknown[]
    ) => object;
    const realClearTimeout = globalThis.clearTimeout as unknown as (
      timer: unknown,
    ) => void;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: readonly unknown[]
    ) => {
      const timer = realSetTimeout(...args);
      const ms = args[1];
      if (typeof ms === "number") onSet(ms, timer);
      return timer;
    }) as never);
    if (onClear === undefined) return;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      timer: unknown,
    ) => {
      if (typeof timer === "object" && timer !== null) onClear(timer);
      realClearTimeout(timer);
    }) as never);
  }

  /**
   * Settle on whichever outcome happens first. A hang has to arrive as the
   * outcome under test, so a failure names what did not happen instead of
   * expiring as a bare vitest timeout.
   */
  function raceOutcome(
    candidate: Promise<string>,
    timedOut: string,
    timeoutMs: number,
  ): Promise<string> {
    return Promise.race([
      candidate,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(timedOut), timeoutMs),
      ),
    ]);
  }

  /** The delay `#reapplyRecoveredHistory` sleeps between slot re-checks. */
  const SLOT_POLL_MS = 25;

  /** Hold the session's turn slot the way a replacing client turn would. */
  function holdTurnSlot(bootstrap: LocalRuntimeBootstrap): void {
    vi.spyOn(bootstrap.session.activeTurn, "unsafePeek").mockReturnValue({
      turnId: "client-turn-that-replaced-the-resume",
    } as never);
  }

  function releaseTurnSlot(bootstrap: LocalRuntimeBootstrap): void {
    vi.mocked(bootstrap.session.activeTurn.unsafePeek).mockReturnValue(null);
  }

  function setSessionHistory(
    bootstrap: LocalRuntimeBootstrap,
    history: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    return sessionState(bootstrap.session).with((state) => {
      state.history = history.map((message) => ({ ...message }));
    });
  }

  /**
   * Restore a run whose snapshot carried a conversation and settle its resumed
   * turn. `holdSlot` puts a newer client turn in the session's turn slot from
   * before the resume settles, which is the window the re-apply has to survive;
   * `resumeThrows` fails the turn after it re-opened. The restore itself must
   * succeed for any of that to be under test, so it is asserted here.
   */
  async function restoreRecoveredRun(opts: {
    readonly durableResumeTimeoutMs: number;
    readonly holdSlot?: boolean;
    readonly resumeThrows?: boolean;
  }): Promise<{
    readonly runner: AgenCDelegateBackgroundAgentRunner;
    readonly bootstrap: LocalRuntimeBootstrap;
  }> {
    const resumed = stubResumedTurn({ throwAfterStart: opts.resumeThrows });
    let booted: LocalRuntimeBootstrap | undefined;
    const runner = makeRunner(
      (bootstrap) => {
        booted = bootstrap;
        if (opts.holdSlot === true) holdTurnSlot(bootstrap);
      },
      { durableResumeTimeoutMs: opts.durableResumeTimeoutMs },
    );

    await expect(
      runner.restoreAgent(restoreParams(recoveredRunState())),
    ).resolves.toBe(true);
    await resumed.settled;
    return { runner, bootstrap: booted! };
  }

  it("drives the recovered turn only once a client can answer its approvals", async () => {
    await stubProvider();
    stubProviderAndMcp();

    const runner = makeRunner();
    let approvalProbe: Promise<ReviewDecision> | undefined;
    const resumeDriven = Promise.withResolvers<void>();
    const observations = recordResumeObservations((session) => {
      // Ask for approval exactly the way `execute-tools` does, from inside the
      // resumed turn. This is the property the issue is about: the request must
      // become a pending decision the daemon can deliver to a client, not an
      // instant refusal.
      approvalProbe = (
        session.services as {
          approvalResolver?: {
            request: (ctx: unknown) => Promise<ReviewDecision>;
          };
        }
      ).approvalResolver?.request({
        callId: APPROVAL_REQUEST_ID,
        invocation: { session },
      });
      resumeDriven.resolve();
    });

    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    await Promise.race([
      resumeDriven.promise,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("the recovered turn was never driven")),
          10_000,
        ),
      ),
    ]);

    expect(observations).toEqual([
      {
        resume: true,
        hasApprovalResolver: true,
        // Production shape marker: every canonical session carries this
        // service, so it can never stand in for "someone can answer".
        hasGuardianApprovalReviewer: true,
      },
    ]);

    // The approval is pending on the daemon, not denied: a client answer
    // reaches it. `#requestDaemonToolDecision` returns DENIED outright when
    // the agent is absent from `#active`, so this also proves the agent was
    // registered before the resumed turn ran.
    expect(approvalProbe).toBeDefined();
    let settled = false;
    void approvalProbe?.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await expect(
      runner.resolveToolDecision(CONVERSATION_ID, {
        requestId: APPROVAL_REQUEST_ID,
        decision: { kind: "approved" },
      }),
    ).resolves.toBe(true);
    await expect(approvalProbe).resolves.toEqual({ kind: "approved" });

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("keeps resuming inline for callers that do not defer (local CLI/TUI)", async () => {
    // The local TUI installs `session.services.approvalResolver` from a React
    // effect, i.e. after bootstrap returns, so it has no resolver at prewarm
    // time either. The fix must not make its resumes defer or fail: without
    // `deferDurableTurnResume` the resume still runs inside bootstrap, byte
    // for byte as before.
    await stubProvider();
    stubProviderAndMcp();

    const resumesDrivenDuringBootstrap: boolean[] = [];
    stubTurn((_session, isResume) => {
      if (isResume) resumesDrivenDuringBootstrap.push(true);
    });

    const boot = await bootstrapLocalRuntimeSession({
      apiKey: "test-key",
      conversationId: CONVERSATION_ID,
      resumeConversation: true,
      resumeRolloutPath: rolloutPath,
      cwd: workspace,
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        HOME: home,
        XAI_API_KEY: "test-key",
      },
    });
    try {
      expect(resumesDrivenDuringBootstrap).toEqual([true]);
      // Nothing was deferred, so the driver is an explicit no-op.
      await expect(boot.runDeferredDurableTurnResume?.()).resolves.toEqual({
        resumed: false,
      });
    } finally {
      await boot.shutdown();
    }
  }, 60_000);

  it("proves the recovered turn is single-shot: replay persists its abort", async () => {
    // Why the fix drives the resume in THIS process instead of deferring it
    // to some later user message: bootstrap replays the rollout with
    // `emitSynthesized: true`, which persists `turn_aborted{process_killed}`
    // for the orphan. Once that abort is on disk the turn yields no resume
    // descriptor ever again, so a deferral that never fires drops it.
    await stubProvider();
    stubProviderAndMcp();
    stubTurn(() => undefined);

    const before = reconstructFromRollout(readRollout(rolloutPath));
    expect(before.resumableTurns.map((turn) => turn.turnId)).toEqual([TURN_ID]);

    const runner = makeRunner();
    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);

    const persisted = readRollout(rolloutPath);
    const abortedTurnIds = persisted.flatMap((item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "turn_aborted" &&
      item.payload.msg.payload.reason === "process_killed"
        ? [item.payload.msg.payload.turnId]
        : [],
    );
    expect(abortedTurnIds).toContain(TURN_ID);
    expect(reconstructFromRollout(persisted).resumableTurns).toEqual([]);
  }, 60_000);

  it("keeps the daemon-recovered conversation the restore hydrated", async () => {
    // A cold daemon start hands `restoreAgent` the recovered run's own state:
    // `initialMessages` (the conversation from the last snapshot, including a
    // message the user had already queued) plus `replayToolCalls`, which are
    // re-dispatched and appended (daemon-cli.ts
    // `recoveredInitialMessages`/`recoveredReplayToolCalls`).
    // `#hydrateRecoveredAgentState` writes them onto `session.state.history`.
    //
    // The recovered turn writes that same slot: `syncSessionState` assigns
    // `sessionState.history` from the checkpoint prefix it was resumed with.
    // Driving the resume after hydration therefore ERASES the recovered
    // conversation. Whatever order the resume runs in, the end state must
    // still carry it.
    await stubProvider();
    stubProviderAndMcp();

    const eventTypes = recordEmittedEventTypes();
    let booted: LocalRuntimeBootstrap | undefined;
    const runner = makeRunner((bootstrap) => {
      booted = bootstrap;
    });

    await expect(
      runner.restoreAgent(restoreParams(recoveredRunState())),
    ).resolves.toBe(true);
    const bootstrap = booted!;

    // At return the hydrated conversation is present on both the fixed and the
    // unfixed source; the regression only shows once the resumed turn settles.
    expect(
      (await sessionHistory(bootstrap)).map((message) => message.role),
    ).toEqual(["user", "assistant", "tool"]);

    // Sample only after the recovered turn has actually started AND finished,
    // otherwise the assertion races an unstarted resume and passes for the
    // wrong reason.
    await waitUntil(
      () => eventTypes.includes("turn_resumed"),
      "the recovered turn to start",
    );
    await waitUntil(
      () => bootstrap.session.activeTurn.unsafePeek() === null,
      "the recovered turn to settle",
    );
    // The restoration of the recovered conversation is chained onto the
    // resume, so give that chain a bounded window and then assert, rather
    // than turning the property under test into a timeout message.
    await waitUntil(
      async () =>
        (await sessionHistory(bootstrap)).some(
          (message) =>
            message.role === "user" &&
            message.content === RECOVERED_USER_MESSAGE,
        ),
      "the recovered conversation to survive the resumed turn",
      5_000,
    ).catch(() => undefined);

    const history = await sessionHistory(bootstrap);
    expect(
      history.some(
        (message) =>
          message.role === "user" && message.content === RECOVERED_USER_MESSAGE,
      ),
    ).toBe(true);
    expect(
      history.some(
        (message) =>
          message.role === "tool" && message.toolCallId === REPLAY_CALL_ID,
      ),
    ).toBe(true);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("does not return before the recovered turn has started", async () => {
    // `restoreAgent` returning while the resume is still queued leaves a
    // window: a client that submits in it has its brand-new turn aborted
    // `replaced` by the late resume (`Session.spawnTask` ->
    // `abortAllTasksLocked("replaced")`). The recovered turn must already own
    // the session's turn slot by the time restore reports success, so the
    // newer user message replaces the resume and never the other way round.
    await stubProvider();
    stubProviderAndMcp();

    const eventTypes = recordEmittedEventTypes();
    const runner = makeRunner();

    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    // `turn_resumed` is emitted right after `spawnTask` installed the
    // recovered turn as the session's active turn.
    expect(eventTypes).toContain("turn_resumed");

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);


  it("returns from a restore whose recovered turn stalls before it can start", async () => {
    // The wait for `turn_resumed` replaced an inline resume that ran inside
    // bootstrap's `DaemonOperationScope("session startup prewarm",
    // DAEMON_AGENT_CREATE_TIMEOUT_MS)`, and everything the resume does before
    // that event can block: `restoreCheckpointProviderRoute` ->
    // `session.prepareProviderSwitch` (credential/provider I/O), `spawnTask`'s
    // abort drain, the fsync-durable emit itself. `daemon-cli` awaits every
    // recovered restore SERIALLY before `socketServer.listen()`, so an
    // unbounded wait stops the daemon from ever listening — which also
    // permanently prevents the client attach this whole fix exists to enable.
    // The wait must expire and hand control back.
    await stubProvider();
    stubProviderAndMcp();

    const warnings = recordEmittedWarnings();
    const stalled = stubStalledResume();

    const runner = makeRunner(undefined, { durableResumeTimeoutMs: 500 });
    const restore = runner.restoreAgent(restoreParams());
    const outcome = await raceOutcome(
      restore.then(
        () => "restoreAgent returned while the recovered turn was still stalled",
      ),
      "restoreAgent never returned: the recovered turn stalled before turn_resumed",
      8_000,
    );
    expect(outcome).toBe(
      "restoreAgent returned while the recovered turn was still stalled",
    );
    await expect(restore).resolves.toBe(true);

    // Expiry is recorded, never silent: the operator and the attaching client
    // both learn that the recovered turn had not started yet.
    expect(stalled.entered()).toBe(true);
    expect(
      warnings.filter(
        (warning) => warning.cause === "durable_resume_start_timeout",
      ),
    ).toHaveLength(1);

    // ...and the orphan is NOT abandoned. It is single-shot (see the
    // "replay persists its abort" test), so cancelling it at the deadline
    // would destroy the interrupted turn instead of merely delaying it.
    expect(stalled.finished()).toBe(false);
    stalled.release();
    await waitUntil(
      () => stalled.finished(),
      "the resume to keep running in the background after the wait expired",
    );

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("re-applies the recovered conversation once a newer turn releases the slot", async () => {
    // Moving the resume after `#hydrateRecoveredAgentState` created a window
    // that did not exist on base: `syncSessionState` republishes
    // `session.state.history` from the checkpoint prefix at EVERY sampling
    // boundary, so once the resumed turn has sampled, the recovered
    // conversation is gone until the re-apply lands. If a client message
    // replaces the resume in between, the re-apply used to be skipped
    // outright and `initialMessages` plus the re-dispatched `replayToolCalls`
    // were lost for good. It must wait for the slot instead of dropping them.
    //
    // The busy slot is simulated by faking exactly the read the runner makes
    // (`session.activeTurn.unsafePeek()`), which is the whole window: driving
    // a real replacing turn to sit in that slot at the microsecond the resume
    // settles is the interleaving the round-3 review could not construct.
    await stubProvider();
    stubProviderAndMcp();

    const { runner, bootstrap } = await restoreRecoveredRun({
      durableResumeTimeoutMs: 30_000,
      holdSlot: true,
    });

    // While the newer turn owns the slot the recovered conversation stays
    // erased — appending it under a live turn would rewrite that turn's
    // context, and its next `syncSessionState` would overwrite it anyway.
    await waitUntil(
      async () => (await sessionHistory(bootstrap)).length > 0,
      "history to be republished under the live turn",
      750,
    ).catch(() => undefined);
    expect(await sessionHistory(bootstrap)).toEqual([]);

    // The slot frees; the recovered conversation must come back rather than
    // be dropped for good.
    releaseTurnSlot(bootstrap);
    await waitUntil(
      async () => hasRecoveredUserMessage(await sessionHistory(bootstrap)),
      "the recovered conversation to survive the turn that replaced the resume",
      10_000,
    );
    expect(hasReplayedToolResult(await sessionHistory(bootstrap))).toBe(true);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);


  it("never withholds the resume from a restore that defers startup side effects", async () => {
    // A suspended / startup-activation-pending restore passes
    // `deferAgentStartupSideEffects: true`, which hands the WHOLE startup
    // prewarm — the durable resume with it — to whoever activates it later,
    // by which time the approval bridge and the `#active` entry exist. The two
    // deferrals must therefore be mutually exclusive: setting both would mark
    // the resume pending inside a prewarm nobody can pair with a
    // `runDeferredDurableTurnResume` call, and the orphan is single-shot, so
    // the turn would be lost rather than late.
    //
    // Out of scope, unchanged, pre-existing: `bin/bootstrap.ts` gates the
    // prewarm block itself on the same flag, so today nothing runs it for
    // those restores at all. This test pins that whoever does run it resumes
    // the orphan, with the daemon approval bridge already installed.
    await stubProvider();
    stubProviderAndMcp();
    seedPendingStartupActivation();
    expect(
      reconstructFromRollout(readRollout(rolloutPath)).resumableTurns.map(
        (turn) => turn.turnId,
      ),
    ).toEqual([TURN_ID]);

    const observations = recordResumeObservations();

    let booted: LocalRuntimeBootstrap | undefined;
    const runner = makeRunner((bootstrap) => {
      booted = bootstrap;
    });

    await expect(
      runner.restoreAgent(
        restoreParams({ resumeStartupActivationPending: true }),
      ),
    ).resolves.toBe(true);

    expect(bootstrapOptions).toHaveLength(1);
    expect(bootstrapOptions[0]!.deferAgentStartupSideEffects).toBe(true);
    expect(bootstrapOptions[0]!.deferDurableTurnResume).toBeUndefined();
    // Nothing ran the prewarm yet, so no turn of any kind was driven.
    expect(observations).toEqual([]);

    // Whoever activates the deferred startup work drives the resume inline,
    // and by then the bridge this issue is about is installed.
    const manager = (
      booted!.session.services as {
        readonly conversationThreadManager?: {
          runStartupPrewarm: (session: unknown) => Promise<unknown>;
        };
      }
    ).conversationThreadManager;
    await manager!.runStartupPrewarm(booted!.session);

    expect(observations).toEqual([
      {
        resume: true,
        hasApprovalResolver: true,
        hasGuardianApprovalReviewer: true,
      },
    ]);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("runs the recovered turn under the agent's unattended policy", async () => {
    // Documented consequence of resuming after `installUnattendedPermissionPolicy`
    // instead of inside bootstrap: the recovered turn is now subject to the
    // agent's configured unattended allow/deny lists, where before it always
    // reached the arbiter's `default_deny`. That is the configured behavior of
    // an unattended agent — an allowlisted tool runs without a prompt and a
    // denylisted one is refused without one — and it is asserted here rather
    // than left to be discovered.
    await stubProvider();
    stubProviderAndMcp();

    const decisions: Array<Record<string, unknown>> = [];
    stubTurn((session, isResume) => {
      if (!isResume) return;
      const context = session.permissionModeRegistry!.current();
      decisions.push({
        mode: context.mode,
        glob: resolveUnattendedPermissionDecision(context, "Glob").behavior,
        exec: resolveUnattendedPermissionDecision(context, "exec_command")
          .behavior,
        edit: resolveUnattendedPermissionDecision(context, "Edit").behavior,
      });
    });

    const runner = makeRunner();
    await expect(
      runner.restoreAgent(
        restoreParams({
          metadata: {
            unattendedAllow: ["Glob"],
            unattendedDeny: ["exec_command"],
          },
        }),
      ),
    ).resolves.toBe(true);

    expect(decisions).toEqual([
      { mode: "unattended", glob: "allow", exec: "deny", edit: "pause" },
    ]);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("neither polls nor warns when the recovered run has nothing to merge", async () => {
    // The emptiness test lives inside the merge thunk
    // (`hydrateRecoveredSessionHistory` returns immediately for an empty
    // recovered conversation), and `daemon-cli` only supplies recovered
    // messages when the snapshot HAS them. So the ordinary recovered run — no
    // snapshot conversation, no in-flight tool calls — must not spend the
    // whole `durableResumeTimeoutMs` polling a slot it has nothing to write,
    // and must not then tell the operator that a conversation nobody had was
    // lost. The decision has to be made BEFORE the wait.
    await stubProvider();
    stubProviderAndMcp();

    const warnings = recordEmittedWarnings();
    let pollSleeps = 0;
    spyOnTimers((ms) => {
      if (ms === SLOT_POLL_MS) pollSleeps += 1;
    });
    const resumed = stubResumedTurn();

    const runner = makeRunner(
      (bootstrap) => {
        // A newer client turn owns the slot for the rest of the test: if the
        // wait ran at all, it would run to its deadline.
        holdTurnSlot(bootstrap);
      },
      { durableResumeTimeoutMs: 300 },
    );

    // No `initialMessages`, no `replayToolCalls`: nothing to merge back.
    await expect(runner.restoreAgent(restoreParams())).resolves.toBe(true);
    await resumed.settled;

    const sleepsBeforeWindow = pollSleeps;
    // Five times the bound: a poll that started would have run out and
    // recorded its warning well inside this window.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(
      warnings.filter(
        (warning) => warning.cause === "recovered_history_reapply_abandoned",
      ),
    ).toEqual([]);
    expect(pollSleeps - sleepsBeforeWindow).toBe(0);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("bounds the production start wait by the startup-prewarm deadline it replaced", async () => {
    // The commit's safety property is that the deferred resume never blocks
    // the restore for longer than the inline resume it replaced, which ran
    // inside `DaemonOperationScope("session startup prewarm",
    // DAEMON_AGENT_CREATE_TIMEOUT_MS)`. Tests that inject their own bound
    // cannot see that, so this one takes the PRODUCTION default and reads the
    // timer the runner actually installs: while the resume is stalled before
    // `turn_resumed`, the start wait is the only long timer still pending
    // (the prewarm scope disposes its own when bootstrap returns).
    await stubProvider();
    stubProviderAndMcp();

    const pendingLongTimers = new Map<object, number>();
    spyOnTimers(
      (ms, timer) => {
        if (ms >= 100_000) pendingLongTimers.set(timer, ms);
      },
      (timer) => {
        pendingLongTimers.delete(timer);
      },
    );
    const stalled = stubStalledResume();

    const runner = makeRunner();
    const restore = runner.restoreAgent(restoreParams());
    await waitUntil(
      () => stalled.entered() && pendingLongTimers.size > 0,
      "the start wait to be installed with the production default",
    );
    expect([...pendingLongTimers.values()]).toEqual([
      DAEMON_AGENT_CREATE_TIMEOUT_MS,
    ]);

    stalled.release();
    await expect(restore).resolves.toBe(true);
    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("records the abandoned merge when a newer turn never releases the slot", async () => {
    // The other end of the wait: recovered content DOES exist, and the turn
    // that replaced the resume outlives the bound. The merge is given up, and
    // that loss is recorded rather than silent — the operator and the next
    // client to attach both see which agent lost its recovered conversation.
    await stubProvider();
    stubProviderAndMcp();

    const warnings = recordEmittedWarnings();
    const { runner, bootstrap } = await restoreRecoveredRun({
      durableResumeTimeoutMs: 400,
      holdSlot: true,
    });

    await waitUntil(
      () =>
        warnings.some(
          (warning) => warning.cause === "recovered_history_reapply_abandoned",
        ),
      "the abandoned merge to be recorded",
      10_000,
    );
    const abandoned = warnings.filter(
      (warning) => warning.cause === "recovered_history_reapply_abandoned",
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.message).toContain("400ms");
    // The warning is not decorative: the recovered conversation really is gone
    // from the session it was hydrated onto.
    expect(await sessionHistory(bootstrap)).toEqual([]);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("re-applies the recovered conversation when the resume throws after re-opening the turn", async () => {
    // `runDeferredDurableTurnResume` swallows the failure and reports
    // `resumed: false`, but the turn had already re-opened and already
    // republished `session.state.history` from its checkpoint prefix. Keying
    // the re-apply off the attempt outcome alone would leave the recovered
    // conversation erased for exactly the runs that failed.
    await stubProvider();
    stubProviderAndMcp();

    const { runner, bootstrap } = await restoreRecoveredRun({
      durableResumeTimeoutMs: 30_000,
      resumeThrows: true,
    });

    await waitUntil(
      async () => hasRecoveredUserMessage(await sessionHistory(bootstrap)),
      "the recovered conversation to survive a resume that threw after starting",
      10_000,
    );
    expect(hasReplayedToolResult(await sessionHistory(bootstrap))).toBe(true);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("releases the start wait as soon as the caller's restore is aborted", async () => {
    // The daemon-startup path passes no signal, which is why the timeout
    // exists — but the on-demand lifecycle path (agent-lifecycle.ts, an
    // `agent.create` resume waiter) owns its own deadline and DOES pass one.
    // Its cancellation must release this wait immediately instead of waiting
    // out a bound that belongs to daemon startup.
    await stubProvider();
    stubProviderAndMcp();

    const stalled = stubStalledResume();
    const controller = new AbortController();
    const runner = makeRunner(undefined, {
      durableResumeTimeoutMs: 30_000,
      agentStopTimeoutMs: 2_000,
    });
    const restore = runner.restoreAgent(
      restoreParams({ signal: controller.signal }),
    );
    const settled = restore.then(
      () => "the restore resolved",
      () => "the restore rejected",
    );

    await waitUntil(
      () => stalled.entered(),
      "the recovered turn to reach its stall",
    );
    const abortedAt = Date.now();
    controller.abort(new Error("the caller cancelled the restore"));
    const outcome = await raceOutcome(
      settled,
      "the restore was still waiting out its own timeout",
      10_000,
    );
    expect(outcome).toBe("the restore rejected");
    expect(Date.now() - abortedAt).toBeLessThan(10_000);

    stalled.release();
    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);

  it("appends only the replayed tool results when the replacing turn already published its own conversation", async () => {
    // The realistic shape of a replaced resume, asserted rather than
    // described: by the time the slot frees, the client turn that replaced the
    // resume has published its OWN conversation. The merge then appends the
    // re-dispatched tool results at the tail and does NOT reintroduce the
    // recovered `initialMessages` ahead of a conversation that has moved on.
    // That is a real ordering change from base (which merged before any client
    // turn could exist) and it is the accepted trade the doc comment states.
    await stubProvider();
    stubProviderAndMcp();

    const { runner, bootstrap } = await restoreRecoveredRun({
      durableResumeTimeoutMs: 30_000,
      holdSlot: true,
    });

    // What the replacing turn does that the busy-slot test never modelled: it
    // publishes its own history before it releases the slot.
    await setSessionHistory(bootstrap, [
      { role: "user", content: "NEWER CLIENT MESSAGE" },
      { role: "assistant", content: "the newer turn's answer" },
    ]);
    releaseTurnSlot(bootstrap);

    await waitUntil(
      async () => (await sessionHistory(bootstrap)).length > 2,
      "the recovered tool results to be merged onto the newer conversation",
      10_000,
    );
    const history = await sessionHistory(bootstrap);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
    ]);
    expect(history[0]!.content).toBe("NEWER CLIENT MESSAGE");
    expect(history.at(-1)!.toolCallId).toBe(REPLAY_CALL_ID);
    // Accepted limitation, pinned so it cannot drift into a claim: the
    // recovered user message is NOT restored ahead of the newer conversation.
    expect(
      history.some((message) => message.content === RECOVERED_USER_MESSAGE),
    ).toBe(false);

    await runner.stopAgent(CONVERSATION_ID).catch(() => undefined);
  }, 60_000);
});
