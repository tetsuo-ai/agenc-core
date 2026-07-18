/**
 * Source-aligned with `src/services/SessionMemory/sessionMemory.ts` at donor
 * commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC runs the updater from the live turn loop instead of a donor hook
 *     registry.
 *   - Child tool access is enforced by `ChildToolPolicy`, and the notes path
 *     is granted through AgenC's internal session allowed-roots argument.
 */

import {
  mkdir,
  open,
  writeFile,
} from "node:fs/promises";
import { dirname, sep } from "node:path";

import type { LiveAgent } from "../../agents/control.js";
import { ROOT_AGENT_PATH } from "../../agents/registry.js";
import type {
  ChildToolPolicy,
  RunAgentParams,
} from "../../agents/run-agent.js";
import type { LLMMessage } from "../../llm/types.js";
import { AdmissionDeniedError } from "../../budget/admission-client.js";
import { runAdmittedToolCall } from "../../budget/admitted-tool-call.js";
import {
  cloneLlmMessageSnapshot as cloneMessage,
} from "../../llm/content-conversion.js";
import { roughTokenCountEstimationForMessages } from "../../llm/token-estimation.js";
import type { Session } from "../../session/session.js";
import { FILE_EDIT_TOOL_NAME } from "../../tools/system/file-edit.js";
import { createFileReadTool } from "../../tools/system/file-read.js";
import {
  recordSessionRead,
  seedSessionReadState,
  withSignedAllowedRoots,
  type SessionReadSeedEntry,
} from "../../tools/system/filesystem.js";
import { withSignedSessionId } from "../../agents/_deps/filesystem-args.js";
import type { Tool } from "../../tools/types.js";
import { buildSessionMemoryUpdatePrompt, loadSessionMemoryTemplate } from "./prompts.js";
import {
  createSessionMemoryState,
  getLastSummarizedMessageCount,
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryEnabled,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  resolveSessionMemoryDirectory,
  resolveSessionMemoryPath,
  resetSessionMemoryState,
  setLastSummarizedMessageCount,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
  type SessionMemoryConfig,
  type SessionMemoryEnv,
  type SessionMemoryPathOptions,
  type SessionMemoryState,
} from "./sessionMemoryUtils.js";

const SESSION_MEMORY_QUERY_SOURCE = "session_memory";
const SESSION_MEMORY_SETUP_TOOL_NAME = "internal.session-memory.setup";
const DEFAULT_MAX_AGENT_TURNS = 2;
const ONE_MEBIBYTE = 1024 * 1024;

const SESSION_MEMORY_SETUP_TOOL = {
  name: SESSION_MEMORY_SETUP_TOOL_NAME,
  description: "Initialize and read the session-scoped memory file.",
  inputSchema: {
    type: "object",
    properties: {
      memory_path: { type: "string" },
    },
    required: ["memory_path"],
    additionalProperties: false,
  },
  recoveryCategory: "side-effecting",
  admissionEstimate: () => ({
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxCostUsd: 0,
  }),
  execute: async () => {
    throw new Error(`${SESSION_MEMORY_SETUP_TOOL_NAME} is an internal boundary`);
  },
} satisfies Tool;

export interface SessionMemoryPostSamplingContext {
  readonly messages: readonly LLMMessage[];
  readonly baseInstructions?: string;
  readonly querySource?: string;
  readonly session?: Session;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly env?: SessionMemoryEnv;
  readonly signal?: AbortSignal;
}

export interface SessionMemoryAgentRequest {
  readonly memoryPath: string;
  readonly memoryDir: string;
  readonly currentMemory: string;
  readonly currentMemoryMtimeMs: number;
  readonly prompt: string;
  readonly messages: readonly LLMMessage[];
  readonly baseInstructions?: string;
  readonly session: Session;
  readonly state: SessionMemoryState;
  readonly signal?: AbortSignal;
}

export type SessionMemoryAgentRunner = (
  request: SessionMemoryAgentRequest,
) => Promise<void>;

