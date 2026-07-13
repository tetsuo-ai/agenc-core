/**
 * Maintains Magic Docs through AgenC file tools and a background subagent.
 * File reads are tracked through the session listener so the updater can
 * seed read-before-edit state before applying the generated edit.
 */

import { readFile, stat } from "node:fs/promises";

import type { LLMMessage } from "../../llm/types.js";
import type { Session } from "../../session/session.js";
import type { Tool } from "../../tools/types.js";
import { FILE_EDIT_TOOL_NAME } from "../../tools/system/file-edit.js";
import { registerFileReadListener } from "../../tools/system/file-read.js";
import {
  forEachSessionRead,
  recordSessionRead,
  seedSessionReadState,
  type SessionReadSeedEntry,
  type SessionReadSnapshot,
} from "../../tools/system/filesystem.js";
import { ROOT_AGENT_PATH } from "../../agents/registry.js";
import type { LiveAgent } from "../../agents/control.js";
import type {
  ChildToolPolicy,
  RunAgentParams,
} from "../../agents/run-agent.js";
import { buildMagicDocsUpdatePrompt } from "./prompts.js";

const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im;
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m;

type MagicDocInfo = {
  readonly path: string;
};

type MagicDocsReadFileSnapshot = Omit<SessionReadSeedEntry, "path">;

export type MagicDocsReadFileState = Map<string, MagicDocsReadFileSnapshot>;

export interface MagicDocsAgentRequest {
  readonly docPath: string;
  readonly currentDoc: string;
  readonly title: string;
  readonly instructions?: string;
  readonly prompt: string;
  readonly messages: readonly LLMMessage[];
  readonly session?: Session;
  readonly currentDocMtimeMs: number;
  readonly readFileState: MagicDocsReadFileState;
  readonly signal?: AbortSignal;
}

export type MagicDocsAgentRunner = (
  request: MagicDocsAgentRequest,
) => Promise<void>;

export interface MagicDocsPostSamplingContext {
  readonly messages: readonly LLMMessage[];
  readonly querySource?: string;
  readonly session?: Session;
  readonly sessionId?: string;
  readonly readFileState?: ReadonlyMap<string, unknown>;
  readonly signal?: AbortSignal;
}

const GLOBAL_SCOPE_ID = "__global__";
const MAGIC_DOCS_QUERY_SOURCE = "magic_docs";

const trackedMagicDocsByScope = new Map<string, Map<string, MagicDocInfo>>();

let unregisterReadListener: (() => void) | null = null;
// One serialized update queue PER scope (session), keyed like
// trackedMagicDocsByScope. A single module-global chain made session B's
// magic-docs update wait behind session A's (a full background subagent).
// The tail entry is deleted once it settles with nothing chained after it, so
// the map stays bounded to scopes with an in-flight update.
const updateQueueByScope = new Map<string, Promise<void>>();
let agentRunnerForTests: MagicDocsAgentRunner | null = null;

function getErrnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function isInaccessibleFileError(error: unknown): boolean {
  const code = getErrnoCode(error);
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM"
  );
}

function hasToolCallsInLastAssistantTurn(
  messages: readonly LLMMessage[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
}
export function trackedMagicDocPathsForTests(sessionId?: string): readonly string[] {
  if (sessionId !== undefined) {
    return [...(trackedMagicDocsByScope.get(scopeIdForSessionId(sessionId))?.keys() ?? [])]
      .sort();
  }
  const paths = new Set<string>();
  for (const docs of trackedMagicDocsByScope.values()) {
    for (const path of docs.keys()) paths.add(path);
  }
  return [...paths].sort();
}

export function setMagicDocsAgentRunnerForTests(
  runner: MagicDocsAgentRunner | null,
): void {
  agentRunnerForTests = runner;
}

export function resetMagicDocsForTests(): void {
  trackedMagicDocsByScope.clear();
  updateQueueByScope.clear();
  agentRunnerForTests = null;
  if (unregisterReadListener !== null) {
    unregisterReadListener();
    unregisterReadListener = null;
  }
}

export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN);
  if (!match || !match[1]) {
    return null;
  }

  const title = match[1].trim();
  const headerEndIndex = match.index! + match[0].length;
  const afterHeader = content.slice(headerEndIndex);
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/);

  if (nextLineMatch && nextLineMatch[1]) {
    const italicsMatch = nextLineMatch[1].match(ITALICS_PATTERN);
    if (italicsMatch && italicsMatch[1]) {
      return {
        title,
        instructions: italicsMatch[1].trim(),
      };
    }
  }

  return { title };
}

function scopeIdForSessionId(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : GLOBAL_SCOPE_ID;
}

function scopeIdForContext(context: MagicDocsPostSamplingContext): string {
  return scopeIdForSessionId(context.session?.conversationId ?? context.sessionId);
}

