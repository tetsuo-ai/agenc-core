/**
 * Child process for the checkpoint-prefix crash/restart test.
 *
 * argv: crash <root> <kill-point> <boundary> <ordinal> | recover <root>
 *
 * crash: run a real two-turn session (RolloutStore, runTurn, read-only and
 * side-effecting tools) and SIGKILL during the second turn at a checkpoint:
 *   before-append  the incremental digest is built but the checkpoint event
 *                  never reaches disk (death in the middle of a checkpoint);
 *   after-append   the checkpoint event was appended and fsynced;
 *   during-build   inside the incremental build, before the digest exists.
 * The kill hits the first second-turn checkpoint at or after <ordinal> whose
 * boundary is <boundary> (any boundary for during-build).
 * recover: open the same rollout in a fresh process (opening re-validates
 * every checkpoint from scratch), reconstruct, resume the interrupted turn,
 * finish it, then reopen and validate every checkpoint again.
 * open-kill <n>: open the same rollout and SIGKILL inside that open-time
 * validation, at its n-th checkpoint (its projection transaction never commits).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeTurnFromCheckpoint } from "../../../src/conversation/thread-manager.js";
import { ConfigStore } from "../../../src/config/store.js";
import { createManagedFeatures } from "../../../src/llm/registry/features.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../../src/llm/types.js";
import { PermissionModeRegistry } from "../../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import { CheckpointPrefixTracker } from "../../../src/session/checkpoint-prefix-tracker.js";
import { IncrementalCheckpointPrefixValidatorV4 } from "../../../src/session/durable-checkpoint-reader.js";
import { openStateDatabases } from "../../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../../src/state/tool-pair-projection.js";
import { planLegacyDurableCheckpointUpgrade } from "../../../src/session/durable-checkpoint-upgrade.js";
import { computeCheckpointPrefixHashV4, readTurnCheckpoint } from "../../../src/session/durable-checkpoint-reader.js";
import type { Event } from "../../../src/session/event-log.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import type { ResponseItem, RolloutItem } from "../../../src/session/rollout-item.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import { Session, type SessionOpts, type SessionServices } from "../../../src/session/session.js";
import type { TurnContext } from "../../../src/session/turn-context.js";
import type { ToolRegistry } from "../../../src/tool-registry.js";
import { AsyncQueue } from "../../../src/utils/async-queue.js";

const SESSION_ID = "checkpoint-prefix-crash";
const FIRST_TURN_CALLS = 12;
const SECOND_TURN_CALLS = 12;
const SECOND_PROMPT = "read the second batch";
const [command, root, killPoint, killBoundary, killOrdinal] = process.argv.slice(2);
if (root === undefined || (command !== "crash" && command !== "recover" && command !== "open-kill")) {
  throw new Error("usage: crash <root> <before-append|after-append> <postAssistant|iteration> <ordinal> | recover <root> | open-kill <root> <n>");
}
const cwd = join(root, "workspace");
const home = join(root, "home");
const effects = join(root, "effects.log");
const trace = join(root, "trace.log");
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
const note = (line: object) => appendFileSync(trace, `${JSON.stringify(line)}\n`);

function usage(): LLMResponse["usage"] {
  return { promptTokens: 8, completionTokens: 4, totalTokens: 12, availability: "reported", provenance: "provider" };
}

/** The plan depends only on the history, so both processes follow it. */
const provider = {
  name: "stub-provider",
  chat: async () => ({ content: "summary", toolCalls: [], usage: usage(), model: "test-model", finishReason: "stop" }),
  healthCheck: async () => true,
  chatStream: async (messages: LLMMessage[]): Promise<LLMResponse> => {
    const results = messages.filter((message) => message.role === "tool").length;
    const secondTurn = messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes(SECOND_PROMPT));
    const target = secondTurn ? FIRST_TURN_CALLS + SECOND_TURN_CALLS : FIRST_TURN_CALLS;
    if (results >= target) {
      return { content: `finished ${results}`, toolCalls: [], usage: usage(), model: "test-model", finishReason: "stop" };
    }
    const next = results + 1;
    const name = next % 4 === 0 ? "AppendEffect" : "ReadFixture";
    return {
      content: "",
      toolCalls: [{ id: `call-${next}`, name, arguments: JSON.stringify({ step: next }) }],
      usage: usage(),
      model: "test-model",
      finishReason: "tool_calls",
    };
  },
} as unknown as LLMProvider;