export interface ManualExtractionResult {
  readonly success: boolean;
  readonly memoryPath?: string;
  readonly error?: string;
}

interface SessionMemoryLane {
  readonly state: SessionMemoryState;
  queue: Promise<void>;
  lastAccessedAt: number;
  pending: number;
}

let agentRunnerForTests: SessionMemoryAgentRunner | null = null;
let defaultSessionMemoryConfig: Partial<SessionMemoryConfig> = {};
const defaultExtractionDecisionState = createSessionMemoryState();
const lanes = new Map<string, SessionMemoryLane>();
const MAX_SESSION_MEMORY_LANES = 256;

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasToolCallsInLastAssistantTurn(
  messages: readonly LLMMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
}

function countToolCallsSince(
  messages: readonly LLMMessage[],
  sinceMessageCount: number,
): number {
  let count = 0;
  const start = Math.max(0, Math.min(messages.length, sinceMessageCount));
  for (const message of messages.slice(start)) {
    if (message.role === "assistant") {
      count += message.toolCalls?.length ?? 0;
    }
  }
  return count;
}

function messageCountMarker(messages: readonly LLMMessage[]): string {
  return `count:${messages.length}`;
}

function tokenCountWithEstimation(messages: readonly LLMMessage[]): number {
  return roughTokenCountEstimationForMessages(messages);
}

async function readSessionMemoryFileWithinLimit(
  memoryPath: string,
  signal: AbortSignal,
): Promise<{
  readonly currentMemory: string;
  readonly currentMemoryMtimeMs: number;
}> {
  signal.throwIfAborted();
  const handle = await open(memoryPath, "r");
  try {
    signal.throwIfAborted();
    const currentStats = await handle.stat();
    if (currentStats.size > ONE_MEBIBYTE) {
      throw new Error(
        `Session memory file exceeds maximum size (${ONE_MEBIBYTE} bytes): ${memoryPath}`,
      );
    }

    const buffer = await handle.readFile({ signal });
    if (buffer.byteLength > ONE_MEBIBYTE) {
      throw new Error(
        `Session memory file exceeds maximum size (${ONE_MEBIBYTE} bytes): ${memoryPath}`,
      );
    }
    signal.throwIfAborted();
    return {
      currentMemory: buffer.toString("utf8"),
      currentMemoryMtimeMs:
        typeof currentStats.mtimeMs === "number" &&
        Number.isFinite(currentStats.mtimeMs)
          ? currentStats.mtimeMs
          : Date.now(),
    };
  } finally {
    await handle.close();
  }
}

export function shouldExtractMemory(
  messages: readonly LLMMessage[],
  state: SessionMemoryState = defaultExtractionDecisionState,
): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages);
  if (!isSessionMemoryInitialized(state)) {
    if (!hasMetInitializationThreshold(currentTokenCount, state)) {
      return false;
    }
    markSessionMemoryInitialized(state);
  }

  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount, state);
  const toolCallsSinceLastUpdate = countToolCallsSince(
    messages,
    getLastSummarizedMessageCount(state),
  );
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates(state);
  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages);
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn);

  if (shouldExtract) {
    setLastSummarizedMessageCount(messages.length, state);
    setLastSummarizedMessageId(messageCountMarker(messages), state);
    return true;
  }
  return false;
}

function laneKeyForContext(context: SessionMemoryPostSamplingContext): string {
  const sessionId = context.session?.conversationId ?? context.sessionId ?? "default";
  const cwd = context.cwd ?? cwdForSession(context.session);
  return `${sessionId}\0${cwd}`;
}

function laneForContext(context: SessionMemoryPostSamplingContext): SessionMemoryLane {
  const key = laneKeyForContext(context);
  const existing = lanes.get(key);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }
  const lane: SessionMemoryLane = {
    state: createSessionMemoryState(defaultSessionMemoryConfig),
    queue: Promise.resolve(),
    lastAccessedAt: Date.now(),
    pending: 0,
  };
  lanes.set(key, lane);
  pruneIdleLanes();
  return lane;
}