function docsForScope(scopeId: string): Map<string, MagicDocInfo> {
  let docs = trackedMagicDocsByScope.get(scopeId);
  if (!docs) {
    docs = new Map();
    trackedMagicDocsByScope.set(scopeId, docs);
  }
  return docs;
}

function deleteTrackedDoc(scopeId: string, filePath: string): void {
  const docs = trackedMagicDocsByScope.get(scopeId);
  if (!docs) return;
  docs.delete(filePath);
  if (docs.size === 0) {
    trackedMagicDocsByScope.delete(scopeId);
  }
}

export function registerMagicDoc(filePath: string, sessionId?: string): void {
  const docs = docsForScope(scopeIdForSessionId(sessionId));
  if (!docs.has(filePath)) {
    docs.set(filePath, { path: filePath });
  }
}

function snapshotToSeed(snapshot: SessionReadSnapshot): MagicDocsReadFileSnapshot {
  return {
    ...(snapshot.content === undefined ? {} : { content: snapshot.content }),
    ...(typeof snapshot.timestamp === "number" && Number.isFinite(snapshot.timestamp)
      ? { timestamp: snapshot.timestamp }
      : {}),
    ...(snapshot.viewKind === undefined ? {} : { viewKind: snapshot.viewKind }),
    ...(snapshot.isPartialView === true ? { isPartialView: true } : {}),
    ...(typeof snapshot.readOffset === "number" && Number.isFinite(snapshot.readOffset)
      ? { readOffset: snapshot.readOffset }
      : {}),
    ...(typeof snapshot.readLimit === "number" && Number.isFinite(snapshot.readLimit)
      ? { readLimit: snapshot.readLimit }
      : {}),
    ...(snapshot.rawContent === undefined ? {} : { rawContent: snapshot.rawContent }),
  };
}

function cloneMagicDocsReadFileState(
  state?: ReadonlyMap<string, unknown>,
): MagicDocsReadFileState {
  const cloned = new Map<string, MagicDocsReadFileSnapshot>();
  if (!state) return cloned;
  for (const [path, value] of state.entries()) {
    if (typeof path !== "string" || path.trim().length === 0) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      cloned.set(path, snapshotToSeed(value as SessionReadSnapshot));
    } else {
      cloned.set(path, {});
    }
  }
  return cloned;
}

function cloneSessionReadFileState(
  sessionId: string | undefined,
): MagicDocsReadFileState {
  const cloned = new Map<string, MagicDocsReadFileSnapshot>();
  forEachSessionRead(sessionId, (path, snapshot) => {
    cloned.set(path, snapshotToSeed(snapshot));
  });
  return cloned;
}

function readFileStateForContext(
  context: MagicDocsPostSamplingContext,
): MagicDocsReadFileState {
  if (context.readFileState !== undefined) {
    return cloneMagicDocsReadFileState(context.readFileState);
  }
  return cloneSessionReadFileState(
    context.session?.conversationId ?? context.sessionId,
  );
}

function seedEntriesFromReadFileState(
  state: MagicDocsReadFileState,
): SessionReadSeedEntry[] {
  return [...state.entries()].map(([path, snapshot]) => ({
    path,
    ...snapshot,
  }));
}

export function createMagicDocsEditPolicy(docPath: string): ChildToolPolicy {
  return (tool: Pick<Tool, "name">, input: Record<string, unknown>) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input.file_path === "string" &&
      input.file_path === docPath
    ) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    return {
      behavior: "deny" as const,
      message: `only ${FILE_EDIT_TOOL_NAME} is allowed for ${docPath}`,
      metadata: {
        reason: `only ${FILE_EDIT_TOOL_NAME} is allowed`,
      },
    };
  };
}

async function spawnMagicDocsLiveAgent(session: Session): Promise<LiveAgent> {
  const controlWithSpawn = session.services.agentControl as unknown as {
    spawn?: (opts: {
      readonly parentPath: string;
      readonly preferredNickname?: string;
    }) => Promise<LiveAgent>;
  };
  if (typeof controlWithSpawn.spawn === "function") {
    return controlWithSpawn.spawn({
      parentPath: ROOT_AGENT_PATH,
      preferredNickname: "magic-docs",
    });
  }

  const { ensureAgentControl } = await import("../../bin/delegate-tool.js");
  const { control } = ensureAgentControl(session);
  return control.spawn({
    parentPath: ROOT_AGENT_PATH,
    preferredNickname: "magic-docs",
  });
}