const tools = [
  {
    name: "ReadFixture", description: "read a fixture", inputSchema: { type: "object" },
    requiresApproval: false, isReadOnly: true, recoveryCategory: "idempotent",
    execute: async (args: { step: number }) => ({
      content: `fixture ${args.step}\n${"export const value = compute(input);\n".repeat(12)}`,
      isError: false,
    }),
  },
  {
    name: "AppendEffect", description: "append one line", inputSchema: { type: "object" },
    requiresApproval: false, recoveryCategory: "side-effecting",
    execute: async (args: { step: number }) => {
      appendFileSync(effects, `effect ${args.step}\n`);
      return { content: `appended ${args.step}`, isError: false };
    },
  },
];
const registry = {
  tools,
  toLLMTools: () => [],
  dispatch: async (name: string, args: { step: number }) => tools.find((tool) => tool.name === name)!.execute(args),
} as unknown as ToolRegistry;

function openStore(resume: boolean): RolloutStore {
  const store = new RolloutStore({
    cwd, agencHome: home, sessionId: SESSION_ID, agencVersion: "test", sessionTempRoot: root!,
    autoStartScheduler: false,
    ...(resume ? { resume: true, resumeRolloutPath: readFileSync(join(root!, "rollout-path"), "utf8") } : {}),
  });
  store.open({ cwd, sessionId: SESSION_ID, agencVersion: "test", originator: "checkpoint-prefix-crash",
    timestamp: new Date().toISOString(), model: "test-model", modelProvider: "stub-provider" });
  return store;
}

function createSession(store: RolloutStore): Session {
  const features = createManagedFeatures();
  const configHome = join(root!, "config-home");
  mkdirSync(configHome, { recursive: true });
  const services = {
    admissionRequired: false,
    runtimeOptions: resolveAgentRuntimeOptions({}),
    configStore: new ConfigStore({ home: configHome, env: { AGENC_HOME: configHome }, cwd }),
    mcpConnectionManager: { setApprovalPolicy: () => {}, setSandboxPolicy: () => {}, requiredStartupFailures: async () => [] },
    mcpStartupCancellationToken: { cancel: () => {}, isCancelled: () => false },
    provider,
    providerEnvironment: {},
    registry,
    hooks: { executeStop: async () => ({}) },
    permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
  } as unknown as SessionServices;
  const policy = {
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "danger_full_access" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
  };
  const session = new Session({
    conversationId: SESSION_ID,
    services,
    initialState: {
      sessionConfiguration: {
        cwd, ...policy, windowsSandboxLevel: "none", collaborationMode: { model: "test-model" },
        dynamicTools: [], sessionSource: "cli_main", provider: { slug: "stub-provider" },
      },
      history: [],
      totalTokenUsage: 0,
    } as unknown as SessionOpts["initialState"],
    features,
    jsRepl: { id: "repl-checkpoint-prefix" },
    config: {
      model: "test-model", cwd, features,
      multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
      permissions: { allowLoginShell: false, shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] }, windowsSandboxPrivateDesktop: false },
      ghostSnapshot: { enabled: false },
      agentRoles: [],
      durableTurns: { resume: { requireLease: false } },
    } as unknown as SessionOpts["config"],
    modelInfo: {
      slug: "test-model", effectiveContextWindowPercent: 100, contextWindow: 131_072,
      supportedReasoningLevels: [], defaultReasoningSummary: "auto", truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    eventQueue: new AsyncQueue<Event>(),
  });
  session.mountRolloutStore(store);
  return session;
}