function pruneIdleLanes(): void {
  if (lanes.size <= MAX_SESSION_MEMORY_LANES) return;
  const idleEntries = [...lanes.entries()]
    .filter(([, lane]) => lane.pending === 0)
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
  for (const [key] of idleEntries) {
    if (lanes.size <= MAX_SESSION_MEMORY_LANES) return;
    lanes.delete(key);
  }
}

function cwdForSession(session: Session | undefined): string {
  const raw =
    session?.sessionConfiguration?.cwd ??
    (session as unknown as { config?: { cwd?: unknown } } | undefined)?.config
      ?.cwd;
  return typeof raw === "string" && raw.length > 0 ? raw : process.cwd();
}

function pathOptionsForContext(
  context: SessionMemoryPostSamplingContext,
): SessionMemorySetupOptions {
  return {
    cwd: context.cwd ?? cwdForSession(context.session),
    ...(context.env !== undefined ? { env: context.env } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  };
}

function copyWithAllowedRoot(
  input: Record<string, unknown>,
  memoryDir: string,
): Record<string, unknown> {
  return withSignedAllowedRoots(input, [memoryDir]);
}

export function createSessionMemoryEditPolicy(
  memoryPath: string,
  memoryDir: string = `${dirname(memoryPath)}${sep}`,
): ChildToolPolicy {
  return (tool: Pick<Tool, "name">, input: Record<string, unknown>) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input.file_path === "string" &&
      input.file_path === memoryPath
    ) {
      return {
        behavior: "allow",
        updatedInput: copyWithAllowedRoot(input, memoryDir),
      };
    }
    return {
      behavior: "deny",
      message: `only ${FILE_EDIT_TOOL_NAME} is allowed for ${memoryPath}`,
      metadata: {
        reason: `only ${FILE_EDIT_TOOL_NAME} is allowed`,
      },
    };
  };
}

export interface SessionMemorySetupOptions
  extends Omit<SessionMemoryPathOptions, "sessionId"> {
  readonly signal?: AbortSignal;
}

