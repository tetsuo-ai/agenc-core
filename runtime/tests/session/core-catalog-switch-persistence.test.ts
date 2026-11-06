import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { capturePromptCacheState, coreCatalogSwitchItem, restorePromptCacheState } from "../../src/session/prompt-cache-state.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

// Native DeepSeek Light's compact core catalog and its one switch to the full core schemas
// (tool-registry.deepseek-cache.test.ts covers the presentation itself).
function deepSeekLightRegistry() {
  return buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    toolsConfig: { disabled_tools: [] },
    getSession: () => ({ services: { provider: { name: "deepseek" },
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-flash" }) } } }) as unknown as Session,
    unifiedExecManager: {
      maxTimeoutMs: Infinity,
      execCommand: vi.fn(async () => ({ stdout: "", stderr: "", output: "", exitCode: null,
        process_id: 71, exit_code: null, wall_time_seconds: 0.001, original_token_count: 0, timedOut: false, truncated: false, durationMs: 1 })),
      writeStdin: vi.fn(), closeAll: vi.fn(async () => {}),
    },
  });
}

const provider = new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna" });
let root: string;
let rollout: RolloutStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-core-catalog-switch-"));
  const agencHome = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  rollout = new RolloutStore({ agencHome, cwd, sessionId: "switch", agencVersion: "0.2.0",
    sessionTempRoot: root, autoStartScheduler: false });
  rollout.open({ sessionId: "switch", timestamp: "2026-11-06T00:00:00.000Z", cwd, originator: "test", agencVersion: "0.2.0" });
});

afterEach(() => {
  rollout?.close();
  rmSync(root, { recursive: true, force: true });
});

function session(services: object): Session {
  let nextId = 0;
  return Object.assign(Object.create(Session.prototype), {
    eventLog: new EventLog(), rolloutStore: rollout,
    txEvent: { send: () => true },
    isRolloutPersistenceSuspended: () => false,
    nextInternalSubId: () => `switch-sub-${++nextId}`,
    emittedTaskAbortTurnIds: new Set<string>(),
    stoppedByUserSinceLastPromptFlag: false,
    userStopGenerationValue: 0,
    services,
  }) as Session;
}

function warning(id: string): Event {
  return { id, msg: { type: "warning", payload: { message: id } } };
}

const switchLines = (items: readonly RolloutItem[]) =>
  items.filter(item => item.type === "session_state" && item.payload.coreCatalog === "expanded");
const cacheStates = (items: readonly RolloutItem[]) =>
  items.flatMap(item => item.type === "session_state" && Object.hasOwn(item.payload, "promptCache") ? [item.payload.promptCache] : []);

test("a process that dies in the turn that switched keeps the switch (Fcat30-7)", () => {
  // The switch rode only in the prompt cache state, which is written at turn end.
  const live = deepSeekLightRegistry();
  const running = session({ registry: live });
  running.emit(warning("request"), { durable: true });
  // A selection of a compact core tool, or a sandbox notice that advises escalation, switches the catalog.
  live.discoverToolNames?.(["exec_command"]);
  const lastSent = JSON.stringify(live.toLLMTools());
  running.emit(warning("tool result"));
  running.emit(warning("iteration checkpoint"), { durable: true });
  running.emit(warning("next request"), { durable: true });
  // The process dies here, before the turn ends.
  const items = rollout.readAll();
  expect(cacheStates(items)).toEqual([]);
  expect(switchLines(items)).toHaveLength(1);
  const resumed = deepSeekLightRegistry();
  expect(JSON.stringify(resumed.toLLMTools())).not.toBe(lastSent);
  restorePromptCacheState({}, provider, items, resumed);
  expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
});

test("the turn that switched keeps the switch when its prompt cache state is too large to save (Fcat30-8)", () => {
  const live = deepSeekLightRegistry();
  const running = session({ registry: live, providerService: new SessionProviderService({ initialProvider: provider }) });
  live.discoverToolNames?.(["exec_command"]);
  const lastSent = JSON.stringify(live.toLLMTools());
  // About 4.4 MB of attachment tracking state: above the recovery line limit, so the turn end saves no state.
  const tracking = getAttachmentTrackingState(running);
  for (let index = 0; index < 1100; index++) tracking.listedSkillNames.add(`skill-${index}-${"x".repeat(4000)}`);
  running.emitTurnAbortedOnce("turn-1", "interrupted");
  const items = rollout.readAll();
  expect(cacheStates(items)).toEqual([null]);
  const resumed = deepSeekLightRegistry();
  restorePromptCacheState({}, provider, items, resumed);
  expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
});

test("a later turn end too large to save does not undo a switch an earlier turn end saved", () => {
  // Rollouts written before the switch had its own line: the last saved state wins for everything else.
  const live = deepSeekLightRegistry();
  live.discoverToolNames?.(["exec_command"]);
  const lastSent = JSON.stringify(live.toLLMTools());
  const items: RolloutItem[] = [
    { type: "session_state", payload: { promptCache: capturePromptCacheState({}, provider, live) } },
    { type: "session_state", payload: { promptCache: null } },
  ];
  const resumed = deepSeekLightRegistry();
  restorePromptCacheState({}, provider, items, resumed);
  expect(JSON.stringify(resumed.toLLMTools())).toBe(lastSent);
});

test("the switch line is written once, never for a session that did not switch, and not again after a resume", () => {
  const live = deepSeekLightRegistry();
  const running = session({ registry: live, providerService: new SessionProviderService({ initialProvider: provider }) });
  running.emit(warning("compact"), { durable: true });
  live.discoverToolNames?.(["write_stdin", "kill_process"]);
  running.emitTurnAbortedOnce("turn-1", "interrupted");
  expect(switchLines(rollout.readAll())).toEqual([]);
  live.discoverToolNames?.(["FileRead"]);
  running.emit(warning("switched"), { durable: true });
  running.emitTurnAbortedOnce("turn-2", "interrupted");
  const items = rollout.readAll();
  expect(switchLines(items)).toHaveLength(1);
  // A resumed session restores the switch and does not write it again.
  const resumedRegistry = deepSeekLightRegistry();
  const resumed = {};
  restorePromptCacheState(resumed, provider, items, resumedRegistry);
  expect(resumedRegistry.isCoreCatalogExpanded?.()).toBe(true);
  expect(coreCatalogSwitchItem(resumed, resumedRegistry)).toBeUndefined();
  // A child that starts from its parent's switch writes it into its own rollout, once.
  const child = deepSeekLightRegistry();
  child.expandCoreCatalog?.();
  const childSession = {};
  expect(coreCatalogSwitchItem(childSession, child)).toEqual({ type: "session_state", payload: { coreCatalog: "expanded" } });
  expect(coreCatalogSwitchItem(childSession, child)).toBeUndefined();
});