async function runMagicDocsAgentWithSubagent(
  request: MagicDocsAgentRequest,
): Promise<void> {
  if (!request.session) {
    throw new Error("MagicDocs update requires a live session");
  }
  if (request.signal?.aborted) return;

  const live = await spawnMagicDocsLiveAgent(request.session);
  seedSessionReadState(live.agentId, seedEntriesFromReadFileState(request.readFileState));
  recordSessionRead(live.agentId, request.docPath, {
    content: request.currentDoc,
    rawContent: request.currentDoc,
    timestamp: Number.isFinite(request.currentDocMtimeMs)
      ? request.currentDocMtimeMs
      : Date.now(),
    viewKind: "full",
  });

  const { runAgent } = await import("../../agents/run-agent.js");
  const params: RunAgentParams = {
    live,
    parent: request.session,
    initialMessages: [
      ...request.messages.map((message) => ({ ...message })),
      { role: "user", content: request.prompt },
    ],
    taskPrompt: request.prompt,
    toolAllowlist: [FILE_EDIT_TOOL_NAME],
    childToolPolicy: createMagicDocsEditPolicy(request.docPath),
    querySource: MAGIC_DOCS_QUERY_SOURCE,
    maxTurns: 2,
    silent: true,
    ...(request.signal !== undefined ? { externalSignal: request.signal } : {}),
  };

  for await (const _event of runAgent(params)) {
    // Consume the background run to completion; transcript relays are disabled.
  }
}

function magicDocsAgentRunner(): MagicDocsAgentRunner {
  return agentRunnerForTests ?? runMagicDocsAgentWithSubagent;
}

async function updateMagicDoc(
  docInfo: MagicDocInfo,
  context: MagicDocsPostSamplingContext,
  scopeId: string,
): Promise<void> {
  let currentDoc: string;
  try {
    currentDoc = await readFile(docInfo.path, "utf8");
  } catch (error) {
    if (isInaccessibleFileError(error)) {
      deleteTrackedDoc(scopeId, docInfo.path);
      return;
    }
    throw error;
  }

  let currentDocMtimeMs: number;
  try {
    const fileStats = await stat(docInfo.path);
    if (!fileStats.isFile()) {
      deleteTrackedDoc(scopeId, docInfo.path);
      return;
    }
    currentDocMtimeMs = Number.isFinite(fileStats.mtimeMs)
      ? fileStats.mtimeMs
      : Date.now();
  } catch (error) {
    if (isInaccessibleFileError(error)) {
      deleteTrackedDoc(scopeId, docInfo.path);
      return;
    }
    throw error;
  }

  const detected = detectMagicDocHeader(currentDoc);
  if (!detected) {
    deleteTrackedDoc(scopeId, docInfo.path);
    return;
  }

  const readFileState = readFileStateForContext(context);
  readFileState.delete(docInfo.path);
  const prompt = await buildMagicDocsUpdatePrompt(
    currentDoc,
    docInfo.path,
    detected.title,
    detected.instructions,
  );

  await magicDocsAgentRunner()({
    docPath: docInfo.path,
    currentDoc,
    title: detected.title,
    ...(detected.instructions !== undefined
      ? { instructions: detected.instructions }
      : {}),
    prompt,
    messages: context.messages,
    ...(context.session !== undefined ? { session: context.session } : {}),
    currentDocMtimeMs,
    readFileState,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
}

async function updateMagicDocs(
  context: MagicDocsPostSamplingContext,
): Promise<void> {
  if (context.signal?.aborted) return;
  if (context.querySource !== undefined && context.querySource !== "repl_main_thread") {
    return;
  }
  if (hasToolCallsInLastAssistantTurn(context.messages)) {
    return;
  }
  const scopeId = scopeIdForContext(context);
  const trackedMagicDocs = trackedMagicDocsByScope.get(scopeId);
  if (!trackedMagicDocs || trackedMagicDocs.size === 0) {
    return;
  }

  for (const docInfo of [...trackedMagicDocs.values()]) {
    if (context.signal?.aborted) return;
    await updateMagicDoc(docInfo, context, scopeId);
  }
}

export function runMagicDocsPostSamplingHook(
  context: MagicDocsPostSamplingContext,
): Promise<void> {
  const scopeId = scopeIdForContext(context);
  const prev = updateQueueByScope.get(scopeId) ?? Promise.resolve();
  const next = prev.then(
    () => updateMagicDocs(context),
    () => updateMagicDocs(context),
  );
  updateQueueByScope.set(scopeId, next);
  // Drop the entry once this settles, unless a newer update chained after it —
  // keeps the map bounded to scopes with a genuinely in-flight update. The
  // settle handler swallows rejection so an ignored tail cannot surface as an
  // unhandled rejection; callers still observe it via the returned promise.
  const settle = (): void => {
    if (updateQueueByScope.get(scopeId) === next) {
      updateQueueByScope.delete(scopeId);
    }
  };
  next.then(settle, settle);
  return next;
}

export function initMagicDocs(): void {
  if (unregisterReadListener !== null) return;
  unregisterReadListener = registerFileReadListener((event) => {
    if (detectMagicDocHeader(event.content)) {
      registerMagicDoc(event.filePath, event.sessionId);
    }
  });
}