export async function setupSessionMemoryFile(
  session: Session,
  options: SessionMemorySetupOptions,
): Promise<{
  readonly memoryDir: string;
  readonly memoryPath: string;
  readonly currentMemory: string;
  readonly currentMemoryMtimeMs: number;
}> {
  if (session === undefined || session === null) {
    throw new AdmissionDeniedError("session_memory_admission_session_unavailable");
  }
  const pathOptions: SessionMemoryPathOptions = {
    ...options,
    sessionId: session.conversationId,
  };
  const memoryDir = resolveSessionMemoryDirectory(pathOptions);
  const memoryPath = resolveSessionMemoryPath(pathOptions);
  let setup:
    | {
        readonly currentMemory: string;
        readonly currentMemoryMtimeMs: number;
      }
    | undefined;
  const activeTurn = session.activeTurn?.unsafePeek?.();
  const turnId =
    activeTurn && typeof activeTurn.turnId === "string"
      ? activeTurn.turnId
      : `session-memory:${session.conversationId}`;
  const callId = session.nextInternalSubId();

  await runAdmittedToolCall({
    session,
    turnId,
    callId,
    tool: SESSION_MEMORY_SETUP_TOOL,
    args: { memory_path: memoryPath },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    invoke: async ({ signal }) => {
      signal.throwIfAborted();
      await mkdir(memoryDir, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();

      try {
        await writeFile(memoryPath, await loadSessionMemoryTemplate(signal), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
          signal,
        });
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      signal.throwIfAborted();

      setup = await readSessionMemoryFileWithinLimit(memoryPath, signal);
      const readTool = createFileReadTool({
        allowedPaths: [memoryDir],
        maxTokens: 50_000,
        maxTextBytes: ONE_MEBIBYTE,
      });
      const readArgs = withSignedAllowedRoots(
        withSignedSessionId(
          { file_path: memoryPath },
          session.conversationId,
        ),
        [memoryDir],
      );
      Object.defineProperty(readArgs, "__abortSignal", {
        value: signal,
        enumerable: false,
        configurable: true,
      });
      const readResult = await readTool.execute(readArgs);
      signal.throwIfAborted();
      if (readResult.isError === true) {
        throw new Error(readResult.content);
      }
      return { content: "session memory setup complete" };
    },
  });
  if (setup === undefined) {
    throw new AdmissionDeniedError("session_memory_setup_result_missing");
  }

  return {
    memoryDir,
    memoryPath,
    currentMemory: setup.currentMemory,
    currentMemoryMtimeMs: setup.currentMemoryMtimeMs,
  };
}

function seedEntriesForMemoryFile(
  memoryPath: string,
  currentMemory: string,
  mtimeMs: number,
): SessionReadSeedEntry[] {
  return [
    {
      path: memoryPath,
      content: currentMemory,
      rawContent: currentMemory,
      timestamp: mtimeMs,
      viewKind: "full",
    },
  ];
}

function buildSessionMemoryInitialMessages(
  request: SessionMemoryAgentRequest,
): LLMMessage[] {
  const baseInstructions = request.baseInstructions?.trim();
  const contextMessages = request.messages.map(cloneMessage);
  return [
    ...(baseInstructions
      ? [{ role: "system" as const, content: baseInstructions }]
      : []),
    ...contextMessages,
    { role: "user", content: request.prompt },
  ];
}

async function spawnSessionMemoryLiveAgent(session: Session): Promise<LiveAgent> {
  const controlWithSpawn = session.services.agentControl as unknown as {
    spawn?: (opts: {
      readonly parentPath: string;
      readonly preferredNickname?: string;
    }) => Promise<LiveAgent>;
  };
  if (typeof controlWithSpawn.spawn === "function") {
    return controlWithSpawn.spawn({
      parentPath: ROOT_AGENT_PATH,
      preferredNickname: "session-memory",
    });
  }

  const { ensureAgentControl } = await import("../../bin/delegate-tool.js");
  const { control } = ensureAgentControl(session);
  return control.spawn({
    parentPath: ROOT_AGENT_PATH,
    preferredNickname: "session-memory",
  });
}

async function runSessionMemoryAgentWithSubagent(
  request: SessionMemoryAgentRequest,
): Promise<void> {
  if (request.signal?.aborted) return;

  const live = await spawnSessionMemoryLiveAgent(request.session);
  const seedEntries = seedEntriesForMemoryFile(
    request.memoryPath,
    request.currentMemory,
    request.currentMemoryMtimeMs,
  );
  seedSessionReadState(live.agentId, seedEntries);
  recordSessionRead(live.agentId, request.memoryPath, {
    content: request.currentMemory,
    rawContent: request.currentMemory,
    timestamp: request.currentMemoryMtimeMs,
    viewKind: "full",
  });

  const { runAgent } = await import("../../agents/run-agent.js");
  const params: RunAgentParams = {
    live,
    parent: request.session,
    initialMessages: buildSessionMemoryInitialMessages(request),
    taskPrompt: request.prompt,
    toolAllowlist: [FILE_EDIT_TOOL_NAME],
    childToolPolicy: createSessionMemoryEditPolicy(
      request.memoryPath,
      request.memoryDir,
    ),
    querySource: SESSION_MEMORY_QUERY_SOURCE,
    maxTurns: DEFAULT_MAX_AGENT_TURNS,
    silent: true,
    ...(request.signal !== undefined ? { externalSignal: request.signal } : {}),
  };

  for await (const _event of runAgent(params)) {
    // Consume the background update to completion; transcript relays are disabled.
  }
}

function sessionMemoryAgentRunner(): SessionMemoryAgentRunner {
  return agentRunnerForTests ?? runSessionMemoryAgentWithSubagent;
}

function shouldSkipContext(context: SessionMemoryPostSamplingContext): boolean {
  if (context.signal?.aborted) return true;
  if (!isSessionMemoryEnabled(context.env)) return true;
  if (
    context.querySource !== undefined &&
    context.querySource !== "repl_main_thread"
  ) {
    return true;
  }
  return hasToolCallsInLastAssistantTurn(context.messages);
}

async function extractSessionMemory(
  context: SessionMemoryPostSamplingContext,
  lane: SessionMemoryLane,
  force: boolean,
): Promise<ManualExtractionResult | null> {
  if (!context.session) {
    return { success: false, error: "Session memory extraction requires a live session" };
  }
  if (!force && shouldSkipContext(context)) return null;
  if (!force && !shouldExtractMemory(context.messages, lane.state)) return null;

  markExtractionStarted(lane.state);
  try {
    const setup = await setupSessionMemoryFile(
      context.session,
      pathOptionsForContext(context),
    );
    const prompt = await buildSessionMemoryUpdatePrompt(
      setup.currentMemory,
      setup.memoryPath,
    );

    await sessionMemoryAgentRunner()({
      memoryPath: setup.memoryPath,
      memoryDir: setup.memoryDir,
      currentMemory: setup.currentMemory,
      currentMemoryMtimeMs: setup.currentMemoryMtimeMs,
      prompt,
      messages: context.messages.map(cloneMessage),
      ...(context.baseInstructions !== undefined
        ? { baseInstructions: context.baseInstructions }
        : {}),
      session: context.session,
      state: lane.state,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });

    recordExtractionTokenCount(tokenCountWithEstimation(context.messages), lane.state);
    setLastSummarizedMessageCount(context.messages.length, lane.state);
    setLastSummarizedMessageId(messageCountMarker(context.messages), lane.state);

    return { success: true, memoryPath: setup.memoryPath };
  } catch (error) {
    if (force) {
      return { success: false, error: errorMessage(error) };
    }
    throw error;
  } finally {
    markExtractionCompleted(lane.state);
  }
}

export function runSessionMemoryPostSamplingHook(
  context: SessionMemoryPostSamplingContext,
): Promise<void> {
  const lane = laneForContext(context);
  lane.pending += 1;
  lane.queue = lane.queue.then(
    async () => {
      try {
        await extractSessionMemory(context, lane, false);
      } finally {
        lane.pending -= 1;
        lane.lastAccessedAt = Date.now();
      }
    },
    async () => {
      try {
        await extractSessionMemory(context, lane, false);
      } finally {
        lane.pending -= 1;
        lane.lastAccessedAt = Date.now();
      }
    },
  );
  return lane.queue;
}

export async function manuallyExtractSessionMemory(
  messages: readonly LLMMessage[],
  session: Session,
  options: {
    readonly cwd?: string;
    readonly env?: SessionMemoryEnv;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ManualExtractionResult> {
  if (messages.length === 0) {
    return { success: false, error: "No messages to summarize" };
  }
  const context: SessionMemoryPostSamplingContext = {
    messages,
    querySource: "repl_main_thread",
    session,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const lane = laneForContext(context);
  lane.pending += 1;
  try {
    return (
      (await extractSessionMemory(context, lane, true)) ?? {
        success: false,
        error: "Session memory extraction skipped",
      }
    );
  } finally {
    lane.pending -= 1;
    lane.lastAccessedAt = Date.now();
  }
}

export function initSessionMemory(
  config: Partial<SessionMemoryConfig> = {},
): void {
  defaultSessionMemoryConfig = { ...config };
  for (const lane of lanes.values()) {
    setSessionMemoryConfig(config, lane.state);
  }
}

export function setSessionMemoryAgentRunnerForTests(
  runner: SessionMemoryAgentRunner | null,
): void {
  agentRunnerForTests = runner;
}

export function resetSessionMemoryForTests(): void {
  agentRunnerForTests = null;
  defaultSessionMemoryConfig = {};
  resetSessionMemoryState(defaultExtractionDecisionState);
  lanes.clear();
}

export {
  resetSessionMemoryState,
  type SessionMemoryConfig,
  type SessionMemoryState,
};