function context(subId: string): TurnContext {
  return {
    subId, cwd, config: { maxTurns: 100 }, configSnapshot: {},
    modelInfo: {
      slug: "test-model", effectiveContextWindowPercent: 100, contextWindow: 131_072,
      supportedReasoningLevels: [], defaultReasoningSummary: "auto", truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    collaborationMode: { model: "test-model" },
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "danger_full_access" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    reasoningSummary: "auto", sessionSource: "cli_main", currentDate: "2026-10-19", timezone: "Etc/UTC",
    dynamicTools: [], depth: 0,
    toolCallGate: { isReady: () => true, signal: () => {}, wait: async () => {} },
  } as unknown as TurnContext;
}

async function drain(turn: AsyncGenerator<unknown, unknown>): Promise<void> {
  for await (const _event of turn) { /* drain */ }
}

/** Recompute every checkpoint from the persisted history, as resume does. */
function validateAll(items: readonly RolloutItem[]): { checkpoints: number; recomputed: number } {
  let history: ResponseItem[] = [];
  let checkpoints = 0;
  let recomputed = 0;
  for (const item of items) {
    if (item.type === "response_item") history.push(item.payload);
    if (item.type === "compacted" && item.payload.replacementHistory !== undefined) {
      history = [...item.payload.replacementHistory];
    }
    if (item.type !== "event_msg" || item.payload.msg.type !== "turn_checkpoint") continue;
    checkpoints += 1;
    const checkpoint = readTurnCheckpoint(item.payload.msg.payload).checkpoint;
    const digest = computeCheckpointPrefixHashV4(history, checkpoint.persistedMessageCount);
    if (digest !== checkpoint.prefixHash) {
      throw new Error(`checkpoint ${checkpoints} digest ${digest} does not match ${checkpoint.prefixHash}`);
    }
    recomputed += 1;
  }
  return { checkpoints, recomputed };
}

function effectLines(): string[] {
  try { return readFileSync(effects, "utf8").split("\n").filter(Boolean); }
  catch { return []; }
}

/** Log every checkpoint build of this process and how much it projected. */
function traceBuilds(label: () => string, beforeBuild: () => void = () => {}): void {
  const capture = CheckpointPrefixTracker.prototype.capture;
  CheckpointPrefixTracker.prototype.capture = function (...args) {
    const prefix = capture.apply(this, args);
    const build = prefix.build.bind(prefix);
    prefix.build = () => {
      beforeBuild();
      const result = build();
      note({ build: result.persistedMessageCount, projected: result.projectedMessages, phase: label() });
      return result;
    };
    return prefix;
  };
}

if (command === "crash") {
  const store = openStore(false);
  writeFileSync(join(root, "rollout-path"), store.rolloutPath);
  const session = createSession(store);
  let secondTurn = false;
  let secondTurnCheckpoints = 0;
  let secondTurnBuilds = 0;
  traceBuilds(() => secondTurn ? "crash-second-turn" : "crash-first-turn", () => {
    if (killPoint === "during-build" && secondTurn && (secondTurnBuilds += 1) >= Number(killOrdinal)) {
      note({ killed: "during-build", boundary: killBoundary });
      process.kill(process.pid, "SIGKILL");
    }
  });
  const append = store.append.bind(store);
  store.append = (event, options) => {
    const checkpoint = event.msg.type === "turn_checkpoint" ? event.msg.payload : undefined;
    const target = secondTurn && checkpoint !== undefined &&
      (secondTurnCheckpoints += 1) >= Number(killOrdinal) && checkpoint.boundary === killBoundary;
    if (target && killPoint === "before-append") {
      note({ killed: "before-append", boundary: checkpoint.boundary, count: checkpoint.persistedMessageCount });
      process.kill(process.pid, "SIGKILL");
    }
    const appended = append(event, options);
    if (target && killPoint === "after-append") {
      note({ killed: "after-append", boundary: checkpoint.boundary, count: checkpoint.persistedMessageCount });
      process.kill(process.pid, "SIGKILL");
    }
    return appended;
  };
  await drain(session.runTurn("read the first batch", { ctx: context("turn-one") }));
  secondTurn = true;
  await drain(session.runTurn(SECOND_PROMPT, { ctx: context("turn-two") }));
  note({ error: "the second turn completed without reaching the kill point" });
  process.exit(3);
} else if (command === "open-kill") {
  const validate = IncrementalCheckpointPrefixValidatorV4.prototype.validate;
  let validated = 0;
  IncrementalCheckpointPrefixValidatorV4.prototype.validate = function (...args) {
    if ((validated += 1) === Number(killPoint)) {
      note({ killed: "open-validation", validated });
      process.kill(process.pid, "SIGKILL");
    }
    return validate.apply(this, args);
  };
  openStore(true);
  note({ error: "the open finished without reaching the kill point" });
  process.exit(3);
} else {
  // Opening re-validates every persisted checkpoint and fails on any mismatch.
  // Count the exact tool-pair projection's work while it does.
  const insertCall = StateToolPairProjection.prototype.insertCall;
  let openInserts = 0;
  StateToolPairProjection.prototype.insertCall = function (...args) {
    openInserts += 1;
    return insertCall.apply(this, args);
  };
  const store = openStore(true);
  StateToolPairProjection.prototype.insertCall = insertCall;
  const before = validateAll(store.readAll());
  const reconstruction = reconstructFromRollout(store.readAll(), {
    checkpointProjection: store.checkpointProjectionContext("checkpoint-prefix-crash"),
  });
  const resumable = reconstruction.resumableTurns.map((turn) => ({
    turnId: turn.turnId,
    integrity: turn.checkpointIntegrityStatus,
    dangling: turn.danglingToolUses.map((use) => use.toolName),
    persistedMessageCount: turn.lastCheckpoint.persistedMessageCount,
  }));
  const session = createSession(store);
  traceBuilds(() => "recover");
  session.eventLog.seedCanonicalHistory(store.readAll()
    .filter((item): item is Extract<RolloutItem, { type: "event_msg" }> => item.type === "event_msg")
    .map((item) => item.payload));
  const events: string[] = [];
  session.eventLog.subscribe((event) => { events.push(event.msg.type); });
  const attempt = await resumeTurnFromCheckpoint(session, reconstruction, undefined, { ctx: context("turn-two") });
  await session.shutdown().catch(() => undefined);
  try { store.close(); } catch { /* shutdown may already have closed it */ }
  const reopened = openStore(true);
  const items = reopened.readAll();
  const after = validateAll(items);
  const plan = planLegacyDurableCheckpointUpgrade({
    items, runId: SESSION_ID, ...reopened.checkpointProjectionContext("checkpoint-prefix-crash-final"),
  });
  reopened.close();
  const results = items.filter((item) => item.type === "response_item" && item.payload.role === "tool")
    .map((item) => (item as Extract<RolloutItem, { type: "response_item" }>).payload.toolCallId);
  const state = openStateDatabases({ cwd, agencHome: home, deferLogs: true });
  const projectionRuns = state.state
    .prepare("SELECT status, COUNT(*) AS runs FROM tool_pair_projection_runs WHERE projection_id LIKE 'checkpoint-upgrade:%' GROUP BY status")
    .all();
  state.close();
  process.stdout.write(`${JSON.stringify({
    before, after, resumable, openInserts, projectionRuns,
    resumed: attempt.resumed,
    reason: "reason" in attempt ? attempt.reason : undefined,
    turnCompleted: events.includes("turn_complete"),
    plan: plan.status === "planned"
      ? { status: plan.status, changed: plan.plan.changed, validated: plan.plan.checkpointsValidated }
      : { status: plan.status },
    toolResults: results.length,
    distinctToolResults: new Set(results).size,
    effects: effectLines(),
  })}\n`);
}
